// test/token-lifecycle.test.js
//
// Plan 09-01 (REQ-9.1 token-lifecycle / token-entropy / token-audit-distinct):
//
// Verifies the token-lifecycle controls shipped by Plan 09-01:
//
//   D-01: apiTokenSessionTtlMs config knob exists with default null. (Round-trip
//         check against config-model.js createDefaultConfig.)
//   D-02: POST /api/admin/token/revoke returns 200 { restart: 'scheduled' } when
//         ctx.getServiceActionsEnabled() === true; returns 503 { error:
//         'service_actions_disabled' } when false. In BOTH cases the apiToken is
//         cleared in config.
//   D-03: validateApiTokenStrength enforces MIN_API_TOKEN_LENGTH = 32 and Shannon
//         entropy ≥ 3.5 bits/char. POST /api/config rejects sub-32 / low-entropy
//         tokens with HTTP 400 { error: 'token_too_short' / 'token_low_entropy' }.
//   D-04: tokenFingerprint returns 16 hex chars of sha256(token). pushLog audit
//         payload for token_rotated contains 16-hex newFingerprint and NEVER a
//         raw-token key.
//   D-05: POST /api/config with body.config.apiToken === '' is accepted (empty
//         stays a valid LAN-trust state).
//
// Harness: createApiRoutes(ctx) is driven directly with synthesised req/res
// objects (mirrors test/admin-rate-limit.test.js, which Plan 09-02 just shipped).
// A non-LAN source IP (203.0.113.5 — TEST-NET-3) prevents the LAN auth bypass
// from firing; Bearer carries the configured apiToken so checkAuth succeeds.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createApiRoutes,
  validateApiTokenStrength,
  tokenFingerprint,
  shannonEntropyBitsPerChar,
  MIN_API_TOKEN_LENGTH,
  TOKEN_FINGERPRINT_HEX_CHARS,
  MIN_API_TOKEN_ENTROPY_BITS_PER_CHAR
} from '../routes-api.js';
import { createDefaultConfig } from '../config-model.js';

const REMOTE_IP = '203.0.113.5'; // TEST-NET-3 — never LAN
// 64 hex chars, ~256 bits entropy — valid token that satisfies D-03 strength gate.
const API_TOKEN = crypto.randomBytes(32).toString('hex');

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

function makeReq(pathname, { method = 'GET', token = API_TOKEN, body = null } = {}) {
  // Use a Readable stream so parseBody's req.on('data') / req.on('end') drives.
  const bodyBuf = body != null ? Buffer.from(JSON.stringify(body)) : null;
  const stream = Readable.from(bodyBuf ? [bodyBuf] : []);
  // Attach the request-shape fields the handler reads directly.
  stream.method = method;
  stream.url = pathname;
  stream.headers = { host: 'dvhub.test' };
  if (token) stream.headers.authorization = `Bearer ${token}`;
  if (body != null) stream.headers['content-type'] = 'application/json';
  stream.socket = { remoteAddress: REMOTE_IP };
  return stream;
}

function mockCtx({
  serviceActionsEnabled = false,
  apiToken = API_TOKEN,
  saveAndApplyConfigSpy = null,
  pushLogSpy = null,
} = {}) {
  // Plan 09-01: minimal ctx surface for the rotate/revoke/config handlers.
  // saveAndApplyConfigSpy + pushLogSpy capture mutations + audit events.
  const cfg = {
    apiToken,
    apiTokenSessionTtlMs: null,
    epex: { enabled: false, timezone: 'Europe/Berlin' },
    optimizer: { enabled: false },
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
    getServiceActionsEnabled: () => serviceActionsEnabled,
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
    // Plan 09-01: saveAndApplyConfig is the writer for rotate + revoke. Spy
    // captures the FULL updated config so tests can assert apiToken value.
    saveAndApplyConfig: (incoming) => {
      // Mirror the in-memory update so subsequent getCfg() sees the new token.
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

// ── Unit-level constant + helper assertions ─────────────────────────────

describe('Plan 09-01 token-lifecycle constants (D-03 / D-04)', () => {
  it('D-03: MIN_API_TOKEN_LENGTH is 32', () => {
    assert.equal(MIN_API_TOKEN_LENGTH, 32);
  });

  it('D-04: TOKEN_FINGERPRINT_HEX_CHARS is 16', () => {
    assert.equal(TOKEN_FINGERPRINT_HEX_CHARS, 16);
  });

  it('D-03: MIN_API_TOKEN_ENTROPY_BITS_PER_CHAR is 3.5', () => {
    assert.equal(MIN_API_TOKEN_ENTROPY_BITS_PER_CHAR, 3.5);
  });

  it('D-01: createDefaultConfig sets apiTokenSessionTtlMs to null (no expiry)', () => {
    const cfg = createDefaultConfig();
    assert.equal(Object.prototype.hasOwnProperty.call(cfg, 'apiTokenSessionTtlMs'), true,
      'apiTokenSessionTtlMs must exist in defaults');
    assert.equal(cfg.apiTokenSessionTtlMs, null,
      'apiTokenSessionTtlMs default must be null (no automatic expiry, D-01)');
  });
});

describe('Plan 09-01 validateApiTokenStrength (D-03)', () => {
  it('rejects a sub-32-char token with token_too_short', () => {
    const r = validateApiTokenStrength('a'.repeat(31));
    assert.equal(r.ok, false);
    assert.equal(r.error, 'token_too_short');
  });

  it('rejects a low-entropy 64-char string with token_low_entropy', () => {
    const r = validateApiTokenStrength('a'.repeat(64));
    assert.equal(r.ok, false);
    assert.equal(r.error, 'token_low_entropy');
  });

  it('accepts crypto.randomBytes(32).toString(hex) — 64 chars, ~256 bits', () => {
    const r = validateApiTokenStrength(crypto.randomBytes(32).toString('hex'));
    assert.equal(r.ok, true);
  });

  it('rejects non-string input (defence-in-depth, never called with non-string in normal flow)', () => {
    const r = validateApiTokenStrength(null);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'token_not_string');
  });
});

describe('Plan 09-01 tokenFingerprint + shannonEntropyBitsPerChar (D-04)', () => {
  it('tokenFingerprint returns the first 16 hex chars of sha256(token)', () => {
    const fp = tokenFingerprint('abc');
    const expected = crypto.createHash('sha256').update('abc').digest('hex').slice(0, 16);
    assert.equal(fp, expected);
    assert.equal(fp.length, 16);
  });

  it('tokenFingerprint returns null for empty / non-string input', () => {
    assert.equal(tokenFingerprint(''), null);
    assert.equal(tokenFingerprint(null), null);
    assert.equal(tokenFingerprint(undefined), null);
  });

  it('shannonEntropyBitsPerChar of "aaaa" is 0 (zero entropy)', () => {
    assert.equal(shannonEntropyBitsPerChar('aaaa'), 0);
  });

  it('shannonEntropyBitsPerChar of a 64-hex random string exceeds 3.5', () => {
    const h = shannonEntropyBitsPerChar(crypto.randomBytes(32).toString('hex'));
    assert.ok(h >= 3.5, `expected entropy >= 3.5, got ${h}`);
  });
});

// ── Integration tests through createApiRoutes ───────────────────────────

describe('Plan 09-01 POST /api/config token-strength gate (D-03 + D-05)', () => {
  it('D-05: accepts apiToken: "" (empty stays valid — no entropy error)', async () => {
    const saveSpy = [];
    const ctx = mockCtx({ saveAndApplyConfigSpy: saveSpy });
    const routes = createApiRoutes(ctx);
    const req = makeReq('/api/config', { method: 'POST', body: { config: { apiToken: '' } } });
    const captured = await dispatch(routes, req);
    assert.notEqual(captured.status, 400,
      `D-05 binding: POST /api/config with empty apiToken must not return 400, got ${captured.status} body=${captured.body}`);
    // The save spy proves the writer received the empty value.
    assert.equal(saveSpy.length, 1, 'saveAndApplyConfig must be called exactly once');
    assert.equal(saveSpy[0].apiToken, '', 'persist payload apiToken must be the empty string (D-05)');
  });

  it('D-03: rejects a sub-32-char apiToken with 400 token_too_short', async () => {
    const ctx = mockCtx();
    const routes = createApiRoutes(ctx);
    const req = makeReq('/api/config', { method: 'POST', body: { config: { apiToken: 'tooshort' } } });
    const captured = await dispatch(routes, req);
    assert.equal(captured.status, 400);
    const body = JSON.parse(captured.body);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'token_too_short');
  });

  it('D-03: rejects a low-entropy 64-char apiToken with 400 token_low_entropy', async () => {
    const ctx = mockCtx();
    const routes = createApiRoutes(ctx);
    const req = makeReq('/api/config', { method: 'POST', body: { config: { apiToken: 'a'.repeat(64) } } });
    const captured = await dispatch(routes, req);
    assert.equal(captured.status, 400);
    const body = JSON.parse(captured.body);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'token_low_entropy');
  });

  it('accepts a strong randomBytes(32).toString(hex) apiToken', async () => {
    const saveSpy = [];
    const ctx = mockCtx({ saveAndApplyConfigSpy: saveSpy });
    const routes = createApiRoutes(ctx);
    const strongToken = crypto.randomBytes(32).toString('hex');
    const req = makeReq('/api/config', { method: 'POST', body: { config: { apiToken: strongToken } } });
    const captured = await dispatch(routes, req);
    assert.notEqual(captured.status, 400, `strong token must be accepted, got ${captured.status} body=${captured.body}`);
    assert.equal(saveSpy.length, 1);
    assert.equal(saveSpy[0].apiToken, strongToken);
  });

  it('D-01: apiTokenSessionTtlMs round-trips through POST /api/config without unknown_config_paths', async () => {
    const saveSpy = [];
    const ctx = mockCtx({ saveAndApplyConfigSpy: saveSpy });
    const routes = createApiRoutes(ctx);
    const req = makeReq('/api/config', { method: 'POST', body: { config: { apiTokenSessionTtlMs: 86400000 } } });
    const captured = await dispatch(routes, req);
    assert.notEqual(captured.status, 400,
      `apiTokenSessionTtlMs must be in ALLOWED_CONFIG_ROOTS, got ${captured.status} body=${captured.body}`);
  });
});

// ── /api/admin/token/rotate ─────────────────────────────────────────────

describe('Plan 09-01 POST /api/admin/token/rotate (D-04)', () => {
  it('returns 200 with token + 16-hex fingerprint; persists new token via saveAndApplyConfig', async () => {
    const saveSpy = [];
    const pushSpy = [];
    const ctx = mockCtx({ saveAndApplyConfigSpy: saveSpy, pushLogSpy: pushSpy });
    const routes = createApiRoutes(ctx);
    const req = makeReq('/api/admin/token/rotate', { method: 'POST' });
    const captured = await dispatch(routes, req);
    assert.equal(captured.status, 200, `expected 200, got ${captured.status} body=${captured.body}`);
    const body = JSON.parse(captured.body);
    assert.equal(body.ok, true);
    assert.equal(typeof body.token, 'string');
    assert.equal(body.token.length, 64, 'rotate must generate 64-hex (32-byte) token — D-04 strength');
    assert.equal(typeof body.fingerprint, 'string');
    assert.equal(body.fingerprint.length, 16, 'fingerprint must be 16 hex chars (D-04)');
    assert.equal(saveSpy.length, 1, 'saveAndApplyConfig must be called once');
    assert.equal(saveSpy[0].apiToken, body.token, 'persisted token must equal the returned token');
  });

  it('emits pushLog token_rotated with newFingerprint=16hex; NEVER includes raw token / apiToken / secret keys', async () => {
    const pushSpy = [];
    const ctx = mockCtx({ pushLogSpy: pushSpy });
    const routes = createApiRoutes(ctx);
    const req = makeReq('/api/admin/token/rotate', { method: 'POST' });
    const captured = await dispatch(routes, req);
    assert.equal(captured.status, 200);
    const rotated = pushSpy.find((e) => e.event === 'token_rotated');
    assert.ok(rotated, 'pushLog(token_rotated, ...) must fire on rotate');
    assert.equal(typeof rotated.details.newFingerprint, 'string');
    assert.equal(rotated.details.newFingerprint.length, 16, 'newFingerprint must be 16 hex chars (D-04)');
    // Negative: no raw-token-shaped keys in the audit payload.
    const forbiddenKeys = Object.keys(rotated.details).filter(
      (k) => /^(apitoken|token|newtoken|secret)$/i.test(k)
    );
    assert.deepEqual(forbiddenKeys, [],
      `audit details must NEVER contain raw token keys, found: ${forbiddenKeys.join(',')}`);
    // Severity is 'info' for rotate (vs 'warn' for revoke).
    assert.equal(rotated.options?.severity, 'info');
  });
});

// ── /api/admin/token/revoke ─────────────────────────────────────────────

describe('Plan 09-01 POST /api/admin/token/revoke (D-02 + D-04)', () => {
  it('D-02: returns 503 service_actions_disabled when getServiceActionsEnabled=false; still clears the token', async () => {
    const saveSpy = [];
    const pushSpy = [];
    const ctx = mockCtx({
      serviceActionsEnabled: false,
      saveAndApplyConfigSpy: saveSpy,
      pushLogSpy: pushSpy,
    });
    const routes = createApiRoutes(ctx);
    const req = makeReq('/api/admin/token/revoke', { method: 'POST' });
    const captured = await dispatch(routes, req);
    assert.equal(captured.status, 503,
      `D-02: revoke with service actions OFF must return 503, got ${captured.status} body=${captured.body}`);
    const body = JSON.parse(captured.body);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'service_actions_disabled');
    assert.equal(body.restart, 'not_available');
    // Token IS still cleared in config even when restart is unavailable.
    assert.equal(saveSpy.length, 1);
    assert.equal(saveSpy[0].apiToken, '', 'apiToken must still be cleared when service actions are disabled');
    // pushLog token_revoked still fires with severity 'warn'
    const revoked = pushSpy.find((e) => e.event === 'token_revoked');
    assert.ok(revoked, 'token_revoked audit entry must fire on every revoke (D-02)');
    assert.equal(revoked.options?.severity, 'warn');
    assert.equal(typeof revoked.details.revokedFingerprint, 'string');
    assert.equal(revoked.details.revokedFingerprint.length, 16, 'revokedFingerprint = 16 hex (D-04)');
  });

  it('D-02: returns 200 restart=scheduled when getServiceActionsEnabled=true', async () => {
    const saveSpy = [];
    const pushSpy = [];
    const ctx = mockCtx({
      serviceActionsEnabled: true,
      saveAndApplyConfigSpy: saveSpy,
      pushLogSpy: pushSpy,
    });
    const routes = createApiRoutes(ctx);
    const req = makeReq('/api/admin/token/revoke', { method: 'POST' });
    const captured = await dispatch(routes, req);
    assert.equal(captured.status, 200,
      `D-02: revoke with service actions ON must return 200, got ${captured.status} body=${captured.body}`);
    const body = JSON.parse(captured.body);
    assert.equal(body.ok, true);
    assert.equal(body.restart, 'scheduled');
    assert.equal(typeof body.revokedFingerprint, 'string');
    // Token is cleared.
    assert.equal(saveSpy.length, 1);
    assert.equal(saveSpy[0].apiToken, '');
    // pushLog token_revoked fires.
    const revoked = pushSpy.find((e) => e.event === 'token_revoked');
    assert.ok(revoked, 'token_revoked audit entry must fire');
    assert.equal(revoked.options?.severity, 'warn');
  });
});
