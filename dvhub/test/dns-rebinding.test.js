// test/dns-rebinding.test.js
//
// Review 2026-10-25 (Sicherheit, P1): DNS-Rebinding.
//
// Eine fremde Webseite lässt ihren Namen (attacker.example) auf die IP der Box
// zeigen. Der Browser im Heimnetz schickt dann Host = Origin = attacker.example
// an die Box — die Herkunftsprüfung hielt das für die eigene Oberfläche und
// checkAuth gab den Heimnetz-Freibrief (lanTrust 'open'). So konnte die Seite
// den API-Token rotieren und mitlesen oder Backup/Config/Support-Bundle holen.
//
// Fix: Freibrief und „gleiche Herkunft“ gelten nur, wenn der Host die Box auf
// eine Art nennt, die ein Angreifer nicht steuern kann (IP, localhost, ein
// Name ohne Punkt, Heimnetz-Endungen wie .local/.fritz.box, der eigene
// Rechnername, allowedHosts). Mit Token geht weiterhin alles.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApiRoutes, isTrustedBoxHost } from '../routes-api.js';

const API_TOKEN = 'lan-trust-test-token-xxxxxxxxxxxxxxxxxx';
const LAN_IP = '192.168.1.66';
const LOOPBACK = '127.0.0.1';

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

function mockCtx(cfgExtra = {}, logs = []) {
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
    security: {},
    ...cfgExtra,
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
    hostname: () => 'dvhub-a7s',
    getCfg: () => cfg,
    getRawCfg: () => cfg,
    saveAndApplyConfig: (next) => { Object.assign(cfg, next); return { changedPaths: ['apiToken'] }; },
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
    pushLog: (event, data) => { logs.push({ event, data }); },
    telemetrySafeWrite: () => {},
    needsSetup: () => false,
    epexNowNext: () => null,
    expireLeaseIfNeeded: () => {},
    costSummary: () => ({}),
    userEnergyPricingSummary: () => ({}),
    buildSystemDiscoveryPayload: async () => ({ ok: true }),
  };
}

async function call(ctx, { method = 'GET', path, headers = {}, ip = LAN_IP }) {
  const routes = createApiRoutes(ctx);
  const req = { method, url: path, headers, socket: { remoteAddress: ip } };
  const res = mockRes();
  await routes.handleRequest(req, res, new URL(req.url, 'http://placeholder'));
  let body = null;
  try { body = JSON.parse(res._captured.body); } catch { /* kein JSON */ }
  return { status: res._captured.status, body };
}

const REBIND = { host: 'attacker.example:8080', origin: 'http://attacker.example:8080', 'content-type': 'text/plain' };

describe('DNS-Rebinding: fremder Name auf die Box-IP bekommt keinen Heimnetz-Freibrief', () => {
  it('Token rotieren und mitlesen klappt nicht', async () => {
    const ctx = mockCtx();
    const r = await call(ctx, { method: 'POST', path: '/api/admin/token/rotate', headers: REBIND });
    assert.notEqual(r.status, 200, `rotate darf nicht durchgehen: ${JSON.stringify(r.body)}`);
    assert.ok(!r.body?.token, 'kein neuer Token in der Antwort');
    assert.equal(ctx.getCfg().apiToken, API_TOKEN, 'Token unverändert');
  });

  for (const path of ['/api/admin/system/info', '/api/config/export', '/api/support/bundle', '/api/db/backup']) {
    it(`GET ${path} mit fremdem Host → 401`, async () => {
      const r = await call(mockCtx(), { path, headers: { host: 'attacker.example:8080' } });
      assert.equal(r.status, 401);
      assert.equal(r.body?.error, 'unauthorized');
    });
  }

  it('auch vom Box-Kiosk (Loopback) kein Freibrief bei fremdem Host', async () => {
    const r = await call(mockCtx(), { path: '/api/admin/system/info', headers: { host: 'attacker.example:8080' }, ip: LOOPBACK });
    assert.equal(r.status, 401);
  });

  it('Einrichtungsfenster (gibt den Token heraus) bleibt für fremde Namen zu', async () => {
    const ctx = mockCtx();
    ctx.needsSetup = () => true;
    const r = await call(ctx, { path: '/api/setup/state', headers: { host: 'attacker.example:8080' } });
    assert.equal(r.status, 403);
  });

  it('trustProxy: fremder X-Forwarded-Host verliert den Freibrief', async () => {
    const ctx = mockCtx({ trustProxy: true, trustedProxyIps: ['192.168.1.2'] });
    const r = await call(ctx, {
      path: '/api/admin/system/info',
      headers: { host: '192.168.1.50:8080', 'x-forwarded-host': 'attacker.example', 'x-forwarded-for': LAN_IP },
      ip: '192.168.1.2',
    });
    assert.equal(r.status, 401);
  });

  it('Verweigerung wird protokolliert, aber gedrosselt', async () => {
    const logs = [];
    const ctx = mockCtx({}, logs);
    const routes = createApiRoutes(ctx);
    for (let i = 0; i < 5; i++) {
      const req = { method: 'GET', url: '/api/admin/system/info', headers: { host: 'attacker.example:8080' }, socket: { remoteAddress: LAN_IP } };
      await routes.handleRequest(req, mockRes(), new URL(req.url, 'http://placeholder'));
    }
    const refused = logs.filter((l) => l.event === 'lan_bypass_refused_host');
    assert.equal(refused.length, 1, 'genau ein Eintrag für fünf gleiche Versuche');
    assert.equal(refused[0].data.host, 'attacker.example:8080');
  });
});

describe('DNS-Rebinding: Heimnetz-Bedienung bleibt ohne Token', () => {
  const LOCAL_HOSTS = [
    '192.168.1.50', '192.168.1.50:8080', '[fe80::1]:8080', '[::1]', '[2001:db8::5]:8080',
    'localhost', 'localhost:8080', 'dvhub', 'dvhub:8080', 'DVHUB.local', 'dvhub.local:8080',
    'dvhub.fritz.box', 'dvhub.fritz.box:8080', 'dvhub.home.arpa', 'dvhub.lan', 'dvhub.home',
    'dvhub.internal', 'dvhub.localdomain', 'speedport.ip', 'dvhub-a7s', 'dvhub.test',
  ];
  for (const host of LOCAL_HOSTS) {
    it(`Host ${host}: lesen und schreiben ohne Token`, async () => {
      const g = await call(mockCtx(), { path: '/api/admin/system/info', headers: { host } });
      assert.notEqual(g.status, 401, `GET mit Host ${host}`);
      const origin = `http://${host.toLowerCase()}`;
      const p = await call(mockCtx(), { method: 'POST', path: '/api/db/restore', headers: { host, origin } });
      assert.notEqual(p.status, 401, `POST mit Host ${host}: ${JSON.stringify(p.body)}`);
      assert.notEqual(p.body?.error, 'cors_origin_not_allowed');
    });
  }

  it('eigener Rechnername als FQDN zählt', async () => {
    const ctx = mockCtx();
    ctx.hostname = () => 'box17.example.org';
    const r = await call(ctx, { path: '/api/admin/system/info', headers: { host: 'box17.example.org:8080' } });
    assert.notEqual(r.status, 401);
  });

  it('allowedHosts-Eintrag zählt (Semantik unverändert)', async () => {
    const ctx = mockCtx({ allowedHosts: ['dvhub.example.com'] });
    const r = await call(ctx, { path: '/api/admin/system/info', headers: { host: 'dvhub.example.com' } });
    assert.notEqual(r.status, 401);
    const off = await call(ctx, { path: '/api/admin/system/info', headers: { host: 'attacker.example' } });
    assert.equal(off.status, 400, 'nicht gelisteter Host bleibt wie bisher 400');
  });

  it('trustProxy: Heimnetz-Name im X-Forwarded-Host behält den Freibrief', async () => {
    const ctx = mockCtx({ trustProxy: true, trustedProxyIps: ['192.168.1.2'] });
    const r = await call(ctx, {
      path: '/api/admin/system/info',
      headers: { host: '127.0.0.1:8080', 'x-forwarded-host': 'dvhub.local', 'x-forwarded-for': LAN_IP },
      ip: '192.168.1.2',
    });
    assert.notEqual(r.status, 401);
  });
});

describe('DNS-Rebinding: öffentlicher Name mit Token (Reverse-Proxy) geht weiter', () => {
  const AUTH = { authorization: `Bearer ${API_TOKEN}` };
  it('GET mit Token', async () => {
    const r = await call(mockCtx(), { path: '/api/admin/system/info', headers: { host: 'dvhub.example.com', ...AUTH } });
    assert.notEqual(r.status, 401);
  });
  it('POST von der eigenen Oberfläche mit Token', async () => {
    const r = await call(mockCtx(), {
      method: 'POST', path: '/api/db/restore',
      headers: { host: 'dvhub.example.com', origin: 'https://dvhub.example.com', ...AUTH },
    });
    assert.notEqual(r.status, 401);
    assert.notEqual(r.body?.error, 'cors_origin_not_allowed');
  });
  it('POST ohne Token bekommt 401 (Token-Hinweis der Oberfläche greift)', async () => {
    const r = await call(mockCtx(), {
      method: 'POST', path: '/api/db/restore',
      headers: { host: 'dvhub.example.com', origin: 'https://dvhub.example.com' },
    });
    assert.equal(r.status, 401);
  });
});

describe('isTrustedBoxHost (rein)', () => {
  const cfg = { allowedHosts: [] };
  it('vertraut lokalen Formen', () => {
    for (const h of ['', '10.0.0.5', '10.0.0.5:80', '[::1]:8080', 'localhost', 'x.localhost', 'nas', 'nas.', 'cerbo.local', 'pi.lan', 'a.fritz.box']) {
      assert.equal(isTrustedBoxHost(h, cfg), true, h);
    }
  });
  it('misstraut öffentlich auflösbaren Namen', () => {
    for (const h of ['attacker.example', 'attacker.example:8080', 'evil.com', 'fritz.box.evil.com', 'local.evil.com',
      'evilfritz.box', 'a.b.c.de', '192.168.1.5.nip.io', '[::1].evil.com', 'speedport.ip.evil.com']) {
      assert.equal(isTrustedBoxHost(h, cfg), false, h);
    }
  });
});
