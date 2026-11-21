// Sungrow zwei WR: zurückgestellter Eintritt bei External-Steuerung, wenn der Master schon in Modus 2 steht
// (Codex-Review bb03fb53..181b0157, 21.11.2026).
//
// P1: Ist External EMS eingestellt und steht der Master in einem gefundenen Modus 2 (nicht von DVhub), behandelte die
// Eintrittsprüfung den Übergang wie einen Eintritt aus Modus 0. War der nicht geführte Slave nicht bestätigt, ließ
// entryDeferred() den gefundenen Befehl des Masters weiterlaufen und meldete mode 'self' — ohne Ende (Forced hat keinen
// geräteeigenen Rückfall). Codex-Reproduktion: nicht besessener Master lädt 4000 W, der Befehl bleibt über alle
// Wiederholungen. Jetzt (A2: einen gefundenen Modus 2 bei External mit bekannten Writes verlassen): vor dem Warten
// 0xCC + Modus 0 am Master, dann warten wie bisher. Gilt mit Aufteilung und im Einzelpfad ohne Slave-Werte.
//
// P2: Nach einem bestätigten Slave-Stopp las die Nachprüfung den Slave im VPP-Modus — der Abbruch kam vor
// setStopConfirmed(false), die alte Bestätigung blieb. Danach galt das 60-s-Intervall, und ein späterer Lesefehler
// wurde ignoriert, als stünde der Slave auf Stopp. Jetzt macht eine beobachtete Fremdsteuerung die Bestätigung
// ungültig; den fremd gesteuerten Slave schreibt DVhub weiterhin nicht.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSungrowEms, EMS_CMD, EMS_MODE, wire } from '../services/inverter/sungrow.js';
import { loadSungrowConfig, sungrowImage, mockSungrow, sungrowDevice } from './helpers/sungrow-fixture.js';

const MODE = wire(13050);
const CMD = wire(13051);
const POWER = wire(13052);
const NEVER_WRITE = new Set([wire(13058), wire(13059), wire(33047), wire(33048)]);
const SLAVE_HOST = '192.168.68.83';

function assertSafeRegs(r) {
  for (const w of r.masterT.writes) assert.ok(!NEVER_WRITE.has(w.address), `Master: verbotener Write ${w.address}=${w.value}`);
  for (const w of r.slaveT.writes) {
    assert.ok(!NEVER_WRITE.has(w.address), `Slave: verbotener Write ${w.address}=${w.value}`);
    assert.notEqual(w.address, MODE, 'Slave bekommt nie 13050');
  }
}
const masterWrites = (r) => r.order.filter((e) => e.startsWith('M:'));
const slaveWrites = (r) => r.order.filter((e) => e.startsWith('S:'));

function rig({ controlMode = 'external', strategy = 'master-only', telemetry = true, masterHolding = {}, slaveHolding = {}, slaveMock = {} } = {}) {
  const secondInverter = { host: SLAVE_HOST, aggregateTelemetry: true, strategyCharge: strategy, strategyDischarge: strategy, maxChargeW: 5000, maxDischargeW: 5000, batteryCapacityWh: 10000 };
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', sungrow: { controlMode, heartbeatTimeoutS: 30, secondInverter }, optimizer: { maxChargeW: 5000, maxDischargeW: 5000, batteryCapacityWh: 10000 } });
  const masterImage = sungrowImage({ holding: masterHolding });
  const slaveImage = sungrowImage({ holding: slaveHolding });
  const masterT = mockSungrow(masterImage);
  const slaveT = mockSungrow(slaveImage, slaveMock);
  const order = [];
  const tap = (tx, side) => ({
    type: 'modbus', reads: tx.reads, writes: tx.writes,
    mbRequest: (c) => tx.mbRequest(c),
    mbWriteSingle: async (c) => { order.push(`${side}:${c.address}=${c.value}`); return tx.mbWriteSingle(c); },
    mbWriteMultiple: async (c) => { order.push(`${side}:${c.address}=[${c.values}]`); return tx.mbWriteMultiple(c); },
  });
  let clock = 1_000_000;
  const now = () => clock;
  const state = {
    victron: { errors: {}, fieldUpdatedAt: { batteryPowerW: clock, pvPowerW: clock, selfConsumptionW: clock }, device: sungrowDevice({ bdcRatedW: 10000 }), batteryPowerW: -1000, pvPowerW: 0, selfConsumptionW: 500, soc: 50, sungrowMasterSocPct: 50 },
    meter: { ok: true, updatedAt: clock, grid_total_w: 0 },
    ctrl: {},
    ...(telemetry ? { sungrowSecond: { online: true, updatedAt: clock, host: SLAVE_HOST, aggregate: true, batteryPowerW: 0, pvPowerW: 0, socPct: 50, bdcRatedW: 10000 } } : {}),
  };
  const logs = [];
  const pushLog = (event, data, level) => logs.push({ event, data, level });
  const slaveEms = createSungrowEms({
    state, getCfg: () => cfg, transport: tap(slaveT, 'S'), pushLog, now, sleep: async () => {},
    statusKey: 'sungrowEmsSlave', isSlave: true, connOverride: () => ({ host: cfg.sungrow.secondInverter.host, port: 502, unitId: 1, timeoutMs: 1500 }),
  });
  const ems = createSungrowEms({ state, getCfg: () => cfg, transport: tap(masterT, 'M'), pushLog, now, sleep: async () => {}, slaveActuator: slaveEms });
  const advance = (ms) => {
    clock += ms;
    for (const f of ['batteryPowerW', 'pvPowerW', 'selfConsumptionW']) state.victron.fieldUpdatedAt[f] = clock;
    state.meter.updatedAt = clock;
    if (state.sungrowSecond) state.sungrowSecond.updatedAt = clock;
  };
  return { cfg, state, ems, slaveEms, masterT, slaveT, masterImage, slaveImage, logs, order, advance };
}

// Gefundener Modus 2 am Master (anderes System, App, früherer Lauf): Laden mit 4000 W.
const FOUND_FORCED_CHARGE = { [MODE]: EMS_MODE.FORCED, [CMD]: EMS_CMD.CHARGE, [POWER]: 4000 };
const OLD_DISCHARGE = { [MODE]: EMS_MODE.SELF, [CMD]: EMS_CMD.DISCHARGE, [POWER]: 2000 };
const unreachable = (flag = { down: true }) => ({ onRead: () => { if (flag.down) throw new Error('connect ECONNREFUSED'); } });

// --- P1 -------------------------------------------------------------------------------------------------------------

test('P1 (Codex-Reproduktion): External, Master lädt in gefundenem Modus 2 mit 4000 W, Slave nicht erreichbar → Master vor dem Warten mit 0xCC + Modus 0 verlassen', async () => {
  const r = rig({ masterHolding: FOUND_FORCED_CHARGE, slaveHolding: OLD_DISCHARGE, slaveMock: unreachable() });
  for (let i = 0; i < 4; i += 1) {
    if (i > 0) r.advance(61_000);
    const res = await r.ems.applySetpoint(-6000 - i, 'rule:abend');
    assert.equal(res.ok, false, `Takt ${i}: ${JSON.stringify(res)}`);
  }
  assert.deepEqual(masterWrites(r), [`M:${CMD}=${EMS_CMD.STOP}`, `M:${MODE}=${EMS_MODE.SELF}`], 'genau einmal bekannte Writes Richtung Grundzustand');
  assert.equal(r.masterImage.holding.get(MODE), EMS_MODE.SELF, 'kein Modus 2 mehr');
  assert.equal(r.masterImage.holding.get(CMD), EMS_CMD.STOP, 'der gefundene Ladebefehl läuft nicht weiter');
  assert.deepEqual(slaveWrites(r), [], 'Slave nicht erreichbar — kein Write');
  const d = r.state.ctrl.sungrowEms.decision;
  assert.equal(d.mode, 'self');
  assert.equal(d.reason, 'entry_slave_unconfirmed');
  const w = r.logs.find((l) => l.event === 'sungrow_ems_slave_unconfirmed_stepback');
  assert.ok(w, 'Meldung');
  assert.equal(w.data.foundMode, EMS_MODE.FORCED);
  assert.match(w.data.text, /Modus 2/);
  assert.notEqual(r.ems._st.target, null, 'Ziel bleibt');
  assertSafeRegs(r);
});

test('P1: External ohne Slave-Werte (Einzelpfad), gefundener Modus 2, Slave nicht erreichbar → ebenso verlassen', async () => {
  const r = rig({ telemetry: false, strategy: 'soc-balance', masterHolding: FOUND_FORCED_CHARGE, slaveHolding: OLD_DISCHARGE, slaveMock: unreachable() });
  for (let i = 0; i < 3; i += 1) {
    if (i > 0) r.advance(61_000);
    assert.equal((await r.ems.applySetpoint(-6000 - i, 'rule:abend')).ok, false, `Takt ${i}`);
  }
  assert.deepEqual(masterWrites(r), [`M:${CMD}=${EMS_CMD.STOP}`, `M:${MODE}=${EMS_MODE.SELF}`]);
  assert.equal(r.masterImage.holding.get(MODE), EMS_MODE.SELF);
  assertSafeRegs(r);
});

test('P1: External, gefundener Modus 2, Slave in Notladung → Master verlassen, kein Slave-Write; nach der Notladung regulärer Eintritt', async () => {
  const r = rig({ masterHolding: FOUND_FORCED_CHARGE, slaveHolding: OLD_DISCHARGE });
  r.state.sungrowSecond.runningState = 0x4001;
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, false);
  assert.deepEqual(masterWrites(r), [`M:${CMD}=${EMS_CMD.STOP}`, `M:${MODE}=${EMS_MODE.SELF}`]);
  assert.deepEqual(slaveWrites(r), [], 'Slave in Notladung wird nie kommandiert');
  r.state.sungrowSecond.runningState = 0;
  r.order.length = 0;
  r.advance(30_000);
  const res = await r.ems.tick();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(r.order[0], `S:${CMD}=${EMS_CMD.STOP}`, `erst der Slave-Stopp: ${r.order}`);
  assert.ok(r.order.includes(`M:${MODE}=${EMS_MODE.EXTERNAL}`), `dann Modus 3: ${r.order}`);
  assertSafeRegs(r);
});

test('P1: Slave antwortet wieder → Stopp am Slave, dann regulärer External-Eintritt', async () => {
  const flag = { down: true };
  const r = rig({ masterHolding: FOUND_FORCED_CHARGE, slaveHolding: OLD_DISCHARGE, slaveMock: unreachable(flag) });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, false);
  flag.down = false;
  r.order.length = 0;
  r.advance(30_000);
  assert.equal((await r.ems.tick()).ok, true);
  assert.equal(r.order[0], `S:${CMD}=${EMS_CMD.STOP}`);
  assert.ok(r.order.includes(`M:${MODE}=${EMS_MODE.EXTERNAL}`), `${r.order}`);
  assertSafeRegs(r);
});

test('Schutz P1: Not-Halt, External, gefundener Modus 2 → nichts geschrieben (ein nicht übernommener Modus 2 bleibt unberührt)', async () => {
  const r = rig({ masterHolding: FOUND_FORCED_CHARGE, slaveHolding: OLD_DISCHARGE, slaveMock: unreachable() });
  r.state.ctrl.discretionaryWritesPaused = true;
  r.state.ctrl.pausedAt = 77;
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).blocked, true);
  await r.ems.tick();
  assert.equal((await r.ems.emergencyStop()).reason, 'not_owned');
  assert.deepEqual(r.order, []);
});

test('Schutz P1: External, Master in Modus 0, Slave nicht erreichbar → Eintritt wartet ohne Master-Write (wie bisher)', async () => {
  const r = rig({ slaveHolding: OLD_DISCHARGE, slaveMock: unreachable() });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, false);
  assert.deepEqual(r.order, []);
  assert.ok(r.logs.some((l) => l.event === 'sungrow_ems_entry_deferred'));
  assert.ok(!r.logs.some((l) => l.event === 'sungrow_ems_slave_unconfirmed_stepback'));
});

test('Schutz P1: Forced, gefundener Modus 2, Slave nicht erreichbar → H-9-Übernahme wartet, kein Master-Write (unverändert)', async () => {
  const r = rig({ controlMode: 'forced', masterHolding: FOUND_FORCED_CHARGE, slaveHolding: OLD_DISCHARGE, slaveMock: unreachable() });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, false);
  assert.deepEqual(masterWrites(r), []);
});

// --- P2 -------------------------------------------------------------------------------------------------------------

test('P2: Nachprüfung sieht den Slave unter VPP → Bestätigung ungültig, Prüfung im Profiltakt; VPP weg und Slave nicht lesbar → Rücktritt statt „zuletzt Stopp“', async () => {
  const flag = { down: false };
  const r = rig({ controlMode: 'forced', slaveHolding: {}, slaveMock: unreachable(flag) });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, true, 'nur Master, Slave auf Stopp bestätigt');
  assert.equal(r.slaveEms.stopConfirmed(), true);
  // Ein VPP übernimmt den Slave und lädt.
  r.slaveImage.holding.set(MODE, EMS_MODE.VPP);
  r.slaveImage.holding.set(CMD, EMS_CMD.CHARGE);
  r.slaveImage.holding.set(POWER, 3000);
  r.advance(61_000); // Nachprüfung fällig
  assert.equal((await r.ems.applySetpoint(-6100, 'rule:abend')).ok, true, 'fremdes EMS: der Master steuert allein');
  assert.equal(r.slaveEms.stopConfirmed(), false, 'beobachtete Fremdsteuerung macht die Bestätigung ungültig');
  assert.ok(r.logs.some((l) => l.event === 'sungrow_ems_slave_foreign'));
  assert.deepEqual(slaveWrites(r), [], 'fremd gesteuerter Slave wird nicht geschrieben');
  // Nächste Prüfung im Profiltakt (10 s), nicht erst nach 60 s.
  const reads = r.slaveT.reads.length;
  r.advance(11_000);
  assert.equal((await r.ems.applySetpoint(-6200, 'rule:abend')).ok, true);
  assert.ok(r.slaveT.reads.length > reads, 'im Profiltakt erneut geprüft');
  // Das VPP gibt ab (Ladebefehl bleibt stehen), der Slave ist nicht mehr lesbar.
  r.slaveImage.holding.set(MODE, EMS_MODE.FORCED);
  flag.down = true;
  r.order.length = 0;
  r.advance(11_000);
  const res = await r.ems.applySetpoint(-6300, 'rule:abend');
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.deepEqual(masterWrites(r), [`M:${CMD}=${EMS_CMD.STOP}`, `M:${MODE}=${EMS_MODE.SELF}`], 'Rücktritt: der unbekannte Slave-Befehl ruht in Modus 0');
  assertSafeRegs(r);
});
