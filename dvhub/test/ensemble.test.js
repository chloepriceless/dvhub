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

// Test B — Full coverage = identity. Both providers present in the slot, Σw = 1.0,
// so per-slot renorm on the effective weight sum is a no-op: result stays bit-identical
// to the legacy Σ(p*w) behaviour (1500). Phase 26-02 must NOT change this value.
test('mergeForecasts sums weighted power_w per slot (full coverage = identity, 1500)', () => {
  const providersBySlot = {
    pvnode: [{ ts_utc: '2026-04-17T12:00:00Z', power_w: 1000 }],
    solcast: [{ ts_utc: '2026-04-17T12:00:00Z', power_w: 2000 }]
  };
  const result = mergeForecasts(providersBySlot, { pvnode: 0.5, solcast: 0.5 });
  assert.equal(result.length, 1);
  assert.equal(result[0].power_w, 1500);
});

// Test A (Phase 26-02 RED) — Partial slot coverage must renorm on the effective
// present-provider weight sum, NOT divide by 1.0. pvnode covers slots X and Y;
// solcast covers only slot X. weights {pvnode:0.5, solcast:0.5}.
//  - Slot X (both present): (1000*0.5 + 3000*0.5) / (0.5+0.5) = 2000.
//  - Slot Y (pvnode only): (2000*0.5) / 0.5 = 2000 (== pvnode_y; NO underestimation).
// Pre-fix the slot-Y value is 2000*0.5 = 1000 (systematic underestimation) → this assert FAILS.
test('mergeForecasts renorms partial coverage on present weightSum (no underestimation)', () => {
  const X = '2026-04-17T11:00:00Z';
  const Y = '2026-04-17T12:00:00Z';
  const providersBySlot = {
    pvnode: [
      { ts_utc: X, power_w: 1000 },
      { ts_utc: Y, power_w: 2000 } // solcast absent in Y
    ],
    solcast: [
      { ts_utc: X, power_w: 3000 }
    ]
  };
  const result = mergeForecasts(providersBySlot, { pvnode: 0.5, solcast: 0.5 });
  const bySlot = Object.fromEntries(result.map(r => [r.ts_utc, r.power_w]));
  // Slot X: both providers → weighted mean over Σw=1.0.
  assert.equal(bySlot[X], 2000);
  // Slot Y: only pvnode present → renorm on its own weight (0.5/0.5=1) → pvnode_y unchanged.
  assert.equal(bySlot[Y], 2000);
});

// Test C (Phase 26-02) — Determinism: accumulate-then-divide must be invariant to
// provider/object-key iteration order. Same inputs, reversed key order → identical array.
test('mergeForecasts is invariant to provider iteration order', () => {
  const X = '2026-04-17T11:00:00Z';
  const Y = '2026-04-17T12:00:00Z';
  const pvnode = [{ ts_utc: X, power_w: 1000 }, { ts_utc: Y, power_w: 2000 }];
  const solcast = [{ ts_utc: X, power_w: 3000 }];
  const weights = { pvnode: 0.5, solcast: 0.5 };
  const forward = mergeForecasts({ pvnode, solcast }, weights);
  const reversed = mergeForecasts({ solcast, pvnode }, weights);
  assert.deepEqual(reversed, forward);
});
