// Sungrow zwei WR: alter Slave-Befehl beim Eintritt des Masters (Christin 21.11.2026: beheben).
//
// Der Slave folgt dem Master-Modus (Feld #5) und bekommt nie einen Modus-Write. Steht der Master in Modus 0, ruht der
// Befehl im Slave (13051/13052) — er wirkt nicht. Tritt DVhub aus Modus 0 in den Steuermodus ein (13050 = 2 bzw. 3 am
// Master), wird dieser Befehl am Slave wieder wirksam. Führt DVhub den Slave in diesem Takt selbst (Aufteilung mit
// Slave-Anteil), schreibt es ihm vorher seinen eigenen Befehl — kein Problem. Führt es ihn NICHT (Strategie „nur
// Master“, Slave-Fehler, keine Slave-Werte), lief bis bb03fb53 ein alter Befehl (anderes System, App, früherer Lauf)
// unbeaufsichtigt unter DVhubs Modus weiter, während der Master den ganzen Anteil fuhr.
//
// Jetzt (Vertrag v6 A.8 I-SafePrefix „Eintritt: Leistung und Befehl vor dem Modus“, im Verbund auch die des
// Folgegeräts; VÄ-11 Kandidatenmenge; H-9 „nie einen unbekannten Gerätewert blind fortführen“): Vor dem Eintritt setzt
// DVhub einen nicht geführten Slave per bekanntem Write auf Stopp (13051 = 0xCC, zurückgelesen). Nicht bestätigt →
// kein Eintritt in diesem Takt, der Master bleibt in Modus 0 (sicherer Grundzustand), Ziel bleibt, der nächste Takt
// versucht es neu. Ein Slave in Notladung bekommt keinen Write; führt DVhub ihn danach nicht wieder, wartet der
// Eintritt (wie H-9). 13050 am Slave, 13058/13059 und 33047/33048 schreibt DVhub nie.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSungrowEms, EMS_CMD, EMS_MODE, wire } from '../services/inverter/sungrow.js';
import { loadSungrowConfig, sungrowImage, mockSungrow, sungrowDevice } from './helpers/sungrow-fixture.js';

const MODE = wire(13050);
const CMD = wire(13051);
const POWER = wire(13052);
const HB = wire(13080);
const RUN_STATE = wire(13000);
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
const slaveRunStateReads = (r) => r.slaveT.reads.filter((x) => x.fc === 4 && x.address === RUN_STATE).length;

// Zwei WR wie in der Laufzeit: Master- und Slave-Aktuator mit je eigenem Transport, Slave mit eigener Verbindung.
function rig({
  controlMode = 'forced', strategy = 'master-only', telemetry = true,
  masterHolding = {}, slaveHolding = {}, slaveInput = {}, slaveMock = {},
} = {}) {
  const secondInverter = { host: SLAVE_HOST, aggregateTelemetry: true, strategyCharge: strategy, strategyDischarge: strategy, maxChargeW: 5000, maxDischargeW: 5000, batteryCapacityWh: 10000 };
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', sungrow: { controlMode, heartbeatTimeoutS: 30, secondInverter }, optimizer: { maxChargeW: 5000, maxDischargeW: 5000, batteryCapacityWh: 10000 } });
  const masterImage = sungrowImage({ holding: masterHolding });
  const slaveImage = sungrowImage({ holding: slaveHolding, input: slaveInput });
  const masterT = mockSungrow(masterImage);
  const slaveT = mockSungrow(slaveImage, slaveMock);
  const order = [];
  const ctl = { slaveWriteFail: false, slaveFailOnce: null };
  const tap = (tx, side) => ({
    type: 'modbus',
    reads: tx.reads,
    writes: tx.writes,
    mbRequest: (c) => tx.mbRequest(c),
    mbWriteSingle: async (c) => {
      if (side === 'S' && (ctl.slaveWriteFail || (ctl.slaveFailOnce != null && c.address === ctl.slaveFailOnce))) {
        ctl.slaveFailOnce = null;
        throw new Error('modbus timeout'); // nichts angekommen
      }
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
  const pushLog = (event, data, level) => logs.push({ event, data, level });
  const slaveEms = createSungrowEms({
    state, getCfg: () => cfg, transport: tap(slaveT, 'S'), pushLog, now, sleep: async () => {},
    statusKey: 'sungrowEmsSlave', isSlave: true, connOverride: () => ({ host: SLAVE_HOST, port: 502, unitId: 1, timeoutMs: 1500 }),
  });
  const ems = createSungrowEms({ state, getCfg: () => cfg, transport: tap(masterT, 'M'), pushLog, now, sleep: async () => {}, slaveActuator: slaveEms });
  const advance = (ms) => {
    clock += ms;
    for (const f of ['batteryPowerW', 'pvPowerW', 'selfConsumptionW']) state.victron.fieldUpdatedAt[f] = clock;
    state.meter.updatedAt = clock;
    if (state.sungrowSecond) state.sungrowSecond.updatedAt = clock;
  };
  return { cfg, state, ems, slaveEms, masterT, slaveT, masterImage, slaveImage, logs, order, ctl, advance };
}

const OLD_DISCHARGE = { [MODE]: EMS_MODE.SELF, [CMD]: EMS_CMD.DISCHARGE, [POWER]: 2000 };
const OLD_CHARGE = { [MODE]: EMS_MODE.SELF, [CMD]: EMS_CMD.CHARGE, [POWER]: 3000 };

// --- Die Lücke ------------------------------------------------------------------------------------------------------

test('nur Master, Forced: Eintritt aus Modus 0 setzt einen alten Slave-Befehl vorher auf Stopp', async () => {
  const r = rig({ slaveHolding: OLD_DISCHARGE });
  // System −1000 W, Netz 0, Soll −6000: P = −1000 + 0,7 · (−6000) = −5200 → nur Master, an seine 5000 W geklemmt.
  const res = await r.ems.applySetpoint(-6000, 'rule:abend');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(r.order[0], `S:${CMD}=${EMS_CMD.STOP}`, `zuerst der Slave-Stopp: ${r.order}`);
  assert.deepEqual(slaveWrites(r), [`S:${CMD}=${EMS_CMD.STOP}`], 'am Slave nur 13051 = 0xCC');
  assert.deepEqual(masterWrites(r), [`M:${POWER}=5000`, `M:${CMD}=${EMS_CMD.DISCHARGE}`, `M:${MODE}=${EMS_MODE.FORCED}`]);
  assert.equal(r.slaveImage.holding.get(CMD), EMS_CMD.STOP, 'der alte Entladebefehl wirkt nach dem Eintritt nicht');
  assert.equal(r.masterImage.holding.get(MODE), EMS_MODE.FORCED);
  assert.equal(r.state.ctrl.sungrowEmsSlave.owns, false, 'Stopp ist der Grundzustand — kein Slave-Besitz');
  const stopped = r.logs.find((l) => l.event === 'sungrow_ems_entry_slave_stopped');
  assert.ok(stopped, 'Meldung zum gestoppten Slave-Befehl');
  assert.equal(stopped.level, 'warn');
  assert.deepEqual(stopped.data.found, { cmd: EMS_CMD.DISCHARGE, powerW: 2000 });
  assertSafeRegs(r);
  // Folgetakte im eigenen Modus 2: kein weiterer Slave-Write, keine erneute Prüfung.
  r.order.length = 0;
  const reads = slaveRunStateReads(r);
  for (let i = 0; i < 3; i += 1) { r.advance(11_000); await r.ems.applySetpoint(-6000 - i - 1, 'rule:abend'); }
  assert.deepEqual(slaveWrites(r), [], `keine weiteren Slave-Writes: ${r.order}`);
  assert.equal(slaveRunStateReads(r), reads, 'keine Slave-Prüfung ohne Eintritt');
});

test('ohne Slave-Werte (Einzelpfad, zweiter WR konfiguriert): Eintritt setzt den alten Slave-Befehl vorher auf Stopp', async () => {
  const r = rig({ strategy: 'soc-balance', telemetry: false, slaveHolding: OLD_CHARGE });
  const res = await r.ems.applySetpoint(-6000, 'rule:abend');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(r.order[0], `S:${CMD}=${EMS_CMD.STOP}`, `zuerst der Slave-Stopp: ${r.order}`);
  assert.ok(r.order.includes(`M:${MODE}=${EMS_MODE.FORCED}`), `Master eingetreten: ${r.order}`);
  assert.equal(r.slaveImage.holding.get(CMD), EMS_CMD.STOP);
  assertSafeRegs(r);
});

test('External-Steuerung, nur Master: Eintritt in Modus 3 setzt den alten Slave-Befehl vorher auf Stopp', async () => {
  const r = rig({ controlMode: 'external', slaveHolding: OLD_DISCHARGE });
  const res = await r.ems.applySetpoint(-6000, 'rule:abend');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(r.order[0], `S:${CMD}=${EMS_CMD.STOP}`, `zuerst der Slave-Stopp: ${r.order}`);
  assert.ok(r.order.includes(`M:${MODE}=${EMS_MODE.EXTERNAL}`), `Master in Modus 3: ${r.order}`);
  assert.ok(r.order.some((e) => e.startsWith(`M:${HB}=`)), 'Herzschlag am Master wie bisher');
  assert.equal(r.slaveImage.holding.get(CMD), EMS_CMD.STOP);
  assertSafeRegs(r);
});

test('nur Master, Wiedereintritt (Master fiel selbst auf Modus 0, Slave bekam per App einen Befehl) → Slave zuerst auf Stopp', async () => {
  const r = rig();
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, true);
  assert.equal(r.state.ctrl.sungrowEms.owns, true);
  // Master fällt von selbst in Modus 0 zurück (WR-Neustart), am Slave steht ein Befehl aus der App.
  r.masterImage.holding.set(MODE, EMS_MODE.SELF);
  r.slaveImage.holding.set(CMD, EMS_CMD.CHARGE);
  r.slaveImage.holding.set(POWER, 2500);
  r.order.length = 0;
  r.advance(61_000); // Gerätezustand des Masters wird neu gelesen
  const res = await r.ems.applySetpoint(-6100, 'rule:abend');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(r.order[0], `S:${CMD}=${EMS_CMD.STOP}`, `zuerst der Slave-Stopp: ${r.order}`);
  assert.ok(r.order.includes(`M:${MODE}=${EMS_MODE.FORCED}`), `Master wieder in Modus 2: ${r.order}`);
  assert.ok(r.logs.some((l) => l.event === 'sungrow_ems_reentry'));
  assertSafeRegs(r);
});

test('nur Master, Wiedereintritt wartet viele Takte (Slave in Notladung) → zählt nicht als Wiedereintritt, keine Stundensperre', async () => {
  const r = rig({ slaveHolding: OLD_CHARGE });
  r.ctl.slaveFailOnce = null;
  // Erster Eintritt: Slave auf Stopp, Master in Modus 2.
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, true);
  assert.equal(r.state.ctrl.sungrowEms.owns, true);
  // Master fällt selbst auf Modus 0, der Slave ist danach lange in Notladung (Befehl aus der App liegt an).
  r.masterImage.holding.set(MODE, EMS_MODE.SELF);
  r.slaveImage.holding.set(CMD, EMS_CMD.CHARGE);
  r.state.sungrowSecond.runningState = 0x4001;
  r.order.length = 0;
  for (let i = 0; i < 10; i += 1) {
    r.advance(61_000);
    const res = await r.ems.applySetpoint(-6000 - i - 1, 'rule:abend');
    assert.equal(res.ok, false, `Takt ${i}: ${JSON.stringify(res)}`);
  }
  assert.deepEqual(r.order, [], 'während der Notladung weder Slave- noch Master-Write');
  assert.ok(!r.logs.some((l) => l.event === 'sungrow_ems_reentry_rate'), 'zurückgestellte Takte lösen keine Stundensperre aus');
  // Notladung vorbei → Wiedereintritt sofort möglich.
  r.state.sungrowSecond.runningState = 0;
  r.advance(61_000);
  const res = await r.ems.applySetpoint(-6100, 'rule:abend');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(r.order[0], `S:${CMD}=${EMS_CMD.STOP}`);
  assert.ok(r.order.includes(`M:${MODE}=${EMS_MODE.FORCED}`), `${r.order}`);
  assertSafeRegs(r);
});

test('nur Master: Slave-Stopp nicht bestätigt → kein Eintritt, Master bleibt in Modus 0, Ziel bleibt; nächster Takt holt es nach', async () => {
  const r = rig({ slaveHolding: OLD_DISCHARGE });
  r.ctl.slaveFailOnce = CMD;
  const res = await r.ems.applySetpoint(-6000, 'rule:abend');
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.deepEqual(r.order, [], 'nichts angekommen, kein Master-Write');
  assert.equal(r.masterImage.holding.get(MODE), EMS_MODE.SELF);
  assert.notEqual(r.state.ctrl.sungrowEms.owns, true);
  assert.notEqual(r.ems._st.target, null, 'Ziel bleibt für den nächsten Takt');
  const deferred = r.logs.find((l) => l.event === 'sungrow_ems_entry_deferred');
  assert.ok(deferred, 'Meldung „Eintritt zurückgestellt“');
  assert.equal(deferred.level, 'warn');
  r.advance(30_000);
  const next = await r.ems.tick();
  assert.equal(next.ok, true, JSON.stringify(next));
  assert.equal(r.order[0], `S:${CMD}=${EMS_CMD.STOP}`);
  assert.ok(r.order.includes(`M:${MODE}=${EMS_MODE.FORCED}`), `jetzt eingetreten: ${r.order}`);
  assertSafeRegs(r);
});

test('nur Master: Slave in Notladung (Telemetrie) → kein Slave-Write, Eintritt wartet bis nach der Notladung', async () => {
  const r = rig({ slaveHolding: OLD_CHARGE });
  r.state.sungrowSecond.runningState = 0x4001;
  const res = await r.ems.applySetpoint(-6000, 'rule:abend');
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.deepEqual(r.order, [], 'weder Slave (Notladung) noch Master (Eintritt wartet)');
  assert.equal(r.masterImage.holding.get(MODE), EMS_MODE.SELF);
  assert.notEqual(r.ems._st.target, null);
  r.state.sungrowSecond.runningState = 0;
  r.advance(30_000);
  const next = await r.ems.tick();
  assert.equal(next.ok, true, JSON.stringify(next));
  assert.equal(r.order[0], `S:${CMD}=${EMS_CMD.STOP}`);
  assert.ok(r.order.includes(`M:${MODE}=${EMS_MODE.FORCED}`));
  assertSafeRegs(r);
});

test('ohne Slave-Werte: Slave in Notladung (am Slave gelesen) → kein Slave-Write, Eintritt wartet', async () => {
  const r = rig({ strategy: 'soc-balance', telemetry: false, slaveHolding: OLD_CHARGE, slaveInput: { [RUN_STATE]: 0x4001 } });
  const res = await r.ems.applySetpoint(-6000, 'rule:abend');
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.deepEqual(r.order, []);
  assert.ok(slaveRunStateReads(r) >= 1, 'Betriebszustand am Slave gelesen');
  r.slaveImage.input.set(RUN_STATE, 0);
  r.advance(30_000);
  const next = await r.ems.tick();
  assert.equal(next.ok, true, JSON.stringify(next));
  assert.equal(r.order[0], `S:${CMD}=${EMS_CMD.STOP}`);
  assert.ok(r.order.includes(`M:${MODE}=${EMS_MODE.FORCED}`));
  assertSafeRegs(r);
});

test('Not-Halt beginnt während der Slave-Prüfung vor dem Eintritt → kein Write an beide, kein Besitz', async () => {
  let r = null;
  r = rig({ slaveHolding: OLD_DISCHARGE, slaveMock: { onRead: ({ fc, address }) => { if (fc === 4 && address === RUN_STATE) r.state.ctrl.discretionaryWritesPaused = true; } } });
  const res = await r.ems.applySetpoint(-6000, 'rule:abend');
  assert.equal(res.ok, false);
  assert.deepEqual(r.order, [], 'nichts geschrieben');
  assert.notEqual(r.state.ctrl.sungrowEms?.owns, true);
  assert.notEqual(r.state.ctrl.sungrowEmsSlave?.owns, true);
  r.state.ctrl.pausedAt = 81;
  assert.equal((await r.ems.emergencyStop()).reason, 'not_owned');
  assert.deepEqual(r.order, [], 'auch der Not-Halt-Durchgang schreibt nichts');
});

test('Slave mit DVhubs eigenem Befehl, Rücknahme scheitert (Werte weg, Slave nicht beschreibbar) → kein Wiedereintritt, bis er zurückgenommen ist', async () => {
  const r = rig({ strategy: 'soc-balance' });
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).ok, true);
  assert.equal(r.state.ctrl.sungrowEmsSlave.owns, true, 'Slave von DVhub gefahren');
  assert.equal(r.slaveImage.holding.get(CMD), EMS_CMD.DISCHARGE);
  // Master fällt von selbst in Modus 0 zurück, die Slave-Werte fehlen, der Slave nimmt keinen Write an.
  r.masterImage.holding.set(MODE, EMS_MODE.SELF);
  delete r.state.sungrowSecond;
  r.ctl.slaveWriteFail = true;
  r.order.length = 0;
  r.advance(61_000);
  const res = await r.ems.applySetpoint(-6100, 'rule:abend');
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.deepEqual(masterWrites(r), [], 'Master bleibt in Modus 0 — sonst liefe der alte Slave-Anteil zusätzlich zum ganzen Master-Anteil');
  assert.equal(r.masterImage.holding.get(MODE), EMS_MODE.SELF);
  // Slave wieder beschreibbar → nächster Takt: Slave zurückgenommen, dann Wiedereintritt.
  r.ctl.slaveWriteFail = false;
  r.advance(30_000);
  const next = await r.ems.tick();
  assert.equal(next.ok, true, JSON.stringify(next));
  assert.equal(r.order[0], `S:${CMD}=${EMS_CMD.STOP}`, `${r.order}`);
  assert.ok(r.order.includes(`M:${MODE}=${EMS_MODE.FORCED}`), `${r.order}`);
  assert.equal(r.state.ctrl.sungrowEmsSlave.owns, false);
  assertSafeRegs(r);
});

test('Slave-Lesefehler genau im Eintrittstakt (führende Strategie) → kein Eintritt; nach Erholung normal (Slave, dann Master)', async () => {
  // Gewollte Änderung gegenüber bb03fb53 (Golden split_slave_fallback): bisher fiel DVhub auch im Eintrittstakt auf
  // „nur Master“ zurück und trat ein — der unbekannte Slave-Befehl wurde dabei wieder wirksam. Im laufenden Betrieb
  // bleibt der Rückfall (Aufgabe 3/C6, sungrow-second.test.js).
  let fail = true;
  const r = rig({ strategy: 'soc-balance', slaveHolding: OLD_CHARGE, slaveMock: { onRead: ({ fc, address }) => { if (fail && fc === 3 && address === MODE) throw new Error('modbus exception 4'); } } });
  const res = await r.ems.applySetpoint(-6000, 'rule:abend');
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.deepEqual(r.order, [], 'kein Write an beide');
  assert.equal(r.masterImage.holding.get(MODE), EMS_MODE.SELF);
  assert.ok(!r.logs.some((l) => l.event === 'sungrow_ems_split_aborted'), 'kein Split-Abbruch, nur zurückgestellt');
  fail = false;
  r.advance(30_000);
  const next = await r.ems.tick();
  assert.equal(next.ok, true, JSON.stringify(next));
  assert.deepEqual(r.order, [
    `S:${POWER}=2600`, `S:${CMD}=${EMS_CMD.DISCHARGE}`,
    `M:${POWER}=2600`, `M:${CMD}=${EMS_CMD.DISCHARGE}`, `M:${MODE}=${EMS_MODE.FORCED}`,
  ]);
  assertSafeRegs(r);
});

test('echter Evaluator: zurückgestellter Eintritt → Sollwert bleibt, kein control_write_error je Auswertung (Review 58b09279)', async () => {
  const { createScheduleEvaluator } = await import('../schedule-eval.js');
  const secondInverter = { host: SLAVE_HOST, aggregateTelemetry: true, strategyCharge: 'master-only', strategyDischarge: 'master-only', maxChargeW: 5000, maxDischargeW: 5000 };
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', sungrow: { controlMode: 'forced', heartbeatTimeoutS: 30, secondInverter }, optimizer: { maxChargeW: 5000, maxDischargeW: 5000, batteryCapacityWh: 10000, allowGridCharge: true } });
  const masterImage = sungrowImage();
  // Slave ohne Begleitdienst-Werte, in Notladung (am Slave gelesen), alter Ladebefehl liegt an.
  const slaveImage = sungrowImage({ holding: OLD_CHARGE, input: { [RUN_STATE]: 0x4001 } });
  const masterT = mockSungrow(masterImage);
  const slaveT = mockSungrow(slaveImage);
  const now = Date.now();
  const state = {
    victron: { soc: 60, batteryPowerW: -500, pvPowerW: 0, selfConsumptionW: 500, errors: {}, fieldUpdatedAt: { soc: now, batteryPowerW: now, pvPowerW: now, selfConsumptionW: now }, device: sungrowDevice() },
    meter: { ok: true, updatedAt: now, grid_total_w: 0 },
    schedule: { rules: [], active: {}, lastWrite: {}, manualOverride: {}, config: {}, lastEvalAt: 0 },
    ctrl: {},
  };
  const logs = [];
  const ev = createScheduleEvaluator({ state, getCfg: () => cfg, transport: masterT, sungrowSlaveTransport: slaveT, pushLog: (event, data) => logs.push({ event, data }), telemetrySafeWrite: () => {}, persistConfig: async () => {}, telemetryStore: null, epexNowNext: () => null });
  // Je Auswertung ein neuer Sollwert (EOS/Regeln ändern ihn laufend) → jedes Mal ein Regeltakt mit zurückgestelltem
  // Eintritt. Netzladen (freigegeben); ein negativer Sollwert endete schon am EEG-Tor.
  for (const v of [3000, 3050, 3100]) {
    const res = await ev.applyControlTarget('gridSetpointW', v, 'api_manual_write');
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.emsFailure, true, 'Aktuator-Fehler: Sollwert bleibt (kein Widerruf)');
  }
  assert.deepEqual([...masterT.writes, ...slaveT.writes], [], 'nichts geschrieben');
  assert.ok(!logs.some((l) => l.event === 'control_write_error'), 'kein irreführendes control_write_error');
  assert.equal(logs.filter((l) => l.event === 'sungrow_ems_entry_deferred').length, 1, 'der Aktuator meldet einmal selbst');
  // Notladung vorbei → Eintritt über denselben Weg: Slave auf Stopp, dann Master.
  slaveImage.input.set(RUN_STATE, 0);
  const ok = await ev.applyControlTarget('gridSetpointW', 3200, 'api_manual_write');
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(slaveT.writes.map((w) => [w.address, w.value]), [[CMD, EMS_CMD.STOP]]);
  assert.equal(masterImage.holding.get(MODE), EMS_MODE.FORCED);
});

// --- Schutztests: unverändertes Verhalten --------------------------------------------------------------------------

test('Schutz: zwei WR mit Aufteilung (soc-balance) — Eintritt unverändert: Slave-Befehl, dann Master, keine Zusatzprüfung', async () => {
  const r = rig({ strategy: 'soc-balance', slaveHolding: OLD_CHARGE });
  const res = await r.ems.applySetpoint(-6000, 'rule:abend');
  assert.equal(res.ok, true, JSON.stringify(res));
  // P = −5200 → 50/50 → je 2600 W; der Slave bekommt DVhubs Befehl (H-9-Übernahme per Write), dann der Master.
  assert.deepEqual(r.order, [
    `S:${POWER}=2600`, `S:${CMD}=${EMS_CMD.DISCHARGE}`,
    `M:${POWER}=2600`, `M:${CMD}=${EMS_CMD.DISCHARGE}`, `M:${MODE}=${EMS_MODE.FORCED}`,
  ]);
  assert.equal(slaveRunStateReads(r), 0, 'keine Betriebszustands-Prüfung am Slave');
  assertSafeRegs(r);
});

test('Schutz: Slave in Notladung bei führender Strategie (soc-balance, Telemetrie) → Master tritt sofort ein, Slave unberührt (wie H-9)', async () => {
  const r = rig({ strategy: 'soc-balance', slaveHolding: OLD_CHARGE });
  r.state.sungrowSecond.runningState = 0x4001;
  const res = await r.ems.applySetpoint(-6000, 'rule:abend');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(slaveWrites(r), [], 'Slave in Notladung bekommt keinen Write');
  assert.deepEqual(masterWrites(r), [`M:${POWER}=5000`, `M:${CMD}=${EMS_CMD.DISCHARGE}`, `M:${MODE}=${EMS_MODE.FORCED}`]);
});

test('Schutz: nur Master, Slave steht schon auf Stopp → kein Slave-Write, Eintritt wie bisher', async () => {
  const r = rig();
  const res = await r.ems.applySetpoint(-6000, 'rule:abend');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(r.order, [`M:${POWER}=5000`, `M:${CMD}=${EMS_CMD.DISCHARGE}`, `M:${MODE}=${EMS_MODE.FORCED}`]);
  assert.ok(!r.logs.some((l) => l.event === 'sungrow_ems_entry_slave_stopped'));
});

test('Schutz: Not-Halt — kein Eintritt, kein Slave-Write', async () => {
  const r = rig({ slaveHolding: OLD_DISCHARGE });
  r.state.ctrl.discretionaryWritesPaused = true;
  r.state.ctrl.pausedAt = 91;
  assert.equal((await r.ems.applySetpoint(-6000, 'rule:abend')).blocked, true);
  await r.ems.tick();
  assert.equal((await r.ems.emergencyStop()).reason, 'not_owned');
  assert.deepEqual(r.order, []);
  assert.equal(r.slaveImage.holding.get(CMD), EMS_CMD.DISCHARGE, 'im Not-Halt fasst DVhub den fremden Slave-Befehl nicht an');
});

test('Schutz: ein WR (Slave-Aktuator ohne zweiten WR wie in der Laufzeit) — Eintritt unverändert, keine Slave-Zugriffe', async () => {
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', sungrow: { controlMode: 'forced', heartbeatTimeoutS: 30 } });
  const image = sungrowImage();
  const t = mockSungrow(image);
  const clock = 1_000_000;
  const state = { victron: { errors: {}, fieldUpdatedAt: { batteryPowerW: clock, pvPowerW: clock, selfConsumptionW: clock }, device: sungrowDevice(), batteryPowerW: -500, pvPowerW: 0, selfConsumptionW: 500 }, meter: { ok: true, updatedAt: clock, grid_total_w: 0 }, ctrl: {} };
  // schedule-eval.js legt den Slave-Aktuator immer an; ohne zweiten WR liefert connOverride null (Verbindung = Master).
  const slaveEms = createSungrowEms({ state, getCfg: () => cfg, transport: t, now: () => clock, statusKey: 'sungrowEmsSlave', isSlave: true, connOverride: () => null, sleep: async () => {} });
  const ems = createSungrowEms({ state, getCfg: () => cfg, transport: t, now: () => clock, slaveActuator: slaveEms, sleep: async () => {} });
  const res = await ems.applySetpoint(-5000, 'rule:abend');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(t.writes.map((w) => [w.address, w.value]), [[POWER, 4000], [CMD, EMS_CMD.DISCHARGE], [MODE, EMS_MODE.FORCED]]);
  assert.ok(!t.reads.some((x) => x.fc === 4 && x.address === RUN_STATE), 'kein Betriebszustand-Lesen');
  assert.equal(slaveEms._st.owns, false);
});
