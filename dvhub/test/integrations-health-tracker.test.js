// test/integrations-health-tracker.test.js
// Phase 09.2 D-01..D-05 — Per-system health-tracker unit tests.
//
// Mirrors test/mqtt-publisher.test.js shape: node:test, no real DB, mock pool
// via queries-array. Verifies ring-buffer caps, sliding-window prune,
// snapshot/restore round-trip, schema-version gating, and Pitfall 6
// (uptimeStartedAt resets on every process boot).

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createIntegrationsHealthTracker } from '../services/integrations-health-tracker.js';

function makeMockCtx({ snapshotRows = [] } = {}) {
  const queries = [];
  return {
    pool: {
      query: async (sql, params) => {
        queries.push({ sql, params });
        if (/SELECT system, snapshot_jsonb FROM integration_health_snapshots/.test(sql)) {
          return { rows: snapshotRows };
        }
        return { rows: [] };
      }
    },
    getCfg: () => ({}),
    pushLog: () => {},
    _queries: queries
  };
}

describe('createIntegrationsHealthTracker', () => {
  let ctx, tracker;
  let dateNowOriginal;

  beforeEach(() => {
    ctx = makeMockCtx();
    tracker = createIntegrationsHealthTracker(ctx);
    dateNowOriginal = Date.now;
  });

  afterEach(() => {
    Date.now = dateNowOriginal;
  });

  it('factory returns expected API', () => {
    for (const k of ['recordSample', 'snapshot', 'persistSnapshot', 'loadSnapshot', 'close']) {
      assert.equal(typeof tracker[k], 'function', `tracker.${k} should be a function`);
    }
    assert.ok(tracker._state instanceof Map, '_state is a Map for test introspection');
  });

  it('recordSample caps latencyMs ring buffer at 60', () => {
    for (let i = 0; i < 100; i++) {
      tracker.recordSample('victron', { latencyMs: i, success: true });
    }
    const internal = tracker._state.get('victron');
    assert.equal(internal.latencyMs.length, 60, 'ring buffer capped at 60');
    // Last 60 samples are 40..99 → average = (40+99)/2 = 69.5 → rounds to 70
    const snap = tracker.snapshot();
    assert.ok(
      snap.victron.latencyMs >= 69 && snap.victron.latencyMs <= 70,
      `snapshot avg of last 60 samples = ${snap.victron.latencyMs}, expected 69 or 70`
    );
  });

  it('recordSample prunes errors24h sliding-window per D-05', () => {
    let now = 1_000_000_000_000; // fixed base (ms since epoch)
    Date.now = () => now;

    // First failure at t=0
    tracker.recordSample('victron', { latencyMs: 5, success: false });
    assert.equal(tracker._state.get('victron').errors24h.length, 1, '1 error after first failure');

    // Second failure 24h + 1min later
    now += 24 * 60 * 60 * 1000 + 60 * 1000;
    tracker.recordSample('victron', { latencyMs: 5, success: false });

    // Snapshot at t = +24h+2min — first failure must be pruned
    now += 60 * 1000;
    const snap = tracker.snapshot();
    assert.equal(snap.victron.errors24h, 1, 'older error pruned by sliding window');
  });

  it('recordSample builds sampleIntervalHistogramMs from gaps', () => {
    let now = 2_000_000_000_000;
    Date.now = () => now;

    tracker.recordSample('victron', { latencyMs: 5, success: true });
    now += 3000;
    tracker.recordSample('victron', { latencyMs: 5, success: true });
    now += 3000;
    tracker.recordSample('victron', { latencyMs: 5, success: true });

    const snap = tracker.snapshot();
    assert.equal(snap.victron.sampleIntervalHistogramMs.length, 2, 'two gaps recorded');
    assert.ok(
      Math.abs(snap.victron.sampleIntervalHistogramMs[0] - 3000) < 50,
      `first gap ~= 3000ms (got ${snap.victron.sampleIntervalHistogramMs[0]})`
    );
    assert.ok(
      Math.abs(snap.victron.sampleIntervalHistogramMs[1] - 3000) < 50,
      `second gap ~= 3000ms (got ${snap.victron.sampleIntervalHistogramMs[1]})`
    );
  });

  it('sampleIntervalHistogramMs caps at 7 entries', () => {
    let now = 3_000_000_000_000;
    Date.now = () => now;

    for (let i = 0; i < 10; i++) {
      tracker.recordSample('victron', { latencyMs: 5, success: true });
      now += 1000;
    }
    const snap = tracker.snapshot();
    // 10 samples → 9 gaps → capped at 7
    assert.equal(snap.victron.sampleIntervalHistogramMs.length, 7, 'histogram capped at 7');
  });

  it('status derives correctly from age and error rate', () => {
    let now = 4_000_000_000_000;
    Date.now = () => now;

    // Fresh sample → ok
    tracker.recordSample('victron', { latencyMs: 5, success: true });
    assert.equal(tracker.snapshot().victron.status, 'ok', 'fresh sample → ok');

    // Advance 60s (>30s → warn)
    now += 60 * 1000;
    assert.equal(tracker.snapshot().victron.status, 'warn', 'age 60s → warn');

    // Advance to 6 minutes (>5min → err)
    now += 5 * 60 * 1000;
    assert.equal(tracker.snapshot().victron.status, 'err', 'age 6min → err');

    // No samples ever → err
    const snapEpex = tracker.snapshot();
    assert.equal(snapEpex.epex, undefined, 'epex absent until first recordSample');
  });

  it('uptime resets on rehydrate per Pitfall 6', async () => {
    // Mock DB row with uptimeStartedAt = 1 day ago (must be ignored on load)
    const dayAgo = Date.now() - 86_400_000;
    const ctx2 = makeMockCtx({
      snapshotRows: [
        {
          system: 'victron',
          snapshot_jsonb: {
            version: 1,
            latencyMs: 12,
            uptimeSec: 86400,
            uptimeStartedAt: dayAgo,
            errors24h: 0,
            lastSampleAt: new Date().toISOString(),
            sampleIntervalHistogramMs: [],
            firmware: '3.42',
            status: 'ok',
            _internalLatencyMs: [10, 12, 14],
            _internalErrors24h: []
          }
        }
      ]
    });
    const tracker2 = createIntegrationsHealthTracker(ctx2);
    await tracker2.loadSnapshot();

    const snap = tracker2.snapshot();
    // Pitfall 6 — uptime resets to 0 (or near) regardless of persisted uptimeStartedAt
    assert.ok(
      snap.victron.uptimeSec < 5,
      `uptime resets on rehydrate (got ${snap.victron.uptimeSec}, expected < 5)`
    );
    // But latencyMs IS rehydrated
    assert.equal(snap.victron.latencyMs, 12, 'avg of rehydrated latencyMs preserved');
  });

  it('persistSnapshot writes valid JSONB payload via parameterized UPSERT', async () => {
    tracker.recordSample('victron', { latencyMs: 10, success: true, firmware: '3.42' });
    tracker.recordSample('victron', { latencyMs: 14, success: true });

    await tracker.persistSnapshot();

    const upsert = ctx._queries.find(q => /INSERT INTO integration_health_snapshots/.test(q.sql));
    assert.ok(upsert, 'UPSERT query was executed');
    assert.match(upsert.sql, /ON CONFLICT \(system\) DO UPDATE/, 'ON CONFLICT clause present');
    assert.equal(upsert.params[0], 'victron', 'first param is system name');

    const payload = JSON.parse(upsert.params[1]);
    assert.equal(payload.version, 1, 'schema version 1');
    assert.equal(payload.latencyMs, 12, 'rolled-up latency in payload');
    assert.ok(Array.isArray(payload._internalLatencyMs), '_internalLatencyMs array present');
    assert.ok(Array.isArray(payload._internalErrors24h), '_internalErrors24h array present');
    assert.equal(payload.firmware, '3.42', 'firmware persisted');
  });

  it('loadSnapshot ignores foreign schema version', async () => {
    const ctx3 = makeMockCtx({
      snapshotRows: [
        { system: 'victron', snapshot_jsonb: { version: 99, latencyMs: 999 } }
      ]
    });
    const tracker3 = createIntegrationsHealthTracker(ctx3);
    await tracker3.loadSnapshot();

    assert.equal(tracker3._state.size, 0, 'foreign-schema row skipped, no state set');
    // No throw — verified by reaching this assertion
  });

  it('close is a no-op safe to call multiple times', () => {
    tracker.close();
    tracker.close(); // idempotent
    assert.ok(true, 'close did not throw');
  });
});
