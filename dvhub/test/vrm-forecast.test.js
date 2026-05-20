import test from 'node:test';
import assert from 'node:assert/strict';
import { createVrmForecast } from '../services/forecast/vrm-forecast.js';

// 18-01j: VRM forecast mirror into pv_forecasts(model='vrm')
//
// Purpose: vrm_forecasts is populated by epex-fetch.js (verified prod 2026-05-20
// pushLog vrmCount=56) but `SELECT COUNT(*) FROM pv_forecasts WHERE model='vrm'`
// returns 0. The ensemble merger and Phase 19 B1 PV-Provider Inspector read
// pv_forecasts to compare providers uniformly — VRM was invisible to them.
//
// This test file documents the side-effect contract: every successful
// readPvForecast() call ALSO persists its rows to pv_forecasts(model='vrm').
// epex-fetch.js is untouched (no double-write); vrm_forecasts continues to be
// the source-of-truth, and pv_forecasts gets a mirror so consumers see all
// providers uniformly. The mirror is fire-and-forget — a store failure must
// NOT break the read path.

function makeCtx({ dbRows = [], cfg = {} } = {}) {
  const logs = [];
  return {
    state: { forecast: { pv: {} } },
    getCfg: () => cfg,
    pushLog: (event, payload) => logs.push({ event, payload }),
    db: { query: async () => ({ rows: dbRows }) },
    logs
  };
}

function makeStoreSpy({ shouldThrow = false } = {}) {
  const calls = [];
  return {
    writePvForecasts: async (rows) => {
      calls.push(rows);
      if (shouldThrow) throw new Error('mock writePvForecasts failure');
    },
    calls
  };
}

// --- 18-01j: VRM mirror into pv_forecasts(model='vrm') ---

test('18-01j: readPvForecast mirrors solar_yield rows into pv_forecasts(model=vrm)', async () => {
  const ctx = makeCtx({
    dbRows: [
      { ts_utc: '2026-05-21T10:00:00Z', value_w: 1200 },
      { ts_utc: '2026-05-21T10:15:00Z', value_w: 1500 },
      { ts_utc: '2026-05-21T10:30:00Z', value_w: 1800 }
    ],
    cfg: { telemetry: { historyImport: { vrmToken: 'tok' } } }
  });
  const store = makeStoreSpy();
  const vrm = createVrmForecast(ctx, { store });
  const slots = await vrm.readPvForecast();
  assert.equal(store.calls.length, 1, 'writePvForecasts called exactly once');
  assert.equal(store.calls[0].length, 3, 'all 3 rows persisted');
  assert.ok(store.calls[0].every(r => r.model === 'vrm'), 'every row model=vrm');
  assert.ok(store.calls[0].every(r => Number.isFinite(r.power_w)), 'every row power_w is finite');
  assert.equal(slots.length, 3, 'return value unchanged shape');
});

test('18-01j: readPvForecast survives store.writePvForecasts failure (fire-and-forget)', async () => {
  const ctx = makeCtx({
    dbRows: [{ ts_utc: '2026-05-21T10:00:00Z', value_w: 1200 }]
  });
  const store = makeStoreSpy({ shouldThrow: true });
  const vrm = createVrmForecast(ctx, { store });
  const slots = await vrm.readPvForecast();
  assert.equal(slots.length, 1, 'still returns slots');
  assert.ok(
    ctx.logs.some(l => l.event === 'vrm_forecast_persist_error'),
    'logged vrm_forecast_persist_error on mirror failure'
  );
});

test('18-01j: readLoadForecast does NOT mirror to pv_forecasts (out of scope)', async () => {
  const ctx = makeCtx({
    dbRows: [{ ts_utc: '2026-05-21T10:00:00Z', value_w: 600 }]
  });
  const store = makeStoreSpy();
  const vrm = createVrmForecast(ctx, { store });
  await vrm.readLoadForecast();
  assert.equal(store.calls.length, 0, 'load forecast must not write to pv_forecasts');
  // Note: no pushLog assertion needed here — makeCtx's default pushLog just
  // collects events to ctx.logs for the rare test that needs them (Test 2).
  // This test only verifies the store side: writePvForecasts must remain uncalled.
});

test('18-01j: readPvForecast handles empty result without calling writePvForecasts', async () => {
  const ctx = makeCtx({ dbRows: [] });
  const store = makeStoreSpy();
  const vrm = createVrmForecast(ctx, { store });
  const result = await vrm.readPvForecast();
  assert.equal(result, null, 'returns null on empty');
  assert.equal(store.calls.length, 0, 'no mirror call on empty');
  // Note: makeCtx's default pushLog silently swallows any events emitted on
  // the empty path (e.g. potential vrm_forecast_empty diagnostic). If you
  // want to assert on log content, inspect ctx.logs — but this test
  // intentionally does NOT, because the null return + zero-call invariants
  // are the documented contract; log presence on empty is impl-detail.
});
