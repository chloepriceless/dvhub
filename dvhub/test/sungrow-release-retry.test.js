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

import { createSungrowEms, wire, EMS_MODE, EMS_CMD } from '../services/inverter/sungrow.js';
import { createLegacyGate } from '../services/gate/legacy.js';
import { readForcedMarker } from '../services/inverter/sungrow-forced-safeoff.js';
import { setEmergencyStop } from '../services/control-commands.js';
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
  const t = { type: 'modbus', mbRequest: (c) => pick(c.host)[1].mbRequest(c), mbWriteSingle: writer('mbWriteSingle'), mbWriteMultiple: writer('mbWriteMultiple') };
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
  const slaveEms = split ? createSungrowEms({
    state, getCfg: () => cfg, transport: t, pushLog, now, statusKey: 'sungrowEmsSlave', isSlave: true, statePath: slavePath, gate,
    connOverride: () => ({ host: SLAVE_HOST, port: 502, unitId: 1, timeoutMs: 1500 }),
  }) : null;
  const ems = createSungrowEms({ state, getCfg: () => cfg, transport: t, pushLog, now, slaveActuator: slaveEms, statePath: masterPath, gate });
  const ctx = { state, sungrowEms: ems, pushLog, gate };
  const fresh = () => { for (const f of ['batteryPowerW', 'pvPowerW', 'selfConsumptionW']) state.victron.fieldUpdatedAt[f] = clock; state.meter.updatedAt = clock; if (state.sungrowSecond) state.sungrowSecond.updatedAt = clock; };
  return {
    cfg, state, ems, slaveEms, ctx, logs, events, fail, writes, mImage, sImage, masterPath, slavePath,
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

test('Option A: ein fremder Modus 2 (nicht von DVhub) wird nicht wiederholt freigegeben und nicht übernommen', async () => {
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
  assert.equal(r.writes.length, n, 'keine Wiederholung gegen ein fremdes EMS');
  assert.equal((await r.ems.applySetpoint(-4000, 'rule:abend')).error, 'sungrow_foreign_ems_mode');
  assert.deepEqual(r.dev(), { mode: EMS_MODE.FORCED, cmd: EMS_CMD.CHARGE, powerW: 1234 });
});

test('Option A: Feldtest „Abregelung testen" bleibt unberührt — Lease und Einstellungen laufen weiter', async () => {
  const r = rig();
  const test0 = { active: true, mode: 'negativePrice', minutes: 10, blockCharge: true, until: r.now() + 10 * 60000 };
  r.state.ctrl.curtailmentTest = { ...test0 };
  await r.ems.applySetpoint(-6000, 'rule:abend');
  r.advance(5000); await r.ems.tick();                    // Feldtest hält den Akku an (0xCC, Modus 2)
  assert.equal(r.ems._st.decision.reason, 'curtailment_test_hold');
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
