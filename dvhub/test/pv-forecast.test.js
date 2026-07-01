import test from 'node:test';
import assert from 'node:assert/strict';

import { createPvForecast, buildPvlibInput, mergePvForecastsWeighted } from '../services/forecast/pv-forecast.js';

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
    // Plan 09-08: batched variant added — keep mocks API-compatible with the
    // store factory's return-object.
    insertPvForecastBatch: async () => {},
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
    insertPvForecastBatch: async () => {}, // Plan 09-08 batched variant
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
      { ts: '2026-04-03T12:00:00Z', power_w: 4000 },
      { ts: '2026-04-03T12:15:00Z', power_w: 4200 }
    ]
  };
  const mockSolcastClient = {
    fetchPvForecast: async () => [
      { ts: '2026-04-03T12:00:00Z', power_w: 5000 },
      { ts: '2026-04-03T12:15:00Z', power_w: 5400 }
    ]
  };
  const storedRows = [];
  const mockStore = {
    insertPvForecast: async (row) => { storedRows.push(row); },
    // Plan 09-08: batched callers now go through insertPvForecastBatch — flatten
    // the rows array into storedRows so existing assertions (look up by ts_utc)
    // continue to work unchanged.
    insertPvForecastBatch: async (rows) => {
      if (Array.isArray(rows)) for (const row of rows) storedRows.push(row);
    },
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
  const firstSlot = storedRows.find(r => new Date(r.ts_utc).getTime() === Date.parse('2026-04-03T12:00:00Z'));
  assert.ok(firstSlot, 'Should store a row for 12:00');
  assert.equal(firstSlot.power_w, 4500, 'Merged power should be average of Solcast and pvlib');
  assert.equal(firstSlot.model, 'combined', 'Model should be "combined" for merged results');
});

// --- WR-01: MAE-weighted path surfaces which present providers it excludes ---
// When inverse-MAE weighting is active (accuracy data exists), only the tracked
// providers (pvnode/solcast/pvlib) carry a weight. A present provider WITHOUT an
// MAE column (vrm/forecast_solar/open_meteo — lifted into the ensemble by 26-01)
// has an undefined weight and is skipped by mergeForecasts. Log that exclusion so
// an operator can distinguish "excluded by design" from a fetch error.
// Pure observability — the weights + merged result are unchanged.

// Operator request 2026-06-21: weight ALL providers by accuracy. A present
// provider WITHOUT its own 7-day MAE is no longer dropped — it rides the NEUTRAL
// PRIOR (mean MAE of the providers that do have one) so it participates at average
// accuracy. The merge never collapses to a single tracked provider.
test('mergePvForecastsWeighted: a present provider without its own MAE rides the neutral prior (not excluded)', async () => {
  const events = [];
  const store = {
    getForecastAccuracyRow: async () => ({ mae_7d_pvnode: 100, mae_7d_solcast: 200, mae_7d_pvlib: 300 })
  };
  const providersBySlot = {
    pvnode: [{ ts_utc: '2026-04-03T12:00:00Z', power_w: 4000 }],
    vrm:    [{ ts_utc: '2026-04-03T12:00:00Z', power_w: 5000 }] // no own MAE → neutral prior, NOT excluded
  };
  const { weights } = await mergePvForecastsWeighted({
    providersBySlot, store, pushLog: (ev, data) => events.push({ ev, data })
  });
  assert.ok(Number.isFinite(weights.pvnode), 'pvnode (tracked) carries a finite weight');
  assert.ok(Number.isFinite(weights.vrm), 'vrm (no own MAE) is weighted via the neutral prior, NOT excluded');
  const priorEvent = events.find(e => e.ev === 'ensemble_mae_neutral_prior');
  assert.ok(priorEvent, 'a neutral-prior event is logged');
  assert.deepEqual(priorEvent.data.priored, ['vrm']);
  assert.ok(priorEvent.data.weighted.includes('pvnode'), 'weighted list names the MAE-tracked providers');
});

test('mergePvForecastsWeighted: no neutral-prior event when every present provider has its own MAE', async () => {
  const events = [];
  const store = {
    getForecastAccuracyRow: async () => ({ mae_7d_pvnode: 100, mae_7d_solcast: 200, mae_7d_pvlib: 300 })
  };
  const providersBySlot = {
    pvnode:  [{ ts_utc: '2026-04-03T12:00:00Z', power_w: 4000 }],
    solcast: [{ ts_utc: '2026-04-03T12:00:00Z', power_w: 4200 }]
  };
  const { weights } = await mergePvForecastsWeighted({ providersBySlot, store, pushLog: (ev, data) => events.push({ ev, data }) });
  assert.ok(Number.isFinite(weights.pvnode) && Number.isFinite(weights.solcast), 'both tracked providers weighted');
  assert.ok(!events.some(e => e.ev === 'ensemble_mae_neutral_prior'),
    'no neutral-prior event when every present provider has its own MAE');
});

// --- Phase 26-01: VRM/forecast_solar/open_meteo feed the WEIGHTED ensemble ---
//
// These three providers were fetched + normalized but only ever consumed by the
// single-fallback else-if chain — they never entered presentProviders/providersBySlot,
// so they could not participate in mergePvForecastsWeighted. Phase 26-01 lifts them into
// the same three-step (normalize → present-push → providersBySlot) as pvnode/solcast/pvlib,
// relying on the 26-02 per-slot effective-weight renorm for correct partial-coverage merge.

/**
 * Shared mock-store: getForecastAccuracyRow returns nothing → mergePvForecastsWeighted
 * falls into the uniform-weight path (the new providers have no MAE column by design —
 * 26-01 weighting decision: new providers ride the uniform path, inverse-MAE stays on
 * pvnode/solcast/pvlib only).
 */
function makeEnsembleMockStore() {
  const storedRows = [];
  return {
    storedRows,
    insertPvForecast: async (row) => { storedRows.push(row); },
    insertPvForecastBatch: async (rows) => {
      if (Array.isArray(rows)) for (const row of rows) storedRows.push(row);
    },
    getLatestWeather: async () => [],
    // present → uniform fallback (no inverse-MAE row)
    getForecastAccuracyRow: async () => null
  };
}

function makeAutoCtx(state, extra = {}) {
  return {
    state,
    getCfg: () => ({
      forecast: {
        location: { latitude: 48.15, longitude: 9.48 },
        // model 'auto' so forecast_solar + open_meteo are attempted; pvnode only if configured.
        pv: { configLevel: 'simple', totalKwp: 10, tiltDeg: 35, azimuthDeg: 180, strings: [], model: 'auto' },
        solcast: {} // no apiKey → solcast not fetched
      }
    }),
    pushLog: () => {},
    bumpForecastVersion: () => {},
    ...extra
  };
}

test('26-01 Test A: vrm + forecast_solar (2 present) → combined ensemble path, not single-fallback', async () => {
  const mockStore = makeEnsembleMockStore();
  const mockState = { forecast: { pv: {} } };
  const ctx = makeAutoCtx(mockState);

  const pv = createPvForecast(ctx, {
    tier: 1,
    store: mockStore,
    pythonBridge: { call: async () => [] },
    solcastClient: { fetchPvForecast: async () => [] },
    forecastSolar: {
      fetchForecast: async () => [
        { ts_utc: '2026-04-03T12:00:00Z', power_w: 3000 },
        { ts_utc: '2026-04-03T12:15:00Z', power_w: 3200 }
      ]
    },
    vrmForecast: {
      isAvailable: () => true,
      readPvForecast: async () => [
        { ts_utc: '2026-04-03T12:00:00Z', power_w: 5000 },
        { ts_utc: '2026-04-03T12:15:00Z', power_w: 5400 }
      ]
    },
    openMeteoSolar: { generateForecast: async () => [] },
    pvnodeClient: { isConfigured: false, fetchForecast: async () => [] }
  });

  await pv.runForecast();
  // With vrm + forecast_solar both present, presentProviders.length === 2 → ensemble path.
  assert.equal(mockState.forecast.pv.model, 'combined',
    'vrm + forecast_solar should enter the combined ensemble path, NOT the single-fallback chain');
  // Uniform two-way merge of vrm (5000) + forecast_solar (3000) = 4000 at 12:00.
  const slot12 = mockState.forecast.pv.data.find(r => new Date(r.ts_utc).getTime() === Date.parse('2026-04-03T12:00:00Z'));
  assert.ok(slot12, 'merged data should include the 12:00 slot');
  assert.equal(slot12.power_w, 4000, 'uniform 2-way merge of 5000 + 3000 = 4000');
});

test('26-01 Test B: writeSnapshot receives vrm/forecast_solar/open_meteo layers', async () => {
  const mockStore = makeEnsembleMockStore();
  const mockState = { forecast: { pv: {} } };
  let snapshotArg = null;
  const ctx = makeAutoCtx(mockState, {
    forecastSnapshots: {
      writeSnapshot: async (arg) => { snapshotArg = arg; }
    }
  });

  const pv = createPvForecast(ctx, {
    tier: 1,
    store: mockStore,
    pythonBridge: { call: async () => [] },
    solcastClient: { fetchPvForecast: async () => [] },
    forecastSolar: {
      fetchForecast: async () => [{ ts_utc: '2026-04-03T12:00:00Z', power_w: 3000 }]
    },
    vrmForecast: {
      isAvailable: () => true,
      readPvForecast: async () => [{ ts_utc: '2026-04-03T12:00:00Z', power_w: 5000 }]
    },
    openMeteoSolar: {
      generateForecast: async () => [{ ts_utc: '2026-04-03T12:00:00Z', power_w: 6000 }]
    },
    pvnodeClient: { isConfigured: false, fetchForecast: async () => [] }
  });

  await pv.runForecast();
  assert.ok(snapshotArg, 'writeSnapshot should have been called');
  assert.ok('vrm' in snapshotArg, 'snapshot should carry a vrm layer');
  assert.ok('forecast_solar' in snapshotArg, 'snapshot should carry a forecast_solar layer');
  assert.ok('open_meteo' in snapshotArg, 'snapshot should carry an open_meteo layer');
  assert.equal(snapshotArg.vrm?.[0]?.power_w, 5000, 'vrm layer carries normalized slots');
  assert.equal(snapshotArg.forecast_solar?.[0]?.power_w, 3000, 'forecast_solar layer carries normalized slots');
  assert.equal(snapshotArg.open_meteo?.[0]?.power_w, 6000, 'open_meteo layer carries normalized slots');
});

test('26-01 Test C: single provider (open_meteo only) → single-fallback preserved', async () => {
  const mockStore = makeEnsembleMockStore();
  const mockState = { forecast: { pv: {} } };
  const ctx = makeAutoCtx(mockState);

  const pv = createPvForecast(ctx, {
    tier: 1,
    store: mockStore,
    pythonBridge: { call: async () => [] },
    solcastClient: { fetchPvForecast: async () => [] },
    forecastSolar: { fetchForecast: async () => [] },
    vrmForecast: { isAvailable: () => false, readPvForecast: async () => [] },
    openMeteoSolar: {
      generateForecast: async () => [{ ts_utc: '2026-04-03T12:00:00Z', power_w: 6000 }]
    },
    pvnodeClient: { isConfigured: false, fetchForecast: async () => [] }
  });

  await pv.runForecast();
  assert.equal(mockState.forecast.pv.model, 'open_meteo',
    'with only open_meteo present, the single-fallback path must still set model=open_meteo');
});
