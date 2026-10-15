// test/helpers/api-routes-harness.js — Anfragen an createApiRoutes().handleRequest
// mit einem kleinen ctx (2026-10-15, für die Routentests der aus routes-api.js
// herausgelösten Bereiche: Sie prüfen auch, dass ein Bereich verdrahtet ist).
import { Readable } from 'node:stream';
import { createApiRoutes } from '../../routes-api.js';

export const API_TOKEN = 'api-routes-harness-token-xxxxxxxxxxxx';

function mockRes() {
  const captured = { status: 0, headers: {}, body: '' };
  return {
    writeHead(code, headers) { captured.status = code; Object.assign(captured.headers, headers || {}); },
    setHeader() {},
    end(payload) { captured.body = payload; },
    on() {},
    _captured: captured,
  };
}

/**
 * ctx mit einer Konfiguration `raw` (getCfg und getRawCfg); `extra` überschreibt
 * oder ergänzt ctx-Felder. saveAndApplyConfig hält gespeicherte Stände in
 * ctx.saved fest.
 */
export function mockCtx({ raw = {}, extra = {} } = {}) {
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
    security: { lanTrust: 'open' },
    ...raw,
  };
  const ctx = {
    saved: [],
    logs: [],
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
    saveAndApplyConfig(next) { ctx.saved.push(next); },
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
    pushLog: (event, data) => { ctx.logs.push([event, data]); },
    telemetrySafeWrite: () => {},
    needsSetup: () => false,
    epexNowNext: () => null,
    expireLeaseIfNeeded: () => {},
    costSummary: () => ({}),
    userEnergyPricingSummary: () => ({}),
    buildSystemDiscoveryPayload: async () => ({ ok: true }),
    ...extra,
  };
  return ctx;
}

/** Eine Anfrage über handleRequest; `body` wird als JSON gesendet. */
export async function call(ctx, pathname, { method = 'GET', body } = {}) {
  const routes = createApiRoutes(ctx);
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Object.assign(Readable.from(payload), {
    method,
    url: pathname,
    headers: { host: 'dvhub.test', authorization: `Bearer ${API_TOKEN}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    socket: { remoteAddress: '127.0.0.1' },
  });
  const res = mockRes();
  const out = await routes.handleRequest(req, res, new URL(req.url, `http://${req.headers.host}`));
  let parsed = null;
  try { parsed = JSON.parse(res._captured.body); } catch { /* kein JSON */ }
  return { status: res._captured.status, body: parsed, handled: out !== false };
}
