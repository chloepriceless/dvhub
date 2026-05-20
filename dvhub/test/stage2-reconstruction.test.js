// test/stage2-reconstruction.test.js — Phase 19 Plan 19-06 (helpers ship in 19-01).
//
// Covers the pure helpers partitionRulesByStage2(rules) and classifyStage2Slot(plan, actual, override).
// These helpers are exported from services/forecast/inspector.js in Plan 19-01 so Plan 19-06 can
// consume them directly without growing the export surface. Test asserts the partition logic +
// 4-class classification matrix per UI-SPEC §B5.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInspector } from '../services/forecast/inspector.js';

// Helpers are returned from the factory under the same names.
function getHelpers() {
  const inspector = createInspector({ state: {}, getCfg: () => ({}), pushLog: () => {} }, {});
  return {
    partitionRulesByStage2: inspector.partitionRulesByStage2,
    classifyStage2Slot: inspector.classifyStage2Slot,
  };
}

test('partitionRulesByStage2 — splits by sma-stage2- id prefix', () => {
  const { partitionRulesByStage2 } = getHelpers();
  const rules = [
    { id: 'sma-stage2-leeren-1', start: '19:45' },
    { id: 'sma-stage2-hold-2', start: '20:00' },
    { id: 'custom-rule-1', start: '19:45' },
  ];
  const { planRules, overrideRules } = partitionRulesByStage2(rules);
  assert.equal(planRules.length, 2);
  assert.equal(overrideRules.length, 1);
  assert.equal(overrideRules[0].id, 'custom-rule-1');
});

test('partitionRulesByStage2 — also matches by stage2Phase marker', () => {
  const { partitionRulesByStage2 } = getHelpers();
  const rules = [
    { id: 'no-prefix', stage2Phase: 'LEEREN', start: '19:45' },
    { id: 'no-prefix-2', stage2Phase: 'HALTEN', start: '20:00' },
    { id: 'manual', start: '19:45' },
  ];
  const { planRules, overrideRules } = partitionRulesByStage2(rules);
  assert.equal(planRules.length, 2);
  assert.equal(overrideRules.length, 1);
});

test('partitionRulesByStage2 — also matches by source field', () => {
  const { partitionRulesByStage2 } = getHelpers();
  const rules = [
    { id: 'r1', source: 'small_market_automation', start: '19:45' },
    { id: 'r2', source: 'operator', start: '19:45' },
  ];
  const { planRules, overrideRules } = partitionRulesByStage2(rules);
  assert.equal(planRules.length, 1);
  assert.equal(overrideRules.length, 1);
});

test('partitionRulesByStage2 — empty/invalid input returns empty arrays', () => {
  const { partitionRulesByStage2 } = getHelpers();
  assert.deepEqual(partitionRulesByStage2(null), { planRules: [], overrideRules: [] });
  assert.deepEqual(partitionRulesByStage2(undefined), { planRules: [], overrideRules: [] });
  assert.deepEqual(partitionRulesByStage2([]), { planRules: [], overrideRules: [] });
});

test('classifyStage2Slot — MATCHED when actual within ±15% of plan', () => {
  const { classifyStage2Slot } = getHelpers();
  const r = classifyStage2Slot({ plannedPowerW: -3200 }, { actualPowerW: -2950 }, null);
  assert.equal(r, 'MATCHED');
});

test('classifyStage2Slot — DEVIATION when actual outside ±15% with no override', () => {
  const { classifyStage2Slot } = getHelpers();
  const r = classifyStage2Slot({ plannedPowerW: -3200 }, { actualPowerW: 0 }, null);
  assert.equal(r, 'DEVIATION');
});

test('classifyStage2Slot — OVERRIDE when override present (regardless of actual)', () => {
  const { classifyStage2Slot } = getHelpers();
  const r = classifyStage2Slot({ plannedPowerW: -3200 }, { actualPowerW: 1100 }, { id: 'custom-grid-charge-1' });
  assert.equal(r, 'OVERRIDE');
});

test('classifyStage2Slot — NEUTRAL when no plan slot', () => {
  const { classifyStage2Slot } = getHelpers();
  const r = classifyStage2Slot(null, { actualPowerW: 800 }, null);
  assert.equal(r, 'NEUTRAL');
});

test('classifyStage2Slot — NEUTRAL when actual is missing/invalid', () => {
  const { classifyStage2Slot } = getHelpers();
  const r = classifyStage2Slot({ plannedPowerW: -3200 }, { actualPowerW: NaN }, null);
  assert.equal(r, 'NEUTRAL');
});

test('classifyStage2Slot — HALTEN slot uses ±100W floor tolerance', () => {
  const { classifyStage2Slot } = getHelpers();
  // Plan=0 (HALTEN), actual=-50 (idle drift) → MATCHED via 100W floor
  const r = classifyStage2Slot({ plannedPowerW: 0 }, { actualPowerW: -50 }, null);
  assert.equal(r, 'MATCHED');
});
