// test/admin-routes.test.js — Routen aus routes/admin-routes.js, die sonst
// kein Test über createApiRoutes().handleRequest erreicht (2026-10-15, beim
// Herauslösen aus routes-api.js). Die übrigen Admin-/DB-Routen prüfen
// admin-health, token-lifecycle, selfupdate-downgrade-guard, container-runtime
// und lan-trust.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApiRoutes } from '../routes-api.js';

const API_TOKEN = 'admin-routes-test-token-xxxxxxxxxxxxxx';

function mockRes() {
  const captured = { status: 0, headers: {}, body: '' };
  return {
    writeHead(code, headers) { captured.status = code; Object.assign(captured.headers, headers); },
    setHeader() {},
    end(payload) { captured.body = payload; },
    on() {},
    _captured: captured,
  };
}

function mockCtx({ telemetry = { enabled: false }, extra = {} } = {}) {
  const cfg = {
    apiToken: API_TOKEN,
    epex: { enabled: false, timezone: 'Europe/Berlin', bzn: 'DE-LU' },
    optimizer: { enabled: false },
    schedule: { timezone: 'Europe/Berlin', rules: [] },
    telemetry,
    family: {},
    gridPositiveMeans: 'grid_import',
    keepalivePulseSec: 30,
    corsAllowedOrigins: [],
    allowedHosts: [],
    security: { lanTrust: 'open' },
  };
  return {
    state: {
      meter: { ok: false, updatedAt: 0, grid_total_w: 0 },
      victron: { soc: 50, batteryPowerW: 0, pvTotalW: 0, updatedAt: 0 },
      epex: { ok: false, data: [] },
      energy: { day: null, importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0 },
      telemetry: { enabled: false, ok: false },
      keepalive: { modbusLastQuery: null, appPulse: { periodSec: 30 } },
      schedule: { rules: [], config: {}, active: {}, lastWrite: {}, manualOverride: {}, lastEvalAt: 0 },
      ctrl: { forcedOff: false, offUntil: 0, lastSignal: 'init', updatedAt: 0, dvControl: null },
      log: [],
      forecast: null,
    },
    getCfg: () => cfg,
    getRawCfg: () => cfg,
    getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }),
    getConfigPath: () => '/tmp/config.json',
    getConfigDefinition: () => [],
    getAppVersion: () => ({ version: '0.9.0-test' }),
    getTransportType: () => 'modbus',
    getAppDir: () => '/tmp',
    getRepoRoot: () => '/tmp',
    getServiceActionsEnabled: () => false,
    getServiceName: () => 'dvhub',
    getServiceUseSudo: () => false,
    runServiceCommand: async () => ({ ok: true }),
    controlValue: () => 'off',
    pushLog: () => {},
    telemetrySafeWrite: () => {},
    needsSetup: () => false,
    epexNowNext: () => null,
    expireLeaseIfNeeded: () => {},
    costSummary: () => ({}),
    userEnergyPricingSummary: () => ({}),
    buildSystemDiscoveryPayload: async () => ({ ok: true }),
    ...extra,
  };
}

async function call(ctx, pathname, method = 'GET') {
  const routes = createApiRoutes(ctx);
  const req = { method, url: pathname, headers: { host: 'dvhub.test', authorization: `Bearer ${API_TOKEN}` }, socket: { remoteAddress: '127.0.0.1' } };
  const res = mockRes();
  await routes.handleRequest(req, res, new URL(req.url, `http://${req.headers.host}`));
  return { status: res._captured.status, body: JSON.parse(res._captured.body) };
}

describe('routes/admin-routes.js über handleRequest', () => {
  it('GET /api/db/backup/status ohne Sicherungsdienst → 503', async () => {
    const r = await call(mockCtx(), '/api/db/backup/status');
    assert.equal(r.status, 503);
    assert.deepEqual(r.body, { ok: false, error: 'backup scheduler unavailable' });
  });

  it('GET /api/db/backup/status → Zustand des Sicherungsdienstes', async () => {
    const status = { lastRunAt: '2026-10-15T01:00:00Z', lastOk: true };
    const r = await call(mockCtx({ extra: { dbBackupScheduler: { getStatus: () => status } } }), '/api/db/backup/status');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, status });
  });

  it('GET /api/db/timescale/status ohne Telemetrie-Datenbank → 503', async () => {
    const r = await call(mockCtx({ telemetry: { enabled: false } }), '/api/db/timescale/status');
    assert.equal(r.status, 503);
    assert.deepEqual(r.body, { ok: false, error: 'telemetry database disabled' });
  });
});
