import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAutomationRuleChain,
  computeAvailableEnergyKwh,
  computeEnergyBasedSlotAllocation,
  computeDynamicAutomationMinSocPct,
  filterFreeAutomationSlots,
  pickBestAutomationPlan,
  splitIntoContiguousSegments
} from '../small-market-automation.js';

const SLOT_MS = 15 * 60 * 1000;
const BASE_TS = Date.parse('2026-03-13T14:00:00Z');
function slotAt(index, ctKwh) {
  return { ts: BASE_TS + index * SLOT_MS, ct_kwh: ctKwh };
}

// --- buildAutomationRuleChain ---

test('buildAutomationRuleChain caps stage power at the global max discharge', () => {
  assert.deepEqual(
    buildAutomationRuleChain({
      maxDischargeW: -18000,
      stages: [
        { dischargeW: -19000, dischargeSlots: 1, cooldownW: -8000, cooldownSlots: 1 }
      ]
    }),
    [
      { powerW: -18000, slots: 1 },
      { powerW: -8000, slots: 1 }
    ]
  );
});

test('buildAutomationRuleChain forces positive dischargeW to negative', () => {
  const result = buildAutomationRuleChain({
    maxDischargeW: -18000,
    stages: [{ dischargeW: 8000, dischargeSlots: 1 }]
  });
  assert.equal(result[0].powerW, -8000);
});

test('buildAutomationRuleChain forces positive maxDischargeW to negative', () => {
  const result = buildAutomationRuleChain({
    maxDischargeW: 12000,
    stages: [{ dischargeW: -8000, dischargeSlots: 1 }]
  });
  assert.equal(result[0].powerW, -8000);
});

test('buildAutomationRuleChain forces positive cooldownW to negative', () => {
  const result = buildAutomationRuleChain({
    maxDischargeW: -18000,
    stages: [{ dischargeW: -18000, dischargeSlots: 1, cooldownW: 5000, cooldownSlots: 1 }]
  });
  assert.equal(result[1].powerW, -5000);
});

test('buildAutomationRuleChain handles empty stages gracefully', () => {
  assert.deepEqual(buildAutomationRuleChain({ maxDischargeW: -10000, stages: [] }), []);
});

test('buildAutomationRuleChain handles non-array stages gracefully', () => {
  assert.deepEqual(buildAutomationRuleChain({ maxDischargeW: -10000, stages: null }), []);
});

// --- computeDynamicAutomationMinSocPct ---

test('computeDynamicAutomationMinSocPct relaxes linearly toward the global min by sunrise', () => {
  const result = computeDynamicAutomationMinSocPct({
    automationMinSocPct: 30,
    globalMinSocPct: 3,
    sunsetTs: Date.parse('2026-06-01T20:00:00+02:00'),
    sunriseTs: Date.parse('2026-06-02T06:00:00+02:00'),
    nowTs: Date.parse('2026-06-02T01:00:00+02:00')
  });
  assert.equal(result, 16.5);
});

test('computeDynamicAutomationMinSocPct returns automationMin before sunset', () => {
  const result = computeDynamicAutomationMinSocPct({
    automationMinSocPct: 30,
    globalMinSocPct: 3,
    sunsetTs: Date.parse('2026-06-01T20:00:00+02:00'),
    sunriseTs: Date.parse('2026-06-02T06:00:00+02:00'),
    nowTs: Date.parse('2026-06-01T18:00:00+02:00')
  });
  assert.equal(result, 30);
});

test('computeDynamicAutomationMinSocPct returns globalMin at or after sunrise', () => {
  const result = computeDynamicAutomationMinSocPct({
    automationMinSocPct: 30,
    globalMinSocPct: 3,
    sunsetTs: Date.parse('2026-06-01T20:00:00+02:00'),
    sunriseTs: Date.parse('2026-06-02T06:00:00+02:00'),
    nowTs: Date.parse('2026-06-02T06:00:00+02:00')
  });
  assert.equal(result, 3);
});

test('computeDynamicAutomationMinSocPct returns automationMin when times are missing', () => {
  assert.equal(computeDynamicAutomationMinSocPct({
    automationMinSocPct: 25,
    globalMinSocPct: 5,
    sunsetTs: null,
    sunriseTs: null,
    nowTs: Date.now()
  }), 25);
});

// --- filterFreeAutomationSlots ---

test('filterFreeAutomationSlots excludes slots already occupied by manual rules', () => {
  const result = filterFreeAutomationSlots({
    slots: [
      { ts: 1, ct_kwh: 20 },
      { ts: 2, ct_kwh: 30 }
    ],
    occupiedWindows: [
      { startTs: 2, endTs: 3, source: 'manual' }
    ]
  });
  assert.deepEqual(result.map((slot) => slot.ts), [1]);
});

test('filterFreeAutomationSlots returns all slots when no windows overlap', () => {
  const result = filterFreeAutomationSlots({
    slots: [{ ts: 10, ct_kwh: 5 }, { ts: 20, ct_kwh: 8 }],
    occupiedWindows: [{ startTs: 30, endTs: 40 }]
  });
  assert.equal(result.length, 2);
});

test('filterFreeAutomationSlots handles empty inputs', () => {
  assert.deepEqual(filterFreeAutomationSlots({ slots: [], occupiedWindows: [] }), []);
  assert.deepEqual(filterFreeAutomationSlots({ slots: null, occupiedWindows: [] }), []);
});

// --- splitIntoContiguousSegments ---

test('splitIntoContiguousSegments groups adjacent slots', () => {
  const slots = [slotAt(0, 10), slotAt(1, 20), slotAt(3, 15), slotAt(4, 25)];
  const segs = splitIntoContiguousSegments(slots, SLOT_MS);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].length, 2); // slots 0,1
  assert.equal(segs[1].length, 2); // slots 3,4
});

test('splitIntoContiguousSegments handles empty input', () => {
  assert.deepEqual(splitIntoContiguousSegments([], SLOT_MS), []);
});

// --- pickBestAutomationPlan (contiguous window optimizer) ---

test('pickBestAutomationPlan finds best contiguous window for discharge+cooldown chain', () => {
  // 4 contiguous slots: index 0=10ct, 1=28ct, 2=27ct, 3=15ct
  // Chain: 1 slot discharge (-18kW) + 1 slot cooldown (-8kW)
  // Window [0,1]: rev = 10*18*0.25/1000*100 + 28*8*0.25/1000*100 ... use ct directly
  // Window [0,1]: 18*0.25*10 + 8*0.25*28 = 45 + 56 = 101
  // Window [1,2]: 18*0.25*28 + 8*0.25*27 = 126 + 54 = 180
  // Window [2,3]: 18*0.25*27 + 8*0.25*15 = 121.5 + 30 = 151.5
  const plan = pickBestAutomationPlan({
    slots: [slotAt(0, 10), slotAt(1, 28), slotAt(2, 27), slotAt(3, 15)],
    chainOptions: [
      [{ powerW: -18000, slots: 1 }, { powerW: -8000, slots: 1 }]
    ],
    slotDurationMs: SLOT_MS
  });

  assert.deepEqual(plan.selectedSlotTimestamps, [slotAt(1, 0).ts, slotAt(2, 0).ts]);
  assert.equal(plan.totalRevenueCt, 180);
});

test('pickBestAutomationPlan enforces contiguity — skips non-adjacent high-price slots', () => {
  // Slot 0=30ct, slot 1=5ct, slot 2=5ct, slot 3=29ct
  // Old algorithm would pick slots 0+3 (top 2 by price). New one must pick contiguous.
  // Chain: 2 uniform slots at -10kW
  // Window [0,1]: 10*0.25*30 + 10*0.25*5 = 75+12.5 = 87.5
  // Window [1,2]: 10*0.25*5 + 10*0.25*5 = 12.5+12.5 = 25
  // Window [2,3]: 10*0.25*5 + 10*0.25*29 = 12.5+72.5 = 85
  const plan = pickBestAutomationPlan({
    slots: [slotAt(0, 30), slotAt(1, 5), slotAt(2, 5), slotAt(3, 29)],
    chainOptions: [[{ powerW: -10000, slots: 2 }]],
    slotDurationMs: SLOT_MS
  });

  assert.deepEqual(plan.selectedSlotTimestamps, [slotAt(0, 0).ts, slotAt(1, 0).ts]);
  assert.equal(plan.totalRevenueCt, 87.5);
});

test('pickBestAutomationPlan respects discharge+cooldown pattern in contiguous window', () => {
  // Stage: 1 discharge slot at -18kW + 3 cooldown slots at -10kW = 4 slots total
  // 6 contiguous slots with prices: 5, 20, 18, 16, 14, 25
  // Window [0..3]: 18*0.25*5 + 10*0.25*20 + 10*0.25*18 + 10*0.25*16 = 22.5+50+45+40 = 157.5
  // Window [1..4]: 18*0.25*20 + 10*0.25*18 + 10*0.25*16 + 10*0.25*14 = 90+45+40+35 = 210
  // Window [2..5]: 18*0.25*18 + 10*0.25*16 + 10*0.25*14 + 10*0.25*25 = 81+40+35+62.5 = 218.5
  const plan = pickBestAutomationPlan({
    slots: [slotAt(0, 5), slotAt(1, 20), slotAt(2, 18), slotAt(3, 16), slotAt(4, 14), slotAt(5, 25)],
    chainOptions: [
      [{ powerW: -18000, slots: 1 }, { powerW: -10000, slots: 3 }]
    ],
    slotDurationMs: SLOT_MS
  });

  assert.deepEqual(plan.selectedSlotTimestamps, [
    slotAt(2, 0).ts, slotAt(3, 0).ts, slotAt(4, 0).ts, slotAt(5, 0).ts
  ]);
  assert.equal(plan.totalRevenueCt, 218.5);
  assert.equal(plan.peakDischargeW, 18000);
});

test('pickBestAutomationPlan returns empty plan when no contiguous window fits', () => {
  // 2 slots with a gap — chain needs 2 contiguous
  const plan = pickBestAutomationPlan({
    slots: [slotAt(0, 30), slotAt(5, 29)], // gap of 4 slots between them
    chainOptions: [[{ powerW: -10000, slots: 2 }]],
    slotDurationMs: SLOT_MS
  });

  assert.deepEqual(plan.selectedSlotTimestamps, []);
  assert.equal(plan.totalRevenueCt, -Infinity);
});

test('pickBestAutomationPlan selects lower peak discharge when revenue is tied', () => {
  // 2 contiguous slots, same price
  const plan = pickBestAutomationPlan({
    slots: [slotAt(0, 20), slotAt(1, 20)],
    chainOptions: [
      [{ powerW: -15000, slots: 1 }, { powerW: -5000, slots: 1 }],
      [{ powerW: -10000, slots: 2 }]
    ],
    slotDurationMs: SLOT_MS
  });
  // Chain1: 15*0.25*20 + 5*0.25*20 = 75+25 = 100ct, peak=15000
  // Chain2: 10*0.25*20 + 10*0.25*20 = 50+50 = 100ct, peak=10000 → wins
  assert.equal(plan.peakDischargeW, 10000);
});

test('pickBestAutomationPlan handles empty slots gracefully', () => {
  const plan = pickBestAutomationPlan({
    slots: [],
    chainOptions: []
  });
  assert.deepEqual(plan.selectedSlotTimestamps, []);
});

// --- estimateSlotRevenueCt (validated through pickBestAutomationPlan) ---

test('revenue calculation uses kW not W (18kW * 0.25h * 28ct/kWh = 126ct)', () => {
  const plan = pickBestAutomationPlan({
    slots: [slotAt(0, 28)],
    chainOptions: [[{ powerW: -18000, slots: 1 }]],
    slotDurationMs: SLOT_MS
  });
  assert.equal(plan.totalRevenueCt, 126);
});

test('estimateSlotRevenueCt uses 15-minute (0.25h) slot duration', () => {
  const plan = pickBestAutomationPlan({
    slots: [slotAt(0, 40)],
    chainOptions: [[{ powerW: -10000, slots: 1 }]],
    slotDurationMs: SLOT_MS
  });
  assert.equal(plan.totalRevenueCt, 100);
});

// --- computeAvailableEnergyKwh ---

test('computeAvailableEnergyKwh calculates correctly (25.6kWh, SOC95→30, eff85)', () => {
  const result = computeAvailableEnergyKwh({
    batteryCapacityKwh: 25.6,
    currentSocPct: 95,
    minSocPct: 30,
    inverterEfficiencyPct: 85
  });
  assert.equal(result, 13.44);
});

test('computeAvailableEnergyKwh returns null when capacity is not set', () => {
  assert.equal(computeAvailableEnergyKwh({ batteryCapacityKwh: null, currentSocPct: 80, minSocPct: 20 }), null);
  assert.equal(computeAvailableEnergyKwh({ batteryCapacityKwh: 0, currentSocPct: 80, minSocPct: 20 }), null);
  assert.equal(computeAvailableEnergyKwh({}), null);
});

test('computeAvailableEnergyKwh returns 0 when SOC equals minSoc', () => {
  assert.equal(computeAvailableEnergyKwh({
    batteryCapacityKwh: 20,
    currentSocPct: 30,
    minSocPct: 30,
    inverterEfficiencyPct: 85
  }), 0);
});

test('computeAvailableEnergyKwh returns 0 when SOC below minSoc', () => {
  assert.equal(computeAvailableEnergyKwh({
    batteryCapacityKwh: 20,
    currentSocPct: 10,
    minSocPct: 30,
    inverterEfficiencyPct: 85
  }), 0);
});

test('computeAvailableEnergyKwh uses default 5% safety and 85% efficiency', () => {
  const result = computeAvailableEnergyKwh({
    batteryCapacityKwh: 10,
    currentSocPct: 100,
    minSocPct: 0
  });
  assert.equal(result, 8.07);
});

// --- computeEnergyBasedSlotAllocation ---

test('computeEnergyBasedSlotAllocation splits energy into full + partial slots', () => {
  const result = computeEnergyBasedSlotAllocation({
    availableKwh: 13.44,
    maxDischargeW: -12000
  });
  assert.equal(result.fullSlots, 4);
  assert.equal(result.partialSlotW, -5760);
  assert.equal(result.totalSlots, 5);
});

test('computeEnergyBasedSlotAllocation with exact multiple returns no partial', () => {
  const result = computeEnergyBasedSlotAllocation({
    availableKwh: 9.0,
    maxDischargeW: -12000
  });
  assert.equal(result.fullSlots, 3);
  assert.equal(result.partialSlotW, 0);
  assert.equal(result.totalSlots, 3);
});

test('computeEnergyBasedSlotAllocation returns zeros with no energy', () => {
  const result = computeEnergyBasedSlotAllocation({ availableKwh: 0, maxDischargeW: -12000 });
  assert.equal(result.totalSlots, 0);
  assert.equal(result.fullSlots, 0);
});

test('computeEnergyBasedSlotAllocation handles very small energy (partial only)', () => {
  const result = computeEnergyBasedSlotAllocation({
    availableKwh: 1.0,
    maxDischargeW: -12000
  });
  assert.equal(result.fullSlots, 0);
  assert.equal(result.partialSlotW, -4000);
  assert.equal(result.totalSlots, 1);
});
