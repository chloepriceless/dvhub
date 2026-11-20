// H-9 „Modus 2 übernehmen und weiterfahren" (VCL-Vertrag v6 Teil H, VÄ-3; Christin 17.11.2026, bestätigt 20.11.2026).
//
// Ein gefundener EMS-Modus 2 (Forced) wird — auch ohne Eigentumsbeleg — übernommen und als eigener weitergefahren.
// Das Eigentum stellt DVhub per bekanntem Write her: Der erste Write ist DVhubs eigener Befehl (13051, bei Laden/
// Entladen auch die Leistung 13052), auch wenn das Gerät schon etwas Ähnliches oder Gleiches zeigt. Ein unbekannter
// Gerätewert läuft nie unter DVhubs Besitz weiter. Modus 13050 bleibt 2 (kein Moduswrite), die Kundenregister
// 13058/13059 und die Gerätegrenzen 33047/33048 werden nie geschrieben. Die manuelle Zwangsfreigabe (H-7) bleibt der
// Notausgang, auch im Not-Halt. Gilt für Master und Slave (zwei WR).
//
// Vorher (8c0f34ea): Ein nicht besessener Modus 2 galt bei Forced-Steuerung als fremd (foreignModeError) — DVhub
// schrieb nichts und ließ den unbekannten Befehl laufen. Der Slave übernahm den Besitz ohne Write, wenn sein Zustand
// innerhalb der Schreibschwelle zu DVhubs Befehl passte (M12).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSungrowEms, EMS_CMD, EMS_MODE, wire } from '../services/inverter/sungrow.js';
import { loadSungrowConfig, sungrowImage, mockSungrow, sungrowDevice } from './helpers/sungrow-fixture.js';

const MODE = wire(13050);
const CMD = wire(13051);
const POWER = wire(13052);
// Kundenregister (Max-/Min-SoC) und Gerätegrenzen: DVhub liest sie nur.
const NEVER_WRITE = new Set([wire(13058), wire(13059), wire(33047), wire(33048)]);
const ADOPTION_REGS = new Set([CMD, POWER]);

function assertNeverCustomerRegs(writes, label = '') {
  for (const w of writes) assert.ok(!NEVER_WRITE.has(w.address), `${label} verbotener Write auf ${w.address}=${w.value}`);
}
function assertOnlyAdoptionRegs(writes, label = '') {
  for (const w of writes) assert.ok(ADOPTION_REGS.has(w.address), `${label} Übernahme schreibt nur 13051/13052, nicht ${w.address}=${w.value}`);
}
const pairs = (writes) => writes.map((w) => [w.address, w.value]);

function rig({ holding = {}, controlMode = 'forced', statePath = null, mockOpts = {} } = {}) {
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', sungrow: { controlMode, heartbeatTimeoutS: 30 } });
  const image = sungrowImage({ holding });
  const t = mockSungrow(image, mockOpts);
  let clock = 1_000_000;
  const now = () => clock;
  const state = { victron: { errors: {}, fieldUpdatedAt: {}, device: sungrowDevice() }, meter: { ok: true, updatedAt: clock, grid_total_w: 0 }, ctrl: {} };
  const telemetry = ({ gridW = 0, batteryW = -500, pvW = 0, loadW = 500 } = {}) => {
    state.meter = { ok: true, updatedAt: clock, grid_total_w: gridW };
    Object.assign(state.victron, { batteryPowerW: batteryW, pvPowerW: pvW, selfConsumptionW: loadW });
    for (const f of ['batteryPowerW', 'pvPowerW', 'selfConsumptionW']) state.victron.fieldUpdatedAt[f] = clock;
  };
  telemetry();
  const logs = [];
  const ems = createSungrowEms({ state, getCfg: () => cfg, transport: t, pushLog: (event, data, level) => logs.push({ event, data, level }), now, statePath, sleep: async () => {} });
  return { cfg, image, t, state, ems, logs, telemetry, advance: (ms) => { clock += ms; } };
}

const SLAVE_HOST = '192.168.68.83';
function splitRig({ masterHolding = {}, slaveHolding = {}, masterMock = {}, slaveMock = {}, strategy = 'soc-balance' } = {}) {
  const secondInverter = { host: SLAVE_HOST, aggregateTelemetry: true, strategyCharge: strategy, strategyDischarge: strategy, maxChargeW: 5000, maxDischargeW: 5000, batteryCapacityWh: 10000 };
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', sungrow: { controlMode: 'forced', heartbeatTimeoutS: 30, secondInverter }, optimizer: { maxChargeW: 5000, maxDischargeW: 5000, batteryCapacityWh: 10000 } });
  const masterImage = sungrowImage({ holding: masterHolding });
  const slaveImage = sungrowImage({ holding: slaveHolding });
  const masterT = mockSungrow(masterImage, masterMock);
  const slaveT = mockSungrow(slaveImage, slaveMock);
  // Gemeinsames Protokoll in Draht-Reihenfolge (Slave/Master), damit die Reihenfolge prüfbar ist.
  const order = [];
  const tap = (tx, side) => ({
    type: 'modbus',
    reads: tx.reads,
    writes: tx.writes,
    mbRequest: (c) => tx.mbRequest(c),
    mbWriteSingle: async (c) => { order.push(`${side}:${c.address}=${c.value}`); return tx.mbWriteSingle(c); },
    mbWriteMultiple: async (c) => { order.push(`${side}:${c.address}=[${c.values}]`); return tx.mbWriteMultiple(c); },
  });
  const clock = 1_000_000;
  const now = () => clock;
  const state = {
    victron: { errors: {}, fieldUpdatedAt: { batteryPowerW: clock, pvPowerW: clock, selfConsumptionW: clock }, device: sungrowDevice({ bdcRatedW: 10000 }), batteryPowerW: -1000, pvPowerW: 0, selfConsumptionW: 500, soc: 50, sungrowMasterSocPct: 50 },
    meter: { ok: true, updatedAt: clock, grid_total_w: 0 },
    ctrl: {},
    sungrowSecond: { online: true, updatedAt: clock, host: SLAVE_HOST, aggregate: true, batteryPowerW: -500, pvPowerW: 0, socPct: 50, bdcRatedW: 10000 },
  };
  const logs = [];
  const pushLog = (event, data, level) => logs.push({ event, data, level });
  const slaveEms = createSungrowEms({
    state, getCfg: () => cfg, transport: tap(slaveT, 'S'), pushLog, now, sleep: async () => {},
    statusKey: 'sungrowEmsSlave', isSlave: true, connOverride: () => ({ host: SLAVE_HOST, port: 502, unitId: 1, timeoutMs: 1500 }),
  });
  const ems = createSungrowEms({ state, getCfg: () => cfg, transport: tap(masterT, 'M'), pushLog, now, sleep: async () => {}, slaveActuator: slaveEms });
  return { cfg, state, ems, slaveEms, masterT, slaveT, masterImage, slaveImage, logs, order };
}

function slaveRig({ mode = EMS_MODE.FORCED, cmd = EMS_CMD.STOP, power = 0 } = {}) {
  const image = sungrowImage({ holding: { [MODE]: mode, [CMD]: cmd, [POWER]: power } });
  const t = mockSungrow(image);
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', sungrow: { controlMode: 'forced', heartbeatTimeoutS: 30, secondInverter: { host: SLAVE_HOST } } });
  const state = { victron: { device: sungrowDevice() }, ctrl: {} };
  const logs = [];
  const ems = createSungrowEms({ state, getCfg: () => cfg, transport: t, now: () => 1_000_000, isSlave: true, pushLog: (event, data, level) => logs.push({ event, data, level }) });
  return { ems, t, image, state, logs };
}

const tmpState = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-h9-'));
  return { dir, statePath: path.join(dir, 'sungrow_ems_state.json') };
};

// --- Master, Forced-Steuerung ------------------------------------------------------------------------------------

test('H-9 Master: fremder Modus 2 ohne Besitz → Übernahme mit DVhubs eigenem Befehl, danach eigener Besitz (Merker)', async () => {
  const { dir, statePath } = tmpState();
  // Ein anderes System (oder ein verlorener Merker) hat den Master auf Modus 2, Entladen 3000 W gestellt.
  const r = rig({ statePath, holding: { [MODE]: EMS_MODE.FORCED, [CMD]: EMS_CMD.DISCHARGE, [POWER]: 3000 } });
  // P = −500 + 0,7 · (−5000 − 0) = −4000 → DVhubs Befehl: Entladen 4000 W.
  const res = await r.ems.applySetpoint(-5000, 'rule:abend');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.notEqual(res.error, 'sungrow_foreign_ems_mode');
  // Bekannter Write: Leistung und Befehl (auch der schon gleiche Befehl „Entladen"), kein Moduswrite.
  assert.deepEqual(pairs(r.t.writes), [[POWER, 4000], [CMD, EMS_CMD.DISCHARGE]]);
  assertOnlyAdoptionRegs(r.t.writes);
  assertNeverCustomerRegs(r.t.writes);
  assert.deepEqual([r.image.holding.get(MODE), r.image.holding.get(CMD), r.image.holding.get(POWER)], [EMS_MODE.FORCED, EMS_CMD.DISCHARGE, 4000]);
  // Danach eigener Besitz — auf der Platte (Außen-Wächter, ExecStopPost) und als zuletzt bestätigter Write.
  assert.equal(r.state.ctrl.sungrowEms.owns, true);
  assert.equal(r.state.ctrl.sungrowEms.ownMode, EMS_MODE.FORCED);
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).ownMode, EMS_MODE.FORCED);
  assert.deepEqual({ ...r.ems._st.lastMasterWrite, at: undefined }, { mode: EMS_MODE.FORCED, cmd: EMS_CMD.DISCHARGE, powerW: 4000, at: undefined });
  // Meldung mit dem gefundenen Zustand, keine Fremd-Meldung.
  const adopted = r.logs.filter((l) => l.event === 'sungrow_ems_forced_adopted');
  assert.equal(adopted.length, 1);
  assert.equal(adopted[0].level, 'warn');
  assert.deepEqual(adopted[0].data.found, { mode: EMS_MODE.FORCED, cmd: EMS_CMD.DISCHARGE, powerW: 3000 });
  assert.deepEqual(adopted[0].data.written, { command: 'discharge', powerW: 4000 });
  assert.equal(adopted[0].data.side, 'master');
  assert.ok(!r.logs.some((l) => l.event === 'sungrow_ems_foreign_mode'));

  // Weiterfahren als eigener Modus 2: der nächste Takt regelt normal, Modus 2 bleibt, kein 13050.
  r.t.writes.length = 0;
  r.advance(6000);
  r.telemetry({ gridW: -2000, batteryW: -4000, pvW: 0, loadW: 500 });
  const next = await r.ems.applySetpoint(-3000, 'rule:abend');
  assert.equal(next.ok, true, JSON.stringify(next));
  assert.ok(r.t.writes.length > 0, 'regelt weiter');
  assert.ok(!r.t.writes.some((w) => w.address === MODE), 'kein Moduswechsel');
  assert.equal(r.image.holding.get(MODE), EMS_MODE.FORCED);
  assert.equal(r.logs.filter((l) => l.event === 'sungrow_ems_forced_adopted').length, 1, 'nur einmal übernommen');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('H-9 Master: kein blindes Fortführen — Gerät steht schon nahe an (±50 W) oder genau auf DVhubs Befehl → trotzdem ein Write', async () => {
  // Fast gleich: ohne H-9 wäre das „unverändert" (Schreibschwelle 100 W) und der fremde Wert liefe weiter.
  const near = rig({ holding: { [MODE]: EMS_MODE.FORCED, [CMD]: EMS_CMD.DISCHARGE, [POWER]: 3950 } });
  assert.equal((await near.ems.applySetpoint(-5000, 'rule:abend')).ok, true);
  assert.deepEqual(pairs(near.t.writes), [[POWER, 4000], [CMD, EMS_CMD.DISCHARGE]]);
  assert.equal(near.image.holding.get(POWER), 4000, 'DVhubs Wert steht im Gerät, nicht der gefundene');
  assert.equal(near.state.ctrl.sungrowEms.owns, true);

  // Genau gleich: der Besitz entsteht trotzdem erst durch DVhubs eigenen Write.
  const same = rig({ holding: { [MODE]: EMS_MODE.FORCED, [CMD]: EMS_CMD.DISCHARGE, [POWER]: 4000 } });
  assert.equal((await same.ems.applySetpoint(-5000, 'rule:abend')).ok, true);
  assert.deepEqual(pairs(same.t.writes), [[POWER, 4000], [CMD, EMS_CMD.DISCHARGE]]);
  assert.equal(same.state.ctrl.sungrowEms.owns, true);

  // Befehl Stopp (Regler |p| < 50 W): nur 13051 = 0xCC, die fremde Leistung im Register ist dann ohne Wirkung.
  const stop = rig({ holding: { [MODE]: EMS_MODE.FORCED, [CMD]: EMS_CMD.STOP, [POWER]: 1234 } });
  stop.telemetry({ gridW: 0, batteryW: 0, pvW: 0, loadW: 0 });
  assert.equal((await stop.ems.applySetpoint(0, 'rule:test')).ok, true);
  assert.deepEqual(pairs(stop.t.writes), [[CMD, EMS_CMD.STOP]]);
  assert.equal(stop.state.ctrl.sungrowEms.owns, true);
  for (const r of [near, same, stop]) { assertOnlyAdoptionRegs(r.t.writes); assertNeverCustomerRegs(r.t.writes); }
});

test('H-9 Master: Merker verloren, Gerät spiegelt DVhubs letzten Write → Besitz per Write zurück (Not-Halt greift wieder)', async () => {
  const r = rig();
  await r.ems.applySetpoint(-5000, 'rule:abend'); // DVhub tritt ein: Modus 2, Entladen 4000 W
  assert.equal(r.state.ctrl.sungrowEms.owns, true);
  // Merker geht verloren (Feldfall 16.11.), das Gerät steht unverändert in DVhubs Zustand.
  r.ems._st.owns = false; r.ems._st.ownMode = null; r.ems._st.dev = null;
  r.t.writes.length = 0;
  r.advance(60_000); // regulärer Takt (gleicher Sollwert → tick statt applySetpoint)
  // P = −4000 + 0,7 · (−5000 − (−5000)) = −4000: derselbe Befehl — ohne H-9 „unverändert", kein Write, kein Besitz.
  r.telemetry({ gridW: -5000, batteryW: -4000, pvW: 0, loadW: 500 });
  const res = await r.ems.tick();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(r.t.writes.some((w) => w.address === CMD), 'Besitz per Write hergestellt');
  assertOnlyAdoptionRegs(r.t.writes);
  assert.equal(r.state.ctrl.sungrowEms.owns, true);
  assert.equal(r.logs.find((l) => l.event === 'sungrow_ems_forced_adopted')?.data.ownLastWrite, true);
  // Not-Halt nimmt den eigenen Betrieb jetzt einmal zurück.
  r.t.writes.length = 0;
  r.state.ctrl.discretionaryWritesPaused = true;
  r.state.ctrl.pausedAt = 21;
  assert.equal((await r.ems.emergencyStop()).ok, true);
  assert.deepEqual(pairs(r.t.writes), [[CMD, EMS_CMD.STOP], [MODE, EMS_MODE.SELF]]);
});

test('H-9 ein WR wie in der Laufzeit (Slave-Aktuator ohne zweiten WR): Übernahme schreibt nur am Master, nur 13052/13051', async () => {
  // schedule-eval.js legt den Slave-Aktuator immer an; ohne zweiten WR liefert connOverride null und seine Verbindung
  // fiele auf den Master zurück. Die Übernahme darf darüber nichts lesen oder schreiben.
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', sungrow: { controlMode: 'forced', heartbeatTimeoutS: 30 } });
  const image = sungrowImage({ holding: { [MODE]: EMS_MODE.FORCED, [CMD]: EMS_CMD.DISCHARGE, [POWER]: 3000 } });
  const t = mockSungrow(image);
  const clock = 1_000_000;
  const state = { victron: { errors: {}, fieldUpdatedAt: { batteryPowerW: clock, pvPowerW: clock, selfConsumptionW: clock }, device: sungrowDevice(), batteryPowerW: -500, pvPowerW: 0, selfConsumptionW: 500 }, meter: { ok: true, updatedAt: clock, grid_total_w: 0 }, ctrl: {} };
  const slaveEms = createSungrowEms({ state, getCfg: () => cfg, transport: t, now: () => clock, statusKey: 'sungrowEmsSlave', isSlave: true, connOverride: () => null, sleep: async () => {} });
  const ems = createSungrowEms({ state, getCfg: () => cfg, transport: t, now: () => clock, slaveActuator: slaveEms, sleep: async () => {} });
  const res = await ems.applySetpoint(-5000, 'rule:abend');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(pairs(t.writes), [[POWER, 4000], [CMD, EMS_CMD.DISCHARGE]]);
  assert.equal(slaveEms._st.owns, false);
});

// --- Not-Halt und H-7 --------------------------------------------------------------------------------------------

test('H-9 + Not-Halt: nach der Übernahme nimmt der Not-Halt den Modus 2 einmal zurück, danach nichts; H-7 bleibt möglich', async () => {
  const r = rig({ holding: { [MODE]: EMS_MODE.FORCED, [CMD]: EMS_CMD.DISCHARGE, [POWER]: 3000 } });
  assert.equal((await r.ems.applySetpoint(-5000, 'rule:abend')).ok, true);
  assert.equal(r.state.ctrl.sungrowEms.owns, true);
  r.t.writes.length = 0;
  r.state.ctrl.discretionaryWritesPaused = true;
  r.state.ctrl.pausedAt = 31;
  assert.equal((await r.ems.emergencyStop()).ok, true);
  assert.deepEqual(pairs(r.t.writes), [[CMD, EMS_CMD.STOP], [MODE, EMS_MODE.SELF]], 'einmal Stopp + Modus 0');
  assert.equal(r.state.ctrl.sungrowEms.owns, false);
  // Danach schreibt DVhub nichts mehr — auch nicht, wenn wieder ein Modus 2 auftaucht.
  r.image.holding.set(MODE, EMS_MODE.FORCED);
  r.image.holding.set(CMD, EMS_CMD.CHARGE);
  r.t.writes.length = 0;
  r.advance(10_000);
  await r.ems.tick();
  assert.equal((await r.ems.applySetpoint(-5000, 'rule:abend')).blocked, true);
  assert.equal((await r.ems.emergencyStop()).reason, 'already_done');
  assert.deepEqual(r.t.writes, [], 'im Not-Halt keine Übernahme');
  // H-7: die manuelle Zwangsfreigabe ist der Notausgang, auch im Not-Halt.
  const rel = await r.ems.forceRelease('manual_release');
  assert.equal(rel.ok, true, JSON.stringify(rel));
  assert.deepEqual(pairs(r.t.writes), [[CMD, EMS_CMD.STOP], [MODE, EMS_MODE.SELF]]);
  assertNeverCustomerRegs(r.t.writes);
});

test('H-9 + Not-Halt: im Not-Halt wird ein gefundener Modus 2 nicht übernommen — nur H-7 schreibt', async () => {
  const r = rig({ holding: { [MODE]: EMS_MODE.FORCED, [CMD]: EMS_CMD.DISCHARGE, [POWER]: 3000 } });
  r.state.ctrl.discretionaryWritesPaused = true;
  r.state.ctrl.pausedAt = 41;
  assert.equal((await r.ems.applySetpoint(-5000, 'rule:abend')).blocked, true);
  await r.ems.tick();
  assert.equal((await r.ems.emergencyStop()).reason, 'not_owned');
  assert.deepEqual(r.t.writes, []);
  assert.notEqual(r.state.ctrl.sungrowEms?.owns, true);
  const rel = await r.ems.forceRelease('manual_release');
  assert.equal(rel.ok, true, JSON.stringify(rel));
  assert.deepEqual(pairs(r.t.writes), [[CMD, EMS_CMD.STOP], [MODE, EMS_MODE.SELF]]);
});

test('H-9 + Not-Halt: Not-Halt beginnt während des Lesens vor der Übernahme → kein Write, kein Besitz', async () => {
  const r = rig({
    holding: { [MODE]: EMS_MODE.FORCED, [CMD]: EMS_CMD.DISCHARGE, [POWER]: 3000 },
    mockOpts: { onRead: ({ fc }) => { if (fc === 3) r.state.ctrl.discretionaryWritesPaused = true; } },
  });
  await r.ems.applySetpoint(-5000, 'rule:abend');
  assert.deepEqual(r.t.writes, []);
  assert.notEqual(r.state.ctrl.sungrowEms?.owns, true);
  r.state.ctrl.pausedAt = 51;
  assert.equal((await r.ems.emergencyStop()).reason, 'not_owned');
  assert.deepEqual(r.t.writes, []);
});

// --- Zwei WR (Master/Slave) --------------------------------------------------------------------------------------

test('H-9 zwei WR: Master und Slave in fremdem Modus 2 → beide per eigenem Write übernommen (Slave zuerst, nie 13050)', async () => {
  const r = splitRig({
    masterHolding: { [MODE]: EMS_MODE.FORCED, [CMD]: EMS_CMD.DISCHARGE, [POWER]: 3000 },
    // Der Slave folgt dem Master-Modus 2 und entlädt 2550 W — 50 W neben DVhubs Anteil (Schreibschwelle 100 W).
    slaveHolding: { [MODE]: EMS_MODE.FORCED, [CMD]: EMS_CMD.DISCHARGE, [POWER]: 2550 },
  });
  // System −1000 W, Netz 0, Soll −6000: P = −1000 + 0,7 · (−6000) = −5200 → soc-balance 50/50 → je 2600 W.
  const res = await r.ems.applySetpoint(-6000, 'rule:abend');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(r.order, [
    `S:${POWER}=2600`, `S:${CMD}=${EMS_CMD.DISCHARGE}`,
    `M:${POWER}=2600`, `M:${CMD}=${EMS_CMD.DISCHARGE}`,
  ]);
  for (const t of [r.masterT, r.slaveT]) { assertOnlyAdoptionRegs(t.writes); assertNeverCustomerRegs(t.writes); }
  assert.equal(r.slaveImage.holding.get(POWER), 2600, 'der fremde Slave-Wert läuft nicht weiter');
  assert.equal(r.state.ctrl.sungrowEms.owns, true);
  assert.equal(r.state.ctrl.sungrowEmsSlave.owns, true);
  const sides = r.logs.filter((l) => l.event === 'sungrow_ems_forced_adopted').map((l) => l.data.side).sort();
  assert.deepEqual(sides, ['master', 'slave']);

  // Not-Halt danach: beide einmal zurück, Slave vor Master.
  r.order.length = 0;
  r.state.ctrl.discretionaryWritesPaused = true;
  r.state.ctrl.pausedAt = 61;
  assert.equal((await r.ems.emergencyStop()).ok, true);
  assert.deepEqual(r.order, [`S:${CMD}=${EMS_CMD.STOP}`, `M:${CMD}=${EMS_CMD.STOP}`, `M:${MODE}=${EMS_MODE.SELF}`]);
});

// Codex 2a0f18b5 P1: Not-Halt beginnt im Split während des Lesens vor der Übernahme. Der Fehler darf nicht in die
// Split-Rücknahme (neutralizeBoth) laufen — sie schrieb 0xCC + Modus 0 auf einen Master, den DVhub nie übernommen hatte.
for (const [label, side] of [['Master', 'M'], ['Slave', 'S']]) {
  test(`H-9 zwei WR + Not-Halt beim Lesen am ${label} → kein Write an beide, kein Besitz (Codex 2a0f18b5 P1)`, async () => {
    const holding = { [MODE]: EMS_MODE.FORCED, [CMD]: EMS_CMD.DISCHARGE, [POWER]: 3000 };
    let r;
    const halt = { onRead: ({ fc, address }) => { if (fc === 3 && address === MODE) r.state.ctrl.discretionaryWritesPaused = true; } };
    r = splitRig({ masterHolding: holding, slaveHolding: holding, ...(side === 'M' ? { masterMock: halt } : { slaveMock: halt }) });
    const res = await r.ems.applySetpoint(-6000, 'rule:abend');
    assert.equal(res.ok, false);
    assert.deepEqual(r.order, [], 'nichts geschrieben');
    assert.notEqual(r.state.ctrl.sungrowEms?.owns, true);
    assert.notEqual(r.state.ctrl.sungrowEmsSlave?.owns, true);
    r.state.ctrl.pausedAt = 71;
    assert.equal((await r.ems.emergencyStop()).reason, 'not_owned');
    assert.deepEqual(r.order, [], 'auch der Not-Halt-Durchgang schreibt nichts Fremdes');
  });
}

test('H-9 zwei WR: Split-Rücknahme nach Master-Fehler schreibt nur auf einen eigenen Master (Codex 2a0f18b5 P1)', async () => {
  // Master in fremdem Modus 2, Lesen der EMS-Register scheitert dauerhaft → keine Übernahme, also auch keine Rücknahme.
  const r = splitRig({
    masterHolding: { [MODE]: EMS_MODE.FORCED, [CMD]: EMS_CMD.DISCHARGE, [POWER]: 3000 },
    masterMock: { failReadAt: MODE },
  });
  const res = await r.ems.applySetpoint(-6000, 'rule:abend');
  assert.equal(res.ok, false);
  assert.ok(!r.order.some((e) => e.startsWith('M:')), `kein Write an den fremden Master: ${r.order}`);
  assert.equal(r.masterImage.holding.get(CMD), EMS_CMD.DISCHARGE);
});

// Codex 2a0f18b5 P2: Strategie master-only — der Slave bekommt keinen Befehl, folgt aber dem Master-Modus 2. Übernimmt
// DVhub den Master, darf ein nicht besessener Slave-Befehl nicht darunter weiterlaufen.
test('H-9 zwei WR, master-only: Slave mit fremdem Befehl wird vor der Master-Übernahme auf Stopp gesetzt (Codex 2a0f18b5 P2)', async () => {
  const r = splitRig({
    strategy: 'master-only',
    masterHolding: { [MODE]: EMS_MODE.FORCED, [CMD]: EMS_CMD.DISCHARGE, [POWER]: 3000 },
    slaveHolding: { [MODE]: EMS_MODE.FORCED, [CMD]: EMS_CMD.DISCHARGE, [POWER]: 2000 },
  });
  const res = await r.ems.applySetpoint(-6000, 'rule:abend');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(r.order.slice(0, 1), [`S:${CMD}=${EMS_CMD.STOP}`], 'Slave zuerst auf Stopp');
  assert.ok(r.order.some((e) => e === `M:${CMD}=${EMS_CMD.DISCHARGE}`), 'danach Master übernommen');
  assert.equal(r.slaveImage.holding.get(CMD), EMS_CMD.STOP);
  for (const t of [r.masterT, r.slaveT]) { assertOnlyAdoptionRegs(t.writes); assertNeverCustomerRegs(t.writes); }
  assert.equal(r.state.ctrl.sungrowEms.owns, true);
  // Folgetakte: kein Hin und Her am Slave (er steht auf Stopp, der Master gehört DVhub).
  r.order.length = 0;
  for (let i = 0; i < 3; i += 1) { await r.ems.applySetpoint(-6000 - i - 1, 'rule:abend'); }
  assert.ok(!r.order.some((e) => e.startsWith('S:')), `keine weiteren Slave-Writes: ${r.order}`);
});

test('H-9 zwei WR, master-only: lässt sich der Slave nicht stoppen, übernimmt DVhub den Master nicht (Codex 2a0f18b5 P2)', async () => {
  const r = splitRig({
    strategy: 'master-only',
    masterHolding: { [MODE]: EMS_MODE.FORCED, [CMD]: EMS_CMD.DISCHARGE, [POWER]: 3000 },
    slaveHolding: { [MODE]: EMS_MODE.FORCED, [CMD]: EMS_CMD.DISCHARGE, [POWER]: 2000 },
    slaveMock: { failWriteAt: CMD },
  });
  const res = await r.ems.applySetpoint(-6000, 'rule:abend');
  assert.equal(res.ok, false);
  assert.ok(!r.order.some((e) => e.startsWith('M:')), `kein Master-Write: ${r.order}`);
  assert.notEqual(r.state.ctrl.sungrowEms.owns, true);
});

test('H-9 Slave: Zustand passt zu DVhubs Befehl (früher M12: Besitz ohne Write) → jetzt ein bekannter Write', async () => {
  // Stopp + Stopp (wie nach Freigabe/Neustart): ein Write 0xCC, dann Besitz.
  const s1 = slaveRig({ mode: EMS_MODE.FORCED, cmd: EMS_CMD.STOP, power: 0 });
  const r1 = await s1.ems.applyDirectCommand({ mode: 'forced', command: 'stop', powerW: 0, reason: 'floor' });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.notEqual(r1.unchanged, true);
  assert.deepEqual(pairs(s1.t.writes), [[CMD, EMS_CMD.STOP]]);
  assert.equal(s1.ems._st.owns, true);
  // Entladen 2550 W gefunden, DVhub will 2600 W: Leistung und Befehl werden geschrieben.
  const s2 = slaveRig({ mode: EMS_MODE.FORCED, cmd: EMS_CMD.DISCHARGE, power: 2550 });
  const r2 = await s2.ems.applyDirectCommand({ mode: 'forced', command: 'discharge', powerW: 2600, reason: 'split' });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.deepEqual(pairs(s2.t.writes), [[POWER, 2600], [CMD, EMS_CMD.DISCHARGE]]);
  assert.equal(s2.image.holding.get(POWER), 2600);
  assert.equal(s2.ems._st.owns, true);
  assert.equal(s2.logs.find((l) => l.event === 'sungrow_ems_forced_adopted')?.data.side, 'slave');
  for (const s of [s1, s2]) { assertOnlyAdoptionRegs(s.t.writes); assertNeverCustomerRegs(s.t.writes); }
  // Schon besessen: wieder die normale Schreibdrossel (kein Write im Rahmen der Schwelle).
  s2.t.writes.length = 0;
  s2.image.holding.set(POWER, 2650);
  const r3 = await s2.ems.applyDirectCommand({ mode: 'forced', command: 'discharge', powerW: 2600, reason: 'split' });
  assert.equal(r3.unchanged, true);
  assert.deepEqual(s2.t.writes, []);
});

test('H-9 Slave: fremdes VPP (Modus 4) am Slave bleibt fremd — keine Übernahme', async () => {
  const s = slaveRig({ mode: EMS_MODE.VPP, cmd: EMS_CMD.DISCHARGE, power: 3000 });
  const res = await s.ems.applyDirectCommand({ mode: 'forced', command: 'discharge', powerW: 2600 });
  assert.equal(res.foreign, true);
  assert.deepEqual(s.t.writes, []);
  assert.notEqual(s.ems._st.owns, true);
});

// --- Lese-Modus ---------------------------------------------------------------------------------------------------

test('H-9 Lese-Modus: ein vom Tor gesperrter Write beansprucht keinen Besitz (kein Merker für Wächter/ExecStopPost)', async () => {
  const prev = process.env.DVHUB_READ_ONLY;
  const prevWarn = console.warn;
  process.env.DVHUB_READ_ONLY = '1';
  console.warn = () => {};
  try {
    for (const holding of [
      { [MODE]: EMS_MODE.FORCED, [CMD]: EMS_CMD.DISCHARGE, [POWER]: 3000 }, // Übernahme eines gefundenen Modus 2
      {},                                                                     // Eintritt aus Modus 0
    ]) {
      const { dir, statePath } = tmpState();
      const r = rig({ statePath, holding });
      const res = await r.ems.applySetpoint(-5000, 'rule:abend');
      assert.equal(res.ok, false);
      assert.deepEqual(r.t.writes, [], 'nichts am Draht');
      assert.equal(r.state.ctrl.sungrowEms.owns, false, 'kein Besitz ohne Write');
      assert.equal(fs.existsSync(statePath), false, 'kein Merker auf der Platte');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    if (prev === undefined) delete process.env.DVHUB_READ_ONLY; else process.env.DVHUB_READ_ONLY = prev;
    console.warn = prevWarn;
  }
});
