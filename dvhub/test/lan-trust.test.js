// test/lan-trust.test.js
//
// Go-Live-Review 2026-06-10 (Christin): operator-selectable LAN-trust posture.
//
// Verifies cfg.security.lanTrust drives checkAuth's LAN bypass:
//   - 'open'       — any LAN client bypasses the token (default / backward compat)
//   - 'restricted' — LAN bypass ONLY for GET endpoints whose group is enabled in
//                    security.lanSafeGroups; other endpoints need a Bearer token
//   - 'strict'     — no LAN bypass; only 127.0.0.1 (loopback) is trusted
// Plus the security.lanCidrs / trustedClientIps narrowing and the pure
// ipMatchesCidr helper.
//
// Drives createApiRoutes(ctx) + synthesised req/res, same harness as
// test/admin-rate-limit.test.js.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApiRoutes, ipMatchesCidr } from '../routes-api.js';

const API_TOKEN = 'lan-trust-test-token-xxxxxxxxxxxxxxxxxx'; // ≥16 chars (startup guard)
const LAN_IP = '192.168.1.66';
const REMOTE_IP = '203.0.113.5'; // TEST-NET-3 — never LAN
const LOOPBACK = '127.0.0.1';

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

function makeReq(pathname, { method = 'GET', token = null, ip = LAN_IP } = {}) {
  const headers = { host: 'dvhub.test' };
  if (token) headers.authorization = `Bearer ${token}`;
  return { method, url: pathname, headers, socket: { remoteAddress: ip } };
}

function mockCtx(security) {
  const cfg = {
    apiToken: API_TOKEN,
    epex: { enabled: false, timezone: 'Europe/Berlin', bzn: 'DE-LU' },
    optimizer: { enabled: false },
    schedule: { timezone: 'Europe/Berlin', rules: [] },
    telemetry: { enabled: false },
    family: {},
    gridPositiveMeans: 'grid_import',
    keepalivePulseSec: 30,
    corsAllowedOrigins: [],
    allowedHosts: [],
    security,
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
  };
}

// Status code of /api/keepalive/pulse (group 'status', GET, minimal handler) for
// a given (security, ip, token). Chosen over /api/status because its handler has
// the smallest ctx surface — we are testing the AUTH gate, not the payload.
async function statusCode(security, reqOpts) {
  const ctx = mockCtx(security);
  const routes = createApiRoutes(ctx);
  const req = makeReq('/api/keepalive/pulse', reqOpts);
  const res = mockRes();
  const url = new URL(req.url, `http://${req.headers.host}`);
  await routes.handleRequest(req, res, url);
  return res._captured.status;
}

// Status code of an admin write (group: none → conservative) — should require
// auth under restricted/strict. We use /api/admin/system/info (GET) which is NOT
// in any LAN-safe group, so under restricted it must demand a Bearer token.
async function adminCode(security, reqOpts) {
  const ctx = mockCtx(security);
  const routes = createApiRoutes(ctx);
  const req = makeReq('/api/admin/system/info', reqOpts);
  const res = mockRes();
  const url = new URL(req.url, `http://${req.headers.host}`);
  await routes.handleRequest(req, res, url);
  return res._captured.status;
}

describe('LAN-trust: lanTrust posture drives the LAN auth bypass', () => {
  it("'open' (default): LAN client reaches /api/status without a token", async () => {
    const code = await statusCode({ lanTrust: 'open', lanSafeGroups: [] }, { ip: LAN_IP });
    assert.equal(code, 200, 'open mode must let any LAN client through token-free');
  });

  it("absent security block behaves like 'open' (backward compat)", async () => {
    const code = await statusCode(undefined, { ip: LAN_IP });
    assert.equal(code, 200, 'no security block → blanket LAN bypass (legacy)');
  });

  it("'restricted' + group enabled: LAN GET to an enabled group passes", async () => {
    const code = await statusCode({ lanTrust: 'restricted', lanSafeGroups: ['status'] }, { ip: LAN_IP });
    assert.equal(code, 200, 'restricted must allow LAN GET when its group is enabled');
  });

  it("'restricted' + group NOT enabled: LAN GET is rejected (401)", async () => {
    const code = await statusCode({ lanTrust: 'restricted', lanSafeGroups: ['dashboard'] }, { ip: LAN_IP });
    assert.equal(code, 401, 'restricted must reject LAN GET when its group is disabled');
  });

  it("'restricted': admin endpoint (no group) requires Bearer even on LAN", async () => {
    const noTok = await adminCode({ lanTrust: 'restricted', lanSafeGroups: ['status', 'dashboard', 'history', 'forecast', 'integrations'] }, { ip: LAN_IP });
    assert.equal(noTok, 401, 'admin write must demand a token under restricted, even from LAN');
    const withTok = await adminCode({ lanTrust: 'restricted', lanSafeGroups: ['status'] }, { ip: LAN_IP, token: API_TOKEN });
    assert.notEqual(withTok, 401, 'a valid Bearer token must pass the gate under restricted');
  });

  it("'strict': LAN client is rejected without a token", async () => {
    const code = await statusCode({ lanTrust: 'strict', lanSafeGroups: ['status'] }, { ip: LAN_IP });
    assert.equal(code, 401, 'strict must reject any non-loopback client without a token');
  });

  it("'strict': loopback (the box itself) still bypasses", async () => {
    const code = await statusCode({ lanTrust: 'strict', lanSafeGroups: [] }, { ip: LOOPBACK });
    assert.equal(code, 200, 'loopback is always trusted (internal calls / on-box kiosk)');
  });

  it("'strict': a valid Bearer token still works from the LAN", async () => {
    const code = await statusCode({ lanTrust: 'strict', lanSafeGroups: [] }, { ip: LAN_IP, token: API_TOKEN });
    assert.equal(code, 200, 'strict still honours a correct Bearer token');
  });

  it('external (non-LAN) client is rejected under open just as before', async () => {
    const code = await statusCode({ lanTrust: 'open', lanSafeGroups: [] }, { ip: REMOTE_IP });
    assert.equal(code, 401, 'external client without token is always rejected');
  });
});

describe('LAN-trust: lanCidrs / trustedClientIps narrowing', () => {
  it('lanCidrs restricts which addresses count as LAN', async () => {
    // Only 192.168.99.0/24 is LAN → our 192.168.1.66 is NOT LAN → 401 under open.
    const outside = await statusCode({ lanTrust: 'open', lanCidrs: ['192.168.99.0/24'] }, { ip: LAN_IP });
    assert.equal(outside, 401, 'a LAN ip outside the configured CIDR must not bypass');
    const inside = await statusCode({ lanTrust: 'open', lanCidrs: ['192.168.1.0/24'] }, { ip: LAN_IP });
    assert.equal(inside, 200, 'a LAN ip inside the configured CIDR bypasses under open');
  });

  it('trustedClientIps is an explicit per-device allowlist on top of the range', async () => {
    const blocked = await statusCode({ lanTrust: 'open', trustedClientIps: ['192.168.1.99'] }, { ip: LAN_IP });
    assert.equal(blocked, 401, 'a LAN ip not on trustedClientIps must not bypass');
    const allowed = await statusCode({ lanTrust: 'open', trustedClientIps: ['192.168.1.66'] }, { ip: LAN_IP });
    assert.equal(allowed, 200, 'a LAN ip on trustedClientIps bypasses');
  });
});

describe('ipMatchesCidr (pure)', () => {
  it('matches IPv4 ranges bit-exact', () => {
    assert.equal(ipMatchesCidr('192.168.1.66', '192.168.1.0/24'), true);
    assert.equal(ipMatchesCidr('192.168.1.5', '192.168.1.0/24'), false);
    assert.equal(ipMatchesCidr('10.1.2.3', '10.0.0.0/8'), true);
    assert.equal(ipMatchesCidr('172.20.5.5', '172.16.0.0/12'), true);
    assert.equal(ipMatchesCidr('8.8.8.8', '192.168.0.0/16'), false);
  });
  it('handles a bare address as /32, ::ffff: prefix, and fails closed on garbage', () => {
    assert.equal(ipMatchesCidr('192.168.1.1', '192.168.1.1'), true);
    assert.equal(ipMatchesCidr('::ffff:192.168.1.5', '192.168.1.0/24'), true);
    assert.equal(ipMatchesCidr('1.2.3.4', 'not-a-cidr'), false);
    assert.equal(ipMatchesCidr('', '192.168.1.0/24'), false);
  });
});
