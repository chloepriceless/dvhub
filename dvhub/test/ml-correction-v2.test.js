// ml-correction-v2.test.js -- Tests for ML correction v2 rewrite (06-01 Task 1).
// Verifies: extended DI signature (store, state), buildFeatures() feature dict,
// forecastVersion-based prediction cache, cache eviction, constant accuracy zeros.

import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMlCorrection } from '../services/ml/ml-correction.js';

describe('createMlCorrection v2 — extended DI + buildFeatures + forecastVersion cache', () => {
  let mockBridge, mockGetCfg, mockPushLog, mockStore, mockState, correction;

  beforeEach(() => {
    mockBridge = {
      call: mock.fn(async () => ({
        ok: true,
        applied: true,
        model: 'lgbm_v1',
        corrected: [
          { start: '2026-04-09T12:00:00Z', powerW: 1100, rawPowerW: 1000, confidence: 0.85 }
        ]
      }))
    };
    mockPushLog = mock.fn();
    mockGetCfg = () => ({
      ml: { mlEnabled: true, mlModelDir: '/tmp/ml-models' },
      forecast: {
        pv: {
          totalKwp: 10.5,
          strings: [
            { kwp: 6.5, tiltDeg: 30, azimuthDeg: 190 },
            { kwp: 4.0, tiltDeg: 25, azimuthDeg: 170 }
          ]
        }
      }
    });
    mockStore = {
      getLatestWeather: mock.fn(async () => [
        {
          ts_utc: new Date('2026-04-09T12:00:00Z'),
          visibility_m: 20000,
          cloud_cover_pct: 30,
          humidity_pct: 55,
          temperature_c: 18.5
        },
        {
          ts_utc: new Date('2026-04-09T13:00:00Z'),
          visibility_m: 18000,
          cloud_cover_pct: 40,
          humidity_pct: 60,
          temperature_c: 19.2
        }
      ])
    };
    mockState = { forecast: {} };
    correction = createMlCorrection({
      pythonBridge: mockBridge,
      getCfg: mockGetCfg,
      pushLog: mockPushLog,
      store: mockStore,
      state: mockState
    });
    correction.setModel({ model_type: 'lgbm', version: 1, mae: 42 });
  });

  it('Test 1: createMlCorrection receives {pythonBridge, getCfg, pushLog, store, state}', () => {
    // If we get here without errors, the factory accepted the extended signature.
    assert.ok(correction, 'correction module should be created with extended DI');
    assert.ok(typeof correction.correct === 'function');
    assert.ok(typeof correction.getModelInfo === 'function');
    assert.ok(typeof correction.setModel === 'function');
  });

  it('Test 2: buildFeatures() produces correct feature dict structure', async () => {
    const pvSlots = [
      { start: '2026-04-09T12:00:00Z', powerW: 1000 },
      { start: '2026-04-09T13:00:00Z', powerW: 900 }
    ];

    await correction.correct(pvSlots, { forecastVersion: 100 });

    // The pythonBridge.call should have been called with a features object
    assert.equal(mockBridge.call.mock.calls.length, 1);
    const callArgs = mockBridge.call.mock.calls[0].arguments;
    const payload = callArgs[1]; // second arg to pythonBridge.call

    // Verify features structure
    assert.ok(payload.features, 'payload must contain features');
    const features = payload.features;

    // Weather array
    assert.ok(Array.isArray(features.weather), 'features.weather must be array');
    assert.ok(features.weather.length >= 1, 'features.weather must have entries');
    const w0 = features.weather[0];
    assert.ok('hour' in w0, 'weather entry must have hour');
    assert.ok('visibility_m' in w0, 'weather entry must have visibility_m');
    assert.ok('cloud_cover_pct' in w0, 'weather entry must have cloud_cover_pct');
    assert.ok('humidity_pct' in w0, 'weather entry must have humidity_pct');
    assert.ok('temp_c' in w0, 'weather entry must have temp_c');

    // Plant config
    assert.ok(features.plant, 'features must have plant');
    assert.equal(features.plant.tilt_deg, 30, 'dominant string tilt_deg');
    assert.equal(features.plant.azimuth_deg, 190, 'dominant string azimuth_deg');
    assert.equal(features.plant.kwp, 10.5, 'total kwp from config');

    // Accuracy always zeros (D-A2)
    assert.ok(features.accuracy, 'features must have accuracy');
    assert.equal(features.accuracy.mae_7d_solcast, 0);
    assert.equal(features.accuracy.mae_7d_pvlib, 0);
    assert.equal(features.accuracy.mae_7d_merged, 0);
  });

  it('Test 3: correct() with forecastVersion=1 calls pythonBridge once, second call with same version returns cached', async () => {
    const pvSlots = [{ start: '2026-04-09T12:00:00Z', powerW: 1000 }];

    // First call
    const result1 = await correction.correct(pvSlots, { forecastVersion: 1 });
    assert.equal(result1.applied, true);
    assert.equal(mockBridge.call.mock.calls.length, 1, 'first call should hit Python');

    // Second call with same forecastVersion
    const result2 = await correction.correct(pvSlots, { forecastVersion: 1 });
    assert.equal(result2.applied, true);
    assert.equal(mockBridge.call.mock.calls.length, 1, 'second call should be cache hit — no new Python call');
  });

  it('Test 4: correct() with forecastVersion=2 spawns new Python call (cache miss)', async () => {
    const pvSlots = [{ start: '2026-04-09T12:00:00Z', powerW: 1000 }];

    // Call with version 1
    await correction.correct(pvSlots, { forecastVersion: 1 });
    assert.equal(mockBridge.call.mock.calls.length, 1);

    // Call with version 2 (cache miss)
    await correction.correct(pvSlots, { forecastVersion: 2 });
    assert.equal(mockBridge.call.mock.calls.length, 2, 'new forecastVersion should trigger Python call');
  });

  it('Test 5: cache evicts oldest entry when size > 2', async () => {
    const pvSlots = [{ start: '2026-04-09T12:00:00Z', powerW: 1000 }];

    // Fill cache with version 1 and 2
    await correction.correct(pvSlots, { forecastVersion: 1 });
    await correction.correct(pvSlots, { forecastVersion: 2 });
    assert.equal(mockBridge.call.mock.calls.length, 2);

    // Version 3 should evict version 1
    await correction.correct(pvSlots, { forecastVersion: 3 });
    assert.equal(mockBridge.call.mock.calls.length, 3);

    // Version 2 should still be cached
    await correction.correct(pvSlots, { forecastVersion: 2 });
    assert.equal(mockBridge.call.mock.calls.length, 3, 'version 2 should still be cached');

    // Version 1 should be evicted (cache miss)
    await correction.correct(pvSlots, { forecastVersion: 1 });
    assert.equal(mockBridge.call.mock.calls.length, 4, 'version 1 should have been evicted');
  });

  it('Test 6: accuracy fields are always {mae_7d_solcast: 0, mae_7d_pvlib: 0, mae_7d_merged: 0}', async () => {
    const pvSlots = [{ start: '2026-04-09T12:00:00Z', powerW: 1000 }];

    await correction.correct(pvSlots, { forecastVersion: 200 });

    const payload = mockBridge.call.mock.calls[0].arguments[1];
    const acc = payload.features.accuracy;
    assert.deepStrictEqual(acc, {
      mae_7d_solcast: 0,
      mae_7d_pvlib: 0,
      mae_7d_merged: 0
    }, 'accuracy must always be constant zeros per D-A2');
  });
});
