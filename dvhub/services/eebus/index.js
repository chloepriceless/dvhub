// services/eebus/index.js — EEBUS in DVhub (§14a-Steuerbox und EEBUS-Geräte).
//
// Das Protokoll spricht der Hilfsprozess dvhub-eebus (C, openeebus von NIBE,
// dvhub/eebus/). Dieser Dienst startet und überwacht ihn, hält Kopplungen und
// Geräte, führt die Zustandsmaschinen der Netzseite (limit-state.js) und setzt
// die Grenzen in DVhubs bestehende Steuerpfade um:
//
//   Bezugsgrenze (LPC, §14a)  → Akku lädt nicht aus dem Netz (schedule-eval),
//                               Wallbox und EEBUS-Geräte (Wärmepumpe …) teilen
//                               sich die Grenze anteilig nach Nennleistung
//   Einspeisegrenze (LPP)     → Einspeisebegrenzer (feed-in-limit-arbiter,
//                               Victron 2706); ohne Begrenzer Einspeisesperre
//   Netzanschlusspunkt (MGCP) → Leistung und Zählerstände an die Steuerbox
//   Verdichter (OHPCF)        → angekündigte Läufe in den günstigsten Zeitraum
//
// Protokoll mit dem Hilfsprozess: siehe dvhub/eebus/bridge/main.c.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';

import { createLimitStateMachine } from './limit-state.js';
import { readApplianceId } from '../support-tunnel.js';

export const EEBUS_DEFAULT_PORT = 4712;
const RESTART_DELAYS_MS = [5_000, 10_000, 30_000, 60_000];
const REQUEST_TIMEOUT_MS = 10_000;
const PAIRING_WINDOW_MS = 10 * 60_000;
const GCP_INTERVAL_MS = 5_000;
const DEVICE_LIMIT_REFRESH_MS = 5 * 60_000;
const STDERR_KEEP = 40;
// Gerätetypen von Steuerboxen/Gateways (u. a. EEBUS-Handwerkertool: „GCPH“).
const GRID_ROLE_HINT = /(control|guard|gateway|grid|smgw|steuer|gcph|connectionhub)/i;

export const EEBUS_BINARY_CANDIDATES = [
  '/opt/dvhub/bin/dvhub-eebus',
  '/usr/local/bin/dvhub-eebus',
];

/** Normalisierte Einstellungen (config.json → eebus). */
// EEBUS zählt Erzeugung negativ: Steuerboxen schreiben die Einspeisegrenze (LPP)
// z. B. als -4200 W. DVhub rechnet mit dem Betrag.
function gridW(uc, w) {
  const n = Number(w);
  return uc === 'lpp' && Number.isFinite(n) ? Math.abs(n) : n;
}

export function resolveEebusConfig(cfg) {
  const e = cfg?.eebus || {};
  const num = (v, d, min = 0) => (Number.isFinite(Number(v)) && Number(v) >= min ? Number(v) : d);
  const port = Number(e.port);
  return {
    enabled: e.enabled === true,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : EEBUS_DEFAULT_PORT,
    binaryPath: typeof e.binaryPath === 'string' && e.binaryPath.trim() ? e.binaryPath.trim() : null,
    trusted: (Array.isArray(e.trusted) ? e.trusted : [])
      .filter((t) => t && /^[0-9a-f]{40}$/.test(String(t.ski || '').toLowerCase()))
      .map((t) => ({
        ski: String(t.ski).toLowerCase(),
        name: String(t.name || '').slice(0, 80),
        role: t.role === 'grid' ? 'grid' : 'device',
        addedAt: t.addedAt || null,
      })),
    grid: {
      consumptionNominalMaxW: num(e.grid?.consumptionNominalMaxW, 0),
      // 0 = automatisch: Mindestleistung Pmin,14a (services/paragraph14a), mind. 4200 W
      failsafeConsumptionW: num(e.grid?.failsafeConsumptionW, 0),
      failsafeConsumptionDurationS: num(e.grid?.failsafeConsumptionDurationS, 7200, 7200),
      productionNominalMaxW: num(e.grid?.productionNominalMaxW, 0),
      failsafeProductionW: num(e.grid?.failsafeProductionW, 0),
      failsafeProductionDurationS: num(e.grid?.failsafeProductionDurationS, 7200, 7200),
    },
    devices: {
      // §14a-Grenze an gekoppelte EEBUS-Geräte (Wärmepumpe, Wallbox) weitergeben.
      forwardGridLimit: e.devices?.forwardGridLimit !== false,
      defaultNominalW: num(e.devices?.defaultNominalW, 4200, 1),
    },
    ohpcf: {
      mode: ['cheapest', 'immediate', 'off'].includes(e.ohpcf?.mode) ? e.ohpcf.mode : 'cheapest',
    },
  };
}

/**
 * Startzeitpunkt für einen angekündigten Verdichterlauf (OHPCF): der Beginn
 * im erlaubten Fenster mit dem niedrigsten mittleren Börsenpreis über die
 * Mindestlaufzeit. Ohne Preise: frühestmöglich.
 * @returns {number} Sekunden ab jetzt
 */
export function planOhpcfStart(announce, priceSlots, nowMs) {
  const earliest = Math.max(0, Number(announce?.earliest_start_s) || 0);
  const latestEnd = Number(announce?.latest_end_s) || 0;
  const minDur = Math.max(0, Number(announce?.min_duration_s) || 0);
  const latestStart = latestEnd > 0 ? latestEnd - minDur : earliest;
  const slots = (priceSlots || [])
    .filter((p) => Number.isFinite(Number(p?.ts)) && Number.isFinite(Number(p?.ct_kwh)))
    .map((p) => ({ ts: Number(p.ts), ct: Number(p.ct_kwh) }))
    .sort((a, b) => a.ts - b.ts);
  if (!slots.length || latestStart <= earliest) return earliest;
  const priceAt = (ms) => {
    let cur = null;
    for (const p of slots) { if (p.ts <= ms) cur = p.ct; else break; }
    return cur;
  };
  const step = 15 * 60;
  let best = earliest;
  let bestCost = Infinity;
  for (let s = earliest; s <= latestStart; s += step) {
    let sum = 0;
    let n = 0;
    for (let t = s; t < s + Math.max(minDur, 1); t += step) {
      const ct = priceAt(nowMs + t * 1000);
      if (ct == null) { n = 0; break; }
      sum += ct;
      n += 1;
    }
    if (n && sum / n < bestCost - 1e-9) { bestCost = sum / n; best = s; }
  }
  return best;
}

/** Leistung am Netzanschlusspunkt für MGCP: Bezug positiv, Einspeisung negativ. */
export function gridImportPositiveW(state, cfg) {
  const total = Number(state?.meter?.grid_total_w);
  if (!Number.isFinite(total)) return null;
  return cfg?.gridPositiveMeans === 'grid_import' ? total : -total;
}

export function createEebusService(ctx, deps = {}) {
  const { state, getCfg, pushLog = () => {} } = ctx;
  const spawn = deps.spawn || nodeSpawn;
  const execFile = deps.execFile || nodeExecFile;
  const fsImpl = deps.fs || fs;
  const now = deps.now || (() => Date.now());
  const setTimer = deps.setTimeout || setTimeout;
  const clearTimer = deps.clearTimeout || clearTimeout;
  const setIntervalFn = deps.setInterval || setInterval;
  const clearIntervalFn = deps.clearInterval || clearInterval;
  const dataDir = path.join(deps.dataDir || ctx.dataDir || process.env.DV_DATA_DIR || process.cwd(), 'eebus');

  const ui = (state.eebus = {
    status: 'disabled',     // disabled | not_installed | starting | running | restarting | error
    error: null,
    ski: null,
    shipId: null,
    port: null,
    qr: null,
    pairing: { on: false, until: null },
    discovered: [],         // mDNS
    peers: {},              // ski → { connected, shipId, lastSeen, waitingTrust }
    grid: { lpc: null, lpp: null, lastWriteSki: null },
    devices: {},            // ski → { entities:{lpc,lpp,mpc,ohpcf}, powerW, nominalW, limit, ohpcf }
    applied: { consumptionLimitW: null, productionLimitW: null, productionBlock: false },
    stderr: [],
    startedAt: null,
    restarts: 0,
  });

  let child = null;
  let stopping = false;
  let restartTimer = null;
  let restartIndex = 0;
  let pairingTimer = null;
  let tickTimer = null;
  let gcpTimer = null;
  let reqId = 0;
  const pending = new Map();
  const deviceLimitCache = new Map(); // entity → { w, at }
  let lastConfigKey = null;
  let prevConsumptionW = null;
  const energy = loadJson('energy.json') || { importWh: 0, exportWh: 0, lastDailyImportWh: null, lastDailyExportWh: null };
  let lastEnergySave = 0;

  const cfgNow = () => resolveEebusConfig(getCfg());
  const roleOf = (ski) => cfgNow().trusted.find((t) => t.ski === ski)?.role || null;
  const hasGridPeer = () => cfgNow().trusted.some((t) => t.role === 'grid');

  // Failsafe-Vorgabe ohne eigenen Wert: die Mindestleistung nach § 14a
  // (bei mehreren steuerbaren Verbrauchseinrichtungen mehr als 4,2 kW).
  function autoFailsafeConsumptionW() {
    return Math.max(4200, Number(ctx.p14a?.pminW?.()) || 0);
  }

  function makeMachine(kind, c) {
    return kind === 'lpc'
      ? createLimitStateMachine({ kind, failsafeW: c.grid.failsafeConsumptionW || autoFailsafeConsumptionW(), failsafeDurationS: c.grid.failsafeConsumptionDurationS, now })
      // 0 = keine Vorgabe → Nennleistung: ein Abbruch zur Steuerbox darf die
      // PV nicht für Stunden auf null setzen, solange sie selbst nichts schreibt.
      : createLimitStateMachine({ kind, failsafeW: c.grid.failsafeProductionW || c.grid.productionNominalMaxW || defaultProductionNominal(), failsafeDurationS: c.grid.failsafeProductionDurationS, now });
  }
  let machines = { lpc: makeMachine('lpc', cfgNow()), lpp: makeMachine('lpp', cfgNow()) };

  // --- Dateien --------------------------------------------------------------

  function loadJson(name) {
    try { return JSON.parse(fsImpl.readFileSync(path.join(dataDir, name), 'utf8')); } catch { return null; }
  }

  function saveJson(name, data) {
    try {
      fsImpl.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const file = path.join(dataDir, name);
      fsImpl.writeFileSync(`${file}.tmp`, JSON.stringify(data));
      fsImpl.renameSync(`${file}.tmp`, file);
    } catch (e) {
      pushLog('eebus_persist_error', { file: name, error: e?.message || String(e) });
    }
  }

  function saveGridState() {
    saveJson('grid-state.json', { lpc: machines.lpc.toJSON(), lpp: machines.lpp.toJSON() });
  }

  // --- Hilfsprozess -----------------------------------------------------------

  function findBinary(c) {
    const candidates = [c.binaryPath, ...EEBUS_BINARY_CANDIDATES, path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'bin', 'dvhub-eebus')]
      .filter(Boolean);
    for (const p of candidates) {
      try {
        fsImpl.accessSync(p, fs.constants.X_OK);
        return p;
      } catch { /* weiter */ }
    }
    return null;
  }

  // SHIP-ID/Seriennummer: das Geräte-Kennzeichen der Box (bleibt beim
  // Geräte-Tausch per Export erhalten), sonst der Hostname.
  function serialNumber() {
    const id = readApplianceId(path.dirname(dataDir), fsImpl);
    if (id) return id.replace(/[^A-Za-z0-9-]/g, '').slice(0, 32);
    return (os.hostname() || 'dvhub').replace(/[^A-Za-z0-9-]/g, '').slice(0, 32) || 'dvhub';
  }

  function certPaths() {
    return { cert: path.join(dataDir, 'cert.pem'), key: path.join(dataDir, 'key.pem') };
  }

  function ensureCert(bin) {
    const { cert, key } = certPaths();
    if (fsImpl.existsSync(cert) && fsImpl.existsSync(key)) return Promise.resolve();
    fsImpl.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    return new Promise((resolve, reject) => {
      execFile(bin, ['--gen-cert', cert, key, `DVhub-${serialNumber()}`], { timeout: 15_000 }, (err) => {
        if (err) reject(new Error(`Zertifikat konnte nicht erzeugt werden: ${err.message}`));
        else {
          pushLog('eebus_cert_created', {});
          resolve();
        }
      });
    });
  }

  function send(cmd) {
    if (!child || !child.stdin?.writable) return Promise.resolve({ ok: false, error: 'eebus not running' });
    const id = ++reqId;
    const line = JSON.stringify({ ...cmd, id });
    return new Promise((resolve) => {
      const timer = setTimer(() => {
        pending.delete(id);
        resolve({ ok: false, error: 'timeout' });
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, timer, cmd: cmd.cmd });
      try { child.stdin.write(`${line}\n`); } catch (e) {
        clearTimer(timer);
        pending.delete(id);
        resolve({ ok: false, error: e?.message || 'write failed' });
      }
    });
  }

  async function start() {
    const c = cfgNow();
    lastConfigKey = configKey(c);
    if (!c.enabled) {
      ui.status = 'disabled';
      return;
    }
    const bin = findBinary(c);
    if (!bin) {
      ui.status = 'not_installed';
      ui.error = 'dvhub-eebus wird gebaut (startet DVhub neu oder läuft gerade im Hintergrund) — '
        + 'auf nativen Installationen über eebus-provision.sh';
      // Der Bau läuft entkoppelt (post-update.sh): jede Minute nachsehen.
      if (!restartTimer) restartTimer = setTimer(() => { restartTimer = null; start(); }, 60_000);
      return;
    }
    try {
      await ensureCert(bin);
    } catch (e) {
      ui.status = 'error';
      ui.error = e.message;
      pushLog('eebus_error', { error: e.message });
      return;
    }

    machines = { lpc: makeMachine('lpc', c), lpp: makeMachine('lpp', c) };
    const enabled = hasGridPeer();
    machines.lpc.setEnabled(enabled);
    machines.lpp.setEnabled(enabled);
    // Bei jedem Start frisch lesen: auch der Neustart nach einem Absturz des
    // Hilfsprozesses muss die zuletzt geschriebenen Failsafe-Werte übernehmen,
    // nicht den Stand vom Start von DVhub.
    const savedGrid = loadJson('grid-state.json');
    if (savedGrid) {
      machines.lpc.restore(savedGrid.lpc);
      machines.lpp.restore(savedGrid.lpp);
    }
    spawnChild(bin, c);
    if (!tickTimer) tickTimer = setIntervalFn(tick, 1_000);
    if (!gcpTimer) gcpTimer = setIntervalFn(pushGcp, GCP_INTERVAL_MS);
  }

  function spawnChild(bin, c) {
    const { cert, key } = certPaths();
    const args = ['--port', String(c.port), '--cert', cert, '--key', key, '--serial', serialNumber()];
    for (const t of c.trusted) args.push('--trust', t.ski);
    ui.status = 'starting';
    ui.error = null;
    ui.port = c.port;
    stopping = false;
    child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        try { handleEvent(ev); } catch (e) { pushLog('eebus_event_error', { ev: ev?.ev, error: e?.message || String(e) }); }
      }
      if (buf.length > 1_000_000) buf = '';
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      for (const l of String(chunk).split('\n')) {
        const line = l.trim();
        if (!line) continue;
        ui.stderr.push(line.slice(0, 300));
        if (ui.stderr.length > STDERR_KEEP) ui.stderr.shift();
      }
    });
    child.on('error', (e) => {
      ui.status = 'error';
      ui.error = e?.message || String(e);
    });
    child.on('exit', (code, signal) => {
      child = null;
      for (const [, p] of pending) { clearTimer(p.timer); p.resolve({ ok: false, error: 'eebus exited' }); }
      pending.clear();
      for (const peer of Object.values(ui.peers)) peer.connected = false;
      if (stopping) { ui.status = cfgNow().enabled ? 'stopped' : 'disabled'; return; }
      ui.status = 'restarting';
      ui.restarts += 1;
      pushLog('eebus_exit', { code, signal, restarts: ui.restarts, stderr: ui.stderr.slice(-3) });
      const delay = RESTART_DELAYS_MS[Math.min(restartIndex, RESTART_DELAYS_MS.length - 1)];
      restartIndex += 1;
      restartTimer = setTimer(() => { restartTimer = null; start(); }, delay);
    });
  }

  async function onReady(ev) {
    ui.status = 'running';
    ui.ski = ev.ski || null;
    ui.shipId = ev.ship_id || null;
    ui.qr = ev.qr || null;
    ui.startedAt = now();
    restartIndex = 0;
    const c = cfgNow();
    const lpcNominal = c.grid.consumptionNominalMaxW || defaultConsumptionNominal();
    const lppNominal = c.grid.productionNominalMaxW || defaultProductionNominal();
    const lpc = machines.lpc.snapshot();
    const lpp = machines.lpp.snapshot();
    await send({ cmd: 'grid_config', uc: 'lpc', nominal_max_w: lpcNominal, failsafe_w: lpc.failsafeW, failsafe_duration_s: lpc.failsafeDurationS });
    await send({ cmd: 'grid_config', uc: 'lpp', nominal_max_w: lppNominal, failsafe_w: lpp.failsafeW, failsafe_duration_s: lpp.failsafeDurationS });
    pushLog('eebus_ready', { ski: ui.ski, port: ui.port });
  }

  function defaultConsumptionNominal() {
    // Hausanschluss unbekannt: 3 × 63 A ist die typische Obergrenze in DE.
    return 43_470;
  }

  function defaultProductionNominal() {
    const plants = Array.isArray(getCfg()?.userEnergyPricing?.pvPlants) ? getCfg().userEnergyPricing.pvPlants : [];
    const kwp = plants.reduce((s, p) => s + (Number(p?.kwp) > 0 ? Number(p.kwp) : 0), 0);
    return kwp > 0 ? Math.round(kwp * 1000) : 30_000;
  }

  // --- Ereignisse des Hilfsprozesses -----------------------------------------

  function peer(ski) {
    if (!ski) return null;
    ui.peers[ski] ||= { connected: false, shipId: null, lastSeen: null, waitingTrust: false };
    return ui.peers[ski];
  }

  function device(ski) {
    ui.devices[ski] ||= { entities: {}, powerW: null, nominalW: null, limit: null, failsafe: null, ohpcf: null, measurements: {} };
    return ui.devices[ski];
  }

  function handleEvent(ev) {
    switch (ev.ev) {
      case 'ready': onReady(ev); break;
      case 'fatal':
        ui.status = 'error';
        ui.error = ev.error === 'port in use'
          ? `EEBUS-Port ${ev.port} ist belegt (anderer EEBUS-Dienst auf diesem Gerät?) — Port in den Einstellungen ändern`
          : (ev.error || 'dvhub-eebus konnte nicht starten');
        pushLog('eebus_fatal', { error: ev.error, port: ev.port });
        break;
      case 'reply': {
        const p = pending.get(ev.id);
        if (p) { clearTimer(p.timer); pending.delete(ev.id); p.resolve(ev); }
        break;
      }
      case 'write_result':
        if (!ev.ok) pushLog('eebus_device_write_rejected', { id: ev.id });
        break;
      case 'mdns':
        ui.discovered = (ev.services || []).filter((s) => s && s.ski && s.ski !== ui.ski).map((s) => ({
          ski: String(s.ski).toLowerCase(), name: s.name || null, brand: s.brand || null, model: s.model || null,
          type: s.type || null, host: s.host || null, port: s.port || null, register: s.register === 'true',
          suggestedRole: GRID_ROLE_HINT.test(`${s.type || ''} ${s.model || ''}`) ? 'grid' : 'device',
        }));
        break;
      case 'connected': {
        const p = peer(ev.ski);
        p.connected = true;
        p.lastSeen = now();
        p.waitingTrust = false;
        pushLog('eebus_connected', { ski: ev.ski, role: roleOf(ev.ski) });
        break;
      }
      case 'disconnected': {
        const p = peer(ev.ski);
        p.connected = false;
        p.lastSeen = now();
        pushLog('eebus_disconnected', { ski: ev.ski, role: roleOf(ev.ski) });
        break;
      }
      case 'ship_id': peer(ev.ski).shipId = ev.ship_id || null; break;
      case 'ship_state':
        if (ev.label === 'waiting_trust' && !roleOf(ev.ski)) peer(ev.ski).waitingTrust = true;
        break;

      // Netzseite (Steuerbox)
      case 'grid_write':
        ui.grid.lastWriteSki = ev.ski || null;
        // Jeder Schreibversuch der Steuerbox ins Protokoll, abgelehnte als Warnung:
        // sonst ist nicht nachvollziehbar, warum eine Vorgabe nicht ankam.
        pushLog(ev.approved ? 'paragraph14a_write' : 'paragraph14a_write_denied', {
          uc: ev.uc, kind: ev.kind, w: ev.w ?? null, durationS: ev.duration_s ?? null, active: ev.active ?? null, ski: ev.ski || null,
        }, ev.approved ? 'info' : 'warn');
        if (ev.ski && roleOf(ev.ski) !== 'grid') {
          pushLog('eebus_grid_write_from_non_grid_peer', { ski: ev.ski, uc: ev.uc, kind: ev.kind });
          break;
        }
        // Failsafe-Werte nur aus echten Schreibvorgängen der Steuerbox: openeebus
        // meldet bei jeder Änderung auch den unveränderten Wert des anderen
        // Anwendungsfalls (grid_failsafe_*), das ist keine Vorgabe.
        if (ev.approved && ev.kind === 'failsafe_limit') {
          machines[ev.uc]?.onFailsafeLimit(gridW(ev.uc, ev.w));
          saveGridState();
          apply();
        } else if (ev.approved && ev.kind === 'failsafe_duration') {
          machines[ev.uc]?.onFailsafeDuration(ev.duration_s);
          saveGridState();
        }
        break;
      case 'grid_write_expired':
        pushLog('paragraph14a_write_expired', { uc: ev.uc, ski: ev.ski || null }, 'warn');
        break;
      case 'grid_limit':
        if (ui.grid.lastWriteSki && roleOf(ui.grid.lastWriteSki) !== 'grid') break;
        machines[ev.uc]?.onLimit({ w: gridW(ev.uc, ev.w), durationS: ev.duration_s, active: ev.active });
        pushLog('paragraph14a_limit_received', { uc: ev.uc, w: ev.w, durationS: ev.duration_s, active: ev.active });
        saveGridState();
        apply();
        break;
      case 'grid_failsafe_limit':
      case 'grid_failsafe_duration':
        break; // siehe grid_write
      case 'grid_heartbeat_state':
        machines.lpc.onHeartbeat(ev.lpc_ok === true);
        machines.lpp.onHeartbeat(ev.lpp_ok === true);
        apply();
        break;

      // Geräteseite
      case 'device_added':
      case 'device_removed': {
        if (!ev.ski || roleOf(ev.ski) !== 'device') break;
        const d = device(ev.ski);
        if (ev.ev === 'device_added') d.entities[ev.uc] = ev.entity;
        else if (d.entities[ev.uc] === ev.entity) delete d.entities[ev.uc];
        apply();
        break;
      }
      case 'device_nominal_max':
        if (ev.ski && roleOf(ev.ski) === 'device' && ev.uc === 'lpc') device(ev.ski).nominalW = Number(ev.w) || null;
        break;
      case 'device_limit':
        if (ev.ski && roleOf(ev.ski) === 'device') device(ev.ski).limit = { uc: ev.uc, w: ev.w, active: ev.active, at: now() };
        break;
      case 'device_measurement':
        if (ev.ski && roleOf(ev.ski) === 'device') {
          const d = device(ev.ski);
          d.measurements[ev.name] = ev.value;
          if (ev.name === 'power_w') d.powerW = ev.value;
        }
        break;
      case 'ohpcf_announce': onOhpcfAnnounce(ev); break;
      case 'ohpcf_state':
        if (ev.ski && roleOf(ev.ski) === 'device') {
          const d = device(ev.ski);
          d.ohpcf = { ...(d.ohpcf || {}), state: ev.state, startInS: ev.start_in_s ?? null, at: now() };
        }
        break;
      case 'ohpcf_clear':
        if (ev.ski && ui.devices[ev.ski]) ui.devices[ev.ski].ohpcf = null;
        break;
      default:
        break;
    }
  }

  async function onOhpcfAnnounce(ev) {
    if (!ev.ski || roleOf(ev.ski) !== 'device') return;
    const d = device(ev.ski);
    const mode = cfgNow().ohpcf.mode;
    d.ohpcf = { state: 'announced', announce: ev, at: now() };
    if (mode === 'off') return;
    const startInS = mode === 'immediate' ? Number(ev.earliest_start_s) || 0 : planOhpcfStart(ev, state.epex?.data, now());
    const res = await send({ cmd: 'ohpcf', action: 'schedule', entity: ev.entity, start_in_s: startInS });
    d.ohpcf = { ...d.ohpcf, plannedStartInS: startInS, plannedAt: now(), scheduleOk: res?.ok === true };
    pushLog('eebus_ohpcf_scheduled', { ski: ev.ski, startInS, mode, ok: res?.ok === true });
  }

  // --- Umsetzung ----------------------------------------------------------------

  /**
   * Verbundene EEBUS-Geräte mit LPC — für die §14a-Aufteilung
   * (services/paragraph14a). Art: mit Verdichter-Ankündigung (OHPCF) eine
   * Wärmepumpe, sonst die Rolle aus der Kopplung, Vorgabe Wärmepumpe.
   */
  function consumptionDevices() {
    const c = cfgNow();
    if (!c.devices.forwardGridLimit) return [];
    const list = [];
    for (const [ski, d] of Object.entries(ui.devices)) {
      if (!d.entities.lpc || !ui.peers[ski]?.connected) continue;
      const trusted = c.trusted.find((t) => t.ski === ski);
      list.push({
        id: `eebus:${ski}`,
        ski,
        entity: d.entities.lpc,
        name: trusted?.name || null,
        kind: d.entities.ohpcf ? 'waermepumpe' : (trusted?.kind || 'waermepumpe'),
        maxW: d.nominalW || c.devices.defaultNominalW,
        powerW: d.powerW ?? null,
      });
    }
    return list;
  }

  /**
   * Anteile der §14a-Grenze an die Geräte schreiben (id → W, null = frei).
   * @param {Record<string, number|null>} shares
   * @param {number|null} untilMs  Ende der Grenze (für die Dauer am Gerät)
   */
  function applyConsumptionShares(shares, untilMs) {
    const list = consumptionDevices();
    const active = {};
    for (const d of list) if (shares?.[d.id] != null) active[d.id] = shares[d.id];
    applyDeviceLimits(active, list.filter((d) => active[d.id] != null), { until: untilMs });
  }

  function apply() {
    machines.lpc.evaluate();
    machines.lpp.evaluate();
    const lpc = machines.lpc.effective();
    const lpp = machines.lpp.effective();
    ui.grid.lpc = machines.lpc.snapshot();
    ui.grid.lpp = machines.lpp.snapshot();

    // Bezug (LPC)
    const consumptionW = Number.isFinite(lpc.limitW) ? lpc.limitW : null;
    if (consumptionW !== ui.applied.consumptionLimitW) {
      pushLog(consumptionW == null ? 'paragraph14a_consumption_released' : 'paragraph14a_consumption_limited', {
        limitW: consumptionW, state: lpc.state, until: lpc.until ? new Date(lpc.until).toISOString() : null,
      });
      ctx.telemetrySafeWrite?.(() => ctx.telemetryStore?.writeControlEvent({
        eventType: consumptionW == null ? 'p14a_consumption_released' : 'p14a_consumption_limited',
        target: 'eebus_lpc', valueNum: consumptionW, reason: lpc.reason, source: 'netzbetreiber',
      }));
    }
    ui.applied.consumptionLimitW = consumptionW;
    state.ctrl.eebusConsumptionLimitW = consumptionW;
    state.ctrl.eebusConsumptionLimitUntil = consumptionW == null ? null : (lpc.until ?? null);
    // Aufteilung auf Wallbox, Speicher und Geräte: services/paragraph14a
    // (Grenze, Relais, Mindestleistung, PV-Überschuss) — sofort neu rechnen.
    if (consumptionW !== prevConsumptionW) ctx.p14a?.update?.();
    prevConsumptionW = consumptionW;

    // Einspeisung (LPP)
    const productionW = Number.isFinite(lpp.limitW) ? lpp.limitW : null;
    // Sperren nur, wenn die Grenze unter der Anlagenleistung liegt — ein
    // Failsafe in Höhe der Nennleistung schränkt nichts ein.
    const blockNeeded = productionW != null && productionW < (cfgNow().grid.productionNominalMaxW || defaultProductionNominal());
    if (productionW !== ui.applied.productionLimitW) {
      ui.applied.productionLimitW = productionW;
      pushLog(productionW == null ? 'eebus_production_released' : 'eebus_production_limited', { limitW: productionW, state: lpp.state });
      const limiter = getCfg()?.controlWrite?.dvFeedInLimitW?.enabled === true && ctx.feedInLimit;
      if (limiter) {
        ui.applied.productionBlock = false;
        state.ctrl.eebusProductionBlock = false;
        Promise.resolve(ctx.feedInLimit.set('eebus_lpp', productionW)).catch((e) => {
          pushLog('eebus_production_limit_error', { error: e?.message || String(e) });
          // Begrenzer nicht schreibbar: Grenze nur durch Sperren einhaltbar.
          if (blockNeeded && ui.applied.productionLimitW === productionW) {
            ui.applied.productionBlock = true;
            state.ctrl.eebusProductionBlock = true;
          }
        });
      } else {
        ui.applied.productionBlock = blockNeeded;
        state.ctrl.eebusProductionBlock = blockNeeded;
      }
    }
  }

  function applyDeviceLimits(shares, list, lpc) {
    const t = now();
    const active = new Set();
    for (const cns of list) {
      if (!cns.entity) continue;
      active.add(cns.entity);
      const w = shares[cns.id];
      const cached = deviceLimitCache.get(cns.entity);
      if (cached && cached.w === w && t - cached.at < DEVICE_LIMIT_REFRESH_MS) continue;
      deviceLimitCache.set(cns.entity, { w, at: t });
      const durationS = lpc.until ? Math.max(60, Math.round((lpc.until - t) / 1000)) : 0;
      send({ cmd: 'device_limit', uc: 'lpc', entity: cns.entity, w, duration_s: durationS, active: true })
        .then((r) => { if (!r?.ok) deviceLimitCache.delete(cns.entity); });
    }
    // Geräte, die keine Grenze mehr bekommen: aufheben.
    for (const [entity] of deviceLimitCache) {
      if (active.has(entity)) continue;
      deviceLimitCache.delete(entity);
      send({ cmd: 'device_limit', uc: 'lpc', entity, w: 0, duration_s: 0, active: false });
    }
  }

  function tick() {
    const before = `${machines.lpc.effective().state}/${machines.lpp.effective().state}`;
    apply();
    const after = `${machines.lpc.effective().state}/${machines.lpp.effective().state}`;
    if (before !== after) saveGridState();
    if (ui.pairing.on && ui.pairing.until && now() > ui.pairing.until) setPairing(false);
    const c = cfgNow();
    const key = configKey(c);
    if (key !== lastConfigKey) reload();
  }

  function integrateEnergy() {
    const daily = state.energy || {};
    const imp = Number(daily.importWh);
    const exp = Number(daily.exportWh);
    if (Number.isFinite(imp)) {
      const last = energy.lastDailyImportWh;
      const delta = last == null ? 0 : imp >= last ? imp - last : imp;
      energy.importWh += delta;
      energy.lastDailyImportWh = imp;
    }
    if (Number.isFinite(exp)) {
      const last = energy.lastDailyExportWh;
      const delta = last == null ? 0 : exp >= last ? exp - last : exp;
      energy.exportWh += delta;
      energy.lastDailyExportWh = exp;
    }
    if (now() - lastEnergySave > 60_000) {
      lastEnergySave = now();
      saveJson('energy.json', energy);
    }
  }

  function pushGcp() {
    if (ui.status !== 'running') return;
    integrateEnergy();
    const powerW = gridImportPositiveW(state, getCfg());
    if (powerW == null) return;
    const cmd = {
      cmd: 'gcp',
      power_w: Math.round(powerW),
      energy_consumed_wh: Math.round(energy.importWh),
      energy_feed_in_wh: Math.round(energy.exportWh),
    };
    if (!child?.stdin?.writable) return;
    try { child.stdin.write(`${JSON.stringify(cmd)}\n`); } catch { /* nächster Takt */ }
  }

  // --- Bedienung (API) ----------------------------------------------------------

  function configKey(c) {
    return JSON.stringify([c.enabled, c.port, c.binaryPath, c.trusted.map((t) => t.ski).sort(),
      c.trusted.find((t) => t.role === 'grid')?.ski || null]);
  }

  async function reload() {
    const c = cfgNow();
    const key = configKey(c);
    if (key === lastConfigKey) return;
    const prev = lastConfigKey ? JSON.parse(lastConfigKey) : null;
    lastConfigKey = key;
    const restartNeeded = !prev || prev[0] !== c.enabled || prev[1] !== c.port || prev[2] !== c.binaryPath;
    if (restartNeeded) {
      await stop();
      await start();
      return;
    }
    // Nur die Vertrauensliste hat sich geändert: ohne Neustart nachziehen.
    const prevSkis = new Set(prev[3]);
    const nextSkis = new Set(c.trusted.map((t) => t.ski));
    for (const ski of nextSkis) if (!prevSkis.has(ski)) await send({ cmd: 'trust', ski });
    for (const ski of prevSkis) if (!nextSkis.has(ski)) await send({ cmd: 'untrust', ski });
    const enabled = hasGridPeer();
    const prevGrid = (prev[4] || null);
    const nextGrid = c.trusted.find((t) => t.role === 'grid')?.ski || null;
    if (prevGrid !== nextGrid) {
      // Andere oder keine Steuerbox: Failsafe-Werte und Grenzen gehörten der
      // alten Box — frisch aus der Konfiguration starten, die neue Box schreibt
      // ihre eigenen. Auch kein gespeicherter Failsafe darf weiterwirken.
      machines = { lpc: makeMachine('lpc', c), lpp: makeMachine('lpp', c) };
      const lpc = machines.lpc.snapshot();
      const lpp = machines.lpp.snapshot();
      send({ cmd: 'grid_config', uc: 'lpc', failsafe_w: lpc.failsafeW, failsafe_duration_s: lpc.failsafeDurationS });
      send({ cmd: 'grid_config', uc: 'lpp', failsafe_w: lpp.failsafeW, failsafe_duration_s: lpp.failsafeDurationS });
    }
    machines.lpc.setEnabled(enabled);
    machines.lpp.setEnabled(enabled);
    saveGridState();
    apply();
  }

  async function setPairing(on) {
    ui.pairing = { on: on === true, until: on === true ? now() + PAIRING_WINDOW_MS : null };
    if (pairingTimer) { clearTimer(pairingTimer); pairingTimer = null; }
    return send({ cmd: 'pairing', on: on === true });
  }

  async function stop() {
    stopping = true;
    if (restartTimer) { clearTimer(restartTimer); restartTimer = null; }
    if (tickTimer) { clearIntervalFn(tickTimer); tickTimer = null; }
    if (gcpTimer) { clearIntervalFn(gcpTimer); gcpTimer = null; }
    saveGridState();
    saveJson('energy.json', energy);
    // Grenzen nicht stehen lassen, wenn EEBUS abgeschaltet wird.
    state.ctrl.eebusConsumptionLimitW = null;
    state.ctrl.eebusWallboxCapW = null;
    state.ctrl.eebusProductionBlock = false;
    if (ui.applied.productionLimitW != null && ctx.feedInLimit) {
      Promise.resolve(ctx.feedInLimit.set('eebus_lpp', null)).catch(() => {});
    }
    ui.applied = { consumptionLimitW: null, productionLimitW: null, productionBlock: false };
    const proc = child;
    if (!proc) return;
    await new Promise((resolve) => {
      const t = setTimer(() => { try { proc.kill('SIGKILL'); } catch { /* weg */ } resolve(); }, 5_000);
      proc.once('exit', () => { clearTimer(t); resolve(); });
      try { proc.stdin.end(); } catch { /* weg */ }
      try { proc.kill('SIGTERM'); } catch { /* weg */ }
    });
  }

  function status() {
    const c = cfgNow();
    const trusted = c.trusted.map((t) => ({
      ...t,
      connected: ui.peers[t.ski]?.connected === true,
      shipId: ui.peers[t.ski]?.shipId || null,
      lastSeen: ui.peers[t.ski]?.lastSeen || null,
      device: t.role === 'device' ? ui.devices[t.ski] || null : undefined,
    }));
    const waiting = Object.entries(ui.peers)
      .filter(([ski, p]) => p.waitingTrust && !c.trusted.some((t) => t.ski === ski))
      .map(([ski, p]) => ({ ski, shipId: p.shipId }));
    return {
      enabled: c.enabled,
      status: ui.status,
      error: ui.error,
      ski: ui.ski,
      shipId: ui.shipId,
      port: ui.port,
      qr: ui.qr,
      pairing: ui.pairing,
      discovered: ui.discovered.filter((d) => !c.trusted.some((t) => t.ski === d.ski)),
      waiting,
      trusted,
      grid: { lpc: ui.grid.lpc, lpp: ui.grid.lpp, hasGridPeer: hasGridPeer() },
      applied: ui.applied,
      energy: { importWh: Math.round(energy.importWh), exportWh: Math.round(energy.exportWh) },
      restarts: ui.restarts,
      stderr: ui.stderr.slice(-10),
    };
  }

  // Kurzfassung für den Leitstand (/api/status, alle paar Sekunden abgefragt).
  function summary() {
    const c = cfgNow();
    if (!c.enabled) return { enabled: false };
    const gridPeer = c.trusted.find((t) => t.role === 'grid') || null;
    const lp = (snap) => (snap ? { state: snap.state, limitW: snap.limitW, until: snap.until } : null);
    const devices = c.trusted.filter((t) => t.role === 'device');
    return {
      enabled: true,
      status: ui.status,
      error: ui.error,
      grid: gridPeer
        ? { name: gridPeer.name || null, connected: ui.peers[gridPeer.ski]?.connected === true }
        : null,
      lpc: lp(ui.grid.lpc),
      lpp: lp(ui.grid.lpp),
      applied: { ...ui.applied },
      devices: { total: devices.length, connected: devices.filter((t) => ui.peers[t.ski]?.connected === true).length },
    };
  }

  async function setDeviceLimit(ski, w, durationS = 0) {
    const d = ui.devices[ski];
    if (!d?.entities?.lpc) return { ok: false, error: 'device has no LPC entity' };
    const active = Number.isFinite(Number(w)) && Number(w) >= 0;
    return send({ cmd: 'device_limit', uc: 'lpc', entity: d.entities.lpc, w: active ? Number(w) : 0, duration_s: Number(durationS) || 0, active });
  }

  return {
    start,
    stop,
    reload,
    status,
    summary,
    consumptionDevices,
    applyConsumptionShares,
    setPairing,
    setDeviceLimit,
    certPaths,
    // für Tests
    _handleEvent: handleEvent,
    _apply: apply,
    _machines: () => machines,
  };
}
