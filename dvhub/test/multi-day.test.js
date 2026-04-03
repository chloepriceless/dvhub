import test from 'node:test';
import assert from 'node:assert/strict';

import { assessMultiDayHold } from '../services/optimizer/multi-day.js';

// --- Helpers ---

/**
 * Create tomorrow-based slots with a given value key.
 * Uses Date.now() + 86_400_000 as base so slots fall within tomorrow's window.
 */
function makeTomorrowSlots(count, valueKey, value, confidence = 0.8) {
  const now = new Date();
  // Tomorrow 06:00 Berlin time (safe window for PV slots)
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(6, 0, 0, 0);
  const base = tomorrow.getTime();

  return Array.from({ length: count }, (_, i) => ({
    ts: base + i * 3600000,
    endTs: base + (i + 1) * 3600000,
    [valueKey]: value,
    confidence
  }));
}

/**
 * Create today-only slots (no tomorrow data).
 */
function makeTodaySlots(count, valueKey, value, confidence = 0.8) {
  const now = new Date();
  now.setHours(6, 0, 0, 0);
  const base = now.getTime();

  return Array.from({ length: count }, (_, i) => ({
    ts: base + i * 3600000,
    endTs: base + (i + 1) * 3600000,
    [valueKey]: value,
    confidence
  }));
}

const BATTERY_CAPACITY_WH = 10000; // 10 kWh
const RT_EFFICIENCY = 0.92;

// --- Test 1: Tomorrow has sufficient PV (>= 30% of capacity) ---
test('assessMultiDayHold: sufficient PV tomorrow (5 kWh) -> holdBattery=false', () => {
  // 5 hours * 1000W = 5000 Wh = 5 kWh (50% of 10 kWh battery -- above 30%)
  const pvSlots = makeTomorrowSlots(5, 'powerW', 1000);
  const loadSlots = makeTomorrowSlots(5, 'powerW', 800);

  const result = assessMultiDayHold(pvSlots, loadSlots, BATTERY_CAPACITY_WH, 8, 30, RT_EFFICIENCY);

  assert.equal(result.holdBattery, false);
  assert.equal(result.reason, 'tomorrow_has_pv');
  assert.equal(result.tomorrowPvKwh, 5);
  assert.equal(result.tomorrowDeficitKwh, 0);
});

// --- Test 2: Low PV tomorrow, high import price, low feed-in -> hold ---
test('assessMultiDayHold: low PV (2 kWh), high import, low feed-in -> holdBattery=true', () => {
  // 2 hours * 1000W = 2000 Wh = 2 kWh (20% of 10 kWh -- below 30%)
  const pvSlots = makeTomorrowSlots(2, 'powerW', 1000);
  // 8 hours * 1000W = 8000 Wh = 8 kWh load
  const loadSlots = makeTomorrowSlots(8, 'powerW', 1000);

  // feedInCtKwh = 8 ct/kWh (low), importCtKwh = 30 ct/kWh (high)
  // deficit = 8 - 2 = 6 kWh, P(need) = min(1, 6/10) = 0.6
  // avoidedCost = 30 * 0.92 * 0.6 = 16.56 ct/kWh
  // feedIn = 8 ct/kWh -> hold (16.56 > 8)
  const result = assessMultiDayHold(pvSlots, loadSlots, BATTERY_CAPACITY_WH, 8, 30, RT_EFFICIENCY);

  assert.equal(result.holdBattery, true);
  assert.equal(result.reason, 'tomorrow_low_pv_hold');
  assert.equal(result.tomorrowPvKwh, 2);
  assert.equal(result.tomorrowDeficitKwh, 6);
});

// --- Test 3: Low PV but feed-in is more profitable ---
test('assessMultiDayHold: low PV but high feed-in tariff -> holdBattery=false', () => {
  // 2 kWh PV, 4 kWh load -> deficit = 2 kWh
  const pvSlots = makeTomorrowSlots(2, 'powerW', 1000);
  const loadSlots = makeTomorrowSlots(4, 'powerW', 1000);

  // feedInCtKwh = 20 ct/kWh (high), importCtKwh = 10 ct/kWh (low)
  // deficit = 4 - 2 = 2 kWh, P(need) = min(1, 2/10) = 0.2
  // avoidedCost = 10 * 0.92 * 0.2 = 1.84 ct/kWh
  // feedIn = 20 ct/kWh -> feed in (1.84 < 20)
  const result = assessMultiDayHold(pvSlots, loadSlots, BATTERY_CAPACITY_WH, 20, 10, RT_EFFICIENCY);

  assert.equal(result.holdBattery, false);
  assert.equal(result.reason, 'feed_in_more_profitable');
  assert.equal(result.tomorrowPvKwh, 2);
  assert.equal(result.tomorrowDeficitKwh, 2);
});

// --- Test 4: No tomorrow PV slots (only today data) ---
test('assessMultiDayHold: no tomorrow data -> holdBattery=false', () => {
  const pvSlots = makeTodaySlots(5, 'powerW', 1000);
  const loadSlots = makeTodaySlots(5, 'powerW', 800);

  const result = assessMultiDayHold(pvSlots, loadSlots, BATTERY_CAPACITY_WH, 8, 30, RT_EFFICIENCY);

  assert.equal(result.holdBattery, false);
  assert.equal(result.reason, 'no_tomorrow_data');
  assert.equal(result.tomorrowPvKwh, 0);
  assert.equal(result.tomorrowDeficitKwh, 0);
});

// --- Test 5: Confidence guard -- PV confidence < 0.5 ---
test('assessMultiDayHold: low confidence (< 0.5) -> holdBattery=false', () => {
  const pvSlots = makeTomorrowSlots(2, 'powerW', 1000, 0.3); // low confidence
  const loadSlots = makeTomorrowSlots(8, 'powerW', 1000);

  const result = assessMultiDayHold(pvSlots, loadSlots, BATTERY_CAPACITY_WH, 8, 30, RT_EFFICIENCY);

  assert.equal(result.holdBattery, false);
  assert.equal(result.reason, 'confidence_too_low');
});

// --- Test 6: Confidence above threshold (0.7) -> normal decision ---
test('assessMultiDayHold: sufficient confidence (0.7) -> normal hold decision', () => {
  const pvSlots = makeTomorrowSlots(2, 'powerW', 1000, 0.7);
  const loadSlots = makeTomorrowSlots(8, 'powerW', 1000);

  // Same as test 2 but with 0.7 confidence -- should still hold
  const result = assessMultiDayHold(pvSlots, loadSlots, BATTERY_CAPACITY_WH, 8, 30, RT_EFFICIENCY);

  assert.equal(result.holdBattery, true);
  assert.equal(result.reason, 'tomorrow_low_pv_hold');
});

// --- Test 7: P(need) calculation correctness ---
test('assessMultiDayHold: P(need) caps at 1.0 when deficit > capacity', () => {
  // 1 kWh PV, 15 kWh load -> deficit = 14 kWh -> P(need) = min(1, 14/10) = 1.0
  const pvSlots = makeTomorrowSlots(1, 'powerW', 1000);
  const loadSlots = makeTomorrowSlots(15, 'powerW', 1000);

  // avoidedCost = 30 * 0.92 * 1.0 = 27.6 ct/kWh
  // feedIn = 8 -> hold (27.6 > 8)
  const result = assessMultiDayHold(pvSlots, loadSlots, BATTERY_CAPACITY_WH, 8, 30, RT_EFFICIENCY);

  assert.equal(result.holdBattery, true);
  assert.equal(result.reason, 'tomorrow_low_pv_hold');
  assert.equal(result.tomorrowDeficitKwh, 14);
});

// --- Test 8: Empty pvSlots -> conservative hold (no PV data for tomorrow) ---
test('assessMultiDayHold: empty pvSlots -> holdBattery=false (no tomorrow data)', () => {
  const result = assessMultiDayHold([], [], BATTERY_CAPACITY_WH, 8, 30, RT_EFFICIENCY);

  assert.equal(result.holdBattery, false);
  assert.equal(result.reason, 'no_tomorrow_data');
});
