import test from 'node:test';
import assert from 'node:assert/strict';

import { createCurtailmentTest } from '../services/curtailment-test.js';

// Beweglicher „Jetzt"-Zeiger, damit Lease-Ablauf ohne echte Wartezeit prüfbar ist.
function harness({ dvEnabled = true, paused = false } = {}) {
  let nowMs = 1_000_000;
  const forced = { calls: [], cleared: [] };
  const state = {
    ctrl: { discretionaryWritesPaused: paused, forcedOff: false, offUntil: 0 },
    victron: { pvTotalW: 5000, sungrowMasterPvW: 3000, sungrowMasterBatteryW: 1200, sungrowSecond: { pvPowerW: 2000, batteryPowerW: 800 } },
    meter: { grid_total_w: -1500 },
    schedule: { active: { feedExcessDcPv: { value: 0 } } },
    log: [],
  };
  const ct = createCurtailmentTest({
    state,
    pushLog: (event, details) => state.log.push({ ts: new Date(nowMs).toISOString(), event, ...details }),
    now: () => nowMs,
    getCfg: () => ({ dvControl: { enabled: dvEnabled } }),
    setForcedOff: (reason, opts) => { forced.calls.push([reason, opts?.until]); state.ctrl.forcedOff = true; state.ctrl.offUntil = opts?.until; },
    clearForcedOff: (reason) => { forced.cleared.push(reason); state.ctrl.forcedOff = false; state.ctrl.offUntil = 0; },
  });
  return { ct, state, forced, advance: (ms) => { nowMs += ms; }, nowRef: () => nowMs };
}

test('DV-Test: setForcedOff mit selbst-ablaufendem Lease, kein Dauerzustand', () => {
  const h = harness();
  const r = h.ct.start({ mode: 'dv', minutes: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(h.forced.calls.length, 1);
  assert.equal(h.forced.calls[0][0], 'curtailment_test');
  assert.equal(h.forced.calls[0][1], h.nowRef() + 5 * 60000, 'until = jetzt + X min');
  assert.equal(h.ct.isActive(), true);
  // Lease läuft von selbst ab: nach 5 min + 1 s ist der Test aus.
  h.advance(5 * 60000 + 1000);
  assert.equal(h.ct.isActive(), false);
});

test('Negativpreis-Test: KEIN setForcedOff (läuft über priceNegative im Regeltakt)', () => {
  const h = harness();
  const r = h.ct.start({ mode: 'negativePrice', minutes: 10 });
  assert.equal(r.ok, true);
  assert.equal(h.forced.calls.length, 0, 'negativePrice schreibt nicht direkt');
  assert.equal(h.ct.isActive(), true);
  assert.equal(h.state.ctrl.curtailmentTest.mode, 'negativePrice');
});

test('Ablehnungen: ungültiger Modus / Minuten, Not-Halt, Steuerung aus', () => {
  assert.equal(harness().ct.start({ mode: 'quatsch', minutes: 5 }).status, 400);
  assert.equal(harness().ct.start({ mode: 'dv', minutes: 0 }).status, 400);
  assert.equal(harness().ct.start({ mode: 'dv', minutes: 61 }).status, 400);
  assert.equal(harness({ paused: true }).ct.start({ mode: 'dv', minutes: 5 }).status, 409);
  assert.equal(harness({ dvEnabled: false }).ct.start({ mode: 'dv', minutes: 5 }).status, 409);
});

test('Doppelstart wird abgelehnt, solange ein Test läuft', () => {
  const h = harness();
  assert.equal(h.ct.start({ mode: 'dv', minutes: 5 }).ok, true);
  const second = h.ct.start({ mode: 'negativePrice', minutes: 5 });
  assert.equal(second.ok, false);
  assert.equal(second.status, 409);
});

test('1-s-Protokoll: Messwerte je WR aus dem Regeltakt, Ablauf beendet den Test', () => {
  const h = harness();
  h.ct.start({ mode: 'dv', minutes: 1 });
  h.ct.sample();
  h.advance(1000); h.ct.sample();
  const view = h.ct.getStatus().test;
  assert.equal(view.samples.length, 2);
  const s = view.samples[0];
  assert.equal(s.gridTotalW, -1500);
  assert.equal(s.pvMasterW, 3000);
  assert.equal(s.pvSlaveW, 2000);
  assert.equal(s.battMasterW, 1200);
  assert.equal(s.battSlaveW, 800);
  assert.equal(s.blocked, true, 'feedExcessDcPv 0 → gesperrt');
  // Ablauf: sample() beendet den Test selbst.
  h.advance(60 * 1000); h.ct.sample();
  assert.equal(h.ct.isActive(), false);
  assert.equal(h.ct.getStatus().test.stopReason, 'expired');
});

test('„Akku nicht laden": batteryHoldActive nur bei blockCharge + laufendem Lease', () => {
  const h = harness();
  h.ct.start({ mode: 'dv', minutes: 2, blockCharge: true });
  assert.equal(h.ct.batteryHoldActive(), true);
  h.advance(2 * 60000 + 1); // Lease abgelaufen
  assert.equal(h.ct.batteryHoldActive(), false);

  const h2 = harness();
  h2.ct.start({ mode: 'dv', minutes: 2, blockCharge: false });
  assert.equal(h2.ct.batteryHoldActive(), false, 'ohne Option kein Hold');
});

test('Stop: hebt ein noch eigenes DV-Lease auf, fasst ein fremdes nicht an', () => {
  const h = harness();
  h.ct.start({ mode: 'dv', minutes: 5 });
  h.ct.stop();
  assert.equal(h.forced.cleared.length, 1, 'eigenes Lease aufgehoben');
  assert.equal(h.ct.isActive(), false);

  // Fremdes DV-Signal überschreibt offUntil → stop fasst es nicht an.
  const h2 = harness();
  h2.ct.start({ mode: 'dv', minutes: 5 });
  h2.state.ctrl.offUntil = h2.nowRef() + 999999; // echtes DV-Signal verschiebt das Lease
  h2.ct.stop();
  assert.equal(h2.forced.cleared.length, 0, 'fremdes Lease bleibt unberührt');
});
