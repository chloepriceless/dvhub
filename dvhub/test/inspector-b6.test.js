// test/inspector-b6.test.js — Phase 19 Plan 19-01 (GREEN by end of plan).
//
// Covers the B6 Optimizer-Cold inspector method — the only fully-implemented
// method in Plan 19-01. Other methods (B1..B5) are stubs and have their own
// scaffold tests (inspector-b1..b5) that stay RED until Plans 19-02..19-06.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInspector } from '../services/forecast/inspector.js';

function makeCtx() {
  return {
    state: { forecast: {}, schedule: {} },
    getCfg: () => ({}),
    pushLog: () => {},
  };
}

test('B6 returns isStale:true reason:never_run when no row', async () => {
  const telemetryStore = { getLatestOptimizerRun: async () => null };
  const inspector = createInspector(makeCtx(), { telemetryStore });
  const r = await inspector.getOptimizerCold();
  assert.equal(r.isStale, true);
  assert.equal(r.reason, 'never_run');
  assert.equal(r.lastRunAt, null);
  assert.equal(r.daysSinceLastRun, null);
});

test('B6 returns isStale:true when last run was 3 days ago', async () => {
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
  const inspector = createInspector(makeCtx(), {
    telemetryStore: {
      getLatestOptimizerRun: async () => ({ runStartedAt: threeDaysAgo, optimizer: 'internal' }),
    },
  });
  const r = await inspector.getOptimizerCold();
  assert.equal(r.isStale, true);
  assert.equal(r.optimizer, 'internal');
  assert.ok(r.daysSinceLastRun >= 2.0 && r.daysSinceLastRun <= 3.1,
    `daysSinceLastRun ${r.daysSinceLastRun} should be between 2.0 and 3.1`);
});

test('B6 returns isStale:false when last run was 1 hour ago', async () => {
  const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
  const inspector = createInspector(makeCtx(), {
    telemetryStore: {
      getLatestOptimizerRun: async () => ({ runStartedAt: oneHourAgo, optimizer: 'internal' }),
    },
  });
  const r = await inspector.getOptimizerCold();
  assert.equal(r.isStale, false);
  assert.ok(r.daysSinceLastRun >= 0 && r.daysSinceLastRun < 0.2,
    `daysSinceLastRun ${r.daysSinceLastRun} should be near 0 for 1-hour-old run`);
});

test('B6 returns telemetry_unavailable when telemetryStore missing', async () => {
  const inspector = createInspector(makeCtx(), { telemetryStore: null });
  const r = await inspector.getOptimizerCold();
  assert.equal(r.isStale, true);
  assert.equal(r.reason, 'telemetry_unavailable');
  assert.equal(r.lastRunAt, null);
});

test('B6 returns invalid_timestamp when runStartedAt is not parseable', async () => {
  const inspector = createInspector(makeCtx(), {
    telemetryStore: {
      getLatestOptimizerRun: async () => ({ runStartedAt: 'not-a-date', optimizer: 'internal' }),
    },
  });
  const r = await inspector.getOptimizerCold();
  assert.equal(r.isStale, true);
  assert.equal(r.reason, 'invalid_timestamp');
});

test('B6 catches query errors and returns query_failed', async () => {
  const inspector = createInspector(makeCtx(), {
    telemetryStore: {
      getLatestOptimizerRun: async () => { throw new Error('connection refused'); },
    },
  });
  const r = await inspector.getOptimizerCold();
  assert.equal(r.isStale, true);
  assert.equal(r.reason, 'query_failed');
});

// ──────────────────────────────────────────────────────────────────────────
// Plan 19-07 — Threshold boundary tests (yellow @ 2d, red @ 5d frontend-only).
//
// Backend reports daysSinceLastRun + isStale (>= 2d). Yellow vs red is a pure
// frontend distinction (settings.js + family.js share FORECAST_INSPECTOR_COLD_*
// constants). These 4 tests lock the boundary semantics so a future change to
// the stale threshold doesn't silently drift the banner colors.
// ──────────────────────────────────────────────────────────────────────────

test('isStale boundary — 1.9 days ago → isStale=false', async () => {
  const ts = new Date(Date.now() - 1.9 * 86400000).toISOString();
  const inspector = createInspector(makeCtx(), {
    telemetryStore: {
      getLatestOptimizerRun: async () => ({ runStartedAt: ts, optimizer: 'internal' }),
    },
  });
  const r = await inspector.getOptimizerCold();
  assert.equal(r.isStale, false);
});

test('isStale boundary — exactly 2.0 days ago → isStale=true', async () => {
  const ts = new Date(Date.now() - 2 * 86400000).toISOString();
  const inspector = createInspector(makeCtx(), {
    telemetryStore: {
      getLatestOptimizerRun: async () => ({ runStartedAt: ts, optimizer: 'internal' }),
    },
  });
  const r = await inspector.getOptimizerCold();
  assert.equal(r.isStale, true);
  assert.ok(r.daysSinceLastRun >= 2.0 && r.daysSinceLastRun <= 2.1,
    `daysSinceLastRun ${r.daysSinceLastRun} should be in [2.0, 2.1]`);
});

test('isStale at 4.9 days — still yellow zone (backend only reports days; frontend chooses color)', async () => {
  const ts = new Date(Date.now() - 4.9 * 86400000).toISOString();
  const inspector = createInspector(makeCtx(), {
    telemetryStore: {
      getLatestOptimizerRun: async () => ({ runStartedAt: ts, optimizer: 'internal' }),
    },
  });
  const r = await inspector.getOptimizerCold();
  assert.equal(r.isStale, true);
  assert.ok(r.daysSinceLastRun >= 4.8 && r.daysSinceLastRun <= 5.0,
    `daysSinceLastRun ${r.daysSinceLastRun} should be in [4.8, 5.0]`);
});

test('isStale at 5.0 days — red zone, backend reports days only', async () => {
  const ts = new Date(Date.now() - 5 * 86400000).toISOString();
  const inspector = createInspector(makeCtx(), {
    telemetryStore: {
      getLatestOptimizerRun: async () => ({ runStartedAt: ts, optimizer: 'internal' }),
    },
  });
  const r = await inspector.getOptimizerCold();
  assert.equal(r.isStale, true);
  assert.ok(r.daysSinceLastRun >= 5.0 && r.daysSinceLastRun <= 5.1,
    `daysSinceLastRun ${r.daysSinceLastRun} should be in [5.0, 5.1]`);
});
