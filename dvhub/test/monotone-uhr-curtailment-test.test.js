// A23 b (Christin 23.11.2026): Feldtest „Abregelung testen (X min)“ — die Zeitbegrenzung läuft monoton. Der Test endet
// nach X min Laufzeit, auch wenn die Systemzeit springt; ein eigenes DV-Lease (offUntil, Wanduhr) nimmt der Ablauf mit
// zurück. startedAt/until/stoppedAt bleiben Wanduhr (Anzeige, Protokoll).
import test from 'node:test';
import assert from 'node:assert/strict';

import { createCurtailmentTest } from '../services/curtailment-test.js';
import { createSungrowEms, wire, EMS_CMD } from '../services/inverter/sungrow.js';
import { loadSungrowConfig, sungrowImage, mockSungrow, sungrowDevice } from './helpers/sungrow-fixture.js';
import { HOST, fixClock, loadProfileConfig, recordingModbus, baseState, evaluatorRig } from './helpers/gate-golden.js';

const CMD = wire(13051);

function harness() {
  const c = { wall: 1_800_000_000_000, mono: 7000 };
  const forced = { calls: [], cleared: [] };
  const state = {
    ctrl: { discretionaryWritesPaused: false, forcedOff: false, offUntil: 0 },
    victron: { pvTotalW: 5000 }, meter: { grid_total_w: -1500 }, schedule: { active: {} }, log: [],
  };
  const ct = createCurtailmentTest({
    state,
    pushLog: (event, details) => state.log.push({ ts: new Date(c.wall).toISOString(), event, ...details }),
    now: () => c.wall,
    monoNow: () => c.mono,
    getCfg: () => ({ dvControl: { enabled: true } }),
    setForcedOff: (reason, opts) => { forced.calls.push([reason, opts?.until]); state.ctrl.forcedOff = true; state.ctrl.offUntil = opts?.until; state.ctrl.lastSignal = reason; },
    clearForcedOff: (reason) => { forced.cleared.push(reason); state.ctrl.forcedOff = false; state.ctrl.offUntil = 0; state.ctrl.lastSignal = reason; },
  });
  return { ct, state, forced, c };
}

test('Abregel-Test: Rücksprung — der Test endet nach X min Laufzeit, das eigene DV-Lease wird zurückgenommen', () => {
  const h = harness();
  const startWall = h.c.wall;
  assert.equal(h.ct.start({ mode: 'dv', minutes: 5 }).ok, true);
  h.c.wall -= 3_600_000; h.c.mono += 5 * 60000 + 1000;
  assert.equal(h.ct.isActive(), false, 'nach 5 min Laufzeit aus');
  h.ct.sample();
  const t = h.state.ctrl.curtailmentTest;
  assert.equal(t.active, false);
  assert.equal(t.stopReason, 'expired');
  assert.equal(t.startedAt, startWall, 'startedAt bleibt Wanduhr');
  assert.deepEqual(h.forced.cleared, ['curtailment_test_expired'], 'eigenes DV-Lease zurückgenommen');
  assert.equal(h.state.ctrl.forcedOff, false);
});

test('Abregel-Test: Sprung vorwärts — der Test läuft weiter bis X min Laufzeit, Restzeit monoton', () => {
  const h = harness();
  h.ct.start({ mode: 'negativePrice', minutes: 10, blockCharge: true });
  h.c.wall += 3_600_000; h.c.mono += 60_000;
  assert.equal(h.ct.isActive(), true);
  assert.equal(h.ct.batteryHoldActive(), true);
  h.ct.sample();
  const v = h.ct.publicView();
  assert.equal(v.active, true);
  assert.equal(v.remainingMs, 9 * 60000);
  assert.equal(v.samples[0].tMs, 60_000, 'Abtastzeit seit Start monoton');
  assert.equal(h.ct.start({ mode: 'negativePrice', minutes: 1 }).error, 'curtailment_test_already_running');
});

test('Abregel-Test: Ablauf nimmt ein fremdes DV-Lease nicht zurück', () => {
  const h = harness();
  h.ct.start({ mode: 'dv', minutes: 5 });
  // Ein echtes DV-Signal kam dazwischen und hat das Lease verschoben.
  h.state.ctrl.offUntil = h.c.wall + 30 * 60000; h.state.ctrl.lastSignal = 'direktvermarkter';
  h.c.mono += 6 * 60000;
  h.ct.sample();
  assert.deepEqual(h.forced.cleared, []);
  assert.equal(h.state.ctrl.forcedOff, true);
});

// Codex 22e6b278 P1: ein Lebenszeichen des DV (Watchdog-Schreiben → dvLimit.watchdogRefresh) verschiebt nur offUntil,
// ohne neuen Befehl. Die Sperre gehört weiter dem Test; Stop und Ablauf nehmen sie zurück.
test('Abregel-Test: DV-Watchdog während des Tests — Stop hebt die Sperre trotzdem auf', () => {
  const h = harness();
  h.ct.start({ mode: 'dv', minutes: 5 });
  h.c.mono += 60000; h.c.wall += 60000;
  h.state.ctrl.offUntil = h.c.wall + 15 * 60000; // watchdogRefresh: nur die Frist, lastSignal bleibt
  h.ct.stop();
  assert.deepEqual(h.forced.cleared, ['curtailment_test_stopped']);
  assert.equal(h.state.ctrl.forcedOff, false);
});

test('Abregel-Test: DV-Watchdog während des Tests — Ablauf hebt die Sperre trotzdem auf', () => {
  const h = harness();
  h.ct.start({ mode: 'dv', minutes: 1 });
  for (let i = 0; i < 3; i++) { // Watchdog alle 30 s
    h.c.mono += 30000; h.c.wall += 30000;
    h.state.ctrl.offUntil = h.c.wall + 15 * 60000;
    h.ct.sample();
  }
  assert.deepEqual(h.forced.cleared, ['curtailment_test_expired']);
  assert.equal(h.state.ctrl.forcedOff, false);
});

// Codex 22e6b278 P2: läuft eine echte DV-Sperre (monoton gestempelt wie server.js stampLease) und springt die
// Systemzeit vorwärts über offUntil, darf der DV-Test sie nicht überschreiben.
test('Abregel-Test: echte DV-Sperre nach Sprung vorwärts — Start abgelehnt', async () => {
  const { stampMono } = await import('../services/mono-clock.js');
  const h = harness();
  h.state.ctrl.forcedOff = true;
  h.state.ctrl.offUntil = Date.now() + 15 * 60000;
  h.state.ctrl.lastSignal = 'plexlog_holding0_0';
  stampMono(h.state.ctrl, 'offUntil', { wallNow: Date.now() }); // wie stampLease (gemeinsame monotone Uhr)
  h.c.wall = Date.now() + 3_600_000; // Systemzeit 1 h vorwärts
  const r = h.ct.start({ mode: 'dv', minutes: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'real_dv_restriction_active');
  assert.deepEqual(h.forced.calls, []);
});

// Regeltakt (schedule-eval): ob der Negativpreis-Test läuft, sagt der Dienst (monoton), nicht Date.now() < until.
test('Regeltakt: Negativpreis-Test gilt nach dem Dienst, nicht nach der Wanduhr-Frist', async (t) => {
  fixClock(t);
  const run = async (active) => {
    const cfg = loadProfileConfig('victron', { victron: { host: HOST }, dvControl: { enabled: true } });
    const state = baseState();
    state.ctrl.curtailmentTest = { active: true, mode: 'negativePrice', blockCharge: false, until: Date.now() + 600000 };
    const rig = evaluatorRig({ cfg, state, ctx: { curtailmentTest: { isActive: () => active } }, transport: recordingModbus({}) });
    await rig.ev.evaluateSchedule();
    return rig.state.schedule?.active?.feedExcessDcPv?.source ?? null;
  };
  assert.equal(await run(true), 'negative_price_protection');
  assert.notEqual(await run(false), 'negative_price_protection', 'Dienst: abgelaufen → kein Negativpreis-Pfad, auch wenn until (Wanduhr) noch nicht erreicht ist');
});

// Codex 944bcef1 (P2): ein abgelaufener DV-Test, der noch nicht abgetastet wurde, gibt beim Start eines neuen Tests
// sein eigenes DV-Lease frei, statt überschrieben zu werden.
test('Abregel-Test: Rücksprung — neuer Test nach monotonem Ablauf nimmt das alte DV-Lease zurück', () => {
  const h = harness();
  h.ct.start({ mode: 'dv', minutes: 5 });
  h.c.wall -= 3_600_000; h.c.mono += 5 * 60000 + 500; // abgelaufen, sample() noch nicht gelaufen
  const r = h.ct.start({ mode: 'negativePrice', minutes: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(h.forced.cleared, ['curtailment_test_expired']);
  assert.equal(h.state.ctrl.forcedOff, false);
  assert.ok(h.state.log.some((l) => l.event === 'curtailment_test_finished' && l.reason === 'expired'));
});

// Codex 944bcef1 (P2): der Sungrow-Aktuator liest „Akku nicht laden“ mit derselben monotonen Frist wie der Dienst.
test('Sungrow: Sprung vorwärts über until — „Akku nicht laden“ gilt weiter, kein Ladebefehl', async () => {
  const c = { wall: 1_000_000_000, mono: 1000 };
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', sungrow: { controlMode: 'forced', heartbeatTimeoutS: 30 } });
  const t = mockSungrow(sungrowImage());
  const state = { victron: { errors: {}, fieldUpdatedAt: {}, device: sungrowDevice() }, meter: { ok: true, updatedAt: c.wall, grid_total_w: 0 }, ctrl: {} };
  const telemetry = () => {
    state.meter = { ok: true, updatedAt: c.wall, grid_total_w: -3000 }; // 3 kW Einspeisung (PV-Überschuss)
    Object.assign(state.victron, { batteryPowerW: 0, pvPowerW: 4000, selfConsumptionW: 1000 });
    for (const f of ['batteryPowerW', 'pvPowerW', 'selfConsumptionW']) state.victron.fieldUpdatedAt[f] = c.wall;
  };
  telemetry();
  const ct = createCurtailmentTest({ state, now: () => c.wall, monoNow: () => c.mono, getCfg: () => ({ dvControl: { enabled: true } }), pushLog: () => {} });
  assert.equal(ct.start({ mode: 'negativePrice', minutes: 10, blockCharge: true }).ok, true);
  const ems = createSungrowEms({ state, getCfg: () => cfg, transport: t, now: () => c.wall, monoNow: () => c.mono });
  c.wall += 3_600_000; c.mono += 60_000; // Uhr springt über until, 1 min Laufzeit
  telemetry();
  assert.equal(ct.batteryHoldActive(), true);
  await ems.applySetpoint(0, 'rule:test');
  assert.ok(!t.writes.some((w) => w.address === CMD && w.value === EMS_CMD.CHARGE), `kein Laden: ${JSON.stringify(t.writes)}`);
});
