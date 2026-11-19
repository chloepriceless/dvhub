// H-1 Phase 2 — Paritätsnachweis für Pfad 6 (Sungrow-EMS, Master UND Slave) über das Schreibtor im Legacy-Modus
// (VCL-Vertrag v6 D.2 „bit-gleich zu main", Nachweis D.4(2)): dieselbe Szenario-Liste läuft einmal über den ALTEN
// Weg (Aufruf direkt an den Transport, `directGate` unten) und einmal über das ECHTE Tor (ein gemeinsames Tor für
// Master und Slave wie in der Laufzeit, server.js ctx.gate). Verglichen werden:
//   • die geordnete Draht-Folge beider WR in EINEM Protokoll (Adresse, Wert, FC) und die vollen Argument-Objekte,
//   • die Lesefolge (Reads entscheiden den weiteren Ablauf),
//   • jeder Rückgabewert der aufgerufenen Aktuator-Funktionen,
//   • die Log-Ereignisnamen samt Stufe, die Statuskachel beider WR (inkl. Modbus-Gesundheit, Tageszähler),
//   • im Lese-Modus die abgewehrten Schreibversuche (Zahl und gemeldete Zeile).
// Der Fake-Transport bildet transport-modbus.js an der Rahmengrenze nach: im Lese-Modus lehnt er jeden Write mit
// derselben Meldung ab (ReadOnlyViolation, noteBlockedWrite) und nichts erreicht den Draht.
//
// Optionaler Gegenbeweis gegen den Stand VOR dem Umbau: SUNGROW_PARITY_BASE=<Pfad zu einer Kopie der alten
// services/inverter/sungrow.js im selben Verzeichnis> — dann fährt die alte Seite den alten Code (ohne Tor-Option).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import * as current from '../services/inverter/sungrow.js';
import { createLegacyGate, SUNGROW_GATE_DEVICES } from '../services/gate/legacy.js';
import { setEmergencyStop } from '../services/control-commands.js';
import { ReadOnlyViolation, blockedWriteCount, isReadOnlyMode, noteBlockedWrite } from '../read-only-guard.js';
import { loadSungrowConfig, sungrowImage, mockSungrow, sungrowDevice, SUNGROW_ENDPOINT } from './helpers/sungrow-fixture.js';

const { wire } = current;
const base = process.env.SUNGROW_PARITY_BASE
  ? await import(pathToFileURL(path.resolve(process.env.SUNGROW_PARITY_BASE)).href)
  : null;
const oldCreate = base ? base.createSungrowEms : current.createSungrowEms;
const newCreate = current.createSungrowEms;

const SLAVE_HOST = '192.168.68.83';
const MODE = wire(13050); const CMD = wire(13051); const POWER = wire(13052); const HB = wire(13080);

// „Alter Weg": dieselbe Aufrufstelle ohne Tor — der Legacy-Aufruf geht unmittelbar an den Transport, Rückgabe und
// Fehler unverändert. Genau das war `await transport.mbWriteSingle(args)` vor Phase 2 (nur für diesen Test).
function directGate() {
  const sinks = {};
  return {
    attachSink(name, spec) { sinks[name] = spec; },
    setRelease() {},
    fence() {},
    async submit(op) {
      try {
        return { outcome: 'ok', result: await sinks[op.legacy.sink].legacy[op.legacy.fn](...op.legacy.args) };
      } catch (e) {
        return { outcome: 'error', error: e };
      }
    },
  };
}

// Ein Fake-Transport für Master und (optional) Slave; alle Writes in EINEM Protokoll in Draht-Reihenfolge.
function fakeWire(mImage, sImage, { master = {}, slave = {}, failWrite = {}, onWrite = null } = {}) {
  const m = mockSungrow(mImage, master);
  const s = sImage ? mockSungrow(sImage, slave) : null;
  const log = []; const calls = []; const reads = [];
  const pick = (host) => (s && host === SLAVE_HOST ? ['S', s] : ['M', m]);
  const writer = (method, fc) => async (c) => {
    const [dev, mock] = pick(c.host);
    // Lese-Modus wie transport-modbus.js send(): Schreibrahmen gar nicht erst einreihen.
    if (isReadOnlyMode()) {
      noteBlockedWrite(`Modbus fc=${fc} an ${c.host}:${c.port}`);
      throw new ReadOnlyViolation(`Schreibzugriff im Lese-Modus abgelehnt (Modbus fc=${fc})`);
    }
    const entry = fc === 16 ? `${dev}:${c.address}=[${(c.values || []).join(',')}]` : `${dev}:${c.address}=${c.value}`;
    log.push(entry);
    calls.push(`${dev}:${method}:${JSON.stringify(c)}`);
    try {
      const fail = failWrite[`${dev}:${c.address}`];
      if (fail) throw fail();
      return await mock[method](c);
    } finally {
      if (onWrite) onWrite(entry);
    }
  };
  return {
    type: 'modbus',
    mbRequest: (c) => { const [dev, mock] = pick(c.host); reads.push(`${dev}:fc${c.fc}:${c.address}x${c.quantity}`); return mock.mbRequest(c); },
    mbWriteSingle: writer('mbWriteSingle', 6),
    mbWriteMultiple: writer('mbWriteMultiple', 16),
    log, calls, reads, m, s,
  };
}

// Aufbau wie schedule-eval.js: Slave-Instanz zuerst, Master mit slaveActuator; ein Tor für beide (neu) bzw. je ein
// direkter Weg (alt).
function buildRig(mode, {
  split = false, controlMode = 'forced', heartbeatTimeoutS = 30, keepaliveRegister = undefined,
  device = sungrowDevice({ bdcRatedW: split ? 10000 : 3000 }), batteryPowerW = split ? -3000 : -500, grid = split ? -3000 : 0,
  masterSoc = 80, slaveSoc = 20, optimizer = null, wireOpts = {}, statePath = null, masterHolding = null,
} = {}) {
  const sungrow = { controlMode, heartbeatTimeoutS, ...(keepaliveRegister ? { keepaliveRegister } : {}) };
  if (split) sungrow.secondInverter = { host: SLAVE_HOST, aggregateTelemetry: true, control: 'split', maxChargeW: 5000, maxDischargeW: 5000, batteryCapacityWh: 5000 };
  else if (controlMode === 'forced') sungrow.secondInverter = { host: SLAVE_HOST };
  const opt = split
    ? { maxChargeW: 5000, maxDischargeW: 5000, batteryCapacityWh: 10000, hardFloorSocPct: 10, maxSocPct: 100, ...(optimizer || {}) }
    : optimizer;
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', sungrow, ...(opt ? { optimizer: opt } : {}) });
  const t = fakeWire(sungrowImage(masterHolding ? { holding: masterHolding } : {}), split ? sungrowImage() : null, wireOpts);
  let clock = 1_000_000;
  const now = () => clock;
  const state = {
    victron: {
      errors: {}, fieldUpdatedAt: { batteryPowerW: clock, pvPowerW: clock, selfConsumptionW: clock }, device,
      batteryPowerW, pvPowerW: 0, selfConsumptionW: 500,
      ...(split ? { soc: Math.round((masterSoc + slaveSoc) / 2), sungrowMasterSocPct: masterSoc } : {}),
    },
    meter: { ok: true, updatedAt: clock, grid_total_w: grid }, ctrl: {},
    ...(split ? { sungrowSecond: { online: true, updatedAt: clock, socPct: slaveSoc, batteryPowerW: 0, pvPowerW: 0, bdcRatedW: 10000 } } : {}),
  };
  const logs = [];
  const pushLog = (event, _data, level) => logs.push(`${event}${typeof level === 'string' ? `:${level}` : (level?.severity ? `:${level.severity}` : '')}`);
  const events = [];
  const shared = mode === 'new'
    ? createLegacyGate({ isHalted: () => state.ctrl?.discretionaryWritesPaused === true, onEvent: (ev) => events.push(ev), now })
    : null;
  const create = mode === 'new' ? newCreate : oldCreate;
  const gateArg = () => (mode === 'new' ? shared : directGate());
  // Einzel-WR wie die Bestands-Rigs ohne Slave-Instanz; im Split beide an EINEM Tor (neu) wie in der Laufzeit.
  const slaveEms = split ? create({
    state, getCfg: () => cfg, transport: t, pushLog, now, statusKey: 'sungrowEmsSlave', isSlave: true, gate: gateArg(),
    connOverride: () => ({ host: SLAVE_HOST, port: 502, unitId: 1, timeoutMs: 1500 }),
  }) : null;
  const ems = create({ state, getCfg: () => cfg, transport: t, pushLog, now, slaveActuator: slaveEms, gate: gateArg(), statePath });
  const ctx = { state, sungrowEms: ems, pushLog, ...(shared ? { gate: shared } : {}) };
  return { mode, cfg, state, t, ems, slaveEms, ctx, logs, events, notes: [], gate: shared, advance: (ms) => { clock += ms; }, now };
}

// Merker auf der Platte (wie sungrow_ems_state.json nach einem Neustart mit DVhub-Besitz).
function merker(ownMode = 2) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-sg-parity-'));
  const p = path.join(dir, 'sungrow_ems_state.json');
  fs.writeFileSync(p, JSON.stringify({ ownMode, endpointKey: SUNGROW_ENDPOINT, at: 1 }));
  return p;
}

const halt = (r) => setEmergencyStop(r.ctx, { on: true });
const resume = (r) => setEmergencyStop(r.ctx, { on: false });
// Rückgaben vergleichbar machen: Zeitstempel kommen aus der festen Uhr; pausedAt aus Date.now() wird geglättet.
const plain = (v) => JSON.parse(JSON.stringify(v ?? null, (k, x) => (k === 'pausedAt' ? '<t>' : x)));

// Gewollte Verhaltensänderung (Christin 19.11., Option A): eine gescheiterte manuelle Freigabe bleibt als Absicht
// stehen und wird wiederholt (test/sungrow-release-retry.test.js); antwortet der WR mit einer Modbus-Ausnahme, hat den
// Wert aber übernommen, gilt der Schritt als erledigt (M14-Muster). Gegen einen Stand VOR dem 19.11.
// (SUNGROW_PARITY_BASE) vergleichen markierte Szenarien nur noch den Draht (Writes + volle Argumente) — der bleibt
// gleich; Rückgaben, Lesefolge, Log und Kachel ändern sich gewollt. Ohne Base (Standard) gilt weiter alles bit-gleich.
const OPTION_A = Object.freeze({ since: 'Christin 19.11., Option A', compare: ['wire', 'calls'] });
const forBase = (out, sc) => (base && sc.intendedSinceBase
  ? Object.fromEntries(sc.intendedSinceBase.compare.map((k) => [k, out[k]]))
  : out);

// --- Szenarien ---------------------------------------------------------------------------------------------------
// je: rig-Optionen, Ablauf (gibt die Rückgaben zurück), optional Soll für die neue Seite (gegen leere Gleichheit).
const SCENARIOS = {
  // die sechs Golden-Master-Szenarien (test/gate-golden-sungrow.test.js)
  golden_single_discharge_limit: {
    rig: {}, run: async (r) => [await r.ems.applySetpoint(-6000, 'rule:abend')],
    wire: ['M:13051=3000', 'M:13050=187', 'M:13049=2'],
  },
  golden_single_charge_gridcharge: {
    rig: { device: sungrowDevice({ bdcRatedW: 10000 }), optimizer: { allowGridCharge: true, maxChargeW: 10000 } },
    run: async (r) => [await r.ems.applySetpoint(4000, 'rule:netzladen')],
    wire: ['M:13051=2300', 'M:13050=170', 'M:13049=2'],
  },
  golden_single_setpoint_zero: {
    rig: {}, run: async (r) => [await r.ems.applySetpoint(0, 'rule:halten')],
    wire: ['M:13051=500', 'M:13050=187', 'M:13049=2'],
  },
  golden_split_discharge_balanced: {
    rig: { split: true }, run: async (r) => [await r.ems.applySetpoint(-3000, 'rule:abend')],
    wire: ['S:13051=111', 'S:13050=187', 'M:13051=2889', 'M:13050=187', 'M:13049=2'],
  },
  golden_split_master_floor: {
    rig: { split: true, masterSoc: 9, slaveSoc: 15 }, run: async (r) => [await r.ems.applySetpoint(-3000, 'rule:abend')],
    wire: ['S:13051=3000', 'S:13050=187', 'M:13049=2'],
  },
  golden_split_slave_fallback: {
    rig: { split: true, wireOpts: { slave: { failReadAt: wire(13050) } } },
    run: async (r) => [await r.ems.applySetpoint(-3000, 'rule:abend')],
    wire: ['M:13051=3000', 'M:13050=187', 'M:13049=2'],
  },

  // Nachführen im Takt und Rücknahme bei veraltetem Sollwert
  forced_ticks_and_expiry: {
    rig: {},
    run: async (r) => {
      const out = [await r.ems.applySetpoint(-6000, 'rule:abend')];
      r.state.victron.batteryPowerW = -2000;
      r.advance(11000); out.push(await r.ems.tick());
      r.advance(130000); out.push(await r.ems.tick()); // > targetMaxAgeMs → Rückgabe an den WR (Modus 0)
      out.push(await r.ems.revoke('gate_rejected'));
      return out;
    },
  },

  // External EMS: Eintritt mit Herzschlag 13080 (FC 6 übernommen), Takt-Herzschlag + Leistungs-Lebenszeichen
  external_entry_keepalive: {
    rig: { controlMode: 'external', keepaliveRegister: 'both', device: sungrowDevice({ bdcRatedW: 10000 }) },
    run: async (r) => {
      const out = [await r.ems.applySetpoint(-3000, 'rule:abend')];
      for (let i = 0; i < 3; i += 1) { r.advance(5000); out.push(await r.ems.tick()); }
      return out;
    },
  },
  // External EMS: der WR übernimmt keinen Herzschlag (FC 6 verworfen, FC 16 ohne Wirkung) → sicher zurück (neutralize)
  external_heartbeat_mismatch: {
    rig: { controlMode: 'external', device: sungrowDevice({ bdcRatedW: 10000 }), wireOpts: { master: { ignoreWriteAt: HB } } },
    run: async (r) => [await r.ems.applySetpoint(-3000, 'rule:abend'), await r.ems.applySetpoint(-2500, 'rule:abend')],
  },

  // Not-Halt: Rücknahme (haltNeutralize), gesperrter Befehl, manuelle Zwangsfreigabe (H-7), Wiederaufnahme
  emergency_stop_single: {
    rig: {},
    run: async (r) => {
      const out = [await r.ems.applySetpoint(-6000, 'rule:abend')];
      out.push(await halt(r));
      out.push(await r.ems.applySetpoint(-3000, 'rule:abend')); // eigener Befehl im Not-Halt → gesperrt
      out.push(await r.ems.tick());
      out.push(await r.ems.forceRelease('manual_release')); // H-7: auch im Not-Halt
      out.push(await r.ems.releaseControl('shutdown'));
      out.push(await resume(r));
      out.push(await r.ems.applySetpoint(-6000, 'rule:abend'));
      return out;
    },
    newSide: (r) => {
      const halted = r.events.filter((e) => e.state_flags.not_halt);
      assert.ok(halted.some((e) => e.action === 'haltNeutralize' && e.outcome === 'ok'), 'Rücknahme im Not-Halt über das Tor');
      assert.ok(halted.some((e) => e.action === 'manualForceRelease' && e.outcome === 'ok'), 'H-7 im Not-Halt über das Tor');
      assert.ok(!halted.some((e) => e.action === 'command' || e.action === 'keepalive'), 'kein Befehl im Not-Halt');
    },
  },
  emergency_stop_split: {
    rig: { split: true },
    run: async (r) => {
      const out = [await r.ems.applySetpoint(-3000, 'rule:abend')];
      out.push(await halt(r));
      out.push(await r.ems.applySetpoint(-2000, 'rule:abend'));
      out.push(await r.ems.forceRelease('manual_release'));
      return out;
    },
    newSide: (r) => {
      const manual = r.events.filter((e) => e.action === 'manualForceRelease');
      assert.deepEqual(manual.map((e) => `${e.target.device}:${e.point}=${e.value.eng}:${e.outcome}`), [
        `${SUNGROW_GATE_DEVICES.slave}:emsCmd=204:ok`, `${SUNGROW_GATE_DEVICES.master}:emsCmd=204:ok`, `${SUNGROW_GATE_DEVICES.master}:emsMode=0:ok`,
      ]);
    },
  },
  // Not-Halt beginnt MITTEN in der Schreibfolge (nach dem Befehl, vor dem Modus)
  emergency_stop_mid_sequence: {
    rig: {},
    onWrite: (r, entry) => { if (entry === 'M:13050=187') { r.state.ctrl.discretionaryWritesPaused = true; r.state.ctrl.pausedAt = 123; } },
    run: async (r) => {
      const out = [await r.ems.applySetpoint(-6000, 'rule:abend')];
      out.push(await r.ems.emergencyStop());
      out.push(await r.ems.emergencyStop()); // genau einmal
      return out;
    },
    wire: ['M:13051=3000', 'M:13050=187', 'M:13050=204'],
  },

  // Lese-Modus (DVHUB_READ_ONLY=1): nichts erreicht den Draht, gleiche Meldung, gleiche Kachel
  read_only: {
    rig: { split: true }, readOnly: true,
    run: async (r) => [
      await r.ems.applySetpoint(-3000, 'rule:abend'),
      await r.ems.forceRelease('manual_release'),
      await r.ems.releaseControl('shutdown'),
    ],
    wire: [],
    newSide: (r) => assert.ok(r.events.length > 0 && r.events.every((e) => e.outcome === 'blocked_readonly'), 'das Tor sperrt im Lese-Modus'),
  },

  // ungültige Konfiguration (C2, writeSafety.ok=false): auch Rücknahme und Zwangsfreigabe schreiben nicht
  config_unsafe: {
    rig: {},
    run: async (r) => {
      const out = [await r.ems.applySetpoint(-6000, 'rule:abend')];
      const note = () => r.notes.push(r.gate?.releaseState(SUNGROW_GATE_DEVICES.master) ?? null);
      note();
      const unsafe = { ok: false, reason: 'manufacturer_profile_error', manufacturer: 'sungrow' };
      r.cfg.writeSafety = unsafe;
      out.push(await r.ems.applySetpoint(-3000, 'rule:abend')); note();
      out.push(await r.ems.releaseControl('shutdown')); note();
      r.cfg.writeSafety = { ok: true };
      out.push(await r.ems.applySetpoint(-2000, 'rule:abend')); note(); // neuer Sollwert (1900 W) → schreibt wieder
      r.cfg.writeSafety = unsafe;
      out.push(await r.ems.forceRelease('manual_release')); note(); // auch die Zwangsfreigabe schreibt nicht (C2)
      return out;
    },
    // Der Torzustand folgt writeSafety in beide Richtungen (dieselbe Quelle wie die C2-Sperre), gesetzt bei jeder
    // Einreichung — dem einzigen Zeitpunkt, an dem das Tor entscheidet.
    newSide: (r) => {
      assert.deepEqual(r.notes, ['open', 'profileInvalid', 'profileInvalid', 'open', 'profileInvalid']);
      // Christin 19.11., Option A: die von C2 gesperrte Freigabe bleibt als Absicht stehen, DVhubs Modus 2 bleibt DVhubs.
      const s = r.ems.status();
      assert.equal(s.release?.pending, true);
      assert.equal(s.owns, true);
      assert.equal(s.ownMode, 2);
    },
    intendedSinceBase: OPTION_A,
  },

  // Gerät nicht erkannt/nicht unterstützt: der Regler schreibt nicht; Not-Halt-Rücknahme (Merker nach Neustart) und
  // manuelle Freigabe schreiben wie heute trotzdem (die Erkennung bleibt in Phase 2 beim Aufrufer, step()).
  device_not_identified: {
    rig: { device: null, statePath: 'merker', masterHolding: { [MODE]: 2, [CMD]: 0xbb, [POWER]: 3000 } },
    run: async (r) => {
      const out = [await r.ems.applySetpoint(-6000, 'rule:abend')];
      r.state.victron.device = sungrowDevice({ supported: false });
      out.push(await r.ems.applySetpoint(-6000, 'rule:abend'));
      out.push(await halt(r));
      out.push(await r.ems.forceRelease('manual_release'));
      return out;
    },
    wire: ['M:13050=204', 'M:13049=0', 'M:13050=204', 'M:13049=0'],
  },

  // Modbus-Ausnahmen beim Schreiben: die Zustellungs-Einordnung des Tors ändert nichts an der Rückgabe
  modbus_exception_2_cmd: {
    rig: { wireOpts: { failWrite: { [`M:${CMD}`]: () => new Error('modbus exception 2') } } },
    run: async (r) => [await r.ems.applySetpoint(-6000, 'rule:abend'), await r.ems.releaseControl('shutdown')],
    newSide: (r) => assert.ok(r.events.some((e) => e.outcome === 'error' && e.delivery === 'rejected'), 'Ausnahme 2 → rejected'),
  },
  modbus_exception_4_mode: {
    rig: { wireOpts: { failWrite: { [`M:${MODE}`]: () => new Error('modbus exception 4') } } },
    run: async (r) => [await r.ems.applySetpoint(-6000, 'rule:abend'), await r.ems.forceRelease('manual_release')],
    newSide: (r) => {
      assert.ok(r.events.some((e) => e.outcome === 'error' && e.delivery === 'unknown'), 'Ausnahme 4 → unknown');
      // Christin 19.11., Option A (M14-Muster): 13050 meldet Ausnahme 4, der Master steht aber in Modus 0 + 0xCC →
      // die Freigabe gilt als bestätigt (vorher: Fehlschlag), nichts steht aus.
      assert.ok(r.logs.includes('sungrow_ems_release_already_set:warn'));
      assert.ok(r.logs.includes('sungrow_ems_manual_release'), 'Freigabe ohne Warnung gemeldet');
      assert.equal(r.ems.status().release, undefined);
      assert.equal(r.ems.status().owns, false);
    },
    intendedSinceBase: OPTION_A,
  },
  modbus_timeout_split_slave: {
    rig: { split: true, wireOpts: { failWrite: { [`S:${POWER}`]: () => new Error('modbus timeout') } } },
    run: async (r) => [await r.ems.applySetpoint(-3000, 'rule:abend')],
  },

  // geordnetes Beenden im Forced-Split (Absicherung C): Slave 0xCC, dann Master 0xCC + Modus 0
  shutdown_release_forced_split: {
    rig: { split: true },
    run: async (r) => [await r.ems.applySetpoint(-3000, 'rule:abend'), await r.ems.releaseControl('shutdown'), await r.ems.releaseControl('shutdown')],
    newSide: (r) => {
      const rel = r.events.filter((e) => e.action === 'haltNeutralize').map((e) => `${e.target.device}:${e.point}=${e.value.eng}`);
      assert.deepEqual(rel, [`${SUNGROW_GATE_DEVICES.slave}:emsCmd=204`, `${SUNGROW_GATE_DEVICES.master}:emsCmd=204`, `${SUNGROW_GATE_DEVICES.master}:emsMode=0`]);
    },
  },
  // Neustart mit Forced-Merker (C3): der WR hält noch DVhubs alten Entladebefehl (Modus 2, 0xBB, 3000 W); der erste
  // Takt setzt den Befehl einmal auf 0xCC, bevor neu geregelt wird.
  startup_reset_with_merker: {
    rig: { statePath: 'merker', masterHolding: { [MODE]: 2, [CMD]: 0xbb, [POWER]: 3000 } },
    run: async (r) => [await r.ems.applySetpoint(-6000, 'rule:abend'), await r.ems.applySetpoint(-5000, 'rule:abend')],
    // erst der Rücksetz-Stopp 0xCC (Modus 2 bleibt), dann wieder Entladen (Codex 44637c3e P2)
    wire: ['M:13050=204', 'M:13050=187'],
  },
};

async function runScenario(name, mode) {
  const sc = SCENARIOS[name];
  const opts = { ...sc.rig };
  if (opts.statePath === 'merker') opts.statePath = merker();
  // Haken je Draht-Write (Not-Halt mitten in der Folge); greift erst nach dem Aufbau.
  const hook = { r: null };
  if (sc.onWrite) opts.wireOpts = { ...(opts.wireOpts || {}), onWrite: (entry) => hook.r && sc.onWrite(hook.r, entry) };
  const r = buildRig(mode, opts);
  hook.r = r;
  const blockedBefore = blockedWriteCount();
  const prevRo = process.env.DVHUB_READ_ONLY;
  const prevWarn = console.warn;
  const readOnlyLines = [];
  if (sc.readOnly) {
    process.env.DVHUB_READ_ONLY = '1';
    // noteBlockedWrite meldet laut auf console.warn; der laufende Zähler „(bisher N)“ ist prozessweit und fällt weg.
    console.warn = (...a) => { readOnlyLines.push(String(a[0]).replace(/ \(bisher \d+\)$/, '')); };
  }
  let results;
  try {
    results = await sc.run(r);
  } finally {
    console.warn = prevWarn;
    if (prevRo === undefined) delete process.env.DVHUB_READ_ONLY; else process.env.DVHUB_READ_ONLY = prevRo;
  }
  const out = {
    wire: r.t.log,
    calls: r.t.calls,
    reads: r.t.reads,
    results: plain(results),
    logs: r.logs,
    status: plain({ master: r.ems.status(), slave: r.slaveEms?.status() ?? null }),
    readOnlyBlocked: blockedWriteCount() - blockedBefore,
    readOnlyLines,
  };
  return { r, out };
}

for (const name of Object.keys(SCENARIOS)) {
  test(`Parität alt ↔ Tor (Legacy): ${name}`, async () => {
    const sc = SCENARIOS[name];
    const before = await runScenario(name, 'old');
    const after = await runScenario(name, 'new');
    assert.deepEqual(forBase(after.out, sc), forBase(before.out, sc), `${name}: Tor-Pfad weicht vom alten Weg ab`);
    if (sc.wire) assert.deepEqual(after.out.wire, sc.wire, `${name}: Draht-Folge`);
    // Jeder Draht-Write der neuen Seite lief durch das Tor (ein ok/error-Ereignis je Write, Vertrauensklasse legacy).
    const delivered = after.r.events.filter((e) => e.outcome === 'ok' || e.outcome === 'error');
    assert.equal(delivered.length, after.out.wire.length, `${name}: jeder Write ein Tor-Ereignis`);
    assert.ok(after.r.events.every((e) => e.trust === 'legacy'), 'Vertrauensklasse legacy (D.2)');
    sc.newSide?.(after.r);
  });
}

test('Parität: die Szenarien sind nicht leer (Draht, Lese-Modus, Not-Halt)', async () => {
  const written = [];
  for (const name of Object.keys(SCENARIOS)) {
    const { out } = await runScenario(name, 'new');
    if (out.wire.length > 0) written.push(name);
  }
  assert.ok(written.length >= Object.keys(SCENARIOS).length - 2, `zu wenige schreibende Szenarien: ${written.join(', ')}`);
  const ro = await runScenario('read_only', 'new');
  assert.ok(ro.out.readOnlyBlocked > 0, 'Lese-Modus wehrt Writes ab');
  assert.equal(ro.out.readOnlyLines.length, ro.out.readOnlyBlocked);
  assert.match(ro.out.readOnlyLines[0], /^\[READ-ONLY\] Schreibzugriff blockiert: Modbus fc=6 an 192\.168\.68\.83:502$/, 'dieselbe Zeile wie transport-modbus.js');
  assert.ok(ro.out.status.master.health.errors24h > 0, 'wie bisher als Modbus-Fehler gezählt');
});
