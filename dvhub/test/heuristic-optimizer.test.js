// test/heuristic-optimizer.test.js -- Unit tests for heuristic-optimizer.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHeuristicSchedule } from '../services/optimizer/heuristic-optimizer.js';

// Helper: create price slots with { ts, endTs, ctKwh, confidence }
const QUARTER_MS = 15 * 60 * 1000;
const BASE_TS = new Date('2026-04-03T00:00:00Z').getTime();

function makePriceSlots(prices) {
  return prices.map((ctKwh, i) => ({
    ts: BASE_TS + i * QUARTER_MS,
    endTs: BASE_TS + (i + 1) * QUARTER_MS,
    ctKwh,
    confidence: 0.8
  }));
}

function makePvSlots(powers) {
  return powers.map((powerW, i) => ({
    ts: BASE_TS + i * QUARTER_MS,
    endTs: BASE_TS + (i + 1) * QUARTER_MS,
    powerW,
    confidence: 0.75
  }));
}

function makeLoadSlots(powers) {
  return powers.map((powerW, i) => ({
    ts: BASE_TS + i * QUARTER_MS,
    endTs: BASE_TS + (i + 1) * QUARTER_MS,
    powerW,
    confidence: 0.7
  }));
}

const defaultBattery = {
  capacityWh: 10000,
  minSocPct: 10,
  maxSocPct: 100,
  maxChargeW: 3000,
  maxDischargeW: 3000,
  currentSocPct: 50
};

const defaultGate = {
  minSocPct: 10,
  maxDischargeW: 3000,
  allowSell: true,
  chargeWindowMultiplier: 1.0
};

test('cheap overnight + expensive afternoon: produces charge and discharge rules', () => {
  // 8 slots: 4 cheap (5 ct), 4 expensive (40 ct) -- avg = 22.5 ct
  // cheap threshold < 22.5 * 0.7 = 15.75, expensive > 22.5 * 1.3 = 29.25
  const prices = [5, 5, 5, 5, 40, 40, 40, 40];
  const pv = [0, 0, 0, 0, 0, 0, 0, 0]; // No PV
  const load = [500, 500, 500, 500, 500, 500, 500, 500];

  const result = buildHeuristicSchedule({
    priceSlots: makePriceSlots(prices),
    pvSlots: makePvSlots(pv),
    loadSlots: makeLoadSlots(load),
    batteryModel: defaultBattery,
    confidenceGate: defaultGate
  });

  assert.ok(Array.isArray(result));
  const chargeRules = result.filter(r => r.powerW > 0);
  const dischargeRules = result.filter(r => r.powerW < 0);
  assert.ok(chargeRules.length > 0, 'should have charge rules for cheap hours');
  assert.ok(dischargeRules.length > 0, 'should have discharge rules for expensive hours');
});

test('high PV forecast reduces charge rules during PV surplus periods', () => {
  // Cheap prices in slots 0-3, but PV surplus in slots 0-1 (1500W)
  const prices = [5, 5, 5, 5, 40, 40, 40, 40];
  const pv = [1500, 1500, 0, 0, 0, 0, 0, 0]; // PV surplus in first 2 cheap slots
  const load = [500, 500, 500, 500, 500, 500, 500, 500];

  const withPv = buildHeuristicSchedule({
    priceSlots: makePriceSlots(prices),
    pvSlots: makePvSlots(pv),
    loadSlots: makeLoadSlots(load),
    batteryModel: defaultBattery,
    confidenceGate: defaultGate
  });

  const withoutPv = buildHeuristicSchedule({
    priceSlots: makePriceSlots(prices),
    pvSlots: makePvSlots([0, 0, 0, 0, 0, 0, 0, 0]),
    loadSlots: makeLoadSlots(load),
    batteryModel: defaultBattery,
    confidenceGate: defaultGate
  });

  // With PV surplus, fewer charge rules because battery charges from PV naturally
  const chargeWithPv = withPv.filter(r => r.powerW > 0);
  const chargeWithoutPv = withoutPv.filter(r => r.powerW > 0);
  assert.ok(chargeWithPv.length < chargeWithoutPv.length,
    `PV surplus should reduce charge rules: ${chargeWithPv.length} vs ${chargeWithoutPv.length}`);
});

test('allowSell=false: no discharge/sell rules generated', () => {
  const prices = [5, 5, 5, 5, 40, 40, 40, 40];
  const pv = [0, 0, 0, 0, 0, 0, 0, 0];
  const load = [500, 500, 500, 500, 500, 500, 500, 500];

  const noSellGate = { ...defaultGate, allowSell: false };
  const result = buildHeuristicSchedule({
    priceSlots: makePriceSlots(prices),
    pvSlots: makePvSlots(pv),
    loadSlots: makeLoadSlots(load),
    batteryModel: defaultBattery,
    confidenceGate: noSellGate
  });

  const dischargeRules = result.filter(r => r.powerW < 0);
  assert.equal(dischargeRules.length, 0, 'no discharge rules when allowSell=false');
});

test('SOC simulation validates feasibility -- uses appliedPowerW for adjustment', () => {
  // Start at 95% SOC -- charging should be clipped by SOC max
  const prices = [5, 5, 40, 40]; // 2 cheap, 2 expensive
  const pv = [0, 0, 0, 0];
  const load = [500, 500, 500, 500];

  const highSocBattery = { ...defaultBattery, currentSocPct: 95 };

  const result = buildHeuristicSchedule({
    priceSlots: makePriceSlots(prices),
    pvSlots: makePvSlots(pv),
    loadSlots: makeLoadSlots(load),
    batteryModel: highSocBattery,
    confidenceGate: defaultGate
  });

  // Should still produce a valid schedule (may have clipped charge slots)
  assert.ok(Array.isArray(result));
  // Charge rules should have adjusted power if clipped
  const chargeRules = result.filter(r => r.powerW > 0);
  for (const r of chargeRules) {
    assert.ok(Number.isFinite(r.powerW), 'powerW should be finite');
  }
});

test('empty forecast data returns empty rules array', () => {
  const result = buildHeuristicSchedule({
    priceSlots: [],
    pvSlots: [],
    loadSlots: [],
    batteryModel: defaultBattery,
    confidenceGate: defaultGate
  });

  assert.ok(Array.isArray(result));
  assert.equal(result.length, 0, 'empty input = empty output');
});

test('slots use normalized format { ts, endTs, ctKwh, confidence }', () => {
  const prices = [5, 5, 40, 40];
  const pv = [0, 0, 0, 0];
  const load = [500, 500, 500, 500];

  const result = buildHeuristicSchedule({
    priceSlots: makePriceSlots(prices),
    pvSlots: makePvSlots(pv),
    loadSlots: makeLoadSlots(load),
    batteryModel: defaultBattery,
    confidenceGate: defaultGate
  });

  // Every output slot must have ts, endTs, powerW, confidence
  for (const slot of result) {
    assert.ok(Number.isFinite(slot.ts), 'slot.ts should be finite number');
    assert.ok(Number.isFinite(slot.endTs), 'slot.endTs should be finite number');
    assert.ok(Number.isFinite(slot.powerW), 'slot.powerW should be finite number');
    assert.ok(Number.isFinite(slot.confidence), 'slot.confidence should be finite number');
    assert.ok(slot.endTs > slot.ts, 'endTs > ts');
  }
});
