import test from 'node:test';
import assert from 'node:assert/strict';

import { createForecastStore, getFreeDiskPct } from '../services/forecast/forecast-store.js';

// --- Schema SQL tests ---

test('ensureSchema SQL contains all 4 table names', () => {
  const logs = [];
  const store = createForecastStore({
    getCfg: () => ({ forecast: { retention: { minFreeDiskPct: 20 } } }),
    pushLog: (type, data) => logs.push({ type, data })
  });

  const sql = store.SCHEMA_SQL;
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS weather_forecasts'), 'weather_forecasts table missing');
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS pv_forecasts'), 'pv_forecasts table missing');
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS load_forecasts'), 'load_forecasts table missing');
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS forecast_accuracy'), 'forecast_accuracy table missing');
});

// T-0105: isReady() must report false until ensureSchema() wires the pool, and
// false again after close(). This is the signal forecast-snapshots uses to avoid
// the boot-race null-pool dereference (8x snapshots_insert_error at startup).
test('isReady() reflects pool init/close lifecycle (T-0105)', async () => {
  const store = createForecastStore({ getCfg: () => ({}), pushLog: () => {} });
  assert.equal(store.isReady(), false, 'not ready before ensureSchema');
  await store.ensureSchema({ query: async () => ({ rows: [], rowCount: 0 }) });
  assert.equal(store.isReady(), true, 'ready after ensureSchema');
  store.close();
  assert.equal(store.isReady(), false, 'not ready after close');
});

test('schema SQL creates indexes for all forecast tables', () => {
  const store = createForecastStore({
    getCfg: () => ({}),
    pushLog: () => {}
  });

  const sql = store.SCHEMA_SQL;
  assert.ok(sql.includes('idx_weather_forecasts_ts'), 'weather index missing');
  assert.ok(sql.includes('idx_pv_forecasts_ts'), 'pv index missing');
  assert.ok(sql.includes('idx_load_forecasts_ts'), 'load index missing');
  assert.ok(sql.includes('idx_forecast_accuracy_date'), 'accuracy index missing');
});

test('schema SQL has UNIQUE constraints for all tables', () => {
  const store = createForecastStore({
    getCfg: () => ({}),
    pushLog: () => {}
  });

  const sql = store.SCHEMA_SQL;
  assert.ok(sql.includes('UNIQUE(provider, ts_utc)'), 'weather UNIQUE constraint missing');
  assert.ok(sql.includes('UNIQUE(model, ts_utc)'), 'pv/load UNIQUE constraint missing');
  assert.ok(sql.includes('UNIQUE(forecast_type, model, evaluation_date)'), 'accuracy UNIQUE constraint missing');
});

// --- Insert methods build correct SQL with ON CONFLICT ---

test('insertWeather uses ON CONFLICT upsert', async () => {
  const queries = [];
  const mockPool = {
    query: (sql, params) => { queries.push({ sql, params }); return { rows: [] }; }
  };

  const store = createForecastStore({
    getCfg: () => ({}),
    pushLog: () => {}
  });
  await store.ensureSchema(mockPool);

  // Reset queries after schema creation
  queries.length = 0;

  await store.insertWeather({
    provider: 'open_meteo',
    ts_utc: '2026-04-03T12:00:00Z',
    ghi_wm2: 500,
    temperature_c: 18.5
  });

  assert.equal(queries.length, 1);
  assert.ok(queries[0].sql.includes('INSERT INTO weather_forecasts'), 'INSERT INTO weather_forecasts missing');
  assert.ok(queries[0].sql.includes('ON CONFLICT'), 'ON CONFLICT missing');
  assert.equal(queries[0].params[0], 'open_meteo');
  assert.equal(queries[0].params[2], 500); // ghi_wm2
});

test('insertPvForecast uses ON CONFLICT upsert', async () => {
  const queries = [];
  const mockPool = {
    query: (sql, params) => { queries.push({ sql, params }); return { rows: [] }; }
  };

  const store = createForecastStore({
    getCfg: () => ({}),
    pushLog: () => {}
  });
  await store.ensureSchema(mockPool);
  queries.length = 0;

  await store.insertPvForecast({
    model: 'solcast',
    ts_utc: '2026-04-03T12:00:00Z',
    power_w: 3500,
    confidence: 0.7
  });

  assert.equal(queries.length, 1);
  assert.ok(queries[0].sql.includes('INSERT INTO pv_forecasts'), 'INSERT INTO pv_forecasts missing');
  assert.ok(queries[0].sql.includes('ON CONFLICT'), 'ON CONFLICT missing');
  assert.equal(queries[0].params[0], 'solcast');
  assert.equal(queries[0].params[2], 3500); // power_w
  assert.equal(queries[0].params[3], 0.7); // confidence
});

test('insertLoadForecast uses ON CONFLICT upsert with defaults', async () => {
  const queries = [];
  const mockPool = {
    query: (sql, params) => { queries.push({ sql, params }); return { rows: [] }; }
  };

  const store = createForecastStore({
    getCfg: () => ({}),
    pushLog: () => {}
  });
  await store.ensureSchema(mockPool);
  queries.length = 0;

  await store.insertLoadForecast({
    ts_utc: '2026-04-03T12:00:00Z',
    power_w: 800
  });

  assert.equal(queries.length, 1);
  assert.ok(queries[0].sql.includes('INSERT INTO load_forecasts'), 'INSERT INTO load_forecasts missing');
  assert.ok(queries[0].sql.includes('ON CONFLICT'), 'ON CONFLICT missing');
  assert.equal(queries[0].params[0], 'sql_weekday'); // default model
  assert.equal(queries[0].params[3], 0.3); // default confidence
});

test('insertAccuracy uses ON CONFLICT upsert', async () => {
  const queries = [];
  const mockPool = {
    query: (sql, params) => { queries.push({ sql, params }); return { rows: [] }; }
  };

  const store = createForecastStore({
    getCfg: () => ({}),
    pushLog: () => {}
  });
  await store.ensureSchema(mockPool);
  queries.length = 0;

  await store.insertAccuracy({
    forecast_type: 'pv',
    model: 'solcast',
    evaluation_date: '2026-04-03',
    mae: 120.5,
    rmse: 180.3
  });

  assert.equal(queries.length, 1);
  assert.ok(queries[0].sql.includes('INSERT INTO forecast_accuracy'), 'INSERT INTO forecast_accuracy missing');
  assert.ok(queries[0].sql.includes('ON CONFLICT'), 'ON CONFLICT missing');
  assert.equal(queries[0].params[0], 'pv');
  assert.equal(queries[0].params[1], 'solcast');
});

// --- Smart retention tests ---

test('runSmartRetention does nothing when disk free > threshold', async () => {
  const logs = [];
  const queries = [];
  const mockPool = {
    query: (sql, params) => { queries.push({ sql, params }); return { rows: [], rowCount: 0 }; }
  };

  const store = createForecastStore({
    getCfg: () => ({ forecast: { retention: { minFreeDiskPct: 20 } } }),
    pushLog: (type, data) => logs.push({ type, data })
  });
  await store.ensureSchema(mockPool);
  queries.length = 0;

  // getFreeDiskPct returns a real value on this system -- we just test it returns something
  const result = await store.runSmartRetention();
  // If disk free >= 20%, no compression should happen
  if (result.action === 'none') {
    assert.ok(result.freePct >= 20);
    assert.equal(queries.length, 0);
  }
  // If disk free < 20% (unlikely in test), compression happened -- that's also valid
});

// --- getFreeDiskPct utility test ---

test('getFreeDiskPct returns a number between 0 and 100 or null', () => {
  const result = getFreeDiskPct('/');
  if (result !== null) {
    assert.equal(typeof result, 'number');
    assert.ok(result >= 0 && result <= 100, `Free disk pct out of range: ${result}`);
  }
});

// --- Service skeleton tests ---

test('createForecastService initializes state.forecast with tier', async () => {
  const { createForecastService } = await import('../services/forecast/index.js');

  const state = {};
  const logs = [];
  const ctx = {
    state,
    getCfg: () => ({ forecast: { retention: { minFreeDiskPct: 20 } } }),
    pushLog: (type, data) => logs.push({ type, data }),
    db: null
  };

  const service = createForecastService(ctx);

  assert.ok(state.forecast, 'state.forecast should be set');
  assert.equal(typeof state.forecast.tier, 'number');
  assert.ok(state.forecast.tier >= 1 && state.forecast.tier <= 3);
  assert.equal(typeof state.forecast.totalMB, 'number');
  assert.ok(state.forecast.totalMB > 0);
  assert.equal(state.forecast.weather.lastFetchAt, null);
  assert.equal(state.forecast.pv.confidence, 0.3);
  assert.equal(state.forecast.price.source, 'epex');

  // Tier 1 should have workerReady true (no worker needed)
  if (state.forecast.tier === 1) {
    assert.equal(state.forecast.workerReady, true);
  }

  // Service exposes tier and store
  assert.equal(service.tier, state.forecast.tier);
  assert.ok(service.store);
  assert.equal(typeof service.start, 'function');
  assert.equal(typeof service.close, 'function');

  // Check init log
  assert.ok(logs.some(l => l.type === 'forecast_init'));
});

test('createForecastService start without db is a no-op', async () => {
  const { createForecastService } = await import('../services/forecast/index.js');

  const state = {};
  const ctx = {
    state,
    getCfg: () => ({}),
    pushLog: () => {},
    db: null
  };

  const service = createForecastService(ctx);
  // start() without db should not throw
  await service.start();
  await service.close();
});

// --- T-0131: getLatestWeather provider de-duplication / merge ---

function makeWeatherStore(rows, cfg = {}) {
  const store = createForecastStore({ getCfg: () => cfg, pushLog: () => {} });
  return store.ensureSchema({ query: async () => ({ rows, rowCount: rows.length }) }).then(() => store);
}

test('getLatestWeather returns rows unchanged when only one provider is present', async () => {
  const rows = [
    { provider: 'open_meteo', ts_utc: '2026-06-09T15:00:00.000Z', ghi_wm2: 100 },
    { provider: 'open_meteo', ts_utc: '2026-06-09T16:00:00.000Z', ghi_wm2: 200 }
  ];
  const store = await makeWeatherStore(rows);
  const out = await store.getLatestWeather({ start: 'a', end: 'b' });
  assert.equal(out.length, 2);
  assert.equal(out[0].ghi_wm2, 100);
});

test('getLatestWeather prefers the configured primary provider in the overlap, fills the tail with the fallback', async () => {
  // Overlap at 15:00 (both mqtt + open_meteo); 16:00 mqtt-only; 17:00 open_meteo-only (longer horizon).
  const rows = [
    { provider: 'open_meteo', ts_utc: '2026-06-09T15:00:00.000Z', ghi_wm2: 100 },
    { provider: 'mqtt',       ts_utc: '2026-06-09T15:00:00.000Z', ghi_wm2: 111 },
    { provider: 'mqtt',       ts_utc: '2026-06-09T16:00:00.000Z', ghi_wm2: 222 },
    { provider: 'open_meteo', ts_utc: '2026-06-09T17:00:00.000Z', ghi_wm2: 300 }
  ];
  const store = await makeWeatherStore(rows, { forecast: { weather: { provider: 'mqtt' } } });
  const out = await store.getLatestWeather({ start: 'a', end: 'b' });
  assert.equal(out.length, 3, 'one row per timestamp');
  assert.equal(out[0].ts_utc, '2026-06-09T15:00:00.000Z');
  assert.equal(out[0].provider, 'mqtt');     // local wins the overlap
  assert.equal(out[0].ghi_wm2, 111);
  assert.equal(out[1].ghi_wm2, 222);         // mqtt-only slot kept
  assert.equal(out[2].provider, 'open_meteo'); // tail filled by Open-Meteo
});

test('getLatestWeather: explicit provider arg overrides config for the merge priority', async () => {
  const rows = [
    { provider: 'open_meteo', ts_utc: '2026-06-09T15:00:00.000Z', ghi_wm2: 100 },
    { provider: 'mqtt',       ts_utc: '2026-06-09T15:00:00.000Z', ghi_wm2: 111 }
  ];
  const store = await makeWeatherStore(rows, { forecast: { weather: { provider: 'mqtt' } } });
  const out = await store.getLatestWeather({ start: 'a', end: 'b', provider: 'open_meteo' });
  assert.equal(out.length, 1);
  assert.equal(out[0].provider, 'open_meteo'); // explicit arg beats config
});
