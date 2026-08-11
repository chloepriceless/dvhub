// test/license-kwp-config-warning.test.js
//
// T-LICENSE-KWP-GATING Increment 4: the POST /api/config success response
// carries a NON-BLOCKING `licenseCapWarning` when the (now-applied) configured
// PV kWp exceeds the licensed tier ceiling (license.max_kwp). The save itself
// is NEVER blocked — the operator may enter their real plant; the warning only
// nudges an upgrade and explains that display/forecast/EOS are capped.
//
// Community / Pro L / legacy keys carry max_kwp==null → no warning (fail-open).
//
// Harness mirrors test/legal-gate-flip-route.test.js (drives createApiRoutes(ctx)
// directly) and adds a mock licenseService.getState().

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createApiRoutes } from '../routes-api.js';

const REMOTE_IP = '203.0.113.5';
const API_TOKEN = crypto.randomBytes(32).toString('hex');

function mockRes() {
  const captured = { status: 0, headers: {}, body: '' };
  return {
    writeHead(code, headers) { captured.status = code; Object.assign(captured.headers, headers); },
    end(payload) { captured.body = payload; },
    _captured: captured,
  };
}

function makeReq(pathname, { method = 'GET', token = API_TOKEN, body = null, extraHeaders = {} } = {}) {
  const bodyBuf = body != null ? Buffer.from(JSON.stringify(body)) : null;
  const stream = Readable.from(bodyBuf ? [bodyBuf] : []);
  stream.method = method;
  stream.url = pathname;
  stream.headers = { host: 'dvhub.test', ...extraHeaders };
  if (token) stream.headers.authorization = `Bearer ${token}`;
  if (body != null) stream.headers['content-type'] = 'application/json';
  stream.socket = { remoteAddress: REMOTE_IP };
  return stream;
}

// licenseState: { max_kwp, system_kwp } returned by licenseService.getState().
// Pass null to omit licenseService entirely (Community-style, no cap logic).
function mockCtx({ licenseState = null } = {}) {
  const cfg = {
    apiToken: API_TOKEN,
    apiTokenSessionTtlMs: null,
    epex: { enabled: false, timezone: 'Europe/Berlin' },
    optimizer: { enabled: false },
    schedule: { timezone: 'Europe/Berlin' },
    telemetry: { enabled: false },
    family: {},
    userEnergyPricing: { pvPlants: [] },
    gridPositiveMeans: 'grid_import',
    keepalivePulseSec: 30,
    corsAllowedOrigins: [],
    allowedHosts: [],
  };
  const ctx = {
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
    getServiceName: () => 'dvhub.service',
    getServiceUseSudo: () => false,
    runServiceCommand: async () => ({ ok: true }),
    controlValue: () => 'off',
    pushLog: () => {},
    telemetrySafeWrite: () => {},
    needsSetup: () => false,
    epexNowNext: () => null,
    expireLeaseIfNeeded: () => {},
    buildSystemDiscoveryPayload: async () => ({ ok: true }),
    saveAndApplyConfig: (incoming) => {
      Object.assign(cfg, incoming);
      return { ok: true, changedPaths: [], restartRequired: false, restartRequiredPaths: [], loadedConfig: { exists: true, valid: true } };
    },
  };
  if (licenseState) {
    ctx.licenseService = {
      getState: () => ({ status: 'active', ...licenseState }),
    };
  }
  return ctx;
}

async function dispatch(routes, req) {
  const res = mockRes();
  const url = new URL(req.url, `http://${req.headers.host}`);
  await routes.handleRequest(req, res, url);
  return res._captured;
}

function savePvPlants(ctx, pvPlants) {
  const routes = createApiRoutes(ctx);
  return dispatch(routes, makeReq('/api/config', {
    method: 'POST',
    body: { config: { userEnergyPricing: { pvPlants } } },
  }));
}

describe('POST /api/config — Lizenz-kWp Increment 4 (nicht-blockierende Warnung)', () => {
  it('warns when the applied PV kWp exceeds the licensed tier (Pro S = 50)', async () => {
    const ctx = mockCtx({ licenseState: { max_kwp: 50, system_kwp: 85 } });
    const captured = await savePvPlants(ctx, [{ kwp: 60, commissionedAt: '2022-01-01' }, { kwp: 25, commissionedAt: '2022-01-01' }]);
    assert.equal(captured.status, 200, captured.body);
    const body = JSON.parse(captured.body);
    assert.equal(body.ok, true);
    assert.ok(body.licenseCapWarning, 'licenseCapWarning must be present');
    assert.equal(body.licenseCapWarning.maxKwp, 50);
    assert.equal(body.licenseCapWarning.systemKwp, 85);
    assert.match(body.licenseCapWarning.message, /50 kWp/);
    assert.match(body.licenseCapWarning.message, /gekappt/i);
  });

  it('no warning when the plant fits the tier (system_kwp <= max_kwp)', async () => {
    const ctx = mockCtx({ licenseState: { max_kwp: 50, system_kwp: 40 } });
    const captured = await savePvPlants(ctx, [{ kwp: 40, commissionedAt: '2022-01-01' }]);
    assert.equal(captured.status, 200, captured.body);
    const body = JSON.parse(captured.body);
    assert.equal(body.licenseCapWarning, null);
  });

  it('no warning for Community/Pro L/legacy (max_kwp == null, fail-open)', async () => {
    const ctx = mockCtx({ licenseState: { max_kwp: null, system_kwp: 200 } });
    const captured = await savePvPlants(ctx, [{ kwp: 200, commissionedAt: '2022-01-01' }]);
    assert.equal(captured.status, 200, captured.body);
    const body = JSON.parse(captured.body);
    assert.equal(body.licenseCapWarning, null);
  });

  it('no warning and no crash when licenseService is absent (backward compatible)', async () => {
    const ctx = mockCtx({ licenseState: null });
    const captured = await savePvPlants(ctx, [{ kwp: 200, commissionedAt: '2022-01-01' }]);
    assert.equal(captured.status, 200, captured.body);
    const body = JSON.parse(captured.body);
    assert.equal(body.licenseCapWarning, null);
  });
});
