// T-0075 P0-1 — telemetry-freshness core contract (Design test #6, Hub-refute Auflage 1).
//
// The whole freshness guard rests on ONE invariant: polling.js stamps
// state.victron.fieldUpdatedAt[field] ONLY in the success branch of a poll. A FAILED
// read must leave the timestamp untouched (and the value frozen at its last reading),
// so a comms outage produces a detectably-stale SoC rather than a fresh-looking frozen
// one. This drives pollPoint through the real public requestPoll() handle (same harness
// idiom as poll-backoff.test.js) with a transport that succeeds then throws.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPoller } from '../polling.js';

function makePoller() {
  const state = {
    meter: {
      ok: false, updatedAt: 0, raw: [],
      grid_l1_w: 0, grid_l2_w: 0, grid_l3_w: 0, grid_total_w: 0, error: null
    },
    victron: { errors: {}, updatedAt: 0, fieldUpdatedAt: {} },
    dvRegs: new Array(8).fill(0),
    energy: { day: '2026-06-05', importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0, lastTs: 0 }
  };
  // mbRequest is flippable: a 3-register reply satisfies both the meter read and the
  // 1-register soc point; `fail=true` makes every Modbus read throw.
  const transport = {
    type: 'modbus',
    fail: false,
    mbRequest: async function () {
      if (this.fail) throw new Error('soc read timeout');
      return [50, 50, 50];
    }
  };
  const cfg = {
    pollMs: 500,
    gridPositiveMeans: 'feed_in',
    meter: { host: '127.0.0.1', port: 502, unitId: 1, fc: 3, address: 0, quantity: 3 },
    points: {
      soc: { enabled: true, fc: 4, address: 843, quantity: 1, signed: false, scale: 1, offset: 0 }
    },
    epex: { timezone: 'UTC' },
    userEnergyPricing: {},
    dvControl: {}
  };
  const poller = createPoller({
    state,
    getCfg: () => cfg,
    transport,
    pushLog: () => {},
    energyPath: '/tmp/telemetry-freshness-test.json',
    onPollComplete: () => {},
    epexNowNext: () => ({ current: { ct_kwh: 0 } })
  });
  return { state, poller, transport };
}

test('T-0075: a successful poll stamps fieldUpdatedAt.soc', async () => {
  const { state, poller } = makePoller();
  await poller.requestPoll();
  assert.equal(state.victron.soc, 50, 'soc read on success');
  assert.ok(state.victron.fieldUpdatedAt.soc > 0, 'success branch stamps fieldUpdatedAt.soc');
  assert.equal(state.victron.errors.soc, undefined, 'no error recorded on success');
});

test('T-0075: a FAILED poll leaves fieldUpdatedAt.soc UNCHANGED and freezes the value (core fix)', async () => {
  const { state, poller, transport } = makePoller();

  // 1. Success → soc read + fieldUpdatedAt.soc stamped.
  await poller.requestPoll();
  assert.equal(state.victron.soc, 50);
  assert.ok(state.victron.fieldUpdatedAt.soc > 0);

  // Pin a known sentinel so the assertion is independent of Date.now() granularity:
  // if the error path wrongly re-stamped, the value would change to ~now (!= sentinel).
  const sentinel = 1234567890;
  state.victron.fieldUpdatedAt.soc = sentinel;

  // 2. Reads now throw — the poll fails.
  transport.fail = true;
  await poller.requestPoll();

  // The freshness invariant: the failed read must NOT advance the success timestamp,
  // and the last good value stays put (the "frozen SoC after a comms fault" the guard
  // is built to detect). updatedAt (last ATTEMPT) is allowed to move — fieldUpdatedAt
  // (last SUCCESS) must not.
  assert.equal(state.victron.fieldUpdatedAt.soc, sentinel,
    'failed read must leave fieldUpdatedAt.soc unchanged');
  assert.equal(state.victron.soc, 50, 'failed read retains the last good SoC value (frozen)');
  assert.ok(state.victron.errors.soc, 'failed read records errors.soc');
});

test('T-0075: a later successful poll re-stamps fieldUpdatedAt.soc (recovery)', async () => {
  const { state, poller, transport } = makePoller();
  await poller.requestPoll();
  state.victron.fieldUpdatedAt.soc = 1; // pretend very old
  transport.fail = true;
  await poller.requestPoll();           // stays old
  assert.equal(state.victron.fieldUpdatedAt.soc, 1);
  transport.fail = false;
  await poller.requestPoll();           // recovery → fresh stamp
  assert.ok(state.victron.fieldUpdatedAt.soc > 1, 'recovery re-stamps freshness');
});
