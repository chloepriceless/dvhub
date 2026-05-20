// test/inspector-routes.test.js — Phase 19 Plan 19-01 route contract.
//
// Covers all 6 /api/forecast/inspector/* endpoints registered in routes-api.js
// by Plan 19-01. Verifies — auth (Bearer + LAN-bypass), validation (from/to ISO,
// 7-day cap, stage2 date regex), Pro-gating (403 with whitelisted feature slug),
// availability (503 when ctx.inspector is null), error handling (500 on throw),
// and stub-passthrough (501 from B1..B5 not_implemented payload).
//
// Test mode: dispatches routes via createApiRoutes(ctx) + mock req/res.
// Pattern adapted from test/api/integrations-health.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApiRoutes } from '../routes-api.js';

const REMOTE_IP = '203.0.113.5'; // TEST-NET-3 — never resolves to LAN
const LAN_IP = '192.168.1.42';
const API_TOKEN = 'plan-19-01-test-token-xxxxxxxxxxxxxxxx';

function mockRes() {
  const captured = { status: 0, headers: {}, body: '' };
  return {
    writeHead(code, headers) { captured.status = code; Object.assign(captured.headers, headers); },
    end(payload) { captured.body = payload; },
    _captured: captured,
  };
}

function makeReq(pathname, { method = 'GET', token = API_TOKEN, ip = REMOTE_IP } = {}) {
  const headers = { host: 'dvhub.test' };
  if (token) headers.authorization = `Bearer ${token}`;
  return { method, url: pathname, headers, socket: { remoteAddress: ip } };
}

function makeInspectorStub({ overrides = {} } = {}) {
  const def = {
    getPvProviders: async ({ from, to }) => ({ ok: false, error: 'not_implemented', stub: 'b1', window: { from, to } }),
    getLoad: async ({ from, to }) => ({ ok: false, error: 'not_implemented', stub: 'b2', window: { from, to } }),
    getMlCorrection: async ({ from, to }) => ({ ok: false, error: 'not_implemented', stub: 'b3', window: { from, to } }),
    getEos: async ({ from, to }) => ({ ok: false, error: 'not_implemented', stub: 'b4', window: { from, to } }),
    getStage2: async ({ date }) => ({ ok: false, error: 'not_implemented', stub: 'b5', date }),
    getOptimizerCold: async () => ({ lastRunAt: '2026-05-19T10:00:00.000Z', daysSinceLastRun: 1.0, isStale: false, optimizer: 'internal' }),
  };
  return { ...def, ...overrides };
}

function mockCtx({ licenseActive = true, inspector = makeInspectorStub() } = {}) {
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
    notifications: { enabled: false, providers: {} },
    integrations: { tesla: { enabled: false } },
    mqtt: {},
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
    inspector,
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
    licenseService: {
      // Mimic services/license/index.js: requirePro returns true when license active,
      // else writes 403 {error:'pro_required',feature:<whitelisted>} and returns false.
      requirePro(req, res, featureName) {
        const ALLOWED = new Set(['family-dashboard','forecast-inspector-ml','forecast-inspector-eos','forecast-inspector-stage2']);
        const feat = ALLOWED.has(featureName) ? featureName : 'unknown';
        if (licenseActive) return true;
        const body = JSON.stringify({ error: 'pro_required', feature: feat });
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
        res.end(body);
        return false;
      },
      getStatus: () => (licenseActive ? 'active' : 'none'),
    },
  };
}

async function dispatch(ctx, req) {
  const routes = createApiRoutes(ctx);
  const res = mockRes();
  const url = new URL(req.url, `http://${req.headers.host}`);
  await routes.handleRequest(req, res, url);
  return res._captured;
}

// ───────── B6 Optimizer-Cold (the only fully-implemented endpoint) ─────────

test('GET /optimizer-cold — 200 with valid Bearer', async () => {
  const ctx = mockCtx();
  const captured = await dispatch(ctx, makeReq('/api/forecast/inspector/optimizer-cold'));
  assert.equal(captured.status, 200, `body=${captured.body}`);
  const body = JSON.parse(captured.body);
  assert.equal(body.ok, true);
  assert.equal(body.isStale, false);
});

test('GET /optimizer-cold — 200 via LAN bypass without token', async () => {
  const ctx = mockCtx();
  const captured = await dispatch(ctx, makeReq('/api/forecast/inspector/optimizer-cold', { token: null, ip: LAN_IP }));
  assert.equal(captured.status, 200, `body=${captured.body}`);
});

test('GET /optimizer-cold — 401 from external IP without token', async () => {
  const ctx = mockCtx();
  const captured = await dispatch(ctx, makeReq('/api/forecast/inspector/optimizer-cold', { token: null, ip: REMOTE_IP }));
  assert.equal(captured.status, 401, `expected 401, got ${captured.status} body=${captured.body}`);
});

test('GET /optimizer-cold — 503 when ctx.inspector is null', async () => {
  const ctx = mockCtx({ inspector: null });
  const captured = await dispatch(ctx, makeReq('/api/forecast/inspector/optimizer-cold'));
  assert.equal(captured.status, 503);
  const body = JSON.parse(captured.body);
  assert.equal(body.error, 'inspector_unavailable');
});

test('GET /optimizer-cold — 500 when handler throws', async () => {
  const inspector = makeInspectorStub({ overrides: { getOptimizerCold: async () => { throw new Error('boom'); } } });
  const ctx = mockCtx({ inspector });
  const captured = await dispatch(ctx, makeReq('/api/forecast/inspector/optimizer-cold'));
  assert.equal(captured.status, 500);
  const body = JSON.parse(captured.body);
  assert.equal(body.error, 'inspector_failed');
});

// ───────── Window-shaped endpoints (B1, B2) — free + not_implemented stubs ─────────

test('GET /pv-providers — 501 stub passthrough when not_implemented', async () => {
  const ctx = mockCtx();
  const qs = '?from=2026-05-20T00:00:00Z&to=2026-05-21T00:00:00Z';
  const captured = await dispatch(ctx, makeReq('/api/forecast/inspector/pv-providers' + qs));
  assert.equal(captured.status, 501, `body=${captured.body}`);
  const body = JSON.parse(captured.body);
  assert.equal(body.error, 'not_implemented');
});

test('GET /pv-providers — 400 invalid_window on missing params', async () => {
  const ctx = mockCtx();
  const captured = await dispatch(ctx, makeReq('/api/forecast/inspector/pv-providers'));
  assert.equal(captured.status, 400);
  const body = JSON.parse(captured.body);
  assert.equal(body.error, 'invalid_window');
});

test('GET /pv-providers — 400 invalid_window on bad ISO', async () => {
  const ctx = mockCtx();
  const captured = await dispatch(ctx, makeReq('/api/forecast/inspector/pv-providers?from=garbage&to=2026-05-21T00:00:00Z'));
  assert.equal(captured.status, 400);
});

test('GET /pv-providers — 400 invalid_window on span > 7 days', async () => {
  const ctx = mockCtx();
  const captured = await dispatch(ctx, makeReq('/api/forecast/inspector/pv-providers?from=2026-05-01T00:00:00Z&to=2026-05-15T00:00:00Z'));
  assert.equal(captured.status, 400);
  const body = JSON.parse(captured.body);
  assert.equal(body.error, 'invalid_window');
});

test('GET /pv-providers — 503 when ctx.inspector is null', async () => {
  const ctx = mockCtx({ inspector: null });
  const captured = await dispatch(ctx, makeReq('/api/forecast/inspector/pv-providers?from=2026-05-20T00:00:00Z&to=2026-05-21T00:00:00Z'));
  assert.equal(captured.status, 503);
});

test('GET /load — 501 stub passthrough', async () => {
  const ctx = mockCtx();
  const captured = await dispatch(ctx, makeReq('/api/forecast/inspector/load?from=2026-05-20T00:00:00Z&to=2026-05-21T00:00:00Z'));
  assert.equal(captured.status, 501);
});

test('GET /load — 400 invalid_window on missing params', async () => {
  const ctx = mockCtx();
  const captured = await dispatch(ctx, makeReq('/api/forecast/inspector/load'));
  assert.equal(captured.status, 400);
});

// ───────── Pro-gated endpoints (B3, B4, B5) — 403 when license inactive ─────────

test('GET /ml-correction — 403 pro_required when license inactive', async () => {
  const ctx = mockCtx({ licenseActive: false });
  const captured = await dispatch(ctx, makeReq('/api/forecast/inspector/ml-correction?from=2026-05-20T00:00:00Z&to=2026-05-21T00:00:00Z'));
  assert.equal(captured.status, 403, `body=${captured.body}`);
  const body = JSON.parse(captured.body);
  assert.equal(body.error, 'pro_required');
  assert.equal(body.feature, 'forecast-inspector-ml');
});

test('GET /ml-correction — 501 stub when license active', async () => {
  const ctx = mockCtx({ licenseActive: true });
  const captured = await dispatch(ctx, makeReq('/api/forecast/inspector/ml-correction?from=2026-05-20T00:00:00Z&to=2026-05-21T00:00:00Z'));
  assert.equal(captured.status, 501);
});

test('GET /eos — 403 pro_required when license inactive', async () => {
  const ctx = mockCtx({ licenseActive: false });
  const captured = await dispatch(ctx, makeReq('/api/forecast/inspector/eos?from=2026-05-20T00:00:00Z&to=2026-05-21T00:00:00Z'));
  assert.equal(captured.status, 403);
  const body = JSON.parse(captured.body);
  assert.equal(body.feature, 'forecast-inspector-eos');
});

test('GET /eos — 501 stub when license active', async () => {
  const ctx = mockCtx({ licenseActive: true });
  const captured = await dispatch(ctx, makeReq('/api/forecast/inspector/eos?from=2026-05-20T00:00:00Z&to=2026-05-21T00:00:00Z'));
  assert.equal(captured.status, 501);
});

test('GET /stage2 — 403 pro_required when license inactive', async () => {
  const ctx = mockCtx({ licenseActive: false });
  // Use yesterday's date so the date-range check would otherwise pass.
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const captured = await dispatch(ctx, makeReq('/api/forecast/inspector/stage2?date=' + yesterday));
  assert.equal(captured.status, 403);
  const body = JSON.parse(captured.body);
  assert.equal(body.feature, 'forecast-inspector-stage2');
});

test('GET /stage2 — 400 invalid_date on bad format', async () => {
  const ctx = mockCtx({ licenseActive: true });
  const captured = await dispatch(ctx, makeReq('/api/forecast/inspector/stage2?date=garbage'));
  assert.equal(captured.status, 400);
  const body = JSON.parse(captured.body);
  assert.equal(body.error, 'invalid_date');
});

test('GET /stage2 — 400 invalid_date on out-of-retention date (>30 days old)', async () => {
  const ctx = mockCtx({ licenseActive: true });
  const captured = await dispatch(ctx, makeReq('/api/forecast/inspector/stage2?date=2020-01-01'));
  assert.equal(captured.status, 400);
});

test('GET /stage2 — 501 stub when license active and date valid', async () => {
  const ctx = mockCtx({ licenseActive: true });
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const captured = await dispatch(ctx, makeReq('/api/forecast/inspector/stage2?date=' + yesterday));
  assert.equal(captured.status, 501, `body=${captured.body}`);
});
