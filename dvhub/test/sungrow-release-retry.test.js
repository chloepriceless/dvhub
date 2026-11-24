// Option A (Christin 19.11.2026, Punkt 7): Eine gescheiterte manuelle Freigabe („Sungrow freigeben",
// POST /api/sungrow/release → forceRelease, H-7) bleibt als Absicht stehen und wird wiederholt, bis sie bestätigt ist
// („das Verhalten aus dem Feldtest hat Vorrang, Option A ist eigentlich das natürliche, was man erwarten würde").
//
// Vorher (Befund Tor-Umbau Phase 2): forceRelease löschte Besitz-Merker, Ziel und letzten bestätigten Write AUCH,
// wenn die Freigabe scheiterte. Der WR stand weiter in DVhubs Modus 2 mit dem alten Befehl; DVhub hielt ihn für
// fremd (sungrow_foreign_ems_mode), schrieb nie wieder, und Not-Halt-/Shutdown-Rücknahme, ExecStopPost und
// Box-Watchdog übersprangen ihn (not_owned).
//
// Jetzt: DVhubs Modus bleibt DVhubs (Merker bleibt), zwischen zwei Versuchen keine Regel-Writes; die Wiederholung
// ist dieselbe Freigabe-Abfolge (Slave 0xCC, Master 0xCC, Master Modus 0, Rücklesen) im vorhandenen Regeltakt mit
// dem vorhandenen Freigabe-Backoff aus dem Feldtest (M14: nach 3 Fehlschlägen in Folge alle 5 min, ohne
// Obergrenze; ein Knopfdruck umgeht den Backoff). M14-Muster: antwortet der WR mit einer Modbus-Ausnahme, hat den
// Wert aber übernommen, gilt der Schritt als erledigt. Im Not-Halt nur die Wiederholung (manualForceRelease, H-7).
// H-8: nie 13058/13059/Ladestrom. Ein fremder Modus wird nicht wiederholt freigegeben.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSungrowEms, wire, EMS_MODE, EMS_CMD, sungrowEmsConf, endpointKeyOf } from '../services/inverter/sungrow.js';
import { createLegacyGate } from '../services/gate/legacy.js';
import { readForcedMarker } from '../services/inverter/sungrow-forced-safeoff.js';
import { setEmergencyStop } from '../services/control-commands.js';
import { loadConfigFile } from '../config-model.js';
import { loadSungrowConfig, sungrowImage, mockSungrow, sungrowDevice } from './helpers/sungrow-fixture.js';

const MODE = wire(13050); const CMD = wire(13051); const POWER = wire(13052); const HB = wire(13080);
const SLAVE_HOST = '192.168.68.83';
const EMS_WRITE_ADDRS = new Set([MODE, CMD, POWER, HB]);
const FIVE_MIN = 5 * 60_000;

// Aufbau wie schedule-eval.js: Slave-Instanz (isSlave, eigener Merker) zuerst, Master mit slaveActuator, EIN Tor für
// beide (server.js ctx.gate). Fehler je Gerät+Draht-Adresse zur Laufzeit schaltbar:
//   fail.set('M:<addr>', 'timeout')  → wirft „modbus timeout", Wert NICHT übernommen
//   fail.set('M:<addr>', 'exc4')     → wirft „modbus exception 4", Wert NICHT übernommen
//   fail.set('M:<addr>', 'exc4applied') → Wert übernommen, trotzdem „modbus exception 4" (Feldtest M14, SH10RT-20)
function rig({ split = false, controlMode = 'forced', masterHolding = null } = {}) {
  const sungrow = { controlMode, heartbeatTimeoutS: 30 };
  if (split) sungrow.secondInverter = { host: SLAVE_HOST, aggregateTelemetry: true, control: 'split', maxChargeW: 5000, maxDischargeW: 5000, batteryCapacityWh: 5000 };
  const optimizer = split ? { maxChargeW: 5000, maxDischargeW: 5000, batteryCapacityWh: 10000, hardFloorSocPct: 10, maxSocPct: 100 } : null;
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', sungrow, ...(optimizer ? { optimizer } : {}) });
  const mImage = sungrowImage(masterHolding ? { holding: masterHolding } : {});
  const sImage = split ? sungrowImage() : null;
  const m = mockSungrow(mImage);
  const s = sImage ? mockSungrow(sImage) : null;
  const fail = new Map();
  // Lesefehler der Kontroll-Register 13050–13052 je Gerät (Codex d6f4b256 P1): readFail.set('M', 'modbus timeout').
  const readFail = new Map();
  const writes = [];
  const pick = (host) => (s && host === SLAVE_HOST ? ['S', s, sImage] : ['M', m, mImage]);
  const writer = (method) => async (c) => {
    const [dev, mock, img] = pick(c.host);
    const value = method === 'mbWriteMultiple' ? (c.values || [])[0] : c.value;
    writes.push({ dev, address: c.address, value });
    const mode = fail.get(`${dev}:${c.address}`);
    if (mode === 'timeout') throw new Error('modbus timeout');
    if (mode === 'exc4') throw new Error('modbus exception 4');
    if (mode === 'exc4applied') { img.holding.set(c.address, value & 0xffff); throw new Error('modbus exception 4'); }
    return mock[method](c);
  };
  const t = {
    type: 'modbus',
    mbRequest: async (c) => {
      const [dev, mock] = pick(c.host);
      if (readFail.has(dev) && Number(c.fc) === 3 && c.address === MODE) throw new Error(readFail.get(dev));
      return mock.mbRequest(c);
    },
    mbWriteSingle: writer('mbWriteSingle'), mbWriteMultiple: writer('mbWriteMultiple'),
  };
  let clock = 1_000_000;
  const now = () => clock;
  const state = {
    victron: {
      errors: {}, fieldUpdatedAt: { batteryPowerW: clock, pvPowerW: clock, selfConsumptionW: clock },
      device: sungrowDevice({ bdcRatedW: split || controlMode === 'external' ? 10000 : 3000 }),
      batteryPowerW: split ? -3000 : -500, pvPowerW: 0, selfConsumptionW: 500,
      ...(split ? { soc: 50, sungrowMasterSocPct: 80 } : {}),
    },
    meter: { ok: true, updatedAt: clock, grid_total_w: split ? -3000 : 0 }, ctrl: {},
    ...(split ? { sungrowSecond: { online: true, updatedAt: clock, socPct: 20, batteryPowerW: 0, pvPowerW: 0, bdcRatedW: 10000 } } : {}),
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-sg-retry-'));
  const masterPath = path.join(dir, 'sungrow_ems_state.json');
  const slavePath = path.join(dir, 'sungrow_ems_slave_state.json');
  const logs = [];
  const pushLog = (event, data, level) => logs.push({ event, data, level });
  const events = [];
  const gate = createLegacyGate({ isHalted: () => state.ctrl?.discretionaryWritesPaused === true, onEvent: (ev) => events.push(ev), now });
  const sleep = async () => {}; // Lese-Wiederholungen (readDevice) ohne echte Wartezeit
  const slaveEms = split ? createSungrowEms({
    state, getCfg: () => cfg, transport: t, pushLog, now, sleep, statusKey: 'sungrowEmsSlave', isSlave: true, statePath: slavePath, gate,
    connOverride: () => ({ host: SLAVE_HOST, port: 502, unitId: 1, timeoutMs: 1500 }),
  }) : null;
  const ems = createSungrowEms({ state, getCfg: () => cfg, transport: t, pushLog, now, sleep, slaveActuator: slaveEms, statePath: masterPath, gate });
  const ctx = { state, sungrowEms: ems, pushLog, gate };
  const fresh = () => { for (const f of ['batteryPowerW', 'pvPowerW', 'selfConsumptionW']) state.victron.fieldUpdatedAt[f] = clock; state.meter.updatedAt = clock; if (state.sungrowSecond) state.sungrowSecond.updatedAt = clock; };
  return {
    cfg, state, ems, slaveEms, ctx, logs, events, fail, readFail, writes, mImage, sImage, masterPath, slavePath,
    advance: (ms) => { clock += ms; fresh(); }, now,
    dev: (img = mImage) => ({ mode: img.holding.get(MODE), cmd: img.holding.get(CMD), powerW: img.holding.get(POWER) }),
    wireSince: (n) => writes.slice(n).map((w) => `${w.dev}:${w.address}=${w.value}`),
  };
}

const foreignLogged = (r) => r.logs.some((l) => l.event === 'sungrow_ems_foreign_mode');
const assertOnlyEmsRegisters = (r) => {
  for (const w of r.writes) assert.ok(EMS_WRITE_ADDRS.has(w.address), `H-8: unerwarteter Write ${w.dev}:${w.address}=${w.value}`);
};
const REL = [`M:${CMD}=${EMS_CMD.STOP}`, `M:${MODE}=${EMS_MODE.SELF}`]; // Freigabe-Abfolge am Master

test('Option A: gescheiterte Freigabe bleibt als Absicht stehen — Besitz bleibt, keine Regel-Writes, nächster Takt wiederholt und bestätigt', async () => {
  const r = rig();
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, true);
  assert.deepEqual(r.dev(), { mode: EMS_MODE.FORCED, cmd: EMS_CMD.DISCHARGE, powerW: 3000 });

  r.fail.set(`M:${CMD}`, 'timeout');
  const out = await r.ems.forceRelease('manual_release');
  r.fail.clear();
  assert.equal(out.ok, false);
  assert.equal(out.pending, true, 'Rückgabe an die API: wird wiederholt');
  assert.match(String(out.error), /modbus timeout/);
  const rel = r.logs.find((l) => l.event === 'sungrow_ems_manual_release');
  assert.equal(rel?.level, 'warn');
  assert.match(rel?.data?.text || '', /Freigabe gescheitert, wird wiederholt/);
  // DVhubs Modus bleibt DVhubs (Merker auch auf der Platte: Watchdog/ExecStopPost/Not-Halt greifen weiter).
  assert.equal(r.ems._st.owns, true);
  assert.equal(r.ems._st.ownMode, EMS_MODE.FORCED);
  assert.equal(readForcedMarker(r.masterPath).owned, true);
  const st = r.ems.status();
  assert.equal(st.release?.pending, true, 'Status: Freigabe steht aus');
  assert.equal(st.release?.attempts, 1);

  // Zwischen den Versuchen: eine neue Vorgabe schreibt NICHTS (kein Befehl, keine Leistung) und gilt nicht als fremd.
  const n = r.writes.length;
  const sp = await r.ems.applySetpoint(-1000, 'rule:abend');
  assert.equal(sp.ok, false);
  assert.equal(sp.error, 'sungrow_release_pending');
  assert.equal(r.writes.length, n, 'keine Regel-Writes während die Freigabe aussteht');
  assert.ok(!foreignLogged(r), 'eigener Modus 2 gilt nicht als fremd');

  // Nächster Takt: dieselbe Freigabe-Abfolge, diesmal bestätigt.
  r.advance(5000);
  await r.ems.tick();
  assert.deepEqual(r.wireSince(n), REL);
  assert.deepEqual(r.dev(), { mode: EMS_MODE.SELF, cmd: EMS_CMD.STOP, powerW: 3000 });
  assert.equal(r.ems._st.owns, false, 'erst die bestätigte Freigabe gibt den Besitz ab');
  assert.equal(r.ems._st.target, null);
  assert.equal(readForcedMarker(r.masterPath).owned, false);
  const done = r.logs.find((l) => l.event === 'sungrow_ems_release_done');
  assert.ok(done, 'Hinweis: Freigabe erledigt');
  assert.equal(done.data.attempts, 2);
  assert.equal(r.ems.status().release?.pending, false);
  assert.ok(r.events.filter((e) => e.outcome === 'ok').slice(-2).every((e) => e.action === 'manualForceRelease'), 'Wiederholung läuft als manualForceRelease');
  assertOnlyEmsRegisters(r);
});

test('Option A: Wiederholung im Regeltakt, nach 3 Fehlschlägen in Folge nur noch alle 5 min (M14-Backoff), ohne Obergrenze; Knopfdruck umgeht den Backoff', async () => {
  const r = rig();
  await r.ems.applySetpoint(-6000, 'rule:abend');
  r.fail.set(`M:${CMD}`, 'timeout');
  await r.ems.forceRelease('manual_release');           // Fehlschlag 1 (Knopf)
  r.advance(5000); await r.ems.tick();                    // Fehlschlag 2
  r.advance(5000); await r.ems.tick();                    // Fehlschlag 3 → Backoff 5 min
  assert.equal(r.ems.status().release.attempts, 3);
  const retryAt = r.ems.status().release.retryAt;
  assert.equal(retryAt, r.now() + FIVE_MIN);
  const n = r.writes.length;
  r.advance(5000); await r.ems.tick();                    // im Backoff: kein Versuch, kein Write
  r.advance(FIVE_MIN - 10000); await r.ems.tick();
  assert.equal(r.writes.length, n, 'im Backoff-Fenster kein Write');
  r.advance(5000); await r.ems.tick();                    // Backoff vorbei → Versuch 4
  assert.deepEqual(r.wireSince(n), [`M:${CMD}=${EMS_CMD.STOP}`]);
  for (let i = 0; i < 6; i += 1) { r.advance(FIVE_MIN); await r.ems.tick(); } // keine Obergrenze
  assert.equal(r.ems.status().release.attempts, 10);
  assert.equal(r.ems.status().release.pending, true);
  assert.ok(!r.writes.slice(n).some((w) => w.address === POWER || (w.address === MODE && w.value !== EMS_MODE.SELF)), 'nur die Freigabe-Abfolge');
  // Knopfdruck (ausdrücklich) umgeht den Backoff — und klappt jetzt.
  r.fail.clear();
  const k = r.writes.length;
  const out = await r.ems.forceRelease('manual_release');
  assert.equal(out.ok, true);
  assert.deepEqual(r.wireSince(k), REL);
  assert.equal(r.ems.status().release.pending, false);
  assert.equal(r.logs.filter((l) => l.event === 'sungrow_ems_release_done').at(-1)?.data?.attempts, 11);
  assertOnlyEmsRegisters(r);
});

test('Option A: halb angekommene Freigabe (0xCC ja, Modus 0 nein) wird mit derselben Abfolge vollendet', async () => {
  const r = rig();
  await r.ems.applySetpoint(-6000, 'rule:abend');
  r.fail.set(`M:${MODE}`, 'timeout');
  assert.equal((await r.ems.forceRelease('manual_release')).ok, false);
  r.fail.clear();
  assert.deepEqual(r.dev(), { mode: EMS_MODE.FORCED, cmd: EMS_CMD.STOP, powerW: 3000 });
  const n = r.writes.length;
  r.advance(5000); await r.ems.tick();
  assert.deepEqual(r.wireSince(n), REL);
  assert.equal(r.dev().mode, EMS_MODE.SELF);
  assert.equal(r.ems._st.owns, false);
});

test('Option A / M14-Muster: Modbus-Ausnahme, Wert aber übernommen → Schritt erledigt, keine endlose Wiederholung', async () => {
  const r = rig();
  await r.ems.applySetpoint(-6000, 'rule:abend');
  r.fail.set(`M:${MODE}`, 'exc4applied');
  const out = await r.ems.forceRelease('manual_release');
  r.fail.clear();
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(r.ems.status().release?.pending ?? false, false);
  assert.equal(r.ems._st.owns, false);
  assert.ok(r.logs.some((l) => l.event === 'sungrow_ems_release_already_set'), 'gemeldet wie M14');
  // Echte Ausnahme ohne Übernahme bleibt ein Fehlschlag (wird wiederholt).
  const r2 = rig();
  await r2.ems.applySetpoint(-6000, 'rule:abend');
  r2.fail.set(`M:${MODE}`, 'exc4');
  const out2 = await r2.ems.forceRelease('manual_release');
  assert.equal(out2.ok, false);
  assert.equal(out2.pending, true);
});

test('Option A, Not-Halt: die Wiederholung läuft als manualForceRelease (H-7) weiter, sonst kein Write', async () => {
  const r = rig();
  await r.ems.applySetpoint(-6000, 'rule:abend');
  r.fail.set(`M:${CMD}`, 'timeout');
  assert.equal((await r.ems.forceRelease('manual_release')).pending, true);
  const ev0 = r.events.length;
  const w0 = r.writes.length;
  await setEmergencyStop(r.ctx, { on: true });           // einmalige Rücknahme scheitert ebenso (0xCC-Zeitüberschreitung)
  r.advance(5000); await r.ems.tick();                    // Wiederholung im Not-Halt, scheitert noch
  r.advance(5000);
  assert.equal((await r.ems.applySetpoint(-3000, 'rule:abend')).ok, false); // Regel-Vorgabe im Not-Halt: nichts
  r.fail.clear();
  r.advance(5000); await r.ems.tick();                    // Wiederholung klappt
  const halted = r.events.slice(ev0).filter((e) => e.state_flags?.not_halt);
  assert.ok(halted.length > 0);
  assert.ok(halted.every((e) => e.action === 'haltNeutralize' || e.action === 'manualForceRelease'), JSON.stringify(halted.map((e) => e.action)));
  assert.ok(halted.some((e) => e.action === 'manualForceRelease' && e.outcome === 'ok'), 'Wiederholung im Not-Halt zugestellt');
  assert.ok(!halted.some((e) => e.action === 'command' || e.action === 'keepalive'), 'kein Befehl/Lebenszeichen im Not-Halt');
  assert.ok(r.writes.slice(w0).every((w) => w.address === CMD || (w.address === MODE && w.value === EMS_MODE.SELF)), 'im Not-Halt nur 0xCC/Modus 0');
  assert.equal(r.dev().mode, EMS_MODE.SELF);
  assert.ok(r.logs.some((l) => l.event === 'sungrow_ems_release_done'));
  // Danach im Not-Halt: nichts mehr.
  const n = r.writes.length;
  r.advance(5000); await r.ems.tick(); await r.ems.applySetpoint(-3000, 'rule:abend');
  assert.equal(r.writes.length, n);
  assertOnlyEmsRegisters(r);
});

test('Option A, Not-Halt: gelingt die einmalige Rücknahme, ist die ausstehende Freigabe erledigt — danach kein Write mehr (Master + Slave)', async () => {
  const r = rig({ split: true });
  await r.ems.applySetpoint(-3000, 'rule:abend');
  r.fail.set(`S:${CMD}`, 'timeout'); r.fail.set(`M:${MODE}`, 'timeout');
  assert.equal((await r.ems.forceRelease('manual_release')).pending, true);
  r.fail.clear();
  const n = r.writes.length;
  await setEmergencyStop(r.ctx, { on: true });           // Slave 0xCC, Master Modus 0 (0xCC steht schon) — bestätigt
  assert.deepEqual(r.wireSince(n), [`S:${CMD}=${EMS_CMD.STOP}`, `M:${MODE}=${EMS_MODE.SELF}`]);
  const done = r.logs.filter((l) => l.event === 'sungrow_ems_release_done');
  assert.deepEqual(done.map((l) => `${l.data.side}:${l.data.via}`).sort(), ['master:emergency_stop', 'slave:emergency_stop']);
  assert.equal(r.ems.status().release?.pending, false);
  const k = r.writes.length;
  r.advance(5000); await r.ems.tick(); await r.ems.applySetpoint(-2000, 'rule:abend');
  assert.equal(r.writes.length, k, 'keine Wiederholung mehr nötig, kein Regel-Write im Not-Halt');
  assertOnlyEmsRegisters(r);
});

test('Option A, Master/Slave: beide scheitern → beide bleiben DVhubs, Wiederholung Slave zuerst, dann Master; beide erledigt', async () => {
  const r = rig({ split: true });
  assert.equal((await r.ems.applySetpoint(-3000, 'rule:abend')).ok, true);
  assert.equal(r.dev(r.sImage).cmd, EMS_CMD.DISCHARGE);
  r.fail.set(`S:${CMD}`, 'timeout'); r.fail.set(`M:${CMD}`, 'timeout');
  const out = await r.ems.forceRelease('manual_release');
  r.fail.clear();
  assert.equal(out.pending, true);
  assert.equal(r.ems._st.owns, true);
  assert.equal(r.slaveEms._st.owns, true);
  const rel = r.logs.find((l) => l.event === 'sungrow_ems_manual_release');
  assert.deepEqual(rel?.data?.slave, { ok: false, pending: true, error: 'modbus timeout' }, 'Slave-Ergebnis gemeldet');
  const n = r.writes.length;
  assert.equal((await r.ems.applySetpoint(-2000, 'rule:abend')).error, 'sungrow_release_pending');
  assert.equal(r.writes.length, n, 'kein Split-Write während die Freigabe aussteht');
  r.advance(5000); await r.ems.tick();
  assert.deepEqual(r.wireSince(n), [`S:${CMD}=${EMS_CMD.STOP}`, ...REL]);
  assert.equal(r.dev(r.sImage).cmd, EMS_CMD.STOP);
  assert.equal(r.dev().mode, EMS_MODE.SELF);
  assert.equal(r.ems._st.owns, false);
  assert.equal(r.slaveEms._st.owns, false);
  const done = r.logs.filter((l) => l.event === 'sungrow_ems_release_done').map((l) => l.data.side).sort();
  assert.deepEqual(done, ['master', 'slave']);
  assertOnlyEmsRegisters(r);
});

test('Option A, Master/Slave: Master bestätigt, Slave scheitert → nur der Slave wird wiederholt, bis dahin keine Regel-Writes', async () => {
  const r = rig({ split: true });
  await r.ems.applySetpoint(-3000, 'rule:abend');
  r.fail.set(`S:${CMD}`, 'timeout');
  const out = await r.ems.forceRelease('manual_release');
  r.fail.clear();
  assert.equal(out.ok, true, 'Master bestätigt');
  assert.equal(out.pending, true, 'Slave steht noch aus');
  assert.equal(r.slaveEms._st.owns, true);
  const rel = r.logs.find((l) => l.event === 'sungrow_ems_manual_release');
  assert.equal(rel?.level, 'warn');
  const n = r.writes.length;
  r.advance(10000);
  assert.equal((await r.ems.applySetpoint(-3000, 'rule:abend')).error, 'sungrow_release_pending');
  assert.equal(r.writes.length, n);
  await r.ems.tick();
  assert.deepEqual(r.wireSince(n), [`S:${CMD}=${EMS_CMD.STOP}`], 'nur der Slave, dieselbe Abfolge');
  assert.equal(r.slaveEms._st.owns, false);
  assert.ok(r.logs.some((l) => l.event === 'sungrow_ems_release_done' && l.data.side === 'slave'));
  // Danach normaler Betrieb (wie nach jeder bestätigten Freigabe: die nächste Vorgabe regelt wieder).
  r.advance(5000);
  assert.equal((await r.ems.applySetpoint(-2000, 'rule:abend')).ok, true);
});

test('Option A, External EMS: zwischen den Versuchen kein Herzschlag — der WR fällt selbst zurück, die Wiederholung bestätigt', async () => {
  const r = rig({ controlMode: 'external' });
  assert.equal((await r.ems.applySetpoint(-3000, 'rule:abend')).ok, true);
  assert.equal(r.dev().mode, EMS_MODE.EXTERNAL);
  r.fail.set(`M:${CMD}`, 'timeout');
  assert.equal((await r.ems.forceRelease('manual_release')).pending, true);
  r.fail.set(`M:${CMD}`, 'timeout');
  const n = r.writes.length;
  r.advance(5000); await r.ems.tick();
  assert.ok(!r.writes.slice(n).some((w) => w.address === HB || w.address === POWER), 'kein Herzschlag, keine Leistung');
  r.fail.clear();
  r.advance(5000); await r.ems.tick();
  assert.equal(r.dev().mode, EMS_MODE.SELF);
  assert.equal(r.ems._st.owns, false);
  assertOnlyEmsRegisters(r);
});

test('Option A: ein fremder Modus 2 (nicht von DVhub) wird nicht wiederholt freigegeben; ein neuer Sollwert übernimmt ihn (H-9)', async () => {
  const r = rig({ masterHolding: { [MODE]: EMS_MODE.FORCED, [CMD]: EMS_CMD.CHARGE, [POWER]: 1234 } });
  r.fail.set(`M:${CMD}`, 'timeout');
  const out = await r.ems.forceRelease('manual_release');
  r.fail.clear();
  assert.equal(out.ok, false);
  assert.notEqual(out.pending, true);
  assert.equal(r.ems._st.owns, false);
  const n = r.writes.length;
  r.advance(5000); await r.ems.tick();
  r.advance(FIVE_MIN); await r.ems.tick();
  assert.equal(r.writes.length, n, 'keine Wiederholung der Freigabe ohne eigenen Betrieb');
  // H-9 (Christin 17./20.11.2026): der nächste Sollwert übernimmt den Modus 2 mit DVhubs eigenem Befehl — der fremde
  // Wert (Laden 1234 W) läuft nicht weiter, kein Moduswrite. P = −500 + 0,7 · (−4000) = −3300 → BDC-Grenze 3000 W.
  const res = await r.ems.applySetpoint(-4000, 'rule:abend');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(r.wireSince(n), [`M:${POWER}=3000`, `M:${CMD}=${EMS_CMD.DISCHARGE}`]);
  assert.deepEqual(r.dev(), { mode: EMS_MODE.FORCED, cmd: EMS_CMD.DISCHARGE, powerW: 3000 });
  assert.equal(r.ems._st.owns, true);
  assertOnlyEmsRegisters(r);
});

test('Option A: Feldtest „Abregelung testen" bleibt unberührt — Lease und Einstellungen laufen weiter', async () => {
  const r = rig();
  const test0 = { active: true, mode: 'negativePrice', minutes: 10, blockCharge: true, until: r.now() + 10 * 60000 };
  r.state.ctrl.curtailmentTest = { ...test0 };
  await r.ems.applySetpoint(-6000, 'rule:abend');
  r.advance(5000); await r.ems.tick();
  // M25 (main 19.11.): „Akku nicht laden" sperrt nur das Laden — DVhub fährt Modus 2 weiter, entlädt aber nur fürs
  // Haus, lädt nie (vorher: Dauer-Stopp curtailment_test_hold). Absicht dieses Tests unverändert: die Freigabe lässt
  // Lease und Einstellungen des Feldtests in Ruhe.
  assert.equal(r.dev().mode, EMS_MODE.FORCED);
  assert.notEqual(r.ems._st.decision.command, 'charge');
  r.fail.set(`M:${MODE}`, 'timeout');
  assert.equal((await r.ems.forceRelease('manual_release')).pending, true);
  r.fail.clear();
  r.advance(5000); await r.ems.tick();                    // Wiederholung bestätigt
  assert.equal(r.dev().mode, EMS_MODE.SELF);
  assert.deepEqual(r.state.ctrl.curtailmentTest, test0, 'Freigabe ändert den Feldtest nicht');
});

test('Bestätigte Freigabe beim ersten Versuch: wie bisher (Besitz, Ziel, letzter Write weg; nichts steht aus)', async () => {
  const r = rig({ split: true });
  await r.ems.applySetpoint(-3000, 'rule:abend');
  const out = await r.ems.forceRelease('manual_release');
  assert.equal(out.ok, true);
  assert.notEqual(out.pending, true);
  assert.equal(r.ems._st.owns, false);
  assert.equal(r.slaveEms._st.owns, false);
  assert.equal(r.ems._st.target, null);
  assert.equal(r.ems._st.lastMasterWrite, null);
  assert.equal(r.ems.status().release ?? null, null, 'kein Freigabe-Status ohne Wiederholung');
  assert.ok(!r.logs.some((l) => l.event === 'sungrow_ems_release_done'));
  assert.equal(r.logs.find((l) => l.event === 'sungrow_ems_manual_release')?.level, undefined);
});

test('Option A, echter Evaluator: während die Freigabe aussteht kein Write, Sollwert bleibt, kein irreführendes control_write_error', async () => {
  const { createScheduleEvaluator } = await import('../schedule-eval.js');
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', sungrow: { controlMode: 'forced' }, optimizer: { allowGridCharge: true } });
  const image = sungrowImage();
  const m = mockSungrow(image);
  let failCmd = false;
  const t = { type: 'modbus', writes: m.writes, mbRequest: (c) => m.mbRequest(c), mbWriteMultiple: (c) => m.mbWriteMultiple(c),
    mbWriteSingle: async (c) => { if (failCmd && c.address === CMD) { m.writes.push({ fc: 6, address: c.address, value: c.value }); throw new Error('modbus timeout'); } return m.mbWriteSingle(c); } };
  const now = Date.now();
  const state = {
    victron: { soc: 60, batteryPowerW: -500, pvPowerW: 0, selfConsumptionW: 500, errors: {}, fieldUpdatedAt: { soc: now, batteryPowerW: now, pvPowerW: now, selfConsumptionW: now }, device: sungrowDevice() },
    meter: { ok: true, updatedAt: now, grid_total_w: 0 },
    schedule: { rules: [], active: {}, lastWrite: {}, manualOverride: {}, config: {}, lastEvalAt: 0 },
    ctrl: {},
  };
  const logs = [];
  const ev = createScheduleEvaluator({ state, getCfg: () => cfg, transport: t, pushLog: (event, data) => logs.push({ event, data }), telemetrySafeWrite: () => {}, persistConfig: async () => {}, telemetryStore: null, epexNowNext: () => null });
  assert.equal((await ev.applyControlTarget('gridSetpointW', 3000, 'api_manual_write')).ok, true);
  failCmd = true;
  assert.equal((await ev.sungrowEms.forceRelease('manual_release')).pending, true);
  failCmd = false;
  const n = m.writes.length;
  const res = await ev.applyControlTarget('gridSetpointW', 2500, 'api_manual_write');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'sungrow_release_pending');
  assert.equal(res.emsFailure, true, 'Aktuator-Fehler: Sollwert bleibt (kein Widerruf)');
  assert.equal(m.writes.length, n, 'kein Write');
  assert.ok(!logs.some((l) => l.event === 'control_write_error'), 'kein control_write_error — die Freigabe meldet selbst');
});

// --- Codex d6f4b256 P1: vor jeder AUTOMATISCHEN Wiederholung Besitz und Gerätezustand neu prüfen ---------------------
// Hat inzwischen ein anderer Regler übernommen (VPP, fremdes EMS) oder hat eine Rücknahme (Not-Halt) den fremden Modus
// erkannt und den Besitz abgegeben, wird die ausstehende Freigabe verworfen (Log + Status) — nie ein fremder Modus
// überschrieben, auch nicht im Not-Halt. Gilt für Master und Slave (der Slave folgt dem Master-Modus, Feld #5).

const abandonedLogs = (r, side) => r.logs.filter((l) => l.event === 'sungrow_ems_release_abandoned' && (!side || l.data.side === side));

for (const [label, foreign] of [['VPP (Modus 4)', EMS_MODE.VPP], ['fremdes External EMS (Modus 3)', EMS_MODE.EXTERNAL]]) {
  test(`Codex P1: ${label} übernimmt nach der gescheiterten Freigabe → keine Wiederholung, Freigabe verworfen (Log + Status)`, async () => {
    const r = rig();
    await r.ems.applySetpoint(-6000, 'rule:abend');
    r.fail.set(`M:${CMD}`, 'timeout');
    assert.equal((await r.ems.forceRelease('manual_release')).pending, true);
    r.fail.clear();
    r.mImage.holding.set(MODE, foreign); // ein anderes System übernimmt den Wechselrichter
    const n = r.writes.length;
    r.advance(5000); await r.ems.tick();
    assert.deepEqual(r.wireSince(n), [], 'der fremde Modus wird nicht überschrieben');
    const rel = r.ems.status().release;
    assert.equal(rel?.pending, false);
    assert.equal(rel?.abandoned, true, 'Status: Freigabe verworfen');
    assert.equal(rel?.reason, 'foreign_mode');
    assert.equal(rel?.mode, foreign);
    assert.equal(r.ems._st.owns, false, 'Besitz abgegeben');
    assert.equal(readForcedMarker(r.masterPath).owned, false, 'Merker weg: Watchdog/ExecStopPost fassen das fremde System nicht an');
    const a = abandonedLogs(r, 'master');
    assert.equal(a.length, 1);
    assert.equal(a[0].level, 'warn');
    assert.equal(a[0].data.mode, foreign);
    // Danach weder Wiederholung noch Regel-Write.
    for (let i = 0; i < 4; i += 1) { r.advance(FIVE_MIN); await r.ems.tick(); }
    assert.equal((await r.ems.applySetpoint(-4000, 'rule:abend')).error, 'sungrow_foreign_ems_mode');
    assert.deepEqual(r.wireSince(n), []);
    assert.equal(r.dev().mode, foreign);
    assertOnlyEmsRegisters(r);
  });
}

test('Codex P1: Not-Halt erkennt den fremden Modus und gibt den Besitz ab → auch im Not-Halt keine Wiederholung', async () => {
  const r = rig();
  await r.ems.applySetpoint(-6000, 'rule:abend');
  r.fail.set(`M:${CMD}`, 'timeout');
  assert.equal((await r.ems.forceRelease('manual_release')).pending, true);
  r.fail.clear();
  r.mImage.holding.set(MODE, EMS_MODE.VPP);
  const n = r.writes.length;
  const res = await setEmergencyStop(r.ctx, { on: true });
  assert.equal(res.devices.batteryEms.reason, 'foreign_ems_mode');
  assert.equal(r.ems._st.owns, false);
  assert.equal(r.ems.status().release?.abandoned, true, 'Freigabe schon beim Erkennen verworfen');
  assert.equal(abandonedLogs(r, 'master').length, 1);
  for (let i = 0; i < 4; i += 1) { r.advance(5000); await r.ems.tick(); }
  r.advance(FIVE_MIN); await r.ems.tick();
  assert.deepEqual(r.wireSince(n), [], 'im Not-Halt kein 0xCC/Modus 0 gegen das fremde System');
  assert.equal(r.dev().mode, EMS_MODE.VPP);
});

test('Codex P1, Slave: Slave plötzlich im VPP-Modus → Slave-Wiederholung verworfen, nichts an den Slave', async () => {
  const r = rig({ split: true });
  await r.ems.applySetpoint(-3000, 'rule:abend');
  r.fail.set(`S:${CMD}`, 'timeout');
  const out = await r.ems.forceRelease('manual_release');
  r.fail.clear();
  assert.equal(out.ok, true, 'Master bestätigt');
  assert.equal(out.pending, true, 'Slave steht aus');
  r.sImage.holding.set(MODE, EMS_MODE.VPP);
  const n = r.writes.length;
  r.advance(10000); await r.ems.tick(); // Master freigegeben → ruhiger Profil-Takt (wie im Slave-Test oben)
  assert.deepEqual(r.wireSince(n), []);
  assert.equal(r.slaveEms._st.owns, false);
  assert.equal(r.slaveEms.status().release?.abandoned, true);
  assert.equal(r.slaveEms.status().release?.reason, 'foreign_mode');
  assert.equal(abandonedLogs(r, 'slave').length, 1);
  r.advance(FIVE_MIN); await r.ems.tick();
  assert.deepEqual(r.wireSince(n), [], 'keine weitere Wiederholung');
});

test('Codex P1, Slave: am Master steuert inzwischen ein anderes System → auch die Slave-Wiederholung verworfen (Slave folgt dem Master)', async () => {
  const r = rig({ split: true });
  await r.ems.applySetpoint(-3000, 'rule:abend');
  r.fail.set(`S:${CMD}`, 'timeout');
  assert.equal((await r.ems.forceRelease('manual_release')).pending, true);
  r.fail.clear();
  assert.equal(r.dev().mode, EMS_MODE.SELF, 'Master freigegeben');
  r.mImage.holding.set(MODE, EMS_MODE.VPP);
  const n = r.writes.length;
  r.advance(10000); await r.ems.tick();
  assert.deepEqual(r.wireSince(n), [], 'kein 0xCC an den Slave, während am Master ein VPP steuert');
  const a = abandonedLogs(r, 'slave');
  assert.equal(a.length, 1);
  assert.equal(a[0].data.reason, 'master_foreign_mode');
  assert.equal(r.slaveEms.status().release?.abandoned, true);
  assert.equal(r.slaveEms._st.owns, false);
  r.advance(FIVE_MIN); await r.ems.tick();
  assert.deepEqual(r.wireSince(n), []);
});

test('Codex P1: Gerätezustand vor der Wiederholung nicht lesbar → kein automatischer Write, zählt als Fehlschlag', async () => {
  const r = rig();
  await r.ems.applySetpoint(-6000, 'rule:abend');
  r.fail.set(`M:${CMD}`, 'timeout');
  await r.ems.forceRelease('manual_release');
  r.fail.clear();
  r.readFail.set('M', 'modbus timeout');
  const n = r.writes.length;
  r.advance(5000); await r.ems.tick();
  assert.deepEqual(r.wireSince(n), [], 'ohne frischen Gerätezustand kein automatischer Write');
  const rel = r.ems.status().release;
  assert.equal(rel?.pending, true);
  assert.equal(rel?.attempts, 2);
  assert.match(String(rel?.lastError), /lesen fehlgeschlagen/);
  assert.equal(r.ems._st.owns, true, 'DVhubs Modus bleibt DVhubs');
  r.readFail.clear();
  r.advance(5000); await r.ems.tick();
  assert.deepEqual(r.wireSince(n), REL);
  assert.equal(r.ems._st.owns, false);
  assert.equal(r.ems.status().release?.done, true);
});

test('Wiederholung: steht der WR schon in Modus 0 + 0xCC, ist die Freigabe erledigt — kein erneuter Write (13050 schonen)', async () => {
  const r = rig();
  await r.ems.applySetpoint(-6000, 'rule:abend');
  r.fail.set(`M:${MODE}`, 'timeout');
  await r.ems.forceRelease('manual_release');
  r.fail.clear();
  assert.deepEqual(r.dev(), { mode: EMS_MODE.FORCED, cmd: EMS_CMD.STOP, powerW: 3000 });
  r.mImage.holding.set(MODE, EMS_MODE.SELF); // Antwort verloren, Wert aber angekommen — oder am Gerät zurückgestellt
  const n = r.writes.length;
  r.advance(5000); await r.ems.tick();
  assert.deepEqual(r.wireSince(n), []);
  assert.equal(r.ems._st.owns, false);
  assert.equal(readForcedMarker(r.masterPath).owned, false);
  const done = r.logs.filter((l) => l.event === 'sungrow_ems_release_done').at(-1);
  assert.equal(done?.data?.via, 'device');
  assert.equal(r.ems.status().release?.done, true);
  r.advance(5000); await r.ems.tick();
  assert.deepEqual(r.wireSince(n), []);
});

// --- Codex d6f4b256 P2: der Freigabe-Hinweis gehört zu genau einer Anfrage ------------------------------------------

test('Codex P2: eine neue Freigabe-Anfrage löscht den alten „erledigt“-Hinweis; ihr Einmal-Fehlschlag steht im Status', async () => {
  const r = rig();
  await r.ems.applySetpoint(-6000, 'rule:abend');
  r.fail.set(`M:${CMD}`, 'timeout');
  const first = await r.ems.forceRelease('manual_release');
  r.fail.clear();
  assert.equal(typeof first.requestedAt, 'number');
  r.advance(5000); await r.ems.tick();
  assert.equal(r.ems.status().release?.done, true);
  assert.equal(r.ems.status().release?.requestedAt, first.requestedAt);
  // Später übernimmt ein VPP; die neue Freigabe ist ein Einmal-Versuch (kein eigener Betrieb) und scheitert.
  r.mImage.holding.set(MODE, EMS_MODE.VPP);
  r.advance(60_000);
  r.fail.set(`M:${CMD}`, 'timeout');
  const second = await r.ems.forceRelease('manual_release');
  r.fail.clear();
  assert.equal(second.ok, false);
  assert.notEqual(second.pending, true);
  assert.ok(second.requestedAt > first.requestedAt);
  const rel = r.ems.status().release;
  assert.notEqual(rel?.done, true, 'kein alter „erledigt“-Hinweis über dem neuen Fehlschlag');
  assert.equal(rel?.pending, false);
  assert.equal(rel?.failed, true);
  assert.equal(rel?.requestedAt, second.requestedAt);
  assert.match(String(rel?.error), /modbus timeout/);
  // Die nächste Anfrage klappt beim ersten Versuch → kein Hinweis mehr (auch nicht der alte Fehlschlag).
  r.advance(60_000);
  assert.equal((await r.ems.forceRelease('manual_release')).ok, true);
  assert.equal(r.ems.status().release, undefined);
});

// --- Restpunkt 1: kein Schreibweg (Herstellerprofil ungültig) → ehrlich ok:false, nichts gesendet ---------------------

// Echter Ladeweg (config-model.js loadConfigFile) mit kaputtem hersteller/sungrow.json: writeSafety.ok=false, und
// R-T2.1 räumt die Schreibblöcke ab (controlWrite leer) — der Sungrow-EMS hat keine Schreibadressen mehr.
function loadBrokenProfileConfig() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-sungrow-broken-'));
  fs.mkdirSync(path.join(rootDir, 'hersteller'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'hersteller', 'sungrow.json'), '{ "kaputt": ');
  const configPath = path.join(rootDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ manufacturer: 'sungrow', updateChannel: 'dev', victron: { host: '192.0.2.50' } }));
  const loaded = loadConfigFile(configPath);
  assert.ok(loaded.manufacturerProfileError, 'Profil ist ungültig');
  return loaded.effectiveConfig;
}

function brokenRig({ merker = false } = {}) {
  const cfg = loadBrokenProfileConfig();
  const m = mockSungrow(sungrowImage({ holding: { [MODE]: EMS_MODE.FORCED, [CMD]: EMS_CMD.DISCHARGE, [POWER]: 3000 } }));
  const writes = [];
  const t = { type: 'modbus', mbRequest: (c) => m.mbRequest(c),
    mbWriteSingle: async (c) => { writes.push(c); return m.mbWriteSingle(c); },
    mbWriteMultiple: async (c) => { writes.push(c); return m.mbWriteMultiple(c); } };
  const state = { victron: { errors: {}, fieldUpdatedAt: {}, device: null }, meter: {}, ctrl: {} };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-sg-broken-'));
  const statePath = path.join(dir, 'sungrow_ems_state.json');
  // Merker wie nach einem Neustart: DVhub besaß Modus 2 an dieser Verbindung, bevor das Profil kaputtging.
  if (merker) fs.writeFileSync(statePath, JSON.stringify({ ownMode: EMS_MODE.FORCED, endpointKey: endpointKeyOf(cfg.victron), at: 1 }));
  const logs = [];
  const ems = createSungrowEms({ state, getCfg: () => cfg, transport: t, pushLog: (event, data, level) => logs.push({ event, data, level }), statePath, sleep: async () => {} });
  return { cfg, state, ems, writes, logs, m, ctx: { state, sungrowEms: ems, pushLog: (event, data, level) => logs.push({ event, data, level }) } };
}

test('Restpunkt 1: ungültiges Herstellerprofil → manuelle Freigabe meldet ok:false „nichts gesendet“ statt „freigegeben“', async () => {
  const r = brokenRig();
  assert.equal(r.cfg.writeSafety?.ok, false);
  assert.equal(sungrowEmsConf(r.cfg), null, 'R-T2.1: ungültiges Profil hat keine Schreibadressen');
  const out = await r.ems.forceRelease('manual_release');
  assert.equal(out.ok, false, JSON.stringify(out));
  assert.equal(out.sent, false);
  assert.equal(out.error, 'config_unsafe_manufacturer_profile_error');
  assert.equal(typeof out.requestedAt, 'number');
  assert.deepEqual(r.writes, []);
  const rel = r.ems.status().release;
  assert.equal(rel?.failed, true);
  assert.equal(rel?.sent, false);
  assert.equal(rel?.error, 'config_unsafe_manufacturer_profile_error');
  const log = r.logs.find((l) => l.event === 'sungrow_ems_manual_release');
  assert.equal(log?.level, 'warn');
  assert.equal(log?.data?.sent, false);
});

test('Restpunkt 1: ohne Sungrow-Steuerung (kein sungrow-ems-Profil) → ok:false sungrow_ems_not_configured, nichts gesendet', async () => {
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import' });
  cfg.controlWrite = { gridSetpointW: { enabled: true, address: 2700 } }; // Victron-artig, kein emulate
  const writes = [];
  const t = { type: 'modbus', mbRequest: async () => [0, 0xcc, 0], mbWriteSingle: async (c) => { writes.push(c); }, mbWriteMultiple: async (c) => { writes.push(c); } };
  const ems = createSungrowEms({ state: { victron: {}, ctrl: {} }, getCfg: () => cfg, transport: t, sleep: async () => {} });
  const out = await ems.forceRelease('manual_release');
  assert.equal(out.ok, false);
  assert.equal(out.sent, false);
  assert.equal(out.error, 'sungrow_ems_not_configured');
  assert.deepEqual(writes, []);
});

test('Restpunkt 1, gleiches Muster im Not-Halt: Merker steht, aber kein Schreibweg → ok:false statt „nicht im Besitz“', async () => {
  const r = brokenRig({ merker: true });
  assert.equal(r.ems._st.owns, true, 'Merker geladen');
  const res = await setEmergencyStop(r.ctx, { on: true });
  const ems = res.devices.batteryEms;
  assert.equal(ems.ok, false, JSON.stringify(ems));
  assert.equal(ems.sent, false);
  assert.equal(ems.error, 'config_unsafe_manufacturer_profile_error');
  assert.ok(r.logs.some((l) => l.event === 'emergency_stop_neutralize_failed' && l.data.target === 'batteryEms'), 'laut gemeldet');
  assert.deepEqual(r.writes, []);
});

// --- Codex 6f356cb8 P2: steht eine Freigabe aus und fällt der Schreibweg weg, sagen Status und API das -----------------

test('Codex 6f356cb8: Freigabe steht aus, Profil wird ungültig → Status/API „nicht gesendet, steht aus“ statt „wird wiederholt“; danach geht es weiter', async () => {
  const r = rig();
  await r.ems.applySetpoint(-6000, 'rule:abend');
  r.fail.set(`M:${CMD}`, 'timeout');
  assert.equal((await r.ems.forceRelease('manual_release')).pending, true);
  r.fail.clear();
  // Profil kaputt (wie loadConfigFile: writeSafety.ok=false, R-T2.1 räumt controlWrite ab).
  const savedControlWrite = r.cfg.controlWrite;
  r.cfg.controlWrite = {};
  r.cfg.writeSafety = { ok: false, reason: 'manufacturer_profile_error', manufacturer: 'sungrow' };
  const n = r.writes.length;
  // Ohne neuen Knopfdruck: der Takt kann nicht wiederholen — der Status sagt warum.
  r.advance(5000); await r.ems.tick();
  let rel = r.state.ctrl.sungrowEms.release;
  assert.equal(rel?.pending, true, 'die Freigabe bleibt als Auftrag stehen');
  assert.equal(rel?.sent, false, 'Status: nichts gesendet');
  assert.equal(rel?.error, 'config_unsafe_manufacturer_profile_error');
  // Erneuter Knopfdruck: API ehrlich (nichts gesendet, steht aus).
  const out = await r.ems.forceRelease('manual_release');
  assert.equal(out.ok, false);
  assert.equal(out.sent, false);
  assert.equal(out.pending, true);
  assert.equal(out.error, 'config_unsafe_manufacturer_profile_error');
  rel = r.ems.status().release;
  assert.equal(rel?.pending, true);
  assert.equal(rel?.sent, false);
  assert.equal(rel?.requestedAt, out.requestedAt);
  assert.deepEqual(r.wireSince(n), []);
  // Profil wieder gültig → die Wiederholung läuft weiter und bestätigt.
  r.cfg.controlWrite = savedControlWrite;
  delete r.cfg.writeSafety;
  r.advance(5000); await r.ems.tick();
  assert.deepEqual(r.wireSince(n), REL);
  rel = r.ems.status().release;
  assert.equal(rel?.done, true);
  assert.equal(rel?.sent, undefined);
});
