// Plan 09-08 Task 4 — forecast-batch-insert tests.
// Verifies the two new batch methods on createForecastStore's return-object:
//   insertPvForecastBatch(rows) → single multi-row INSERT INTO pv_forecasts
//   insertSnapshotBatch(rows)   → single multi-row INSERT INTO forecast_snapshots
// We mock the pg pool's query method to inspect the SQL and parameters that the
// batch methods build. No real Postgres connection is required.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createForecastStore } from '../services/forecast/forecast-store.js';

/**
 * Build a forecast store wired to a fake pg pool that records every query.
 * Returns { store, calls } where `calls` is an array of { sql, params }.
 */
function makeStoreWithMockPool() {
  const calls = [];
  const fakePool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }
  };
  const store = createForecastStore({
    state: {},
    getCfg: () => ({}),
    pushLog: () => {},
    db: {}
  });
  // ensureSchema accepts a pool — replace the SCHEMA_SQL execution by directly
  // injecting the pool. We can't await ensureSchema because that would also
  // issue a CREATE TABLE call; instead we hand-set pool via the same code path.
  // The factory exposes pool via closure only, so we call ensureSchema with
  // a pool whose query swallows the schema DDL into `calls` and then clear it.
  return { store, calls, fakePool };
}

async function initStore() {
  const { store, calls, fakePool } = makeStoreWithMockPool();
  await store.ensureSchema(fakePool);
  calls.length = 0; // drop the schema DDL call so test assertions are clean
  return { store, calls };
}

test('insertPvForecastBatch issues a single INSERT for N rows with correct placeholders', async () => {
  const { store, calls } = await initStore();
  const rows = [
    { model: 'combined', ts_utc: '2026-05-11T00:00:00Z', power_w: 100, confidence: 0.5 },
    { model: 'combined', ts_utc: '2026-05-11T00:15:00Z', power_w: 200, confidence: 0.5 },
    { model: 'combined', ts_utc: '2026-05-11T00:30:00Z', power_w: 300, confidence: 0.5 }
  ];
  await store.insertPvForecastBatch(rows);

  assert.equal(calls.length, 1, 'exactly one DB call for N=3 rows');
  const { sql, params } = calls[0];
  assert.match(sql, /INSERT INTO pv_forecasts/);
  assert.match(sql, /ON CONFLICT \(model, ts_utc\)/, 'ON CONFLICT key matches single-row variant');
  assert.match(sql, /\(\$1, \$2, \$3, \$4, \$5\)/, 'first row placeholder group');
  assert.match(sql, /\(\$6, \$7, \$8, \$9, \$10\)/, 'second row placeholder group');
  assert.match(sql, /\(\$11, \$12, \$13, \$14, \$15\)/, 'third row placeholder group');
  assert.equal(params.length, 15, '5 cols × 3 rows = 15 params');
  assert.equal(params[0], 'combined');
  assert.equal(params[2], 100);
  // Row 2 starts at index 5: [model, ts_utc, power_w, confidence, meta_json]
  assert.equal(params[6], '2026-05-11T00:15:00Z');
  assert.equal(params[7], 200);
});

test('insertPvForecastBatch on empty array is a no-op (no DB call)', async () => {
  const { store, calls } = await initStore();
  await store.insertPvForecastBatch([]);
  assert.equal(calls.length, 0);
  await store.insertPvForecastBatch(null);
  assert.equal(calls.length, 0);
});

test('insertPvForecastBatch coerces NaN power_w to 0 (mirrors single-row variant)', async () => {
  const { store, calls } = await initStore();
  await store.insertPvForecastBatch([
    { model: 'pvlib', ts_utc: '2026-05-11T00:00:00Z', power_w: 'not-a-number', confidence: 0.4 }
  ]);
  const { params } = calls[0];
  // params: [model, ts_utc, power, confidence, meta_json]
  assert.equal(params[2], 0, 'NaN coerced to 0 — broken row does not abort the batch');
});

test('insertPvForecastBatch defaults confidence to 0.3 and meta_json to null', async () => {
  const { store, calls } = await initStore();
  await store.insertPvForecastBatch([
    { model: 'pvlib', ts_utc: '2026-05-11T00:00:00Z', power_w: 500 }
  ]);
  const { params } = calls[0];
  assert.equal(params[3], 0.3);
  assert.equal(params[4], null);
});

test('insertSnapshotBatch issues a single INSERT with target_date defaulting to slot date', async () => {
  const { store, calls } = await initStore();
  const rows = [
    { forecast_date: '2026-05-11', slot_utc: '2026-05-10T08:00:00Z', layer: 'pvnode', power_w: 800 },
    { forecast_date: '2026-05-11', slot_utc: '2026-05-10T08:15:00Z', layer: 'pvnode', power_w: 900 }
  ];
  await store.insertSnapshotBatch(rows);

  assert.equal(calls.length, 1, 'one DB call for batch');
  const { sql, params } = calls[0];
  assert.match(sql, /INSERT INTO forecast_snapshots/);
  assert.match(sql, /ON CONFLICT \(target_date, slot_utc, layer\)/);
  assert.match(sql, /\(\$1, \$2, \$3, \$4, \$5\)/);
  assert.match(sql, /\(\$6, \$7, \$8, \$9, \$10\)/);
  assert.equal(params.length, 10, '5 cols × 2 rows');
  // params: [forecast_date, target_date, slot_utc, layer, power_w] per row
  assert.equal(params[0], '2026-05-11');
  assert.equal(params[1], '2026-05-10', 'target_date defaulted from slot_utc date');
  assert.equal(params[2], '2026-05-10T08:00:00Z');
  assert.equal(params[3], 'pvnode');
  assert.equal(params[4], 800);
});

test('insertSnapshotBatch respects explicit target_date when caller provides it', async () => {
  const { store, calls } = await initStore();
  await store.insertSnapshotBatch([
    {
      forecast_date: '2026-05-11',
      target_date: '2026-05-09', // explicit — must NOT be overridden
      slot_utc: '2026-05-10T08:00:00Z',
      layer: 'pvnode',
      power_w: 800
    }
  ]);
  assert.equal(calls[0].params[1], '2026-05-09', 'explicit target_date preserved');
});

test('insertSnapshotBatch on empty array is a no-op', async () => {
  const { store, calls } = await initStore();
  await store.insertSnapshotBatch([]);
  assert.equal(calls.length, 0);
});

test('insertPvForecastBatch and insertSnapshotBatch are attached to the factory return-object', async () => {
  const { store } = await initStore();
  assert.equal(typeof store.insertPvForecastBatch, 'function');
  assert.equal(typeof store.insertSnapshotBatch, 'function');
});
