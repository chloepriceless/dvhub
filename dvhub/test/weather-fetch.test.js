import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createWeatherFetch,
  buildOpenMeteoUrl,
  parseOpenMeteoResponse
} from '../services/forecast/weather-fetch.js';

test('createWeatherFetch returns object with start and close functions', () => {
  const state = { forecast: { weather: {} } };
  const logs = [];
  const ctx = {
    state,
    getCfg: () => ({
      forecast: {
        location: { latitude: 48.15, longitude: 9.48 },
        weather: { fetchIntervalMs: 3600000 }
      }
    }),
    pushLog: (key, data) => logs.push({ key, data })
  };
  const store = { insertWeather: async () => {} };
  const wf = createWeatherFetch(ctx, { store });
  assert.equal(typeof wf.start, 'function');
  assert.equal(typeof wf.close, 'function');
});

test('buildOpenMeteoUrl builds correct URL with lat/lon and required variables', () => {
  const url = buildOpenMeteoUrl(48.15, 9.48);
  assert.ok(url.includes('api.open-meteo.com'), 'should use Open-Meteo API');
  assert.ok(url.includes('latitude=48.15'), 'should include latitude');
  assert.ok(url.includes('longitude=9.48'), 'should include longitude');
  assert.ok(url.includes('shortwave_radiation'), 'should include GHI');
  assert.ok(url.includes('direct_normal_irradiance'), 'should include DNI');
  assert.ok(url.includes('diffuse_radiation'), 'should include DHI');
  assert.ok(url.includes('temperature_2m'), 'should include temperature');
  assert.ok(url.includes('windspeed_10m') || url.includes('wind_speed_10m'), 'should include wind speed');
  assert.ok(url.includes('visibility'), 'should include visibility');
  assert.ok(url.includes('relative_humidity_2m'), 'should include humidity');
  assert.ok(url.includes('forecast_days=4'), 'should request 4 days');
  assert.ok(url.includes('timezone=Europe'), 'should include timezone');
});

test('parseOpenMeteoResponse maps hourly data to weather_forecasts rows', () => {
  const mockResponse = {
    hourly: {
      time: ['2026-04-03T00:00', '2026-04-03T01:00'],
      shortwave_radiation: [0, 120.5],
      direct_normal_irradiance: [0, 85.3],
      diffuse_radiation: [0, 35.2],
      temperature_2m: [5.1, 5.8],
      windspeed_10m: [2.3, 3.1],
      cloudcover: [80, 60],
      visibility: [15000, 12000],
      relative_humidity_2m: [90, 85]
    }
  };

  const rows = parseOpenMeteoResponse(mockResponse);
  assert.equal(rows.length, 2);

  // Check first row
  assert.equal(rows[0].provider, 'open_meteo');
  assert.equal(rows[0].ts_utc, '2026-04-03T00:00');
  assert.equal(rows[0].ghi_wm2, 0);
  assert.equal(rows[0].dni_wm2, 0);
  assert.equal(rows[0].dhi_wm2, 0);
  assert.equal(rows[0].temperature_c, 5.1);
  assert.equal(rows[0].wind_speed_ms, 2.3);
  assert.equal(rows[0].cloud_cover_pct, 80);
  assert.equal(rows[0].visibility_m, 15000);
  assert.equal(rows[0].humidity_pct, 90);

  // Check second row
  assert.equal(rows[1].ghi_wm2, 120.5);
  assert.equal(rows[1].dni_wm2, 85.3);
  assert.equal(rows[1].dhi_wm2, 35.2);
});

test('parseOpenMeteoResponse handles empty response gracefully', () => {
  const rows = parseOpenMeteoResponse({ hourly: { time: [] } });
  assert.equal(rows.length, 0);
});

test('parseOpenMeteoResponse handles missing fields with null', () => {
  const mockResponse = {
    hourly: {
      time: ['2026-04-03T00:00'],
      shortwave_radiation: [100],
      // All other fields missing
    }
  };
  const rows = parseOpenMeteoResponse(mockResponse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ghi_wm2, 100);
  assert.equal(rows[0].dni_wm2, null);
  assert.equal(rows[0].dhi_wm2, null);
  assert.equal(rows[0].temperature_c, null);
  assert.equal(rows[0].wind_speed_ms, null);
  assert.equal(rows[0].cloud_cover_pct, null);
  assert.equal(rows[0].visibility_m, null);
  assert.equal(rows[0].humidity_pct, null);
});
