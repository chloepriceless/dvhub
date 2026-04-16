import test from 'node:test';
import assert from 'node:assert/strict';

// Phase 07 Wave-0 scaffold — REVIEWS H5: UNSKIP in Plan 07-04 when
// services/forecast/forecast-snapshots.js is created.

test.skip('createForecastSnapshots factory returns start/close/writeSnapshot methods — UNSKIP when Plan 07-04 merges', async () => {
  const { createForecastSnapshots } = await import('../services/forecast/forecast-snapshots.js');
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
