// services/wallbox/ocpp-server.js — OCPP 1.6J-Zentrale (Central System) in DVhub (2026-10-20).
//
// OCPP ist ein offener Standard der Open Charge Alliance; viele Wallboxen
// sprechen ihn (Alfen, ABL, Wallbox, Zaptec, Bender-basierte, Vestel …). Die
// Wallbox verbindet sich mit ws://<DVhub>:<port>/<Ladepunkt-ID> (Subprotokoll
// „ocpp1.6“). Nachrichten (OCPP-J): [2, id, Aktion, Daten] Aufruf,
// [3, id, Daten] Antwort, [4, id, Fehlercode, Text, Details] Fehler.
//
// Angenommen: BootNotification, Heartbeat, StatusNotification, MeterValues,
// Authorize (immer Accepted — die Freigabe am Ladepunkt bleibt Sache der Box),
// StartTransaction, StopTransaction, DataTransfer, Firmware-/Diagnose-Status.
// Gesendet (callAction): SetChargingProfile, ClearChargingProfile,
// RemoteStartTransaction, RemoteStopTransaction, ChangeConfiguration, TriggerMessage.
//
// Zugang: nur Heimnetz-Adressen (wie der Modbus-Server); optional Passwort
// (OCPP-Sicherheitsprofil 1, HTTP Basic, Benutzer = Ladepunkt-ID).
import { WebSocketServer } from 'ws';

const DEFAULT_PORT = 8887;
const HEARTBEAT_S = 60;
const METER_INTERVAL_S = 10;

function privateAddress(addr) {
  const raw = String(addr || '').replace(/^::ffff:/, '');
  if (raw === '127.0.0.1' || raw === '::1') return true;
  const p = raw.split('.').map(Number);
  if (p.length !== 4 || !p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return /^(fe80|fd|fc)/i.test(raw);
  return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168);
}

function toWatts(v, unit) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return String(unit || 'W').toLowerCase() === 'kw' ? Math.round(n * 1000) : Math.round(n);
}
function toWh(v, unit) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return String(unit || 'Wh').toLowerCase() === 'kwh' ? Math.round(n * 1000) : Math.round(n);
}

export function createOcppServer(ctx, deps = {}) {
  const now = deps.now || (() => Date.now());
  const callTimeoutMs = deps.callTimeoutMs || 15_000;
  const points = new Map(); // id → { id, ws, vendor, model, connectors: {n: {...}}, lastSeen, pending }
  let wss = null;
  let listeningPort = null;
  let msgId = 0;
  let txId = Math.floor(now() / 1000) % 1_000_000;

  const cfg = () => ctx.getCfg?.()?.ocpp || {};
  const log = (e, d) => ctx.pushLog?.(e, d);

  function connector(cp, n) {
    const k = Number(n) || 0;
    cp.connectors[k] ||= { status: null, errorCode: null, transactionId: null, powerW: null, energyWh: null, currentA: null, meterAt: null };
    return cp.connectors[k];
  }

  function reply(ws, id, payload) { ws.send(JSON.stringify([3, id, payload])); }
  function replyError(ws, id, code, text) { ws.send(JSON.stringify([4, id, code, text, {}])); }

  function handleCall(cp, id, action, p) {
    const t = new Date(now()).toISOString();
    switch (action) {
      case 'BootNotification':
        cp.vendor = p?.chargePointVendor ?? null;
        cp.model = p?.chargePointModel ?? null;
        cp.firmware = p?.firmwareVersion ?? null;
        reply(cp.ws, id, { status: 'Accepted', currentTime: t, interval: HEARTBEAT_S });
        log('ocpp_boot', { id: cp.id, vendor: cp.vendor, model: cp.model });
        // Messwerte regelmäßig und mit Leistung/Energie/Strom anfordern.
        setTimeout(() => {
          callAction(cp.id, 'ChangeConfiguration', { key: 'MeterValueSampleInterval', value: String(METER_INTERVAL_S) }).catch(() => {});
          callAction(cp.id, 'ChangeConfiguration', { key: 'MeterValuesSampledData', value: 'Energy.Active.Import.Register,Power.Active.Import,Current.Import' }).catch(() => {});
        }, 0);
        return;
      case 'Heartbeat':
        return reply(cp.ws, id, { currentTime: t });
      case 'StatusNotification': {
        const c = connector(cp, p?.connectorId);
        c.status = p?.status ?? null;
        c.errorCode = p?.errorCode ?? null;
        return reply(cp.ws, id, {});
      }
      case 'MeterValues': {
        const c = connector(cp, p?.connectorId);
        const currents = [];
        for (const mv of p?.meterValue || []) {
          for (const sv of mv?.sampledValue || []) {
            const m = sv?.measurand || 'Energy.Active.Import.Register';
            if (m === 'Power.Active.Import' && !sv.phase) c.powerW = toWatts(sv.value, sv.unit);
            else if (m === 'Energy.Active.Import.Register' && !sv.phase) c.energyWh = toWh(sv.value, sv.unit);
            else if (m === 'Current.Import') { const a = Number(sv.value); if (Number.isFinite(a)) currents.push(a); }
          }
        }
        if (currents.length) c.currentA = Math.max(...currents);
        if (p?.transactionId != null) c.transactionId = p.transactionId;
        c.meterAt = t;
        return reply(cp.ws, id, {});
      }
      case 'Authorize':
        return reply(cp.ws, id, { idTagInfo: { status: 'Accepted' } });
      case 'StartTransaction': {
        const c = connector(cp, p?.connectorId);
        txId += 1;
        c.transactionId = txId;
        log('ocpp_transaction_start', { id: cp.id, connectorId: p?.connectorId, transactionId: txId });
        return reply(cp.ws, id, { transactionId: txId, idTagInfo: { status: 'Accepted' } });
      }
      case 'StopTransaction':
        for (const c of Object.values(cp.connectors)) if (c.transactionId === p?.transactionId) c.transactionId = null;
        log('ocpp_transaction_stop', { id: cp.id, transactionId: p?.transactionId });
        return reply(cp.ws, id, { idTagInfo: { status: 'Accepted' } });
      case 'DataTransfer':
        return reply(cp.ws, id, { status: 'UnknownVendorId' });
      case 'FirmwareStatusNotification':
      case 'DiagnosticsStatusNotification':
        return reply(cp.ws, id, {});
      default:
        return replyError(cp.ws, id, 'NotImplemented', `Aktion ${action} wird von DVhub nicht unterstützt`);
    }
  }

  function onConnection(ws, req) {
    const cpId = decodeURIComponent(String(req.url || '').split('?')[0].replace(/^\/+(ocpp\/)?/, '').replace(/\/+$/, ''));
    const old = points.get(cpId);
    if (old?.ws && old.ws !== ws) { try { old.ws.terminate(); } catch { /* weg */ } }
    const cp = old || { id: cpId, connectors: {}, vendor: null, model: null, firmware: null };
    cp.ws = ws;
    cp.pending = new Map();
    cp.connectedAt = new Date(now()).toISOString();
    cp.lastSeen = cp.connectedAt;
    points.set(cpId, cp);
    log('ocpp_connected', { id: cpId, remote: req.socket.remoteAddress });
    ws.on('message', (raw) => {
      cp.lastSeen = new Date(now()).toISOString();
      let m;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (!Array.isArray(m)) return;
      if (m[0] === 2) {
        try { handleCall(cp, m[1], m[2], m[3]); } catch (e) { replyError(ws, m[1], 'InternalError', e?.message || String(e)); }
      } else if (m[0] === 3 || m[0] === 4) {
        const pend = cp.pending.get(m[1]);
        if (pend) { cp.pending.delete(m[1]); pend(m); }
      }
    });
    ws.on('close', () => {
      if (cp.ws === ws) { cp.ws = null; log('ocpp_disconnected', { id: cpId }); }
      for (const pend of cp.pending.values()) pend([4, null, 'GenericError', 'Verbindung getrennt']);
      cp.pending.clear();
    });
    ws.on('error', () => { /* close folgt */ });
  }

  /** Aufruf an einen Ladepunkt; Ergebnis { ok, payload } oder { ok:false, error }. */
  function callAction(cpId, action, payload) {
    const cp = points.get(cpId);
    if (!cp?.ws || cp.ws.readyState !== 1) return Promise.resolve({ ok: false, error: `Ladepunkt ${cpId} nicht verbunden` });
    const id = `dv${++msgId}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { cp.pending.delete(id); resolve({ ok: false, error: `${action}: keine Antwort` }); }, callTimeoutMs);
      cp.pending.set(id, (m) => {
        clearTimeout(timer);
        if (m[0] === 3) resolve({ ok: true, payload: m[2] || {} });
        else resolve({ ok: false, error: `${action}: ${m[2]} ${m[3] || ''}`.trim() });
      });
      cp.ws.send(JSON.stringify([2, id, action, payload]));
    });
  }

  function verifyClient(info, cb) {
    if (!privateAddress(info.req.socket.remoteAddress)) return cb(false, 403, 'Forbidden');
    const pw = String(cfg().password || '');
    if (!pw) return cb(true);
    const hdr = String(info.req.headers.authorization || '');
    const m = hdr.match(/^Basic\s+(.+)$/i);
    const given = m ? Buffer.from(m[1], 'base64').toString('utf8').split(':').slice(1).join(':') : null;
    return given === pw ? cb(true) : cb(false, 401, 'Unauthorized');
  }

  async function start() {
    const c = cfg();
    if (c.enabled !== true || wss) return { started: false };
    const port = Number(c.port) || DEFAULT_PORT;
    wss = new WebSocketServer({
      host: c.host || '0.0.0.0',
      port,
      verifyClient,
      handleProtocols: (protocols) => (protocols.has('ocpp1.6') ? 'ocpp1.6' : false),
    });
    wss.on('connection', onConnection);
    await new Promise((resolve, reject) => { wss.once('listening', resolve); wss.once('error', reject); });
    listeningPort = port;
    log('ocpp_listening', { port });
    return { started: true, port };
  }

  async function stop() {
    if (!wss) return;
    for (const cp of points.values()) { try { cp.ws?.terminate(); } catch { /* weg */ } }
    await new Promise((resolve) => wss.close(() => resolve()));
    wss = null;
    listeningPort = null;
  }

  /** Einstellungen übernehmen ohne Neustart von DVhub: an/aus, Port gewechselt. */
  async function reconcile() {
    const c = cfg();
    const port = Number(c.port) || DEFAULT_PORT;
    if (c.enabled !== true) { if (wss) { await stop(); log('ocpp_stopped', {}); } return; }
    if (wss && listeningPort !== port) await stop();
    if (!wss) await start();
  }

  function chargePoint(id) {
    const cp = points.get(id);
    if (!cp) return null;
    return {
      id: cp.id, connected: Boolean(cp.ws && cp.ws.readyState === 1), vendor: cp.vendor, model: cp.model,
      firmware: cp.firmware, connectedAt: cp.connectedAt, lastSeen: cp.lastSeen,
      connectors: JSON.parse(JSON.stringify(cp.connectors)),
    };
  }
  function list() { return [...points.keys()].map(chargePoint); }
  function status() { return { enabled: cfg().enabled === true, listening: Boolean(wss), port: Number(cfg().port) || DEFAULT_PORT, chargePoints: list() }; }

  return { start, stop, reconcile, callAction, chargePoint, list, status };
}
