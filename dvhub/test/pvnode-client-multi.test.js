import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStrings, localWallClockToUtcIso, extractValues, clampForecastDays } from '../services/forecast/pvnode-client.js';

// T-PVNODE-V2 (2026-06-22): the V1 chunkPlants/buildQueryParams model (≤2 planes per
// request → ⌈N/2⌉ GETs) was replaced by the V2 single-request `strings[]` model plus
// site-local→UTC timestamp conversion. These tests cover the new pure builders.

test('buildStrings maps ALL planes into one V2 strings[] (no 2-plane chunking)', () => {
  const plants = [
    { kwp: 3, tiltDeg: 30, azimuthDeg: 180 },
    { kwp: 5, tiltDeg: 25, azimuthDeg: 90 },
    { kwp: 2, tiltDeg: 35, azimuthDeg: 270 }
  ];
  const strings = buildStrings(plants);
  assert.equal(strings.length, 3, 'all planes in a single request');
  assert.deepEqual(strings[0], { slope: 30, orientation: 180, power_kw: 3 });
  assert.deepEqual(strings[1], { slope: 25, orientation: 90, power_kw: 5 });
  assert.deepEqual(strings[2], { slope: 35, orientation: 270, power_kw: 2 });
});

test('buildStrings drops invalid planes (kwp<=0 / non-finite geometry)', () => {
  const strings = buildStrings([
    { kwp: 5, tiltDeg: 30, azimuthDeg: 180 },
    { kwp: 0, tiltDeg: 30, azimuthDeg: 180 },
    { kwp: 4, tiltDeg: 'x', azimuthDeg: 180 }
  ]);
  assert.equal(strings.length, 1);
  assert.equal(strings[0].power_kw, 5);
});

test('buildStrings sends geometry only (V1 shading params are NOT forwarded — format differs in V2)', () => {
  const strings = buildStrings([
    { kwp: 5, tiltDeg: 30, azimuthDeg: 180, skyObstructionConfig: 'HORIZON', shadingConfig: 'ROW' }
  ]);
  assert.deepEqual(Object.keys(strings[0]).sort(), ['orientation', 'power_kw', 'slope']);
});

test('buildStrings([]) and non-array input → []', () => {
  assert.deepEqual(buildStrings([]), []);
  assert.deepEqual(buildStrings(null), []);
});

test('localWallClockToUtcIso converts Berlin summer wall-clock (CEST +02:00) to UTC', () => {
  assert.equal(localWallClockToUtcIso('2026-06-22T14:00:00', 'Europe/Berlin'), '2026-06-22T12:00:00.000Z');
});

test('localWallClockToUtcIso converts Berlin winter wall-clock (CET +01:00) to UTC', () => {
  assert.equal(localWallClockToUtcIso('2026-01-15T14:00:00', 'Europe/Berlin'), '2026-01-15T13:00:00.000Z');
});

test('localWallClockToUtcIso trusts an explicit-Z timestamp (normalized to .000Z)', () => {
  assert.equal(localWallClockToUtcIso('2026-06-22T12:00:00Z', 'Europe/Berlin'), '2026-06-22T12:00:00.000Z');
});

test('localWallClockToUtcIso returns null on nullish / unparseable input', () => {
  assert.equal(localWallClockToUtcIso(null, 'Europe/Berlin'), null);
  assert.equal(localWallClockToUtcIso('not-a-date', 'Europe/Berlin'), null);
});

test('extractValues parses a V2 ForecastResponse (values[]/pv_power), converts ts→UTC, skips null', () => {
  const body = {
    timezone: 'Europe/Berlin',
    values: [
      { timestamp: '2026-06-22T12:00:00', pv_power: 4200 },
      { timestamp: '2026-06-22T12:15:00', pv_power: null }, // no value (e.g. night) → skipped
      { timestamp: '2026-06-22T12:30:00', pv_power: 4500 }
    ]
  };
  const rows = extractValues(body);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { ts_utc: '2026-06-22T10:00:00.000Z', power_w: 4200 });
  assert.deepEqual(rows[1], { ts_utc: '2026-06-22T10:30:00.000Z', power_w: 4500 });
});

test('extractValues tolerates legacy shapes (forecasts[]/data[] + field synonyms)', () => {
  const r1 = extractValues({ forecasts: [{ timestamp: '2026-01-01T12:00:00Z', power_w: 1234 }] });
  assert.deepEqual(r1, [{ ts_utc: '2026-01-01T12:00:00.000Z', power_w: 1234 }]);
  const r2 = extractValues({ data: [{ ts: '2026-02-02T13:30:00Z', power: 567 }] });
  assert.deepEqual(r2, [{ ts_utc: '2026-02-02T13:30:00.000Z', power_w: 567 }]);
});

test('clampForecastDays: default 2 for empty/invalid, clamp to 1..7, floor', () => {
  assert.equal(clampForecastDays(undefined), 2, 'unset → 2 (Free-tier reality)');
  assert.equal(clampForecastDays(''), 2);
  assert.equal(clampForecastDays(null), 2);
  assert.equal(clampForecastDays('abc'), 2, 'NaN → fallback');
  assert.equal(clampForecastDays(2), 2);
  assert.equal(clampForecastDays('7'), 7, 'string number accepted');
  assert.equal(clampForecastDays(9), 7, 'clamp above 7');
  assert.equal(clampForecastDays(0), 1, 'clamp below 1');
  assert.equal(clampForecastDays(-5), 1);
  assert.equal(clampForecastDays(3.9), 3, 'floored');
  assert.equal(clampForecastDays('', 5), 5, 'custom fallback honoured');
});
