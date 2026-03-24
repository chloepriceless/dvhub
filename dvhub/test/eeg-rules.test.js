import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NEGATIVE_PRICE_RULES,
  EV_DEDUCTION_CT_KWH,
  getEegNegativePriceRule,
  getFeedInCompensationCtKwh,
  isNegativePriceSlotAffected
} from '../eeg-rules.js';

// ── getEegNegativePriceRule ─────────────────────────────────────────────────

test('getEegNegativePriceRule returns none for plants commissioned before 2016-01-01', () => {
  const result = getEegNegativePriceRule({ commissionedAt: '2015-06-01', kwp: 100 });
  assert.equal(result.rule, 'none');
  assert.ok(/Keine Kürzung/i.test(result.description || ''), `Expected description to contain "Keine Kürzung", got: ${result.description}`);
});

test('getEegNegativePriceRule returns 6h for plants >= 500 kWp commissioned 2016-2020', () => {
  const result = getEegNegativePriceRule({ commissionedAt: '2018-03-15', kwp: 600 });
  assert.equal(result.rule, '6h');
  assert.equal(result.minKwp, 500);
});

test('getEegNegativePriceRule returns none for plants < 500 kWp commissioned 2016-2020', () => {
  const result = getEegNegativePriceRule({ commissionedAt: '2018-03-15', kwp: 100 });
  assert.equal(result.rule, 'none');
});

test('getEegNegativePriceRule returns 4h for plants >= 400 kWp commissioned 2021-2022', () => {
  const result = getEegNegativePriceRule({ commissionedAt: '2021-06-01', kwp: 500 });
  assert.equal(result.rule, '4h');
  assert.equal(result.minKwp, 400);
});

test('getEegNegativePriceRule returns none for plants < 400 kWp commissioned 2021-2022', () => {
  const result = getEegNegativePriceRule({ commissionedAt: '2021-06-01', kwp: 300 });
  assert.equal(result.rule, 'none');
});

test('getEegNegativePriceRule returns tiered for plants >= 400 kWp commissioned 2023 to 2025-02-24', () => {
  const result = getEegNegativePriceRule({ commissionedAt: '2023-06-01', kwp: 500 });
  assert.equal(result.rule, 'tiered');
  assert.equal(result.minKwp, 400);
  assert.deepEqual(result.tiers, { 2023: 4, 2024: 3 });
});

test('getEegNegativePriceRule returns 15min for plants >= 2 kWp commissioned from 2025-02-25', () => {
  const result = getEegNegativePriceRule({ commissionedAt: '2025-03-01', kwp: 10 });
  assert.equal(result.rule, '15min');
  assert.equal(result.minKwp, 2);
});

test('getEegNegativePriceRule returns none for plants < 2 kWp commissioned from 2025-02-25', () => {
  const result = getEegNegativePriceRule({ commissionedAt: '2025-03-01', kwp: 1 });
  assert.equal(result.rule, 'none');
});

test('getEegNegativePriceRule returns none for null commissionedAt', () => {
  const result = getEegNegativePriceRule({ commissionedAt: null, kwp: 500 });
  assert.equal(result.rule, 'none');
});

test('getEegNegativePriceRule returns none for undefined commissionedAt', () => {
  const result = getEegNegativePriceRule({ commissionedAt: undefined, kwp: 500 });
  assert.equal(result.rule, 'none');
});

// ── getFeedInCompensationCtKwh ──────────────────────────────────────────────

test('getFeedInCompensationCtKwh subtracts 0.4 ct/kWh for standard (no iMSys)', () => {
  const result = getFeedInCompensationCtKwh({ applicableValueCtKwh: 7.79 });
  assert.equal(result, 7.39);
});

test('getFeedInCompensationCtKwh subtracts 0.4 ct/kWh for AW=12.35 no iMSys', () => {
  const result = getFeedInCompensationCtKwh({ applicableValueCtKwh: 12.35 });
  assert.equal(result, 11.95);
});

test('getFeedInCompensationCtKwh subtracts 0.2 ct/kWh for iMSys=true', () => {
  const result = getFeedInCompensationCtKwh({ applicableValueCtKwh: 7.79, hasSmartMeter: true });
  assert.equal(result, 7.59);
});

test('getFeedInCompensationCtKwh returns null for AW=null', () => {
  const result = getFeedInCompensationCtKwh({ applicableValueCtKwh: null });
  assert.equal(result, null);
});

test('getFeedInCompensationCtKwh returns negative value for AW less than deduction', () => {
  const result = getFeedInCompensationCtKwh({ applicableValueCtKwh: 0.3 });
  assert.ok(typeof result === 'number' && result < 0, `Expected negative number, got: ${result}`);
});

// ── isNegativePriceSlotAffected ─────────────────────────────────────────────

test('isNegativePriceSlotAffected returns false for rule=none regardless of price', () => {
  assert.equal(isNegativePriceSlotAffected({ rule: 'none', marketPriceCtKwh: -5 }), false);
});

test('isNegativePriceSlotAffected returns true for rule=6h with 6 consecutive negative hours', () => {
  assert.equal(isNegativePriceSlotAffected({ rule: '6h', consecutiveNegativeHours: 6 }), true);
});

test('isNegativePriceSlotAffected returns false for rule=6h with only 5 consecutive negative hours', () => {
  assert.equal(isNegativePriceSlotAffected({ rule: '6h', consecutiveNegativeHours: 5 }), false);
});

test('isNegativePriceSlotAffected returns true for rule=4h with 4 consecutive negative hours', () => {
  assert.equal(isNegativePriceSlotAffected({ rule: '4h', consecutiveNegativeHours: 4 }), true);
});

test('isNegativePriceSlotAffected returns true for rule=15min when price is negative', () => {
  assert.equal(isNegativePriceSlotAffected({ rule: '15min', marketPriceCtKwh: -0.01 }), true);
});

test('isNegativePriceSlotAffected returns false for rule=15min when price is zero', () => {
  assert.equal(isNegativePriceSlotAffected({ rule: '15min', marketPriceCtKwh: 0 }), false);
});

test('isNegativePriceSlotAffected returns true for rule=tiered in 2023 with 4 consecutive hours', () => {
  assert.equal(isNegativePriceSlotAffected({ rule: 'tiered', tiers: { 2023: 4, 2024: 3 }, year: 2023, consecutiveNegativeHours: 4 }), true);
});

test('isNegativePriceSlotAffected returns true for rule=tiered in 2024 with exactly 3 consecutive hours', () => {
  assert.equal(isNegativePriceSlotAffected({ rule: 'tiered', tiers: { 2023: 4, 2024: 3 }, year: 2024, consecutiveNegativeHours: 3 }), true);
});

test('isNegativePriceSlotAffected returns false for rule=tiered in 2024 with only 2 consecutive hours', () => {
  assert.equal(isNegativePriceSlotAffected({ rule: 'tiered', tiers: { 2023: 4, 2024: 3 }, year: 2024, consecutiveNegativeHours: 2 }), false);
});

// ── NEGATIVE_PRICE_RULES and EV_DEDUCTION_CT_KWH exports ───────────────────

test('NEGATIVE_PRICE_RULES is a non-empty array', () => {
  assert.ok(Array.isArray(NEGATIVE_PRICE_RULES) && NEGATIVE_PRICE_RULES.length > 0);
});

test('EV_DEDUCTION_CT_KWH is 0.4', () => {
  assert.equal(EV_DEDUCTION_CT_KWH, 0.4);
});
