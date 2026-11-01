// test/eos-remote-routes.test.js — Oberfläche/API für EOS im Fernbetrieb.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApiRoutes } from '../routes-api.js';

const REMOTE_IP = '203.0.113.5'; // TEST-NET-3 — never resolves to LAN
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

function mockCtx({ licenseActive = true, inspector = makeInspectorStub(), eosMonitor = null, eosProxy = null, eosRemoteState = null, eosRemote = null } = {}) {
  const cfg = {
    apiToken: API_TOKEN,
    epex: { enabled: false, timezone: 'Europe/Berlin' },
    optimizer: { enabled: false, ...(eosProxy ? { eosProxy } : {}) },
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
      optimizer: { eosRemote: eosRemoteState },
    },
    eosRemote,
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
  m.isUp = () => enabled && status !== 'down';
  m.notifySolutionReady = async () => { m.notified += 1; };
  return m;
}


const REMOTE_PROXY = { enabled: true, mode: 'remote', url: 'http://127.0.0.1:8503', remote: { endpoint: 'https://eos.example.invalid', token: 'dves_geheim' } };
const REMOTE_STATE = {
  mode: 'remote', endpointHost: 'eos.example.invalid', enrolled: true, phase: 'idle', lastJobId: 'job_x',
  lastOkAt: '2026-10-28T11:00:00.000Z', lastRunMs: 41234, lastError: null, usingLastPlan: false, fallback: null,
  eosVersion: 'v0.4.0rc3',
  diagnostics: { eosVersion: 'v0.4.0rc3', runMs: 41234, workers: 4, costs: { netAmt: 0.73 }, warnings: ['Tail forecast shortened'] },
};

test('GET /api/eos/plan — im Fernbetrieb mit Abschnitt „EOS-Rechendienst“ (ohne Token)', async () => {
  const eosMonitor = monitorStub();
  const body = JSON.parse((await dispatch(mockCtx({ eosMonitor, eosProxy: REMOTE_PROXY, eosRemoteState: REMOTE_STATE }), makeReq('/api/eos/plan'))).body);
  assert.equal(body.remote.lastRunMs, 41234);
  assert.deepEqual(body.remote.diagnostics.warnings, ['Tail forecast shortened']);
  assert.doesNotMatch(JSON.stringify(body), /dves_geheim/);
});

test('GET /api/eos/plan — lokal: kein remote-Abschnitt', async () => {
  const body = JSON.parse((await dispatch(mockCtx({ eosMonitor: monitorStub() }), makeReq('/api/eos/plan'))).body);
  assert.equal(body.remote ?? null, null);
});

test('GET /api/integrations/dveos — nennt Betriebsart und Dienst-Zustand', async () => {
  const body = JSON.parse((await dispatch(mockCtx({ eosMonitor: monitorStub(), eosProxy: REMOTE_PROXY, eosRemoteState: REMOTE_STATE }), makeReq('/api/integrations/dveos'))).body);
  assert.equal(body.mode, 'remote');
  assert.equal(body.remote.endpointHost, 'eos.example.invalid');
  assert.doesNotMatch(JSON.stringify(body), /dves_geheim/);
});

test('GET /api/eos/remote/debug — Diagnosepaket herunterladen; ohne Paket 404; mit Auth', async () => {
  const eosRemote = { fetchDebugBundle: async () => ({ jobId: 'job_x', bundle: { eosLog: 'LOG' } }) };
  const ok = await dispatch(mockCtx({ eosProxy: REMOTE_PROXY, eosRemote }), makeReq('/api/eos/remote/debug'));
  assert.equal(ok.status, 200);
  assert.match(String(ok.headers['Content-Disposition'] || ok.headers['content-disposition']), /attachment; filename="eos-diagnose-job_x\.json"/);
  assert.equal(JSON.parse(ok.body).bundle.eosLog, 'LOG');
  const none = await dispatch(mockCtx({ eosProxy: REMOTE_PROXY, eosRemote: { fetchDebugBundle: async () => null } }), makeReq('/api/eos/remote/debug'));
  assert.equal(none.status, 404);
  const noAuth = await dispatch(mockCtx({ eosProxy: REMOTE_PROXY, eosRemote }), makeReq('/api/eos/remote/debug', { token: null }));
  assert.equal(noAuth.status, 401);
});

test('POST /api/eos/sync-from-dvhub — im Fernbetrieb abgelehnt (Abgleich läuft automatisch)', async () => {
  const req = makeReq('/api/eos/sync-from-dvhub', { method: 'POST' });
  req.resume = () => {};
  const r = await dispatch(mockCtx({ eosProxy: REMOTE_PROXY }), req);
  assert.equal(r.status, 409);
  assert.equal(JSON.parse(r.body).error, 'eos_remote_mode');
});
