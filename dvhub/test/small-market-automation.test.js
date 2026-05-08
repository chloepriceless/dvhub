import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAutomationRuleChain,
  buildChainVariants,
  computeAvailableEnergyKwh,
  computeEnergyBasedSlotAllocation,
  computeDynamicAutomationMinSocPct,
  computeForecastReserveSocPct,
  filterFreeAutomationSlots,
  pickBestAutomationPlan,
  splitIntoContiguousSegments,
  sumForecastSlotsKwh
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

test('computeDynamicAutomationMinSocPct relaxes linearly toward the global min by sunrise+1h grace', () => {
  // sunset 20:00 → effective-sunrise 07:00 (sunrise 06:00 + 1h PV-warmup grace)
  // = 11h window. now 01:00 = 5h after sunset → progress 5/11.
  const result = computeDynamicAutomationMinSocPct({
    automationMinSocPct: 30,
    globalMinSocPct: 3,
    sunsetTs: Date.parse('2026-06-01T20:00:00+02:00'),
    sunriseTs: Date.parse('2026-06-02T06:00:00+02:00'),
    nowTs: Date.parse('2026-06-02T01:00:00+02:00')
  });
  // 30 - 27 * (5/11) = 17.7272…
  assert.ok(Math.abs(result - (30 - 27 * 5 / 11)) < 1e-9, `expected ~17.727, got ${result}`);
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

test('computeDynamicAutomationMinSocPct keeps SOC floor restrictive at sunrise (PV still too weak)', () => {
  // At geometric sunrise, the 1h grace window still applies — sun just cleared
  // the horizon and produces <500W, so we stay near automationMin, not at globalMin.
  const result = computeDynamicAutomationMinSocPct({
    automationMinSocPct: 30,
    globalMinSocPct: 3,
    sunsetTs: Date.parse('2026-06-01T20:00:00+02:00'),
    sunriseTs: Date.parse('2026-06-02T06:00:00+02:00'),
    nowTs: Date.parse('2026-06-02T06:00:00+02:00')
  });
  // 10h after sunset, 11h total → 30 - 27 * 10/11 ≈ 5.45
  assert.ok(Math.abs(result - (30 - 27 * 10 / 11)) < 1e-9, `expected ~5.45, got ${result}`);
  assert.ok(result > 3, 'must not drop to globalMin yet at geometric sunrise');
});

test('computeDynamicAutomationMinSocPct returns globalMin at or after sunrise+1h grace', () => {
  const result = computeDynamicAutomationMinSocPct({
    automationMinSocPct: 30,
    globalMinSocPct: 3,
    sunsetTs: Date.parse('2026-06-01T20:00:00+02:00'),
    sunriseTs: Date.parse('2026-06-02T06:00:00+02:00'),
    nowTs: Date.parse('2026-06-02T07:00:00+02:00')
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

// --- buildChainVariants ---

test('buildChainVariants generates progressive stage prefixes', () => {
  const stages = [
    { dischargeW: -18000, dischargeSlots: 1, cooldownW: -10000, cooldownSlots: 3 },
    { dischargeW: -15000, dischargeSlots: 2, cooldownW: -12000, cooldownSlots: 1 }
  ];
  const variants = buildChainVariants({ maxDischargeW: -18000, stages });
  assert.equal(variants.length, 2);
  // First variant: stage 1 only → 1 discharge + 3 cooldown entries
  assert.equal(variants[0].length, 2); // [{powerW:-18000, slots:1}, {powerW:-10000, slots:3}]
  // Second variant: stage 1 + stage 2
  assert.equal(variants[1].length, 4);
});

test('buildChainVariants truncates to energy budget', () => {
  const stages = [
    { dischargeW: -18000, dischargeSlots: 1, cooldownW: -10000, cooldownSlots: 3 },
    { dischargeW: -15000, dischargeSlots: 2, cooldownW: -12000, cooldownSlots: 1 }
  ];
  // 18000W * 0.25h = 4.5 kWh per slot at full power
  // Stage 1: 1 slot @18kW + 3 slots @10kW = 4.5 + 7.5 = 12 kWh
  // With only 5 kWh budget: only 1 slot @18kW (4.5) + 0.5 remaining → not enough for 10kW slot
  const variants = buildChainVariants({ maxDischargeW: -18000, stages, availableKwh: 5 });
  assert.ok(variants.length >= 1);
  // First variant should be truncated
  const expanded = variants[0];
  assert.equal(expanded[0].powerW, -18000);
  assert.equal(expanded[0].slots, 1);
});

test('buildChainVariants returns empty for no stages', () => {
  assert.deepEqual(buildChainVariants({ maxDischargeW: -18000, stages: [] }), []);
  assert.deepEqual(buildChainVariants({ maxDischargeW: -18000 }), []);
});

test('buildChainVariants returns empty when energy budget is too small for even one slot', () => {
  // 1 kWh available, stage needs 18kW * 0.25h = 4.5 kWh per slot → 0 slots fit
  const stages = [
    { dischargeW: -18000, dischargeSlots: 4, cooldownSlots: 0 }
  ];
  const variants = buildChainVariants({ maxDischargeW: -18000, stages, availableKwh: 1.0 });
  assert.equal(variants.length, 0, 'should return no variants when energy is insufficient for a single slot');
});

test('buildChainVariants returns empty when energy budget is very small (1.2 kWh, 12kW discharge)', () => {
  // 12kW * 0.25h = 3 kWh per slot → Math.floor(1.2/3) = 0 slots
  const stages = [
    { dischargeW: -12000, dischargeSlots: 4, cooldownSlots: 0 }
  ];
  const variants = buildChainVariants({ maxDischargeW: -12000, stages, availableKwh: 1.2 });
  assert.equal(variants.length, 0, 'should return no variants when 1.2 kWh is too small for a 3 kWh slot');
});

test('pickBestAutomationPlan selects most profitable chain variant', () => {
  // 8 contiguous high-price slots
  const slots = Array.from({ length: 8 }, (_, i) => slotAt(i, 20 + i));
  const stages = [
    { dischargeW: -18000, dischargeSlots: 1, cooldownW: -10000, cooldownSlots: 3 },
    { dischargeW: -15000, dischargeSlots: 2, cooldownW: -12000, cooldownSlots: 1 }
  ];
  const chainVariants = buildChainVariants({ maxDischargeW: -18000, stages });
  const plan = pickBestAutomationPlan({
    slots,
    chainOptions: chainVariants,
    slotDurationMs: SLOT_MS
  });
  // Should pick the longer chain (7 slots) since prices rise, giving more total revenue
  assert.ok(plan.selectedSlotTimestamps.length > 0);
  assert.ok(plan.totalRevenueCt > 0);
});

// --- sumForecastSlotsKwh ---

test('sumForecastSlotsKwh sums 15-min PV slots over the requested horizon', () => {
  const NOW = Date.parse('2026-05-07T08:00:00Z');
  const slots = [
    { start: '2026-05-07T08:00:00Z', powerW: 4000, confidence: 0.5 }, // 1 kWh
    { start: '2026-05-07T08:15:00Z', powerW: 8000, confidence: 0.5 }, // 2 kWh
    { start: '2026-05-07T08:30:00Z', powerW: 4000, confidence: 0.4 }, // 1 kWh
    { start: '2026-05-07T20:00:00Z', powerW: 0,    confidence: 0.6 }  // outside 1h horizon
  ];
  const r = sumForecastSlotsKwh({ slots, fromTs: NOW, toTs: NOW + 3600000, defaultDurationMin: 15 });
  assert.equal(r.totalKwh, 4);
  assert.equal(r.slotsCounted, 3);
  assert.ok(r.avgConfidence > 0.4 && r.avgConfidence < 0.5);
});

test('sumForecastSlotsKwh clips slot tails that overflow the horizon end', () => {
  const NOW = Date.parse('2026-05-07T08:00:00Z');
  const slots = [
    // start 07:30, end 08:30 (60-min slot at 4 kW) → 30 min overlap with [08:00, 09:00) = 2 kWh
    { start: '2026-05-07T07:30:00Z', end: '2026-05-07T08:30:00Z', powerW: 4000, confidence: 0.5 },
    // start 08:50, end 09:30 → 10 min overlap with [08:00, 09:00) = 0.667 kWh
    { start: '2026-05-07T08:50:00Z', end: '2026-05-07T09:30:00Z', powerW: 4000, confidence: 0.5 }
  ];
  const r = sumForecastSlotsKwh({ slots, fromTs: NOW, toTs: NOW + 3600000 });
  assert.ok(Math.abs(r.totalKwh - 2.67) < 0.05, `expected ~2.67 got ${r.totalKwh}`);
});

// --- computeForecastReserveSocPct ---

test('computeForecastReserveSocPct relaxes reserve when sunny day expected', () => {
  const NOW = Date.parse('2026-05-06T18:00:00Z');
  // 30 PV slots × 15 min × 8 kW ≈ 60 kWh; 24 load slots × 1h × 1 kW = 24 kWh
  const pvSlots = Array.from({ length: 30 }, (_, i) => ({
    start: new Date(NOW + (i + 12) * 15 * 60000).toISOString(),
    powerW: 8000, confidence: 0.6
  }));
  const loadSlots = Array.from({ length: 24 }, (_, i) => ({
    start: new Date(NOW + i * 3600000).toISOString(),
    powerW: 1000, confidence: 0.5
  }));
  const r = computeForecastReserveSocPct({
    pvSlots, loadSlots, nowTs: NOW, horizonHours: 24,
    currentSocPct: 50, batteryCapacityKwh: 40, configuredMinSocPct: 25,
    globalMinSocPct: 5, safetyMarginKwh: 1.5
  });
  assert.equal(r.hoardingActive, false);
  assert.ok(r.effectiveMinSocPct < 25, `expected relax below 25, got ${r.effectiveMinSocPct}`);
  assert.ok(r.effectiveMinSocPct >= 5);
  assert.equal(r.reason, 'forecast_relaxed');
});

test('computeForecastReserveSocPct triggers hoarding when 24h budget is negative', () => {
  const NOW = Date.parse('2026-05-06T18:00:00Z');
  // No PV (cloudy), heavy load
  const pvSlots = [
    { start: new Date(NOW).toISOString(), powerW: 0, confidence: 0.6 }
  ];
  const loadSlots = Array.from({ length: 24 }, (_, i) => ({
    start: new Date(NOW + i * 3600000).toISOString(),
    powerW: 2000, confidence: 0.5
  }));
  const r = computeForecastReserveSocPct({
    pvSlots, loadSlots, nowTs: NOW, horizonHours: 24,
    currentSocPct: 30, batteryCapacityKwh: 40, configuredMinSocPct: 25,
    globalMinSocPct: 5, safetyMarginKwh: 1.5
  });
  // stored = 40 * (30-5)/100 = 10 kWh; load = 48 kWh; pv ~ 0; net = 10 - 48 = -38 → hoarding
  assert.equal(r.hoardingActive, true);
  assert.equal(r.reason, 'hoarding_deficit');
});

test('computeForecastReserveSocPct caps reserve at configured minSocPct', () => {
  const NOW = Date.parse('2026-05-06T18:00:00Z');
  // Forecast says reserve ≈ 21%, config caps at 10% — verify the cap wins.
  // Setup: 24 PV-15min slots × 1 kW = 6 kWh, 24 load-1h slots × 1 kW = 24 kWh
  // → deficit = 18 + 1.5 safety = 19.5 kWh / 40 kWh * 100 + 5 = 53.75% raw
  // → capped at min(10, 53.75) = 10
  // SOC=90 → stored = 40 * (90-5)/100 = 34 kWh; net = 34 + 6 - 24 = +16 (no hoarding)
  const pvSlots = Array.from({ length: 24 }, (_, i) => ({
    start: new Date(NOW + i * 3600000).toISOString(),
    end: new Date(NOW + (i + 1) * 3600000).toISOString(),
    powerW: 1000, confidence: 0.6
  }));
  const loadSlots = Array.from({ length: 24 }, (_, i) => ({
    start: new Date(NOW + i * 3600000).toISOString(),
    end: new Date(NOW + (i + 1) * 3600000).toISOString(),
    powerW: 1000, confidence: 0.5
  }));
  const r = computeForecastReserveSocPct({
    pvSlots, loadSlots, nowTs: NOW, horizonHours: 24,
    currentSocPct: 90, batteryCapacityKwh: 40, configuredMinSocPct: 10,
    globalMinSocPct: 5, safetyMarginKwh: 1.5
  });
  assert.equal(r.hoardingActive, false, `unexpected hoarding (net=${r.netKwh})`);
  assert.ok(r.effectiveMinSocPct <= 10, `expected ≤ 10 (cap), got ${r.effectiveMinSocPct}`);
});

test('computeForecastReserveSocPct falls back to configured minSocPct on low confidence', () => {
  const NOW = Date.parse('2026-05-06T18:00:00Z');
  const pvSlots = [{ start: new Date(NOW).toISOString(), powerW: 4000, confidence: 0.2 }];
  const loadSlots = [{ start: new Date(NOW).toISOString(), powerW: 1000, confidence: 0.3 }];
  const r = computeForecastReserveSocPct({
    pvSlots, loadSlots, nowTs: NOW, horizonHours: 24,
    currentSocPct: 60, batteryCapacityKwh: 40, configuredMinSocPct: 25,
    globalMinSocPct: 5, safetyMarginKwh: 1.5, confidenceThreshold: 0.4
  });
  assert.equal(r.effectiveMinSocPct, 25);
  assert.equal(r.reason, 'low_confidence');
  assert.equal(r.hoardingActive, false);
});

test('computeForecastReserveSocPct returns config fallback when forecast missing', () => {
  const r = computeForecastReserveSocPct({
    pvSlots: [], loadSlots: [], nowTs: Date.now(),
    currentSocPct: 50, batteryCapacityKwh: 40, configuredMinSocPct: 25
  });
  assert.equal(r.effectiveMinSocPct, 25);
  assert.equal(r.hoardingActive, false);
  // Empty slot lists fall through the confidence branch — caller can't distinguish from
  // genuinely-low-confidence; both should preserve the configured floor.
  assert.ok(['low_confidence', 'no_forecast_data'].includes(r.reason), `unexpected reason: ${r.reason}`);
});

test('computeForecastReserveSocPct uses no_forecast_data fallback when battery state is missing', () => {
  const r = computeForecastReserveSocPct({
    pvSlots: [{ start: new Date().toISOString(), powerW: 4000, confidence: 0.5 }],
    loadSlots: [{ start: new Date().toISOString(), powerW: 1000, confidence: 0.5 }],
    nowTs: Date.now(),
    currentSocPct: null, batteryCapacityKwh: 0, configuredMinSocPct: 25
  });
  assert.equal(r.effectiveMinSocPct, 25);
  assert.equal(r.reason, 'no_forecast_data');
});
