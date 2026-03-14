import test from 'node:test';
import assert from 'node:assert/strict';

import { filterSlotsByTimeWindow, computeNextPeriodBounds } from '../small-market-automation.js';

function buildNeedsRegeneration({
  runDate,
  lastState,
  priceSlotCount,
  currentSocPct,
  previousAutomationRules,
  batteryCapacityKwh
}) {
  const priceDataChanged = priceSlotCount !== (lastState?.lastPriceSlotCount || 0);
  const socChanged = batteryCapacityKwh > 0
    && currentSocPct != null
    && lastState?.lastSocPct != null
    && Math.abs(currentSocPct - lastState.lastSocPct) >= 5;

  return !lastState?.lastRunDate
    || lastState.lastRunDate !== runDate
    || !previousAutomationRules.length
    || priceDataChanged
    || socChanged;
}

const SLOT_MS = 15 * 60 * 1000;

function slotAt(iso, ctKwh = 0) {
  return { ts: Date.parse(iso), ct_kwh: ctKwh };
}

test('filterSlotsByTimeWindow filters slots inside a normal daytime window', () => {
  const slots = [
    slotAt('2026-01-15T12:45:00Z', 10), // 13:45 Berlin
    slotAt('2026-01-15T13:00:00Z', 11), // 14:00 Berlin
    slotAt('2026-01-15T16:45:00Z', 12), // 17:45 Berlin
    slotAt('2026-01-15T17:00:00Z', 13) // 18:00 Berlin
  ];

  const result = filterSlotsByTimeWindow({
    slots,
    searchWindowStart: '14:00',
    searchWindowEnd: '18:00',
    timeZone: 'Europe/Berlin'
  });

  assert.deepEqual(result.map((slot) => slot.ts), [slots[1].ts, slots[2].ts]);
});

test('filterSlotsByTimeWindow supports overnight windows where start > end', () => {
  const slots = [
    slotAt('2026-01-15T20:45:00Z', 10), // 21:45 Berlin (outside)
    slotAt('2026-01-15T21:00:00Z', 11), // 22:00 Berlin (inside)
    slotAt('2026-01-15T23:00:00Z', 12), // 00:00 Berlin (inside)
    slotAt('2026-01-16T04:45:00Z', 13), // 05:45 Berlin (inside)
    slotAt('2026-01-16T05:00:00Z', 14) // 06:00 Berlin (outside)
  ];

  const result = filterSlotsByTimeWindow({
    slots,
    searchWindowStart: '22:00',
    searchWindowEnd: '06:00',
    timeZone: 'Europe/Berlin'
  });

  assert.deepEqual(result.map((slot) => slot.ts), [slots[1].ts, slots[2].ts, slots[3].ts]);
});

test('filterSlotsByTimeWindow handles empty or missing window inputs', () => {
  assert.deepEqual(filterSlotsByTimeWindow({
    slots: [],
    searchWindowStart: '14:00',
    searchWindowEnd: '18:00',
    timeZone: 'Europe/Berlin'
  }), []);

  const slots = [slotAt('2026-01-15T13:00:00Z', 11)];

  assert.deepEqual(filterSlotsByTimeWindow({
    slots,
    searchWindowStart: null,
    searchWindowEnd: '18:00',
    timeZone: 'Europe/Berlin'
  }), []);

  assert.deepEqual(filterSlotsByTimeWindow({
    slots,
    searchWindowStart: '14:00',
    searchWindowEnd: undefined,
    timeZone: 'Europe/Berlin'
  }), []);
});

test('regeneration state machine does not regenerate on same day with unchanged inputs', () => {
  const needsRegeneration = buildNeedsRegeneration({
    runDate: '2026-03-13',
    lastState: {
      lastRunDate: '2026-03-13',
      lastPriceSlotCount: 96,
      lastSocPct: 50
    },
    priceSlotCount: 96,
    currentSocPct: 54,
    previousAutomationRules: [{ id: 'sma-1' }],
    batteryCapacityKwh: 25.6
  });

  assert.equal(needsRegeneration, false);
});

test('regeneration state machine regenerates on day change', () => {
  const needsRegeneration = buildNeedsRegeneration({
    runDate: '2026-03-13',
    lastState: {
      lastRunDate: '2026-03-12',
      lastPriceSlotCount: 96,
      lastSocPct: 50
    },
    priceSlotCount: 96,
    currentSocPct: 50,
    previousAutomationRules: [{ id: 'sma-1' }],
    batteryCapacityKwh: 25.6
  });

  assert.equal(needsRegeneration, true);
});

test('regeneration state machine regenerates when price slot count changes', () => {
  const needsRegeneration = buildNeedsRegeneration({
    runDate: '2026-03-13',
    lastState: {
      lastRunDate: '2026-03-13',
      lastPriceSlotCount: 92,
      lastSocPct: 50
    },
    priceSlotCount: 96,
    currentSocPct: 50,
    previousAutomationRules: [{ id: 'sma-1' }],
    batteryCapacityKwh: 25.6
  });

  assert.equal(needsRegeneration, true);
});

test('regeneration state machine regenerates when soc changes by at least 5%', () => {
  const needsRegeneration = buildNeedsRegeneration({
    runDate: '2026-03-13',
    lastState: {
      lastRunDate: '2026-03-13',
      lastPriceSlotCount: 96,
      lastSocPct: 50
    },
    priceSlotCount: 96,
    currentSocPct: 55,
    previousAutomationRules: [{ id: 'sma-1' }],
    batteryCapacityKwh: 25.6
  });

  assert.equal(needsRegeneration, true);
});

test('regeneration state machine ignores soc deltas when battery capacity is not configured', () => {
  const needsRegeneration = buildNeedsRegeneration({
    runDate: '2026-03-13',
    lastState: {
      lastRunDate: '2026-03-13',
      lastPriceSlotCount: 96,
      lastSocPct: 20
    },
    priceSlotCount: 96,
    currentSocPct: 80,
    previousAutomationRules: [{ id: 'sma-1' }],
    batteryCapacityKwh: 0
  });

  assert.equal(needsRegeneration, false);
});

test('regeneration state machine regenerates when there are no existing automation rules', () => {
  const needsRegeneration = buildNeedsRegeneration({
    runDate: '2026-03-13',
    lastState: {
      lastRunDate: '2026-03-13',
      lastPriceSlotCount: 96,
      lastSocPct: 50
    },
    priceSlotCount: 96,
    currentSocPct: 50,
    previousAutomationRules: [],
    batteryCapacityKwh: 25.6
  });

  assert.equal(needsRegeneration, true);
});

// Keep a basic sanity check around slot spacing assumptions used by planner callers.
test('slot fixture helper still models 15-minute spacing', () => {
  const first = slotAt('2026-01-15T13:00:00Z', 11);
  const second = slotAt('2026-01-15T13:15:00Z', 12);
  assert.equal(second.ts - first.ts, SLOT_MS);
});

// --- computeNextPeriodBounds tests ---

test('computeNextPeriodBounds returns current overnight period when now is after start', () => {
  // 2026-03-14 at 16:00 Berlin (15:00 UTC in winter, but March = CET+1 = 15:00 UTC)
  const now = Date.parse('2026-03-14T15:00:00Z'); // 16:00 Berlin
  const bounds = computeNextPeriodBounds({
    now,
    searchWindowStart: '14:00',
    searchWindowEnd: '09:00',
    timeZone: 'Europe/Berlin'
  });

  assert.ok(bounds != null);
  // Start should be 2026-03-14 14:00 Berlin = 13:00 UTC
  assert.equal(new Date(bounds.startTs).toISOString(), '2026-03-14T13:00:00.000Z');
  // End should be 2026-03-15 09:00 Berlin = 08:00 UTC
  assert.equal(new Date(bounds.endTs).toISOString(), '2026-03-15T08:00:00.000Z');
});

test('computeNextPeriodBounds returns current overnight period when now is in tail (before end)', () => {
  // 2026-03-15 at 07:00 Berlin (06:00 UTC) — still within the 14:00→09:00 period that started yesterday
  const now = Date.parse('2026-03-15T06:00:00Z'); // 07:00 Berlin
  const bounds = computeNextPeriodBounds({
    now,
    searchWindowStart: '14:00',
    searchWindowEnd: '09:00',
    timeZone: 'Europe/Berlin'
  });

  assert.ok(bounds != null);
  // Start should be 2026-03-14 14:00 Berlin = 13:00 UTC
  assert.equal(new Date(bounds.startTs).toISOString(), '2026-03-14T13:00:00.000Z');
  // End should be 2026-03-15 09:00 Berlin = 08:00 UTC
  assert.equal(new Date(bounds.endTs).toISOString(), '2026-03-15T08:00:00.000Z');
});

test('computeNextPeriodBounds returns next overnight period when now is between end and start', () => {
  // 2026-03-15 at 10:00 Berlin (09:00 UTC) — between 09:00 and 14:00, next period starts at 14:00
  const now = Date.parse('2026-03-15T09:00:00Z'); // 10:00 Berlin
  const bounds = computeNextPeriodBounds({
    now,
    searchWindowStart: '14:00',
    searchWindowEnd: '09:00',
    timeZone: 'Europe/Berlin'
  });

  assert.ok(bounds != null);
  // Start should be 2026-03-15 14:00 Berlin = 13:00 UTC
  assert.equal(new Date(bounds.startTs).toISOString(), '2026-03-15T13:00:00.000Z');
  // End should be 2026-03-16 09:00 Berlin = 08:00 UTC (March 29 is DST switch, but not yet)
  assert.equal(new Date(bounds.endTs).toISOString(), '2026-03-16T08:00:00.000Z');
});

test('computeNextPeriodBounds limits optimizer to single period (prevents cross-day selection)', () => {
  // Simulate: now is 16:00 on March 14, EPEX data has slots for both tonight AND tomorrow night
  const now = Date.parse('2026-03-14T15:00:00Z'); // 16:00 Berlin
  const bounds = computeNextPeriodBounds({
    now,
    searchWindowStart: '14:00',
    searchWindowEnd: '09:00',
    timeZone: 'Europe/Berlin'
  });

  // Tonight's slots (should be included)
  const tonightSlot = Date.parse('2026-03-14T17:00:00Z'); // 18:00 Berlin
  const tomorrowMorningSlot = Date.parse('2026-03-15T06:00:00Z'); // 07:00 Berlin

  // Tomorrow night's slots (should be EXCLUDED)
  const tomorrowNightSlot = Date.parse('2026-03-15T17:00:00Z'); // 18:00 Berlin next day

  assert.ok(tonightSlot >= bounds.startTs && tonightSlot < bounds.endTs, 'tonight slot should be in period');
  assert.ok(tomorrowMorningSlot >= bounds.startTs && tomorrowMorningSlot < bounds.endTs, 'tomorrow morning slot should be in period');
  assert.ok(tomorrowNightSlot >= bounds.endTs, 'tomorrow night slot should be outside period');
});

test('computeNextPeriodBounds handles same-day window', () => {
  // Window 09:00→14:00, now is 10:00
  const now = Date.parse('2026-03-14T09:00:00Z'); // 10:00 Berlin
  const bounds = computeNextPeriodBounds({
    now,
    searchWindowStart: '09:00',
    searchWindowEnd: '14:00',
    timeZone: 'Europe/Berlin'
  });

  assert.ok(bounds != null);
  assert.equal(new Date(bounds.startTs).toISOString(), '2026-03-14T08:00:00.000Z'); // 09:00 Berlin
  assert.equal(new Date(bounds.endTs).toISOString(), '2026-03-14T13:00:00.000Z');   // 14:00 Berlin
});

test('computeNextPeriodBounds returns null for invalid inputs', () => {
  assert.equal(computeNextPeriodBounds({ now: NaN, searchWindowStart: '14:00', searchWindowEnd: '09:00' }), null);
  assert.equal(computeNextPeriodBounds({ now: Date.now(), searchWindowStart: null, searchWindowEnd: '09:00' }), null);
  assert.equal(computeNextPeriodBounds({ now: Date.now(), searchWindowStart: '14:00', searchWindowEnd: null }), null);
});
