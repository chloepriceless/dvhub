// Sungrow zwei WR: Master regelt nach einer Frist allein, auch wenn der nicht geführte Slave unbestätigt ist
// (Christin 21.11.2026, A7 Option b).
//
// Bis 8f0f1346 wartete der Eintritt des Masters (bzw. trat der Master zurück), solange ein nicht geführter Slave nicht
// auf Stopp bestätigt war (Slave nicht erreichbar, Rücklesung scheitert) — ohne Ende. Jetzt: Nach der Frist
// `sungrow.secondInverter.slaveUnconfirmedMasterAloneAfterMin` (Standard 30 min, 0 = sofort) tritt der Master ein bzw.
// bleibt eingetreten und regelt allein; ein alter Slave-Befehl kann dann mitlaufen. Deutliche Warnung
// `sungrow_ems_master_alone_slave_unconfirmed` beim Wechsel und alle 15 min, sichtbar in `sungrowEms.decision`.
// Nicht bei Notladung (weiter warten, kein Write), nicht im Not-Halt. Antwortet der Slave wieder, greift die Prüfung
// wie bisher und die Frist beginnt neu. Die Frist lebt nur im Speicher.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeConfigInput, getConfigDefinition } from '../config-model.js';
import { createSungrowEms, EMS_CMD, EMS_MODE, wire, sungrowMasterAloneAfterMs, endpointKeyOf } from '../services/inverter/sungrow.js';
import { loadSungrowConfig, sungrowImage, mockSungrow, sungrowDevice } from './helpers/sungrow-fixture.js';

const MODE = wire(13050);
const CMD = wire(13051);
const POWER = wire(13052);
const RUN_STATE = wire(13000);
const NEVER_WRITE = new Set([wire(13058), wire(13059), wire(33047), wire(33048)]);
const SLAVE_HOST = '192.168.68.83';
const MIN = 60_000;
const ALONE = 'sungrow_ems_master_alone_slave_unconfirmed';

function assertSafeRegs(r) {
  for (const w of r.masterT.writes) assert.ok(!NEVER_WRITE.has(w.address), `Master: verbotener Write ${w.address}=${w.value}`);
  for (const w of r.slaveT.writes) {
    assert.ok(!NEVER_WRITE.has(w.address), `Slave: verbotener Write ${w.address}=${w.value}`);
    assert.notEqual(w.address, MODE, 'Slave bekommt nie 13050');
  }
}
const masterWrites = (r) => r.order.filter((e) => e.startsWith('M:'));
const slaveWrites = (r) => r.order.filter((e) => e.startsWith('S:'));
const aloneLogs = (r) => r.logs.filter((l) => l.event === ALONE);

// Zwei WR wie in der Laufzeit (wie sungrow-nur-master-slave-altbefehl.test.js), dazu die Frist in der Einstellung.
function rig({
  controlMode = 'forced', strategy = 'master-only', strategyCharge = strategy, strategyDischarge = strategy, telemetry = true,
  masterHolding = {}, slaveHolding = {}, slaveInput = {}, slaveMock = {}, masterMock = {}, aloneAfterMin, separateMono = false, clockStart = 1_000_000,
  forcedHeartbeatPath = null,
} = {}) {
  const secondInverter = { host: SLAVE_HOST, aggregateTelemetry: true, strategyCharge, strategyDischarge, maxChargeW: 5000, maxDischargeW: 5000, batteryCapacityWh: 10000 };
  if (aloneAfterMin !== undefined) secondInverter.slaveUnconfirmedMasterAloneAfterMin = aloneAfterMin;
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', sungrow: { controlMode, heartbeatTimeoutS: 30, secondInverter }, optimizer: { maxChargeW: 5000, maxDischargeW: 5000, batteryCapacityWh: 10000 } });
  const masterImage = sungrowImage({ holding: masterHolding });
  const slaveImage = sungrowImage({ holding: slaveHolding, input: slaveInput });
  const masterT = mockSungrow(masterImage, masterMock);
  const slaveT = mockSungrow(slaveImage, slaveMock);
  const order = [];
  const ctl = { slaveWriteFail: false };
  const tap = (tx, side) => ({
    type: 'modbus',
    reads: tx.reads,
    writes: tx.writes,
    mbRequest: (c) => tx.mbRequest(c),
    mbWriteSingle: async (c) => {
      if (side === 'S' && ctl.slaveWriteFail) throw new Error('modbus timeout'); // nichts angekommen
      order.push(`${side}:${c.address}=${c.value}`);
      return tx.mbWriteSingle(c);
    },
    mbWriteMultiple: async (c) => { order.push(`${side}:${c.address}=[${c.values}]`); return tx.mbWriteMultiple(c); },
  });
  let clock = clockStart;
  const now = () => clock;
  // Monotone Uhr (Fable P3-2): ab Werk dieselbe wie die Wanduhr; separateMono = eigene, die nur advance() bewegt.
  let mono = 5_000;
  const monoNow = separateMono ? () => mono : undefined;
  const state = {
    victron: { errors: {}, fieldUpdatedAt: { batteryPowerW: clock, pvPowerW: clock, selfConsumptionW: clock }, device: sungrowDevice({ bdcRatedW: 10000 }), batteryPowerW: -1000, pvPowerW: 0, selfConsumptionW: 500, soc: 50, sungrowMasterSocPct: 50 },
    meter: { ok: true, updatedAt: clock, grid_total_w: 0 },
    ctrl: {},
    ...(telemetry ? { sungrowSecond: { online: true, updatedAt: clock, host: SLAVE_HOST, aggregate: true, batteryPowerW: 0, pvPowerW: 0, socPct: 50, bdcRatedW: 10000 } } : {}),
  };
  const logs = [];
  const pushLog = (event, data, level) => logs.push({ event, data, level, at: clock });
  const slaveEms = createSungrowEms({
    state, getCfg: () => cfg, transport: tap(slaveT, 'S'), pushLog, now, sleep: async () => {},
    statusKey: 'sungrowEmsSlave', isSlave: true, connOverride: () => ({ host: cfg.sungrow.secondInverter.host, port: 502, unitId: 1, timeoutMs: 1500 }),
    ...(monoNow ? { monoNow } : {}),
  });
  const ems = createSungrowEms({ state, getCfg: () => cfg, transport: tap(masterT, 'M'), pushLog, now, sleep: async () => {}, slaveActuator: slaveEms, forcedHeartbeatPath, ...(monoNow ? { monoNow } : {}) });
  const jumpWall = (ms) => { clock += ms; }; // nur die Wanduhr springt (NTP, Hand-Einstellung)
  const advance = (ms) => {
    clock += ms;
    mono += ms;
    for (const f of ['batteryPowerW', 'pvPowerW', 'selfConsumptionW']) state.victron.fieldUpdatedAt[f] = clock;
    state.meter.updatedAt = clock;
    if (state.sungrowSecond) state.sungrowSecond.updatedAt = clock;
  };
  const t0 = clock;
  // Je Minute ein neuer Sollwert (EOS/Regeln ändern ihn laufend) — jeder Aufruf ist ein Regeltakt.
  let sp = -6000;
  const minute = async () => { advance(MIN); sp = sp === -6000 ? -6200 : -6000; return r.ems.applySetpoint(sp, 'rule:abend'); };
  const r = { cfg, state, ems, slaveEms, masterT, slaveT, masterImage, slaveImage, logs, order, ctl, advance, jumpWall, minute, now, t0 };
  return r;
}

const OLD_DISCHARGE = { [MODE]: EMS_MODE.SELF, [CMD]: EMS_CMD.DISCHARGE, [POWER]: 2000 };
const OLD_CHARGE = { [MODE]: EMS_MODE.SELF, [CMD]: EMS_CMD.CHARGE, [POWER]: 3000 };
// Slave nicht erreichbar: jede Anfrage an ihn scheitert (Betriebszustand 13000 zuerst).
const unreachable = (flag = { down: true }) => ({ onRead: () => { if (flag.down) throw new Error('connect ECONNREFUSED'); } });

// --- Frist abgelaufen / vor Ablauf ---------------------------------------------------------------------------------

test('Frist (Standard 30 min): vorher wartet der Eintritt, danach regelt der Master allein — mit Warnung und im Status', async () => {
  const r = rig({ slaveHolding: OLD_DISCHARGE, slaveMock: unreachable() });
  const first = await r.ems.applySetpoint(-6000, 'rule:abend');
  assert.equal(first.ok, false, JSON.stringify(first));
  assert.equal(r.state.ctrl.sungrowEms.decision.reason, 'entry_slave_unconfirmed');
  assert.equal(r.state.ctrl.sungrowEms.decision.masterAloneAt, r.t0 + 30 * MIN, 'Status nennt, wann der Master allein regelt');
  for (let i = 1; i <= 29; i += 1) {
    const res = await r.minute();
    assert.equal(res.ok, false, `Minute ${i}: wartet noch (${JSON.stringify(res)})`);
  }
  assert.deepEqual(r.order, [], 'vor Ablauf kein Write');
  assert.equal(aloneLogs(r).length, 0);
  // Minute 30: Frist abgelaufen → Eintritt, der Master regelt allein.
  const res = await r.minute();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(masterWrites(r), [`M:${POWER}=5000`, `M:${CMD}=${EMS_CMD.DISCHARGE}`, `M:${MODE}=${EMS_MODE.FORCED}`]);
  assert.deepEqual(slaveWrites(r), [], 'der Slave ist nicht erreichbar — kein Write');
  assert.equal(aloneLogs(r).length, 1, 'Warnung beim Wechsel');
  const w = aloneLogs(r)[0];
  assert.equal(w.level, 'warn');
  assert.equal(w.data.since, r.t0, 'seit dem ersten Warten');
  assert.match(w.data.text, /Master regelt allein/);
  assert.match(w.data.text, /alter Befehl/);
  const d = r.state.ctrl.sungrowEms.decision;
  assert.equal(d.mode, 'forced');
  assert.equal(d.masterAlone?.reason, 'slave_unconfirmed', JSON.stringify(d));
  assert.equal(d.masterAlone.slaveUnconfirmedSince, r.t0);
  assert.equal(r.state.ctrl.sungrowEms.owns, true);
  assertSafeRegs(r);
  // Weiter allein: kein Rücktritt, Warnung erst nach 15 min wieder.
  for (let i = 1; i <= 14; i += 1) assert.equal((await r.minute()).ok, true, `allein, Minute ${i}`);
  assert.equal(aloneLogs(r).length, 1, 'innerhalb von 15 min keine zweite Warnung');
  assert.equal((await r.minute()).ok, true);
  assert.equal(aloneLogs(r).length, 2, 'nach 15 min erneut gewarnt');
  assert.equal(r.masterImage.holding.get(MODE), EMS_MODE.FORCED, 'kein Rücktritt');
  assert.ok(!r.logs.some((l) => l.event === 'sungrow_ems_slave_unconfirmed_stepback'), 'kein Rücktritt gemeldet');
  assert.ok(r.state.ctrl.sungrowEms.decision.masterAlone, 'weiter sichtbar');
  assertSafeRegs(r);
});

test('Frist einstellbar (45 min): nach 44 min wartet der Eintritt noch, nach 45 min tritt der Master allein ein', async () => {
  const r = rig({ slaveHolding: OLD_DISCHARGE, slaveMock: unreachable(), aloneAfterMin: 45 });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, false);
  for (let i = 1; i <= 44; i += 1) assert.equal((await r.minute()).ok, false, `Minute ${i}`);
  assert.deepEqual(r.order, []);
  assert.equal((await r.minute()).ok, true);
  assert.equal(r.masterImage.holding.get(MODE), EMS_MODE.FORCED);
  assert.equal(aloneLogs(r).length, 1);
});

test('Im Betrieb: Slave-Werte fallen weg, Stopp nicht möglich → Rücktritt wie bisher; nach der Frist tritt der Master allein wieder ein', async () => {
  // Eintritt bei Notladung mit führender Strategie (H-9-Ausnahme): Slave-Befehl unbekannt, nicht bestätigt.
  const r = rig({ strategy: 'soc-balance', slaveHolding: OLD_CHARGE });
  r.state.sungrowSecond.runningState = 0x4001;
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, true);
  delete r.state.sungrowSecond;  // Notladung vorbei, Werte weg
  r.ctl.slaveWriteFail = true;   // der Slave nimmt keinen Write an
  r.order.length = 0;
  const t1 = r.now() + MIN;
  const back = await r.minute();
  assert.equal(back.ok, false, JSON.stringify(back));
  assert.deepEqual(masterWrites(r), [`M:${CMD}=${EMS_CMD.STOP}`, `M:${MODE}=${EMS_MODE.SELF}`], 'erst der Rücktritt (Frist läuft)');
  assert.ok(r.logs.some((l) => l.event === 'sungrow_ems_slave_unconfirmed_stepback'));
  r.order.length = 0;
  for (let i = 1; i <= 29; i += 1) assert.equal((await r.minute()).ok, false, `Minute ${i}`);
  assert.deepEqual(r.order, [], 'während der Frist kein Write');
  const res = await r.minute();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(masterWrites(r).includes(`M:${MODE}=${EMS_MODE.FORCED}`), `wieder eingetreten: ${r.order}`);
  assert.equal(aloneLogs(r).length, 1);
  assert.equal(aloneLogs(r)[0].data.since, t1, 'Frist ab dem ersten Warten (Rücktritt)');
  // Weiter allein — kein zweiter Rücktritt, obwohl die Stopp-Versuche weiter scheitern.
  r.order.length = 0;
  for (let i = 0; i < 5; i += 1) assert.equal((await r.minute()).ok, true);
  assert.ok(!masterWrites(r).includes(`M:${MODE}=${EMS_MODE.SELF}`), `kein Rücktritt: ${r.order}`);
  assertSafeRegs(r);
});

test('External, nur Master: nach der Frist tritt der Master allein in Modus 3 ein', async () => {
  const r = rig({ controlMode: 'external', slaveHolding: OLD_DISCHARGE, slaveMock: unreachable(), aloneAfterMin: 5 });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, false);
  for (let i = 1; i <= 4; i += 1) assert.equal((await r.minute()).ok, false);
  const res = await r.minute();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(r.masterImage.holding.get(MODE), EMS_MODE.EXTERNAL);
  assert.equal(aloneLogs(r).length, 1);
  assert.equal(r.state.ctrl.sungrowEms.decision.masterAlone?.reason, 'slave_unconfirmed');
});

test('Führende Strategie (soc-balance), Slave fällt im Eintrittstakt aus → nach der Frist regelt der Master allein mit dem ganzen Anteil', async () => {
  const flag = { down: true };
  const r = rig({ strategy: 'soc-balance', slaveHolding: OLD_CHARGE, slaveMock: unreachable(flag), aloneAfterMin: 3 });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, false);
  for (let i = 1; i <= 2; i += 1) assert.equal((await r.minute()).ok, false);
  const res = await r.minute();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.slaveFellBack, true);
  assert.equal(r.masterImage.holding.get(MODE), EMS_MODE.FORCED);
  assert.equal(r.state.ctrl.sungrowEms.decision.masterAlone?.reason, 'slave_unconfirmed');
  assert.equal(aloneLogs(r).length, 1);
});

// --- Notladung -----------------------------------------------------------------------------------------------------

test('Notladung (Telemetrie): Eintritt wartet trotz Frist, kein Write; die Frist beginnt erst nach der Notladung', async () => {
  const flag = { down: false };
  const r = rig({ slaveHolding: OLD_CHARGE, slaveMock: unreachable(flag) });
  r.state.sungrowSecond.runningState = 0x4001;
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, false);
  for (let i = 1; i <= 40; i += 1) assert.equal((await r.minute()).ok, false, `Minute ${i}`);
  assert.deepEqual(r.order, [], 'in Notladung weder Slave- noch Master-Write');
  assert.equal(aloneLogs(r).length, 0, 'die Notladung zählt nicht zur Frist');
  assert.equal(r.state.ctrl.sungrowEms.decision.masterAloneAt, null, 'in Notladung kein Zeitpunkt für „allein“');
  // Notladung vorbei, Slave nicht erreichbar → jetzt beginnt die Frist.
  r.state.sungrowSecond.runningState = 0;
  flag.down = true;
  // Erster Takt danach = Minute 0 der Frist.
  for (let i = 0; i <= 29; i += 1) assert.equal((await r.minute()).ok, false, `nach Notladung, Minute ${i}`);
  assert.deepEqual(r.order, []);
  const res = await r.minute();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(aloneLogs(r).length, 1);
});

test('Kurze Notladung mitten in der Frist (unter 5 min) → die Frist beginnt danach neu, nicht ab dem ersten Warten', async () => {
  const flag = { down: true };
  const r = rig({ slaveHolding: OLD_CHARGE, slaveMock: unreachable(flag), aloneAfterMin: 10 });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, false); // Minute 0: unbestätigt
  for (let i = 1; i <= 8; i += 1) assert.equal((await r.minute()).ok, false);
  r.state.sungrowSecond.runningState = 0x4001;                              // Minuten 9–11: Notladung
  for (let i = 9; i <= 11; i += 1) assert.equal((await r.minute()).ok, false);
  r.state.sungrowSecond.runningState = 0;                                    // ab Minute 12: wieder unbestätigt
  assert.equal((await r.minute()).ok, false, 'Minute 12: neue Frist, nicht „seit Minute 0“');
  assert.deepEqual(r.order, []);
  for (let i = 13; i <= 21; i += 1) assert.equal((await r.minute()).ok, false, `Minute ${i}`);
  assert.equal((await r.minute()).ok, true, 'Minute 22 = 10 min nach dem Ende der Notladung');
  assert.equal(aloneLogs(r).length, 1);
});

test('Slave kurz unter fremdem EMS (Master allein ohne Frist), danach unbestätigt → neue Frist: erst Rücktritt', async () => {
  const flag = { down: true };
  const r = rig({ slaveHolding: OLD_CHARGE, slaveMock: unreachable(flag), aloneAfterMin: 10 });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, false);
  for (let i = 1; i <= 8; i += 1) assert.equal((await r.minute()).ok, false);
  flag.down = false;
  r.slaveImage.holding.set(MODE, EMS_MODE.VPP);                              // Minute 9: Slave unter VPP
  assert.equal((await r.minute()).ok, true, 'fremdes EMS: der Master steuert allein (bestehende Regel)');
  assert.equal(aloneLogs(r).length, 0);
  flag.down = true;                                                          // Minute 10: wieder nicht erreichbar
  r.order.length = 0;
  assert.equal((await r.minute()).ok, false);
  assert.deepEqual(masterWrites(r), [`M:${CMD}=${EMS_CMD.STOP}`, `M:${MODE}=${EMS_MODE.SELF}`], 'neue Frist: Rücktritt statt „allein seit Minute 0“');
  assert.equal(aloneLogs(r).length, 0);
});

test('Notladung am Slave gelesen (ohne Slave-Werte): Eintritt wartet trotz Frist 0', async () => {
  const r = rig({ strategy: 'soc-balance', telemetry: false, slaveHolding: OLD_CHARGE, slaveInput: { [RUN_STATE]: 0x4001 }, aloneAfterMin: 0 });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, false);
  for (let i = 1; i <= 5; i += 1) assert.equal((await r.minute()).ok, false);
  assert.deepEqual(r.order, []);
  assert.equal(aloneLogs(r).length, 0);
});

// --- Slave kommt zurück ----------------------------------------------------------------------------------------------

test('Slave antwortet wieder: alter Befehl wird gestoppt, „allein“ endet, die Frist beginnt neu (nächster Fehlschlag → wieder Rücktritt)', async () => {
  const flag = { down: true };
  const r = rig({ slaveHolding: OLD_DISCHARGE, slaveMock: unreachable(flag), aloneAfterMin: 2 });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, false);
  await r.minute();
  assert.equal((await r.minute()).ok, true, 'nach 2 min allein');
  assert.ok(r.state.ctrl.sungrowEms.decision.masterAlone);
  assert.equal(r.slaveImage.holding.get(CMD), EMS_CMD.DISCHARGE, 'der alte Befehl läuft mit');
  // Slave antwortet wieder: die Prüfung stoppt den alten Befehl nach denselben Regeln.
  flag.down = false;
  r.order.length = 0;
  assert.equal((await r.minute()).ok, true);
  assert.deepEqual(slaveWrites(r), [`S:${CMD}=${EMS_CMD.STOP}`], `Slave gestoppt: ${r.order}`);
  assert.ok(r.logs.some((l) => l.event === 'sungrow_ems_running_slave_stopped'));
  assert.equal(r.state.ctrl.sungrowEms.decision.masterAlone, undefined, '„allein“ ist vorbei');
  assert.equal(r.masterImage.holding.get(MODE), EMS_MODE.FORCED);
  // Per App kommt ein neuer Befehl, der Slave nimmt den Stopp nicht an → die Frist begann neu: erst Rücktritt.
  r.slaveImage.holding.set(CMD, EMS_CMD.CHARGE);
  r.slaveImage.holding.set(POWER, 2500);
  r.ctl.slaveWriteFail = true;
  r.order.length = 0;
  const res = await r.minute(); // Nachprüfung im Lesetakt (60 s)
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.deepEqual(masterWrites(r), [`M:${CMD}=${EMS_CMD.STOP}`, `M:${MODE}=${EMS_MODE.SELF}`], 'neue Frist: Rücktritt statt sofort allein');
  r.order.length = 0;
  await r.minute();
  assert.deepEqual(masterWrites(r), [], 'wartet in der neuen Frist');
  assert.equal((await r.minute()).ok, true, 'nach der neuen Frist wieder allein');
  assert.equal(aloneLogs(r).length, 2, 'neue Lage, neue Warnung');
  assertSafeRegs(r);
});

// --- Not-Halt --------------------------------------------------------------------------------------------------------

test('Not-Halt während der Frist → nichts, auch nach ihrem Ablauf; danach beginnt die Frist neu', async () => {
  const r = rig({ slaveHolding: OLD_DISCHARGE, slaveMock: unreachable(), aloneAfterMin: 10 });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, false);
  for (let i = 1; i <= 5; i += 1) await r.minute();
  r.state.ctrl.discretionaryWritesPaused = true;
  r.state.ctrl.pausedAt = 4711;
  assert.equal((await r.ems.emergencyStop()).reason, 'not_owned');
  for (let i = 1; i <= 20; i += 1) {
    const res = await r.minute();
    assert.equal(res.blocked, true, `Not-Halt, Minute ${i}: ${JSON.stringify(res)}`);
    await r.ems.tick();
  }
  assert.deepEqual(r.order, [], 'im Not-Halt kein Write');
  assert.equal(aloneLogs(r).length, 0);
  // Not-Halt vorbei: die Frist beginnt neu (nicht sofort allein).
  r.state.ctrl.discretionaryWritesPaused = false;
  for (let i = 0; i <= 9; i += 1) assert.equal((await r.minute()).ok, false, `neue Frist, Minute ${i}`);
  assert.deepEqual(r.order, []);
  assert.equal((await r.minute()).ok, true);
  assert.equal(aloneLogs(r).length, 1);
});

test('Not-Halt im Alleinbetrieb → einmalige Rücknahme, danach nichts; nach dem Not-Halt beginnt die Frist neu', async () => {
  const r = rig({ slaveHolding: OLD_DISCHARGE, slaveMock: unreachable(), aloneAfterMin: 1 });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, false);
  assert.equal((await r.minute()).ok, true, 'allein');
  r.state.ctrl.discretionaryWritesPaused = true;
  r.state.ctrl.pausedAt = 4712;
  r.order.length = 0;
  assert.equal((await r.ems.emergencyStop()).ok, true);
  assert.deepEqual(masterWrites(r), [`M:${CMD}=${EMS_CMD.STOP}`, `M:${MODE}=${EMS_MODE.SELF}`], 'genau eine Rücknahme');
  r.order.length = 0;
  // Kurzer Not-Halt (2 min, unter der 5-min-Lücke einer Episode): die Frist beginnt trotzdem neu.
  for (let i = 1; i <= 2; i += 1) { assert.equal((await r.minute()).blocked, true); await r.ems.tick(); }
  assert.deepEqual(r.order, [], 'danach nichts');
  r.state.ctrl.discretionaryWritesPaused = false;
  assert.equal((await r.minute()).ok, false, 'nach dem Not-Halt: neue Frist, erst warten');
  assert.deepEqual(r.order, []);
  assert.equal((await r.minute()).ok, true, 'nach der neuen Frist allein');
});

// --- Frist 0 ---------------------------------------------------------------------------------------------------------

test('Frist 0 = sofort: Eintritt ohne Warten, Warnung beim Wechsel; im Betrieb kein Rücktritt', async () => {
  const r = rig({ slaveHolding: OLD_DISCHARGE, slaveMock: unreachable(), aloneAfterMin: 0 });
  const res = await r.ems.applySetpoint(-6000, 'rule:abend');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(masterWrites(r).includes(`M:${MODE}=${EMS_MODE.FORCED}`));
  assert.equal(aloneLogs(r).length, 1);
  assert.ok(!r.logs.some((l) => l.event === 'sungrow_ems_entry_deferred'), 'kein Warten');
  assert.equal(r.state.ctrl.sungrowEms.decision.masterAlone?.reason, 'slave_unconfirmed');
});

test('Frist 0 im Betrieb: Slave-Werte fallen weg, Stopp scheitert → kein Rücktritt, der Master regelt allein', async () => {
  const r = rig({ strategy: 'soc-balance', slaveHolding: OLD_CHARGE, aloneAfterMin: 0 });
  r.state.sungrowSecond.runningState = 0x4001;
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, true);
  delete r.state.sungrowSecond;
  r.ctl.slaveWriteFail = true;
  r.order.length = 0;
  assert.equal((await r.minute()).ok, true);
  assert.ok(!masterWrites(r).includes(`M:${MODE}=${EMS_MODE.SELF}`), `kein Rücktritt: ${r.order}`);
  assert.equal(r.masterImage.holding.get(MODE), EMS_MODE.FORCED);
  assert.equal(aloneLogs(r).length, 1);
  assert.ok(!r.logs.some((l) => l.event === 'sungrow_ems_slave_unconfirmed_stepback'));
});

test('Im Alleinbetrieb wird der nicht erreichbare Slave nur im Lesetakt (60 s) erneut versucht, nicht im Profiltakt', async () => {
  const r = rig({ slaveHolding: OLD_DISCHARGE, slaveMock: unreachable(), aloneAfterMin: 0 });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, true);
  const tries = () => r.slaveT.reads.length;
  const before = tries();
  for (let i = 0; i < 4; i += 1) { r.advance(12_000); assert.equal((await r.ems.applySetpoint(-6000 - (i % 2) * 400, 'rule:abend')).ok, true); }
  assert.equal(tries(), before, 'binnen 48 s kein neuer Versuch am Slave (der Master regelt)');
  r.advance(13_000);
  assert.equal((await r.ems.applySetpoint(-6100, 'rule:abend')).ok, true);
  assert.ok(tries() > before, 'nach 60 s ein neuer Versuch');
});

// --- Einstellung -----------------------------------------------------------------------------------------------------

test('Einstellung: Feld mit Standard 30, Grenzen 0–1440, Hilfetext; Auflösung mit Standard und Grenzen', () => {
  const f = getConfigDefinition().fields.find((x) => x.path === 'sungrow.secondInverter.slaveUnconfirmedMasterAloneAfterMin');
  assert.ok(f, 'Feld fehlt');
  assert.equal(f.type, 'number');
  assert.equal(f.default, 30);
  assert.equal(f.min, 0);
  assert.equal(f.max, 1440);
  assert.equal(f.group, 'sungrowEms');
  assert.deepEqual(f.visibleWhenPath, { path: 'manufacturer', equals: 'sungrow' });
  assert.match(f.help, /0 = sofort/);
  assert.match(f.help, /alter Befehl/);
  assert.match(f.help, /Notladung/);
  // Auflösung (Millisekunden).
  const ms = (v) => sungrowMasterAloneAfterMs(v === undefined ? { sungrow: { secondInverter: {} } } : { sungrow: { secondInverter: { slaveUnconfirmedMasterAloneAfterMin: v } } });
  assert.equal(ms(undefined), 30 * MIN, 'Standard 30 min');
  assert.equal(sungrowMasterAloneAfterMs({}), 30 * MIN);
  assert.equal(ms(0), 0, '0 = sofort');
  assert.equal(ms(45), 45 * MIN);
  assert.equal(ms('15'), 15 * MIN);
  assert.equal(ms(1440), 1440 * MIN);
  assert.equal(ms(5000), 1440 * MIN, 'nach oben begrenzt');
  assert.equal(ms(-1), 30 * MIN, 'negativ → Standard');
  assert.equal(ms(''), 30 * MIN, 'leer → Standard, nicht 0');
  assert.equal(ms(null), 30 * MIN);
  assert.equal(ms('abc'), 30 * MIN);
  assert.equal(ms(true), 30 * MIN);
  // Gespeicherte Einstellung außerhalb der Grenzen wird verworfen (Standard), mit Warnung.
  for (const bad of [-5, 1441]) {
    const { persistedConfig, warnings } = normalizeConfigInput({ manufacturer: 'sungrow', sungrow: { secondInverter: { host: SLAVE_HOST, slaveUnconfirmedMasterAloneAfterMin: bad } } });
    assert.equal(persistedConfig.sungrow.secondInverter.slaveUnconfirmedMasterAloneAfterMin, undefined, `${bad} verworfen`);
    assert.ok(warnings.some((w) => /slaveUnconfirmedMasterAloneAfterMin: out of range/.test(w)), `Warnung für ${bad}`);
  }
  const ok = normalizeConfigInput({ manufacturer: 'sungrow', sungrow: { secondInverter: { host: SLAVE_HOST, slaveUnconfirmedMasterAloneAfterMin: '0' } } });
  assert.equal(ok.persistedConfig.sungrow.secondInverter.slaveUnconfirmedMasterAloneAfterMin, 0, '0 bleibt 0');
});

// --- Schutz: unverändert ----------------------------------------------------------------------------------------------

test('Schutz: fremdes EMS am Slave bleibt „Master allein“ ohne Frist-Warnung; bestätigter Slave ohne Warnung', async () => {
  const r = rig({ slaveHolding: { [MODE]: EMS_MODE.VPP, [CMD]: EMS_CMD.DISCHARGE, [POWER]: 2000 } });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, true);
  for (let i = 0; i < 3; i += 1) assert.equal((await r.minute()).ok, true);
  assert.equal(aloneLogs(r).length, 0, 'fremdes EMS: eigene Meldung, keine Frist');
  assert.equal(r.state.ctrl.sungrowEms.decision.masterAlone, undefined);
  const q = rig();
  assert.equal((await q.ems.applySetpoint(-6000, 'rule:abend')).ok, true);
  assert.equal(aloneLogs(q).length, 0);
  assert.equal(q.state.ctrl.sungrowEms.decision.masterAlone, undefined);
});

test('Schutz: die Frist lebt nur im Speicher — ein frischer Aktuator beginnt neu', async () => {
  const r = rig({ slaveHolding: OLD_DISCHARGE, slaveMock: unreachable(), aloneAfterMin: 2 });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, false);
  await r.minute();
  // „Neustart“: neuer Master-Aktuator auf demselben Zustand, Slave weiter nicht erreichbar.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-sg-frist-'));
  const fresh = createSungrowEms({ state: r.state, getCfg: () => r.cfg, transport: { ...r.masterT, type: 'modbus' }, pushLog: () => {}, now: r.now, sleep: async () => {}, slaveActuator: r.slaveEms, statePath: path.join(dir, 'sungrow_ems_state.json') });
  r.advance(MIN);
  const res = await fresh.applySetpoint(-6000, 'rule:abend');
  assert.equal(res.ok, false, 'nach dem Neustart beginnt die Frist neu');
  assert.equal(r.masterImage.holding.get(MODE), EMS_MODE.SELF);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- Fable-Prüfung 5c39c85d (P3) -------------------------------------------------------------------------------------

const modeWrites = (r, value) => r.order.filter((e) => e === `M:${MODE}=${value}`).length;

test('P3-1: im Alleinbetrieb kein Rücktritt nach Ende einer Notladung — flackernde Notladung kostet keine 13050-Writes', async () => {
  const r = rig({ slaveHolding: OLD_CHARGE, slaveMock: unreachable(), aloneAfterMin: 1 });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, false);
  assert.equal((await r.minute()).ok, true, 'allein');
  assert.equal(modeWrites(r, EMS_MODE.FORCED), 1);
  // 60 min lang Notladung im Minutentakt an/aus, der Slave bleibt unbestätigt (nicht erreichbar).
  for (let i = 0; i < 60; i += 1) {
    r.state.sungrowSecond.runningState = i % 2 === 0 ? 0x4001 : 0;
    assert.equal((await r.minute()).ok, true, `Minute ${i}`);
    // Review 0abbb847 P3: auch in den Notladungs-Minuten im Status sichtbar.
    assert.equal(r.state.ctrl.sungrowEms.decision.masterAlone?.reason, 'slave_unconfirmed', `Status Minute ${i}`);
  }
  assert.equal(modeWrites(r, EMS_MODE.SELF), 0, `kein Rücktritt: ${r.order}`);
  assert.equal(modeWrites(r, EMS_MODE.FORCED), 1, 'kein erneuter Eintritt');
  assert.ok(!r.logs.some((l) => l.event === 'sungrow_ems_slave_unconfirmed_stepback'));
  assert.equal(r.state.ctrl.sungrowEms.decision.masterAlone?.reason, 'slave_unconfirmed', 'weiter allein');
  assert.equal(r.state.ctrl.sungrowEms.decision.masterAlone.slaveUnconfirmedSince, r.t0, 'dieselbe Lage seit dem ersten Warten');
});

test('P3-1: im Alleinbetrieb kein Rücktritt nach einer Prüfpause > 5 min (Master-Lesefehler)', async () => {
  const flag = { masterDown: false };
  const r = rig({ telemetry: false, slaveHolding: OLD_CHARGE, slaveMock: unreachable(), aloneAfterMin: 1,
    masterMock: { onRead: ({ fc, address }) => { if (flag.masterDown && fc === 3 && address === MODE) throw new Error('modbus exception 4'); } } });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, false);
  assert.equal((await r.minute()).ok, true, 'allein');
  flag.masterDown = true;
  for (let i = 0; i < 7; i += 1) assert.equal((await r.minute()).ok, false, `Master nicht lesbar, Minute ${i}`);
  flag.masterDown = false;
  r.order.length = 0;
  assert.equal((await r.minute()).ok, true, 'nach der Pause weiter allein');
  assert.equal(modeWrites(r, EMS_MODE.SELF), 0, `kein Rücktritt: ${r.order}`);
  assert.equal(r.masterImage.holding.get(MODE), EMS_MODE.FORCED);
  assert.equal(r.state.ctrl.sungrowEms.decision.masterAlone?.reason, 'slave_unconfirmed');
});

test('P3-1: Alleinbetrieb, Master fällt danach in Modus 0 (Ziel abgelaufen) → nächster Eintritt sofort allein, ohne neue Frist', async () => {
  const r = rig({ slaveHolding: OLD_DISCHARGE, slaveMock: unreachable(), aloneAfterMin: 10 });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, false);
  for (let i = 1; i <= 10; i += 1) await r.minute();
  assert.equal(r.masterImage.holding.get(MODE), EMS_MODE.FORCED, 'nach 10 min allein');
  r.advance(130_000);
  await r.ems.tick();
  assert.equal(r.masterImage.holding.get(MODE), EMS_MODE.SELF, 'ohne Sollwert zurück in Modus 0');
  r.advance(20 * MIN); // lange Pause ohne Prüfung, der Slave bleibt unbestätigt
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, true, 'Eintritt sofort allein');
  assert.equal(r.masterImage.holding.get(MODE), EMS_MODE.FORCED);
});

test('P3-4: Wartephase — Lücke > 5 min ohne Prüfung beginnt die Frist neu', async () => {
  const r = rig({ slaveHolding: OLD_DISCHARGE, slaveMock: unreachable(), aloneAfterMin: 10 });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, false);
  for (let i = 1; i <= 8; i += 1) await r.minute();
  r.advance(6 * MIN); // keine Prüfung (kein Takt)
  const t1 = r.now() + MIN;
  assert.equal((await r.minute()).ok, false, 'neue Frist');
  assert.equal(r.state.ctrl.sungrowEms.decision.masterAloneAt, t1 + 10 * MIN);
  for (let i = 1; i <= 9; i += 1) assert.equal((await r.minute()).ok, false, `neue Frist, Minute ${i}`);
  assert.deepEqual(r.order, []);
  assert.equal((await r.minute()).ok, true);
});

test('P3-4: Wechsel der Slave-Verbindung beginnt die Frist neu', async () => {
  const r = rig({ slaveHolding: OLD_DISCHARGE, slaveMock: unreachable(), aloneAfterMin: 10 });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, false);
  for (let i = 1; i <= 8; i += 1) await r.minute();
  r.cfg.sungrow.secondInverter.host = '192.168.68.99'; // anderer Slave, ebenfalls nicht erreichbar
  if (r.state.sungrowSecond) r.state.sungrowSecond.host = '192.168.68.99';
  for (let i = 9; i <= 18; i += 1) assert.equal((await r.minute()).ok, false, `Minute ${i}: neue Frist ab Minute 9`);
  assert.deepEqual(r.order, []);
  assert.equal((await r.minute()).ok, true, 'Minute 19 = 10 min nach dem Wechsel');
});

test('P3-4: Wechsel der Master-Verbindung beginnt die Frist neu', async () => {
  const r = rig({ slaveHolding: OLD_DISCHARGE, slaveMock: unreachable(), aloneAfterMin: 10 });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, false);
  for (let i = 1; i <= 8; i += 1) await r.minute();
  r.cfg.victron.host = '192.0.2.51';
  r.state.victron.device.endpointKey = endpointKeyOf(r.cfg.victron); // der Poller hat das Gerät neu erkannt
  for (let i = 9; i <= 18; i += 1) assert.equal((await r.minute()).ok, false, `Minute ${i}: neue Frist ab Minute 9`);
  assert.deepEqual(r.order, []);
  assert.equal((await r.minute()).ok, true, 'Minute 19 = 10 min nach dem Wechsel');
});

// A12 (Christin 21.11.2026, a): die Frist gilt auch für die H-9-Übernahme (gefundener Modus 2, Slave unbestätigt).
const FOUND_MODE2 = { [MODE]: EMS_MODE.FORCED, [CMD]: EMS_CMD.DISCHARGE, [POWER]: 3000 };
const adoptedLogs = (r) => r.logs.filter((l) => l.event === 'sungrow_ems_forced_adopted');

test('A12: H-9-Übernahme mit Frist 0 → der Master wird sofort allein übernommen (eigener Befehl), Warnung und Status', async () => {
  const r = rig({ masterHolding: FOUND_MODE2, slaveHolding: OLD_CHARGE, slaveMock: unreachable(), aloneAfterMin: 0 });
  const res = await r.ems.applySetpoint(-6000, 'rule:abend');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(masterWrites(r), [`M:${POWER}=5000`, `M:${CMD}=${EMS_CMD.DISCHARGE}`], 'Übernahme per eigenem Write, kein Moduswechsel');
  assert.equal(adoptedLogs(r).length, 1);
  assert.equal(aloneLogs(r).length, 1);
  assert.equal(aloneLogs(r)[0].data.kind, 'adopt');
  assert.equal(r.state.ctrl.sungrowEms.owns, true);
  assert.equal(r.state.ctrl.sungrowEms.decision.masterAlone?.reason, 'slave_unconfirmed');
  assertSafeRegs(r);
});

test('A12: H-9-Übernahme wartet bis zur Frist (10 min), danach allein; im Betrieb kein Rücktritt', async () => {
  const r = rig({ masterHolding: FOUND_MODE2, slaveHolding: OLD_CHARGE, slaveMock: unreachable(), aloneAfterMin: 10 });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, false);
  for (let i = 1; i <= 9; i += 1) assert.equal((await r.minute()).ok, false, `Minute ${i}: Übernahme wartet`);
  assert.deepEqual(masterWrites(r), [], 'vor Ablauf keine Übernahme');
  assert.equal((await r.minute()).ok, true, 'Minute 10: Übernahme allein');
  assert.equal(adoptedLogs(r).length, 1);
  assert.equal(aloneLogs(r).length, 1);
  r.order.length = 0;
  for (let i = 0; i < 5; i += 1) assert.equal((await r.minute()).ok, true);
  assert.equal(modeWrites(r, EMS_MODE.SELF), 0, `kein Rücktritt: ${r.order}`);
  assert.equal(r.masterImage.holding.get(MODE), EMS_MODE.FORCED);
});

test('A12: H-9-Übernahme ohne Slave-Werte (Einzelpfad) mit Frist 0 → allein übernommen', async () => {
  const r = rig({ telemetry: false, masterHolding: FOUND_MODE2, slaveHolding: OLD_CHARGE, slaveMock: unreachable(), aloneAfterMin: 0 });
  const res = await r.ems.applySetpoint(-6000, 'rule:abend');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(adoptedLogs(r).length, 1);
  assert.equal(aloneLogs(r).length, 1);
  assert.equal(r.state.ctrl.sungrowEms.decision.masterAlone?.reason, 'slave_unconfirmed');
});

test('A12: H-9-Übernahme bei Slave in Notladung → wartet trotz Frist 0, kein Write', async () => {
  const r = rig({ masterHolding: FOUND_MODE2, slaveHolding: OLD_CHARGE, aloneAfterMin: 0 });
  r.state.sungrowSecond.runningState = 0x4001;
  for (let i = 0; i < 5; i += 1) {
    const res = i === 0 ? await r.ems.applySetpoint(-6000, 'rule:abend') : await r.minute();
    assert.equal(res.ok, false, `Takt ${i}`);
  }
  assert.deepEqual(r.order, []);
  assert.equal(aloneLogs(r).length, 0);
  assert.equal(adoptedLogs(r).length, 0);
});

test('A12: Not-Halt während der Übernahme-Frist → nichts; danach beginnt die Frist neu', async () => {
  const r = rig({ masterHolding: FOUND_MODE2, slaveHolding: OLD_CHARGE, slaveMock: unreachable(), aloneAfterMin: 2 });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, false);
  await r.minute();
  r.state.ctrl.discretionaryWritesPaused = true;
  r.state.ctrl.pausedAt = 4713;
  assert.equal((await r.ems.emergencyStop()).reason, 'not_owned', 'nicht übernommener Modus 2 wird nicht angefasst');
  for (let i = 0; i < 2; i += 1) { assert.equal((await r.minute()).blocked, true); await r.ems.tick(); }
  assert.deepEqual(r.order, []);
  r.state.ctrl.discretionaryWritesPaused = false;
  assert.equal((await r.minute()).ok, false, 'neue Frist');
  assert.equal((await r.minute()).ok, false);
  assert.deepEqual(r.order, []);
  assert.equal((await r.minute()).ok, true, 'nach 2 min allein übernommen');
  assert.equal(adoptedLogs(r).length, 1);
});

test('A12: nach der Übernahme allein — der Slave antwortet wieder → alter Befehl gestoppt, „allein“ endet', async () => {
  const flag = { down: true };
  const r = rig({ masterHolding: FOUND_MODE2, slaveHolding: OLD_CHARGE, slaveMock: unreachable(flag), aloneAfterMin: 0 });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, true);
  flag.down = false;
  r.order.length = 0;
  assert.equal((await r.minute()).ok, true);
  assert.deepEqual(slaveWrites(r), [`S:${CMD}=${EMS_CMD.STOP}`]);
  assert.equal(r.state.ctrl.sungrowEms.decision.masterAlone, undefined);
  assert.equal(r.masterImage.holding.get(MODE), EMS_MODE.FORCED);
});

test('P3-4: „allein“ endet, wenn DVhub den Slave wieder führt — danach gilt eine neue Frist (erst Rücktritt)', async () => {
  const flag = { down: true };
  const r = rig({ slaveHolding: {}, slaveMock: unreachable(flag), aloneAfterMin: 1 });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, false);
  assert.equal((await r.minute()).ok, true, 'allein');
  // Slave antwortet, die Strategie führt ihn wieder.
  flag.down = false;
  r.cfg.sungrow.secondInverter.strategyCharge = 'soc-balance';
  r.cfg.sungrow.secondInverter.strategyDischarge = 'soc-balance';
  assert.equal((await r.minute()).ok, true);
  assert.equal(r.state.ctrl.sungrowEmsSlave.owns, true, 'geführt');
  // Ein fremdes EMS übernimmt den Slave (Besitz ohne Stopp abgegeben), danach ist er nicht mehr erreichbar.
  r.slaveImage.holding.set(MODE, EMS_MODE.VPP);
  assert.equal((await r.minute()).ok, true);
  assert.equal(r.state.ctrl.sungrowEmsSlave.owns, false);
  flag.down = true;
  r.order.length = 0;
  assert.equal((await r.minute()).ok, false, 'neue Frist');
  assert.equal(modeWrites(r, EMS_MODE.SELF), 1, `Rücktritt statt „allein“ aus der alten Lage: ${r.order}`);
});

test('P3-4: „allein“ endet bei besessenem Slave — der nächste Eintritt wartet die Frist neu ab', async () => {
  const r = rig({ strategy: 'soc-balance', slaveHolding: {}, aloneAfterMin: 1 });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, true);
  assert.equal(r.state.ctrl.sungrowEmsSlave.owns, true, 'Slave mit DVhubs Befehl');
  // Master fällt selbst in Modus 0, die Slave-Werte fehlen, der Slave nimmt keinen Write an.
  r.masterImage.holding.set(MODE, EMS_MODE.SELF);
  delete r.state.sungrowSecond;
  r.ctl.slaveWriteFail = true;
  r.advance(61_000);
  assert.equal((await r.ems.applySetpoint(-6100, 'rule:abend')).ok, false, 'Rücknahme scheitert → wartet');
  assert.equal((await r.minute()).ok, true, 'nach 1 min allein eingetreten');
  assert.equal(r.masterImage.holding.get(MODE), EMS_MODE.FORCED);
  assert.equal(r.state.ctrl.sungrowEmsSlave.owns, true, 'Slave weiter besessen');
  assert.equal((await r.minute()).ok, true, 'Betrieb: besessener Slave → „allein“ endet');
  // Master fällt wieder selbst in Modus 0 → neue Frist, nicht sofort allein.
  r.masterImage.holding.set(MODE, EMS_MODE.SELF);
  r.order.length = 0;
  r.advance(61_000);
  assert.equal((await r.ems.applySetpoint(-6200, 'rule:abend')).ok, false, 'neue Frist');
  assert.equal(modeWrites(r, EMS_MODE.FORCED), 0, `kein sofortiger Eintritt: ${r.order}`);
});

test('P3-4: „allein“ endet bei frisch bestätigtem Slave-Stopp — danach gilt eine neue Frist', async () => {
  const r = rig({ slaveHolding: OLD_DISCHARGE, slaveMock: unreachable(), aloneAfterMin: 1 });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, false);
  assert.equal((await r.minute()).ok, true, 'allein');
  // Der Stopp wird auf anderem Weg bestätigt (etwa eine Rücknahme am Slave).
  r.slaveEms._st.stopConfirmed = true;
  r.slaveEms._st.stopConfirmedAt = r.now();
  assert.equal((await r.minute()).ok, true);
  assert.equal(r.state.ctrl.sungrowEms.decision.masterAlone, undefined, '„allein“ vorbei');
  // Wieder unbekannt (neuer Befehl), Slave nicht erreichbar → neue Frist: Rücktritt.
  r.slaveEms._st.stopConfirmed = false;
  r.order.length = 0;
  assert.equal((await r.minute()).ok, false);
  assert.equal(modeWrites(r, EMS_MODE.SELF), 1, `Rücktritt: ${r.order}`);
});

test('P3-2: Frist mit monotoner Uhr — Wanduhr springt vorwärts (+2 h) → die Frist wird nicht kürzer', async () => {
  const r = rig({ slaveHolding: OLD_DISCHARGE, slaveMock: unreachable(), aloneAfterMin: 10, separateMono: true });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, false);
  for (let i = 1; i <= 3; i += 1) await r.minute();
  r.jumpWall(2 * 60 * MIN);
  for (let i = 4; i <= 9; i += 1) assert.equal((await r.minute()).ok, false, `Minute ${i}`);
  assert.deepEqual(r.order, []);
  assert.equal(r.state.ctrl.sungrowEms.decision.masterAloneAt, r.now() + MIN, 'Anzeige: noch 1 min, in Wanduhrzeit');
  assert.equal((await r.minute()).ok, true, 'Minute 10');
});

test('P3-2: Frist mit monotoner Uhr — Wanduhr springt rückwärts (−10 min) → die Frist wird nicht länger', async () => {
  const r = rig({ slaveHolding: OLD_DISCHARGE, slaveMock: unreachable(), aloneAfterMin: 10, separateMono: true });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, false);
  for (let i = 1; i <= 3; i += 1) await r.minute();
  r.jumpWall(-10 * MIN); // Wanduhr jetzt 7 min vor dem ersten Warten
  for (let i = 4; i <= 9; i += 1) assert.equal((await r.minute()).ok, false, `Minute ${i}`);
  assert.equal((await r.minute()).ok, true, 'Minute 10 (Wanduhr: erst 0 min seit dem ersten Warten)');
  assert.equal(r.masterImage.holding.get(MODE), EMS_MODE.FORCED);
});

test('Review 590b056a P3: Wanduhr springt rückwärts (−60 min) → der Slave wird trotzdem weiter geprüft und vor dem Alleinbetrieb gestoppt', async () => {
  const flag = { down: true };
  const r = rig({ slaveHolding: OLD_DISCHARGE, slaveMock: unreachable(flag), aloneAfterMin: 30, separateMono: true, clockStart: 50_000_000 });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, false);
  for (let i = 1; i <= 10; i += 1) await r.minute();
  r.jumpWall(-60 * MIN);
  await r.minute();
  flag.down = false; // Minute 12: der Slave antwortet wieder, sein alter Entladebefehl steht noch
  await r.minute();
  assert.deepEqual(slaveWrites(r), [`S:${CMD}=${EMS_CMD.STOP}`], `binnen eines Takts geprüft und gestoppt: ${r.order}`);
  assert.equal(r.slaveImage.holding.get(CMD), EMS_CMD.STOP);
  assert.ok(r.order.includes(`M:${MODE}=${EMS_MODE.FORCED}`), 'danach regulärer Eintritt');
  assert.equal(aloneLogs(r).length, 0, 'kein Alleinbetrieb');
});

test('Review 590b056a P3: Wanduhr springt rückwärts (−60 min) → die Nachprüfung eines bestätigten Slave setzt nicht aus', async () => {
  const r = rig({ slaveHolding: {}, separateMono: true, clockStart: 50_000_000 });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, true); // nur Master, Stopp bestätigt
  r.jumpWall(-60 * MIN);
  r.slaveImage.holding.set(CMD, EMS_CMD.DISCHARGE); // App setzt am Slave Entladen
  r.slaveImage.holding.set(POWER, 2000);
  r.order.length = 0;
  await r.minute(); // 60 s monoton seit der Bestätigung → Nachprüfung fällig
  await r.minute();
  assert.deepEqual(slaveWrites(r), [`S:${CMD}=${EMS_CMD.STOP}`], `Nachprüfung im Lesetakt: ${r.order}`);
  assert.ok(r.logs.some((l) => l.event === 'sungrow_ems_running_slave_stopped'));
});

test('Review 1b28e47c P3: Alleinbetrieb, Slave kurz unter fremdem EMS → Status ohne „Slave unbestätigt“; danach weiter allein ohne Rücktritt', async () => {
  const flag = { down: true };
  const r = rig({ slaveHolding: OLD_CHARGE, slaveMock: unreachable(flag), aloneAfterMin: 1 });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, false);
  assert.equal((await r.minute()).ok, true, 'allein');
  flag.down = false;
  r.slaveImage.holding.set(MODE, EMS_MODE.VPP);
  assert.equal((await r.minute()).ok, true, 'fremdes EMS: der Master steuert weiter');
  assert.equal(r.state.ctrl.sungrowEms.decision.masterAlone, undefined, 'kein veraltetes „Slave unbestätigt“ unter fremdem EMS');
  assert.ok(r.logs.some((l) => l.event === 'sungrow_ems_slave_foreign'));
  flag.down = true; // VPP weg, Slave wieder nicht erreichbar
  r.order.length = 0;
  assert.equal((await r.minute()).ok, true);
  assert.equal(modeWrites(r, EMS_MODE.SELF), 0, `kein Rücktritt: ${r.order}`);
  assert.equal(r.state.ctrl.sungrowEms.decision.masterAlone?.reason, 'slave_unconfirmed', 'wieder allein sichtbar');
});

test('Zusammenspiel Codex-P1 + Frist: External, gefundener Modus 2, Slave nicht erreichbar → erst Modus 0 (bekannte Writes), nach der Frist allein in Modus 3', async () => {
  const r = rig({ controlMode: 'external', masterHolding: { [MODE]: EMS_MODE.FORCED, [CMD]: EMS_CMD.CHARGE, [POWER]: 4000 }, slaveHolding: OLD_DISCHARGE, slaveMock: unreachable(), aloneAfterMin: 1 });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, false);
  assert.deepEqual(masterWrites(r), [`M:${CMD}=${EMS_CMD.STOP}`, `M:${MODE}=${EMS_MODE.SELF}`], 'gefundener Modus 2 verlassen');
  r.order.length = 0;
  assert.equal((await r.minute()).ok, true, 'nach 1 min allein');
  assert.ok(r.order.includes(`M:${MODE}=${EMS_MODE.EXTERNAL}`), `${r.order}`);
  assert.equal(aloneLogs(r).length, 1);
  assertSafeRegs(r);
});

test('Codex 22d327d3 P3: wartende H-9-Übernahme hat einen eigenen Wartezustand mit Zeitpunkt (Split und Einzelpfad), Warnung alle 15 min', async () => {
  for (const telemetry of [true, false]) {
    const r = rig({ telemetry, masterHolding: FOUND_MODE2, slaveHolding: OLD_CHARGE, slaveMock: unreachable(), aloneAfterMin: 30 });
    assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, false);
    const d = r.state.ctrl.sungrowEms.decision;
    assert.equal(d.mode, 'adopt_wait', `${telemetry ? 'Split' : 'Einzelpfad'}: ${JSON.stringify(d)}`);
    assert.equal(d.reason, 'adopt_slave_unconfirmed');
    assert.equal(d.masterAloneAt, r.t0 + 30 * MIN, 'Zeitpunkt der automatischen Übernahme');
    assert.equal(d.since, r.t0);
    const warns = () => r.logs.filter((l) => l.event === 'sungrow_ems_adopt_deferred');
    assert.equal(warns().length, 1);
    assert.equal(warns()[0].level, 'warn');
    assert.match(warns()[0].data.text, /Übernahme/);
    assert.ok(!r.logs.some((l) => l.event === 'sungrow_ems_split_aborted'), 'kein Split-Abbruch');
    for (let i = 1; i <= 14; i += 1) await r.minute();
    assert.equal(warns().length, 1, 'binnen 15 min keine zweite Warnung');
    await r.minute();
    assert.equal(warns().length, 2, 'nach 15 min erneut');
    assert.deepEqual(masterWrites(r), [], 'während des Wartens kein Write');
  }
});

test('Codex 0cc625c7 P1: wartende Übernahme, ein fremdes EMS übernimmt den Master (Modus 4), Slave kommt nach 10 s zurück → kein Write an den Master', async () => {
  for (const telemetry of [false, true]) {
    const flag = { down: true };
    const r = rig({ telemetry, masterHolding: FOUND_MODE2, slaveHolding: {}, slaveMock: unreachable(flag), aloneAfterMin: 30 });
    assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, false);
    assert.equal(r.state.ctrl.sungrowEms.decision.mode, 'adopt_wait');
    r.masterImage.holding.set(MODE, EMS_MODE.VPP); // fremdes EMS übernimmt
    flag.down = false;                             // Slave antwortet wieder (Stopp bestätigt)
    r.order.length = 0;
    r.advance(10_000);
    await r.ems.applySetpoint(-6100, 'rule:abend');
    assert.deepEqual(masterWrites(r), [], `${telemetry ? 'Split' : 'Einzelpfad'}: kein Write an einen fremd gesteuerten Master: ${r.order}`);
    assert.ok(r.logs.some((l) => l.event === 'sungrow_ems_foreign_mode'), 'fremder Modus erkannt');
  }
});

// --- A16 (Christin 23.11.2026, a): H-9-Übernahme bei Slave unter fremdem EMS (VPP) → sofort allein ------------------
// Vorher (6dd6f4e5): ein fremdes EMS am Slave zählte bei der Übernahme als „unbestätigt" — die Übernahme wartete
// (adopt_wait, sungrow_ems_adopt_deferred) bis zum Ablauf der Frist. Jetzt wie beim gewöhnlichen Eintritt: der Master
// wird sofort übernommen und regelt allein, der VPP-Slave wird nie geschrieben.

const VPP_SLAVE = { [MODE]: EMS_MODE.VPP, [CMD]: EMS_CMD.DISCHARGE, [POWER]: 2000 };
const foreignLogs = (r) => r.logs.filter((l) => l.event === 'sungrow_ems_slave_foreign');
const adoptDeferredLogs = (r) => r.logs.filter((l) => l.event === 'sungrow_ems_adopt_deferred');

test('A16: H-9-Übernahme, Slave unter fremdem EMS (VPP) → Master sofort allein übernommen, kein Warten, Slave nie geschrieben', async () => {
  for (const telemetry of [true, false]) {
    const where = telemetry ? 'Split' : 'Einzelpfad';
    const r = rig({ telemetry, masterHolding: FOUND_MODE2, slaveHolding: VPP_SLAVE }); // Frist Standard 30 min
    const res = await r.ems.applySetpoint(-6000, 'rule:abend');
    assert.equal(res.ok, true, `${where}: ${JSON.stringify(res)}`);
    assert.deepEqual(masterWrites(r), [`M:${POWER}=5000`, `M:${CMD}=${EMS_CMD.DISCHARGE}`], `${where}: Übernahme per eigenem Write, kein Moduswechsel`);
    assert.deepEqual(slaveWrites(r), [], `${where}: VPP-Slave wird nie geschrieben`);
    assert.equal(adoptedLogs(r).length, 1, where);
    assert.equal(adoptDeferredLogs(r).length, 0, `${where}: kein „Übernahme zurückgestellt"`);
    assert.equal(aloneLogs(r).length, 0, `${where}: keine Frist-Warnung (fremdes EMS, nicht unbestätigt)`);
    assert.equal(foreignLogs(r).length, 1, `${where}: Meldung „Slave unter fremdem EMS"`);
    const d = r.state.ctrl.sungrowEms.decision;
    assert.notEqual(d.mode, 'adopt_wait', `${where}: ${JSON.stringify(d)}`);
    assert.equal(d.masterAlone, undefined, `${where}: kein „Slave unbestätigt" im Status`);
    assert.equal(r.state.ctrl.sungrowEms.owns, true);
    // Weiter allein: kein Rücktritt, Meldung nur einmal je Lage, Slave weiter unberührt.
    r.order.length = 0;
    for (let i = 0; i < 5; i += 1) assert.equal((await r.minute()).ok, true, `${where}: Minute ${i + 1}`);
    assert.equal(modeWrites(r, EMS_MODE.SELF), 0, `${where}: kein Rücktritt: ${r.order}`);
    assert.deepEqual(slaveWrites(r), [], where);
    assert.equal(foreignLogs(r).length, 1, `${where}: einmal je Lage`);
    assert.equal(r.masterImage.holding.get(MODE), EMS_MODE.FORCED);
    assert.equal(r.slaveImage.holding.get(MODE), EMS_MODE.VPP);
    assertSafeRegs(r);
  }
});

test('A16: wartende Übernahme (Slave nicht erreichbar), Slave meldet sich unter VPP → sofort übernommen statt bis zur Frist', async () => {
  const flag = { down: true };
  const r = rig({ masterHolding: FOUND_MODE2, slaveHolding: OLD_CHARGE, slaveMock: unreachable(flag), aloneAfterMin: 30 });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, false);
  assert.equal(r.state.ctrl.sungrowEms.decision.mode, 'adopt_wait');
  for (let i = 1; i <= 4; i += 1) assert.equal((await r.minute()).ok, false, `Minute ${i}: wartet`);
  flag.down = false;
  r.slaveImage.holding.set(MODE, EMS_MODE.VPP); // Minute 5: Slave antwortet, steht unter VPP
  const res = await r.minute();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(adoptedLogs(r).length, 1);
  assert.equal(aloneLogs(r).length, 0, 'keine Frist-Warnung');
  assert.equal(foreignLogs(r).length, 1);
  assert.equal(r.state.ctrl.sungrowEms.decision.masterAlone, undefined);
  assert.notEqual(r.state.ctrl.sungrowEms.decision.mode, 'adopt_wait');
  assert.deepEqual(slaveWrites(r), []);
  assertSafeRegs(r);
});

test('A16: Not-Halt — Übernahme bei VPP-Slave schreibt nichts', async () => {
  const r = rig({ masterHolding: FOUND_MODE2, slaveHolding: VPP_SLAVE });
  r.state.ctrl.discretionaryWritesPaused = true;
  r.state.ctrl.pausedAt = 4713;
  const res = await r.ems.applySetpoint(-6000, 'rule:abend');
  assert.notEqual(res.ok, true, JSON.stringify(res));
  await r.ems.tick();
  await r.minute();
  assert.deepEqual(r.order, [], 'im Not-Halt kein Write');
  assert.equal(adoptedLogs(r).length, 0);
});

// --- A17 (Christin 23.11.2026): Gerätezustand des Masters mit monotoner Uhr ------------------------------------------
// Vorher (6dd6f4e5): der Lesetakt des Master-Gerätezustands (deviceRecheckMs, 60 s) rechnete mit der Wanduhr. Nach
// einem Rücksprung der Uhr (NTP, Hand-Einstellung) um 60 min las DVhub den Master entsprechend länger nicht neu
// (ein WR-Neustart, ein App-Eingriff blieb unbemerkt). Jetzt monoton wie die Frist.

// Der Sollwert ändert sich je Takt um 1 W: das löst einen Regeltakt aus (unabhängig vom Takt-Zeitgeber), bleibt aber
// unter der Schreibschwelle (stepW) — gelesen wird also nur, wenn der Lesetakt des Gerätezustands abgelaufen ist.
let a17Sp = -6000;
const nudge = (r) => { a17Sp = a17Sp === -6000 ? -6001 : -6000; return r.ems.applySetpoint(a17Sp, 'rule:abend'); };
const masterBlockReads = (r) => r.masterT.reads.filter((q) => q.fc === 3 && q.address === MODE && q.quantity === 3).length;

test('A17: Wanduhr springt rückwärts (−60 min) → der Master wird trotzdem nach 60 s (monoton) neu gelesen', async () => {
  for (const telemetry of [true, false]) {
    const where = telemetry ? 'Split' : 'Einzelpfad';
    const r = rig({ telemetry, slaveHolding: {}, separateMono: true, clockStart: 50_000_000 });
    assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, true, where);
    r.jumpWall(-60 * MIN);
    const n0 = masterBlockReads(r);
    r.advance(30_000);
    assert.equal((await nudge(r)).ok, true, where);
    assert.equal(masterBlockReads(r), n0, `${where}: vor Ablauf des Lesetakts aus dem Zwischenspeicher`);
    r.advance(31_000); // 61 s monoton seit dem letzten Lesen, Wanduhr 59 min davor
    assert.equal((await nudge(r)).ok, true, where);
    assert.equal(masterBlockReads(r), n0 + 1, `${where}: nach 60 s monoton neu gelesen`);
  }
});

test('A17: Wanduhr springt vorwärts (+2 h) → der Master wird nicht vorzeitig neu gelesen; Status-Zeit bleibt Wanduhr', async () => {
  const r = rig({ slaveHolding: {}, separateMono: true, clockStart: 50_000_000 });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, true);
  const n0 = masterBlockReads(r);
  const devAt = r.state.ctrl.sungrowEms.device?.at;
  assert.ok(devAt >= r.t0, `device.at in Wanduhrzeit: ${devAt}`);
  r.jumpWall(2 * 60 * MIN);
  r.advance(10_000);
  assert.equal((await nudge(r)).ok, true);
  assert.equal(masterBlockReads(r), n0, 'Sprung vorwärts löst kein vorzeitiges Lesen aus');
  assert.equal(Object.keys(r.state.ctrl.sungrowEms.device).sort().join(','), 'at,cmd,mode,powerW', 'Status-Feld unverändert');
});

// --- A21 (Christin 23.11.2026): Regeltakt und Forced-Herzschlagdatei mit monotoner Uhr ------------------------------
// Vorher (78009c3b): der Takt-Zeitgeber (due: now() - lastStepAt) und die 5-s-Drossel der Lebenszeichen-Datei für den
// Box-Watchdog rechneten mit der Wanduhr. Nach einem Rücksprung der Uhr um 60 min regelte tick() bei gleichbleibendem
// Sollwert eine Stunde lang nicht nach (kein Refresh, kein External-Herzschlag) und die Datei blieb alt; nach einem
// Sprung vorwärts kam der Takt vorzeitig. Jetzt monoton; die Zeit in der Datei (at) bleibt Wanduhr.

const WAYS = [
  { controlMode: 'forced', telemetry: true, name: 'Forced, zwei WR' },
  { controlMode: 'forced', telemetry: false, name: 'Forced, Einzelpfad' },
  { controlMode: 'external', telemetry: true, name: 'External, zwei WR' },
  { controlMode: 'external', telemetry: false, name: 'External, Einzelpfad' },
];

test('A21: Wanduhr springt rückwärts (−60 min) → der Regeltakt regelt weiter nach (alle Steuerwege)', async () => {
  for (const w of WAYS) {
    const r = rig({ controlMode: w.controlMode, telemetry: w.telemetry, slaveHolding: {}, separateMono: true, clockStart: 50_000_000 });
    assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, true, w.name);
    assert.equal(r.state.ctrl.sungrowEms.owns, true, w.name);
    r.jumpWall(-60 * MIN);
    r.advance(10_000);
    const res = await r.ems.tick();
    assert.notEqual(res.idle, true, `${w.name}: Takt nach 10 s (monoton) fällig: ${JSON.stringify(res)}`);
    r.advance(10_000);
    const res2 = await r.ems.applySetpoint(-6000, 'rule:abend'); // gleicher Sollwert → Auffrischen nur, wenn fällig
    assert.notEqual(res2.refreshed, true, `${w.name}: unveränderter Sollwert regelt nach: ${JSON.stringify(res2)}`);
  }
});

test('A21: Wanduhr springt vorwärts (+2 h) → kein vorzeitiger Takt (alle Steuerwege)', async () => {
  for (const w of WAYS) {
    const r = rig({ controlMode: w.controlMode, telemetry: w.telemetry, slaveHolding: {}, separateMono: true, clockStart: 50_000_000 });
    assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, true, w.name);
    r.jumpWall(2 * 60 * MIN);
    const res = await r.ems.tick();
    assert.equal(res.idle, true, `${w.name}: monoton 0 s seit dem letzten Takt → nicht fällig: ${JSON.stringify(res)}`);
    const res2 = await r.ems.applySetpoint(-6000, 'rule:abend');
    assert.equal(res2.refreshed, true, `${w.name}: unveränderter Sollwert ohne Takt: ${JSON.stringify(res2)}`);
  }
});

test('A21: Forced-Herzschlagdatei — Rücksprung (−60 min) frischt weiter auf, Sprung vorwärts (+2 h) nicht vorzeitig; at bleibt Wanduhr', async () => {
  for (const telemetry of [true, false]) {
    const where = telemetry ? 'zwei WR' : 'Einzelpfad';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-sg-hb-'));
    const hbPath = path.join(dir, 'sungrow_forced_heartbeat.json');
    try {
      const r = rig({ telemetry, slaveHolding: {}, separateMono: true, clockStart: 50_000_000, forcedHeartbeatPath: hbPath });
      assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, true, where);
      const hbAt = () => JSON.parse(fs.readFileSync(hbPath, 'utf8')).at;
      assert.equal(hbAt(), r.now(), `${where}: erstes Lebenszeichen in Wanduhrzeit`);
      // Rücksprung: nach 6 s (monoton) neu geschrieben, mit der aktuellen Wanduhrzeit.
      r.jumpWall(-60 * MIN);
      r.advance(6_000);
      await nudge(r); // Sollwert-Änderung → Takt unabhängig vom Takt-Zeitgeber
      assert.equal(hbAt(), r.now(), `${where}: nach Rücksprung aufgefrischt`);
      // Sprung vorwärts: 1 s (monoton) später nicht erneut (Drossel 5 s).
      const before = hbAt();
      r.jumpWall(2 * 60 * MIN);
      r.advance(1_000);
      await nudge(r);
      assert.equal(hbAt(), before, `${where}: Sprung vorwärts schreibt nicht vorzeitig`);
      r.advance(5_000);
      await nudge(r);
      assert.equal(hbAt(), r.now(), `${where}: nach 5 s (monoton) wieder aufgefrischt`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});
