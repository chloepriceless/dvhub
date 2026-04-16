import test from 'node:test';
import assert from 'node:assert/strict';

// Phase 07 Wave-0 scaffold — REVIEWS H5: UNSKIP in Plan 07-02 when
// services/forecast/ensemble.js is created.

test.skip('computeWeights normalizes inverse MAE to sum=1.0 — UNSKIP when Plan 07-02 merges', async () => {
  const { computeWeights } = await import('../services/forecast/ensemble.js');
  const w = computeWeights({ pvnode: 100, solcast: 200, pvlib: 100 });
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1.0) < 1e-9);
});

test.skip('computeWeights returns {} when no valid MAE data — UNSKIP when Plan 07-02 merges', async () => {
  const { computeWeights } = await import('../services/forecast/ensemble.js');
  assert.deepEqual(computeWeights({}), {});
});

test.skip('mergeForecasts sums weighted power_w per slot — UNSKIP when Plan 07-02 merges', async () => {
  const { mergeForecasts } = await import('../services/forecast/ensemble.js');
  const providersBySlot = {
    pvnode: [{ ts_utc: '2026-04-17T12:00:00Z', power_w: 1000 }],
    solcast: [{ ts_utc: '2026-04-17T12:00:00Z', power_w: 2000 }]
  };
  const result = mergeForecasts(providersBySlot, { pvnode: 0.5, solcast: 0.5 });
  assert.equal(result.length, 1);
  assert.equal(result[0].power_w, 1500);
});
