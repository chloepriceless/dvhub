// A23 b (Christin 23.11.2026): Feldtest „Abregelung testen (X min)“ — die Zeitbegrenzung läuft monoton. Der Test endet
// nach X min Laufzeit, auch wenn die Systemzeit springt; ein eigenes DV-Lease (offUntil, Wanduhr) nimmt der Ablauf mit
// zurück. startedAt/until/stoppedAt bleiben Wanduhr (Anzeige, Protokoll).
import test from 'node:test';
import assert from 'node:assert/strict';

import { createCurtailmentTest } from '../services/curtailment-test.js';
import { HOST, fixClock, loadProfileConfig, recordingModbus, baseState, evaluatorRig } from './helpers/gate-golden.js';

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
