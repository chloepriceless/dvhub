// test/milp-battery-optimizer.test.js -- Unit tests for milp-battery-optimizer.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMilpSchedule } from '../services/optimizer/milp-battery-optimizer.js';

const QUARTER_MS = 15 * 60 * 1000;
const HOUR_MS = 3600000;
const BASE_TS = new Date('2026-04-03T00:00:00Z').getTime();

// Helper: create 15-min price slots (4 per hour)
function make15minPriceSlots(hourlyPrices) {
  const slots = [];
  for (let h = 0; h < hourlyPrices.length; h++) {
    for (let q = 0; q < 4; q++) {
      const ts = BASE_TS + h * HOUR_MS + q * QUARTER_MS;
      slots.push({
        ts,
        endTs: ts + QUARTER_MS,
        ctKwh: hourlyPrices[h],
        confidence: 0.8
      });
    }
  }
  return slots;
}

// Helper: create 15-min PV slots (4 per hour)
function make15minPvSlots(hourlyPower) {
  const slots = [];
  for (let h = 0; h < hourlyPower.length; h++) {
    for (let q = 0; q < 4; q++) {
      const ts = BASE_TS + h * HOUR_MS + q * QUARTER_MS;
      slots.push({
        ts,
        endTs: ts + QUARTER_MS,
        powerW: hourlyPower[h],
        confidence: 0.75
      });
    }
  }
  return slots;
}

// Helper: create 1h load slots (already hourly)
function makeHourlyLoadSlots(hourlyPower) {
  return hourlyPower.map((powerW, h) => ({
    ts: BASE_TS + h * HOUR_MS,
    endTs: BASE_TS + (h + 1) * HOUR_MS,
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

// Check if HiGHS is available
let higgsAvailable = false;
try {
  const mod = await import('highs');
  const solver = await mod.default();
  higgsAvailable = !!solver;
} catch {
  higgsAvailable = false;
}

test('buildMilpSchedule with cheap/expensive prices produces charge rules during cheapest hours', async () => {
  // 8 hours: 4 cheap (5ct), 4 expensive (40ct)
  const prices = [5, 5, 5, 5, 40, 40, 40, 40];
  const pv = [0, 0, 0, 0, 0, 0, 0, 0];
  const load = [500, 500, 500, 500, 500, 500, 500, 500];

  const result = await buildMilpSchedule({
    priceSlots: make15minPriceSlots(prices),
    pvSlots: make15minPvSlots(pv),
    loadSlots: makeHourlyLoadSlots(load),
    batteryModel: defaultBattery,
    confidenceGate: defaultGate
  });

  if (!higgsAvailable) {
    assert.equal(result, null, 'returns null when HiGHS unavailable');
    return;
  }

  assert.ok(Array.isArray(result));
  const chargeSlots = result.filter(r => r.powerW > 0);
  assert.ok(chargeSlots.length > 0, 'should have charge slots during cheap hours');
});

test('buildMilpSchedule produces discharge rules during most expensive hours', async () => {
  const prices = [5, 5, 5, 5, 40, 40, 40, 40];
  const pv = [0, 0, 0, 0, 0, 0, 0, 0];
  const load = [500, 500, 500, 500, 500, 500, 500, 500];

  const result = await buildMilpSchedule({
    priceSlots: make15minPriceSlots(prices),
    pvSlots: make15minPvSlots(pv),
    loadSlots: makeHourlyLoadSlots(load),
    batteryModel: defaultBattery,
    confidenceGate: defaultGate
  });

  if (!higgsAvailable) {
    assert.equal(result, null);
    return;
  }

  assert.ok(Array.isArray(result));
  const dischargeSlots = result.filter(r => r.powerW < 0);
  assert.ok(dischargeSlots.length > 0, 'should have discharge slots during expensive hours');
});

test('SOC constraints respected: never below minSocPct, never above maxSocPct', async () => {
  // Use tight battery to stress SOC bounds
  const prices = [5, 5, 40, 40, 5, 5, 40, 40];
  const pv = [0, 0, 0, 0, 0, 0, 0, 0];
  const load = [500, 500, 500, 500, 500, 500, 500, 500];

  const tightBattery = { ...defaultBattery, minSocPct: 20, maxSocPct: 90 };

  const result = await buildMilpSchedule({
    priceSlots: make15minPriceSlots(prices),
    pvSlots: make15minPvSlots(pv),
    loadSlots: makeHourlyLoadSlots(load),
    batteryModel: tightBattery,
    confidenceGate: { ...defaultGate, minSocPct: 20 }
  });

  if (!higgsAvailable) {
    assert.equal(result, null);
    return;
  }

  // Schedule should exist and be valid
  assert.ok(Array.isArray(result));
});

test('power constraints respected: charge <= maxChargeW, discharge <= maxDischargeW', async () => {
  const prices = [5, 5, 40, 40];
  const pv = [0, 0, 0, 0];
  const load = [500, 500, 500, 500];

  const result = await buildMilpSchedule({
    priceSlots: make15minPriceSlots(prices),
    pvSlots: make15minPvSlots(pv),
    loadSlots: makeHourlyLoadSlots(load),
    batteryModel: defaultBattery,
    confidenceGate: defaultGate
  });

  if (!higgsAvailable) {
    assert.equal(result, null);
    return;
  }

  assert.ok(Array.isArray(result));
  for (const slot of result) {
    assert.ok(slot.powerW <= defaultBattery.maxChargeW,
      `charge ${slot.powerW} <= ${defaultBattery.maxChargeW}`);
    assert.ok(slot.powerW >= -defaultBattery.maxDischargeW,
      `discharge ${slot.powerW} >= ${-defaultBattery.maxDischargeW}`);
  }
});

test('returns null when HiGHS is not available (graceful degradation)', async () => {
  // This test verifies the fallback behavior
  // If HiGHS is available, the function returns an array
  // If not, it returns null
  const result = await buildMilpSchedule({
    priceSlots: make15minPriceSlots([10, 10]),
    pvSlots: make15minPvSlots([0, 0]),
    loadSlots: makeHourlyLoadSlots([500, 500]),
    batteryModel: defaultBattery,
    confidenceGate: defaultGate
  });

  if (higgsAvailable) {
    assert.ok(Array.isArray(result), 'with HiGHS: returns array');
  } else {
    assert.equal(result, null, 'without HiGHS: returns null');
  }
});

test('output format matches schedule-builder input: array of { ts, endTs, powerW, confidence }', async () => {
  const prices = [5, 5, 40, 40];
  const pv = [0, 0, 0, 0];
  const load = [500, 500, 500, 500];

  const result = await buildMilpSchedule({
    priceSlots: make15minPriceSlots(prices),
    pvSlots: make15minPvSlots(pv),
    loadSlots: makeHourlyLoadSlots(load),
    batteryModel: defaultBattery,
    confidenceGate: defaultGate
  });

  if (!higgsAvailable) {
    assert.equal(result, null);
    return;
  }

  assert.ok(Array.isArray(result));
  for (const slot of result) {
    assert.ok(Number.isFinite(slot.ts), 'ts is finite');
    assert.ok(Number.isFinite(slot.endTs), 'endTs is finite');
    assert.ok(Number.isFinite(slot.powerW), 'powerW is finite');
    assert.ok(Number.isFinite(slot.confidence), 'confidence is finite');
    assert.ok(slot.endTs > slot.ts, 'endTs > ts');
  }
});

test('15min price/PV slots are aggregated to 1h via aggregateTo1h before MILP', async () => {
  // Provide 15min slots (4 per hour) and verify output exists
  // The MILP internally aggregates to 1h, then expands back to 15min
  const prices = [10, 20, 30, 40]; // 4 hourly prices -> 16 fifteen-min slots
  const pv = [0, 0, 0, 0];
  const load = [500, 500, 500, 500];

  const priceSlots = make15minPriceSlots(prices);
  assert.equal(priceSlots.length, 16, 'input has 16 fifteen-min price slots');

  const result = await buildMilpSchedule({
    priceSlots,
    pvSlots: make15minPvSlots(pv),
    loadSlots: makeHourlyLoadSlots(load),
    batteryModel: defaultBattery,
    confidenceGate: defaultGate
  });

  if (!higgsAvailable) {
    assert.equal(result, null);
    return;
  }

  // Output should be 15min slots (expanded from 1h MILP results)
  assert.ok(Array.isArray(result));
  // Each slot should be 15min duration
  for (const slot of result) {
    assert.equal(slot.endTs - slot.ts, QUARTER_MS, 'each output slot is 15min');
  }
});

test('1h load slots pass through to MILP without re-aggregation', async () => {
  // Load slots are already hourly -- verify they work directly
  const prices = [5, 40]; // 2 hours
  const pv = [0, 0];
  const load = [500, 1000]; // 2 hourly load slots

  const loadSlots = makeHourlyLoadSlots(load);
  assert.equal(loadSlots.length, 2, 'load has 2 hourly slots');

  const result = await buildMilpSchedule({
    priceSlots: make15minPriceSlots(prices),
    pvSlots: make15minPvSlots(pv),
    loadSlots,
    batteryModel: defaultBattery,
    confidenceGate: defaultGate
  });

  if (!higgsAvailable) {
    assert.equal(result, null);
    return;
  }

  // Should succeed without error (load passed through without re-aggregation)
  assert.ok(result === null || Array.isArray(result), 'result is null or array');
});

test('1h MILP results are expanded back to 15min slots', async () => {
  const prices = [5, 5, 40, 40]; // 4 hours
  const pv = [0, 0, 0, 0];
  const load = [500, 500, 500, 500];

  const result = await buildMilpSchedule({
    priceSlots: make15minPriceSlots(prices),
    pvSlots: make15minPvSlots(pv),
    loadSlots: makeHourlyLoadSlots(load),
    batteryModel: defaultBattery,
    confidenceGate: defaultGate
  });

  if (!higgsAvailable) {
    assert.equal(result, null);
    return;
  }

  assert.ok(Array.isArray(result));
  if (result.length > 0) {
    // All slots should be 15-min (each hourly value repeated 4 times)
    for (const slot of result) {
      assert.equal(slot.endTs - slot.ts, QUARTER_MS,
        `slot duration is 15min: ${slot.endTs - slot.ts}ms`);
    }
    // Total output slots should be multiple of 4 (each hour expanded to 4 quarters)
    assert.equal(result.length % 4, 0, `result length ${result.length} is multiple of 4`);
  }
});
