import test from 'node:test';
import assert from 'node:assert/strict';

import { createPvForecast, buildPvlibInput } from '../services/forecast/pv-forecast.js';

// --- buildPvlibInput tests ---

test('buildPvlibInput simple mode uses defaults (tilt=35, azimuth=180)', () => {
  const cfg = {
    forecast: {
      location: { latitude: 48.15, longitude: 9.48 },
      pv: { configLevel: 'simple', totalKwp: 10.0, tiltDeg: 35, azimuthDeg: 180, strings: [], model: 'solcast' }
    }
  };
  const input = buildPvlibInput(cfg);
  assert.equal(input.lat, 48.15);
  assert.equal(input.lon, 9.48);
  assert.equal(input.kwp, 10.0);
  assert.equal(input.tilt, 35);
  assert.equal(input.azimuth, 180);
  assert.equal(input.strings.length, 0);
});

test('buildPvlibInput standard mode uses configured tilt and azimuth', () => {
  const cfg = {
    forecast: {
      location: { latitude: 52.52, longitude: 13.41 },
      pv: { configLevel: 'standard', totalKwp: 8.0, tiltDeg: 25, azimuthDeg: 160, strings: [], model: 'pvlib' }
    }
  };
  const input = buildPvlibInput(cfg);
  assert.equal(input.lat, 52.52);
  assert.equal(input.lon, 13.41);
  assert.equal(input.kwp, 8.0);
  assert.equal(input.tilt, 25);
  assert.equal(input.azimuth, 160);
  assert.equal(input.strings.length, 0);
});

test('buildPvlibInput detailed mode passes strings array', () => {
  const cfg = {
    forecast: {
      location: { latitude: 48.15, longitude: 9.48 },
      pv: {
        configLevel: 'detailed',
        totalKwp: 15.0,
        tiltDeg: 35,
        azimuthDeg: 180,
        strings: [
          { kwp: 8.0, tiltDeg: 30, azimuthDeg: 170, label: 'Sued' },
          { kwp: 7.0, tiltDeg: 20, azimuthDeg: 90, label: 'Ost' }
        ],
        model: 'pvlib'
      }
    }
  };
  const input = buildPvlibInput(cfg);
  assert.equal(input.strings.length, 2);
  assert.equal(input.strings[0].kwp, 8.0);
  assert.equal(input.strings[0].tiltDeg, 30);
  assert.equal(input.strings[0].azimuthDeg, 170);
  assert.equal(input.strings[1].kwp, 7.0);
  assert.equal(input.strings[1].azimuthDeg, 90);
});

// --- Tier gating tests ---

test('createPvForecast on Tier 1 does NOT call pythonBridge', async () => {
  let pythonCalled = false;
  const mockPythonBridge = {
    call: async () => { pythonCalled = true; return []; }
  };
  let solcastCalled = false;
  const mockSolcastClient = {
    fetchPvForecast: async () => { solcastCalled = true; return [{ ts: '2026-04-03T12:00:00', power_w: 5000 }]; }
  };
  const mockStore = {
    insertPvForecast: async () => {},
    getLatestWeather: async () => []
  };
  const mockState = { forecast: { pv: {} } };
  const ctx = {
    state: mockState,
    getCfg: () => ({
      forecast: {
        location: { latitude: 48.15, longitude: 9.48 },
        pv: { configLevel: 'simple', totalKwp: 10, tiltDeg: 35, azimuthDeg: 180, strings: [], model: 'solcast' }
      }
    }),
    pushLog: () => {}
  };

  const pv = createPvForecast(ctx, {
    tier: 1,
    store: mockStore,
    pythonBridge: mockPythonBridge,
    solcastClient: mockSolcastClient
  });

  await pv.runForecast();
  assert.equal(pythonCalled, false, 'Python bridge should NOT be called on Tier 1');
  assert.equal(solcastCalled, true, 'Solcast should be called on Tier 1');
});

test('createPvForecast on Tier 2 calls pythonBridge.call with correct input schema', async () => {
  let pythonInput = null;
  const mockPythonBridge = {
    call: async (script, input) => {
      pythonInput = input;
      return [{ ts: '2026-04-03T12:00:00', power_w: 3500 }];
    }
  };
  const mockSolcastClient = {
    fetchPvForecast: async () => []
  };
  const mockStore = {
    insertPvForecast: async () => {},
    getLatestWeather: async () => [
      { ts_utc: '2026-04-03T10:00:00Z', ghi_wm2: 500, dni_wm2: 400, dhi_wm2: 100, temperature_c: 15, wind_speed_ms: 3 }
    ]
  };
  const mockState = { forecast: { pv: {} } };
  const ctx = {
    state: mockState,
    getCfg: () => ({
      forecast: {
        location: { latitude: 48.15, longitude: 9.48 },
        pv: { configLevel: 'simple', totalKwp: 10, tiltDeg: 35, azimuthDeg: 180, strings: [], model: 'pvlib' }
      }
    }),
    pushLog: () => {}
  };

  const pv = createPvForecast(ctx, {
    tier: 2,
    store: mockStore,
    pythonBridge: mockPythonBridge,
    solcastClient: mockSolcastClient
  });

  await pv.runForecast();
  assert.ok(pythonInput !== null, 'Python bridge should be called on Tier 2');
  assert.equal(pythonInput.lat, 48.15);
  assert.equal(pythonInput.lon, 9.48);
  assert.equal(pythonInput.kwp, 10);
  assert.ok(Array.isArray(pythonInput.weather), 'Input should include weather data');
});

test('mergePvForecasts combines Solcast + pvlib results (both model)', async () => {
  const mockPythonBridge = {
    call: async () => [
      { ts: '2026-04-03T12:00:00', power_w: 4000 },
      { ts: '2026-04-03T12:15:00', power_w: 4200 }
    ]
  };
  const mockSolcastClient = {
    fetchPvForecast: async () => [
      { ts: '2026-04-03T12:00:00', power_w: 5000 },
      { ts: '2026-04-03T12:15:00', power_w: 5400 }
    ]
  };
  let storedRows = [];
  const mockStore = {
    insertPvForecast: async (row) => { storedRows.push(row); },
    getLatestWeather: async () => [
      { ts_utc: '2026-04-03T10:00:00Z', ghi_wm2: 500, dni_wm2: 400, dhi_wm2: 100, temperature_c: 15, wind_speed_ms: 3 }
    ]
  };
  const mockState = { forecast: { pv: {} } };
  const ctx = {
    state: mockState,
    getCfg: () => ({
      forecast: {
        location: { latitude: 48.15, longitude: 9.48 },
        pv: { configLevel: 'simple', totalKwp: 10, tiltDeg: 35, azimuthDeg: 180, strings: [], model: 'both' }
      }
    }),
    pushLog: () => {}
  };

  const pv = createPvForecast(ctx, {
    tier: 2,
    store: mockStore,
    pythonBridge: mockPythonBridge,
    solcastClient: mockSolcastClient
  });

  await pv.runForecast();
  // In 'both' mode, the merged result should average the power values
  // (4000 + 5000) / 2 = 4500 for the first slot
  const firstSlot = storedRows.find(r => r.ts_utc === '2026-04-03T12:00:00');
  assert.ok(firstSlot, 'Should store a row for 12:00');
  assert.equal(firstSlot.power_w, 4500, 'Merged power should be average of Solcast and pvlib');
  assert.equal(firstSlot.model, 'combined', 'Model should be "combined" for merged results');
});
