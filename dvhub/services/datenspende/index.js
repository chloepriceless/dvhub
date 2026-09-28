// services/datenspende/index.js — DVhub als Datenspender für das Forschungs-
// projekt „Datenspende“ des Lehrstuhls COMSYS (RWTH Aachen, SAFEr Grid).
//
// Was passiert (nur nach ausdrücklicher Einwilligung, ab Werk AUS):
//   1. Einrichtung: Konto anlegen/anmelden → Haushalt → Client → API-Key.
//      Das Passwort wird NIE gespeichert; nur API-Key + IDs landen im Sidecar
//      ${DATA_DIR}/datenspende.json (0600, nicht in config.json).
//   2. Sammeln: alle `intervalSec` (Default 10 s) ein Messwert je Quelle —
//      Netz, PV, Hausverbrauch, Batterie, Shelly-/MQTT-Geräte, MQTT-Kacheln in
//      W/kW, evcc-Ladepunkte. Jede Quelle ist beim Projekt ein eigener „Zähler“
//      und wird beim ersten Wert automatisch registriert.
//   3. Senden: alle 60–90 s (zufällig, damit nicht alle Anlagen gleichzeitig
//      senden) gebündelt an /meters/batch. Offline bleiben Werte in der
//      Warteschlange ${DATA_DIR}/datenspende-queue.json und werden nachgereicht.
//
// Vorzeichen (dokumentiert, weil der Server keine Konvention vorgibt):
//   Netz    power > 0 = Bezug, < 0 = Einspeisung
//   Batterie power > 0 = Laden, < 0 = Entladen
//   PV / Hausverbrauch / Geräte ≥ 0
// Einheiten: power in W; energy in kWh (nur Shelly — deren Lebenszeit-Zähler).
//   OFFEN (mit COMSYS klären): erwartete energy-Einheit ist nicht dokumentiert;
//   die HA-Integration schickt den Rohwert des HA-Sensors (meist kWh).
//
// Läuft im Runtime-Prozess (dort sind Geräte-Werte live); Status und
// Einrichtung laufen im Web-Prozess und tauschen sich über die Dateien in
// DATA_DIR aus (im Normalbetrieb ist beides derselbe Prozess).

import fs from 'node:fs';
import path from 'node:path';
import { findHistoryBounds, readSlotWindow, readLiveWindow } from './history.js';
import {
  createDatenspendeClient, DATENSPENDE_BASE_URL,
  DatenspendeRequestError, DatenspendeDuplicateError, DatenspendeServerError, DatenspendeAuthError,
} from './client.js';

export const SIDECAR_NAME = 'datenspende.json';
export const QUEUE_NAME = 'datenspende-queue.json';
export const DEFAULT_INTERVAL_SEC = 10;
export const MAX_QUEUED_READINGS = 50_000;     // ~2 h Puffer bei 10 Zählern / 10 s
export const MAX_BATCH_READINGS = 5_000;       // Server lehnt > 10 000 ab
export const BATCH_INTERVAL_MIN_S = 60;
export const BATCH_INTERVAL_MAX_S = 90;
export const HEAD_RETRY_BACKOFF_MS = 30_000;   // gleicher Batch nicht Schlag auf Schlag
export const HEAD_BLOCK_TIMEOUT_MS = 15 * 60_000; // 5xx-Batch blockiert höchstens so lange
export const SOURCE_GROUPS = ['grid', 'pv', 'load', 'battery', 'devices', 'mqttTiles', 'wallbox'];
// Nachversand der Bestandsdaten: höflich gegenüber dem Projekt-Server.
export const BACKFILL_PAUSE_MS = 3_000;          // Pause nach jedem Batch
export const BACKFILL_RETRY_MS = 60_000;         // Server/Verbindung weg → später erneut
export const BACKFILL_SLOT_WINDOW_MS = 7 * 24 * 3600_000; // Viertelstunden: 1 Woche je Schritt
export const BACKFILL_LIVE_WINDOW_MS = 3600_000;          // Live (~5 s): 1 Stunde je Schritt
// Zähler der Gesamtanlage — gleiche Namen live und im Nachversand.
export const SYSTEM_METERS = {
  grid: { name: 'Netzanschluss', model: 'DVhub Netzanschluss (+Bezug/−Einspeisung)' },
  pv: { name: 'PV-Erzeugung', model: 'DVhub PV gesamt' },
  load: { name: 'Hausverbrauch', model: 'DVhub Hausverbrauch' },
  battery: { name: 'Batterie', model: 'DVhub Batterie (+Laden/−Entladen)' },
};

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round1 = (v) => Math.round(v * 10) / 10;
// Zeitstempel auf volle Sekunde, Format wie die HA-Integration: 2026-09-28T12:00:00Z
export const isoSecond = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

// Aktuelle Werte aller Quellen. Rein lesend, keine Netzwerkzugriffe.
export function collectSources(ctx, cfg, nowMs) {
  const payload = (ctx.getCachedRuntimeStatusPayload && ctx.getCachedRuntimeStatusPayload())
    || (ctx.buildFallbackStatusPayload && ctx.buildFallbackStatusPayload(nowMs)) || {};
  const v = payload.victron || {};
  const ds = cfg.datenspende || {};
  const on = (g) => (ds.sources || {})[g] !== false;
  const vendor = String(cfg.manufacturer || 'DVhub');
  const out = [];

  if (on('grid')) {
    const imp = num(v.gridImportW), exp = num(v.gridExportW);
    let power = (imp !== null && exp !== null) ? imp - exp : null;
    if (power === null) {
      // Rückfall auf den Zähler-Rohwert mit der konfigurierten Vorzeichen-Konvention.
      const total = num(payload.meter?.grid_total_w);
      if (total !== null) power = cfg.gridPositiveMeans === 'grid_import' ? total : -total;
    }
    if (power !== null) out.push({ key: 'grid', ...SYSTEM_METERS.grid, vendor, power: round1(power) });
  }
  if (on('pv') && num(v.pvTotalW) !== null) out.push({ key: 'pv', ...SYSTEM_METERS.pv, vendor, power: round1(v.pvTotalW) });
  if (on('load') && num(v.selfConsumptionW) !== null) out.push({ key: 'load', ...SYSTEM_METERS.load, vendor, power: round1(v.selfConsumptionW) });
  if (on('battery') && num(v.batteryPowerW) !== null) out.push({ key: 'battery', ...SYSTEM_METERS.battery, vendor, power: round1(v.batteryPowerW) });

  if (on('devices') && ctx.deviceService?.getDevices) {
    const byId = new Map((Array.isArray(cfg.devices) ? cfg.devices : []).map((d) => [String(d?.id), d]));
    for (const d of ctx.deviceService.getDevices() || []) {
      if (!d || !d.online || num(d.powerW) === null) continue;
      const adapter = byId.get(String(d.id))?.adapter || '';
      const isShelly = adapter === 'shelly-http';
      const src = { key: `device:${d.id}`, name: String(d.name || d.id), vendor: isShelly ? 'Shelly' : 'MQTT', model: adapter || 'DVhub-Gerät', power: round1(d.powerW) };
      // Shelly: energyTodayWh ist der Lebenszeit-Zähler (aenergy.total, Wh) → kWh.
      // MQTT: Einheit des Energie-Felds unbekannt → nicht senden.
      if (isShelly && num(d.energyTodayWh) !== null) src.energy = Math.round(d.energyTodayWh) / 1000;
      out.push(src);
    }
  }
  if (on('mqttTiles') && ctx.familyMqttTiles?.getTiles) {
    for (const t of ctx.familyMqttTiles.getTiles() || []) {
      if (!t || !t.online) continue;
      const unit = String(t.unit || '').trim();
      // Fehlender Wert (null/leer) ist KEIN 0-W-Messwert — überspringen.
      if (t.value === null || t.value === undefined || (typeof t.value === 'string' && !t.value.trim())) continue;
      const val = typeof t.value === 'number' ? t.value : Number(t.value);
      if (!Number.isFinite(val) || !/^k?W$/.test(unit)) continue; // nur Leistung
      out.push({ key: `tile:${t.id}`, name: String(t.label || t.id), vendor: 'MQTT', model: 'MQTT-Kachel', power: round1(unit === 'kW' ? val * 1000 : val) });
    }
  }
  if (on('wallbox') && ctx.evccIntegration?.getLoadpoints) {
    for (const lp of ctx.evccIntegration.getLoadpoints() || []) {
      if (!lp || num(lp.chargePowerW) === null) continue;
      out.push({ key: `evcc:${lp.id}`, name: String(lp.title || `Ladepunkt ${lp.id}`), vendor: 'evcc', model: 'Wallbox-Ladeleistung', power: round1(lp.chargePowerW) });
    }
  }
  return out;
}

class LinkChangedError extends Error {
  constructor() { super('Verknüpfung während des Sendens geändert'); }
}

export function createDatenspende(ctx = {}, deps = {}) {
  const fsImpl = deps.fs || fs;
  const now = deps.now || (() => Date.now());
  const random = deps.random || Math.random;
  // Fester Versand-Takt nur für E2E-Tests/Diagnose (sonst zufällig 60–90 s).
  const fixedFlushMs = Number(deps.flushIntervalSec) > 0 ? Number(deps.flushIntervalSec) * 1000 : null;
  const pushLog = typeof ctx.pushLog === 'function' ? ctx.pushLog : () => {};
  const getCfg = () => (typeof ctx.getCfg === 'function' ? ctx.getCfg() : {}) || {};
  const client = deps.client || createDatenspendeClient({
    baseUrl: process.env.DV_DATENSPENDE_URL || DATENSPENDE_BASE_URL,
  });

  const dataDir = () => (typeof ctx.getDataDir === 'function' ? ctx.getDataDir() : null) || process.env.DV_DATA_DIR || '.';
  const sidecarPath = () => path.join(dataDir(), SIDECAR_NAME);
  const queuePath = () => path.join(dataDir(), QUEUE_NAME);

  function readJson(p) {
    try { return JSON.parse(fsImpl.readFileSync(p, 'utf8')); } catch { return null; }
  }
  function writeJson(p, obj, mode) {
    const tmp = `${p}.tmp`;
    fsImpl.writeFileSync(tmp, JSON.stringify(obj), mode ? { mode } : undefined);
    fsImpl.renameSync(tmp, p);
  }
  const loadSidecar = () => {
    const sc = readJson(sidecarPath());
    return sc && sc.apiKey && sc.clientId ? sc : null;
  };
  const saveSidecar = (sc) => writeJson(sidecarPath(), sc, 0o600);
  // Nach jedem await gilt: der Kunde kann inzwischen getrennt oder ein anderes
  // Konto verknüpft haben (auch aus dem anderen Prozess). Änderungen daher nur
  // auf den FRISCH gelesenen Stand anwenden — und nur, wenn es noch dieselbe
  // Verknüpfung ist. Sonst nie einen alten Zugang zurückschreiben.
  const sameLink = (a, b) => !!(a && b && a.clientId === b.clientId && a.apiKey === b.apiKey);
  function commitSidecar(expected, mutate) {
    const fresh = loadSidecar();
    if (!sameLink(fresh, expected)) return false;
    mutate(fresh);
    saveSidecar(fresh);
    return true;
  }

  function settings() {
    const ds = getCfg().datenspende || {};
    const iv = Number(ds.intervalSec);
    return {
      enabled: ds.enabled === true,
      intervalSec: Number.isFinite(iv) ? Math.min(300, Math.max(5, Math.round(iv))) : DEFAULT_INTERVAL_SEC,
      clientType: String(ds.clientType || 'dvhub').trim() || 'dvhub',
    };
  }

  // ── Warteschlange (im Speicher, Stand auf Platte) ─────────────────────────
  // readings: { key, timestamp, power?, energy? } — die Zähler-ID wird erst
  // beim Senden über sidecar.meters[key] aufgelöst.
  let queue = null; // lazy geladen
  function q() {
    if (!queue) {
      const saved = readJson(queuePath());
      queue = {
        readings: Array.isArray(saved?.readings) ? saved.readings : [],
        clientId: saved?.clientId || null,
        headBlockedSince: saved?.headBlockedSince || null,
        lastFailAt: saved?.lastFailAt || null,
        lastFlushAt: saved?.lastFlushAt || null,
        lastSampleAt: saved?.lastSampleAt || null,
        lastError: saved?.lastError || null,
      };
    }
    return queue;
  }
  function persistQueue() {
    try { writeJson(queuePath(), q()); } catch (e) { pushLog('datenspende_queue_write_error', { error: String(e.message || e) }); }
  }
  function clearQueue() {
    queue = { readings: [], clientId: null, headBlockedSince: null, lastFailAt: null, lastFlushAt: null, lastSampleAt: null, lastError: null };
    try { fsImpl.unlinkSync(queuePath()); } catch { /* war nicht da */ }
  }
  // Warteschlange gehört zu genau einer Verknüpfung — nach Trennen/Neu-
  // Verknüpfen (auch aus dem anderen Prozess) nichts an den falschen Client senden.
  function syncWithLink(sc) {
    const qq = q();
    if (!sc) { if (qq.readings.length || qq.clientId) clearQueue(); return false; }
    if (qq.clientId && qq.clientId !== sc.clientId) clearQueue();
    q().clientId = sc.clientId;
    return true;
  }

  // ── Sammeln ────────────────────────────────────────────────────────────────
  function sample() {
    const sc = loadSidecar();
    if (!syncWithLink(sc)) return { skipped: 'not_linked' };
    if (!settings().enabled) {
      // Ausgeschaltet: nichts sammeln — und nichts Gesammeltes mehr senden.
      if (q().readings.length) { q().readings = []; persistQueue(); }
      return { skipped: 'disabled' };
    }
    const t = now();
    const ts = isoSecond(t);
    const sources = collectSources(ctx, getCfg(), t);
    const qq = q();
    for (const s of sources) {
      const r = { key: s.key, timestamp: ts, power: s.power };
      if (s.energy !== undefined) r.energy = s.energy;
      qq.readings.push(r);
      // Name/Hersteller für die Registrierung merken (wird beim Senden gebraucht).
      metaByKey.set(s.key, { name: s.name, vendor: s.vendor, model: s.model });
    }
    if (qq.readings.length > MAX_QUEUED_READINGS) {
      const drop = qq.readings.length - MAX_QUEUED_READINGS;
      qq.readings.splice(0, drop);
      pushLog('datenspende_queue_overflow', { dropped: drop });
    }
    qq.lastSampleAt = new Date(t).toISOString();
    return { ok: true, sampled: sources.length };
  }
  const metaByKey = new Map();
  // Name/Hersteller eines Zählers — auch für Quellen, die (noch) nicht live
  // gesampelt wurden (Nachversand direkt nach dem Start).
  function metaFor(key) {
    if (metaByKey.has(key)) return metaByKey.get(key);
    const vendor = String(getCfg().manufacturer || 'DVhub');
    if (SYSTEM_METERS[key]) return { ...SYSTEM_METERS[key], vendor };
    if (key.startsWith('tile:')) {
      const id = key.slice(5);
      const tile = (ctx.familyMqttTiles?.getTiles?.() || []).find((t) => String(t.id) === id);
      return { name: String(tile?.label || id), vendor: 'MQTT', model: 'MQTT-Kachel' };
    }
    return { name: key, vendor: 'DVhub', model: 'DVhub' };
  }

  // ── Senden ─────────────────────────────────────────────────────────────────
  let flushing = null;
  function flush() {
    if (flushing) return flushing;
    flushing = doFlush().finally(() => { flushing = null; });
    return flushing;
  }

  async function ensureMeters(sc, keys) {
    sc.meters = sc.meters || {};
    let changed = false;
    for (const key of keys) {
      if (sc.meters[key]?.id) continue;
      const meta = metaFor(key);
      try {
        const id = await client.registerMeter(sc.apiKey, sc.clientId, meta);
        if (!id) throw new DatenspendeRequestError('Keine meterId in der Antwort', 'missing_meter_id');
        sc.meters[key] = { id, name: meta.name, registeredAt: new Date(now()).toISOString() };
        changed = true;
        pushLog('datenspende_meter_registered', { key, name: meta.name });
      } catch (e) {
        if (e instanceof DatenspendeRequestError) {
          // Dauerhaft abgelehnt: Werte dieser Quelle verwerfen, sonst stauen sie sich.
          q().readings = q().readings.filter((r) => r.key !== key);
          pushLog('datenspende_meter_rejected', { key, error: e.message });
        } else {
          throw e; // Verbindung/Auth → ganzer Flush später erneut
        }
      }
    }
    if (changed && !commitSidecar(sc, (fresh) => { fresh.meters = { ...(fresh.meters || {}), ...sc.meters }; })) {
      throw new LinkChangedError();
    }
  }

  async function doFlush() {
    const sc = loadSidecar();
    if (!syncWithLink(sc)) return { skipped: 'not_linked' };
    if (!settings().enabled) return { skipped: 'disabled' };
    const qq = q();
    if (!qq.readings.length) return { ok: true, sent: 0 };
    const t = now();
    if (qq.lastFailAt && t - Date.parse(qq.lastFailAt) < HEAD_RETRY_BACKOFF_MS) return { skipped: 'backoff' };
    try {
      await ensureMeters(sc, [...new Set(qq.readings.map((r) => r.key))]);
      if (!sameLink(loadSidecar(), sc)) throw new LinkChangedError();
      // Während der Registrierung ausgeschaltet? Dann nichts mehr senden.
      if (!settings().enabled) {
        qq.readings = [];
        persistQueue();
        return { skipped: 'disabled' };
      }
      const batch = qq.readings.filter((r) => sc.meters?.[r.key]?.id).slice(0, MAX_BATCH_READINGS);
      if (!batch.length) return { ok: true, sent: 0 };
      const wire = batch.map((r) => {
        const w = { meter_id: sc.meters[r.key].id, timestamp: r.timestamp, power: r.power };
        if (r.energy !== undefined) w.energy = r.energy;
        return w;
      });
      const res = await client.submitBatch(sc.apiKey, sc.clientId, wire);
      const sent = new Set(batch);
      qq.readings = qq.readings.filter((r) => !sent.has(r));
      if (res.unknownMeters.length) {
        // Server kennt den Zähler nicht (mehr): Werte verwerfen, beim nächsten
        // Mal neu registrieren.
        const unknown = new Set(res.unknownMeters);
        const keys = Object.keys(sc.meters).filter((k) => unknown.has(sc.meters[k].id));
        for (const k of keys) delete sc.meters[k];
        qq.readings = qq.readings.filter((r) => !keys.includes(r.key));
        pushLog('datenspende_unknown_meters', { keys });
      }
      // Während des Sendens getrennt/neu verknüpft? Dann nichts zurückschreiben.
      if (!commitSidecar(sc, (fresh) => {
        fresh.meters = sc.meters;
        fresh.donated = (Number(fresh.donated) || 0) + res.accepted;
      })) throw new LinkChangedError();
      qq.headBlockedSince = null;
      qq.lastFailAt = null;
      qq.lastError = null;
      qq.lastFlushAt = new Date(t).toISOString();
      persistQueue();
      return { ok: true, sent: batch.length, accepted: res.accepted };
    } catch (e) {
      if (e instanceof LinkChangedError) {
        // Verknüpfung hat sich geändert — Warteschlange gehört nicht mehr zu ihr.
        syncWithLink(loadSidecar());
        return { ok: false, aborted: 'link_changed' };
      }
      const msg = String(e?.message || e).slice(0, 200);
      qq.lastError = msg;
      qq.lastFailAt = new Date(t).toISOString();
      if (e instanceof DatenspendeRequestError || e instanceof DatenspendeDuplicateError) {
        // Dauerhaft falsch → diesen Batch verwerfen, Rest weiter senden.
        dropHead(sc);
        qq.lastFailAt = null;
      } else if (e instanceof DatenspendeServerError) {
        qq.headBlockedSince = qq.headBlockedSince || new Date(t).toISOString();
        if (t - Date.parse(qq.headBlockedSince) > HEAD_BLOCK_TIMEOUT_MS) {
          dropHead(sc);
          qq.headBlockedSince = null;
          pushLog('datenspende_batch_dropped', { reason: 'server_error_timeout', error: msg });
        }
      } else if (e instanceof DatenspendeAuthError) {
        pushLog('datenspende_auth_error', { error: msg });
      }
      persistQueue();
      pushLog('datenspende_flush_error', { error: msg, kind: e?.name });
      return { ok: false, error: msg, kind: e?.name };
    }
  }
  function dropHead(sc) {
    const qq = q();
    const head = qq.readings.filter((r) => sc.meters?.[r.key]?.id).slice(0, MAX_BATCH_READINGS);
    const drop = new Set(head);
    qq.readings = qq.readings.filter((r) => !drop.has(r));
  }

  // ── Einrichtung ────────────────────────────────────────────────────────────
  // Generation: Trennen oder Ausschalten, während eine Einrichtung noch läuft,
  // verwirft deren Ergebnis — sonst stellte der späte Abschluss den Zugang
  // wieder her und schaltete die Spende gegen den Willen des Kunden ein.
  let linkGen = 0;
  function cancelPendingLink() { linkGen++; }

  async function link({ mode, username, password, email, secret, consent, household = {} }) {
    if (consent !== true) throw new DatenspendeAuthError('Ohne Einwilligung keine Teilnahme', 'consent_required');
    const gen = ++linkGen;
    const user = String(username || '').trim();
    if (!user || !password) throw new DatenspendeRequestError('Benutzername und Passwort nötig', 'missing_fields');
    const auth = mode === 'signin'
      ? await client.signIn({ username: user, password })
      : await client.signUp({ username: user, password, email, secret, consent: true });
    if (!auth.token || !auth.userId) throw new DatenspendeRequestError('Anmeldung ohne Token/Nutzer-ID', 'bad_response');
    let creds;
    try {
      const inhabitants = Number(household.numberInhabitants);
      const householdId = await client.createHousehold(auth.token, {
        userId: auth.userId,
        name: String(household.name || 'DVhub-Haushalt').slice(0, 80),
        numberInhabitants: Number.isInteger(inhabitants) && inhabitants > 0 ? inhabitants : undefined,
        zip: household.zip ? String(household.zip).slice(0, 12) : undefined,
        country: household.country ? String(household.country).slice(0, 56) : undefined,
      });
      const clientId = await client.createClient(auth.token, { householdId, name: 'DVhub', type: settings().clientType });
      const apiKey = await client.createApiKey(auth.token, { clientId, name: 'DVhub API-Key' });
      if (!householdId || !clientId || !apiKey) throw new DatenspendeRequestError('Einrichtung unvollständig', 'bad_response');
      creds = { apiKey, clientId, householdId };
    } finally {
      // Web-Session sofort beenden — dauerhaft genutzt wird nur der API-Key.
      try { await client.signOut(auth.token); } catch { /* best effort */ }
    }
    // Erst NACH dem letzten await prüfen und speichern: hat der Kunde während
    // der Einrichtung ausgeschaltet/getrennt, wird nichts gespeichert und die
    // Route schaltet die Spende nicht ein.
    if (gen !== linkGen) throw new DatenspendeRequestError('Einrichtung abgebrochen (Spende inzwischen beendet)', 'link_cancelled');
    const at = new Date(now()).toISOString();
    clearQueue();
    saveSidecar({ ...creds, userId: auth.userId, username: user, linkedAt: at, consentAt: at, meters: {}, donated: 0 });
    pushLog('datenspende_linked', { clientId: creds.clientId, mode: mode === 'signin' ? 'signin' : 'signup' });
    return status();
  }

  function unlink() {
    cancelPendingLink();
    try { fsImpl.unlinkSync(sidecarPath()); } catch { /* war nicht verknüpft */ }
    clearQueue();
    metaByKey.clear();
    pushLog('datenspende_unlinked', {});
    return status();
  }

  // Anmeldung mit einem beim Projekt erzeugten API-Key (ohne Passwort): der Key
  // wird beim Server geprüft, die Client-ID kommt von dort.
  async function linkApiKey({ apiKey, consent }) {
    if (consent !== true) throw new DatenspendeAuthError('Ohne Einwilligung keine Teilnahme', 'consent_required');
    const key = String(apiKey || '').trim();
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(key)) throw new DatenspendeRequestError('API-Key-Format ungültig', 'invalid_api_key');
    const gen = ++linkGen;
    const clientId = await client.getClientId(key);
    if (!clientId) throw new DatenspendeRequestError('Server lieferte keine Client-ID', 'bad_response');
    if (gen !== linkGen) throw new DatenspendeRequestError('Einrichtung abgebrochen (Spende inzwischen beendet)', 'link_cancelled');
    const at = new Date(now()).toISOString();
    clearQueue();
    saveSidecar({ apiKey: key, clientId, username: null, via: 'api_key', linkedAt: at, consentAt: at, meters: {}, donated: 0 });
    pushLog('datenspende_linked', { clientId, mode: 'api_key' });
    return status();
  }

  // ── Nachversand der Bestandsdaten ──────────────────────────────────────────
  // Arbeitet sich über einen Zeit-Cursor vom ältesten Datensatz bis zum Start
  // der Live-Spende (linkedAt) vor: erst Viertelstunden, ab Beginn der Live-
  // Daten ~5-s-Werte. Stand liegt im Sidecar (überlebt Neustarts). Einreichen
  // ist idempotent — ein wiederholtes Fenster erzeugt keine Doppelten.
  const sleep = deps.sleep || ((ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); }));
  let backfillRunning = null;

  function startBackfill() {
    const sc = loadSidecar();
    if (!sc) throw new DatenspendeRequestError('Nicht verknüpft', 'not_linked');
    if (sc.backfill?.status === 'running') { kickBackfill(); return status(); }
    const until = sc.linkedAt || new Date(now()).toISOString();
    const prev = sc.backfill || {};
    // Nach „fertig“/„gestoppt“/Fehler am alten Stand weitermachen, statt alles neu zu senden.
    commitSidecar(sc, (f) => {
      f.backfill = { ...prev, status: 'running', until, error: null, startedAt: prev.startedAt || new Date(now()).toISOString(), sent: prev.sent || 0 };
    });
    pushLog('datenspende_backfill_started', { until });
    kickBackfill();
    return status();
  }
  function stopBackfill() {
    const sc = loadSidecar();
    if (sc?.backfill) commitSidecar(sc, (f) => { f.backfill = { ...f.backfill, status: 'stopped' }; });
    return status();
  }
  function kickBackfill() {
    if (backfillRunning) return backfillRunning;
    backfillRunning = runBackfill().catch((e) => {
      pushLog('datenspende_backfill_error', { error: String(e?.message || e) });
    }).finally(() => { backfillRunning = null; });
    return backfillRunning;
  }
  function setBackfill(sc, patch) {
    return commitSidecar(sc, (f) => { f.backfill = { ...(f.backfill || {}), ...patch }; });
  }
  function backfillTileIds() {
    return (ctx.familyMqttTiles?.getTiles?.() || [])
      .filter((t) => /^k?W$/.test(String(t?.unit || '').trim()))
      .map((t) => String(t.id));
  }

  async function runBackfill() {
    for (;;) {
      const sc = loadSidecar();
      if (!sc || sc.backfill?.status !== 'running') return;
      if (!settings().enabled) return; // pausiert mit der Spende; läuft beim Einschalten weiter
      const db = ctx.db;
      if (!db || typeof db.query !== 'function') { setBackfill(sc, { status: 'error', error: 'Keine Datenbank verfügbar' }); return; }
      const cfg = getCfg();
      const src = cfg.datenspende?.sources || {};
      const sources = Object.fromEntries(SOURCE_GROUPS.map((g) => [g, src[g] !== false]));
      const bf = sc.backfill;
      let cursor = bf.cursor;
      let liveStart = bf.liveStart;
      if (!cursor) {
        const b = await findHistoryBounds(db, sources);
        liveStart = b.liveStart;
        cursor = b.firstSlot || b.liveStart || bf.until;
        if (!setBackfill(sc, { cursor, liveStart, firstData: cursor })) return;
      }
      const c = Date.parse(cursor);
      const until = Date.parse(bf.until);
      if (!(c < until)) {
        setBackfill(sc, { status: 'done', finishedAt: new Date(now()).toISOString() });
        pushLog('datenspende_backfill_done', { sent: bf.sent || 0 });
        return;
      }
      const ls = liveStart ? Date.parse(liveStart) : until;
      const inSlots = c < ls;
      const end = Math.min(c + (inSlots ? BACKFILL_SLOT_WINDOW_MS : BACKFILL_LIVE_WINDOW_MS), inSlots ? ls : until, until);
      const fromIso = new Date(c).toISOString();
      const toIso = new Date(end).toISOString();
      let accepted = 0;
      try {
        const readings = inSlots
          ? await readSlotWindow(db, fromIso, toIso, sources)
          : await readLiveWindow(db, fromIso, toIso, sources, backfillTileIds());
        if (readings.length) {
          const local = { ...sc, meters: { ...(sc.meters || {}) } };
          await ensureMeters(local, [...new Set(readings.map((r) => r.key))]);
          const ok = readings.filter((r) => local.meters?.[r.key]?.id);
          for (let i = 0; i < ok.length; i += MAX_BATCH_READINGS) {
            const cur = loadSidecar();
            if (!sameLink(cur, sc) || cur.backfill?.status !== 'running' || !settings().enabled) return;
            const wire = ok.slice(i, i + MAX_BATCH_READINGS).map((r) => ({ meter_id: local.meters[r.key].id, timestamp: r.timestamp, power: r.power }));
            const res = await client.submitBatch(sc.apiKey, sc.clientId, wire);
            accepted += res.accepted;
            await sleep(BACKFILL_PAUSE_MS);
          }
        }
      } catch (e) {
        if (e instanceof LinkChangedError) return;
        const msg = String(e?.message || e).slice(0, 200);
        if (e instanceof DatenspendeRequestError || e instanceof DatenspendeDuplicateError) {
          // Server lehnt die Daten dauerhaft ab (z. B. zu alte Zeitstempel): anhalten
          // und sichtbar melden — nicht stillschweigend überspringen.
          setBackfill(sc, { status: 'error', error: msg, errorAt: fromIso });
          pushLog('datenspende_backfill_rejected', { error: msg, window: fromIso });
          return;
        }
        setBackfill(sc, { error: msg });
        await sleep(BACKFILL_RETRY_MS);
        continue; // gleiches Fenster erneut
      }
      if (!commitSidecar(sc, (f) => {
        f.backfill = { ...(f.backfill || {}), cursor: toIso, sent: (Number(f.backfill?.sent) || 0) + accepted, error: null };
        f.donated = (Number(f.donated) || 0) + accepted;
      })) return;
    }
  }

  function status() {
    const sc = loadSidecar();
    const saved = readJson(queuePath()) || {};
    const live = queue && sc && queue.clientId === sc.clientId ? queue : saved;
    const cfg = getCfg();
    let preview = [];
    try { preview = collectSources(ctx, cfg, now()).map(({ key, name, power, energy }) => ({ key, name, power, energy: energy ?? null })); } catch { /* Anzeige best effort */ }
    return {
      linked: !!sc,
      ...settings(),
      sources: SOURCE_GROUPS.reduce((o, g) => ({ ...o, [g]: (cfg.datenspende?.sources || {})[g] !== false }), {}),
      clientId: sc?.clientId || null,
      username: sc?.username || null,
      linkedAt: sc?.linkedAt || null,
      donated: Number(sc?.donated) || 0,
      meters: Object.entries(sc?.meters || {}).map(([key, m]) => ({ key, name: m.name, meterId: m.id })),
      queued: Array.isArray(live.readings) ? live.readings.length : 0,
      lastSampleAt: live.lastSampleAt || null,
      lastFlushAt: live.lastFlushAt || null,
      lastError: live.lastError || null,
      preview,
      backfill: sc?.backfill ? {
        status: sc.backfill.status, cursor: sc.backfill.cursor || null, until: sc.backfill.until || null,
        firstData: sc.backfill.firstData || null, liveStart: sc.backfill.liveStart || null,
        sent: Number(sc.backfill.sent) || 0, error: sc.backfill.error || null, finishedAt: sc.backfill.finishedAt || null,
      } : null,
      projectUrl: 'https://datenspende.comsys.rwth-aachen.de',
    };
  }

  // ── Timer ──────────────────────────────────────────────────────────────────
  let sampleTimer = null;
  let flushTimer = null;
  let lastSampleMs = 0;
  let stopped = true;
  function scheduleFlush(delayMs) {
    flushTimer = setTimeout(async () => {
      try { await flush(); } catch (e) { pushLog('datenspende_flush_error', { error: String(e?.message || e) }); }
      // Nachversand, der wegen Pause ruhte, beim nächsten Takt wieder aufnehmen.
      try { if (settings().enabled && loadSidecar()?.backfill?.status === 'running') kickBackfill(); } catch { /* best effort */ }
      if (!stopped) scheduleFlush(fixedFlushMs || (BATCH_INTERVAL_MIN_S + random() * (BATCH_INTERVAL_MAX_S - BATCH_INTERVAL_MIN_S)) * 1000);
    }, delayMs);
    if (flushTimer.unref) flushTimer.unref();
  }
  function start() {
    if (!stopped) return;
    stopped = false;
    // 1-s-Takt, gesampelt wird im konfigurierten Abstand (Änderung wirkt ohne Neustart).
    sampleTimer = setInterval(() => {
      try {
        const t = now();
        if (t - lastSampleMs >= settings().intervalSec * 1000) { lastSampleMs = t; sample(); }
      } catch (e) { pushLog('datenspende_sample_error', { error: String(e?.message || e) }); }
    }, 1000);
    if (sampleTimer.unref) sampleTimer.unref();
    // Erster Versand irgendwann im ersten Intervall — nach einem Neustart vieler
    // Anlagen nicht alle im selben Moment.
    scheduleFlush(fixedFlushMs || random() * BATCH_INTERVAL_MAX_S * 1000);
    // Unterbrochenen Nachversand fortsetzen (nach Neustart).
    const resume = setTimeout(() => { if (!stopped && loadSidecar()?.backfill?.status === 'running') kickBackfill(); }, 10_000);
    if (resume.unref) resume.unref();
  }
  function stop() {
    stopped = true;
    if (sampleTimer) clearInterval(sampleTimer);
    if (flushTimer) clearTimeout(flushTimer);
    sampleTimer = flushTimer = null;
    if (queue) persistQueue();
  }

  return { sample, flush, link, linkApiKey, unlink, cancelPendingLink, status, start, stop, settings, startBackfill, stopBackfill, runBackfill: kickBackfill };
}
