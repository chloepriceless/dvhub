import test from 'node:test';
import assert from 'node:assert/strict';
import { createForecastSnapshots } from '../services/forecast/forecast-snapshots.js';

// Phase 07 Plan 07-04: Wave-0 scaffold unskipped (REVIEWS H5 transition).

test('createForecastSnapshots factory returns start/close/writeSnapshot methods', () => {
  const mockCtx = { getCfg: () => ({}), pushLog: () => {} };
  const mockStore = {
    insertSnapshot: async () => {},
    query: async () => ({ rows: [], rowCount: 0 })
  };
  const svc = createForecastSnapshots(mockCtx, { store: mockStore, forecastService: {} });
  assert.equal(typeof svc.start, 'function');
  assert.equal(typeof svc.close, 'function');
  assert.equal(typeof svc.writeSnapshot, 'function');
});

test('writeSnapshot writes forecast_date + target_date per slot (REVIEWS H1)', async () => {
  const inserted = [];
  const mockStore = {
    insertSnapshot: async (row) => { inserted.push(row); },
    query: async () => ({ rows: [], rowCount: 0 })
  };
  const svc = createForecastSnapshots(
    { pushLog: () => {} },
    { store: mockStore, forecastService: {} }
  );
  const res = await svc.writeSnapshot({
    forecast_date: '2026-04-17',
    pvnode: [{ ts_utc: '2026-04-18T10:00:00.000Z', power_w: 1500 }],
    solcast: [],
    pvlib: [],
    merged: [{ ts_utc: '2026-04-18T10:00:00.000Z', power_w: 1500 }],
    ml: []
  });
  assert.equal(res.ok, true);
  assert.equal(res.slotsWritten, 2);
  for (const row of inserted) {
    assert.equal(row.forecast_date, '2026-04-17');
    assert.equal(row.target_date, '2026-04-18');
  }
});

test('writeSnapshot rejects nowcast-source writes (Pitfall S-1)', async () => {
  const svc = createForecastSnapshots(
    { pushLog: () => {} },
    {
      store: { insertSnapshot: async () => {}, query: async () => ({ rows: [], rowCount: 0 }) },
      forecastService: {}
    }
  );
  const res = await svc.writeSnapshot({
    source: 'nowcast',
    merged: [{ ts_utc: '2026-04-18T10:00:00.000Z', power_w: 999 }]
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'nowcast_source_not_allowed');
});

test('writeSnapshot short-circuits on same-day re-invocation (in-memory guard)', async () => {
  let inserts = 0;
  const svc = createForecastSnapshots(
    { pushLog: () => {} },
    {
      store: {
        insertSnapshot: async () => { inserts++; },
        query: async () => ({ rows: [], rowCount: 0 })
      },
      forecastService: {}
    }
  );
  const payload = { forecast_date: '2026-04-17', merged: [{ ts_utc: '2026-04-18T10:00:00.000Z', power_w: 100 }] };
  await svc.writeSnapshot(payload);
  const res = await svc.writeSnapshot(payload);
  assert.equal(res.skipped, true);
  assert.equal(inserts, 1);
});

// T-0105: at boot the event-driven writeSnapshot can race ahead of
// forecast-store.ensureSchema() (pool=null) → previously 8× snapshots_insert_error.
// The store.isReady() guard must defer cleanly (no DB calls) and the deferred
// day must still get written once the pool is up (no latch on the skip).
test('writeSnapshot defers without any DB call while store not ready, then writes once ready (T-0105)', async () => {
  let ready = false;
  let inserts = 0;
  let queries = 0;
  const events = [];
  const mockStore = {
    isReady: () => ready,
    insertSnapshot: async () => { inserts++; },
    query: async () => { queries++; return { rows: [], rowCount: 0 }; }
  };
  const svc = createForecastSnapshots(
    { pushLog: (e) => events.push(e) },
    { store: mockStore, forecastService: {} }
  );
  const payload = { forecast_date: '2026-04-17', merged: [{ ts_utc: '2026-04-18T10:00:00.000Z', power_w: 100 }] };

  // Boot race: pool not ready → clean defer, zero DB calls (no insert/query errors).
  const deferred = await svc.writeSnapshot(payload);
  assert.equal(deferred.ok, false);
  assert.equal(deferred.reason, 'db_not_ready');
  assert.equal(inserts, 0);
  assert.equal(queries, 0);
  assert.ok(events.includes('snapshots_skip_db_not_ready'));

  // Pool comes up → retry proceeds (the defer did NOT latch lastSnapshotForecastDate).
  ready = true;
  const written = await svc.writeSnapshot(payload);
  assert.equal(written.ok, true);
  assert.equal(written.slotsWritten, 1);
  assert.equal(inserts, 1);
});

// Backward-compat: a store WITHOUT isReady (older mock / shape) is treated as ready.
test('writeSnapshot proceeds when store has no isReady() (backward-compat)', async () => {
  let inserts = 0;
  const svc = createForecastSnapshots(
    { pushLog: () => {} },
    { store: { insertSnapshot: async () => { inserts++; }, query: async () => ({ rows: [], rowCount: 0 }) }, forecastService: {} }
  );
  const res = await svc.writeSnapshot({ forecast_date: '2026-04-17', merged: [{ ts_utc: '2026-04-18T10:00:00.000Z', power_w: 100 }] });
  assert.equal(res.ok, true);
  assert.equal(inserts, 1);
});
