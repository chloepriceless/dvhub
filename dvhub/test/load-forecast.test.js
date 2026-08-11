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

test('formatLoadSlots maps hour_of_day to correct power values (Berlin-zone-aware)', () => {
  // 18-01k: hourMap is keyed by Berlin local hour-of-day (matching the SQL
  // EXTRACT domain). 2026-04-03 is in CEST (UTC+2), so Berlin midnight on
  // 2026-04-04 = 2026-04-03T22:00:00Z. We pick that instant so result[0]
  // looks up Berlin-hour=0 and the 100/200/.../2400 mapping holds.
  const sqlRows = [];
  for (let h = 0; h < 24; h++) {
    sqlRows.push({ hour_of_day: h, avg_power_w: 100 * (h + 1), sample_count: '28' });
  }
  const now = new Date('2026-04-03T22:00:00Z'); // Berlin 2026-04-04T00:00 CEST
  const result = formatLoadSlots(sqlRows, 800, now);
  // Berlin-hour 0 -> 100W, Berlin-hour 1 -> 200W, etc.
  assert.equal(result[0].power_w, 100, 'Berlin-hour 0 should map to 100W');
  assert.equal(result[1].power_w, 200, 'Berlin-hour 1 should map to 200W');
  assert.equal(result[23].power_w, 2400, 'Berlin-hour 23 should map to 2400W');
  // Berlin-hour 24 wraps to Berlin-hour 0 again
  assert.equal(result[24].power_w, 100, 'Berlin-hour 24 wraps to Berlin-hour 0');
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

// --- runForecast VRM fallback (Part A — widened cold-start fallback) ---

function makeRunForecastCtx() {
  return {
    state: { forecast: { load: { lastFetchAt: null, data: null, confidence: 0.3 } } },
    getCfg: () => ({ forecast: { load: { defaultPowerW: 800 } }, ml: {} }),
    pushLog: () => {},
    bumpForecastVersion: () => {},
    forecastService: { tier: 1 },
    // mock DB: SQL rollup returns < 7 hours -> formatLoadSlots cold-start (flat 800)
    db: { query: async () => ({ rows: [{ hour_of_day: 0, avg_power_w: 500, sample_count: '3' }] }) }
  };
}

test('runForecast prefers the VRM consumption forecast over flat-800 on a cold-start rollup', async () => {
  const ctx = makeRunForecastCtx();
  const vrmSlots = Array.from({ length: 24 }, (_, h) => ({
    ts_utc: new Date(Date.UTC(2026, 4, 18, h)).toISOString(),
    power_w: 300 + h * 50
  }));
  const vrmForecast = {
    isAvailable: () => true,
    readLoadForecast: async () => vrmSlots
  };
  const svc = createLoadForecast(ctx, { store: { insertLoadForecast: async () => {} }, vrmForecast });
  await svc.runForecast();

  const data = ctx.state.forecast.load.data;
  assert.ok(Array.isArray(data) && data.length === 24, 'should hold the VRM slots');
  // Flat-800 would make every slot identical; VRM data has per-hour variation.
  const distinct = new Set(data.map(s => s.power_w));
  assert.ok(distinct.size > 1, 'VRM fallback should produce a non-flat profile');
  assert.ok(!data.every(s => s.power_w === 800), 'must NOT serve the flat-800 constant');
  assert.equal(svc.getState().source, 'vrm_fallback', 'state source should be vrm_fallback');
});

test('runForecast keeps flat-800 as last resort when VRM is unavailable', async () => {
  const ctx = makeRunForecastCtx();
  const vrmForecast = {
    isAvailable: () => false,
    readLoadForecast: async () => { throw new Error('should not be called'); }
  };
  const svc = createLoadForecast(ctx, { store: { insertLoadForecast: async () => {} }, vrmForecast });
  await svc.runForecast();

  const data = ctx.state.forecast.load.data;
  assert.ok(data.every(s => s.power_w === 800), 'flat-800 stays the last resort');
  assert.equal(svc.getState().source, 'naive_constant', 'state source should be naive_constant');
});

// --- 18-01k: timezone-key bug + distinct fallback model name ---

test('18-01k: formatLoadSlots looks up hourMap in Berlin-local hours (matches SQL query domain)', () => {
  // Build a Berlin-keyed hourMap: hour_of_day = Berlin local hour, distinct values per hour
  const sqlRows = [];
  for (let h = 0; h < 24; h++) {
    sqlRows.push({ hour_of_day: h, avg_power_w: 100 + h * 100, sample_count: '30' });
  }
  // Berlin summer (UTC+2): UTC 16:00 == Berlin 18:00 -> Berlin-hour key 18 -> avg_power_w 1900
  const now = new Date('2026-05-20T16:00:00Z');
  const result = formatLoadSlots(sqlRows, 800, now);
  assert.notEqual(result[0].power_w, 800, 'must not fall through to defaultPowerW');
  assert.equal(result[0].power_w, 1900, 'Berlin-hour=18 should map to avg_power_w=1900');
});

test('18-01k: formatLoadSlots maps Berlin-keyed hourMap correctly in winter (UTC+1 offset)', () => {
  // Winter (CET, UTC+1): UTC 09:00 == Berlin 10:00 -> Berlin-hour key 10 -> avg_power_w 600
  // Under the bug, ts.getUTCHours()=9 -> avg_power_w 500. Asserting 600 catches it.
  // Also asserts a non-flat profile via specific-value mapping at a later slot.
  const sqlRows = [];
  for (let h = 0; h < 24; h++) {
    sqlRows.push({ hour_of_day: h, avg_power_w: 100 + h * 50, sample_count: '20' });
  }
  const now = new Date('2026-01-15T09:00:00Z'); // Berlin 10:00 CET
  const result = formatLoadSlots(sqlRows, 800, now);
  assert.equal(result[0].power_w, 600, 'Berlin-hour=10 should map to avg_power_w=600 (UTC code would yield 550)');
  // Curve must vary across 24h (catches all-800W flat bug AND constant-curve bugs).
  const distinct = new Set(result.slice(0, 24).map(s => s.power_w));
  assert.ok(distinct.size > 1, `expected > 1 distinct values, got ${distinct.size}: ${[...distinct]}`);
});

function makeRunForecastHarness({ sqlRows, defaultPowerW = 800 } = {}) {
  const persisted = [];
  const ctx = {
    state: { forecast: { load: {} } },
    getCfg: () => ({ forecast: { load: { defaultPowerW } }, ml: {} }),
    pushLog: () => {},
    db: { query: async () => ({ rows: sqlRows }) },
    forecastService: { tier: 1 },
    bumpForecastVersion: () => {}
  };
  const store = {
    insertLoadForecast: async (row) => { persisted.push(row); },
    query: async () => ({ rows: [] })
  };
  const vrmForecast = { isAvailable: () => false, readLoadForecast: async () => null };
  const lf = createLoadForecast(ctx, { store, vrmForecast });
  return { ctx, store, persisted, lf };
}

test('18-01k: runForecast persists model=sql_weekday_fallback when cold-start defaultPowerW is served', async () => {
  const h = makeRunForecastHarness({
    sqlRows: [
      { hour_of_day: 0, avg_power_w: 500, sample_count: '3' },
      { hour_of_day: 1, avg_power_w: 400, sample_count: '2' }
    ]
  });
  await h.lf.runForecast();
  assert.ok(h.persisted.length > 0, 'something was persisted');
  assert.ok(
    h.persisted.every(r => r.model === 'sql_weekday_fallback'),
    `expected every row model=sql_weekday_fallback, got: ${[...new Set(h.persisted.map(r => r.model))]}`
  );
});

test('18-01k: runForecast persists model=sql_weekday for real rollup (24 distinct hours)', async () => {
  const sqlRows = [];
  for (let h = 0; h < 24; h++) {
    sqlRows.push({ hour_of_day: h, avg_power_w: 500 + h * 30, sample_count: '20' });
  }
  const h = makeRunForecastHarness({ sqlRows });
  await h.lf.runForecast();
  assert.ok(h.persisted.length > 0, 'something was persisted');
  assert.ok(
    h.persisted.every(r => r.model === 'sql_weekday'),
    `expected every row model=sql_weekday, got: ${[...new Set(h.persisted.map(r => r.model))]}`
  );
});
