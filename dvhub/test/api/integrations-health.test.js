// test/api/integrations-health.test.js
//
// Plan 09.2-04 Wave-0 (RED) — endpoint contract tests for the new
// GET /api/integrations/health route.
//
// CONTEXT.md decisions verified by this file:
//   D-15 spirit / T-09.2-AUTHZ: /api/integrations/health is NOT in
//     LAN_SAFE_ENDPOINTS — Bearer auth required from any source. Tested
//     with REMOTE_IP (TEST-NET-3) so the LAN auth-bypass cannot mask a
//     missing-auth regression.
//   D-17 revised: per-system shape with latencyMs, uptimeSec, errors24h,
//     lastSampleAt, sampleIntervalHistogramMs, firmware, status fields.
//   D-18: 5-second in-memory cache. Two requests within the TTL share the
//     same payload (verified by injecting a snapshot fn whose return value
//     mutates per call — second call must return the first call's value).
//   D-19 revised: Featured-Row is Victron-only. The response.featured
//     object MUST contain `victronHeartbeatSec` + `victronEssMode` and
//     MUST NOT contain LUOX hero fields (luoxRevenueTodayEur, bidsToday,
//     dvExcessLifetimeEur, luoxActiveSinceDays — dv_bids does not exist).
//
// Test mode: invokes the routes-api dispatch handler directly via mocked
// req/res (admin-health.test.js pattern). No live HTTP server, no DB.
// The healthTracker is a stub on ctx; the cache is a closure inside
// createApiRoutes(ctx), so each test creates a fresh routes instance to
// isolate cache state.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApiRoutes } from '../../routes-api.js';

const REMOTE_IP = '203.0.113.5'; // TEST-NET-3 — never resolves to LAN
const API_TOKEN = 'plan-09-2-04-test-token-xxxxxxxxxxxxxxxx';

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

function makeTrackerSnapshot() {
  const now = Date.now();
  return {
    victron: {
      latencyMs: 12,
      uptimeSec: 100,
      errors24h: 0,
      lastSampleAt: new Date(now - 1000).toISOString(),
      sampleIntervalHistogramMs: [3000, 3010, 2990, 3005, 3000, 3015, 2995],
      firmware: '3.42',
      status: 'ok',
    },
    mqtt: {
      latencyMs: 5,
      uptimeSec: 100,
      errors24h: 1,
      lastSampleAt: new Date(now - 5000).toISOString(),
      sampleIntervalHistogramMs: [5000, 5010, 4990],
      firmware: null,
      status: 'ok',
    },
  };
}

function mockCtx({ snapshotFn = makeTrackerSnapshot, essMode = 'active' } = {}) {
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
      meter: { ok: true, updatedAt: Date.now(), grid_total_w: 100, essMode },
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
    healthTracker: {
      snapshot: () => snapshotFn(),
      recordSample: () => {},
      persistSnapshot: async () => {},
      loadSnapshot: async () => {},
      close: () => {},
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

describe('GET /api/integrations/health', () => {
  it('returns 401 without Bearer token (NOT in LAN_SAFE_ENDPOINTS)', async () => {
    const ctx = mockCtx();
    const req = makeReq('/api/integrations/health', { token: null });
    const captured = await dispatch(ctx, req);
    assert.equal(
      captured.status,
      401,
      `expected 401 from external IP without token, got ${captured.status} body=${captured.body}`
    );
  });

  it('returns 200 with valid Bearer token', async () => {
    const ctx = mockCtx();
    const req = makeReq('/api/integrations/health');
    const captured = await dispatch(ctx, req);
    assert.equal(captured.status, 200, `expected 200, got ${captured.status} body=${captured.body}`);
    const ct = captured.headers['content-type'] || '';
    assert.match(ct, /application\/json/, `expected JSON content-type, got "${ct}"`);
  });

  it('per-system shape includes all expected fields', async () => {
    const ctx = mockCtx();
    const req = makeReq('/api/integrations/health');
    const captured = await dispatch(ctx, req);
    const body = JSON.parse(captured.body);
    for (const sys of ['victron', 'mqtt']) {
      assert.ok(body[sys], `expected ${sys} key in payload`);
      for (const f of [
        'latencyMs', 'uptimeSec', 'errors24h',
        'lastSampleAt', 'sampleIntervalHistogramMs', 'firmware', 'status',
      ]) {
        assert.ok(f in body[sys], `${sys} missing field "${f}"`);
      }
    }
  });

  it('status field is one of ok|warn|err for every per-system entry', async () => {
    const ctx = mockCtx();
    const req = makeReq('/api/integrations/health');
    const captured = await dispatch(ctx, req);
    const body = JSON.parse(captured.body);
    for (const k of Object.keys(body)) {
      if (k === 'featured') continue;
      const status = body[k].status;
      assert.ok(
        ['ok', 'warn', 'err'].includes(status),
        `system "${k}" has invalid status "${status}" (expected ok|warn|err)`
      );
    }
  });

  it('featured is Victron-only — D-19 revised (no LUOX hero fields)', async () => {
    const ctx = mockCtx();
    const req = makeReq('/api/integrations/health');
    const captured = await dispatch(ctx, req);
    const body = JSON.parse(captured.body);
    assert.ok(body.featured, 'expected featured key in payload');
    assert.ok('victronHeartbeatSec' in body.featured, 'featured must contain victronHeartbeatSec');
    assert.ok('victronEssMode' in body.featured, 'featured must contain victronEssMode');
    // D-19 revised: dv_bids does not exist; LUOX hero card dropped.
    for (const forbidden of [
      'luoxRevenueTodayEur',
      'bidsToday',
      'dvExcessLifetimeEur',
      'luoxActiveSinceDays',
    ]) {
      assert.ok(
        !(forbidden in body.featured),
        `featured MUST NOT contain "${forbidden}" (D-19 revised — dv_bids has no source data)`
      );
    }
    // Sanity: the heartbeat is derived from victron.lastSampleAt → must be a small number.
    assert.equal(typeof body.featured.victronHeartbeatSec, 'number');
    assert.ok(body.featured.victronHeartbeatSec >= 0 && body.featured.victronHeartbeatSec < 60);
  });

  it('caches response for 5 seconds (D-18) — two consecutive calls share payload', async () => {
    let i = 0;
    const dynamicSnap = () => {
      i++;
      return {
        victron: {
          ...makeTrackerSnapshot().victron,
          // Mutate latencyMs per call so a cache miss is observable.
          latencyMs: 100 + i,
        },
      };
    };
    const ctx = mockCtx({ snapshotFn: dynamicSnap });
    // CRITICAL: the cache lives inside the routes closure, so we MUST reuse the
    // same routes instance across both calls (a fresh createApiRoutes() would
    // start with an empty cache and never observe a hit).
    const routes = createApiRoutes(ctx);
    async function call() {
      const req = makeReq('/api/integrations/health');
      const res = mockRes();
      const url = new URL(req.url, `http://${req.headers.host}`);
      await routes.handleRequest(req, res, url);
      return res._captured;
    }
    const r1 = JSON.parse((await call()).body);
    const r2 = JSON.parse((await call()).body);
    assert.equal(
      r1.victron.latencyMs,
      r2.victron.latencyMs,
      `second request should hit cache (got r1=${r1.victron.latencyMs}, r2=${r2.victron.latencyMs})`
    );
    assert.equal(i, 1, `tracker.snapshot() should have been invoked exactly once for two cached calls, got ${i}`);
  });
});
