import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAutomationRuleChain,
  computeDynamicAutomationMinSocPct,
  filterFreeAutomationSlots,
  pickBestAutomationPlan
} from '../small-market-automation.js';

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

test('pickBestAutomationPlan prefers the higher total revenue candidate even when it uses lower peak power', () => {
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
  assert.equal(plan.totalRevenueCt, 1650);
});
