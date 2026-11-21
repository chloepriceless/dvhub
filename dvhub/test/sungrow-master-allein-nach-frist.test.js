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
import { createSungrowEms, EMS_CMD, EMS_MODE, wire, sungrowMasterAloneAfterMs } from '../services/inverter/sungrow.js';
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
  masterHolding = {}, slaveHolding = {}, slaveInput = {}, slaveMock = {}, aloneAfterMin,
} = {}) {
  const secondInverter = { host: SLAVE_HOST, aggregateTelemetry: true, strategyCharge, strategyDischarge, maxChargeW: 5000, maxDischargeW: 5000, batteryCapacityWh: 10000 };
  if (aloneAfterMin !== undefined) secondInverter.slaveUnconfirmedMasterAloneAfterMin = aloneAfterMin;
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', sungrow: { controlMode, heartbeatTimeoutS: 30, secondInverter }, optimizer: { maxChargeW: 5000, maxDischargeW: 5000, batteryCapacityWh: 10000 } });
  const masterImage = sungrowImage({ holding: masterHolding });
  const slaveImage = sungrowImage({ holding: slaveHolding, input: slaveInput });
  const masterT = mockSungrow(masterImage);
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
  let clock = 1_000_000;
  const now = () => clock;
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
  });
  const ems = createSungrowEms({ state, getCfg: () => cfg, transport: tap(masterT, 'M'), pushLog, now, sleep: async () => {}, slaveActuator: slaveEms });
  const advance = (ms) => {
    clock += ms;
    for (const f of ['batteryPowerW', 'pvPowerW', 'selfConsumptionW']) state.victron.fieldUpdatedAt[f] = clock;
    state.meter.updatedAt = clock;
    if (state.sungrowSecond) state.sungrowSecond.updatedAt = clock;
  };
  const t0 = clock;
  // Je Minute ein neuer Sollwert (EOS/Regeln ändern ihn laufend) — jeder Aufruf ist ein Regeltakt.
  let sp = -6000;
  const minute = async () => { advance(MIN); sp = sp === -6000 ? -6200 : -6000; return r.ems.applySetpoint(sp, 'rule:abend'); };
  const r = { cfg, state, ems, slaveEms, masterT, slaveT, masterImage, slaveImage, logs, order, ctl, advance, minute, now, t0 };
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
