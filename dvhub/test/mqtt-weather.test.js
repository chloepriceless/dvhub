import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMqttWeather,
  loxoneEpochToUnixMs,
  parseNumeric,
  topicSuffix,
  buildWeather4loxRows,
  buildCustomNowcastRow,
  resolveMqttWeatherConfig,
  LOXONE_EPOCH_OFFSET_S,
  WEATHER4LOX_DEFAULT_PREFIX
} from '../services/forecast/mqtt-weather.js';

// --- loxoneEpochToUnixMs ---

test('loxoneEpochToUnixMs converts Loxone epoch to Unix ms', () => {
  // 550249200 lox + 1230768000 offset = 2026-06-09T15:00:00Z (verified prod sample)
  assert.equal(new Date(loxoneEpochToUnixMs(550249200)).toISOString(), '2026-06-09T15:00:00.000Z');
  // Loxone 0 == 2009-01-01T00:00:00Z
  assert.equal(loxoneEpochToUnixMs(0), LOXONE_EPOCH_OFFSET_S * 1000);
  assert.equal(new Date(loxoneEpochToUnixMs(0)).toISOString(), '2009-01-01T00:00:00.000Z');
});

test('loxoneEpochToUnixMs returns NaN for non-numeric input', () => {
  // Non-numeric strings and undefined coerce to NaN. (null/'' coerce to 0 in
  // JS, but those never reach this function — buildWeather4loxRows skips slots
  // whose hfcNN_date is null before calling it.)
  assert.ok(Number.isNaN(loxoneEpochToUnixMs('abc')));
  assert.ok(Number.isNaN(loxoneEpochToUnixMs(undefined)));
  assert.ok(Number.isNaN(loxoneEpochToUnixMs('not-a-date')));
});

// --- parseNumeric ---

test('parseNumeric parses bare numeric strings', () => {
  assert.equal(parseNumeric('203.0'), 203);
  assert.equal(parseNumeric('  67  '), 67);
  assert.equal(parseNumeric('0'), 0);
  assert.equal(parseNumeric('15.5'), 15.5);
  assert.equal(parseNumeric(42), 42);
});

test('parseNumeric tolerates a JSON {value:X} envelope (Victron-style)', () => {
  assert.equal(parseNumeric('{"value":5}'), 5);
  assert.equal(parseNumeric('{"value":-3.2}'), -3.2);
});

test('parseNumeric returns null for empty / non-numeric / no-value sentinel', () => {
  assert.equal(parseNumeric(''), null);
  assert.equal(parseNumeric('   '), null);
  assert.equal(parseNumeric('n/a'), null);
  assert.equal(parseNumeric(null), null);
  assert.equal(parseNumeric(undefined), null);
  // weather4lox "no value" sentinel
  assert.equal(parseNumeric('-9999'), null);
  assert.equal(parseNumeric('-9999.0'), null);
  assert.equal(parseNumeric(-9999), null);
});

test('parseNumeric accepts a Buffer payload (mqtt.js delivers Buffers)', () => {
  assert.equal(parseNumeric(Buffer.from('120.5')), 120.5);
});

// --- topicSuffix ---

test('topicSuffix strips the prefix', () => {
  assert.equal(topicSuffix('weather4lox/hfc8_sr', 'weather4lox'), 'hfc8_sr');
  assert.equal(topicSuffix('weather4lox/cur_sr', 'weather4lox'), 'cur_sr');
  // trailing slash on the configured prefix is tolerated
  assert.equal(topicSuffix('weather4lox/hfc1_tt', 'weather4lox/'), 'hfc1_tt');
});

test('topicSuffix returns null for topics outside the prefix', () => {
  assert.equal(topicSuffix('homeassistant/statestream/x', 'weather4lox'), null);
  assert.equal(topicSuffix(42, 'weather4lox'), null);
});

// --- buildWeather4loxRows (golden mapping) ---

test('buildWeather4loxRows maps complete hourly slots to weather_forecasts rows', () => {
  const raw = {
    hfc1_sr: 0, hfc1_date: 550249200, hfc1_sky: 88, hfc1_tt: 15.5, hfc1_hu: 70,
    hfc2_sr: 203, hfc2_date: 550252800, hfc2_sky: 40, hfc2_tt: 17.2
  };
  const rows = buildWeather4loxRows(raw);
  assert.equal(rows.length, 2);

  assert.equal(rows[0].provider, 'mqtt');
  assert.equal(rows[0].ts_utc, '2026-06-09T15:00:00.000Z');
  assert.equal(rows[0].ghi_wm2, 0);
  assert.equal(rows[0].cloud_cover_pct, 88);
  assert.equal(rows[0].temperature_c, 15.5);
  assert.equal(rows[0].humidity_pct, 70);

  assert.equal(rows[1].ts_utc, '2026-06-09T16:00:00.000Z');
  assert.equal(rows[1].ghi_wm2, 203);
  assert.equal(rows[1].cloud_cover_pct, 40);
  assert.equal(rows[1].temperature_c, 17.2);
  assert.equal(rows[1].humidity_pct, null); // missing field -> null
});

test('buildWeather4loxRows skips slots missing a timestamp or irradiance', () => {
  const raw = {
    hfc1_sr: 100,                      // no hfc1_date -> skip
    hfc2_date: 550252800,              // no hfc2_sr   -> skip
    hfc3_sr: 250, hfc3_date: 550256400 // complete     -> kept
  };
  const rows = buildWeather4loxRows(raw);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ghi_wm2, 250);
});

test('buildWeather4loxRows handles empty / garbage input', () => {
  assert.deepEqual(buildWeather4loxRows({}), []);
  assert.deepEqual(buildWeather4loxRows(null), []);
  assert.deepEqual(buildWeather4loxRows(undefined), []);
});

// --- buildCustomNowcastRow ---

test('buildCustomNowcastRow stamps the value at the current full hour', () => {
  const row = buildCustomNowcastRow(
    { ghi: 120, temperature: 14, cloud: 50 },
    Date.parse('2026-06-09T15:23:45Z')
  );
  assert.equal(row.ts_utc, '2026-06-09T15:00:00.000Z'); // floored to the hour
  assert.equal(row.ghi_wm2, 120);
  assert.equal(row.temperature_c, 14);
  assert.equal(row.cloud_cover_pct, 50);
  assert.equal(row.provider, 'mqtt');
});

test('buildCustomNowcastRow returns null without a GHI value', () => {
  assert.equal(buildCustomNowcastRow({ temperature: 14 }, Date.now()), null);
  assert.equal(buildCustomNowcastRow({ ghi: null }, Date.now()), null);
});

// --- resolveMqttWeatherConfig ---

test('resolveMqttWeatherConfig: enabled only when provider === mqtt', () => {
  assert.equal(resolveMqttWeatherConfig({ forecast: { weather: { provider: 'open_meteo' } } }).enabled, false);
  assert.equal(resolveMqttWeatherConfig({ forecast: { weather: { provider: 'mqtt' } } }).enabled, true);
});

test('resolveMqttWeatherConfig: brokerUrl falls back to top-level mqtt broker', () => {
  const c = resolveMqttWeatherConfig({
    forecast: { weather: { provider: 'mqtt', mqtt: {} } },
    mqtt: { brokerUrl: 'mqtt://192.168.0.5:1883' }
  });
  assert.equal(c.brokerUrl, 'mqtt://192.168.0.5:1883');
  assert.equal(c.preset, 'weather4lox');
  assert.equal(c.prefix, WEATHER4LOX_DEFAULT_PREFIX);
});

test('resolveMqttWeatherConfig: explicit weather broker overrides the top-level one', () => {
  const c = resolveMqttWeatherConfig({
    forecast: { weather: { provider: 'mqtt', mqtt: { brokerUrl: 'mqtt://lox:1883', prefix: 'wx' } } },
    mqtt: { brokerUrl: 'mqtt://other:1883' }
  });
  assert.equal(c.brokerUrl, 'mqtt://lox:1883');
  assert.equal(c.prefix, 'wx');
});

// --- factory: ingest + flush ---

function makeCtx(cfg) {
  const logs = [];
  let bumped = 0;
  return {
    state: { forecast: { weather: { lastFetchAt: null, error: null } } },
    getCfg: () => cfg,
    pushLog: (key, data) => logs.push({ key, data }),
    bumpForecastVersion: () => { bumped++; },
    _logs: logs,
    _bumped: () => bumped
  };
}

test('createMqttWeather returns the expected interface', () => {
  const ctx = makeCtx({ forecast: { weather: { provider: 'mqtt' } }, mqtt: {} });
  const svc = createMqttWeather(ctx, { store: { insertWeather: async () => {} } });
  assert.equal(typeof svc.start, 'function');
  assert.equal(typeof svc.close, 'function');
  assert.equal(typeof svc.ingest, 'function');
});

test('ingest (weather4lox) buffers values and flush writes deduped rows', async () => {
  const cfg = { forecast: { weather: { provider: 'mqtt', mqtt: { preset: 'weather4lox', prefix: 'weather4lox' } } }, mqtt: { brokerUrl: 'mqtt://x:1883' } };
  const ctx = makeCtx(cfg);
  const written = [];
  const svc = createMqttWeather(ctx, { store: { insertWeather: async (r) => { written.push(r); } } });

  // Simulate retained-message delivery on subscribe.
  svc.ingest('weather4lox/hfc1_sr', '0');
  svc.ingest('weather4lox/hfc1_date', '550249200');
  svc.ingest('weather4lox/hfc1_sky', '88');
  svc.ingest('weather4lox/hfc1_tt', '15.5');
  svc.ingest('weather4lox/hfc2_sr', '203.0');
  svc.ingest('weather4lox/hfc2_date', '550252800');
  svc.ingest('weather4lox/cur_sr', '67');   // live nowcast — buffered, not a row
  svc.ingest('homeassistant/other', '999'); // outside prefix — ignored

  await svc._flush();

  assert.equal(written.length, 2);
  assert.equal(written[0].ghi_wm2, 0);
  assert.equal(written[1].ghi_wm2, 203);
  assert.ok(ctx.state.forecast.weather.lastFetchAt, 'lastFetchAt stamped');
  assert.equal(ctx._bumped(), 1, 'forecast version bumped once');
});

test('ingest drops a value when the sentinel arrives', async () => {
  const cfg = { forecast: { weather: { provider: 'mqtt', mqtt: { preset: 'weather4lox' } } }, mqtt: { brokerUrl: 'mqtt://x:1883' } };
  const ctx = makeCtx(cfg);
  const svc = createMqttWeather(ctx, { store: { insertWeather: async () => {} } });
  svc.ingest('weather4lox/hfc1_tt', '15.5');
  assert.equal(svc._raw().hfc1_tt, 15.5);
  svc.ingest('weather4lox/hfc1_tt', '-9999'); // no value -> drop
  assert.equal('hfc1_tt' in svc._raw(), false);
});

test('flush is a no-op when no complete slots are buffered', async () => {
  const cfg = { forecast: { weather: { provider: 'mqtt', mqtt: { preset: 'weather4lox' } } }, mqtt: { brokerUrl: 'mqtt://x:1883' } };
  const ctx = makeCtx(cfg);
  let writes = 0;
  const svc = createMqttWeather(ctx, { store: { insertWeather: async () => { writes++; } } });
  svc.ingest('weather4lox/cur_sr', '67'); // only a live value, no forecast slot
  await svc._flush();
  assert.equal(writes, 0);
  assert.ok(ctx._logs.some(l => l.key === 'mqtt_weather_flush_skip'));
});

test('custom preset maps configured topics to a nowcast row', async () => {
  const cfg = {
    forecast: { weather: { provider: 'mqtt', mqtt: { preset: 'custom', ghiTopic: 'wx/ghi', tempTopic: 'wx/temp', cloudTopic: 'wx/cloud' } } },
    mqtt: { brokerUrl: 'mqtt://x:1883' }
  };
  const ctx = makeCtx(cfg);
  const written = [];
  const svc = createMqttWeather(ctx, { store: { insertWeather: async (r) => { written.push(r); } } });
  svc.ingest('wx/ghi', '350');
  svc.ingest('wx/temp', '18');
  svc.ingest('wx/cloud', '20');
  svc.ingest('wx/unmapped', '5'); // not a configured topic -> ignored
  await svc._flush();
  assert.equal(written.length, 1);
  assert.equal(written[0].ghi_wm2, 350);
  assert.equal(written[0].temperature_c, 18);
  assert.equal(written[0].cloud_cover_pct, 20);
});

test('start() is a no-op when provider !== mqtt (no broker connection attempted)', async () => {
  const cfg = { forecast: { weather: { provider: 'open_meteo' } }, mqtt: { brokerUrl: 'mqtt://x:1883' } };
  const ctx = makeCtx(cfg);
  const svc = createMqttWeather(ctx, { store: { insertWeather: async () => {} } });
  await svc.start(); // must not throw and must not import/connect mqtt
  await svc._flush();
  assert.equal(ctx._logs.some(l => l.key === 'mqtt_weather_connected'), false);
});

test('start() logs a skip when provider is mqtt but no broker URL is resolvable', async () => {
  const cfg = { forecast: { weather: { provider: 'mqtt', mqtt: {} } } };
  const ctx = makeCtx(cfg);
  const svc = createMqttWeather(ctx, { store: { insertWeather: async () => {} } });
  await svc.start();
  assert.ok(ctx._logs.some(l => l.key === 'mqtt_weather_skip' && l.data?.reason === 'no_broker_url'));
});
