/**
 * External Integrations API Routes Tests
 *
 * Tests EVCC, Forecast, Tariff, and MISPEL route handlers
 * using Fastify inject() with mock service objects.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

import { createEvccRoutes } from '../modules/optimizer/routes/evcc-routes.js';
import { createForecastRoutes } from '../modules/optimizer/routes/forecast-routes.js';
import { createTariffRoutes } from '../modules/optimizer/routes/tariff-routes.js';

// --- EVCC Routes ---

describe('evcc routes - no data', () => {
  let fastify;

  before(async () => {
    fastify = Fastify();
    const evccBridge = { getState: () => null };
    const registerRoutes = createEvccRoutes({ evccBridge });
    registerRoutes(fastify);
  });

  after(async () => { await fastify.close(); });

  it('GET /api/evcc/state returns { state: null } when EVCC bridge has no data', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/evcc/state' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.state, null);
  });

  it('GET /api/evcc/loadpoints returns { loadpoints: [] } when no EVCC data', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/evcc/loadpoints' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(body.loadpoints, []);
  });
});

describe('evcc routes - with data', () => {
  let fastify;

  const mockState = {
    loadpoints: [
      { title: 'Wallbox', chargePower: 7400, vehicleSoc: 65 },
      { title: 'Carport', chargePower: 0, vehicleSoc: 80 },
    ],
    gridPower: 1200,
    pvPower: 5000,
    updatedAt: '2026-03-14T12:00:00Z',
  };

  before(async () => {
    fastify = Fastify();
    const evccBridge = { getState: () => mockState };
    const registerRoutes = createEvccRoutes({ evccBridge });
    registerRoutes(fastify);
  });

  after(async () => { await fastify.close(); });

  it('GET /api/evcc/state returns normalized loadpoint data when bridge has state', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/evcc/state' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.state);
    assert.equal(body.state.loadpoints.length, 2);
    assert.equal(body.state.loadpoints[0].chargePower, 7400);
  });

  it('GET /api/evcc/loadpoints returns loadpoints array from state', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/evcc/loadpoints' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.loadpoints.length, 2);
    assert.equal(body.loadpoints[1].title, 'Carport');
  });
});

// --- Forecast Routes ---

describe('forecast routes - no data', () => {
  let fastify;

  before(async () => {
    fastify = Fastify();
    const forecastBroker = {
      getPvForecast: () => null,
      getLoadForecast: () => null,
      isForecastStale: () => true,
    };
    const registerRoutes = createForecastRoutes({ forecastBroker });
    registerRoutes(fastify);
  });

  after(async () => { await fastify.close(); });

  it('GET /api/forecast/pv returns { forecast: null, stale: true } when no forecast ingested', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/forecast/pv' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.forecast, null);
    assert.equal(body.stale, true);
  });

  it('GET /api/forecast/load returns { forecast: null, stale: true } when no forecast', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/forecast/load' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.forecast, null);
    assert.equal(body.stale, true);
  });
});

describe('forecast routes - with data', () => {
  let fastify;

  const mockPvForecast = {
    data: [100, 200, 300],
    ingestedAt: '2026-03-14T11:00:00Z',
  };
  const mockLoadForecast = {
    data: [400, 500, 600],
    ingestedAt: '2026-03-14T11:00:00Z',
  };

  before(async () => {
    fastify = Fastify();
    const forecastBroker = {
      getPvForecast: () => mockPvForecast,
      getLoadForecast: () => mockLoadForecast,
      isForecastStale: (f) => f === null,
    };
    const registerRoutes = createForecastRoutes({ forecastBroker });
    registerRoutes(fastify);
  });

  after(async () => { await fastify.close(); });

  it('GET /api/forecast/pv returns forecast object with stale flag when forecast exists', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/forecast/pv' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(body.forecast.data, [100, 200, 300]);
    assert.equal(body.stale, false);
  });

  it('GET /api/forecast/load returns load forecast with stale flag', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/forecast/load' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(body.forecast.data, [400, 500, 600]);
    assert.equal(body.stale, false);
  });
});

// --- Tariff Routes ---

describe('tariff routes', () => {
  let fastify;

  before(async () => {
    fastify = Fastify();
    const tariffEngine = {
      resolvePrice: (ts) => 25.5,
      resolveNetworkCharge: (ts) => 8.0,
    };
    const registerRoutes = createTariffRoutes({ tariffEngine });
    registerRoutes(fastify);
  });

  after(async () => { await fastify.close(); });

  it('GET /api/tariff/current returns resolved price for current timestamp', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/tariff/current' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.price, 25.5);
    assert.equal(body.networkCharge, 8.0);
    assert.ok(body.timestamp);
  });

  it('GET /api/tariff/schedule?hours=24 returns 96 entries (15-min slots)', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/tariff/schedule?hours=24' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.slots.length, 96);
    assert.equal(body.resolution, '15min');
    assert.ok(body.slots[0].timestamp);
    assert.equal(body.slots[0].price, 25.5);
    assert.equal(body.slots[0].networkCharge, 8.0);
  });
});

// --- MISPEL Routes ---

describe('mispel routes - enabled', () => {
  let fastify;

  before(async () => {
    fastify = Fastify();
    const tariffEngine = {
      resolvePrice: () => 25.5,
      resolveNetworkCharge: () => 8.0,
    };
    const mispelTracker = {
      isEnabled: () => true,
      getAnnualStatus: async (year) => ({
        year,
        enabled: true,
        totalPvToStorageKwh: 120.5,
        totalGridToStorageKwh: 30.2,
        totalStorageToGridKwh: 10.1,
        capKwh: 5000,
        utilizationPct: 2.41,
      }),
    };
    const registerRoutes = createTariffRoutes({ tariffEngine, mispelTracker });
    registerRoutes(fastify);
  });

  after(async () => { await fastify.close(); });

  it('GET /api/mispel/status returns annual cap status when MISPEL enabled', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/mispel/status' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.enabled, true);
    assert.equal(body.year, new Date().getFullYear());
    assert.equal(typeof body.totalPvToStorageKwh, 'number');
    assert.equal(typeof body.capKwh, 'number');
  });
});

describe('mispel routes - disabled', () => {
  let fastify;

  before(async () => {
    fastify = Fastify();
    const tariffEngine = {
      resolvePrice: () => 25.5,
      resolveNetworkCharge: () => 8.0,
    };
    const mispelTracker = {
      isEnabled: () => false,
    };
    const registerRoutes = createTariffRoutes({ tariffEngine, mispelTracker });
    registerRoutes(fastify);
  });

  after(async () => { await fastify.close(); });

  it('GET /api/mispel/status returns { enabled: false } when MISPEL disabled', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/mispel/status' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.enabled, false);
  });
});

// --- Auth conditional ---

describe('evcc routes - auth conditional', () => {
  let fastify;

  before(async () => {
    fastify = Fastify();
    fastify.decorate('authenticate', async (request, reply) => {
      if (!request.headers.authorization) {
        reply.code(401).send({ error: 'Authentication required' });
      }
    });
    const evccBridge = { getState: () => null };
    const registerRoutes = createEvccRoutes({ evccBridge });
    registerRoutes(fastify);
  });

  after(async () => { await fastify.close(); });

  it('routes apply auth preHandler when fastify.authenticate is decorated', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/evcc/state' });
    assert.equal(res.statusCode, 401);
  });
});
