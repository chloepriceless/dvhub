// test/eos-plan-routes.test.js — Push-Empfang von EOS und Leitstand-Plan aus
// dem EOS-Monitor (2026-10-03). Harness wie test/inspector-routes.test.js.

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
    getEos: async ({ from, to }) => ({ ok: false, error: 'not_implemented', stub: 'b4', window: { from, to } }),
    getOptimizerCold: async () => ({ lastRunAt: '2026-05-19T10:00:00.000Z', daysSinceLastRun: 1.0, isStale: false, optimizer: 'internal' }),
  };
  return { ...def, ...overrides };
}

function mockCtx({ licenseActive = true, inspector = makeInspectorStub(), eosMonitor = null } = {}) {
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
    eosMonitor,
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
        const ALLOWED = new Set(['family-dashboard','forecast-inspector-eos']);
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


function monitorStub({ enabled = true, plan = null, status = 'up' } = {}) {
  const m = { notified: 0 };
  m.status = () => ({ enabled, status, reachable: enabled && status !== 'down', push: { active: m.notified > 0, lastAt: null, count: m.notified } });
  m.displayPlan = async () => plan;
  m.notifySolutionReady = async () => { m.notified += 1; };
  return m;
}

const rows = Array.from({ length: 768 }, (_, i) => ({ ts_utc: new Date(Date.UTC(2026, 9, 3, 9) + i * 900_000).toISOString(), socPct: 50 }));
const solution = { generatedAt: '2026-10-03T11:13:46+02:00', validFrom: rows[0].ts_utc, validUntil: rows[767].ts_utc, slotMinutes: 15, kpis: {}, rows };

test('POST /api/eos/solution-ready — von der Box selbst: 204, Monitor holt', async () => {
  const eosMonitor = monitorStub();
  const ctx = mockCtx({ eosMonitor });
  const req = makeReq('/api/eos/solution-ready', { method: 'POST', token: null, ip: '127.0.0.1' });
  req.resume = () => {};
  const captured = await dispatch(ctx, req);
  assert.equal(captured.status, 204, `body=${captured.body}`);
  assert.equal(eosMonitor.notified, 1);
});

test('POST /api/eos/solution-ready — aus dem LAN mit Token: 403 (nur Loopback)', async () => {
  const eosMonitor = monitorStub();
  const ctx = mockCtx({ eosMonitor });
  const req = makeReq('/api/eos/solution-ready', { method: 'POST', ip: LAN_IP });
  req.resume = () => {};
  const captured = await dispatch(ctx, req);
  assert.equal(captured.status, 403);
  assert.equal(eosMonitor.notified, 0);
});

test('GET /api/eos/plan — Plan aus dem Monitor, gekürzt auf 300 Zeilen, ohne Token im LAN', async () => {
  const ctx = mockCtx({ eosMonitor: monitorStub({ plan: { data: solution, at: Date.UTC(2026, 9, 3, 9, 14), current: false } }) });
  const captured = await dispatch(ctx, makeReq('/api/eos/plan', { token: null, ip: LAN_IP }));
  assert.equal(captured.status, 200, `body=${captured.body}`);
  const body = JSON.parse(captured.body);
  assert.equal(body.available, true);
  assert.equal(body.output.generatedAt, solution.generatedAt);
  assert.equal(body.output.rows.length, 300);
  assert.equal(body.output.totalCount, 768);
  assert.equal(body.plan.current, false, 'Plan von vor dem EOS-Neustart bleibt sichtbar');
});

test('GET /api/eos/plan — noch kein Plan: available ohne output; EOS aus: eos_off', async () => {
  let body = JSON.parse((await dispatch(mockCtx({ eosMonitor: monitorStub() }), makeReq('/api/eos/plan'))).body);
  assert.equal(body.output, null);
  assert.equal(body.available, true);
  body = JSON.parse((await dispatch(mockCtx({ eosMonitor: monitorStub({ enabled: false }) }), makeReq('/api/eos/plan'))).body);
  assert.deepEqual([body.available, body.reason], [false, 'eos_off']);
});

test('GET /api/eos/plan — ohne Pro-Lizenz 403', async () => {
  const captured = await dispatch(mockCtx({ licenseActive: false, eosMonitor: monitorStub() }), makeReq('/api/eos/plan'));
  assert.equal(captured.status, 403);
});

// EOS neu starten aus der Oberfläche (2026-10-16, Feldfall: EOS antwortete, rechnete aber nicht).
function restarterStub({ canRestart = true, reason = null, result = { ok: true } } = {}) {
  const r = { calls: [] };
  r.status = () => ({ canRestart, reason, restarting: false, stallRestartMin: 90, stalledForMin: null, restarts: r.calls.length, lastRestart: null });
  r.restart = (opts) => { r.calls.push(opts); return Promise.resolve(result); };
  return r;
}

test('POST /api/eos/restart — lokal möglich: 202, Neustart über den Restarter (via ui)', async () => {
  const ctx = mockCtx({ eosMonitor: monitorStub() });
  ctx.eosRestarter = restarterStub();
  const captured = await dispatch(ctx, makeReq('/api/eos/restart', { method: 'POST', ip: LAN_IP }));
  assert.equal(captured.status, 202, `body=${captured.body}`);
  assert.equal(JSON.parse(captured.body).accepted, true);
  assert.equal(ctx.eosRestarter.calls.length, 1);
  assert.equal(ctx.eosRestarter.calls[0].via, 'ui');
});

test('POST /api/eos/restart — EOS im Container/entfernt: 409 mit Grund, kein Neustart', async () => {
  const ctx = mockCtx({ eosMonitor: monitorStub() });
  ctx.eosRestarter = restarterStub({ canRestart: false, reason: 'remote' });
  const captured = await dispatch(ctx, makeReq('/api/eos/restart', { method: 'POST', ip: LAN_IP }));
  assert.equal(captured.status, 409);
  assert.equal(JSON.parse(captured.body).error, 'remote');
  assert.equal(ctx.eosRestarter.calls.length, 0);
});

test('POST /api/eos/restart — zu schnell hintereinander: 429', async () => {
  const ctx = mockCtx({ eosMonitor: monitorStub() });
  ctx.eosRestarter = restarterStub({ result: { ok: false, error: 'too_soon' } });
  const captured = await dispatch(ctx, makeReq('/api/eos/restart', { method: 'POST', ip: LAN_IP }));
  assert.equal(captured.status, 429);
});

// Fehlt die sudoers-Regel, scheitert `sudo -n` sofort — dann darf die Route
// nicht „angestoßen“ melden (lokal beobachtet 2026-10-17: 202 trotz Fehler).
test('POST /api/eos/restart — sofort gescheitert (sudo verweigert): 502 mit Fehlertext', async () => {
  const ctx = mockCtx({ eosMonitor: monitorStub() });
  ctx.eosRestarter = restarterStub({ result: { ok: false, error: 'restart_failed', detail: 'sudo: a password is required' } });
  const captured = await dispatch(ctx, makeReq('/api/eos/restart', { method: 'POST', ip: LAN_IP }));
  assert.equal(captured.status, 502, `body=${captured.body}`);
  const body = JSON.parse(captured.body);
  assert.equal(body.error, 'restart_failed');
  assert.match(body.detail, /password is required/);
});

test('GET /api/eos/status — enthält den Neustart-Zustand', async () => {
  const ctx = mockCtx({ eosMonitor: monitorStub() });
  ctx.eosRestarter = restarterStub();
  const captured = await dispatch(ctx, makeReq('/api/eos/status', { ip: LAN_IP }));
  assert.equal(captured.status, 200);
  const body = JSON.parse(captured.body);
  assert.equal(body.restart.canRestart, true);
  assert.equal(body.restart.stallRestartMin, 90);
});

// Wächter im EOS-Container (2026-10-18): nur von der Box selbst, ohne Token.
test('GET /api/eos/restart-request — Loopback ohne Token: 200 mit requestedAt; aus dem LAN: 403', async () => {
  const ctx = mockCtx({ eosMonitor: monitorStub() });
  const polls = [];
  ctx.eosRestarter = { ...restarterStub(), helperPoll: (q) => { polls.push(q); return { requestedAt: 1234 }; } };
  const ok = await dispatch(ctx, makeReq('/api/eos/restart-request?boot=999', { token: null, ip: '127.0.0.1' }));
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).requestedAt, 1234);
  assert.deepEqual(polls, [{ boot: '999' }]);
  const lan = await dispatch(ctx, makeReq('/api/eos/restart-request?boot=1', { ip: LAN_IP }));
  assert.equal(lan.status, 403);
  assert.equal(polls.length, 1);
});

// Codex 2026-10-18: mit gesetzter Host-Allowlist kam der Wächter (Host 127.0.0.1:8080)
// nicht durch das Host-Tor. Ausnahme nur für Box-interne Aufrufe von Loopback mit Loopback-Host.
test('Host-Allowlist: Wächter von 127.0.0.1 kommt durch, fremder Host oder andere Route nicht', async () => {
  const ctx = mockCtx({ eosMonitor: monitorStub() });
  ctx.getCfg().allowedHosts = ['dvhub.example.org'];
  ctx.eosRestarter = { ...restarterStub(), helperPoll: () => ({ requestedAt: null }) };
  const req = (path, host, ip = '127.0.0.1') => ({ ...makeReq(path, { token: null, ip }), headers: { host } });
  assert.equal((await dispatch(ctx, req('/api/eos/restart-request?boot=1', '127.0.0.1:8080'))).status, 200);
  assert.equal((await dispatch(ctx, req('/api/eos/restart-request?boot=1', 'localhost:8081'))).status, 200);
  assert.equal((await dispatch(ctx, req('/api/eos/restart-request?boot=1', 'rebind.attacker.example'))).status, 400, 'fremder Host bleibt gesperrt');
  assert.equal((await dispatch(ctx, req('/api/eos/restart-request?boot=1', '127.0.0.1:8080', LAN_IP))).status, 400, 'nicht von Loopback');
  assert.equal((await dispatch(ctx, req('/api/eos/status', '127.0.0.1:8080'))).status, 400, 'andere Routen unverändert');
});
