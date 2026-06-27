// test/onboarding-setup.test.js
//
// First-run onboarding (Aurora setup wizard, 2026-06-27). Covers the two
// halves of the feature:
//
//   1. config-model: an explicit setupCompleted:false (installer-seeded on a
//      FRESH box) forces needsSetup=true even when the config is present +
//      valid. Absent / true (legacy + completed boxes) leaves needsSetup driven
//      purely by exists/valid — no forced re-setup.
//
//   2. routes-api: the token-free, LAN/loopback-only setup window —
//        GET  /api/setup/state    → secrets-free prefill (NEVER the apiToken)
//        POST /api/setup/complete → persist plant config, flip setupCompleted,
//                                   hand the browser the real apiToken once.
//      Both reject non-LAN callers; complete refuses once the window is closed.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createDefaultConfig, loadConfigFile } from '../config-model.js';
import { createApiRoutes } from '../routes-api.js';

const LAN_IP = '192.168.1.50';
const REMOTE_IP = '203.0.113.5'; // TEST-NET-3 — never LAN
const API_TOKEN = crypto.randomBytes(24).toString('hex');

// ── Part 1: config-model needsSetup gate ────────────────────────────────
describe('onboarding: setupCompleted drives needsSetup', () => {
  // The repo's real Victron profile — copied next to each fixture so
  // loadConfigFile resolves a manufacturer profile and reports valid:true
  // (without it the config is valid:false and needsSetup is true for the wrong
  // reason, masking the setupCompleted gate we are actually testing).
  const victronProfile = fs.readFileSync(new URL('../hersteller/victron.json', import.meta.url), 'utf8');

  function writeConfig(extra) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-onboarding-'));
    fs.mkdirSync(path.join(dir, 'hersteller'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'hersteller', 'victron.json'), victronProfile);
    const file = path.join(dir, 'config.json');
    const base = { manufacturer: 'victron', apiToken: API_TOKEN, victron: { host: '192.168.1.20' } };
    fs.writeFileSync(file, JSON.stringify({ ...base, ...extra }, null, 2));
    return file;
  }

  it('createDefaultConfig defaults setupCompleted to true (legacy-safe)', () => {
    assert.equal(createDefaultConfig().setupCompleted, true);
  });

  it('explicit setupCompleted:false forces needsSetup even on a valid config', () => {
    const loaded = loadConfigFile(writeConfig({ setupCompleted: false }));
    assert.equal(loaded.exists, true);
    assert.equal(loaded.valid, true);
    assert.equal(loaded.needsSetup, true, 'a fresh installer box (setupCompleted:false) must show the wizard');
  });

  it('absent setupCompleted leaves needsSetup false (no forced re-setup on legacy boxes)', () => {
    const loaded = loadConfigFile(writeConfig({}));
    assert.equal(loaded.needsSetup, false, 'a legacy config without the key must NOT be forced into re-setup');
  });

  it('setupCompleted:true leaves needsSetup false (completed box)', () => {
    const loaded = loadConfigFile(writeConfig({ setupCompleted: true }));
    assert.equal(loaded.needsSetup, false);
  });
});

// ── Part 2: route-layer setup window ────────────────────────────────────
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

function makeReq(pathname, { method = 'GET', token = null, body = null, ip = LAN_IP } = {}) {
  const bodyBuf = body != null ? Buffer.from(JSON.stringify(body)) : null;
  const stream = Readable.from(bodyBuf ? [bodyBuf] : []);
  stream.method = method;
  stream.url = pathname;
  stream.headers = { host: 'dvhub.test' };
  if (token) stream.headers.authorization = `Bearer ${token}`;
  if (body != null) stream.headers['content-type'] = 'application/json';
  stream.socket = { remoteAddress: ip };
  return stream;
}

function mockCtx({ needsSetup = true, saveSpy = null, pushSpy = null } = {}) {
  const cfg = {
    apiToken: API_TOKEN,
    manufacturer: 'victron',
    victron: { host: '192.168.1.20' },
    forecast: { location: { latitude: 48.137154, longitude: 11.576124 } },
    epex: { enabled: false, timezone: 'Europe/Berlin' },
    optimizer: { enabled: false },
    schedule: { timezone: 'Europe/Berlin' },
    telemetry: { enabled: false },
    family: {},
    security: {},
    gridPositiveMeans: 'grid_import',
    keepalivePulseSec: 30,
    corsAllowedOrigins: [],
    allowedHosts: [],
  };
  let needs = needsSetup;
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
    getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: needs }),
    getConfigPath: () => '/tmp/config.json',
    getConfigDefinition: () => [],
    getAppVersion: () => ({ version: '0.9.0-test' }),
    getTransportType: () => 'modbus',
    getAppDir: () => os.tmpdir(),
    getRepoRoot: () => '/tmp',
    getServiceActionsEnabled: () => false,
    getServiceName: () => 'dvhub',
    getServiceUseSudo: () => false,
    runServiceCommand: async () => ({ ok: true }),
    controlValue: () => 'off',
    pushLog: (event, details, options) => { if (pushSpy) pushSpy.push({ event, details, options }); },
    telemetrySafeWrite: () => {},
    needsSetup: () => needs,
    epexNowNext: () => null,
    expireLeaseIfNeeded: () => {},
    buildSystemDiscoveryPayload: async () => ({ ok: true }),
    saveAndApplyConfig: (incoming) => {
      Object.assign(cfg, incoming);
      needs = incoming.setupCompleted === false; // mirror real loadConfigFile re-derivation
      if (saveSpy) saveSpy.push(incoming);
      return { ok: true, changedPaths: [], restartRequired: false, restartRequiredPaths: [], loadedConfig: { exists: true, valid: true } };
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

describe('onboarding: GET /api/setup/state', () => {
  it('LAN, token-free → 200 with secrets-free prefill (NO apiToken)', async () => {
    const captured = await dispatch(mockCtx(), makeReq('/api/setup/state', { ip: LAN_IP }));
    assert.equal(captured.status, 200, captured.body);
    const body = JSON.parse(captured.body);
    assert.equal(body.ok, true);
    assert.equal(body.needsSetup, true);
    assert.equal(body.manufacturer, 'victron');
    assert.equal(body.victronHost, '192.168.1.20');
    assert.equal(body.location.latitude, 48.137154);
    assert.ok(!('apiToken' in body), 'state must NEVER leak the apiToken');
    assert.ok(!JSON.stringify(body).includes(API_TOKEN), 'the real token must not appear anywhere in the state payload');
  });

  it('placeholder host (config.example.json 192.168.x.x) prefills as empty', async () => {
    const ctx = mockCtx();
    ctx.getCfg().victron.host = '192.168.x.x';
    const captured = await dispatch(ctx, makeReq('/api/setup/state', { ip: LAN_IP }));
    const body = JSON.parse(captured.body);
    assert.equal(body.victronHost, '');
  });

  it('non-LAN caller → 403 setup_window_lan_only', async () => {
    const captured = await dispatch(mockCtx(), makeReq('/api/setup/state', { ip: REMOTE_IP }));
    assert.equal(captured.status, 403);
    assert.equal(JSON.parse(captured.body).error, 'setup_window_lan_only');
  });
});

describe('onboarding: POST /api/setup/complete', () => {
  it('LAN, valid host+location → 200, saves setupCompleted:true and returns the real token', async () => {
    const saveSpy = [];
    const pushSpy = [];
    const ctx = mockCtx({ saveSpy, pushSpy });
    const captured = await dispatch(ctx, makeReq('/api/setup/complete', {
      method: 'POST', ip: LAN_IP,
      body: { victronHost: '192.168.1.77', location: { latitude: 50.5, longitude: 8.25 } },
    }));
    assert.equal(captured.status, 200, captured.body);
    const body = JSON.parse(captured.body);
    assert.equal(body.ok, true);
    assert.equal(body.apiToken, API_TOKEN, 'complete must hand the browser the real token to claim');
    assert.equal(body.redirect, '/');
    assert.equal(saveSpy.length, 1);
    assert.equal(saveSpy[0].setupCompleted, true);
    assert.equal(saveSpy[0].victron.host, '192.168.1.77');
    assert.equal(saveSpy[0].forecast.location.latitude, 50.5);
    assert.ok(pushSpy.some((e) => e.event === 'setup_completed'), 'must audit-log setup_completed');
    // Window now closed.
    assert.equal(ctx.needsSetup(), false);
  });

  it('LAN, host only (no location) → 200', async () => {
    const saveSpy = [];
    const captured = await dispatch(mockCtx({ saveSpy }), makeReq('/api/setup/complete', {
      method: 'POST', ip: LAN_IP, body: { victronHost: 'venus.local' },
    }));
    assert.equal(captured.status, 200, captured.body);
    assert.equal(saveSpy[0].victron.host, 'venus.local');
  });

  it('empty / missing host → 400 invalid_victron_host', async () => {
    const captured = await dispatch(mockCtx(), makeReq('/api/setup/complete', {
      method: 'POST', ip: LAN_IP, body: { victronHost: '   ' },
    }));
    assert.equal(captured.status, 400);
    assert.equal(JSON.parse(captured.body).error, 'invalid_victron_host');
  });

  it('host with a scheme/path is rejected → 400', async () => {
    const captured = await dispatch(mockCtx(), makeReq('/api/setup/complete', {
      method: 'POST', ip: LAN_IP, body: { victronHost: 'http://192.168.1.5/x' },
    }));
    assert.equal(captured.status, 400);
    assert.equal(JSON.parse(captured.body).error, 'invalid_victron_host');
  });

  it('out-of-range location → 400 invalid_location', async () => {
    const captured = await dispatch(mockCtx(), makeReq('/api/setup/complete', {
      method: 'POST', ip: LAN_IP, body: { victronHost: '192.168.1.5', location: { latitude: 999, longitude: 8 } },
    }));
    assert.equal(captured.status, 400);
    assert.equal(JSON.parse(captured.body).error, 'invalid_location');
  });

  it('window already closed (needsSetup=false) → 403 setup_already_completed', async () => {
    const captured = await dispatch(mockCtx({ needsSetup: false }), makeReq('/api/setup/complete', {
      method: 'POST', ip: LAN_IP, body: { victronHost: '192.168.1.5' },
    }));
    assert.equal(captured.status, 403);
    assert.equal(JSON.parse(captured.body).error, 'setup_already_completed');
  });

  it('non-LAN caller → 403 setup_window_lan_only (cannot complete from the WAN)', async () => {
    const captured = await dispatch(mockCtx(), makeReq('/api/setup/complete', {
      method: 'POST', ip: REMOTE_IP, body: { victronHost: '192.168.1.5' },
    }));
    assert.equal(captured.status, 403);
    assert.equal(JSON.parse(captured.body).error, 'setup_window_lan_only');
  });
});
