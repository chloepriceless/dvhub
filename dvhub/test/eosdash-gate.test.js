// test/eosdash-gate.test.js
//
// Review 2026-10-25 (Sicherheit, P2): /eosdash/* läuft in server.js an
// routes.handleRequest vorbei durch routes.enforceRequestGate. Das Tor prüfte
// nur Rate-Limit und checkAuth — die Herkunftsprüfung für schreibende Aufrufe
// und die Host-Allowlist fehlten. Jede Webseite konnte so per Formular-POST
// (ohne Preflight) die EOS-Konfiguration hinter EOSdash ändern.
// Jetzt gelten für /eosdash/* dieselben Host- und Herkunftsregeln wie für /api/*.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApiRoutes } from '../routes-api.js';

const API_TOKEN = 'lan-trust-test-token-xxxxxxxxxxxxxxxxxx';
const LAN_IP = '192.168.1.66';

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

function mockCtx(cfgExtra = {}) {
  const cfg = {
    apiToken: API_TOKEN, epex: { enabled: false }, optimizer: { enabled: false },
    schedule: { timezone: 'Europe/Berlin', rules: [] }, telemetry: { enabled: false }, family: {},
    corsAllowedOrigins: [], allowedHosts: [], security: {}, ...cfgExtra,
  };
  return {
    state: { meter: {}, victron: {}, epex: {}, energy: {}, telemetry: {}, keepalive: { appPulse: {} }, schedule: { rules: [] }, ctrl: {}, log: [], forecast: null },
    getCfg: () => cfg, getRawCfg: () => cfg,
    getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }),
    getConfigPath: () => '/tmp/config.json', getConfigDefinition: () => [],
    getAppVersion: () => ({ version: '0.9.0-test' }), getTransportType: () => 'modbus',
    getAppDir: () => '/tmp', getRepoRoot: () => '/tmp', getServiceActionsEnabled: () => false,
    getServiceName: () => 'dvhub', getServiceUseSudo: () => false, runServiceCommand: async () => ({ ok: true }),
    controlValue: () => 'off', pushLog: () => {}, telemetrySafeWrite: () => {}, needsSetup: () => false,
    epexNowNext: () => null, expireLeaseIfNeeded: () => {}, costSummary: () => ({}), userEnergyPricingSummary: () => ({}),
    buildSystemDiscoveryPayload: async () => ({ ok: true }),
  };
}

function gate({ method = 'POST', path = '/eosdash/configedit', headers, ip = LAN_IP, cfgExtra } = {}) {
  const routes = createApiRoutes(mockCtx(cfgExtra));
  const res = mockRes();
  const passed = routes.enforceRequestGate({ method, url: path, headers, socket: { remoteAddress: ip } }, res);
  let body = null;
  try { body = JSON.parse(res._captured.body); } catch { /* nichts geschrieben */ }
  return { passed, status: res._captured.status, body };
}

const BOX = '192.168.1.50:8080';

describe('EOSdash-Tor: Herkunft und Host wie bei /api/*', () => {
  it('fremde Webseite (Formular-POST) wird abgewiesen', () => {
    const r = gate({ headers: { host: BOX, origin: 'https://boese.example', 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(r.passed, false);
    assert.equal(r.status, 403);
    assert.equal(r.body?.error, 'cors_origin_not_allowed');
  });

  it('auch PUT/DELETE/PATCH von fremder Herkunft werden abgewiesen', () => {
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      const r = gate({ method, headers: { host: BOX, origin: 'https://boese.example' } });
      assert.equal(r.passed, false, method);
      assert.equal(r.status, 403, method);
    }
  });

  it('Origin "null" wird abgewiesen', () => {
    const r = gate({ headers: { host: BOX, origin: 'null' } });
    assert.equal(r.passed, false);
  });

  it('DNS-Rebinding (Host = Origin = fremder Name) kommt nicht durch', () => {
    const r = gate({ headers: { host: 'attacker.example:8080', origin: 'http://attacker.example:8080' } });
    assert.equal(r.passed, false);
  });

  it('nicht gelisteter Host bei gesetzter allowedHosts → 400 wie bei /api/*', () => {
    const r = gate({ method: 'GET', headers: { host: 'attacker.example' }, cfgExtra: { allowedHosts: ['dvhub.example.com'] } });
    assert.equal(r.passed, false);
    assert.equal(r.status, 400);
    assert.equal(r.body?.error, 'host_not_allowed');
  });

  it('eigene EOSdash-Oberfläche (gleiche Herkunft) kommt ohne Token durch', () => {
    assert.equal(gate({ headers: { host: BOX, origin: `http://${BOX}` } }).passed, true);
    assert.equal(gate({ headers: { host: 'dvhub.local', origin: 'http://dvhub.local' } }).passed, true);
  });

  it('GET (Seiten, htmx-Fragmente) und POST ohne Origin bleiben unverändert', () => {
    assert.equal(gate({ method: 'GET', path: '/eosdash/', headers: { host: BOX } }).passed, true);
    assert.equal(gate({ method: 'GET', headers: { host: BOX, origin: 'https://boese.example' } }).passed, true);
    assert.equal(gate({ headers: { host: BOX } }).passed, true);
  });

  it('eingetragene Herkunft (corsAllowedOrigins) und Reverse-Proxy mit Token kommen durch', () => {
    assert.equal(gate({ headers: { host: BOX, origin: 'https://portal.example' }, cfgExtra: { corsAllowedOrigins: ['https://portal.example'] } }).passed, true);
    assert.equal(gate({
      headers: { host: 'dvhub.example.com', origin: 'https://dvhub.example.com', authorization: `Bearer ${API_TOKEN}` },
      ip: '203.0.113.5',
    }).passed, true);
  });
});
