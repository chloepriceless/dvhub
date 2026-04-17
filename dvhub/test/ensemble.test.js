import test from 'node:test';
import assert from 'node:assert/strict';
import { computeWeights, mergeForecasts } from '../services/forecast/ensemble.js';

// Phase 07 Wave-1 (Plan 07-02): tests unskipped (REVIEWS H5 transition).
// services/forecast/ensemble.js now exports computeWeights + mergeForecasts.

test('computeWeights normalizes inverse MAE to sum=1.0', () => {
  const w = computeWeights({ pvnode: 100, solcast: 200, pvlib: 100 });
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1.0) < 1e-9, `weights sum=${sum}`);
  // Equal-MAE providers (pvnode=pvlib=100) get equal weight; solcast=200 gets half.
  assert.ok(Math.abs(w.pvnode - w.pvlib) < 1e-9);
  assert.ok(w.pvnode > w.solcast);
});

test('computeWeights returns {} when no valid MAE data', () => {
  assert.deepEqual(computeWeights({}), {});
  // Zero/negative/NaN MAE values treated as missing providers — expect {}.
  assert.deepEqual(computeWeights({ pvnode: 0, solcast: -10, pvlib: null }), {});
});

test('mergeForecasts sums weighted power_w per slot', () => {
  const providersBySlot = {
    pvnode: [{ ts_utc: '2026-04-17T12:00:00Z', power_w: 1000 }],
    solcast: [{ ts_utc: '2026-04-17T12:00:00Z', power_w: 2000 }]
  };
  const result = mergeForecasts(providersBySlot, { pvnode: 0.5, solcast: 0.5 });
  assert.equal(result.length, 1);
  assert.equal(result[0].power_w, 1500);
});
