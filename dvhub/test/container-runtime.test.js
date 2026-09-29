// test/container-runtime.test.js — DVHUB_RUNTIME=container (Dockerfile):
// Update/Reboot/Restart/Timescale-Upgrade antworten 409 mit Klartext-Hinweis,
// der DB-Restore ist ohne Service-Actions erreichbar (Weg für Bestandsdaten).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApiRoutes } from '../routes-api.js';

const API_TOKEN = 'lan-trust-test-token-xxxxxxxxxxxxxxxxxx'; // ≥16 chars (startup guard)
const LAN_IP = '192.168.1.66';
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


async function call(pathname, { method = 'GET', env = 'container' } = {}) {
  const prev = process.env.DVHUB_RUNTIME;
  if (env) process.env.DVHUB_RUNTIME = env; else delete process.env.DVHUB_RUNTIME;
  try {
    const routes = createApiRoutes(mockCtx({ lanTrust: 'open' }));
    const req = makeReq(pathname, { method, ip: LOOPBACK, token: API_TOKEN });
    const res = mockRes();
    await routes.handleRequest(req, res, new URL(req.url, `http://${req.headers.host}`));
    let body = null;
    try { body = JSON.parse(res._captured.body); } catch { /* */ }
    return { status: res._captured.status, body };
  } finally {
    if (prev === undefined) delete process.env.DVHUB_RUNTIME; else process.env.DVHUB_RUNTIME = prev;
  }
}

describe('Container-Laufzeit', () => {
  const refused = [
    ['GET', '/api/admin/update/check'], ['POST', '/api/admin/update/apply'], ['POST', '/api/admin/update/channel'],
    ['GET', '/api/admin/system/updates/check'], ['POST', '/api/admin/system/updates/apply'],
    ['POST', '/api/admin/system/reboot'], ['POST', '/api/admin/service/restart'], ['POST', '/api/db/timescale/upgrade'],
  ];
  for (const [method, p] of refused) {
    it(`${method} ${p} → 409 container_runtime mit Hinweis`, async () => {
      const r = await call(p, { method });
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'container_runtime');
      assert.match(r.body.error, /docker compose pull/);
    });
  }
  it('nativ unverändert: Update-Check bleibt beim Service-Actions-Gate (403)', async () => {
    const r = await call('/api/admin/update/check', { env: null });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'service actions disabled');
  });
  it('DB-Restore: im Container ohne Service-Actions erreichbar, nativ weiter 403', async () => {
    const ct = await call('/api/db/restore', { method: 'POST' });
    assert.notEqual(ct.status, 403, JSON.stringify(ct.body));
    assert.equal(ct.body.error, 'telemetry database disabled', 'läuft bis zur DB-Prüfung durch');
    const nat = await call('/api/db/restore', { method: 'POST', env: null });
    assert.equal(nat.status, 403);
  });
});
