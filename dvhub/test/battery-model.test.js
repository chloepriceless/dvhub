import test from 'node:test';
import assert from 'node:assert/strict';

import { simulateSoc } from '../services/optimizer/battery-model.js';

// --- Test 1: Constant charge with efficiency losses ---
test('simulateSoc: constant charge 3000W for 1h on 10kWh battery from 50% SOC returns ~78.8%', () => {
  const result = simulateSoc({
    initialSocPct: 50,
    capacityWh: 10000,
    roundTripEfficiency: 0.92,
    maxChargeW: 5000,
    maxDischargeW: 5000,
    minSocPct: 0,
    maxSocPct: 100,
    schedule: [{ ts: 1000, powerW: 3000, dtHours: 1 }]
  });

  assert.equal(result.length, 1);
  // sqrt(0.92) ~ 0.95917 => 3000 * 1 * 0.95917 = 2877.5 Wh => 5000 + 2877.5 = 7877.5 => 78.8%
  assert.equal(result[0].socPct, 78.8);
  assert.equal(result[0].appliedPowerW, 3000);
  assert.equal(result[0].clipReason, null);
});

// --- Test 2: Constant discharge with efficiency losses ---
test('simulateSoc: constant discharge 3000W for 1h on 10kWh battery from 80% SOC returns ~48.7%', () => {
  const result = simulateSoc({
    initialSocPct: 80,
    capacityWh: 10000,
    roundTripEfficiency: 0.92,
    maxChargeW: 5000,
    maxDischargeW: 5000,
    minSocPct: 0,
    maxSocPct: 100,
    schedule: [{ ts: 1000, powerW: -3000, dtHours: 1 }]
  });

  assert.equal(result.length, 1);
  // sqrt(0.92) ~ 0.95917 => 3000 * 1 / 0.95917 = 3127.7 Wh => 8000 - 3127.7 = 4872.3 => 48.7%
  assert.equal(result[0].socPct, 48.7);
  assert.equal(result[0].appliedPowerW, -3000);
  assert.equal(result[0].clipReason, null);
});

// --- Test 3: SOC clipped at maxSocPct ---
test('simulateSoc: SOC clipped at maxSocPct when charging would exceed capacity', () => {
  const result = simulateSoc({
    initialSocPct: 95,
    capacityWh: 10000,
    roundTripEfficiency: 0.92,
    maxChargeW: 5000,
    maxDischargeW: 5000,
    minSocPct: 0,
    maxSocPct: 100,
    schedule: [{ ts: 1000, powerW: 3000, dtHours: 1 }]
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].socPct, 100);
  assert.equal(result[0].clipReason, 'soc_max');
  // appliedPowerW should be less than 3000 since SOC was clipped
  assert.ok(result[0].appliedPowerW < 3000);
  assert.ok(result[0].appliedPowerW > 0);
});

// --- Test 4: SOC clipped at minSocPct ---
test('simulateSoc: SOC clipped at minSocPct when discharging would go below minimum', () => {
  const result = simulateSoc({
    initialSocPct: 15,
    capacityWh: 10000,
    roundTripEfficiency: 0.92,
    maxChargeW: 5000,
    maxDischargeW: 5000,
    minSocPct: 10,
    maxSocPct: 100,
    schedule: [{ ts: 1000, powerW: -3000, dtHours: 1 }]
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].socPct, 10);
  assert.equal(result[0].clipReason, 'soc_min');
  // appliedPowerW should be less negative than -3000 since SOC was clipped
  assert.ok(result[0].appliedPowerW > -3000);
  assert.ok(result[0].appliedPowerW < 0);
});

// --- Test 5: Power clipped at maxChargeW ---
test('simulateSoc: power clipped at maxChargeW when charge exceeds limit', () => {
  const result = simulateSoc({
    initialSocPct: 50,
    capacityWh: 10000,
    roundTripEfficiency: 0.92,
    maxChargeW: 3000,
    maxDischargeW: 3000,
    minSocPct: 0,
    maxSocPct: 100,
    schedule: [{ ts: 1000, powerW: 5000, dtHours: 1 }]
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].clipReason, 'power_max');
  // Power should be clamped to maxChargeW
  assert.equal(result[0].powerW, 3000);
  assert.equal(result[0].appliedPowerW, 3000);
});

// --- Test 6: Power clipped at maxDischargeW ---
test('simulateSoc: power clipped at maxDischargeW when discharge exceeds limit', () => {
  const result = simulateSoc({
    initialSocPct: 50,
    capacityWh: 10000,
    roundTripEfficiency: 0.92,
    maxChargeW: 3000,
    maxDischargeW: 3000,
    minSocPct: 0,
    maxSocPct: 100,
    schedule: [{ ts: 1000, powerW: -5000, dtHours: 1 }]
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].clipReason, 'power_max');
  // Power should be clamped to -maxDischargeW
  assert.equal(result[0].powerW, -3000);
  assert.equal(result[0].appliedPowerW, -3000);
});

// --- Test 7: Empty schedule returns empty trajectory ---
test('simulateSoc: empty schedule returns empty trajectory', () => {
  const result = simulateSoc({
    initialSocPct: 50,
    capacityWh: 10000,
    schedule: []
  });

  assert.deepEqual(result, []);
});

// --- Test 8: Zero-power steps pass through without SOC change ---
test('simulateSoc: zero-power step passes through without SOC change', () => {
  const result = simulateSoc({
    initialSocPct: 50,
    capacityWh: 10000,
    roundTripEfficiency: 0.92,
    maxChargeW: 3000,
    maxDischargeW: 3000,
    minSocPct: 0,
    maxSocPct: 100,
    schedule: [{ ts: 1000, powerW: 0, dtHours: 1 }]
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].socPct, 50);
  assert.equal(result[0].powerW, 0);
  assert.equal(result[0].appliedPowerW, 0);
  assert.equal(result[0].clipReason, null);
});

// --- Test 9: appliedPowerW reflects ACTUAL power after all clipping ---
test('simulateSoc: appliedPowerW reflects actual power used after SOC bound clipping', () => {
  // Charge from 98% with 3000W for 1h -- SOC will hit 100% before full charge completes
  const result = simulateSoc({
    initialSocPct: 98,
    capacityWh: 10000,
    roundTripEfficiency: 0.92,
    maxChargeW: 5000,
    maxDischargeW: 5000,
    minSocPct: 0,
    maxSocPct: 100,
    schedule: [{ ts: 1000, powerW: 3000, dtHours: 1 }]
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].socPct, 100);
  assert.equal(result[0].clipReason, 'soc_max');
  // appliedPowerW should be the actual power that got 200Wh into battery
  // 200Wh / (dtHours * effCharge) = 200 / (1 * sqrt(0.92)) ~ 208.5W
  assert.ok(result[0].appliedPowerW > 200);
  assert.ok(result[0].appliedPowerW < 300);
});
