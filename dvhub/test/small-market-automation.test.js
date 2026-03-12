import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAutomationRuleChain,
  computeAvailableEnergyKwh,
  computeEnergyBasedSlotAllocation,
  computeDynamicAutomationMinSocPct,
  filterFreeAutomationSlots,
  pickBestAutomationPlan
} from '../small-market-automation.js';

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

// --- pickBestAutomationPlan ---

test('pickBestAutomationPlan prefers the higher total revenue chain', () => {
  const plan = pickBestAutomationPlan({
    slots: [
      { ts: 1, ct_kwh: 28 },
      { ts: 2, ct_kwh: 27 },
      { ts: 3, ct_kwh: 10 }
    ],
    targetSlotCount: 2,
    chainOptions: [
      [{ powerW: -18000, slots: 1 }, { powerW: -8000, slots: 1 }],
      [{ powerW: -12000, slots: 2 }]
    ]
  });

  assert.deepEqual(plan.selectedSlotTimestamps, [1, 2]);
  // Revenue: slot1 (18kW * 0.25h * 28ct) + slot2 (8kW * 0.25h * 27ct) = 126 + 54 = 180
  assert.equal(plan.totalRevenueCt, 180);
});

test('pickBestAutomationPlan selects lower peak discharge when revenue is tied', () => {
  const plan = pickBestAutomationPlan({
    slots: [
      { ts: 1, ct_kwh: 20 },
      { ts: 2, ct_kwh: 20 }
    ],
    targetSlotCount: 2,
    chainOptions: [
      [{ powerW: -15000, slots: 1 }, { powerW: -5000, slots: 1 }],
      [{ powerW: -10000, slots: 2 }]
    ]
  });
  // Both chains: 20ct * (15+5)/1000*0.25 = 20ct * 5 = same? No:
  // Chain1: (15*0.25*20) + (5*0.25*20) = 75+25 = 100ct
  // Chain2: (10*0.25*20) + (10*0.25*20) = 50+50 = 100ct (tied)
  // Peak: chain1=15000 vs chain2=10000 → chain2 wins
  assert.equal(plan.peakDischargeW, 10000);
});

test('pickBestAutomationPlan skips chains that do not match candidate slot count', () => {
  const plan = pickBestAutomationPlan({
    slots: [{ ts: 1, ct_kwh: 20 }, { ts: 2, ct_kwh: 15 }],
    targetSlotCount: 2,
    chainOptions: [[{ powerW: -10000, slots: 1 }]] // chain expands to 1 slot, need 2
  });
  // No chain matches → plan stays at initial empty state
  assert.equal(plan.chain.length, 0);
  assert.equal(plan.totalRevenueCt, -Infinity);
});

test('pickBestAutomationPlan handles empty slots gracefully', () => {
  const plan = pickBestAutomationPlan({
    slots: [],
    targetSlotCount: 0,
    chainOptions: []
  });
  assert.deepEqual(plan.selectedSlotTimestamps, []);
});

// --- estimateSlotRevenueCt (validated through pickBestAutomationPlan) ---

test('revenue calculation uses kW not W (18kW * 0.25h * 28ct/kWh = 126ct)', () => {
  const plan = pickBestAutomationPlan({
    slots: [{ ts: 1, ct_kwh: 28 }],
    targetSlotCount: 1,
    chainOptions: [[{ powerW: -18000, slots: 1 }]]
  });
  // 18000W / 1000 * 0.25h * 28ct/kWh = 126ct
  assert.equal(plan.totalRevenueCt, 126);
});

test('estimateSlotRevenueCt uses 15-minute (0.25h) slot duration', () => {
  // A single 15-min slot at 10kW and 40ct/kWh should yield: 10 * 0.25 * 40 = 100ct
  const plan = pickBestAutomationPlan({
    slots: [{ ts: 1000, ct_kwh: 40 }],
    targetSlotCount: 1,
    chainOptions: [[{ powerW: -10000, slots: 1 }]]
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
  // 25.6 * 0.95 * 0.65 * 0.85 = 13.4368 → rounded to 13.44
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
  // 10 * 0.95 * 1.0 * 0.85 = 8.075 → rounded to 8.07
  assert.equal(result, 8.07);
});

// --- computeEnergyBasedSlotAllocation ---

test('computeEnergyBasedSlotAllocation splits energy into full + partial slots', () => {
  const result = computeEnergyBasedSlotAllocation({
    availableKwh: 13.44,
    maxDischargeW: -12000
  });
  // 12kW * 0.25h = 3kWh per slot, 13.44 / 3 = 4.48
  assert.equal(result.fullSlots, 4);
  assert.equal(result.partialSlotW, -5760); // 0.48 * 3kWh... 1.44kWh / 0.25h = 5760W
  assert.equal(result.totalSlots, 5);
});

test('computeEnergyBasedSlotAllocation with exact multiple returns no partial', () => {
  const result = computeEnergyBasedSlotAllocation({
    availableKwh: 9.0,
    maxDischargeW: -12000
  });
  // 9.0 / 3.0 = exactly 3 slots
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
  // 1.0 / 3.0 = 0.33 → 0 full slots, 1 partial at 1.0/0.25 = 4000W
  assert.equal(result.fullSlots, 0);
  assert.equal(result.partialSlotW, -4000);
  assert.equal(result.totalSlots, 1);
});
