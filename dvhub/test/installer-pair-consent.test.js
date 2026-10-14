// test/installer-pair-consent.test.js — Fern-Support-Haken im Kopplungsdialog
// (2026-10-14): „Kopplung starten“ mit allowTunnel:true erlaubt dem Portal das
// Öffnen des Tunnels gleich mit; ohne Haken bleibt es aus, ein schon gesetzter
// Haken wird nie stillschweigend entfernt.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createApiRoutes } from '../routes-api.js';

const API_TOKEN = 'pair-consent-test-token-xxxxxxxxxxxxxxx';

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

function mockCtx(security, installerPortal) {
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
    installerPortal,
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


async function pair(installerPortal, body) {
  const ctx = mockCtx({ lanTrust: 'open' }, installerPortal);
  let cfg = ctx.getRawCfg();
  ctx.getCfg = () => cfg;
  ctx.getRawCfg = () => cfg;
  const saved = [];
  ctx.saveAndApplyConfig = (next) => { saved.push(next); cfg = next; return { ok: true }; };
  ctx.installerPortalClient = { claim: async () => ({ ok: true, status: 'requested', portalUrl: 'https://portal.dvhub.de' }) };
  const portal = {
    enabled: () => cfg.installerPortal?.enabled === true,
    permissions: () => ({ allowTunnel: cfg.installerPortal?.allowTunnel === true, allowUpdates: false }),
    checkUiToken: (t) => t === 'nonce',
    applianceId: () => 'box-01',
  };
  ctx.installerPortal = portal;
  const routes = createApiRoutes(ctx);
  const req = Readable.from([Buffer.from(JSON.stringify({ portalUrl: 'https://portal.dvhub.de', pairingCode: '123456', uiToken: 'nonce', ...body }))]);
  Object.assign(req, { method: 'POST', url: '/api/installer/client/pair', headers: { host: 'dvhub.test', 'content-type': 'application/json' }, socket: { remoteAddress: '192.168.1.66' } });
  const res = mockRes();
  await routes.handleRequest(req, res, new URL(req.url, 'http://dvhub.test'));
  return { status: res._captured.status, saved, cfg: () => cfg };
}

test('Kopplung mit Fern-Support-Haken: Portal-Zugang und Tunnel-Freigabe an', async () => {
  const r = await pair(null, { allowTunnel: true });
  assert.equal(r.status, 200);
  assert.equal(r.cfg().installerPortal.enabled, true);
  assert.equal(r.cfg().installerPortal.allowTunnel, true);
});

test('Kopplung ohne Haken: nur Portal-Zugang, Tunnel bleibt gesperrt', async () => {
  const r = await pair(null, {});
  assert.equal(r.status, 200);
  assert.equal(r.cfg().installerPortal.enabled, true);
  assert.notEqual(r.cfg().installerPortal.allowTunnel, true);
});

test('Kopplung ohne Haken entfernt eine schon erteilte Freigabe nicht', async () => {
  const ctxCfg = { enabled: true, allowTunnel: true };
  const r = await pair(ctxCfg, { allowTunnel: false });
  assert.equal(r.status, 200);
  assert.equal(r.saved.length, 0, 'nichts zu speichern');
  assert.equal(r.cfg().installerPortal.allowTunnel, true);
});
