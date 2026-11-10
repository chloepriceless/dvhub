// services/eebus/index.js — EEBUS in DVhub (§14a-Steuerbox und EEBUS-Geräte).
//
// Das Protokoll spricht der Hilfsprozess dvhub-eebus (Go auf enbility eebus-go,
// dvhub/eebus/go/, im Container und nativ; Rückweg C auf openeebus von NIBE,
// dvhub/eebus/bridge/ — gleiches Protokoll). Dieser Dienst startet und überwacht ihn, hält Kopplungen und
// Geräte, führt die Zustandsmaschinen der Netzseite (limit-state.js) und setzt
// die Grenzen in DVhubs bestehende Steuerpfade um:
//
//   Bezugsgrenze (LPC, §14a)  → Akku lädt nicht aus dem Netz (schedule-eval),
//                               Wallbox und EEBUS-Geräte (Wärmepumpe …) teilen
//                               sich die Grenze (services/paragraph14a: nach Bedarf, Vorrang oder anteilig)
//   Einspeisegrenze (LPP)     → Einspeisebegrenzer (feed-in-limit-arbiter,
//                               Victron 2706); ohne Begrenzer Einspeisesperre
//   Netzanschlusspunkt (MGCP) → Leistung und Zählerstände an die Steuerbox
//   Verdichter (OHPCF)        → angekündigte Läufe in den günstigsten Zeitraum
//   E-Auto an der Wallbox     → Stand je Gerät (ui.devices[ski].ev), Ladestrom
//                               über setEvCurrentLimits (nur Go-Fassung)
//
// Protokoll mit dem Hilfsprozess: siehe dvhub/eebus/go/PROTOKOLL.md.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';

import { createLimitStateMachine } from './limit-state.js';
import { readApplianceId } from '../support-tunnel.js';
import { isReadOnlyMode, noteBlockedWrite } from '../../read-only-guard.js';
import { meterImport } from '../import-limit/core.js';

export const EEBUS_DEFAULT_PORT = 4712;
const RESTART_DELAYS_MS = [5_000, 10_000, 30_000, 60_000];
const REQUEST_TIMEOUT_MS = 10_000;
const PAIRING_WINDOW_MS = 10 * 60_000;
const GCP_INTERVAL_MS = 5_000;
const DEVICE_LIMIT_REFRESH_MS = 5 * 60_000;
const STDERR_KEEP = 40;
// Anlaufstufe einer EEBUS-Wallbox ohne Angabe des Autos: 6 A auf drei Phasen.
const EV_START_W = 6 * 3 * 230;
// §14a-Gerätesteuerung überwachen (pv magazine 09.11.2026): Störungen erst nach
// dieser Zeit melden (kurze Aussetzer, Gerät braucht Zeit zum Umsetzen) …
const ISSUE_GRACE_MS = 60_000;
// … und eine abweichende Rückmeldung des Geräts frühestens so oft neu schreiben.
const RESEND_MS = 60_000;
// Vom Hilfsprozess abgelehnte Vorgabe (z. B. „write failed“ direkt nach der
// Anmeldung, solange die Grenzbeschreibung des Geräts noch nicht gelesen ist):
// nach dieser Zeit erneut schreiben.
const RETRY_MS = 10_000;
const OVER_LIMIT_TOL_MIN_W = 300;
const OVER_LIMIT_TOL_SHARE = 0.1;
// Leistung eines EEBUS-Geräts (MPC) gilt höchstens so lange und nur in der
// laufenden Verbindung (Fable R2 P2-5). Geräte melden bei jeder Änderung; ein
// älterer Wert ist unbekannt — dann rechnet § 14a strenger (kein Überschuss
// aus dieser Leistung, Bedarf = Nennleistung).
const DEVICE_POWER_MAX_AGE_MS = 5 * 60_000;
// Netzanschlusspunkt (MGCP) an die Steuerbox nur mit gültigem, frischem Zählerwert.
const GCP_METER_MAX_AGE_MS = 30_000;
// Automatische Failsafe-Vorgabe höchstens so oft neu an den Hilfsprozess.
const FAILSAFE_SYNC_MS = 30_000;
const ISSUE_TEXT = {
  unreachable: 'nicht erreichbar — die §14a-Steuerung wirkt nicht, das Gerät fällt auf seinen eigenen Failsafe-Wert zurück',
  not_applied: 'setzt die Vorgabe nicht um (meldet eine andere Grenze)',
  over_limit: 'zieht mehr als die Vorgabe',
  rejected: 'hat die Vorgabe abgelehnt',
};
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

/**
 * Leistung am Netzanschlusspunkt für MGCP: Bezug positiv, Einspeisung negativ.
 * Nur ein gültiger, frischer Zählerwert (meter.ok, höchstens maxAgeMs alt) —
 * sonst null: beim Start steht grid_total_w auf 0, nach einem Lesefehler auf
 * dem alten Wert (Fable R2 P1-1).
 */
export function gridImportPositiveW(state, cfg, { now = Date.now(), maxAgeMs = GCP_METER_MAX_AGE_MS } = {}) {
  const m = meterImport(state, { gridPositiveMeans: cfg?.gridPositiveMeans === 'grid_import' ? 'grid_import' : 'feed_in' }, { now, maxAgeMs });
  return m.fresh ? m.importW : null;
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
    notHalt: { active: false, since: null, released: 0, heartbeat: null },
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
  // Vorgabe der Wallbox-Steuerung je Gerät (EEBUS-Wallbox, services/wallbox/
  // eebus-wallbox.js): ski → W. Gilt zusammen mit dem §14a-Anteil — der kleinere.
  const emsLimits = new Map();
  let lastShares = {};
  let lastSharesUntil = null;
  let lastSharesUntilById = null;
  let lastConfigKey = null;
  let prevConsumptionW = null;
  // §14a-Gerätesteuerung: Geräte mit LPC, die DVhub kennt (ski → { entity,
  // lostAt, last: {name, kind, maxW} }), letzte Vorgabe je Entität, Zuordnung
  // Befehls-id → Entität (für write_result), offene Störungen.
  const lpcKnown = new Map();
  const deviceWrites = new Map(); // entity → { w, active, durationS, at, rejected, resentAt }
  const writeIds = new Map();     // id → entity
  const issues = new Map();       // `${ski}:${code}` → { ski, code, since, logged }
  const overSince = new Map();    // entity → Zeitpunkt, seit dem das Gerät über der Vorgabe liegt
  // Geräte, denen DVhub je eine Vorgabe geschrieben hat (auch ohne Steuerbox,
  // z. B. Netzanschluss-Deckel oder von Hand): ab dann läuft DVhubs Herzschlag
  // zum Gerät. Gespeichert, damit ein Neustart von DVhub oder dem Hilfsprozess
  // und das Ende eines Not-Halts das Gerät wieder aufnehmen (Fable R2 P2-3).
  const ledDevices = new Set(Array.isArray(loadJson('controlled.json')?.skis) ? loadJson('controlled.json').skis : []);
  const energy = loadJson('energy.json') || { importWh: 0, exportWh: 0, lastDailyImportWh: null, lastDailyExportWh: null };
  let lastEnergySave = 0;

  const cfgNow = () => resolveEebusConfig(getCfg());
  // Not-Halt („als ob die Kiste aus ist“, Christin 10.11.2026): keine Vorgaben
  // an Geräte, kein Herzschlag, kein Wiederanlauf-„frei“, keine Verdichter-
  // Planung. Nur während der einen Neutralisierung beim Eintritt
  // (control-commands.js setEmergencyStop: Wallbox-Stopp, Freigabe der eigenen
  // Grenzen) öffnet sich das Fenster _notHaltNeutralizing. Lesen, Status, Netzseite
  // (Steuerbox) und Messwerte an die Steuerbox (MGCP) laufen weiter.
  const notHalt = () => state.ctrl?.discretionaryWritesPaused === true;
  const notHaltBlocks = () => notHalt() && state.ctrl?._notHaltNeutralizing !== true;
  const notHaltLogged = new Set();
  function noteNotHaltBlock(what, data = {}) {
    if (notHaltLogged.has(what)) return;
    notHaltLogged.add(what);
    pushLog('eebus_write_blocked_nothalt', { what, ...data }, 'warn');
  }
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

  // Befehle, die ein Gerät steuern (Not-Halt-Tor als letzte Sperre).
  const DEVICE_CONTROL_CMDS = new Set(['device_limit', 'device_failsafe', 'ohpcf', 'ev_current_limits']);

  function send(cmd, onId = null) {
    // Lese-Modus: eine beobachtende Instanz steuert kein Gerät — letzte Sperre
    // für alle Gerätebefehle (der Knoten startet im Lese-Modus ohnehin nicht).
    if (DEVICE_CONTROL_CMDS.has(cmd?.cmd) && isReadOnlyMode()) {
      noteBlockedWrite(`eebus ${cmd.cmd}`);
      return Promise.resolve({ ok: false, error: 'read_only' });
    }
    if (DEVICE_CONTROL_CMDS.has(cmd?.cmd) && notHaltBlocks()) {
      noteNotHaltBlock(cmd.cmd);
      return Promise.resolve({ ok: false, blocked: true, error: 'emergency_stop_active' });
    }
    if (!child || !child.stdin?.writable) return Promise.resolve({ ok: false, error: 'eebus not running' });
    const id = ++reqId;
    if (onId) onId(id);
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
    // Lese-Modus (DVHUB_READ_ONLY=1): der EEBUS-Knoten startet nicht (Fable R2
    // P2-2). Gegenüber Steuerbox und Geräten ist schon die Teilnahme ein
    // Schreiben: DVhub gäbe Vorgaben der Steuerbox frei und quittierte sie,
    // schickte Herzschlag und Messwerte (MGCP) und plante Verdichterläufe —
    // die Steuerbox hielte eine Vorgabe für umgesetzt, die die Lese-Instanz nie
    // umsetzt. Mit kopiertem Datenverzeichnis (der Anlass des Lese-Modus) hätte
    // sie zudem dieselbe SKI wie die echte Instanz.
    if (isReadOnlyMode()) {
      ui.status = 'read_only';
      ui.error = 'Lese-Modus (DVHUB_READ_ONLY=1): EEBUS ist aus — keine Verbindung zu Steuerbox und Geräten';
      pushLog('eebus_read_only', {}, 'warn');
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
    // Eine noch gültige, gespeicherte Grenze gilt sofort (limit-state init),
    // nicht erst mit dem ersten Takt (Fable R2 P2-4).
    apply();
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
      // Der neue Hilfsprozess kennt keine Vorgaben und keinen Herzschlag: alles
      // neu schreiben, sobald die Geräte sich wieder anmelden.
      deviceLimitCache.clear();
      for (const k of lpcKnown.values()) if (k.lostAt == null) k.lostAt = now();
      for (const d of Object.values(ui.devices)) forgetConnectionValues(d);
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
    ui.devices[ski] ||= { entities: {}, powerW: null, powerAt: null, nominalW: null, limit: null, failsafe: null, ohpcf: null, measurements: {}, ev: null };
    return ui.devices[ski];
  }

  // Verbindung weg: Messwert und Grenz-Rückmeldung gehören zur alten Verbindung
  // (Fable R2 P2-5, P3-4) — nach dem Wiederanmelden meldet das Gerät neu.
  function forgetConnectionValues(d) {
    d.powerW = null;
    d.powerAt = null;
    d.lpcLimit = null;
  }

  // Leistung nur, wenn in dieser Verbindung gemeldet und nicht zu alt.
  function freshPowerW(d) {
    if (d?.powerW == null || !Number.isFinite(Number(d.powerW))) return null;
    if (d.powerAt == null || now() - d.powerAt > DEVICE_POWER_MAX_AGE_MS) return null;
    return Number(d.powerW);
  }

  function markLed(ski) {
    if (!ski || ledDevices.has(ski)) return;
    ledDevices.add(ski);
    saveJson('controlled.json', { skis: [...ledDevices] });
  }

  // E-Auto an einer EEBUS-Wallbox (EVCC/EVCEM/EVSOC/OPEV/OSCEV/CEVC, nur
  // dvhub-eebus in Go): je Gerät der letzte Stand, solange das Auto steckt.
  function emptyEv(entity) {
    return {
      connected: false, entity: entity || null, chargeState: null, soc: null, phases: null,
      phasesA: null, powerPerPhaseW: null, powerW: null, energyWh: null,
      vehicle: null, limits: {}, plan: null, at: now(),
    };
  }

  function evOf(ev) {
    if (!ev.ski || roleOf(ev.ski) !== 'device') return null;
    const d = device(ev.ski);
    if (!d.ev || (ev.entity && d.ev.entity && d.ev.entity !== ev.entity && !d.ev.connected)) d.ev = emptyEv(ev.entity);
    if (ev.entity) d.ev.entity = ev.entity;
    d.ev.at = now();
    return d.ev;
  }

  const numOrNull = (v) => (Number.isFinite(Number(v)) && v !== null ? Number(v) : null);
  const numList = (v) => (Array.isArray(v) ? v.map((x) => numOrNull(x)) : null);

  function onEvEvent(ev) {
    const e = evOf(ev);
    if (!e) return;
    switch (ev.ev) {
      case 'ev_connected':
        Object.assign(e, emptyEv(ev.entity), { connected: true, unplugged: false });
        pushLog('eebus_ev_connected', { ski: ev.ski, entity: ev.entity || null });
        break;
      case 'ev_disconnected':
        Object.assign(e, emptyEv(ev.entity || e.entity), { unplugged: true });
        pushLog('eebus_ev_disconnected', { ski: ev.ski, entity: ev.entity || null });
        break;
      case 'ev_data':
        e.connected = true;
        e.unplugged = false;
        if (ev.charge_state != null) e.chargeState = ev.charge_state;
        e.vehicle = {
          ...(e.vehicle || {}),
          ...(ev.comm_standard != null ? { commStandard: ev.comm_standard } : {}),
          ...(ev.asymmetric != null ? { asymmetric: ev.asymmetric === true } : {}),
          ...(Array.isArray(ev.ids) ? { ids: ev.ids } : {}),
          ...(ev.manufacturer ? { manufacturer: ev.manufacturer } : {}),
          ...(ev.power_min_w != null ? { powerMinW: numOrNull(ev.power_min_w) } : {}),
          ...(ev.power_max_w != null ? { powerMaxW: numOrNull(ev.power_max_w) } : {}),
          ...(ev.power_standby_w != null ? { powerStandbyW: numOrNull(ev.power_standby_w) } : {}),
          ...(ev.sleep != null ? { sleep: ev.sleep === true } : {}),
        };
        break;
      case 'ev_measurement':
        e.connected = true;
        e.unplugged = false;
        if (ev.phases != null) e.phases = numOrNull(ev.phases);
        if (ev.current_a) e.phasesA = numList(ev.current_a);
        if (ev.power_w) e.powerPerPhaseW = numList(ev.power_w);
        if (ev.power_total_w != null) e.powerW = numOrNull(ev.power_total_w);
        if (ev.energy_wh != null) e.energyWh = numOrNull(ev.energy_wh);
        break;
      case 'ev_soc':
        e.connected = true;
        e.soc = numOrNull(ev.soc);
        break;
      case 'ev_limits':
        if (ev.uc !== 'opev' && ev.uc !== 'oscev') break;
        e.limits = {
          ...e.limits,
          [ev.uc]: {
            minA: numList(ev.min_a), maxA: numList(ev.max_a), defaultA: numList(ev.default_a),
            limits: (Array.isArray(ev.limits) ? ev.limits : []).map((l) => ({
              phase: l.phase, active: l.active === true, valueA: numOrNull(l.value_a), changeable: l.changeable === true,
            })),
          },
        };
        break;
      case 'ev_charge_plan':
        e.plan = {
          strategy: ev.strategy || null,
          demand: ev.demand ? {
            minWh: numOrNull(ev.demand.min_wh), optWh: numOrNull(ev.demand.opt_wh), maxWh: numOrNull(ev.demand.max_wh),
            startInS: numOrNull(ev.demand.start_in_s), endInS: numOrNull(ev.demand.end_in_s),
          } : null,
          slots: (Array.isArray(ev.plan) ? ev.plan : []).map((p) => ({
            startMs: numOrNull(p.start_ms), endMs: numOrNull(p.end_ms), w: numOrNull(p.w), minW: numOrNull(p.min_w), maxW: numOrNull(p.max_w),
          })),
        };
        break;
      default:
        break;
    }
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
      case 'write_result': {
        const entity = writeIds.get(ev.id);
        writeIds.delete(ev.id);
        const w = entity ? deviceWrites.get(entity) : null;
        if (w && w.id === ev.id) w.rejected = !ev.ok;
        if (!ev.ok) {
          pushLog('eebus_device_write_rejected', { id: ev.id, entity: entity || null, ski: entity ? skiOfEntity(entity) : null }, 'warn');
        }
        break;
      }
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
        const known = lpcKnown.get(ev.ski);
        if (known && known.lostAt == null) known.lostAt = now();
        if (ui.devices[ev.ski]) forgetConnectionValues(ui.devices[ev.ski]);
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
        if (ev.uc === 'lpc') {
          if (ev.ev === 'device_added') {
            const known = lpcKnown.get(ev.ski) || {};
            lpcKnown.set(ev.ski, { ...known, entity: ev.entity, lostAt: null });
          } else if (lpcKnown.has(ev.ski) && lpcKnown.get(ev.ski).lostAt == null) {
            lpcKnown.get(ev.ski).lostAt = now();
          }
        }
        apply();
        if (ev.ev === 'device_added' && ev.uc === 'lpc') resumeDevice(ev.ski);
        break;
      }
      case 'device_nominal_max':
        if (ev.ski && roleOf(ev.ski) === 'device' && ev.uc === 'lpc') device(ev.ski).nominalW = Number(ev.w) || null;
        break;
      case 'device_limit':
        if (ev.ski && roleOf(ev.ski) === 'device') {
          const d = device(ev.ski);
          d.limit = { uc: ev.uc, w: ev.w, active: ev.active, at: now() };
          // Für die Prüfung der §14a-Vorgabe nur die Rückmeldung zur Verbrauchsgrenze.
          if (ev.uc === 'lpc') d.lpcLimit = d.limit;
        }
        break;
      case 'device_failsafe_limit':
      case 'device_failsafe_duration':
        // Failsafe-Werte des Geräts (gilt, wenn DVhub es nicht mehr erreicht).
        if (ev.ski && roleOf(ev.ski) === 'device' && ev.uc === 'lpc') {
          const d = device(ev.ski);
          d.failsafe = { ...(d.failsafe || {}), ...(ev.ev === 'device_failsafe_limit' ? { w: Number(ev.w) } : { durationS: Number(ev.duration_s) }), at: now() };
        }
        break;
      case 'device_measurement':
        if (ev.ski && roleOf(ev.ski) === 'device') {
          const d = device(ev.ski);
          d.measurements[ev.name] = ev.value;
          if (ev.name === 'power_w') { d.powerW = ev.value; d.powerAt = now(); }
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

      // E-Auto an der Wallbox
      case 'ev_connected':
      case 'ev_disconnected':
      case 'ev_data':
      case 'ev_measurement':
      case 'ev_soc':
      case 'ev_limits':
      case 'ev_charge_plan':
        onEvEvent(ev);
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
    // Not-Halt: DVhub plant keinen Lauf — die Wärmepumpe startet nach ihrer
    // eigenen Vorgabe, wie ohne DVhub.
    if (notHalt()) { noteNotHaltBlock('ohpcf', { ski: ev.ski }); d.ohpcf.notHalt = true; return; }
    if (isReadOnlyMode()) { noteBlockedWrite(`eebus ohpcf ${ev.ski}`); d.ohpcf.readOnly = true; return; }
    const startInS = mode === 'immediate' ? Number(ev.earliest_start_s) || 0 : planOhpcfStart(ev, state.epex?.data, now());
    const res = await send({ cmd: 'ohpcf', action: 'schedule', entity: ev.entity, start_in_s: startInS });
    d.ohpcf = { ...d.ohpcf, plannedStartInS: startInS, plannedAt: now(), scheduleOk: res?.ok === true };
    pushLog('eebus_ohpcf_scheduled', { ski: ev.ski, startInS, mode, ok: res?.ok === true });
  }

  // --- Umsetzung ----------------------------------------------------------------

  /**
   * Verbundene EEBUS-Geräte mit LPC — für die §14a-Aufteilung
   * (services/paragraph14a). Art: mit Verdichter-Ankündigung (OHPCF) eine
   * Wärmepumpe; meldet die Box ein Auto (EVCC/EVCEM …) oder ist sie als
   * Hauptwallbox eingetragen, ein Ladepunkt; sonst wie bisher Wärmepumpe.
   * Ladepunkt: Anlaufstufe (startW) aus der Mindestleistung des Autos, sonst
   * 6 A auf drei Phasen; ohne gestecktes Auto kein Bedarf (available: false).
   */
  function consumptionDevices() {
    const c = cfgNow();
    if (!c.devices.forwardGridLimit) return [];
    const wb = getCfg()?.wallbox;
    const mainWallboxSki = wb?.type === 'eebus' ? String(wb.eebus?.ski || '').trim().toLowerCase() : '';
    const list = [];
    for (const [ski, d] of Object.entries(ui.devices)) {
      if (!d.entities.lpc || !ui.peers[ski]?.connected) continue;
      const trusted = c.trusted.find((t) => t.ski === ski);
      const kind = d.entities.ohpcf ? 'waermepumpe' : (d.ev || ski === mainWallboxSki) ? 'ladepunkt' : 'waermepumpe';
      const minW = Number(d.ev?.vehicle?.powerMinW);
      const known = lpcKnown.get(ski);
      if (known) known.last = { name: trusted?.name || null, kind, maxW: d.nominalW || c.devices.defaultNominalW };
      list.push({
        id: `eebus:${ski}`,
        ski,
        entity: d.entities.lpc,
        name: trusted?.name || null,
        kind,
        maxW: d.nominalW || c.devices.defaultNominalW,
        powerW: freshPowerW(d),
        ...(kind === 'ladepunkt' ? {
          startW: minW > 0 ? minW : EV_START_W,
          // Nur ein gemeldetes Abstecken heißt „kein Bedarf“ — ein unbekannter
          // Zustand (z. B. nur ev_limits) nicht, und Leistung fließt sichtbar.
          available: !(d.ev?.unplugged === true && !(Number(freshPowerW(d)) > 100)),
        } : {}),
      });
    }
    return list;
  }

  // DVhub steuert Geräte nach § 14a: Steuerbox gekoppelt oder Relais ausgewertet.
  function p14aControlled() {
    return hasGridPeer() || getCfg()?.paragraph14a?.relay?.enabled === true;
  }

  function skiOfEntity(entity) {
    for (const [ski, k] of lpcKnown) if (k.entity === entity) return ski;
    return null;
  }

  function skiOfLpcEntity(entity) {
    for (const [ski, d] of Object.entries(ui.devices)) if (d?.entities?.lpc === entity) return ski;
    return null;
  }

  /**
   * Geräte mit LPC, die DVhub gesteuert hat und gerade nicht erreicht. Sie
   * ziehen bis zu ihrem eigenen Failsafe-Wert (ohne Angabe: Nennleistung) —
   * services/paragraph14a hält das im Budget frei und zählt sie für Pmin.
   */
  function lostConsumptionDevices() {
    const c = cfgNow();
    if (!c.devices.forwardGridLimit) return [];
    const list = [];
    for (const [ski, k] of lpcKnown) {
      if (k.lostAt == null || !c.trusted.some((t) => t.ski === ski && t.role === 'device')) continue;
      const d = ui.devices[ski];
      const maxW = d?.nominalW || k.last?.maxW || c.devices.defaultNominalW;
      const fs = Number(d?.failsafe?.w);
      list.push({
        id: `eebus:${ski}`, ski, name: k.last?.name || c.trusted.find((t) => t.ski === ski)?.name || null,
        kind: k.last?.kind || 'waermepumpe', maxW, failsafeW: Number.isFinite(fs) && fs >= 0 ? fs : null, since: k.lostAt,
      });
    }
    return list;
  }

  /** Vorgabe an ein Gerät schreiben und merken (für die Prüfung der Umsetzung). */
  // owner: wer die Vorgabe führt ('p14a' Aufteilung, 'ems' Wallbox-Steuerung,
  // 'manual' von Hand); expiresAt: Ende einer befristeten Vorgabe (dann endet
  // auch die Prüfung — Codex aa32838a).
  function writeDeviceLimit(entity, { w, durationS = 0, active, owner = 'p14a', expiresAt = null }) {
    // Lese-Modus: eine beobachtende Instanz steuert kein Gerät (Codex 01dec596).
    if (isReadOnlyMode()) {
      noteBlockedWrite(`eebus device_limit ${entity}`);
      return Promise.resolve({ ok: false, error: 'read_only' });
    }
    // Not-Halt: vor dem Merken — eine blockierte Vorgabe ist keine Vorgabe.
    if (notHaltBlocks()) {
      noteNotHaltBlock('device_limit', { entity });
      return Promise.resolve({ ok: false, blocked: true, error: 'emergency_stop_active' });
    }
    const rec = { w: active ? w : null, active, durationS, at: now(), sentAt: now(), rejected: false, resentAt: null, id: null, replyOk: null, owner, expiresAt, confirmed: false };
    deviceWrites.set(entity, rec);
    // Jede Vorgabe (auch „frei“) startet DVhubs Herzschlag zum Gerät.
    markLed(skiOfEntity(entity) || skiOfLpcEntity(entity));
    return send({ cmd: 'device_limit', uc: 'lpc', entity, w: active ? w : 0, duration_s: durationS, active }, (id) => {
      rec.id = id;
      writeIds.set(id, entity);
      if (writeIds.size > 500) writeIds.delete(writeIds.keys().next().value);
    }).then((r) => { rec.replyOk = r?.ok === true; return r; });
  }

  // Letzte Vorgabe erneut schreiben; die Frist der Prüfung läuft weiter.
  function rewrite(entity, want, t) {
    deviceLimitCache.delete(entity);
    const durationS = want.until ? Math.max(60, Math.round((want.until - t) / 1000)) : want.durationS;
    writeDeviceLimit(entity, { w: want.w, durationS, active: want.active, owner: want.owner, expiresAt: want.expiresAt ?? null });
    const rec = deviceWrites.get(entity);
    if (!rec) return null;
    rec.at = want.at;
    rec.resentAt = want.resentAt;
    rec.until = want.until;
    if (want.active) deviceLimitCache.set(entity, { w: want.w, until: want.until ?? null, at: t });
    return rec;
  }

  /**
   * Gerät (wieder) angemeldet: Kopplung aufnehmen. Eine aktive Grenze geht
   * sofort neu raus; ohne Grenze schreibt DVhub „frei“ — das startet DVhubs
   * Herzschlag zum Gerät und beendet einen Failsafe, in den das Gerät nach
   * einem Neustart von DVhub oder einem Stromausfall gefallen ist (EEBUS LPC:
   * eine neue Vorgabe beendet den Failsafe). Nur wenn DVhub das Gerät nach
   * § 14a steuert (Steuerbox oder Relais) oder die Wallbox-Steuerung es führt.
   */
  function resumeDevice(ski) {
    const entity = ui.devices[ski]?.entities?.lpc;
    if (!entity) return;
    // Geführt: § 14a (Steuerbox/Relais, mit Weitergabe an die Geräte), die
    // Wallbox-Steuerung oder DVhub hat dem Gerät je eine Vorgabe geschrieben
    // (Netzanschluss-Deckel, von Hand — dessen Herzschlag endete mit dem
    // Neustart, das Gerät hängt sonst bis zum Ende seines Failsafes, Fable R2 P2-3).
    const led = (p14aControlled() && cfgNow().devices.forwardGridLimit) || emsLimits.has(ski) || ledDevices.has(ski);
    deviceLimitCache.delete(entity);
    if (!led) return;
    // Not-Halt: kein „frei“ (es startete den Herzschlag) — nach dem Aufheben
    // holt resumeAfterEmergencyStop() das für alle verbundenen Geräte nach.
    if (notHalt()) { noteNotHaltBlock('resume', { ski }); return; }
    // Aufteilung mit dem wieder angemeldeten Gerät neu rechnen (es war
    // inzwischen evtl. aus den Anteilen gefallen) — sonst die letzten Anteile.
    if (typeof ctx.p14a?.update === 'function') ctx.p14a.update();
    else applyConsumptionShares(lastShares, lastSharesUntil, lastSharesUntilById);
    if (deviceLimitCache.has(entity)) return;
    // Eigene, noch gültige Vorgabe außerhalb der Aufteilung zuerst neu
    // schreiben — „frei“ höbe sonst einen Wallbox-Stopp (EMS) oder eine Grenze
    // von Hand auf (Codex 8877e4cb, P1).
    const t = now();
    const ems = emsLimits.has(ski) ? emsLimits.get(ski) : null;
    const rec = deviceWrites.get(entity);
    const manual = rec?.owner === 'manual' && rec.active === true && Number.isFinite(rec.w)
      && (rec.expiresAt == null || rec.expiresAt > t) ? rec : null;
    if (ems != null) {
      writeDeviceLimit(entity, { w: ems, durationS: 0, active: true, owner: 'ems' });
    } else if (manual) {
      // Restdauer genau (aufgerundet), nicht wieder mindestens 60 s — sonst
      // liefe die Grenze am Gerät über ihr Ende hinaus (Codex 4a31cadc).
      const durationS = manual.expiresAt != null ? Math.max(1, Math.ceil((manual.expiresAt - t) / 1000)) : 0;
      writeDeviceLimit(entity, { w: manual.w, durationS, active: true, owner: 'manual', expiresAt: manual.expiresAt });
    } else {
      writeDeviceLimit(entity, { w: 0, durationS: 0, active: false });
    }
    pushLog('paragraph14a_device_resumed', { ski, entity, ...(ems != null ? { emsW: ems } : manual ? { manualW: manual.w } : {}) });
  }

  function setIssue(ski, code, on, since = now(), detail = {}) {
    const key = `${ski}:${code}`;
    const cur = issues.get(key);
    if (!on) {
      if (cur) {
        issues.delete(key);
        if (cur.logged) pushLog('paragraph14a_device_issue_resolved', { ski, code, name: cur.name });
      }
      return;
    }
    const name = lpcKnown.get(ski)?.last?.name || cfgNow().trusted.find((t) => t.ski === ski)?.name || 'EEBUS-Gerät';
    const entry = cur || { ski, code, since, logged: false, name };
    Object.assign(entry, { detail, name });
    issues.set(key, entry);
    const grace = code === 'rejected' ? 0 : ISSUE_GRACE_MS;
    if (!entry.logged && now() - entry.since >= grace) {
      entry.logged = true;
      const text = `${name}: ${ISSUE_TEXT[code]}`;
      pushLog('paragraph14a_device_issue', { ski, code, name, since: new Date(entry.since).toISOString(), ...detail }, 'warn');
      Promise.resolve(ctx.notifyDirect?.({
        event: 'paragraph14a_device_issue', level: 'warning', title: 'DVhub: §14a-Steuerung gestört', body: text,
      })).catch(() => {});
    }
  }

  /**
   * Umsetzung der §14a-Vorgaben je Gerät prüfen (jeden Takt). Bewertet wird nur,
   * was das Gerät tatsächlich meldet (eigene Grenze, Messwert) — ohne
   * Rückmeldung keine Fehlermeldung. Abweichende Grenze → neu schreiben.
   */
  function checkDevices() {
    if (isReadOnlyMode()) return; // keine Schreibvorgänge, also nichts zu prüfen
    // Not-Halt: DVhub gibt nichts vor, also nichts zu prüfen oder neu zu schreiben.
    if (notHalt()) return;
    const t = now();
    const controlled = p14aControlled() && cfgNow().devices.forwardGridLimit;
    const seen = new Set();
    for (const [ski, k] of lpcKnown) {
      const trusted = cfgNow().trusted.some((x) => x.ski === ski && x.role === 'device');
      if (!trusted) {
        lpcKnown.delete(ski);
        if (ledDevices.delete(ski)) saveJson('controlled.json', { skis: [...ledDevices] });
        continue;
      }
      seen.add(ski);
      setIssue(ski, 'unreachable', controlled && k.lostAt != null, k.lostAt ?? t);
      const d = ui.devices[ski];
      // Überwacht wird nur, was DVhub selbst führt: §14a-Weitergabe an, eine
      // Vorgabe der Wallbox-Steuerung — oder deren Freigabe, bis das Gerät sie
      // umgesetzt hat (Codex aa32838a). Befristete Vorgaben nur bis zu ihrem Ende.
      const last = k.lostAt == null && k.entity ? deviceWrites.get(k.entity) : null;
      const expiry = last ? (last.expiresAt ?? last.until ?? null) : null;
      const supervised = cfgNow().devices.forwardGridLimit || emsLimits.has(ski)
        || (last?.owner === 'ems' && last.confirmed !== true);
      const want = supervised && last && !(expiry != null && t >= expiry) ? last : null;
      if (!want) {
        for (const code of ['not_applied', 'over_limit', 'rejected']) setIssue(ski, code, false);
        overSince.delete(k.entity);
        continue;
      }
      setIssue(ski, 'rejected', want.rejected === true, want.at);
      // Vom Hilfsprozess nicht angenommen: nach RETRY_MS erneut.
      if (want.replyOk === false && t - want.sentAt >= RETRY_MS) {
        rewrite(k.entity, want, t);
        pushLog('paragraph14a_device_limit_retry', { ski, w: want.w, active: want.active });
        continue;
      }
      // Rückmeldung des Geräts zur Verbrauchsgrenze: weicht sie nach der Frist ab?
      const rep = d?.lpcLimit;
      const repActive = rep?.active === true;
      const differs = rep != null && (repActive !== want.active
        || (want.active && Math.abs(Number(rep.w) - want.w) > Math.max(50, 0.02 * want.w)));
      if (rep != null && !differs) want.confirmed = true;
      const mismatch = differs && t - want.at >= ISSUE_GRACE_MS;
      setIssue(ski, 'not_applied', mismatch, want.at, mismatch ? { reportedW: repActive ? Number(rep.w) : null, wantW: want.w } : {});
      if (mismatch && (want.resentAt == null || t - want.resentAt >= RESEND_MS)) {
        rewrite(k.entity, { ...want, resentAt: t }, t);
        pushLog('paragraph14a_device_limit_resent', { ski, w: want.w, active: want.active, reportedW: repActive ? Number(rep.w) : null });
      }
      // Messwert über der Vorgabe?
      const p = Number(d?.powerW);
      const over = want.active && Number.isFinite(p) && d?.powerW != null
        && p > want.w + Math.max(OVER_LIMIT_TOL_MIN_W, OVER_LIMIT_TOL_SHARE * want.w);
      if (over && !overSince.has(k.entity)) overSince.set(k.entity, t);
      if (!over) overSince.delete(k.entity);
      setIssue(ski, 'over_limit', over, overSince.get(k.entity) ?? t, over ? { powerW: p, wantW: want.w } : {});
    }
    for (const [key, i] of issues) if (!seen.has(i.ski)) { issues.delete(key); if (i.logged) pushLog('paragraph14a_device_issue_resolved', { ski: i.ski, code: i.code, name: i.name }); }
  }

  /** Gemeldete Störungen der §14a-Gerätesteuerung (für Leitstand, §14a-Ansicht). */
  function controlIssues() {
    return [...issues.values()].filter((i) => i.logged).map((i) => ({
      ski: i.ski, code: i.code, name: i.name, since: i.since, text: `${i.name}: ${ISSUE_TEXT[i.code]}`, ...i.detail,
    }));
  }

  /**
   * Anteile der §14a-Grenze an die Geräte schreiben (id → W, null = frei).
   * @param {Record<string, number|null>} shares
   * @param {number|null} untilMs  Ende der Grenze (für die Dauer am Gerät)
   */
  function applyConsumptionShares(shares, untilMs, untilById = null) {
    lastShares = shares || {};
    lastSharesUntil = untilMs ?? null;
    lastSharesUntilById = untilById && typeof untilById === 'object' ? untilById : null;
    if (notHaltBlocks()) return;
    const list = consumptionDevices();
    const active = {};
    for (const d of list) {
      const share = shares?.[d.id] ?? null;
      const ems = emsLimits.has(d.ski) ? emsLimits.get(d.ski) : null;
      const w = share == null ? ems : (ems == null ? share : Math.min(share, ems));
      if (w != null) active[d.id] = w;
    }
    applyDeviceLimits(active, list.filter((d) => active[d.id] != null), { until: untilMs, untilById: lastSharesUntilById });
  }

  /** Geräteinfo für die EEBUS-Wallbox: verbunden, LPC vorhanden, Leistung, Name. */
  // OPEV nutzbar nur mit lesbaren Grenzen (max_a) und mindestens einer änderbaren
  // Phasengrenze — dvhub-eebus meldet ev_limits auch, wenn beide Leseversuche scheitern.
  // Stopp per OPEV nur, wenn der Standardwert 0 ist: eebus-go setzt Werte unter dem
  // Minimum auf den Standardwert (features/internal/electricalconnection.go:297).
  function opevInfo(o) {
    const maxList = (o?.maxA || []).filter(Number.isFinite);
    const usable = maxList.length > 0 && (o?.limits || []).some((l) => l.changeable);
    return {
      opev: usable,
      opevStop: usable && !(o?.defaultA || []).some((v) => Number.isFinite(v) && v > 0),
      maxA: maxList.length ? Math.max(...maxList) : null,
    };
  }

  function deviceInfo(ski) {
    const d = ui.devices[ski];
    const trusted = cfgNow().trusted.find((t) => t.ski === ski);
    if (!d && !trusted) return null;
    return {
      connected: ui.peers[ski]?.connected === true,
      hasLpc: Boolean(d?.entities?.lpc),
      powerW: d?.powerW ?? null,
      name: trusted?.name || null,
      // E-Auto (nur Go-Fassung): null, solange die Box nichts zum Auto gemeldet hat.
      ev: d?.ev ? {
        connected: d.ev.connected === true,
        soc: d.ev.soc ?? null,
        powerW: d.ev.powerW ?? null,
        phasesA: d.ev.phasesA ?? null,
        ...opevInfo(d.ev.limits?.opev),
      } : null,
    };
  }

  /**
   * Vorgabe der Wallbox-Steuerung setzen (W) oder aufheben (null). Steht das
   * Gerät in der §14a-Aufteilung, rechnet die Aufteilung neu (kleinerer Wert
   * gilt); sonst geht die Grenze direkt ans Gerät.
   */
  async function setEmsLimit(ski, w) {
    if (notHaltBlocks()) { noteNotHaltBlock('ems_limit', { ski }); return { ok: false, blocked: true, error: 'emergency_stop_active' }; }
    const d = ui.devices[ski];
    if (!d?.entities?.lpc) return { ok: false, error: 'EEBUS-Gerät ohne Verbrauchsgrenze (LPC) oder nicht verbunden' };
    if (w == null) emsLimits.delete(ski);
    else emsLimits.set(ski, Math.max(0, Math.round(Number(w))));
    if (consumptionDevices().some((x) => x.ski === ski)) {
      // Neu schreiben erzwingen; beim Aufheben bleibt der Eintrag, damit die
      // Aufteilung die Grenze am Gerät zurücknimmt.
      if (w != null) deviceLimitCache.delete(d.entities.lpc);
      applyConsumptionShares(lastShares, lastSharesUntil, lastSharesUntilById);
      return { ok: true };
    }
    if (w == null) return writeDeviceLimit(d.entities.lpc, { w: 0, durationS: 0, active: false, owner: 'ems' });
    return writeDeviceLimit(d.entities.lpc, { w: emsLimits.get(ski), durationS: 0, active: true, owner: 'ems' });
  }

  // --- Not-Halt ---------------------------------------------------------------

  /**
   * Not-Halt-Eintritt (control-commands.js setEmergencyStop, im Fenster
   * _notHaltNeutralizing): jede Grenze, die DVhub gerade selbst an einem
   * verbundenen Gerät aktiv vorgibt (§14a-Anteil, Netzanschluss, von Hand),
   * EINMAL freigeben. Die Vorgabe der Wallbox-Steuerung (owner/emsLimits) gehört
   * der Wallbox — deren Not-Halt-Stopp lief davor (eos-evcc-bridge) und bleibt.
   * Danach den Herzschlag zu den Geräten anhalten: wie bei ausgeschaltetem
   * DVhub gehen die Geräte nach ihrer Frist (Go 4 s, C 60 s; LPC: spätestens
   * 120 s) in ihren eigenen Failsafe (Failsafe-Grenze für mindestens die
   * Failsafe-Dauer, danach ohne Grenze). Kein Wiederholen bei Fehlschlag.
   */
  async function emergencyStop() {
    notHaltLogged.clear();
    ui.notHalt = { active: true, since: now(), released: 0, heartbeat: null };
    if (!child || ui.status !== 'running') {
      ui.notHalt.heartbeat = 'not_running';
      return { ok: true, skipped: 'not_running' };
    }
    const released = [];
    const errors = [];
    const writes = [];
    for (const [entity, rec] of deviceWrites) {
      if (!rec?.active) continue;
      const ski = skiOfEntity(entity);
      if (!ski || !ui.peers[ski]?.connected || lpcKnown.get(ski)?.lostAt != null) continue;
      if (rec.owner === 'ems') continue;
      const ems = emsLimits.has(ski) ? emsLimits.get(ski) : null;
      // Geführt von der Wallbox-Steuerung: ihr Wert bleibt (der kleinere aus
      // §14a-Anteil und Wallbox-Grenze wird zur reinen Wallbox-Grenze).
      if (ems != null && rec.w === ems) continue;
      const req = ems != null
        ? writeDeviceLimit(entity, { w: ems, durationS: 0, active: true, owner: 'ems' })
        : writeDeviceLimit(entity, { w: 0, durationS: 0, active: false });
      writes.push(req.then((r) => (r?.ok ? released.push(ski) : errors.push(`${ski}: ${r?.error || 'write failed'}`))));
    }
    await Promise.all(writes);
    // Beim Aufheben schreibt die Aufteilung alles neu.
    deviceLimitCache.clear();
    ui.notHalt.released = released.length;
    if (released.length) pushLog('eebus_emergency_stop_released', { devices: released });
    ui.notHalt.heartbeat = await stopDeviceHeartbeat();
    if (errors.length) return { ok: false, error: errors.join('; '), released: released.length };
    return { ok: true, released: released.length, heartbeat: ui.notHalt.heartbeat };
  }

  // Herzschlag der Geräteseite anhalten (dvhub-eebus device_heartbeat). Ein
  // Hilfsprozess ohne den Befehl (C-Bridge, ältere Go-Fassung) wird neu
  // gestartet: ein frischer Prozess schlägt erst mit der ersten Vorgabe.
  async function stopDeviceHeartbeat() {
    const r = await send({ cmd: 'device_heartbeat', on: false });
    if (r?.ok) { pushLog('eebus_device_heartbeat_stopped', {}, 'warn'); return 'stopped'; }
    if (r?.error === 'unknown command' && child) {
      pushLog('eebus_device_heartbeat_restart', { reason: 'device_heartbeat unsupported' }, 'warn');
      saveGridState();
      try { child.kill('SIGTERM'); } catch { /* weg */ }
      return 'restarted';
    }
    pushLog('eebus_device_heartbeat_stop_failed', { error: r?.error || 'unknown' }, 'error');
    // Sonst liefe der Herzschlag den ganzen Not-Halt weiter (Fable R2 P3-11):
    // Hilfsprozess neu starten — ein frischer Prozess schlägt erst mit der
    // ersten Vorgabe, und ein Prozess-Neustart ist kein Geräte-Write.
    if (child) {
      saveGridState();
      try { child.kill('SIGTERM'); } catch { /* weg */ }
      return 'restarted';
    }
    return 'failed';
  }

  /**
   * Not-Halt aufgehoben: sauber wieder anlaufen — Aufteilung neu rechnen und
   * schreiben, jedes verbundene Gerät wie beim Anmelden aufnehmen (aktive
   * Grenze oder „frei“; das startet den Herzschlag wieder und beendet einen
   * Failsafe, in den das Gerät während des Not-Halts gefallen ist).
   */
  function resumeAfterEmergencyStop() {
    notHaltLogged.clear();
    ui.notHalt = { active: false, since: null, released: 0, heartbeat: null };
    deviceLimitCache.clear();
    if (ui.status !== 'running') return { ok: true, skipped: 'not_running' };
    let n = 0;
    for (const [ski, k] of lpcKnown) {
      if (k.lostAt != null || !ui.peers[ski]?.connected) continue;
      resumeDevice(ski);
      n += 1;
    }
    if (n === 0) {
      if (typeof ctx.p14a?.update === 'function') ctx.p14a.update();
      else applyConsumptionShares(lastShares, lastSharesUntil, lastSharesUntilById);
    }
    pushLog('eebus_emergency_stop_resumed', { devices: n });
    return { ok: true, devices: n };
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
      // Ablauf je Gerät (Netzanschluss-Grenze ohne Ablauf), sonst der gemeinsame.
      const until = lpc.untilById && Object.prototype.hasOwnProperty.call(lpc.untilById, cns.id)
        ? (lpc.untilById[cns.id] ?? null) : (lpc.until ?? null);
      // Gleiche Leistung, aber andere Dauer (z. B. §14a endet, die Netzanschluss-
      // Grenze bleibt) → neu schicken, sonst liefe sie am Gerät ab.
      if (cached && cached.w === w && cached.until === until && t - cached.at < DEVICE_LIMIT_REFRESH_MS) continue;
      deviceLimitCache.set(cns.entity, { w, until, at: t });
      const durationS = until ? Math.max(60, Math.round((until - t) / 1000)) : 0;
      // Gleiche Vorgabe (nur aufgefrischt): Frist der Umsetzungsprüfung läuft weiter.
      const prev = deviceWrites.get(cns.entity);
      const same = prev && prev.active && prev.w === w;
      writeDeviceLimit(cns.entity, { w, durationS, active: true })
        .then((r) => { if (!r?.ok) deviceLimitCache.delete(cns.entity); });
      const rec = deviceWrites.get(cns.entity);
      if (rec && rec !== prev) {
        rec.until = until;
        if (same) { rec.at = prev.at; rec.resentAt = prev.resentAt; }
      }
    }
    // Geräte, die keine Grenze mehr bekommen: aufheben.
    for (const [entity] of deviceLimitCache) {
      if (active.has(entity)) continue;
      deviceLimitCache.delete(entity);
      writeDeviceLimit(entity, { w: 0, durationS: 0, active: false });
    }
  }

  // Automatische Failsafe-Vorgabe (Pmin,14a) der Geräteliste nachführen: beim
  // Start sind noch keine EEBUS-Geräte angemeldet (Fable R2 P3-5). Nur ohne
  // eigenen Wert in der Konfiguration und solange die Steuerbox keinen
  // geschrieben hat (setDefaultFailsafeW).
  let lastFailsafeSyncAt = 0;
  function syncAutoFailsafe() {
    if (ui.status !== 'running' || cfgNow().grid.failsafeConsumptionW) return;
    if (now() - lastFailsafeSyncAt < FAILSAFE_SYNC_MS) return;
    lastFailsafeSyncAt = now();
    if (!machines.lpc.setDefaultFailsafeW(autoFailsafeConsumptionW())) return;
    const lpc = machines.lpc.snapshot();
    send({ cmd: 'grid_config', uc: 'lpc', failsafe_w: lpc.failsafeW, failsafe_duration_s: lpc.failsafeDurationS });
    pushLog('eebus_failsafe_default_updated', { failsafeW: lpc.failsafeW });
  }

  function tick() {
    const before = `${machines.lpc.effective().state}/${machines.lpp.effective().state}`;
    apply();
    checkDevices();
    syncAutoFailsafe();
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
    const powerW = gridImportPositiveW(state, getCfg(), { now: now(), maxAgeMs: GCP_METER_MAX_AGE_MS });
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
      notHalt: notHalt() ? { ...ui.notHalt, active: true } : null,
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
      issues: controlIssues(),
      // Not-Halt: §14a an den Geräten ausgesetzt (Leitstand-Hinweis).
      notHalt: notHalt() ? { suspended: true, since: ui.notHalt?.since ?? null, heartbeat: ui.notHalt?.heartbeat ?? null } : null,
    };
  }

  async function setDeviceLimit(ski, w, durationS = 0) {
    const d = ui.devices[ski];
    if (!d?.entities?.lpc) return { ok: false, error: 'device has no LPC entity' };
    if (notHalt()) return { ok: false, blocked: true, error: 'emergency_stop_active' };
    const active = Number.isFinite(Number(w)) && Number(w) >= 0;
    // Über writeDeviceLimit: die Prüfung der Umsetzung kennt dann diese Vorgabe.
    const dur = Number(durationS) || 0;
    return writeDeviceLimit(d.entities.lpc, {
      w: active ? Number(w) : 0, durationS: dur, active, owner: 'manual', expiresAt: dur > 0 ? now() + dur * 1000 : null,
    });
  }

  /**
   * Ladestrom fürs Auto an einer EEBUS-Wallbox (dvhub-eebus ev_current_limits).
   * @param {string} ski  Wallbox
   * @param {number[]|null} ampsPerPhase  A je Phase L1–L3 (ein Wert gilt für alle
   *   Phasen); null hebt die Grenze auf
   * @param {{uc?: 'opev'|'oscev'}} [opts]  opev = Höchststrom (Überlastschutz, Vorgabe),
   *   oscev = Empfehlung für Eigenverbrauch
   */
  async function setEvCurrentLimits(ski, ampsPerPhase, { uc = 'opev' } = {}) {
    if (uc !== 'opev' && uc !== 'oscev') return { ok: false, error: 'uc must be opev or oscev' };
    if (notHaltBlocks()) { noteNotHaltBlock('ev_current_limits', { ski }); return { ok: false, blocked: true, error: 'emergency_stop_active' }; }
    const ev = ui.devices[ski]?.ev;
    if (!ev?.connected) return { ok: false, error: 'no ev connected' };
    let amps = null;
    if (ampsPerPhase != null) {
      if (!Array.isArray(ampsPerPhase) || ampsPerPhase.length < 1 || ampsPerPhase.length > 3
        || !ampsPerPhase.every((a) => Number.isFinite(Number(a)) && Number(a) >= 0)) {
        return { ok: false, error: 'ampsPerPhase must be 1 to 3 values >= 0 or null' };
      }
      amps = ampsPerPhase.map(Number);
    }
    return send({ cmd: 'ev_current_limits', ski, ...(ev.entity ? { entity: ev.entity } : {}), uc, amps });
  }

  return {
    start,
    stop,
    reload,
    status,
    summary,
    consumptionDevices,
    lostConsumptionDevices,
    controlIssues,
    applyConsumptionShares,
    setPairing,
    setDeviceLimit,
    setEmsLimit,
    deviceInfo,
    setEvCurrentLimits,
    emergencyStop,
    resumeAfterEmergencyStop,
    certPaths,
    // für Tests
    _handleEvent: handleEvent,
    _apply: apply,
    _tick: tick,
    _machines: () => machines,
  };
}
