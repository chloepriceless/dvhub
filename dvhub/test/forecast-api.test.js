// test/forecast-api.test.js -- Tests for /api/forecast combined endpoint (FORE-07).
// Uses mock state objects (no live DB needed).

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createForecastService } from '../services/forecast/index.js';

// --- Mocking helpers ---

function createMockCtx(overrides = {}) {
  const state = {
    epex: {
      ok: true,
      data: [
        { ts: Date.now(), ct_kwh: 12.5, eur_mwh: 125 },
        { ts: Date.now() + 900_000, ct_kwh: 13.0, eur_mwh: 130 },
        { ts: Date.now() + 1_800_000, ct_kwh: 11.0, eur_mwh: 110 }
      ]
    },
    forecast: null,  // Will be set by createForecastService
    ...overrides.state
  };

  const cfg = {
    forecast: {
      enabled: true,
      pv: { model: 'solcast', configLevel: 'simple', totalKwp: 10 },
      load: { model: 'sql_weekday', defaultPowerW: 800 },
      location: { latitude: 51.0, longitude: 9.0 },
      solcast: { apiKey: '', siteId: '' },
      weather: { fetchIntervalMs: 3_600_000 },
      retention: { strategy: 'time_based', minFreeDiskPct: 20 }
    },
    ...overrides.cfg
  };

  const logs = [];

  return {
    state,
    getCfg: () => cfg,
    pushLog: (type, data) => logs.push({ type, data }),
    db: null,  // No DB for unit tests
    _logs: logs
  };
}

describe('createForecastService', () => {

  it('should return an object with start, close, tier, store, buildForecastResponse', () => {
    const ctx = createMockCtx();
    const service = createForecastService(ctx);
    assert.equal(typeof service.start, 'function');
    assert.equal(typeof service.close, 'function');
    assert.equal(typeof service.tier, 'number');
    assert.ok(service.store);
    assert.equal(typeof service.buildForecastResponse, 'function');
  });

  it('should initialize state.forecast with tier info', () => {
    const ctx = createMockCtx();
    createForecastService(ctx);
    assert.equal(typeof ctx.state.forecast.tier, 'number');
    assert.equal(typeof ctx.state.forecast.totalMB, 'number');
    assert.ok(ctx.state.forecast.tier >= 1 && ctx.state.forecast.tier <= 3);
  });

  it('should log forecast_init on creation', () => {
    const ctx = createMockCtx();
    createForecastService(ctx);
    const initLog = ctx._logs.find(l => l.type === 'forecast_init');
    assert.ok(initLog, 'forecast_init log should exist');
    assert.ok(initLog.data.tier);
    assert.ok(initLog.data.totalMB);
  });
});

describe('buildForecastResponse', () => {
  let ctx;
  let service;

  beforeEach(() => {
    ctx = createMockCtx();
    service = createForecastService(ctx);
  });

  it('should return object with meta, price, pv, load keys', () => {
    const response = service.buildForecastResponse();
    assert.ok(response.meta, 'response should have meta');
    assert.ok(response.price, 'response should have price');
    assert.ok(response.pv, 'response should have pv');
    assert.ok(response.load, 'response should have load');
  });

  it('meta should contain generatedAt, horizon, tier, pvModel, loadModel', () => {
    const { meta } = service.buildForecastResponse();
    assert.ok(meta.generatedAt, 'meta.generatedAt should exist');
    assert.equal(meta.horizon, '72h');
    assert.equal(typeof meta.tier, 'number');
    assert.ok(meta.pvModel, 'meta.pvModel should exist');
    assert.ok(meta.loadModel, 'meta.loadModel should exist');
  });

  it('meta.generatedAt should be a valid ISO date', () => {
    const { meta } = service.buildForecastResponse();
    const parsed = new Date(meta.generatedAt);
    assert.ok(!isNaN(parsed.getTime()), 'generatedAt should be a valid date');
  });

  it('price.resolution should be 15min per D-02', () => {
    const { price } = service.buildForecastResponse();
    assert.equal(price.resolution, '15min');
  });

  it('pv.resolution should be 15min per D-02', () => {
    const { pv } = service.buildForecastResponse();
    assert.equal(pv.resolution, '15min');
  });

  it('load.resolution should be 1h per D-02', () => {
    const { load } = service.buildForecastResponse();
    assert.equal(load.resolution, '1h');
  });

  it('price slots should have start, end, ctKwh, confidence fields', () => {
    const { price } = service.buildForecastResponse();
    assert.ok(price.slots.length > 0, 'should have price slots from mock EPEX data');
    for (const slot of price.slots) {
      assert.ok(slot.start, 'slot should have start');
      assert.ok(slot.end, 'slot should have end');
      assert.equal(typeof slot.ctKwh, 'number', 'slot should have numeric ctKwh');
      assert.equal(typeof slot.confidence, 'number', 'slot should have numeric confidence');
    }
  });

  it('confidence values should be between 0.0 and 1.0 per D-05', () => {
    // Set up PV and load data for broader coverage
    ctx.state.forecast.pv.data = [
      { ts: new Date().toISOString(), powerW: 3500, confidence: 0.7 }
    ];
    ctx.state.forecast.load.data = [
      { ts_utc: new Date().toISOString(), power_w: 850, confidence: 0.5 }
    ];

    const response = service.buildForecastResponse();

    // Check price confidence
    for (const slot of response.price.slots) {
      assert.ok(slot.confidence >= 0.0 && slot.confidence <= 1.0,
        `price confidence ${slot.confidence} should be in [0, 1]`);
    }

    // Check PV confidence
    for (const slot of response.pv.slots) {
      assert.ok(slot.confidence >= 0.0 && slot.confidence <= 1.0,
        `pv confidence ${slot.confidence} should be in [0, 1]`);
    }

    // Check load confidence
    for (const slot of response.load.slots) {
      assert.ok(slot.confidence >= 0.0 && slot.confidence <= 1.0,
        `load confidence ${slot.confidence} should be in [0, 1]`);
    }
  });

  it('should return empty slots arrays when no data available', () => {
    // Start with clean state (no EPEX data)
    ctx.state.epex = { ok: false, data: null };
    ctx.state.forecast.pv.data = null;
    ctx.state.forecast.load.data = null;

    const response = service.buildForecastResponse();
    assert.deepEqual(response.price.slots, []);
    assert.deepEqual(response.pv.slots, []);
    assert.deepEqual(response.load.slots, []);
  });

  it('should use cfg defaults for pvModel and loadModel', () => {
    const { meta } = service.buildForecastResponse();
    assert.equal(meta.pvModel, 'solcast');
    assert.equal(meta.loadModel, 'sql_weekday');
  });

  it('should use state.forecast.pv.model when available', () => {
    ctx.state.forecast.pv.model = 'pvlib';
    const { meta } = service.buildForecastResponse();
    assert.equal(meta.pvModel, 'pvlib');
  });

  it('pv slots should have start, end, powerW, confidence', () => {
    ctx.state.forecast.pv.data = [
      { ts: new Date().toISOString(), powerW: 3500, confidence: 0.7 },
      { ts: new Date(Date.now() + 900_000).toISOString(), powerW: 3200, confidence: 0.65 }
    ];

    const { pv } = service.buildForecastResponse();
    assert.equal(pv.slots.length, 2);
    for (const slot of pv.slots) {
      assert.ok(slot.start, 'slot should have start');
      assert.ok(slot.end, 'slot should have end');
      assert.equal(typeof slot.powerW, 'number');
      assert.equal(typeof slot.confidence, 'number');
    }
  });

  it('load slots should have start, end, powerW, confidence', () => {
    ctx.state.forecast.load.data = [
      { ts_utc: new Date().toISOString(), power_w: 850, confidence: 0.5 },
      { ts_utc: new Date(Date.now() + 3_600_000).toISOString(), power_w: 920, confidence: 0.5 }
    ];

    const { load } = service.buildForecastResponse();
    assert.equal(load.slots.length, 2);
    for (const slot of load.slots) {
      assert.ok(slot.start, 'slot should have start');
      assert.ok(slot.end, 'slot should have end');
      assert.equal(typeof slot.powerW, 'number');
      assert.equal(typeof slot.confidence, 'number');
    }
  });
});
