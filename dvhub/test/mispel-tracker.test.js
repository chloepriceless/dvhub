import test from 'node:test';
import assert from 'node:assert/strict';

import { createMispelTracker, REFUNDABLE_UMLAGEN_CT_KWH } from '../services/optimizer/mispel-tracker.js';

// --- Helpers ---

function makeState() {
  return { optimizer: {} };
}

function makeCfg(overrides = {}) {
  const base = { optimizer: { mispel: { mode: 'pauschal', pvKwp: 10 } } };
  if (overrides.mode !== undefined) base.optimizer.mispel.mode = overrides.mode;
  if (overrides.pvKwp !== undefined) base.optimizer.mispel.pvKwp = overrides.pvKwp;
  return () => base;
}

function makeLog() {
  const logs = [];
  const pushLog = (key, data) => logs.push({ key, data });
  pushLog.logs = logs;
  return pushLog;
}

// --- Test 1: REFUNDABLE_UMLAGEN_CT_KWH constant ---
test('REFUNDABLE_UMLAGEN_CT_KWH is 4.996', () => {
  assert.equal(REFUNDABLE_UMLAGEN_CT_KWH, 4.996);
});

// --- Test 2: createMispelTracker initializes state.optimizer.mispel ---
test('createMispelTracker initializes state.optimizer.mispel', () => {
  const state = makeState();
  const tracker = createMispelTracker(state, makeCfg(), makeLog());

  assert.ok(state.optimizer.mispel);
  assert.equal(state.optimizer.mispel.mode, 'pauschal');
  assert.equal(state.optimizer.mispel.yearlyFeedInKwh, 0);
  assert.equal(state.optimizer.mispel.yearlyGridWithdrawalKwh, 0);
  assert.equal(state.optimizer.mispel.gruenstromKwh, 0);
  assert.equal(state.optimizer.mispel.graustromKwh, 0);
  assert.equal(state.optimizer.mispel.saldierungsfaehigKwh, 0);
  assert.equal(state.optimizer.mispel.lastResetYear, new Date().getFullYear());
  assert.equal(state.optimizer.mispel.lastUpdateAt, null);
});

// --- Test 3: createMispelTracker returns update, getState, isGridChargeProfitable ---
test('createMispelTracker returns correct API surface', () => {
  const state = makeState();
  const tracker = createMispelTracker(state, makeCfg(), makeLog());

  assert.equal(typeof tracker.update, 'function');
  assert.equal(typeof tracker.getState, 'function');
  assert.equal(typeof tracker.isGridChargeProfitable, 'function');
});

// --- Test 4: update accumulates feed-in and grid withdrawal ---
test('update accumulates yearlyFeedInKwh and yearlyGridWithdrawalKwh', () => {
  const state = makeState();
  const tracker = createMispelTracker(state, makeCfg(), makeLog());

  tracker.update(2000000, 1000000); // 2000 kWh feed-in, 1000 kWh withdrawal
  assert.equal(state.optimizer.mispel.yearlyFeedInKwh, 2000);
  assert.equal(state.optimizer.mispel.yearlyGridWithdrawalKwh, 1000);

  tracker.update(500000, 250000); // +500 kWh feed-in, +250 kWh withdrawal
  assert.equal(state.optimizer.mispel.yearlyFeedInKwh, 2500);
  assert.equal(state.optimizer.mispel.yearlyGridWithdrawalKwh, 1250);
});

// --- Test 5: update recalculates derived fields (Gruenstrom/Graustrom split) ---
test('update recalculates gruenstrom and graustrom split', () => {
  const state = makeState();
  // pvKwp=10 -> gruenstrom limit = 5000 kWh
  const tracker = createMispelTracker(state, makeCfg({ pvKwp: 10 }), makeLog());

  // Feed in 8000 kWh -> gruenstrom=5000, graustrom=3000
  tracker.update(8000000, 4000000); // 8000 kWh, 4000 kWh
  assert.equal(state.optimizer.mispel.gruenstromKwh, 5000);
  assert.equal(state.optimizer.mispel.graustromKwh, 3000);
  assert.equal(state.optimizer.mispel.saldierungsfaehigKwh, 3000);
});

// --- Test 6: update sets lastUpdateAt ---
test('update sets lastUpdateAt to ISO string', () => {
  const state = makeState();
  const tracker = createMispelTracker(state, makeCfg(), makeLog());

  tracker.update(1000, 500);
  assert.ok(state.optimizer.mispel.lastUpdateAt);
  // Should be a valid ISO date string
  assert.ok(!isNaN(Date.parse(state.optimizer.mispel.lastUpdateAt)));
});

// --- Test 7: getState returns mispel state snapshot ---
test('getState returns current mispel state', () => {
  const state = makeState();
  const tracker = createMispelTracker(state, makeCfg(), makeLog());

  tracker.update(5000000, 2000000);
  const snap = tracker.getState();

  assert.equal(snap.yearlyFeedInKwh, 5000);
  assert.equal(snap.yearlyGridWithdrawalKwh, 2000);
  assert.equal(snap.mode, 'pauschal');
});

// --- Test 8: isGridChargeProfitable returns saldierung_available when headroom ---
test('isGridChargeProfitable returns profitable when Saldierung headroom > 0', () => {
  const state = makeState();
  // pvKwp=10 -> limit=5000
  const tracker = createMispelTracker(state, makeCfg({ pvKwp: 10 }), makeLog());

  // feedIn=8000, withdrawal=2000 -> saldierungsfaehig=3000, alreadySaldiert=min(3000,2000)=2000, remaining=1000
  tracker.update(8000000, 2000000);
  const result = tracker.isGridChargeProfitable(30);

  assert.equal(result.profitable, true);
  assert.equal(result.reason, 'saldierung_available');
  assert.equal(result.adjustedImportCtKwh, 30 - 4.996);
});

// --- Test 9: isGridChargeProfitable returns saldierung_exhausted when no headroom ---
test('isGridChargeProfitable returns not profitable when Saldierung exhausted', () => {
  const state = makeState();
  const tracker = createMispelTracker(state, makeCfg({ pvKwp: 10 }), makeLog());

  // feedIn=8000, withdrawal=4000 -> saldierungsfaehig=3000, alreadySaldiert=min(3000,4000)=3000, remaining=0
  tracker.update(8000000, 4000000);
  const result = tracker.isGridChargeProfitable(30);

  assert.equal(result.profitable, false);
  assert.equal(result.reason, 'saldierung_exhausted');
  assert.equal(result.adjustedImportCtKwh, 30);
});

// --- Test 10: isGridChargeProfitable returns mispel_disabled when mode is none ---
test('isGridChargeProfitable returns mispel_disabled when mode is none', () => {
  const state = makeState();
  const tracker = createMispelTracker(state, makeCfg({ mode: 'none' }), makeLog());

  const result = tracker.isGridChargeProfitable(30);

  assert.equal(result.profitable, false);
  assert.equal(result.reason, 'mispel_disabled');
  assert.equal(result.adjustedImportCtKwh, 30);
});

// --- Test 11: Year boundary resets all counters ---
test('year boundary resets all counters', () => {
  const state = makeState();
  const tracker = createMispelTracker(state, makeCfg(), makeLog());

  // Simulate some accumulated data
  tracker.update(8000000, 4000000);
  assert.equal(state.optimizer.mispel.yearlyFeedInKwh, 8000);

  // Force lastResetYear to previous year to trigger reset
  state.optimizer.mispel.lastResetYear = new Date().getFullYear() - 1;

  tracker.update(1000000, 500000);

  // After reset, should only have the new data
  assert.equal(state.optimizer.mispel.yearlyFeedInKwh, 1000);
  assert.equal(state.optimizer.mispel.yearlyGridWithdrawalKwh, 500);
  assert.equal(state.optimizer.mispel.lastResetYear, new Date().getFullYear());
});

// --- Test 12: Pauschal mode logs warning on startup ---
test('pauschal mode logs mispel_pauschal_warning on startup', () => {
  const state = makeState();
  const pushLog = makeLog();
  createMispelTracker(state, makeCfg({ mode: 'pauschal' }), pushLog);

  assert.equal(pushLog.logs.length, 1);
  assert.equal(pushLog.logs[0].key, 'mispel_pauschal_warning');
  assert.ok(pushLog.logs[0].data.message.includes('EU-beihilferechtliche'));
});

// --- Test 13: Non-pauschal mode does NOT log warning ---
test('non-pauschal mode does not log warning', () => {
  const state = makeState();
  const pushLog = makeLog();
  createMispelTracker(state, makeCfg({ mode: 'none' }), pushLog);

  assert.equal(pushLog.logs.length, 0);
});

// --- Test 14: Feed-in below gruenstrom limit has zero graustrom ---
test('feed-in below gruenstrom limit has zero graustrom', () => {
  const state = makeState();
  // pvKwp=10 -> limit=5000
  const tracker = createMispelTracker(state, makeCfg({ pvKwp: 10 }), makeLog());

  tracker.update(3000000, 1000000); // 3000 kWh < 5000 limit
  assert.equal(state.optimizer.mispel.gruenstromKwh, 3000);
  assert.equal(state.optimizer.mispel.graustromKwh, 0);
  assert.equal(state.optimizer.mispel.saldierungsfaehigKwh, 0);
});

// --- Test 15: Verify exact example from research (D-25/D-26) ---
test('research example: pvKwp=10, feedIn=8000, withdrawal=4000', () => {
  const state = makeState();
  const tracker = createMispelTracker(state, makeCfg({ pvKwp: 10 }), makeLog());

  tracker.update(8000000, 4000000);

  const mispel = state.optimizer.mispel;
  assert.equal(mispel.gruenstromKwh, 5000);
  assert.equal(mispel.graustromKwh, 3000);
  assert.equal(mispel.saldierungsfaehigKwh, 3000);

  // saldierungsfaehig=3000, withdrawal=4000, erstattung=min(3000,4000)=3000, remaining=0
  const result = tracker.isGridChargeProfitable(30);
  assert.equal(result.profitable, false);
  assert.equal(result.reason, 'saldierung_exhausted');
});
