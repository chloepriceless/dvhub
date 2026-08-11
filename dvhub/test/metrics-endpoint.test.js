// test/metrics-endpoint.test.js
//
// Plan 09-06 (REQ-9.6 metrics-endpoint + REQ-9.6 metrics-lan-bypass):
//
// Verifies GET /api/metrics behaviour:
//   1. D-07: a LAN client gets 200 + Prometheus exposition WITHOUT Bearer
//      (because '/api/metrics' is in LAN_SAFE_ENDPOINTS).
//   2. D-06: the body looks like the prom-client exposition format
//      (HELP/TYPE lines, labelled counter samples).
//   3. Cardinality control: dynamic-id requests appear under a :id canonical
//      route label, never the raw id (matchRouteLabel guard).
//   4. External clients still hit the Bearer gate — 401 without, 200 with.
//
// Same minimal-ctx harness as test/admin-rate-limit.test.js.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApiRoutes, metricsRegistry } from '../routes-api.js';

const LAN_IP = '192.168.1.5';       // RFC 1918 — LAN client (no Bearer required)
const EXT_IP = '203.0.113.5';        // TEST-NET-3 — external client (Bearer required)
const API_TOKEN = 'plan-09-06-test-token-xxxxxxxxxxxxxxxxxx'; // ≥ 16 chars

function mockRes() {
  const captured = { status: 0, headers: {}, body: '' };
  return {
    writeHead(code, headers) {
      captured.status = code;
      Object.assign(captured.headers, headers);
    },
    end(payload) { captured.body = payload; },
    _captured: captured,
  };
}

function makeReq(pathname, { method = 'GET', token = null, ip = LAN_IP } = {}) {
  const headers = { host: 'dvhub.test' };
  if (token) headers.authorization = `Bearer ${token}`;
  return {
    method,
    url: pathname,
    headers,
    socket: { remoteAddress: ip },
  };
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
    buildSystemDiscoveryPayload: async () => ({ ok: true }),
  };
}

async function callMetrics({ ip, token = null } = {}) {
  const ctx = mockCtx();
  const routes = createApiRoutes(ctx);
  const req = makeReq('/api/metrics', { ip, token });
  const res = mockRes();
  const url = new URL(req.url, `http://${req.headers.host}`);
  await routes.handleRequest(req, res, url);
  return res._captured;
}

describe('Plan 09-06 metrics-endpoint — D-07 LAN bypass', () => {
  it('D-07: GET /api/metrics from LAN bypasses Bearer (LAN_SAFE_ENDPOINTS includes /api/metrics)', async () => {
    const captured = await callMetrics({ ip: LAN_IP, token: null });
    assert.equal(captured.status, 200, 'LAN scrape without Bearer must return 200');
    const ct = captured.headers['content-type'] || '';
    assert.ok(
      ct.startsWith('text/plain; version=0.0.4'),
      `content-type must start with prom exposition v0.0.4 (got "${ct}")`
    );
  });

  it('D-06: GET /api/metrics returns prom-client Prometheus exposition (TYPE/HELP lines + counter samples)', async () => {
    // Mock res isn't an EventEmitter (no on()), so the finish-observer in
    // handleRequest cannot fire in this test harness. Seed the counter
    // directly to assert the exposition shape — the wire-level wiring
    // (counter.inc on res.finish) is exercised in production by real http.IncomingMessage.
    const { httpRequestsTotal } = await import('../routes-api.js');
    httpRequestsTotal.inc({ method: 'GET', route: '/api/status', status: '200' });

    const captured = await callMetrics({ ip: LAN_IP });
    assert.equal(captured.status, 200);
    assert.ok(captured.body.includes('# HELP dvhub_http_requests_total'), 'body must contain HELP for dvhub_http_requests_total');
    assert.ok(captured.body.includes('# TYPE dvhub_http_requests_total counter'), 'body must contain TYPE counter line');
    assert.ok(/dvhub_http_requests_total\{/.test(captured.body), 'body must contain at least one labelled counter sample');
    assert.ok(captured.body.includes('# TYPE dvhub_http_request_duration_seconds histogram'), 'body must contain histogram TYPE');
  });

  it('Cardinality control: dynamic-id paths surface as canonical :id labels in matchRouteLabel', async () => {
    const { matchRouteLabel } = await import('../routes-api.js');
    assert.equal(matchRouteLabel('/api/devices/abc-123'), '/api/devices/:id');
    // /api/messages/:id pattern removed with the LLM stack (2026-06-13).
    assert.equal(matchRouteLabel('/api/status'), '/api/status');
    // Belt-and-braces: increment counter with both labels, verify metrics
    // output keeps the canonical form (no abc-123 leak).
    const { httpRequestsTotal } = await import('../routes-api.js');
    httpRequestsTotal.inc({ method: 'GET', route: '/api/devices/:id', status: '200' });
    const body = await metricsRegistry.metrics();
    assert.ok(body.includes('route="/api/devices/:id"'), 'metrics body must contain :id canonical label');
    assert.ok(!body.includes('route="/api/devices/abc-123"'), 'metrics body must NOT contain raw dynamic id');
  });

  it('External (non-LAN) GET /api/metrics WITHOUT Bearer returns 401', async () => {
    const captured = await callMetrics({ ip: EXT_IP, token: null });
    // Bearer missing — checkAuth fails closed. Status is 401 (token mismatch)
    // or 503 (api_token_not_configured); here we have apiToken set so 401.
    assert.equal(captured.status, 401, 'external scrape without Bearer must return 401');
  });

  it('External GET /api/metrics WITH valid Bearer returns 200', async () => {
    const captured = await callMetrics({ ip: EXT_IP, token: API_TOKEN });
    assert.equal(captured.status, 200, 'external scrape with valid Bearer must return 200');
    const ct = captured.headers['content-type'] || '';
    assert.ok(ct.startsWith('text/plain; version=0.0.4'), 'content-type must be Prometheus exposition');
  });
});
