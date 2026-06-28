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
// 2026-06-28: the gate now triggers ONLY on the ENABLE transition
// (after === true && before !== true). The original "any before !== after"
// rule still mis-fired on installs that don't run the wizard at all — any page
// that round-trips the whole config POSTs `allowGridCharge: false` against an
// undefined stored value (undefined → false) and got 403'd, even though grid-
// charge was never touched (reported on a fresh Pi). Materialising an unset
// gate to false, and disabling a gate (→ false), are not legal changes and now
// pass without the header; only turning a gate ON requires confirmation.
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

describe('legal-gate flip detection — gate the ENABLE transition only (covers HUMAN-UAT #3)', () => {

  it('fresh install: undefined → false on allowGridCharge is ACCEPTED without header (no false-positive flip)', async () => {
    // Baseline = no optimizer.allowGridCharge / allowGridDischarge keys at all
    // (mirrors a factory-reset DVhub). Materialising an unset gate to false is
    // not a legal change — it must NOT 403, even without the confirm header.
    // This is the 2026-06-28 fix for the fresh-Pi "Speichern fehlgeschlagen:
    // legal_gate_flip_requires_confirmation" report.
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
      // no x-confirm-legal-gate header → must still succeed (not an enable)
    });
    const captured = await dispatch(routes, req);
    assert.equal(captured.status, 200, `undefined→false must not 403; got ${captured.status} body=${captured.body}`);
    assert.equal(pushSpy.find(e => e.event === 'legal_gate_flip_rejected'), undefined,
      'materialising to false must not be rejected');
    assert.equal(pushSpy.find(e => e.event === 'legal_gate_flipped'), undefined,
      'materialising to false is not an enable → no legal_gate_flipped');
  });

  it('fresh install: undefined → true (opt IN to grid-charge) WITHOUT header is REJECTED 403', async () => {
    // Turning the gate ON is the §14a-relevant direction — still gated.
    const pushSpy = [];
    const ctx = mockCtx({ optimizerOverrides: null, pushLogSpy: pushSpy });
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
    assert.equal(captured.status, 403, `expected 403, got ${captured.status} body=${captured.body}`);
    const body = JSON.parse(captured.body);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'legal_gate_flip_requires_confirmation');
    assert.ok(body.paths.includes('optimizer.allowGridCharge'), 'paths list must include allowGridCharge');
    const reject = pushSpy.find(e => e.event === 'legal_gate_flip_rejected');
    assert.ok(reject, 'pushLog must emit legal_gate_flip_rejected on the blocked enable');
    assert.deepEqual(reject.details.paths, ['optimizer.allowGridCharge']);
  });

  it('fresh install: undefined → true WITH x-confirm-legal-gate: true is ACCEPTED 200 + audited', async () => {
    const pushSpy = [];
    const saveSpy = [];
    const ctx = mockCtx({ optimizerOverrides: null, pushLogSpy: pushSpy, saveAndApplyConfigSpy: saveSpy });
    const routes = createApiRoutes(ctx);
    const req = makeReq('/api/config', {
      method: 'POST',
      body: {
        config: {
          apiToken: API_TOKEN,
          optimizer: { enabled: false, allowGridCharge: true }
        }
      },
      extraHeaders: { 'x-confirm-legal-gate': 'true' }
    });
    const captured = await dispatch(routes, req);
    assert.equal(captured.status, 200, `expected 200, got ${captured.status} body=${captured.body}`);
    const flipped = pushSpy.find(e => e.event === 'legal_gate_flipped');
    assert.ok(flipped, 'pushLog must emit legal_gate_flipped when the enable is confirmed');
    assert.deepEqual(flipped.details.paths, ['optimizer.allowGridCharge']);
    assert.equal(saveSpy.length, 1, 'saveAndApplyConfig should be invoked exactly once on success');
    assert.equal(saveSpy[0].optimizer.allowGridCharge, true);
  });

  it('fresh install: both allowGridCharge AND allowGridDischarge enabled together produce a 2-path event', async () => {
    const pushSpy = [];
    const ctx = mockCtx({ optimizerOverrides: null, pushLogSpy: pushSpy });
    const routes = createApiRoutes(ctx);
    const req = makeReq('/api/config', {
      method: 'POST',
      body: {
        config: {
          apiToken: API_TOKEN,
          optimizer: { enabled: false, allowGridCharge: true, allowGridDischarge: true }
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

  it('existing install: unchanged value (true → true) does NOT trigger the gate', async () => {
    // After the wizard has run once, the keys exist and re-saving the same
    // value (e.g. a normal settings POST that round-trips the whole config)
    // must NOT be flagged as a flip. already-ON, still-ON → no enable.
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
      // no header — must still succeed because no enable occurred
    });
    const captured = await dispatch(routes, req);
    assert.equal(captured.status, 200, `re-saving identical config must not 403; got ${captured.status}`);
    assert.equal(pushSpy.find(e => e.event === 'legal_gate_flipped'), undefined,
      'unchanged value must not emit legal_gate_flipped');
    assert.equal(pushSpy.find(e => e.event === 'legal_gate_flip_rejected'), undefined,
      'unchanged value must not emit legal_gate_flip_rejected');
  });

  it('existing install: DISABLE (true → false) is ACCEPTED without header (turning OFF is never gated)', async () => {
    // Disabling grid-charge/discharge is the safe direction — it can never
    // create a §14a violation — so it must pass without the confirm header.
    const pushSpy = [];
    const ctx = mockCtx({
      optimizerOverrides: { allowGridCharge: true },
      pushLogSpy: pushSpy
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
      // no header — disabling must still succeed
    });
    const captured = await dispatch(routes, req);
    assert.equal(captured.status, 200, `disabling must not 403; got ${captured.status} body=${captured.body}`);
    assert.equal(pushSpy.find(e => e.event === 'legal_gate_flip_rejected'), undefined,
      'disabling must not be rejected');
    assert.equal(pushSpy.find(e => e.event === 'legal_gate_flipped'), undefined,
      'disabling is not an enable → no legal_gate_flipped (covered by generic config_saved audit)');
  });

  it('existing install: re-enable (false → true) STILL requires the header', async () => {
    // Turning the gate back ON on an existing device still needs confirmation —
    // the header gate is not a one-shot install bypass.
    const ctx = mockCtx({
      optimizerOverrides: { allowGridCharge: false }
    });
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
