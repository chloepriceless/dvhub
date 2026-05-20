// test/license-routes.test.js — HTTP route tests for /api/license/* (Phase 17 Plan 03).
//
// Pattern source: test/smoke-phase05.test.js — createApiRoutes(ctx) + mockRes +
// makeReq with on('data')/on('end') shim. mockCtx mirrors test/family-api.test.js
// but keeps the surface tight (only the fields routes-api.js destructures).
//
// R-1 (operator can activate/state/revalidate/remove) and R-5 (revalidate
// shares poller code path) covered here. R-6 (Family-route gating) tests
// remain skipped — Plan 04 owns the gate wiring.
//
// Constraint (PROJECT.md): node:test + node:assert/strict ONLY. NO vitest.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApiRoutes } from '../routes-api.js';
import { createLicenseService } from '../services/license/index.js';

// ---------------------------------------------------------------------------
// Helpers — mockRes / makeReq / mockCtx
// ---------------------------------------------------------------------------

function mockRes() {
  const captured = { status: 0, headers: {}, body: '' };
  return {
    writeHead(code, headers) { captured.status = code; Object.assign(captured.headers, headers); },
    end(payload) { captured.body = payload; },
    _captured: captured
  };
}

// makeReq(method, urlPath[, body])
// The on('data') / on('end') shim emits the JSON-stringified body so
// parseBody() in server-utils.js can read it.
function makeReq(method, urlPath, body) {
  const rawBody = body ? JSON.stringify(body) : '';
  const headers = { host: 'localhost' };
  const req = {
    method,
    url: urlPath,
    headers,
    socket: { remoteAddress: '127.0.0.1' }, // LAN-bypass for checkAuth
    _body: rawBody,
    _listeners: {},
    on(event, cb) {
      if (event === 'data' && req._body) {
        setTimeout(() => cb(Buffer.from(req._body)), 0);
        setTimeout(() => {
          const endCb = req._listeners['end'];
          if (endCb) endCb();
        }, 1);
      } else if (event === 'end' && !req._body) {
        setTimeout(() => cb(), 0);
      } else {
        req._listeners[event] = cb;
      }
      return req;
    },
    destroy() { req._destroyed = true; }
  };
  return req;
}

/**
 * Build an isolated ctx with a real licenseService wired in. Per-test tmpdir
 * for license_state.json so persist/reload paths don't collide.
 */
function mockCtx(over = {}) {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'license-routes-test-'));
  const state = {};
  const logs = [];
  const cfg = {
    apiToken: 'test-token-not-used-because-LAN-bypass',
    licensing: { keygenAccount: 'test1' },
    family: {},
    telemetry: { enabled: false },
    epex: { enabled: false, timezone: 'Europe/Berlin' },
    schedule: { timezone: 'Europe/Berlin' },
    notifications: { providers: {} },
    ...(over.cfg || {})
  };
  const licenseService = createLicenseService({
    state,
    getCfg: () => cfg,
    pushLog: (type, data) => logs.push({ type, data }),
    appDir,
    securityHeaders: {}
  });
  // Minimal surface routes-api.js needs at construct time + at /api/license/*
  // handler time. Anything unused stays as a no-op stub to keep the test
  // boundary tight.
  const ctx = {
    state,
    getCfg: () => cfg,
    pushLog: (type, data) => logs.push({ type, data }),
    telemetrySafeWrite: () => {},
    licenseService,
    transport: { type: 'modbus' },
    persistConfig: () => {},
    setForcedOff: () => {},
    clearForcedOff: () => {},
    expireLeaseIfNeeded: () => {},
    getServiceActionsEnabled: () => false,
    getServiceName: () => 'dvhub',
    getServiceUseSudo: () => false,
    buildRuntimeRouteMeta: () => ({ ready: true, busy: false, queueDepth: 0 }),
    buildFallbackStatusPayload: () => ({}),
    getRawCfg: () => cfg,
    getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }),
    getConfigDefinition: () => [],
    getAppVersion: () => ({ versionLabel: '1.0.0-test' }),
    getTransportType: () => 'modbus',
    getAppDir: () => appDir,
    getRepoRoot: () => '/tmp',
    scanTransport: {},
    fetchEpexDay: async () => {},
    fetchVrmForecast: async () => {},
    saveAndApplyConfig: () => ({ ok: true, changedPaths: [], restartRequired: false, restartRequiredPaths: [] }),
    scheduleServiceRestart: () => {},
    runServiceCommand: async () => ({ ok: true }),
    epexNowNext: () => null,
    applyControlTarget: async () => ({ ok: true }),
    controlValue: () => 'off',
    needsSetup: () => false,
    getConfigPath: () => '/tmp/config.json',
    historyApi: null,
    historyImportManager: null,
    assertValidRuntimeCommand: () => {},
    _logs: logs,
    _appDir: appDir
  };
  return ctx;
}

function makeValidKeygenResponse(code = 'VALID') {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        id: 'lic-test-1',
        type: 'licenses',
        attributes: { status: 'ACTIVE', expiry: null, scheme: 'ED25519_SIGN', metadata: {} }
      },
      meta: { valid: code === 'VALID', code, detail: 'is valid', ts: '2026-05-20T00:00:00Z' }
    })
  };
}

function makeNotFoundKeygenResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: null,
      meta: { valid: false, code: 'NOT_FOUND', detail: 'does not exist', ts: '2026-05-20T00:00:00Z' }
    })
  };
}

async function withMockFetch(impl, cb) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return impl(url, init, calls.length);
  };
  try { await cb(calls); } finally { globalThis.fetch = real; }
}

function urlFor(p) { return new URL('http://localhost' + p); }

// ---------------------------------------------------------------------------
// R-1 — /api/license/activate
// ---------------------------------------------------------------------------

test('POST /api/license/activate persists state and returns 200 ok:true on VALID', async () => {
  await withMockFetch(
    async () => makeValidKeygenResponse('VALID'),
    async (fetchCalls) => {
      const ctx = mockCtx();
      const routes = createApiRoutes(ctx);
      const res = mockRes();
      await routes.handleRequest(
        makeReq('POST', '/api/license/activate', { key: 'DVHB-AAAA-BBBB-CCCC-DDDD' }),
        res,
        urlFor('/api/license/activate')
      );
      assert.equal(res._captured.status, 200, `expected 200, got ${res._captured.status} body=${res._captured.body}`);
      const body = JSON.parse(res._captured.body);
      assert.equal(body.ok, true);
      assert.equal(body.status, 'active');
      assert.equal(body.code, 'VALID');
      assert.equal(fetchCalls.length, 1, 'one keygen request');
      assert.ok(fetchCalls[0].url.includes('/v1/accounts/test1/licenses/actions/validate-key'));
      // Persisted state reflects active license + fingerprint
      const persisted = JSON.parse(fs.readFileSync(path.join(ctx._appDir, 'license_state.json'), 'utf8'));
      assert.equal(persisted.status, 'active');
      assert.equal(persisted.key_fingerprint, 'DDDD');
    }
  );
});

test('POST /api/license/activate returns 422 ok:false on NOT_FOUND', async () => {
  await withMockFetch(
    async () => makeNotFoundKeygenResponse(),
    async () => {
      const ctx = mockCtx();
      const routes = createApiRoutes(ctx);
      const res = mockRes();
      await routes.handleRequest(
        makeReq('POST', '/api/license/activate', { key: 'DVHB-WRONG-KEY' }),
        res,
        urlFor('/api/license/activate')
      );
      assert.equal(res._captured.status, 422, `expected 422, got ${res._captured.status} body=${res._captured.body}`);
      const body = JSON.parse(res._captured.body);
      assert.equal(body.ok, false);
      assert.equal(body.status, 'invalid');
      assert.equal(body.code, 'NOT_FOUND');
    }
  );
});

test('POST /api/license/activate rejects empty key with 400', async () => {
  let fetchCalled = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; return makeValidKeygenResponse(); };
  try {
    const ctx = mockCtx();
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    await routes.handleRequest(
      makeReq('POST', '/api/license/activate', { key: '   ' }),
      res,
      urlFor('/api/license/activate')
    );
    assert.equal(res._captured.status, 400, `expected 400, got ${res._captured.status} body=${res._captured.body}`);
    const body = JSON.parse(res._captured.body);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'empty_key');
    assert.equal(fetchCalled, false, 'fetch must not be called for empty key');
  } finally { globalThis.fetch = realFetch; }
});

// ---------------------------------------------------------------------------
// R-1 — /api/license/state (redaction)
// ---------------------------------------------------------------------------

test('GET /api/license/state returns masked fingerprint, never full key', async () => {
  await withMockFetch(
    async () => makeValidKeygenResponse('VALID'),
    async () => {
      const ctx = mockCtx();
      const routes = createApiRoutes(ctx);
      // First activate so the service has a non-empty state.
      const actRes = mockRes();
      await routes.handleRequest(
        makeReq('POST', '/api/license/activate', { key: 'DVHB-XXXX-XXXX-XXXX-AAAA' }),
        actRes,
        urlFor('/api/license/activate')
      );
      assert.equal(actRes._captured.status, 200);

      // Then GET /state — the body MUST NOT contain the full key.
      const res = mockRes();
      await routes.handleRequest(
        makeReq('GET', '/api/license/state'),
        res,
        urlFor('/api/license/state')
      );
      assert.equal(res._captured.status, 200);
      const body = JSON.parse(res._captured.body);
      assert.equal(body.status, 'active');
      assert.equal(body.key_fingerprint, 'AAAA');
      // The response MUST redact the plaintext key.
      assert.equal(body.license_key, null, 'plaintext key must NEVER be returned');
      // Defense in depth: response body must not contain the plaintext key anywhere.
      assert.ok(!res._captured.body.includes('DVHB-XXXX-XXXX-XXXX-AAAA'),
        'plaintext key must NOT appear in the response body anywhere');
    }
  );
});

// ---------------------------------------------------------------------------
// R-5 — /api/license/revalidate
// ---------------------------------------------------------------------------

test('POST /api/license/revalidate triggers same code path as poller', async () => {
  await withMockFetch(
    async () => makeValidKeygenResponse('VALID'),
    async (fetchCalls) => {
      const ctx = mockCtx();
      const routes = createApiRoutes(ctx);
      // Activate first so revalidate has a persisted key to reuse.
      await routes.handleRequest(
        makeReq('POST', '/api/license/activate', { key: 'DVHB-FOR-REVAL' }),
        mockRes(),
        urlFor('/api/license/activate')
      );
      assert.equal(fetchCalls.length, 1);

      const res = mockRes();
      await routes.handleRequest(
        makeReq('POST', '/api/license/revalidate', {}),
        res,
        urlFor('/api/license/revalidate')
      );
      assert.equal(res._captured.status, 200, `expected 200, got ${res._captured.status} body=${res._captured.body}`);
      const body = JSON.parse(res._captured.body);
      assert.equal(body.ok, true);
      assert.equal(body.status, 'active');
      assert.equal(fetchCalls.length, 2, 'revalidate must hit the same validate-key endpoint');
      assert.ok(fetchCalls[1].url.includes('/v1/accounts/test1/licenses/actions/validate-key'),
        'revalidate uses same Keygen URL as activate');
    }
  );
});

test('POST /api/license/revalidate returns 503 when no license has been activated', async () => {
  // No prior activate -> license_key=null -> service returns
  // { ok:false, error:'no_license_active' }. Route maps to 503 (server-side
  // misconfig — caller can't fix it by retrying).
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('fetch must not be called'); };
  try {
    const ctx = mockCtx();
    const routes = createApiRoutes(ctx);
    const res = mockRes();
    await routes.handleRequest(
      makeReq('POST', '/api/license/revalidate', {}),
      res,
      urlFor('/api/license/revalidate')
    );
    assert.equal(res._captured.status, 503);
    const body = JSON.parse(res._captured.body);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'no_license_active');
  } finally { globalThis.fetch = realFetch; }
});

// ---------------------------------------------------------------------------
// R-1 — /api/license/remove
// ---------------------------------------------------------------------------

test('POST /api/license/remove resets status to none', async () => {
  await withMockFetch(
    async () => makeValidKeygenResponse('VALID'),
    async () => {
      const ctx = mockCtx();
      const routes = createApiRoutes(ctx);
      // Activate first.
      await routes.handleRequest(
        makeReq('POST', '/api/license/activate', { key: 'DVHB-REMOVEME' }),
        mockRes(),
        urlFor('/api/license/activate')
      );
      // Then remove.
      const res = mockRes();
      await routes.handleRequest(
        makeReq('POST', '/api/license/remove', {}),
        res,
        urlFor('/api/license/remove')
      );
      assert.equal(res._captured.status, 200);
      const body = JSON.parse(res._captured.body);
      assert.equal(body.ok, true);
      assert.equal(body.status, 'none');
      // Subsequent GET /state shows status=none, license_id=null.
      const stateRes = mockRes();
      await routes.handleRequest(
        makeReq('GET', '/api/license/state'),
        stateRes,
        urlFor('/api/license/state')
      );
      assert.equal(stateRes._captured.status, 200);
      const sb = JSON.parse(stateRes._captured.body);
      assert.equal(sb.status, 'none');
      assert.equal(sb.license_id, null);
      assert.equal(sb.license_key, null);
    }
  );
});

// ---------------------------------------------------------------------------
// R-6 — Family-route gating (still skipped — Plan 04 owns this wave)
// ---------------------------------------------------------------------------

test.skip('GET /api/family/status returns 403 pro_required when license !== active', async () => {
  // TODO: implement in Plan 17-04 — see 17-PATTERNS.md §Two-gate pattern
  // state.license.status='none' -> requirePro returns false -> 403 body:{error:'pro_required', feature:'family-dashboard'}
  assert.ok(true);
});

test.skip('GET /api/family/status returns 200 when license === active', async () => {
  // TODO: implement in Plan 17-04
  // state.license.status='active' -> requirePro returns true -> handler runs -> 200
  assert.ok(true);
});

test.skip('GET /api/family/presence returns 403 pro_required when license !== active', async () => {
  // TODO: implement in Plan 17-04 — see 17-PATTERNS.md (all 7 /api/family/* handlers)
  assert.ok(true);
});

test.skip('GET /api/family/tile-history returns 403 pro_required when license !== active', async () => {
  // TODO: implement in Plan 17-04
  assert.ok(true);
});

test.skip('GET /api/family/tesla-history returns 403 pro_required when license !== active', async () => {
  // TODO: implement in Plan 17-04
  assert.ok(true);
});

test.skip('GET /family page returns 403 pro_required when license !== active', async () => {
  // TODO: implement in Plan 17-04 — see 17-CONTEXT.md D-08 (static-file serving for family.html/.js/.css)
  // GET /family.html with no license -> 403 pro_required (not the static file)
  assert.ok(true);
});
