// test/security-headers.test.js
//
// Plan 09-09 (REQ-9.9 defence-in-depth headers):
//
// Verifies the additive header polish on top of Plan 08-05's SECURITY_HEADERS.
// Asserts the response of GET /api/status (a LAN-safe endpoint) carries:
//
//   - Permissions-Policy disabling sensor APIs (accelerometer, camera,
//     geolocation, gyroscope, magnetometer, microphone, payment, usb)
//   - Cross-Origin-Opener-Policy: same-origin
//   - Cross-Origin-Resource-Policy: same-origin
//   - Referrer-Policy: no-referrer            (regression check vs. 08-05)
//   - Strict-Transport-Security: max-age=...  (regression check vs. 08-05)
//   - X-Frame-Options: DENY                   (regression check vs. 08-05)
//
// Source-level assertion: routes-api.js carries the cookie-policy contract
// comment string `HttpOnly; Secure; SameSite=Strict` (the literal
// requirement any future Set-Cookie must satisfy).
//
// Harness pattern: createApiRoutes(ctx) driven directly with synthesized
// req/res — identical to test/admin-rate-limit.test.js and
// test/family-routes.test.js. No HTTP server spin-up.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApiRoutes } from '../routes-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_API_PATH = path.resolve(__dirname, '..', 'routes-api.js');

function mockRes() {
  const captured = { status: 0, headers: {}, body: '' };
  return {
    writeHead(code, headers) {
      captured.status = code;
      Object.assign(captured.headers, headers);
    },
    end(payload) { captured.body = payload; },
    _captured: captured
  };
}

function mockCtx() {
  // Minimal ctx surface for the /api/status handler (which calls
  // buildApiStatusResponse → buildWorkerBackedStatusResponse on the
  // cached/fallback/runtime payloads + configMetaPayload). Anything else
  // stays unimplemented so an accidentally-hit route fails loudly.
  const cfg = {
    apiToken: '',
    epex: { enabled: false, timezone: 'Europe/Berlin' },
    optimizer: { enabled: false },
    schedule: { timezone: 'Europe/Berlin' },
    telemetry: { enabled: false },
    family: {},
    gridPositiveMeans: 'grid_import',
    keepalivePulseSec: 30,
    corsAllowedOrigins: [],
    allowedHosts: [] // empty == permissive (LAN-dev shortcut, Plan 08-04)
  };
  return {
    state: {
      meter: { ok: false, updatedAt: 0, raw: [], grid_l1_w: 0, grid_l2_w: 0, grid_l3_w: 0, grid_total_w: 0 },
      victron: { soc: 50, batteryPowerW: 0, pvTotalW: 0, gridImportW: 0, gridExportW: 0, updatedAt: 0 },
      epex: { ok: false, data: [] },
      energy: { day: null, importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0 },
      telemetry: { enabled: false, dbPath: null, ok: false },
      keepalive: { modbusLastQuery: null, appPulse: { periodSec: 30 } },
      schedule: { rules: [], config: {}, active: {}, lastWrite: {}, manualOverride: {}, lastEvalAt: 0 },
      ctrl: { forcedOff: false, offUntil: 0, lastSignal: 'init', updatedAt: 0, dvControl: null },
      dvRegs: { 0: 0, 1: 0, 3: 0, 4: 0 },
      log: [],
      forecast: null
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
    getCachedRuntimeStatusPayload: () => null,
    buildRuntimeRouteMeta: () => ({ ready: true, busy: false, queueDepth: 0 }),
    buildFallbackStatusPayload: () => ({
      victron: { pvTotalW: 0, batteryPowerW: 0, soc: 50 },
      meter: { grid_total_w: 0 },
      epex: { ok: false, data: [] },
      costs: { netEur: 0, costEur: 0, revenueEur: 0 }
    }),
    buildSystemDiscoveryPayload: async () => ({ ok: true })
  };
}

async function callStatus(routes, { remoteAddress = '127.0.0.1' } = {}) {
  const req = {
    method: 'GET',
    url: '/api/status',
    headers: { host: 'dvhub.test' },
    socket: { remoteAddress }
  };
  const res = mockRes();
  const url = new URL(req.url, `http://${req.headers.host}`);
  await routes.handleRequest(req, res, url);
  return res._captured;
}

// Header name lookup is case-insensitive in Node's http response API.
// SECURITY_HEADERS uses canonical-case keys ('Permissions-Policy', ...),
// but the mock writeHead just stores them verbatim. To keep the assertions
// robust against either casing in future refactors, search case-insensitively.
function findHeader(headers, name) {
  const target = String(name).toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === target) return v;
  }
  return undefined;
}

describe('Plan 09-09 defence-in-depth headers: GET /api/status response', () => {
  it('returns 200 (LAN-safe endpoint)', async () => {
    const routes = createApiRoutes(mockCtx());
    const captured = await callStatus(routes);
    assert.equal(captured.status, 200, `expected 200, got ${captured.status}: ${captured.body}`);
  });

  it('carries Permissions-Policy disabling sensor APIs (8 directives)', async () => {
    const routes = createApiRoutes(mockCtx());
    const captured = await callStatus(routes);
    const pp = findHeader(captured.headers, 'Permissions-Policy');
    assert.ok(pp, 'Permissions-Policy header must be present');
    for (const directive of [
      'accelerometer=()',
      'camera=()',
      'geolocation=()',
      'gyroscope=()',
      'magnetometer=()',
      'microphone=()',
      'payment=()',
      'usb=()'
    ]) {
      assert.ok(
        pp.includes(directive),
        `Permissions-Policy must include "${directive}", got: ${pp}`
      );
    }
  });

  it('carries Cross-Origin-Opener-Policy: same-origin', async () => {
    const routes = createApiRoutes(mockCtx());
    const captured = await callStatus(routes);
    const coop = findHeader(captured.headers, 'Cross-Origin-Opener-Policy');
    assert.equal(coop, 'same-origin', `expected same-origin, got ${coop}`);
  });

  it('carries Cross-Origin-Resource-Policy: same-origin', async () => {
    const routes = createApiRoutes(mockCtx());
    const captured = await callStatus(routes);
    const corp = findHeader(captured.headers, 'Cross-Origin-Resource-Policy');
    assert.equal(corp, 'same-origin', `expected same-origin, got ${corp}`);
  });

  // ── Regression checks: Plan 08-05 headers MUST stay intact ────────────

  it('regression: Referrer-Policy: no-referrer is still set (08-05)', async () => {
    const routes = createApiRoutes(mockCtx());
    const captured = await callStatus(routes);
    const rp = findHeader(captured.headers, 'Referrer-Policy');
    assert.equal(rp, 'no-referrer', `08-05 Referrer-Policy must remain, got ${rp}`);
  });

  it('regression: Strict-Transport-Security with max-age + includeSubDomains is still set (08-05)', async () => {
    const routes = createApiRoutes(mockCtx());
    const captured = await callStatus(routes);
    const hsts = findHeader(captured.headers, 'Strict-Transport-Security');
    assert.equal(
      hsts,
      'max-age=31536000; includeSubDomains',
      `08-05 HSTS must remain unchanged, got ${hsts}`
    );
  });

  it('regression: X-Frame-Options: DENY is still set (08-05)', async () => {
    const routes = createApiRoutes(mockCtx());
    const captured = await callStatus(routes);
    const xfo = findHeader(captured.headers, 'X-Frame-Options');
    assert.equal(xfo, 'DENY', `08-05 X-Frame-Options must remain, got ${xfo}`);
  });
});

// ── Source-level cookie-policy contract assertion ──────────────────────

describe('Plan 09-09 cookie-policy contract (source-level)', () => {
  it('SECURITY_HEADERS comment block declares HttpOnly; Secure; SameSite=Strict', () => {
    const src = fs.readFileSync(ROUTES_API_PATH, 'utf8');
    // Case-insensitive contains-match per the plan's instruction
    // ("verbatim or close — case-insensitive contains match").
    assert.match(
      src,
      /HttpOnly;\s*Secure;\s*SameSite=Strict/i,
      'routes-api.js must contain the cookie-policy contract string'
    );
  });

  it('SECURITY_HEADERS contains a Permissions-Policy directive (source check)', () => {
    const src = fs.readFileSync(ROUTES_API_PATH, 'utf8');
    assert.match(src, /'Permissions-Policy':/);
    assert.match(src, /accelerometer=\(\)/);
  });

  it('SECURITY_HEADERS contains COOP same-origin (source check)', () => {
    const src = fs.readFileSync(ROUTES_API_PATH, 'utf8');
    assert.match(src, /'Cross-Origin-Opener-Policy':\s*'same-origin'/);
  });

  it('SECURITY_HEADERS contains CORP same-origin (source check)', () => {
    const src = fs.readFileSync(ROUTES_API_PATH, 'utf8');
    assert.match(src, /'Cross-Origin-Resource-Policy':\s*'same-origin'/);
  });
});
