// test/admin-rate-limit.test.js
//
// Plan 09-02 (REQ-9.2 admin-rate-limit + REQ-9.2 admin-service-gate):
//
// Verifies the two behaviour changes shipped by Plan 09-02 together:
//
//   1. /api/admin/* is NO LONGER exempt from the global checkRateLimit
//      bucket. The 121st request from a single non-LAN IP within one
//      RATE_LIMIT_WINDOW_MS must return 429 with body { error: 'Too many
//      requests' }.
//
//   2. /api/admin/system/info now honours getServiceActionsEnabled() and
//      returns 403 { ok: false, error: 'service actions disabled' } when
//      the gate is false — the exact wording used by its siblings
//      (/reboot, /update/check, /update/apply).
//
// The tests drive createApiRoutes(ctx) directly and synthesise req/res
// objects (same harness as test/family-routes.test.js). A non-LAN source
// IP (203.0.113.5 — TEST-NET-3) is used so the LAN auth-bypass does NOT
// fire; a Bearer header carrying the configured apiToken authenticates
// the call, which is what allows us to exercise the in-handler gates.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApiRoutes } from '../routes-api.js';

const REMOTE_IP = '203.0.113.5'; // TEST-NET-3 — never resolves to LAN
const API_TOKEN = 'plan-09-02-test-token-xxxxxxxxxxxxxxxxxx'; // ≥ 16 chars (Plan 08-01 startup guard)

function mockRes() {
  const captured = { status: 0, headers: {}, body: '' };
  return {
    writeHead(code, headers) {
      captured.status = code;
      Object.assign(captured.headers, headers);
    },
    end(payload) {
      captured.body = payload;
    },
    _captured: captured,
  };
}

function makeReq(pathname, { method = 'GET', token = API_TOKEN } = {}) {
  const headers = { host: 'dvhub.test' };
  if (token) headers.authorization = `Bearer ${token}`;
  return {
    method,
    url: pathname,
    headers,
    socket: { remoteAddress: REMOTE_IP },
  };
}

function mockCtx({ serviceActionsEnabled = false, apiToken = API_TOKEN } = {}) {
  // Lazy minimal ctx — only the surface that /api/admin/system/info and the
  // pre-handler chain (host allowlist, CORS, rate-limit, auth) actually
  // touch is filled in. Anything else stays unimplemented so a test that
  // accidentally hits a different route fails loudly.
  const cfg = {
    apiToken,
    epex: { enabled: false, timezone: 'Europe/Berlin' },
    optimizer: { enabled: false },
    schedule: { timezone: 'Europe/Berlin' },
    telemetry: { enabled: false },
    family: {},
    gridPositiveMeans: 'grid_import',
    keepalivePulseSec: 30,
    corsAllowedOrigins: [],
    allowedHosts: [], // empty == permissive (LAN-dev shortcut, see Plan 08-04)
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
    getServiceActionsEnabled: () => serviceActionsEnabled,
    getServiceName: () => 'dvhub',
    getServiceUseSudo: () => false,
    runServiceCommand: async () => ({ ok: true }),
    controlValue: () => 'off',
    pushLog: () => {},
    telemetrySafeWrite: () => {},
    needsSetup: () => false,
    epexNowNext: () => null,
    expireLeaseIfNeeded: () => {},
    buildSystemDiscoveryPayload: async () => ({ ok: true }),
  };
}

// Helper: synthesize a request to /api/admin/system/info and drive it through
// handleRequest. Returns the captured response object.
async function callSystemInfo(routes) {
  const req = makeReq('/api/admin/system/info');
  const res = mockRes();
  const url = new URL(req.url, `http://${req.headers.host}`);
  await routes.handleRequest(req, res, url);
  return res._captured;
}

describe('Plan 09-02 admin-service-gate: /api/admin/system/info honours getServiceActionsEnabled', () => {
  it('returns 403 { ok: false, error: "service actions disabled" } when gate is OFF', async () => {
    const ctx = mockCtx({ serviceActionsEnabled: false });
    const routes = createApiRoutes(ctx);
    const captured = await callSystemInfo(routes);
    assert.equal(captured.status, 403, 'must return 403 when service actions disabled');
    const body = JSON.parse(captured.body);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'service actions disabled');
  });

  it('uses byte-identical wording to /api/admin/system/reboot sibling (QUAL-02 backward compat)', async () => {
    // Sanity: the exact 'service actions disabled' string must remain stable
    // so the existing operator-UI 403 handler covers system/info without
    // a UI change. (Same assertion against the source as the integration
    // tests use — see test/integration-endpoints.test.js for the pattern.)
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../routes-api.js', import.meta.url), 'utf8');
    // Locate the system/info handler block (line range chosen by anchoring
    // on the unique handler signature) and inspect the first 200 chars.
    const idx = src.indexOf("url.pathname === '/api/admin/system/info'");
    assert.ok(idx !== -1, 'system/info handler must exist');
    const slice = src.slice(idx, idx + 400);
    assert.match(
      slice,
      /getServiceActionsEnabled\(\)[\s\S]{0,120}'service actions disabled'/,
      'system/info handler must contain getServiceActionsEnabled() gate with sibling-shaped 403'
    );
  });
});

describe('Plan 09-02 admin-rate-limit: /api/admin/* no longer exempt from checkRateLimit', () => {
  it('the 121st request from a single non-LAN IP returns 429 with "Too many requests"', async () => {
    // Gate OFF so each successful trip through the pre-handler chain hits
    // the 403 service-gate branch — we are exercising checkRateLimit, not
    // the body of system/info. The rate-limit decision is taken BEFORE
    // the in-handler gate, so the first 120 calls return 403 (gate fired)
    // and the 121st returns 429 (rate-limit fired).
    const ctx = mockCtx({ serviceActionsEnabled: false });
    const routes = createApiRoutes(ctx);

    let last;
    for (let i = 1; i <= 120; i++) {
      last = await callSystemInfo(routes);
      assert.equal(
        last.status,
        403,
        `request #${i} (within rate-limit window) must return 403 service-gate, got ${last.status}`
      );
      const body = JSON.parse(last.body);
      assert.equal(body.error, 'service actions disabled', `request #${i} body must be the gate 403`);
    }

    // 121st request — rate-limit kicks in BEFORE the handler runs.
    const limited = await callSystemInfo(routes);
    assert.equal(limited.status, 429, 'the 121st request must return 429');
    const limitedBody = JSON.parse(limited.body);
    assert.equal(
      limitedBody.error,
      'Too many requests',
      'rate-limit response body must contain "Too many requests"'
    );
  });

  it('rate-limit applies independently of the service-actions gate (gate ON path still triggers 429)', async () => {
    // With gate ON the handler would attempt to shell out to uptime/hostname/etc
    // — we DO NOT want that in a unit test. So we drive enough sub-handler
    // requests to flip the bucket, then verify the 121st response is 429.
    // The handler interior never runs on the 121st request because the rate
    // limiter short-circuits before it. We use a fresh ctx (and therefore a
    // fresh in-memory rateLimitBuckets Map) so this test's count does not
    // bleed into the previous test.
    const ctx = mockCtx({ serviceActionsEnabled: true });
    const routes = createApiRoutes(ctx);

    // Use the admin token-rotate path (a POST that does not exec child
    // processes regardless of the service-actions gate) to confirm the
    // limit applies to /api/admin/* writes too, not just GETs. We just
    // need 121 calls; the handler-level outcome of each pre-429 call is
    // not what's under test here.
    async function callRotate() {
      const req = makeReq('/api/admin/token/rotate', { method: 'POST' });
      const res = mockRes();
      const url = new URL(req.url, `http://${req.headers.host}`);
      await routes.handleRequest(req, res, url);
      return res._captured;
    }

    for (let i = 1; i <= 120; i++) {
      const r = await callRotate();
      assert.notEqual(r.status, 429, `request #${i} should not yet be rate-limited (got 429 too early)`);
    }
    const limited = await callRotate();
    assert.equal(limited.status, 429, 'the 121st rotate must hit the rate limit');
    const limitedBody = JSON.parse(limited.body);
    assert.equal(limitedBody.error, 'Too many requests');
  });

  it('source-level guard: checkRateLimit no longer contains the /api/admin/* early-return', async () => {
    // Belt-and-braces drift detection. If a future refactor re-introduces
    // the exemption this assertion will catch it without needing a full
    // 121-request driver run.
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../routes-api.js', import.meta.url), 'utf8');
    assert.equal(
      src.includes("if (url.pathname.startsWith('/api/admin/')) return true;"),
      false,
      'checkRateLimit must not exempt /api/admin/* (Plan 09-02 removed this line)'
    );
    assert.ok(
      src.includes('admin endpoints DO get rate-limited'),
      'checkRateLimit must carry the Plan 09-02 comment justifying the change'
    );
  });
});
