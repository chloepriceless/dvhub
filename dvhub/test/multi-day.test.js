import test from 'node:test';
import assert from 'node:assert/strict';

import { assessMultiDayHold } from '../services/optimizer/multi-day.js';
import { localDate, zoneOffsetMs } from '../tz-fast.js';

// --- Helpers ---

/**
 * Create tomorrow-based slots with a given value key.
 * Uses Date.now() + 86_400_000 as base so slots fall within tomorrow's window.
 */
// 06:00 Berlin am Berliner Tag heute + dayOffset (unabhaengig von der Zeitzone
// des Rechners — assessMultiDayHold rechnet seit 25.10.2026 in Europe/Berlin).
function berlinSixAm(dayOffset) {
  const today = localDate(Date.now(), 'Europe/Berlin');
  const [y, m, d] = today.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d + dayOffset, 6, 0, 0);
  return guess - zoneOffsetMs(guess - 2 * 3600000, 'Europe/Berlin');
}

function makeTomorrowSlots(count, valueKey, value, confidence = 0.8) {
  // Tomorrow 06:00 Berlin time (safe window for PV slots)
  const base = berlinSixAm(1);

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
  const base = berlinSixAm(0);

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

// Review 25.10.2026 (P3): „morgen“ hing an der Mitternacht des Rechners (UTC-Box:
// zwei Stunden daneben) und war fest 24 h lang. Jetzt Kalendertag in der
// Anlagen-Zeitzone, auch an den Umstellungstagen (23 bzw. 25 h).
function hourSlots(fromIso, count, powerW) {
  const base = Date.parse(fromIso);
  return Array.from({ length: count }, (_, i) => ({ ts: base + i * 3600000, endTs: base + (i + 1) * 3600000, powerW, confidence: 0.9 }));
}

function withTz(tz, fn) {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try { return fn(); } finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; }
}

test('assessMultiDayHold: morgen = Berliner Kalendertag, auch auf einer UTC-Box', () => {
  // 11.06. 00:30 Berlin = 10.06. 22:30Z. Morgen = 12.06. Berlin = 11.06. 22:00Z – 12.06. 22:00Z.
  const nowMs = Date.parse('2026-06-10T22:30:00Z');
  const pv = [
    ...hourSlots('2026-06-11T04:00:00Z', 10, 500), // heute (Berlin): 5 kWh, zaehlt nicht
    ...hourSlots('2026-06-12T04:00:00Z', 10, 200)  // morgen (Berlin): 2 kWh
  ];
  const result = withTz('UTC', () => assessMultiDayHold(pv, [], BATTERY_CAPACITY_WH, 8, 30, RT_EFFICIENCY, { nowMs, timeZone: 'Europe/Berlin' }));
  assert.ok(Math.abs(result.tomorrowPvKwh - 2) < 1e-9, `morgen ${result.tomorrowPvKwh} kWh`);
});

test('assessMultiDayHold: Umstellungstag mit 25 h zaehlt bis zur echten Mitternacht', () => {
  // Morgen = 25.10.2026 (Winterzeit): 24.10. 22:00Z bis 25.10. 23:00Z.
  const nowMs = Date.parse('2026-10-24T10:00:00Z');
  const pv = [
    ...hourSlots('2026-10-25T08:00:00Z', 4, 250), // 1 kWh
    ...hourSlots('2026-10-25T22:00:00Z', 1, 1000)  // 23:00–24:00 MEZ, noch der 25.10.: 1 kWh
  ];
  const result = assessMultiDayHold(pv, [], BATTERY_CAPACITY_WH, 8, 30, RT_EFFICIENCY, { nowMs, timeZone: 'Europe/Berlin' });
  assert.ok(Math.abs(result.tomorrowPvKwh - 2) < 1e-9, `morgen ${result.tomorrowPvKwh} kWh`);
});
