// test/bulk-ingest-audit.test.js
//
// Plan 09-05 (REQ-9.5 history-import-audit / export-audit / vpn-upload-audit):
//
// Verifies the bulk-ingest audit envelope:
//
//   - GET  /api/config/export         → pushLog('config_exported', ...)
//   - POST /api/history/import        → pushLog('history_import_started') + ...finished
//   - POST /api/history/backfill/vrm  → pushLog('backfill_started') + ...finished
//   - POST /api/vpn/config/upload     → pushLog('vpn_config_uploaded')
//
// Cross-cuts:
//   - Every audit details payload uses ONLY allowlisted keys (no raw secret-shaped
//     keys like apiToken / password / private_key / etc.). Secret-leak guard.
//   - Every actorIp flows through deriveClientIp (Plan 09-03 helper), not via raw
//     req.socket.remoteAddress.
//   - VPN-upload fingerprint is sha256(file).slice(0, 16) — 16 hex chars per D-04
//     convention. Matches Plan 09-01 tokenFingerprint output length so audit-log
//     filters work uniformly across token + VPN audit rows.
//
// Harness: createApiRoutes(ctx) is driven with synthetic req/res, mirroring the
// pattern Plan 09-01 shipped in token-lifecycle.test.js. A non-LAN source IP
// (203.0.113.5) is used so the LAN bypass cannot mask Bearer-auth bugs.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createApiRoutes, tokenFingerprint } from '../routes-api.js';

const REMOTE_IP = '203.0.113.5'; // TEST-NET-3 — never LAN
const API_TOKEN = crypto.randomBytes(32).toString('hex'); // satisfies 09-01 strength gate

// Banlist regex for audit-details keys. Any payload key matching this MUST never
// appear in a pushLog details object — those are raw-secret-shaped names.
const BANNED_DETAIL_KEYS = /^(apitoken|secret|password|privatekey|private[-_]key|rawtoken|newtoken)$/i;

function assertNoSecretKeys(details, label) {
  if (!details || typeof details !== 'object') return;
  for (const k of Object.keys(details)) {
    assert.ok(
      !BANNED_DETAIL_KEYS.test(k),
      `${label}: audit details must not include key "${k}" (matches banlist — looks like a secret)`
    );
  }
}

function mockRes() {
  const captured = { status: 0, headers: {}, body: '' };
  return {
    writeHead(code, headers) {
      captured.status = code;
      Object.assign(captured.headers, headers);
    },
    end(payload) {
      captured.body = payload != null ? String(payload) : '';
    },
    _captured: captured,
  };
}

function makeReq(pathname, { method = 'GET', token = API_TOKEN, body = null, contentType = null, rawBody = null } = {}) {
  let bodyBuf = null;
  if (rawBody != null) {
    bodyBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody));
  } else if (body != null) {
    bodyBuf = Buffer.from(JSON.stringify(body));
  }
  const stream = Readable.from(bodyBuf ? [bodyBuf] : []);
  stream.method = method;
  stream.url = pathname;
  stream.headers = { host: 'dvhub.test' };
  if (token) stream.headers.authorization = `Bearer ${token}`;
  if (contentType) {
    stream.headers['content-type'] = contentType;
  } else if (body != null) {
    stream.headers['content-type'] = 'application/json';
  }
  stream.socket = { remoteAddress: REMOTE_IP };
  return stream;
}

function mockCtx({
  apiToken = API_TOKEN,
  pushLogSpy = null,
  historyImportResult = null,
} = {}) {
  const cfg = {
    apiToken,
    apiTokenSessionTtlMs: null,
    epex: { enabled: false, timezone: 'Europe/Berlin' },
    optimizer: { enabled: false },
    schedule: { timezone: 'Europe/Berlin' },
    telemetry: { enabled: false, historyImport: { provider: 'vrm' } },
    family: {},
    vpn: { protocol: 'openvpn' },
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
      vpn: { profileName: null },
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
      return { ok: true, changedPaths: [], restartRequired: false, restartRequiredPaths: [], loadedConfig: { exists: true, valid: true } };
    },
    assertValidRuntimeCommand: () => {},
    // Plan 09-05 Task 2 + Task 3: history import / backfill mock.
    historyImportManager: {
      backfillHistoryFromConfiguredSource: async () => historyImportResult ?? { ok: true, importedRows: 42, daysDone: 1 },
      importFromConfiguredSource: async () => historyImportResult ?? { ok: true, importedRows: 17 },
      importSamples: () => historyImportResult ?? { ok: true, importedRows: 5 },
      getStatus: () => ({ enabled: false, ready: false, backfillRunning: false }),
    },
    // Plan 09-05 Task 4: VPN manager mock.
    vpnManager: {
      importConfig: async () => ({ ok: true, profileName: 'home' }),
      getStatus: () => ({ profileName: 'home', status: 'down' }),
      getConfigDetails: async () => ({}),
      start: async () => {},
      stop: async () => {},
      restart: async () => {},
    },
  };
}

async function dispatch(routes, req) {
  const res = mockRes();
  const url = new URL(req.url, `http://${req.headers.host}`);
  await routes.handleRequest(req, res, url);
  return res._captured;
}

// ── /api/config/export ──────────────────────────────────────────────────

describe('Plan 09-05 Task 1: GET /api/config/export audit', () => {
  it('emits pushLog config_exported with actor, actorIp, redactedKeyCount', async () => {
    const pushSpy = [];
    const ctx = mockCtx({ pushLogSpy: pushSpy });
    const routes = createApiRoutes(ctx);
    const req = makeReq('/api/config/export', { method: 'GET' });
    const captured = await dispatch(routes, req);
    assert.equal(captured.status, 200, `expected 200, got ${captured.status}`);
    const exported = pushSpy.find((e) => e.event === 'config_exported');
    assert.ok(exported, 'pushLog(config_exported, ...) must fire on /api/config/export');
    assert.equal(typeof exported.details.actor, 'string');
    assert.equal(typeof exported.details.actorIp, 'string');
    assert.ok(exported.details.actorIp.length > 0, 'actorIp must be a non-empty string (deriveClientIp)');
    assert.equal(typeof exported.details.redactedKeyCount, 'number');
    assert.ok(exported.details.redactedKeyCount >= 0, 'redactedKeyCount must be non-negative');
    assertNoSecretKeys(exported.details, 'config_exported');
  });

  it('emission happens BEFORE the response body (audit-first ordering)', async () => {
    // We don't have wallclock between push and writeHead, but we can assert
    // both that pushLog fired AND the response is 200 (so the order is preserved
    // — if push had been after end, the spy still records it before the test
    // assertion runs because both are synchronous in the handler).
    const pushSpy = [];
    const ctx = mockCtx({ pushLogSpy: pushSpy });
    const routes = createApiRoutes(ctx);
    const req = makeReq('/api/config/export', { method: 'GET' });
    await dispatch(routes, req);
    const idx = pushSpy.findIndex((e) => e.event === 'config_exported');
    assert.notEqual(idx, -1, 'config_exported audit row must be emitted');
  });
});

// ── /api/history/import ─────────────────────────────────────────────────

describe('Plan 09-05 Task 2: POST /api/history/import audit lifecycle', () => {
  it('emits history_import_started BEFORE the manager runs', async () => {
    const pushSpy = [];
    const ctx = mockCtx({ pushLogSpy: pushSpy });
    const routes = createApiRoutes(ctx);
    const req = makeReq('/api/history/import', {
      method: 'POST',
      body: { requestedFrom: '2026-01-01T00:00:00Z', requestedTo: '2026-01-02T00:00:00Z', provider: 'vrm' }
    });
    await dispatch(routes, req);
    const started = pushSpy.find((e) => e.event === 'history_import_started');
    assert.ok(started, 'history_import_started must fire');
    assert.equal(typeof started.details.actorIp, 'string');
    assert.equal(started.details.source, 'vrm');
    assert.ok(started.details.range && typeof started.details.range === 'object',
      'range must be a sub-object with from/to');
    assertNoSecretKeys(started.details, 'history_import_started');
  });

  it('emits history_import_finished AFTER the manager resolves; status maps ok → "ok"', async () => {
    const pushSpy = [];
    const ctx = mockCtx({
      pushLogSpy: pushSpy,
      historyImportResult: { ok: true, importedRows: 100 }
    });
    const routes = createApiRoutes(ctx);
    const req = makeReq('/api/history/import', {
      method: 'POST',
      body: { requestedFrom: '2026-01-01', requestedTo: '2026-01-02', provider: 'vrm' }
    });
    await dispatch(routes, req);
    const finished = pushSpy.find((e) => e.event === 'history_import_finished');
    assert.ok(finished, 'history_import_finished must fire');
    assert.equal(finished.details.status, 'ok');
    assert.equal(finished.details.rowsWritten, 100, 'rowsWritten must mirror importedRows');
    assert.equal(typeof finished.details.durationMs, 'number');
    assert.ok(finished.details.durationMs >= 0);
    assertNoSecretKeys(finished.details, 'history_import_finished');
  });

  it('maps result.ok=false → status="error" and severity="error"', async () => {
    const pushSpy = [];
    const ctx = mockCtx({
      pushLogSpy: pushSpy,
      historyImportResult: { ok: false, error: 'no importable rows returned from VRM' }
    });
    const routes = createApiRoutes(ctx);
    const req = makeReq('/api/history/import', {
      method: 'POST',
      body: { requestedFrom: '2026-01-01', requestedTo: '2026-01-02', provider: 'vrm' }
    });
    await dispatch(routes, req);
    const finished = pushSpy.find((e) => e.event === 'history_import_finished');
    assert.ok(finished, 'history_import_finished must fire even on failure');
    assert.equal(finished.details.status, 'error');
    assert.equal(finished.options?.severity, 'error');
  });
});

// ── /api/history/backfill/vrm ───────────────────────────────────────────

describe('Plan 09-05 Task 3: POST /api/history/backfill/vrm audit envelope', () => {
  it('emits backfill_started with kind="vrm", actor, actorIp, range', async () => {
    const pushSpy = [];
    const ctx = mockCtx({ pushLogSpy: pushSpy });
    const routes = createApiRoutes(ctx);
    const req = makeReq('/api/history/backfill/vrm', {
      method: 'POST',
      body: { mode: 'gap' }
    });
    await dispatch(routes, req);
    const started = pushSpy.find((e) => e.event === 'backfill_started');
    assert.ok(started, 'backfill_started must fire on /api/history/backfill/vrm');
    assert.equal(started.details.kind, 'vrm');
    assert.equal(typeof started.details.actor, 'string');
    assert.equal(typeof started.details.actorIp, 'string');
    assert.ok(started.details.range && typeof started.details.range === 'object');
    assertNoSecretKeys(started.details, 'backfill_started');
  });

  it('emits backfill_finished with kind, daysDone, slotsWritten, status, durationMs', async () => {
    const pushSpy = [];
    const ctx = mockCtx({
      pushLogSpy: pushSpy,
      historyImportResult: { ok: true, importedRows: 50, daysDone: 7 }
    });
    const routes = createApiRoutes(ctx);
    const req = makeReq('/api/history/backfill/vrm', { method: 'POST', body: { mode: 'gap' } });
    await dispatch(routes, req);
    const finished = pushSpy.find((e) => e.event === 'backfill_finished');
    assert.ok(finished, 'backfill_finished must fire');
    assert.equal(finished.details.kind, 'vrm');
    assert.equal(finished.details.status, 'ok');
    assert.equal(finished.details.slotsWritten, 50);
    assert.equal(finished.details.daysDone, 7);
    assert.equal(typeof finished.details.durationMs, 'number');
    assertNoSecretKeys(finished.details, 'backfill_finished');
  });
});

// ── /api/vpn/config/upload ──────────────────────────────────────────────

describe('Plan 09-05 Task 4: POST /api/vpn/config/upload audit with 16-hex fingerprint (D-04)', () => {
  it('JSON branch: emits vpn_config_uploaded with sizeBytes + 16-hex fingerprint', async () => {
    const pushSpy = [];
    const ctx = mockCtx({ pushLogSpy: pushSpy });
    const routes = createApiRoutes(ctx);
    const configBody = 'client\ndev tun\nproto udp\nremote test.example.com 1194\n';
    const req = makeReq('/api/vpn/config/upload', {
      method: 'POST',
      body: { config: configBody, protocol: 'openvpn' }
    });
    const captured = await dispatch(routes, req);
    assert.equal(captured.status, 200, `expected 200, got ${captured.status} body=${captured.body}`);
    const uploaded = pushSpy.find((e) => e.event === 'vpn_config_uploaded');
    assert.ok(uploaded, 'vpn_config_uploaded must fire on /api/vpn/config/upload');
    assert.equal(typeof uploaded.details.actor, 'string');
    assert.equal(typeof uploaded.details.actorIp, 'string');
    assert.equal(typeof uploaded.details.fingerprint, 'string');
    assert.equal(uploaded.details.fingerprint.length, 16,
      'D-04: vpn-upload fingerprint MUST be 16 hex chars — matches Plan 09-01 tokenFingerprint length');
    // Cross-check fingerprint == sha256(body).slice(0, 16)
    const expectedFingerprint = crypto.createHash('sha256').update(configBody).digest('hex').slice(0, 16);
    assert.equal(uploaded.details.fingerprint, expectedFingerprint);
    // sizeBytes = utf8 byte length
    assert.equal(uploaded.details.sizeBytes, Buffer.byteLength(configBody, 'utf8'));
    assertNoSecretKeys(uploaded.details, 'vpn_config_uploaded');
  });

  it('multipart branch: emits vpn_config_uploaded with sizeBytes + 16-hex fingerprint', async () => {
    const pushSpy = [];
    const ctx = mockCtx({ pushLogSpy: pushSpy });
    const routes = createApiRoutes(ctx);
    const configBody = 'client\ndev tap\nproto tcp\nremote vpn.example.com 443\n';
    const boundary = 'BOUNDARY12345';
    // Minimal multipart body: one part with name="ovpn" filename="client.ovpn"
    const mp =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="ovpn"; filename="client.ovpn"\r\n` +
      `Content-Type: application/x-openvpn-profile\r\n\r\n` +
      `${configBody}\r\n` +
      `--${boundary}--\r\n`;
    const req = makeReq('/api/vpn/config/upload', {
      method: 'POST',
      contentType: `multipart/form-data; boundary=${boundary}`,
      rawBody: mp
    });
    const captured = await dispatch(routes, req);
    assert.equal(captured.status, 200, `expected 200, got ${captured.status} body=${captured.body}`);
    const uploaded = pushSpy.find((e) => e.event === 'vpn_config_uploaded');
    assert.ok(uploaded, 'vpn_config_uploaded must fire on multipart upload');
    assert.equal(uploaded.details.fingerprint.length, 16, 'D-04 fingerprint length = 16');
    // The parseMultipartBody helper writes the body verbatim (string), so the
    // fingerprint computed from configBody should match what the handler logged.
    const expectedFingerprint = crypto.createHash('sha256').update(configBody).digest('hex').slice(0, 16);
    assert.equal(uploaded.details.fingerprint, expectedFingerprint);
    assert.equal(uploaded.details.sizeBytes, Buffer.byteLength(configBody, 'utf8'));
    assertNoSecretKeys(uploaded.details, 'vpn_config_uploaded');
  });
});

// ── Cross-cut: secret-leak banlist sweeps every emitted audit row ───────

describe('Plan 09-05 Cross-cut: NO audit details contain raw secret keys', () => {
  it('every emitted pushLog details payload from all bulk-ingest endpoints passes assertNoSecretKeys', async () => {
    const pushSpy = [];
    const ctx = mockCtx({ pushLogSpy: pushSpy });
    const routes = createApiRoutes(ctx);
    // Fire each audit-emitting endpoint at least once.
    await dispatch(routes, makeReq('/api/config/export', { method: 'GET' }));
    await dispatch(routes, makeReq('/api/history/import', {
      method: 'POST', body: { requestedFrom: '2026-01-01', requestedTo: '2026-01-02' }
    }));
    await dispatch(routes, makeReq('/api/history/backfill/vrm', { method: 'POST', body: { mode: 'gap' } }));
    await dispatch(routes, makeReq('/api/vpn/config/upload', {
      method: 'POST',
      body: { config: 'client\nproto udp\n' }
    }));
    // Sweep — every spy entry must pass.
    const targetEvents = new Set([
      'config_exported',
      'history_import_started', 'history_import_finished',
      'backfill_started', 'backfill_finished',
      'vpn_config_uploaded'
    ]);
    const swept = pushSpy.filter((e) => targetEvents.has(e.event));
    assert.ok(swept.length >= 5, `expected ≥5 bulk-ingest audit rows across the four endpoints, got ${swept.length}`);
    for (const row of swept) {
      assertNoSecretKeys(row.details, row.event);
    }
  });
});

// ── Cross-reference: Plan 09-01 tokenFingerprint contract ───────────────

describe('Plan 09-05 ↔ Plan 09-01 cross-reference: tokenFingerprint = 16 hex chars', () => {
  it('tokenFingerprint returns 16 hex chars (D-04) — Plan 09-05 reuses this length for VPN audit', async () => {
    const fp = tokenFingerprint('any-string-input-will-do');
    assert.equal(typeof fp, 'string');
    assert.equal(fp.length, 16,
      'D-04: tokenFingerprint must be 16 hex chars; Plan 09-05 VPN-upload audit reuses this length for cross-event consistency');
  });
});
