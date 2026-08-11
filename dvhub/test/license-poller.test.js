// test/license-poller.test.js — Unit tests for the license-poller (Phase 17 Plan 03).
//
// Verifies the 30s-after-boot setTimeout + 24h setInterval schedule and the
// overlap-guard that prevents concurrent revalidate calls when an upstream
// HTTP request is still in flight (RESEARCH §Pitfall 4).
//
// Timer injection: ctx.timers = { setInterval, setTimeout, clearInterval } lets
// each test capture the scheduled callbacks and fire them on demand without
// real time passing.
//
// Pattern source: test/license-service.test.js (mockCtx, withMockFetch).
// Constraint (PROJECT.md): node:test + node:assert/strict ONLY. NO vitest.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLicenseService } from '../services/license/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Per-test isolated ctx with a fresh tmpdir for license_state.json so persist
 * paths don't collide between tests.
 */
function mockCtx(over = {}) {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'license-poll-test-'));
  const state = {};
  const logs = [];
  const cfg = {
    licensing: { keygenAccount: 'test1' },
    ...(over.cfg || {})
  };
  return {
    state,
    appDir,
    getCfg: () => cfg,
    pushLog: (type, data) => logs.push({ type, data }),
    securityHeaders: { 'X-Test': '1' },
    timers: over.timers,
    _logs: logs,
    _appDir: appDir
  };
}

/**
 * Build a fake-timers harness that captures scheduled callbacks instead of
 * scheduling them on the real event loop. Tests then invoke the captured
 * callbacks on demand.
 */
function makeFakeTimers() {
  const intervals = [];   // { id, fn, ms, cleared }
  const timeouts = [];    // { id, fn, ms, cleared }
  let nextId = 1;
  return {
    setInterval: (fn, ms) => {
      const id = nextId++;
      intervals.push({ id, fn, ms, cleared: false });
      return id;
    },
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timeouts.push({ id, fn, ms, cleared: false });
      return id;
    },
    clearInterval: (id) => {
      const i = intervals.find(it => it.id === id);
      if (i) i.cleared = true;
      const t = timeouts.find(it => it.id === id);
      if (t) t.cleared = true;
    },
    clearTimeout: (id) => {
      const t = timeouts.find(it => it.id === id);
      if (t) t.cleared = true;
      const i = intervals.find(it => it.id === id);
      if (i) i.cleared = true;
    },
    _intervals: intervals,
    _timeouts: timeouts
  };
}

function makeValidResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        id: 'lic-1',
        type: 'licenses',
        attributes: { status: 'ACTIVE', expiry: null, scheme: 'ED25519_SIGN', metadata: {} }
      },
      meta: { valid: true, code: 'VALID', detail: 'is valid', ts: '2026-05-20T00:00:00Z' }
    })
  };
}

// ---------------------------------------------------------------------------
// Tests — R-5 poller schedule + overlap-guard
// ---------------------------------------------------------------------------

test('24h setInterval schedule fires once per 24h with timer injection', async () => {
  const timers = makeFakeTimers();
  const ctx = mockCtx({ timers });
  const realFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount++;
    return makeValidResponse();
  };
  try {
    const svc = createLicenseService(ctx);
    svc.loadStateFromDisk();
    svc.setLicenseKeyForTest('DVHB-TEST');
    svc.setStatusForTest('active');
    await svc.start();

    // Exactly one setInterval call, at the 24h cadence
    assert.equal(timers._intervals.length, 1);
    assert.equal(timers._intervals[0].ms, 24 * 60 * 60 * 1000);
    assert.equal(fetchCount, 0, 'start() must NOT fetch synchronously');

    // Fire the captured interval callback once — should drive one revalidate
    timers._intervals[0].fn();
    // Let microtasks settle (revalidate is async)
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    assert.equal(fetchCount, 1, 'interval tick should drive exactly one fetch');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('first validate runs 30s after boot, not immediately', async () => {
  const timers = makeFakeTimers();
  const ctx = mockCtx({ timers });
  const realFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount++;
    return makeValidResponse();
  };
  try {
    const svc = createLicenseService(ctx);
    svc.loadStateFromDisk();
    svc.setLicenseKeyForTest('DVHB-TEST');
    svc.setStatusForTest('active');
    await svc.start();

    // No fetch yet — only timers scheduled
    assert.equal(fetchCount, 0, 'fetch must NOT fire immediately on start()');
    assert.equal(timers._timeouts.length, 1, 'one setTimeout scheduled');
    assert.equal(timers._timeouts[0].ms, 30_000, 'initial validate scheduled at 30s');

    // Fire the boot setTimeout → first revalidate
    timers._timeouts[0].fn();
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    assert.equal(fetchCount, 1, 'boot revalidate fires after timeout callback');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('overlap-guard early-returns when a previous revalidate is in flight', async () => {
  const timers = makeFakeTimers();
  const ctx = mockCtx({ timers });
  const realFetch = globalThis.fetch;
  let fetchCount = 0;
  let resolveFirstFetch;
  // First fetch: returns a Promise we control. Subsequent fetches resolve
  // immediately with a VALID response.
  globalThis.fetch = () => {
    fetchCount++;
    if (fetchCount === 1) {
      return new Promise(r => {
        resolveFirstFetch = () => r(makeValidResponse());
      });
    }
    return Promise.resolve(makeValidResponse());
  };
  try {
    const svc = createLicenseService(ctx);
    svc.loadStateFromDisk();
    svc.setLicenseKeyForTest('DVHB-TEST');
    svc.setStatusForTest('active');
    await svc.start();

    // Trigger the interval callback twice — the second invocation must
    // early-return because the first revalidate is still in flight.
    timers._intervals[0].fn();
    // Let the in-flight revalidate begin (so revalidateInFlight === true).
    await new Promise(r => setImmediate(r));
    timers._intervals[0].fn();
    await new Promise(r => setImmediate(r));

    assert.equal(fetchCount, 1, 'overlap-guard must suppress the second concurrent call');

    // Release the first fetch — revalidateInFlight should reset.
    resolveFirstFetch();
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    // Now firing the interval again must drive a second fetch.
    timers._intervals[0].fn();
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    assert.equal(fetchCount, 2, 'after first revalidate settles, next tick drives a fresh fetch');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('close() clears both the boot timeout and the 24h interval', async () => {
  const timers = makeFakeTimers();
  const ctx = mockCtx({ timers });
  const svc = createLicenseService(ctx);
  svc.loadStateFromDisk();
  await svc.start();

  assert.equal(timers._intervals.length, 1);
  assert.equal(timers._timeouts.length, 1);
  assert.equal(timers._intervals[0].cleared, false);
  assert.equal(timers._timeouts[0].cleared, false);

  await svc.close();

  assert.equal(timers._intervals[0].cleared, true, 'close() must clear the 24h interval');
  assert.equal(timers._timeouts[0].cleared, true, 'close() must clear the boot setTimeout');
});
