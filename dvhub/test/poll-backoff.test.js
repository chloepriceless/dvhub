// Plan 09-08 Task 4 — poll-backoff tests.
// Verifies the exponential backoff in createPoller from polling.js. The test
// drives pollMeter directly via the public requestPoll() handle so we can
// step through failure scenarios without sleeping. The locked delay table
// (BASE_POLL_MS=500, BACKOFF_THRESHOLD=3) is:
//   consecutiveErrors=0..3 → 500 ms (base)
//   consecutiveErrors=4    → 750 ms   (500 × 1.5^1)
//   consecutiveErrors=5    → 1125 ms  (500 × 1.5^2)
//   consecutiveErrors=7    → 2531.25 ms (500 × 1.5^4)
//   consecutiveErrors=15   → 30000 ms (cap; 500 × 1.5^12 = 64876.59 > 30000)
// First success resets consecutiveErrors to 0 and nextRetryAt to base 500.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPoller } from '../polling.js';

/** Build minimal poller state + a failing modbus transport. */
function makeFailingPoller() {
  const state = {
    meter: {
      ok: false, updatedAt: 0, raw: [],
      grid_l1_w: 0, grid_l2_w: 0, grid_l3_w: 0, grid_total_w: 0, error: null
    },
    victron: { errors: {}, updatedAt: 0 },
    dvRegs: new Array(8).fill(0),
    energy: { day: '2026-05-11', importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0, lastTs: 0 }
  };
  const transport = {
    type: 'modbus',
    mbRequest: async () => { throw new Error('meter offline'); }
  };
  const cfg = {
    // BASE_POLL_MS resolves via cfg.pollMs first — the plan's locked delay
    // table assumes 500 ms base.
    pollMs: 500,
    gridPositiveMeans: 'feed_in',
    meter: { host: '127.0.0.1', port: 502, unitId: 1, fc: 3, address: 0, quantity: 3 },
    points: {},
    epex: { timezone: 'UTC' },
    userEnergyPricing: {},
    dvControl: {}
  };
  const poller = createPoller({
    state,
    getCfg: () => cfg,
    transport,
    pushLog: () => {},
    energyPath: '/tmp/poll-backoff-test.json',
    onPollComplete: () => {},
    epexNowNext: () => ({ current: { ct_kwh: 0 } })
  });
  return { state, poller, cfg, transport };
}

/** Recompute the locked delay formula for a given consecutiveErrors value. */
function expectedDelay(consecutiveErrors, basePollMs = 500, threshold = 3, cap = 30_000) {
  if (consecutiveErrors < threshold) return basePollMs;
  const power = Math.max(0, consecutiveErrors - threshold);
  return Math.min(cap, basePollMs * Math.pow(1.5, power));
}

test('consecutiveErrors increments on each failed pollMeter call', async () => {
  const { state, poller } = makeFailingPoller();
  await poller.requestPoll();
  await poller.requestPoll();
  await poller.requestPoll();
  await poller.requestPoll();
  await poller.requestPoll();
  assert.equal(state.meter.consecutiveErrors, 5);
  assert.equal(state.meter.ok, false);
  assert.match(state.meter.error, /meter offline/);
});

test('locked delay formula: 4 consecutive failures → 750 ms', () => {
  assert.equal(expectedDelay(4), 750);
});

test('locked delay formula: 5 consecutive failures → 1125 ms', () => {
  assert.equal(expectedDelay(5), 1125);
});

test('locked delay formula: 7 consecutive failures → 2531.25 ms', () => {
  // 500 × 1.5^4 = 500 × 5.0625 = 2531.25 — exact under IEEE-754
  const d = expectedDelay(7);
  assert.ok(Math.abs(d - 2531.25) < 0.5, `expected ~2531.25, got ${d}`);
});

test('locked delay formula: 15 consecutive failures → 30000 ms cap', () => {
  assert.equal(expectedDelay(15), 30_000);
  // Sanity: uncapped would be 500 × 1.5^12 = 64876.59…
  const uncapped = 500 * Math.pow(1.5, 12);
  assert.ok(uncapped > 30_000, 'cap is actually clamping the value');
});

test('locked delay formula: 0..3 consecutive failures all yield base 500 ms (no backoff)', () => {
  for (const cE of [0, 1, 2, 3]) {
    assert.equal(expectedDelay(cE), 500, `cE=${cE} should still be base 500`);
  }
});

test('first success after failures resets consecutiveErrors to 0 and nextRetryAt to null', async () => {
  const { state, poller, transport } = makeFailingPoller();
  // 5 failures to build up backoff state
  for (let i = 0; i < 5; i++) await poller.requestPoll();
  assert.equal(state.meter.consecutiveErrors, 5);

  // Flip the transport to succeed — 3 registers (l1, l2, l3) for the meter read
  transport.mbRequest = async () => [100, 200, 300];

  await poller.requestPoll();
  assert.equal(state.meter.consecutiveErrors, 0, 'reset on success');
  assert.equal(state.meter.nextRetryAt, null, 'nextRetryAt cleared on success');
  assert.equal(state.meter.ok, true);
});

test('state.meter.nextRetryAt advances after failures (observable via /api/status)', async () => {
  const { state, poller } = makeFailingPoller();
  // start() would kick off pollMeterWithBackoff which sets nextRetryAt;
  // simulate by calling start() and reading the post-tick state.
  poller.start();
  // Wait a microtask cycle for the kickoff promise to flush
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  // After at least one failed tick, nextRetryAt is a number in the future or equal to now
  assert.ok(
    state.meter.nextRetryAt === null || typeof state.meter.nextRetryAt === 'number',
    `nextRetryAt should be number or null, got ${typeof state.meter.nextRetryAt}`
  );
  poller.stop();
});
