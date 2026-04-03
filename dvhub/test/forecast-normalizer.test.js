import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeForecast,
  averageSlotConfidence,
  aggregateTo1h
} from '../services/optimizer/forecast-normalizer.js';

// --- Test 1: normalizeForecast converts price slots from ISO to epoch-ms ---
test('normalizeForecast: converts price slots from ISO strings to epoch-ms timestamps', () => {
  const forecastResponse = {
    price: {
      resolution: '15min',
      slots: [
        { start: '2026-04-03T00:00:00.000Z', end: '2026-04-03T00:15:00.000Z', ctKwh: 5.2, confidence: 0.95 },
        { start: '2026-04-03T00:15:00.000Z', end: '2026-04-03T00:30:00.000Z', ctKwh: 4.8, confidence: 0.93 }
      ]
    },
    pv: { resolution: '15min', slots: [] },
    load: { resolution: '1h', slots: [] }
  };

  const result = normalizeForecast(forecastResponse);

  assert.equal(result.price.resolution, '15min');
  assert.equal(result.price.slots.length, 2);
  assert.equal(result.price.slots[0].ts, new Date('2026-04-03T00:00:00.000Z').getTime());
  assert.equal(result.price.slots[0].endTs, new Date('2026-04-03T00:15:00.000Z').getTime());
  assert.equal(result.price.slots[0].ctKwh, 5.2);
  assert.equal(result.price.slots[0].confidence, 0.95);
  // Ensure old fields are NOT present
  assert.equal(result.price.slots[0].start, undefined);
  assert.equal(result.price.slots[0].end, undefined);
});

// --- Test 2: normalizeForecast converts PV slots ---
test('normalizeForecast: converts PV slots from ISO to epoch-ms with powerW field', () => {
  const forecastResponse = {
    price: { resolution: '15min', slots: [] },
    pv: {
      resolution: '15min',
      slots: [
        { start: '2026-04-03T10:00:00.000Z', end: '2026-04-03T10:15:00.000Z', powerW: 1200, confidence: 0.72 }
      ]
    },
    load: { resolution: '1h', slots: [] }
  };

  const result = normalizeForecast(forecastResponse);

  assert.equal(result.pv.resolution, '15min');
  assert.equal(result.pv.slots.length, 1);
  assert.equal(result.pv.slots[0].ts, new Date('2026-04-03T10:00:00.000Z').getTime());
  assert.equal(result.pv.slots[0].endTs, new Date('2026-04-03T10:15:00.000Z').getTime());
  assert.equal(result.pv.slots[0].powerW, 1200);
  assert.equal(result.pv.slots[0].confidence, 0.72);
});

// --- Test 3: normalizeForecast converts load slots ---
test('normalizeForecast: converts load slots from ISO to epoch-ms', () => {
  const forecastResponse = {
    price: { resolution: '15min', slots: [] },
    pv: { resolution: '15min', slots: [] },
    load: {
      resolution: '1h',
      slots: [
        { start: '2026-04-03T08:00:00.000Z', end: '2026-04-03T09:00:00.000Z', powerW: 850, confidence: 0.5 }
      ]
    }
  };

  const result = normalizeForecast(forecastResponse);

  assert.equal(result.load.resolution, '1h');
  assert.equal(result.load.slots.length, 1);
  assert.equal(result.load.slots[0].ts, new Date('2026-04-03T08:00:00.000Z').getTime());
  assert.equal(result.load.slots[0].endTs, new Date('2026-04-03T09:00:00.000Z').getTime());
  assert.equal(result.load.slots[0].powerW, 850);
  assert.equal(result.load.slots[0].confidence, 0.5);
});

// --- Test 4: averageSlotConfidence computes weighted average ---
test('averageSlotConfidence: computes average confidence across slots', () => {
  const slots = [
    { ts: 1000, endTs: 2000, ctKwh: 5, confidence: 0.9 },
    { ts: 2000, endTs: 3000, ctKwh: 6, confidence: 0.8 },
    { ts: 3000, endTs: 4000, ctKwh: 7, confidence: 0.7 }
  ];

  const avg = averageSlotConfidence(slots);
  assert.ok(Math.abs(avg - 0.8) < 0.001);
});

// --- Test 4b: averageSlotConfidence returns 0.3 for empty slots ---
test('averageSlotConfidence: returns 0.3 default for empty slots array', () => {
  assert.equal(averageSlotConfidence([]), 0.3);
});

// --- Test 5: aggregateTo1h averages 15min price slots per hour ---
test('aggregateTo1h: aggregates 15min price slots to 1h by averaging ctKwh, min confidence', () => {
  const baseTs = new Date('2026-04-03T10:00:00.000Z').getTime();
  const slots15 = [
    { ts: baseTs, endTs: baseTs + 900000, ctKwh: 4.0, confidence: 0.90 },
    { ts: baseTs + 900000, endTs: baseTs + 1800000, ctKwh: 5.0, confidence: 0.85 },
    { ts: baseTs + 1800000, endTs: baseTs + 2700000, ctKwh: 6.0, confidence: 0.80 },
    { ts: baseTs + 2700000, endTs: baseTs + 3600000, ctKwh: 7.0, confidence: 0.95 }
  ];

  const result = aggregateTo1h(slots15, 'ctKwh');

  assert.equal(result.length, 1);
  assert.equal(result[0].ts, baseTs);
  assert.equal(result[0].endTs, baseTs + 3600000);
  // Average: (4 + 5 + 6 + 7) / 4 = 5.5
  assert.ok(Math.abs(result[0].ctKwh - 5.5) < 0.001);
  // Min confidence: min(0.90, 0.85, 0.80, 0.95) = 0.80
  assert.equal(result[0].confidence, 0.80);
});

// --- Test 6: aggregateTo1h averages 15min PV slots per hour ---
test('aggregateTo1h: aggregates 15min PV slots to 1h by averaging powerW, min confidence', () => {
  const baseTs = new Date('2026-04-03T12:00:00.000Z').getTime();
  const slots15 = [
    { ts: baseTs, endTs: baseTs + 900000, powerW: 1000, confidence: 0.70 },
    { ts: baseTs + 900000, endTs: baseTs + 1800000, powerW: 1200, confidence: 0.65 },
    { ts: baseTs + 1800000, endTs: baseTs + 2700000, powerW: 1100, confidence: 0.72 },
    { ts: baseTs + 2700000, endTs: baseTs + 3600000, powerW: 900, confidence: 0.68 }
  ];

  const result = aggregateTo1h(slots15, 'powerW');

  assert.equal(result.length, 1);
  // Average: (1000+1200+1100+900)/4 = 1050
  assert.ok(Math.abs(result[0].powerW - 1050) < 0.001);
  // Min confidence: 0.65
  assert.equal(result[0].confidence, 0.65);
});

// --- Test 7: aggregateTo1h passes through 1h load slots unchanged ---
test('aggregateTo1h: passes through 1h load slots unchanged (already hourly)', () => {
  const baseTs = new Date('2026-04-03T14:00:00.000Z').getTime();
  const slots1h = [
    { ts: baseTs, endTs: baseTs + 3600000, powerW: 850, confidence: 0.5 }
  ];

  const result = aggregateTo1h(slots1h, 'powerW');

  assert.equal(result.length, 1);
  assert.equal(result[0].ts, baseTs);
  assert.equal(result[0].powerW, 850);
  assert.equal(result[0].confidence, 0.5);
});

// --- Test 8: normalizeForecast with empty slots returns empty ---
test('normalizeForecast: empty slots arrays return empty normalized result', () => {
  const forecastResponse = {
    price: { resolution: '15min', slots: [] },
    pv: { resolution: '15min', slots: [] },
    load: { resolution: '1h', slots: [] }
  };

  const result = normalizeForecast(forecastResponse);

  assert.equal(result.price.slots.length, 0);
  assert.equal(result.pv.slots.length, 0);
  assert.equal(result.load.slots.length, 0);
});
