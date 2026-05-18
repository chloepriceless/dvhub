import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLoadForecastQuery,
  computeLoadConfidence,
  formatLoadSlots,
  createLoadForecast
} from '../services/forecast/load-forecast.js';

// --- buildLoadForecastQuery ---

test('buildLoadForecastQuery returns SQL with DOW match and 28-day window', () => {
  const sql = buildLoadForecastQuery();
  assert.ok(sql.includes('energy_slots_15m'), 'should query energy_slots_15m');
  assert.ok(sql.includes('load_power_w'), 'should filter by load_power_w series_key');
  assert.ok(sql.includes('EXTRACT(DOW'), 'should use EXTRACT(DOW ...) for day-of-week match');
  assert.ok(sql.includes('28 days'), 'should use 28-day lookback window');
});

test('buildLoadForecastQuery uses load_power_w as series_key', () => {
  const sql = buildLoadForecastQuery();
  assert.ok(sql.includes("'load_power_w'"), 'should use load_power_w literal');
});

test('buildLoadForecastQuery filters by the source_kind values telemetry-store actually writes', () => {
  const sql = buildLoadForecastQuery();
  // telemetry-store-pg.js writes 'local_live' / 'vrm_import' — never the
  // legacy 'live' value (which matched 0 rows and forced flat-800 cold-start).
  assert.ok(
    sql.includes("source_kind IN ('vrm_import', 'local_live')"),
    'should filter source_kind to vrm_import + local_live'
  );
  assert.ok(
    !/source_kind\s*=\s*'live'/.test(sql),
    'must NOT use the bogus source_kind = \'live\' filter'
  );
});

test('buildLoadForecastQuery converts kWh-per-15min to average watts (x4000) under a unit=kWh guard', () => {
  const sql = buildLoadForecastQuery();
  // load_power_w rows store kWh-per-15min-slot; x4000 = (x4 for 15min->h)(x1000 kW->W).
  assert.ok(sql.includes('value_num * 4000'), 'should scale value_num by 4000');
  assert.ok(sql.includes("unit = 'kWh'"), 'should guard the x4000 scaling with unit = kWh');
});

// --- computeLoadConfidence ---

test('computeLoadConfidence returns 0.3 when sampleCount < 7', () => {
  assert.equal(computeLoadConfidence(0), 0.3);
  assert.equal(computeLoadConfidence(1), 0.3);
  assert.equal(computeLoadConfidence(6), 0.3);
});

test('computeLoadConfidence returns 0.5 when sampleCount between 7-13', () => {
  assert.equal(computeLoadConfidence(7), 0.5);
  assert.equal(computeLoadConfidence(10), 0.5);
  assert.equal(computeLoadConfidence(13), 0.5);
});

test('computeLoadConfidence returns 0.7 when sampleCount between 14-27', () => {
  assert.equal(computeLoadConfidence(14), 0.7);
  assert.equal(computeLoadConfidence(20), 0.7);
  assert.equal(computeLoadConfidence(27), 0.7);
});

test('computeLoadConfidence returns 0.85 when sampleCount >= 28', () => {
  assert.equal(computeLoadConfidence(28), 0.85);
  assert.equal(computeLoadConfidence(100), 0.85);
  assert.equal(computeLoadConfidence(365), 0.85);
});

// --- formatLoadSlots (cold-start fallback) ---

test('cold-start fallback returns constant defaultPowerW (800W) when sampleCount < 7', () => {
  const sqlRows = [
    { hour_of_day: 0, avg_power_w: 500, sample_count: '3' },
    { hour_of_day: 1, avg_power_w: 400, sample_count: '2' }
  ];
  const now = new Date('2026-04-03T12:00:00Z');
  const result = formatLoadSlots(sqlRows, 800, now);
  // Cold start: only 2 unique hours < 7
  assert.equal(result.length, 72, 'should produce 72 slots');
  assert.ok(result.every(s => s.power_w === 800), 'all slots should use defaultPowerW');
  assert.ok(result.every(s => s.confidence === 0.3), 'all slots should have cold-start confidence');
});

// --- formatLoadSlots (normal operation) ---

test('formatLoadSlots creates 1h resolution slots for 72h (per D-02, D-03)', () => {
  // Provide data for all 24 hours to avoid cold-start
  const sqlRows = [];
  for (let h = 0; h < 24; h++) {
    sqlRows.push({ hour_of_day: h, avg_power_w: 500 + h * 10, sample_count: '30' });
  }
  const now = new Date('2026-04-03T12:00:00Z');
  const result = formatLoadSlots(sqlRows, 800, now);
  assert.equal(result.length, 72, 'should produce 72 slots');
  // The first slot should be at the start of the current hour
  const firstTs = new Date(result[0].ts_utc);
  assert.equal(firstTs.getMinutes(), 0, 'slots should be at 1h boundaries');
  assert.equal(firstTs.getSeconds(), 0, 'slots should be at 1h boundaries');
  assert.equal(firstTs.getMilliseconds(), 0, 'slots should be at 1h boundaries');
});

test('formatLoadSlots produces ISO timestamps at 1h boundaries', () => {
  const sqlRows = [];
  for (let h = 0; h < 24; h++) {
    sqlRows.push({ hour_of_day: h, avg_power_w: 600, sample_count: '28' });
  }
  const now = new Date('2026-04-03T14:30:00Z');
  const result = formatLoadSlots(sqlRows, 800, now);
  for (let i = 0; i < result.length; i++) {
    const ts = new Date(result[i].ts_utc);
    assert.equal(ts.getMinutes(), 0, `slot ${i} should have 0 minutes`);
    assert.equal(ts.getSeconds(), 0, `slot ${i} should have 0 seconds`);
    // Each slot should be exactly 1h apart
    if (i > 0) {
      const prevTs = new Date(result[i - 1].ts_utc);
      assert.equal(ts - prevTs, 3600000, `slot ${i} should be 1h after slot ${i-1}`);
    }
  }
});

test('formatLoadSlots maps hour_of_day to correct power values', () => {
  const sqlRows = [];
  for (let h = 0; h < 24; h++) {
    sqlRows.push({ hour_of_day: h, avg_power_w: 100 * (h + 1), sample_count: '28' });
  }
  const now = new Date('2026-04-03T00:00:00Z');
  const result = formatLoadSlots(sqlRows, 800, now);
  // Hour 0 -> 100W, Hour 1 -> 200W, etc.
  assert.equal(result[0].power_w, 100, 'hour 0 should map to 100W');
  assert.equal(result[1].power_w, 200, 'hour 1 should map to 200W');
  assert.equal(result[23].power_w, 2400, 'hour 23 should map to 2400W');
  // Hour 24 wraps to hour 0 again
  assert.equal(result[24].power_w, 100, 'hour 24 wraps to hour 0');
});

// --- createLoadForecast ---

test('createLoadForecast returns object with start, close, runForecast', () => {
  const mockCtx = {
    state: { forecast: { load: { lastFetchAt: null, data: null, confidence: 0.3 } } },
    getCfg: () => ({ forecast: { load: { model: 'sql_weekday', defaultPowerW: 800 } } }),
    pushLog: () => {},
    db: null
  };
  const mockStore = {
    insertLoadForecast: async () => {}
  };
  const svc = createLoadForecast(mockCtx, { store: mockStore });
  assert.equal(typeof svc.start, 'function');
  assert.equal(typeof svc.close, 'function');
  assert.equal(typeof svc.runForecast, 'function');
});
