// statsforecast.test.js -- StatsForecast load forecast delegation tests (MLAI-03).
// Tests: SF delegation on tier>=2, SF skip on tier<2, SF skip when sfEnabled=false,
// SQL fallback on bridge error, output contract validation.
// Uses node:test and node:assert with mock dependencies.

import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createLoadForecast, formatLoadSlots, computeLoadConfidence } from '../services/forecast/load-forecast.js';

describe('StatsForecast delegation in load-forecast', () => {
  let mockBridge, mockGetCfg, mockPushLog, mockStore, mockVrmForecast, ctx;

  beforeEach(() => {
    mockBridge = { call: mock.fn() };
    mockPushLog = mock.fn();
    mockStore = {
      insertLoadForecast: mock.fn(async () => {}),
      query: mock.fn()
    };
    mockVrmForecast = { isAvailable: () => false };
    mockGetCfg = () => ({
      ml: { sfEnabled: true, mlSlidingWindowMonths: 1, sfUseMstl: false },
      forecast: { load: { defaultPowerW: 800 } }
    });
    ctx = {
      state: { forecast: { load: { lastFetchAt: null, data: null, confidence: 0.3 } } },
      getCfg: mockGetCfg,
      pushLog: mockPushLog,
      db: {
        query: mock.fn(async () => ({ rows: [] }))
      },
      forecastService: { tier: 2 },
      bumpForecastVersion: mock.fn()
    };
  });

  it('test 1: SF delegation on tier >= 2 with sfEnabled=true', async () => {
    ctx.forecastService = { tier: 2 };

    // Mock python bridge returns SF data
    mockBridge.call.mock.mockImplementation(async () => [
      { ts_utc: '2026-04-08T12:00:00Z', power_w: 1500, confidence: 0.8 },
      { ts_utc: '2026-04-08T13:00:00Z', power_w: 1200, confidence: 0.75 }
    ]);

    // Mock store.query for queryLoadHistory -- need >= 48 rows for SF to attempt
    const historyRows = Array.from({ length: 50 }, (_, i) => ({
      ts_utc: new Date(Date.now() - (50 - i) * 3600000).toISOString(),
      power_w: 1400 + Math.random() * 200
    }));
    mockStore.query.mock.mockImplementation(async () => ({
      rows: historyRows
    }));

    const loadForecast = createLoadForecast(ctx, {
      store: mockStore,
      vrmForecast: mockVrmForecast,
      pythonBridge: mockBridge
    });

    await loadForecast.runForecast();

    // Verify python bridge was called with load_forecast_sf.py
    const bridgeCalls = mockBridge.call.mock.calls;
    assert.ok(bridgeCalls.length > 0, 'Python bridge should be called');
    const callArgs = bridgeCalls[0].arguments;
    assert.ok(
      callArgs[0].includes('load_forecast_sf.py'),
      'Should call load_forecast_sf.py'
    );
  });

  it('test 2: SF skipped on tier < 2', async () => {
    ctx.forecastService = { tier: 1 };

    const loadForecast = createLoadForecast(ctx, {
      store: mockStore,
      vrmForecast: mockVrmForecast,
      pythonBridge: mockBridge
    });

    await loadForecast.runForecast();

    // Python bridge should NOT be called
    assert.equal(mockBridge.call.mock.calls.length, 0, 'Bridge should not be called on tier 1');
  });

  it('test 3: SF skipped when sfEnabled=false', async () => {
    ctx.forecastService = { tier: 2 };
    ctx.getCfg = () => ({
      ml: { sfEnabled: false, mlSlidingWindowMonths: 1, sfUseMstl: false },
      forecast: { load: { defaultPowerW: 800 } }
    });

    const loadForecast = createLoadForecast(ctx, {
      store: mockStore,
      vrmForecast: mockVrmForecast,
      pythonBridge: mockBridge
    });

    await loadForecast.runForecast();

    // Python bridge should NOT be called
    assert.equal(mockBridge.call.mock.calls.length, 0, 'Bridge should not be called when sfEnabled=false');
  });

  it('test 4: SQL fallback on bridge error', async () => {
    ctx.forecastService = { tier: 2 };

    // Mock python bridge to throw
    mockBridge.call.mock.mockImplementation(async () => {
      throw new Error('python process crashed');
    });

    // Mock store.query for queryLoadHistory -- need >= 48 rows for SF to attempt
    const historyRows = Array.from({ length: 50 }, (_, i) => ({
      ts_utc: new Date(Date.now() - (50 - i) * 3600000).toISOString(),
      power_w: 1400 + Math.random() * 200
    }));
    mockStore.query.mock.mockImplementation(async () => ({
      rows: historyRows
    }));

    const loadForecast = createLoadForecast(ctx, {
      store: mockStore,
      vrmForecast: mockVrmForecast,
      pythonBridge: mockBridge
    });

    // Should NOT throw
    await loadForecast.runForecast();

    // Should log the error
    const errorLog = mockPushLog.mock.calls.find(
      c => c.arguments[0] === 'sf_load_forecast_error'
    );
    assert.ok(errorLog, 'Should log sf_load_forecast_error');

    // Should still produce load data (from SQL fallback)
    assert.ok(ctx.state.forecast.load.data, 'Should have load data from SQL fallback');
  });

  it('test 5: output contract matches [{ts_utc, power_w, confidence}]', async () => {
    ctx.forecastService = { tier: 2 };

    // Mock python bridge returns valid SF data
    const sfData = [
      { ts_utc: '2026-04-08T12:00:00Z', power_w: 1500, confidence: 0.8 },
      { ts_utc: '2026-04-08T13:00:00Z', power_w: 1200, confidence: 0.75 },
      { ts_utc: '2026-04-08T14:00:00Z', power_w: 900, confidence: 0.7 }
    ];

    mockBridge.call.mock.mockImplementation(async () => sfData);

    // Need >= 48 rows for SF to attempt
    const historyRows = Array.from({ length: 50 }, (_, i) => ({
      ts_utc: new Date(Date.now() - (50 - i) * 3600000).toISOString(),
      power_w: 1400 + Math.random() * 200
    }));
    mockStore.query.mock.mockImplementation(async () => ({
      rows: historyRows
    }));

    const loadForecast = createLoadForecast(ctx, {
      store: mockStore,
      vrmForecast: mockVrmForecast,
      pythonBridge: mockBridge
    });

    await loadForecast.runForecast();

    // Verify output contract on state data
    const loadData = ctx.state.forecast.load.data;
    assert.ok(Array.isArray(loadData), 'Load data should be an array');
    assert.ok(loadData.length > 0, 'Load data should have entries');

    for (const slot of loadData) {
      assert.ok(typeof slot.ts_utc === 'string', 'ts_utc should be a string');
      assert.ok(typeof slot.power_w === 'number', 'power_w should be a number');
      assert.ok(typeof slot.confidence === 'number', 'confidence should be a number');
      assert.ok(slot.confidence >= 0 && slot.confidence <= 1, 'confidence should be between 0 and 1');
    }
  });

  it('test 6: SF passes use_mstl=true on tier 3 when sfUseMstl enabled', async () => {
    ctx.forecastService = { tier: 3 };
    ctx.getCfg = () => ({
      ml: { sfEnabled: true, mlSlidingWindowMonths: 1, sfUseMstl: true },
      forecast: { load: { defaultPowerW: 800 } }
    });

    mockBridge.call.mock.mockImplementation(async () => [
      { ts_utc: '2026-04-08T12:00:00Z', power_w: 1500, confidence: 0.8 }
    ]);

    // Need >= 48 rows for SF to attempt
    const historyRows = Array.from({ length: 50 }, (_, i) => ({
      ts_utc: new Date(Date.now() - (50 - i) * 3600000).toISOString(),
      power_w: 1400 + Math.random() * 200
    }));
    mockStore.query.mock.mockImplementation(async () => ({
      rows: historyRows
    }));

    const loadForecast = createLoadForecast(ctx, {
      store: mockStore,
      vrmForecast: mockVrmForecast,
      pythonBridge: mockBridge
    });

    await loadForecast.runForecast();

    // Verify use_mstl was passed as true
    const callArgs = mockBridge.call.mock.calls[0].arguments;
    const inputData = callArgs[1];
    assert.equal(inputData.use_mstl, true, 'Should pass use_mstl=true on tier 3');
  });
});
