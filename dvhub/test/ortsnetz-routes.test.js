// test/ortsnetz-routes.test.js — /api/ortsnetz/*: Status mit UI-Nonce,
// Einstellungen nur mit Nonce/Bearer, Werte geprüft, Opt-in landet in der Config.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApiRoutes } from '../routes-api.js';

const API_TOKEN = 'lan-trust-test-token-xxxxxxxxxxxxxxxxxx'; // ≥16 chars (startup guard)
const LAN_IP = '192.168.1.66';

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


function setup() {
  const ctx = mockCtx({ lanTrust: 'open' });
  let saved = null;
  const raw = {};
  ctx.getRawCfg = () => raw;
  ctx.saveAndApplyConfig = (next) => { saved = next; Object.assign(raw, next); return {}; };
  let ticks = 0;
  ctx.ortsnetz = { status: () => ({ enabled: !!raw.ortsnetz?.enabled, location: null }), tick: async () => { ticks++; return { ok: true }; } };
  const routes = createApiRoutes(ctx);
  async function call(p, method = 'GET', body) {
    const req = makeReq(p, { method, ip: LAN_IP });
    if (body) { req.headers['content-type'] = 'application/json'; const buf = Buffer.from(JSON.stringify(body)); req.on = (ev, fn) => { if (ev === 'data') fn(buf); if (ev === 'end') fn(); return req; }; }
    const res = mockRes();
    await routes.handleRequest(req, res, new URL(req.url, `http://${req.headers.host}`));
    let j = null; try { j = JSON.parse(res._captured.body); } catch { /* */ }
    return { status: res._captured.status, j };
  }
  return { call, saved: () => saved, ticks: () => ticks };
}

describe('/api/ortsnetz', () => {
  it('Status liefert uiToken; Einstellungen ohne Nonce → 403', async () => {
    const t = setup();
    const st = await t.call('/api/ortsnetz/status');
    assert.equal(st.status, 200);
    assert.match(st.j.uiToken, /^[a-f0-9]{32}$/);
    const no = await t.call('/api/ortsnetz/settings', 'POST', { enabled: true });
    assert.equal(no.status, 403);
    assert.equal(no.j.error, 'ui_token_required');
  });
  it('Opt-in + Standort (Komma erlaubt) landen in der Config; ungültige Werte → 400', async () => {
    const t = setup();
    const { j } = await t.call('/api/ortsnetz/status');
    const ok = await t.call('/api/ortsnetz/settings', 'POST', { uiToken: j.uiToken, enabled: true, latitude: '48,125611', longitude: 9.432794, sendPvForecast: false });
    assert.equal(ok.status, 200, JSON.stringify(ok.j));
    assert.deepEqual(t.saved().ortsnetz, { enabled: true, latitude: 48.125611, longitude: 9.432794, sendPvForecast: false });
    assert.equal((await t.call('/api/ortsnetz/settings', 'POST', { uiToken: j.uiToken, latitude: 95 })).j.error, 'latitude_invalid');
    assert.equal((await t.call('/api/ortsnetz/settings', 'POST', { uiToken: j.uiToken, enabled: 'ja' })).status, 400);
    const cleared = await t.call('/api/ortsnetz/settings', 'POST', { uiToken: j.uiToken, latitude: '', longitude: null });
    assert.equal(cleared.status, 200);
    assert.equal(t.saved().ortsnetz.latitude, null, 'leer = Prognose-Standort');
  });
});
