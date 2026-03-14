import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import websocketPlugin from '@fastify/websocket';

import authPlugin from '../core/auth.js';
import createGatewayPlugin from '../modules/gateway/plugin.js';

const TEST_TOKEN = 'test-token';
const TEST_VERSION = '9.9.9-test';

const TEST_SNAPSHOT = {
  status: 'ok',
  inverter: { online: true },
  costs: {
    day: '2026-03-14',
    importWh: 1200,
    exportWh: 300,
    netEur: -0.42
  }
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '../public');

function createMockGatewayDeps() {
  const state = {
    schedule: {
      manualOverride: {},
      config: {},
      rules: [],
      active: {},
      lastWrite: {}
    },
    scan: { running: false, error: null, rows: [] },
    epex: { ok: true, error: null },
    log: [{ ts: '2026-03-14T00:00:00.000Z', event: 'boot' }],
    energy: { importWh: 1200, exportWh: 300, costEur: 0.33, revenueEur: 0.75 }
  };

  const config = {
    apiToken: TEST_TOKEN,
    schedule: { smallMarketAutomation: {} },
    telemetry: { historyImport: {} }
  };

  const rawConfig = { ...config };

  return {
    api: {
      getPublicDir: () => PUBLIC_DIR,
      getRootPage: () => 'index.html'
    },
    config,
    rawConfig,
    getSnapshot: () => TEST_SNAPSHOT,
    getState: () => state,
    getConfig: () => config,
    getRawConfig: () => rawConfig,
    configPath: '/tmp/dvhub-fastify-routes-test-config.json',
    logBuffer: [{ ts: '2026-03-14T00:00:00.000Z', event: 'started' }],
    appVersion: {
      version: TEST_VERSION,
      revision: 'test-revision',
      versionLabel: `v${TEST_VERSION}`
    },
    hal: {},
    eventBus: { emit: () => {}, on: () => {}, off: () => {} },
    scheduleRuntime: {},
    controlValue: () => 0,
    assertValidRuntimeCommand: () => {},
    applyControlTarget: async () => ({ ok: true }),
    validateScheduleRule: () => true,
    isSmallMarketAutomationRule: () => false,
    pushLog: () => {},
    persistConfig: () => {},
    saveAndApplyConfig: () => {},
    regenerateSmallMarketAutomationRules: () => {},
    integrationState: () => ({ ok: true }),
    eosState: () => ({ ok: true }),
    emhassState: () => ({ ok: true }),
    telemetrySafeWrite: (fn) => {
      if (typeof fn === 'function') fn();
    },
    buildOptimizerRunPayload: () => ({}),
    getTelemetryStore: () => ({ writeOptimizerRun: () => {} }),
    telemetryStore: { writeOptimizerRun: () => {} },
    fetchEpexDay: async () => {},
    runMeterScan: async () => {},
    buildApiHistoryImportStatusResponse: () => ({ ok: true }),
    getHistoryImportManager: () => null,
    historyImportManager: null,
    getHistoryApi: () => null,
    historyApi: null
  };
}

describe('gateway routes integration', () => {
  let fastify;
  const authHeaders = { authorization: `Bearer ${TEST_TOKEN}` };

  before(async () => {
    fastify = Fastify();

    await fastify.register(authPlugin, { apiToken: TEST_TOKEN });
    await fastify.register(websocketPlugin);
    await fastify.register(createGatewayPlugin(createMockGatewayDeps()));
  });

  after(async () => {
    await fastify.close();
  });

  it('GET /api/version returns 200 with version string', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/version',
      headers: authHeaders
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(typeof body.version, 'string');
    assert.equal(body.version, TEST_VERSION);
  });

  it('GET /api/status returns 200 with a JSON object', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/status',
      headers: authHeaders
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), TEST_SNAPSHOT);
  });

  it('GET /api/config returns 200 with config payload', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/config',
      headers: authHeaders
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.config, 'object');
    assert.equal(typeof body.effectiveConfig, 'object');
  });

  it('GET /api/log returns 200 with an array of rows', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/log',
      headers: authHeaders
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(Array.isArray(body.rows), true);
  });

  it('GET /api/costs returns 200 with a costs object', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/costs',
      headers: authHeaders
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), TEST_SNAPSHOT.costs);
  });

  it('returns 401 for auth-protected route when token is missing', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/status'
    });

    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error, 'Authentication required');
  });

  it('returns 200 for auth-protected route with a valid token', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/status',
      headers: authHeaders
    });

    assert.equal(response.statusCode, 200);
  });
});
