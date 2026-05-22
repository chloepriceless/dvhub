// test/legal-gate-flip-route.test.js
//
// Phase 08 HUMAN-UAT #3 retroactive coverage — replaces the "factory-reset
// DVhub device" manual UAT step with an integration test that drives
// createApiRoutes(ctx) directly against a synthesized empty-config startup.
//
// The c36d23f fix (2026-05-10) made the setup wizard send
// `x-confirm-legal-gate: true` whenever `#legalAck` is ticked, so a fresh
// install can complete the EEG/§14a step. The server-side enforcement lives
// in routes-api.js POST /api/config (legal-gate flip detection block,
// LEGAL_GATE_PATHS = ['optimizer.allowGridCharge', 'optimizer.allowGridDischarge']).
//
// The pre-fix bug surface: on a brand-new device, those config keys do NOT
// exist. The wizard POSTs `optimizer.allowGridCharge: false` (and similar),
// which is `undefined → false` — the server flagged this as a "flip" and
// returned 403 unless the header was present. Without the wizard sending
// the header, the install path was broken.
//
// These tests exercise the gate logic itself, so the operator never has to
// wipe a production device to verify the fix still works.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createApiRoutes } from '../routes-api.js';

const REMOTE_IP = '203.0.113.5'; // TEST-NET-3 — never matches LAN allowlist
const API_TOKEN = crypto.randomBytes(32).toString('hex'); // 64 hex, ~256 bits — passes D-03 strength gate

function mockRes() {
  const captured = { status: 0, headers: {}, body: '' };
  return {
    writeHead(code, headers) {
      captured.status = code;
      Object.assign(captured.headers, headers);
    },
    end(payload) {
      captured.body = payload;
    },
    _captured: captured,
  };
}

function makeReq(pathname, { method = 'GET', token = API_TOKEN, body = null, extraHeaders = {} } = {}) {
  const bodyBuf = body != null ? Buffer.from(JSON.stringify(body)) : null;
  const stream = Readable.from(bodyBuf ? [bodyBuf] : []);
  stream.method = method;
  stream.url = pathname;
  stream.headers = { host: 'dvhub.test', ...extraHeaders };
  if (token) stream.headers.authorization = `Bearer ${token}`;
  if (body != null) stream.headers['content-type'] = 'application/json';
  stream.socket = { remoteAddress: REMOTE_IP };
  return stream;
}

// Build a mock ctx whose getCfg() returns a baseline that does NOT define
// optimizer.allowGridCharge / optimizer.allowGridDischarge. This mirrors a
// brand-new DVhub install — exactly the state factory-reset would create.
// Caller can override by passing `optimizerOverrides` to set the keys.
function mockCtx({
  optimizerOverrides = null,    // null = keys absent (fresh install); pass {} or {allowGridCharge:true} to set
  apiToken = API_TOKEN,
  pushLogSpy = null,
  saveAndApplyConfigSpy = null,
} = {}) {
  const optimizer = { enabled: false };
  if (optimizerOverrides) Object.assign(optimizer, optimizerOverrides);
  const cfg = {
    apiToken,
    apiTokenSessionTtlMs: null,
    epex: { enabled: false, timezone: 'Europe/Berlin' },
    optimizer,
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
    getServiceName: () => 'dvhub.service',
    getServiceUseSudo: () => false,
    runServiceCommand: async () => ({ ok: true }),
    controlValue: () => 'off',
    pushLog: (event, details, options) => {
      if (pushLogSpy) pushLogSpy.push({ event, details, options });
    },
    telemetrySafeWrite: () => {},
    needsSetup: () => false,
    epexNowNext: () => null,
    expireLeaseIfNeeded: () => {},
    buildSystemDiscoveryPayload: async () => ({ ok: true }),
    saveAndApplyConfig: (incoming) => {
      Object.assign(cfg, incoming);
      if (saveAndApplyConfigSpy) saveAndApplyConfigSpy.push(incoming);
      return { ok: true, changedPaths: [], restartRequired: false, restartRequiredPaths: [], loadedConfig: { exists: true, valid: true } };
    },
  };
}

async function dispatch(routes, req) {
  const res = mockRes();
  const url = new URL(req.url, `http://${req.headers.host}`);
  await routes.handleRequest(req, res, url);
  return res._captured;
}

describe('Phase 08 c36d23f — legal-gate flip detection on fresh install (covers HUMAN-UAT #3)', () => {

  it('fresh install: undefined → false flip on allowGridCharge is REJECTED with 403 when header is missing', async () => {
    // Baseline = no optimizer.allowGridCharge / allowGridDischarge keys at all
    // (mirrors a factory-reset DVhub, exactly the Phase 08 HUMAN-UAT scenario).
    const pushSpy = [];
    const ctx = mockCtx({ optimizerOverrides: null, pushLogSpy: pushSpy });
    const routes = createApiRoutes(ctx);
    const req = makeReq('/api/config', {
      method: 'POST',
      body: {
        config: {
          apiToken: API_TOKEN,
          optimizer: { enabled: false, allowGridCharge: false }
        }
      }
      // no x-confirm-legal-gate header → expect 403
    });
    const captured = await dispatch(routes, req);
    assert.equal(captured.status, 403, `expected 403, got ${captured.status} body=${captured.body}`);
    const body = JSON.parse(captured.body);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'legal_gate_flip_requires_confirmation');
    assert.ok(body.paths.includes('optimizer.allowGridCharge'), 'paths list must include allowGridCharge');
    // Audit log: rejection event must fire with the actor context.
    const reject = pushSpy.find(e => e.event === 'legal_gate_flip_rejected');
    assert.ok(reject, 'pushLog must emit legal_gate_flip_rejected on the failed flip');
    assert.deepEqual(reject.details.paths, ['optimizer.allowGridCharge']);
  });

  it('fresh install: undefined → false flip on allowGridCharge is ACCEPTED with 200 when x-confirm-legal-gate: true (the c36d23f path)', async () => {
    const pushSpy = [];
    const saveSpy = [];
    const ctx = mockCtx({ optimizerOverrides: null, pushLogSpy: pushSpy, saveAndApplyConfigSpy: saveSpy });
    const routes = createApiRoutes(ctx);
    const req = makeReq('/api/config', {
      method: 'POST',
      body: {
        config: {
          apiToken: API_TOKEN,
          optimizer: { enabled: false, allowGridCharge: false }
        }
      },
      extraHeaders: { 'x-confirm-legal-gate': 'true' }
    });
    const captured = await dispatch(routes, req);
    assert.equal(captured.status, 200, `expected 200, got ${captured.status} body=${captured.body}`);
    // Audit event: must fire legal_gate_flipped (NOT _rejected) with the flipped path list.
    const flipped = pushSpy.find(e => e.event === 'legal_gate_flipped');
    assert.ok(flipped, 'pushLog must emit legal_gate_flipped when the gate is confirmed');
    assert.deepEqual(flipped.details.paths, ['optimizer.allowGridCharge']);
    // saveAndApplyConfig must have been called with the new value persisted.
    assert.equal(saveSpy.length, 1, 'saveAndApplyConfig should be invoked exactly once on success');
    assert.equal(saveSpy[0].optimizer.allowGridCharge, false);
  });

  it('fresh install: both allowGridCharge AND allowGridDischarge flips together produce a 2-path event', async () => {
    const pushSpy = [];
    const ctx = mockCtx({ optimizerOverrides: null, pushLogSpy: pushSpy });
    const routes = createApiRoutes(ctx);
    const req = makeReq('/api/config', {
      method: 'POST',
      body: {
        config: {
          apiToken: API_TOKEN,
          optimizer: { enabled: false, allowGridCharge: false, allowGridDischarge: false }
        }
      },
      extraHeaders: { 'x-confirm-legal-gate': 'true' }
    });
    const captured = await dispatch(routes, req);
    assert.equal(captured.status, 200);
    const flipped = pushSpy.find(e => e.event === 'legal_gate_flipped');
    assert.ok(flipped);
    assert.deepEqual(flipped.details.paths.sort(), ['optimizer.allowGridCharge', 'optimizer.allowGridDischarge']);
  });

  it('fresh install: undefined → true flip (operator opts IN to grid-charge) ALSO requires the header', async () => {
    // Same gate logic applies symmetrically — turning a feature ON for the
    // first time still counts as a flip.
    const ctx = mockCtx({ optimizerOverrides: null });
    const routes = createApiRoutes(ctx);
    const req = makeReq('/api/config', {
      method: 'POST',
      body: {
        config: {
          apiToken: API_TOKEN,
          optimizer: { enabled: false, allowGridCharge: true }
        }
      }
      // no header → 403
    });
    const captured = await dispatch(routes, req);
    assert.equal(captured.status, 403);
    assert.equal(JSON.parse(captured.body).error, 'legal_gate_flip_requires_confirmation');
  });

  it('existing install: unchanged value (true → true) does NOT trigger the gate', async () => {
    // After the wizard has run once, the keys exist and re-saving the same
    // value (e.g. a normal settings POST that round-trips the whole config)
    // must NOT be flagged as a flip. before === after → no flip.
    const pushSpy = [];
    const ctx = mockCtx({
      optimizerOverrides: { allowGridCharge: true, allowGridDischarge: false },
      pushLogSpy: pushSpy
    });
    const routes = createApiRoutes(ctx);
    const req = makeReq('/api/config', {
      method: 'POST',
      body: {
        config: {
          apiToken: API_TOKEN,
          optimizer: { enabled: false, allowGridCharge: true, allowGridDischarge: false }
        }
      }
      // no header — must still succeed because no flip occurred
    });
    const captured = await dispatch(routes, req);
    assert.equal(captured.status, 200, `re-saving identical config must not 403; got ${captured.status}`);
    assert.equal(pushSpy.find(e => e.event === 'legal_gate_flipped'), undefined,
      'unchanged value must not emit legal_gate_flipped');
    assert.equal(pushSpy.find(e => e.event === 'legal_gate_flip_rejected'), undefined,
      'unchanged value must not emit legal_gate_flip_rejected');
  });

  it('existing install: real flip (true → false) STILL requires the header', async () => {
    // A genuine toggle on an existing device still counts as a flip — the
    // header gate is not a one-shot install bypass.
    const ctx = mockCtx({
      optimizerOverrides: { allowGridCharge: true }
    });
    const routes = createApiRoutes(ctx);
    const req = makeReq('/api/config', {
      method: 'POST',
      body: {
        config: {
          apiToken: API_TOKEN,
          optimizer: { enabled: false, allowGridCharge: false }
        }
      }
      // no header → 403
    });
    const captured = await dispatch(routes, req);
    assert.equal(captured.status, 403);
    assert.equal(JSON.parse(captured.body).error, 'legal_gate_flip_requires_confirmation');
  });

  it('POST body that omits the legal-gate keys entirely does NOT trigger the gate (after === undefined)', async () => {
    // Partial settings POSTs that don't touch the legal-gate paths at all
    // must pass without the header. The gate filter requires `after !==
    // undefined` so omitted keys are out of scope.
    const pushSpy = [];
    const ctx = mockCtx({ optimizerOverrides: null, pushLogSpy: pushSpy });
    const routes = createApiRoutes(ctx);
    const req = makeReq('/api/config', {
      method: 'POST',
      body: {
        config: {
          apiToken: API_TOKEN,
          optimizer: { enabled: true }
          // allowGridCharge / allowGridDischarge omitted → no flip
        }
      }
      // no header
    });
    const captured = await dispatch(routes, req);
    assert.equal(captured.status, 200);
    assert.equal(pushSpy.find(e => e.event === 'legal_gate_flipped'), undefined);
    assert.equal(pushSpy.find(e => e.event === 'legal_gate_flip_rejected'), undefined);
  });
});
