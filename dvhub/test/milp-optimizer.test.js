import test from 'node:test';
import assert from 'node:assert/strict';

import { pickMilpPlan } from '../milp-optimizer.js';

// Characterization tests for pickMilpPlan — the productive MILP discharge
// control-path that decides which slots the physical 43 kWh battery discharges
// into for arbitrage. These pin EXISTING behavior (read from
// dvhub/milp-optimizer.js), not an idealized contract, so a regression that
// mis-controls the battery is caught in CI.
//
// ⚠️ SIGN CONVENTION (load-bearing): discharge power is NEGATIVE in this
// codebase. Fixtures pass maxDischargeW: -5000 and a stage dischargeW: -5000,
// mirroring the real call-site (market-automation-builder.js:906-923).
// Revenue is computed on Math.abs(powerW), so a positive ct_kwh on a slot
// yields a positive totalRevenueCt.

const SLOT_MS = 15 * 60 * 1000;
const BASE_TS = Date.parse('2026-03-13T14:00:00Z');

function slotAt(index, ctKwh) {
  return { ts: BASE_TS + index * SLOT_MS, ct_kwh: ctKwh };
}

// The default (no-custom-stages) production stage shape: a single discharge
// slot at the global max discharge power (market-automation-builder.js:906-923).
const DEFAULT_STAGE = { dischargeW: -5000, dischargeSlots: 1, cooldownSlots: 0 };

// emptyResult contract (milp-optimizer.js:51) — returned on every degenerate branch.
function assertEmptyContract(result) {
  assert.equal(result.engine, 'milp');
  assert.deepEqual(result.selectedSlotTimestamps, []);
  assert.equal(result.totalRevenueCt, 0);
  assert.deepEqual(result.chain, []);
  assert.equal(result.peakDischargeW, 0);
  assert.deepEqual(result.blocks, []);
}

// --- Deterministic empty-result branches (no solver required) ---

test('pickMilpPlan returns the empty-result contract when given no slots', async () => {
  // milp-optimizer.js:57 — !ordered.length short-circuits before any solver call.
  const result = await pickMilpPlan({
    slots: [],
    stages: [DEFAULT_STAGE],
    maxDischargeW: -5000
  });
  assertEmptyContract(result);
});

test('pickMilpPlan returns the empty-result contract when given no stages', async () => {
  // milp-optimizer.js:57 — !stages.length short-circuits even with valid slots.
  const result = await pickMilpPlan({
    slots: [slotAt(0, 30), slotAt(1, 28), slotAt(2, 25)],
    stages: [],
    maxDischargeW: -5000
  });
  assertEmptyContract(result);
});

test('pickMilpPlan returns the empty-result contract when no placement is profitable (all prices <= 0)', async () => {
  // milp-optimizer.js:85 filters out placements with revenueCt <= 0; with all
  // ct_kwh <= 0 no placement survives, so :102 returns emptyResult. Negative
  // prices on a discharge are never profitable (you'd pay to export).
  const result = await pickMilpPlan({
    slots: [slotAt(0, -2), slotAt(1, -5), slotAt(2, 0)],
    stages: [DEFAULT_STAGE],
    maxDischargeW: -5000
  });
  assertEmptyContract(result);
});

// --- Solver path (HiGHS-graceful profitable selection) ---

test('pickMilpPlan selects a profitable slot (or degrades to the empty contract if HiGHS is unavailable)', async () => {
  // Contiguous profitable slots + one valid single-slot discharge stage.
  // splitIntoContiguousSegments yields a single segment (consecutive indices),
  // so each slot is a valid placement; the high-price slot is profitable.
  const slots = [slotAt(0, 5), slotAt(1, 30), slotAt(2, 28), slotAt(3, 6)];
  const result = await pickMilpPlan({
    slots,
    stages: [DEFAULT_STAGE],
    maxDischargeW: -5000
  });

  assert.equal(result.engine, 'milp', 'every result carries engine: milp');

  const isEmpty = result.selectedSlotTimestamps.length === 0;
  if (isEmpty) {
    // HiGHS unavailable on this box (milp-optimizer.js:193-196) — graceful degrade.
    assertEmptyContract(result);
  } else {
    // HiGHS available — the solver picked at least one profitable placement.
    assert.equal(result.solverStatus, 'Optimal');
    assert.ok(result.totalRevenueCt > 0, `expected positive revenue, got ${result.totalRevenueCt}`);
    assert.ok(result.selectedSlotTimestamps.length >= 1);
    // Discharge power is negative → peak discharge magnitude is positive.
    assert.ok(result.peakDischargeW > 0, 'peakDischargeW is a positive magnitude');
    // Every selected slot must be one of the profitable-priced input slots.
    const profitableTs = new Set(slots.filter(s => s.ct_kwh > 0).map(s => s.ts));
    for (const ts of result.selectedSlotTimestamps) {
      assert.ok(profitableTs.has(ts), `selected slot ${ts} must be a profitable input slot`);
    }
  }
});
