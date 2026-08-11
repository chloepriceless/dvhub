// test/admin-health.test.js
//
// Plan 09-06 (REQ-9.6 health-detail):
//
// Verifies the additive latencyMs / lastSuccessAt / lastErrorAt fields on
// every checks[] entry of /api/admin/health. QUAL-02 backward compat:
// the existing id/label/ok/detail fields stay present on every check.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApiRoutes } from '../routes-api.js';

const LAN_IP = '192.168.1.5';
const API_TOKEN = 'plan-09-06-test-token-xxxxxxxxxxxxxxxxxx';

function mockRes() {
  const captured = { status: 0, headers: {}, body: '' };
  return {
    writeHead(code, headers) { captured.status = code; Object.assign(captured.headers, headers); },
    end(payload) { captured.body = payload; },
    _captured: captured,
  };
}

function makeReq(pathname, { method = 'GET', token = API_TOKEN, ip = LAN_IP } = {}) {
  const headers = { host: 'dvhub.test' };
  if (token) headers.authorization = `Bearer ${token}`;
  return { method, url: pathname, headers, socket: { remoteAddress: ip } };
}

function mockCtx() {
  const cfg = {
    apiToken: API_TOKEN,
    epex: { enabled: false, timezone: 'Europe/Berlin' },
    optimizer: { enabled: false },
    schedule: { timezone: 'Europe/Berlin' },
    telemetry: { enabled: false },
    family: {},
    gridPositiveMeans: 'grid_import',
    keepalivePulseSec: 30,
    corsAllowedOrigins: [],
    allowedHosts: [],
  };
  return {
    state: {
      meter: { ok: true, updatedAt: Date.now(), grid_total_w: 100 },
      victron: { soc: 50, batteryPowerW: 0, pvTotalW: 0, updatedAt: 0 },
      epex: { ok: false, data: [], updatedAt: 0 },
      energy: { day: null, importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0 },
      telemetry: { enabled: false, ok: false, dbPath: null, lastError: null, lastWriteAt: 0 },
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
    runServiceCommand: async () => ({ ok: true, stdout: 'active' }),
    controlValue: () => 'off',
    pushLog: () => {},
    telemetrySafeWrite: () => {},
    needsSetup: () => false,
    epexNowNext: () => null,
    expireLeaseIfNeeded: () => {},
    buildSystemDiscoveryPayload: async () => ({ ok: true }),
  };
}

async function fetchHealth(ctx) {
  const routes = createApiRoutes(ctx);
  const req = makeReq('/api/admin/health');
  const res = mockRes();
  const url = new URL(req.url, `http://${req.headers.host}`);
  await routes.handleRequest(req, res, url);
  return res._captured;
}

describe('Plan 09-06 admin-health: latencyMs / lastSuccessAt / lastErrorAt per check', () => {
  it('GET /api/admin/health returns checks[] with new latencyMs / lastSuccessAt / lastErrorAt keys per entry', async () => {
    const ctx = mockCtx();
    const captured = await fetchHealth(ctx);
    assert.equal(captured.status, 200, `expected 200, got ${captured.status} body=${captured.body}`);
    const body = JSON.parse(captured.body);
    assert.ok(Array.isArray(body.checks), 'body.checks must be an array');
    assert.ok(body.checks.length >= 4, `expected at least 4 checks, got ${body.checks.length}`);
    for (const entry of body.checks) {
      assert.equal(typeof entry.latencyMs, 'number', `check ${entry.id} latencyMs must be number`);
      assert.ok(entry.latencyMs >= 0, `check ${entry.id} latencyMs must be ≥ 0`);
      assert.ok(
        typeof entry.lastSuccessAt === 'string' || entry.lastSuccessAt === null,
        `check ${entry.id} lastSuccessAt must be ISO string or null (got ${typeof entry.lastSuccessAt})`
      );
      assert.ok(
        typeof entry.lastErrorAt === 'string' || entry.lastErrorAt === null,
        `check ${entry.id} lastErrorAt must be ISO string or null (got ${typeof entry.lastErrorAt})`
      );
      // ISO timestamps must parse to a valid Date.
      if (entry.lastSuccessAt) assert.ok(!Number.isNaN(Date.parse(entry.lastSuccessAt)), 'lastSuccessAt must parse');
      if (entry.lastErrorAt) assert.ok(!Number.isNaN(Date.parse(entry.lastErrorAt)), 'lastErrorAt must parse');
    }
  });

  it('QUAL-02: pre-existing keys (id, label, ok, detail) still present in every check', async () => {
    const ctx = mockCtx();
    const captured = await fetchHealth(ctx);
    const body = JSON.parse(captured.body);
    for (const entry of body.checks) {
      assert.equal(typeof entry.id, 'string', `check missing id (got ${JSON.stringify(entry)})`);
      assert.equal(typeof entry.label, 'string', `check ${entry.id} missing label`);
      assert.equal(typeof entry.ok, 'boolean', `check ${entry.id} missing ok`);
      assert.equal(typeof entry.detail, 'string', `check ${entry.id} missing detail`);
    }
  });

  it('meter check populates lastSuccessAt as an ISO string when state.meter.ok=true', async () => {
    const ctx = mockCtx();
    const captured = await fetchHealth(ctx);
    const body = JSON.parse(captured.body);
    const meter = body.checks.find((c) => c.id === 'meter');
    assert.ok(meter, 'meter check must exist');
    assert.equal(meter.ok, true);
    assert.equal(typeof meter.lastSuccessAt, 'string', 'meter lastSuccessAt must be ISO string when ok');
    assert.equal(meter.lastErrorAt, null, 'meter lastErrorAt must be null when ok');
  });
});
