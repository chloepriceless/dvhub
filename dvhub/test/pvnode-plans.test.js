import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PVNODE_PLANS,
  DEFAULT_PVNODE_PLAN,
  resolvePvnodePlan,
  MIN_FETCH_FLOOR_MS,
} from '../services/forecast/pvnode-plans.js';

// pvnode V2 plan tiers (pvnode.com/pricing, 2026-06-25): plan → fetch window /
// monthly quota / horizon / nowcast / calibration.

test('default (no plan configured) → Free tier', () => {
  const p = resolvePvnodePlan({});
  assert.equal(p.key, 'free');
  assert.equal(DEFAULT_PVNODE_PLAN, 'free');
  assert.equal(p.fetchIntervalMs, 12 * 60 * 60 * 1000); // 12 h poll
  assert.equal(p.monthlyQuota, 250);
  assert.equal(p.maxForecastDays, 2);
  assert.equal(p.nowcast, false);
  assert.equal(p.calibration, false);
});

test('Light: hourly poll, 3000/month, 7 days, no nowcast', () => {
  const p = resolvePvnodePlan({ forecast: { pvnode: { plan: 'light' } } });
  assert.equal(p.key, 'light');
  assert.equal(p.fetchIntervalMs, 60 * 60 * 1000);
  assert.equal(p.monthlyQuota, 3000);
  assert.equal(p.maxForecastDays, 7);
  assert.equal(p.nowcast, false);
});

test('Plus: 15-min poll (nowcast budget-floored), 3000/month, calibration', () => {
  const p = resolvePvnodePlan({ forecast: { pvnode: { plan: 'plus' } } });
  assert.equal(p.key, 'plus');
  assert.equal(p.fetchIntervalMs, 15 * 60 * 1000);
  assert.equal(p.monthlyQuota, 3000);
  assert.equal(p.maxForecastDays, 7);
  assert.equal(p.nowcast, true);
  assert.equal(p.calibration, true);
});

test('Enterprise: high quota, nowcast + calibration', () => {
  const p = resolvePvnodePlan({ forecast: { pvnode: { plan: 'enterprise' } } });
  assert.equal(p.key, 'enterprise');
  assert.ok(p.monthlyQuota >= 100000);
  assert.equal(p.nowcast, true);
});

test('unknown / garbage plan falls back to Free (safest, lowest limits)', () => {
  assert.equal(resolvePvnodePlan({ forecast: { pvnode: { plan: 'gold' } } }).key, 'free');
  assert.equal(resolvePvnodePlan({ forecast: { pvnode: { plan: '' } } }).key, 'free');
  assert.equal(resolvePvnodePlan({ forecast: { pvnode: { plan: 42 } } }).key, 'free');
});

test('plan id is case-insensitive', () => {
  assert.equal(resolvePvnodePlan({ forecast: { pvnode: { plan: 'PLUS' } } }).key, 'plus');
});

test('explicit monthlyQuota override wins over the plan default', () => {
  const p = resolvePvnodePlan({ forecast: { pvnode: { plan: 'free', monthlyQuota: 5000 } } });
  assert.equal(p.key, 'free');         // still Free for window/horizon
  assert.equal(p.monthlyQuota, 5000);  // but the operator override wins
});

test('explicit fetchIntervalMs override wins, but is floored at 15 min', () => {
  const slow = resolvePvnodePlan({ forecast: { pvnode: { plan: 'plus', fetchIntervalMs: 30 * 60 * 1000 } } });
  assert.equal(slow.fetchIntervalMs, 30 * 60 * 1000); // honored

  const tooFast = resolvePvnodePlan({ forecast: { pvnode: { plan: 'plus', fetchIntervalMs: 60 * 1000 } } });
  assert.equal(tooFast.fetchIntervalMs, MIN_FETCH_FLOOR_MS); // 1 min request → floored to 15 min
});

test('every plan preset has a complete, sane shape', () => {
  for (const [key, plan] of Object.entries(PVNODE_PLANS)) {
    assert.ok(plan.label, `${key} has a label`);
    assert.ok(plan.fetchIntervalMs >= MIN_FETCH_FLOOR_MS, `${key} poll ≥ floor`);
    assert.ok(plan.monthlyQuota > 0, `${key} positive quota`);
    assert.ok(plan.maxForecastDays >= 1 && plan.maxForecastDays <= 7, `${key} horizon 1..7`);
    assert.equal(typeof plan.nowcast, 'boolean');
    assert.equal(typeof plan.calibration, 'boolean');
  }
});
