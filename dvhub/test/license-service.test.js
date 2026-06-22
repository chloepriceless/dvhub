// test/license-service.test.js — Unit tests for createLicenseService (Phase 17 Plan 02).
//
// Pattern source: test/smoke-phase05.test.js:784-822 (globalThis.fetch swap with try/finally).
// mockCtx factory mirrors test/family-api.test.js:13-128.
//
// Constraint (PROJECT.md): node:test + node:assert/strict ONLY. NO vitest.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLicenseService } from '../services/license/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an isolated mock-ctx with a per-test tmpdir so persist/reload tests
 * don't collide and so post-test 0600-mode checks have a clean file.
 */
function mockCtx(over = {}) {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'license-test-'));
  const state = {};
  const logs = [];
  const cfg = {
    licensing: { keygenAccount: 'test1' },
    ...(over.cfg || {})
  };
  return {
    state,
    appDir,
    getCfg: () => cfg,
    pushLog: (type, data) => logs.push({ type, data }),
    securityHeaders: { 'X-Test': '1' },
    _logs: logs,
    _appDir: appDir
  };
}

/**
 * Build a Keygen validate-key response body for the given status/code combo.
 */
function makeKeygenResponse({ valid, code, attributes = {}, id = 'lic-1' }) {
  return {
    data: {
      id,
      type: 'licenses',
      attributes: {
        status: 'ACTIVE',
        expiry: null,
        scheme: 'ED25519_SIGN',
        metadata: {},
        ...attributes
      }
    },
    meta: {
      valid,
      code,
      detail: valid ? 'is valid' : 'is not valid',
      ts: '2026-05-20T00:00:00Z'
    }
  };
}

/**
 * Install a mock globalThis.fetch for the duration of the callback. Returns
 * a captured-args array (one entry per fetch call) so tests can assert on
 * URL / body / init.
 */
async function withMockFetch(impl, cb) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return impl(url, init, calls.length);
  };
  try {
    await cb(calls);
  } finally {
    globalThis.fetch = real;
  }
}

// ---------------------------------------------------------------------------
// Tests — R-2/R-3/R-4 service surface (un-skipped from Plan 17-01 scaffold)
// ---------------------------------------------------------------------------

test('activate returns active on VALID response', async () => {
  await withMockFetch(
    async () => ({
      ok: true, status: 200,
      json: async () => makeKeygenResponse({ valid: true, code: 'VALID' })
    }),
    async () => {
      const ctx = mockCtx();
      const svc = createLicenseService(ctx);
      svc.loadStateFromDisk();
      const r = await svc.activateLicense('DVHB-XXXX-XXXX-XXXX-AAAA');
      assert.equal(r.ok, true);
      assert.equal(r.status, 'active');
      assert.equal(svc.getStatus(), 'active');
    }
  );
});

test('activate returns invalid on NOT_FOUND', async () => {
  await withMockFetch(
    async () => ({
      ok: true, status: 200,
      json: async () => ({
        data: null,
        meta: { valid: false, code: 'NOT_FOUND', detail: 'does not exist' }
      })
    }),
    async () => {
      const ctx = mockCtx();
      const svc = createLicenseService(ctx);
      svc.loadStateFromDisk();
      const r = await svc.activateLicense('BOGUS-KEY-1234');
      assert.equal(r.ok, false);
      assert.equal(r.status, 'invalid');
      assert.equal(svc.getStatus(), 'invalid');
    }
  );
});

test('activate maps SUSPENDED → suspended', async () => {
  await withMockFetch(
    async () => ({
      ok: true, status: 200,
      json: async () => makeKeygenResponse({
        valid: false, code: 'SUSPENDED',
        attributes: { status: 'SUSPENDED' }
      })
    }),
    async () => {
      const ctx = mockCtx();
      const svc = createLicenseService(ctx);
      svc.loadStateFromDisk();
      const r = await svc.activateLicense('DVHB-SUSP-XXXX-XXXX-AAAA');
      assert.equal(r.status, 'suspended');
      assert.equal(svc.getStatus(), 'suspended');
    }
  );
});

test('activate maps EXPIRED → expired', async () => {
  await withMockFetch(
    async () => ({
      ok: true, status: 200,
      json: async () => makeKeygenResponse({
        valid: false, code: 'EXPIRED',
        attributes: { status: 'EXPIRED' }
      })
    }),
    async () => {
      const ctx = mockCtx();
      const svc = createLicenseService(ctx);
      svc.loadStateFromDisk();
      const r = await svc.activateLicense('DVHB-EXPI-XXXX-XXXX-AAAA');
      assert.equal(r.status, 'expired');
      assert.equal(svc.getStatus(), 'expired');
    }
  );
});

test('activate maps BANNED → suspended (collapsed)', async () => {
  await withMockFetch(
    async () => ({
      ok: true, status: 200,
      json: async () => makeKeygenResponse({
        valid: false, code: 'BANNED',
        attributes: { status: 'BANNED' }
      })
    }),
    async () => {
      const ctx = mockCtx();
      const svc = createLicenseService(ctx);
      svc.loadStateFromDisk();
      const r = await svc.activateLicense('DVHB-BANN-XXXX-XXXX-AAAA');
      // BANNED collapses to 'suspended' (no separate banned-state in the 5-status enum)
      assert.equal(r.status, 'suspended');
    }
  );
});

test('network failure leaves state unchanged (permissive)', async () => {
  await withMockFetch(
    async () => { throw new TypeError('fetch failed: ECONNREFUSED'); },
    async () => {
      const ctx = mockCtx();
      const svc = createLicenseService(ctx);
      svc.loadStateFromDisk();
      svc.setStatusForTest('active');                // simulate prior-active state
      svc.setLicenseKeyForTest('DVHB-PREVIOUS-XXXX-AAAA');
      const r = await svc.revalidateLicense();
      assert.equal(r.ok, false);
      assert.equal(r.error, 'server_error');
      assert.equal(svc.getStatus(), 'active');       // permissive — state unchanged
    }
  );
});

test('timeout fires AbortSignal then retries once after 2s', async () => {
  // First call throws TimeoutError; second call succeeds. The 2 s real sleep
  // in fetchKeygen is a 2_000 ms wall-clock wait — keep this test's timeout
  // generous (node --test default is 30 s — plenty).
  await withMockFetch(
    async (url, init, callNum) => {
      if (callNum === 1) {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
      }
      return {
        ok: true, status: 200,
        json: async () => makeKeygenResponse({ valid: true, code: 'VALID' })
      };
    },
    async (calls) => {
      const ctx = mockCtx();
      const svc = createLicenseService(ctx);
      svc.loadStateFromDisk();
      const r = await svc.activateLicense('DVHB-RETRY-XXXX-XXXX-AAAA');
      assert.equal(calls.length, 2, 'expected exactly 1 retry');
      assert.equal(r.status, 'active');
    }
  );
});

test('corrupt license_state.json falls back to fresh none state with log', async () => {
  const ctx = mockCtx();
  // Write garbage to the license_state.json before service init
  const licensePath = path.join(ctx._appDir, 'license_state.json');
  fs.writeFileSync(licensePath, '{ this is not valid JSON', 'utf8');

  const svc = createLicenseService(ctx);
  svc.loadStateFromDisk();
  assert.equal(svc.getStatus(), 'none');
  const loadErrLogs = ctx._logs.filter(l => l.type === 'license_state_load_error');
  assert.equal(loadErrLogs.length, 1, 'expected one license_state_load_error log');
});

// --- Hardening A (2026-06-22): key-less `status:active` must never unlock Pro ---

test('Hardening A: loadStateFromDisk rejects status:active without a license_key', async () => {
  const ctx = mockCtx();
  // The trivial bypass attempt: a hand-written active state with no key.
  const licensePath = path.join(ctx._appDir, 'license_state.json');
  fs.writeFileSync(licensePath, JSON.stringify({ status: 'active' }), 'utf8');

  const svc = createLicenseService(ctx);
  svc.loadStateFromDisk();
  assert.equal(svc.getStatus(), 'none', 'key-less active must be downgraded to none');
  assert.ok(
    ctx._logs.some(l => l.type === 'license_state_active_without_key_rejected'),
    'rejection must be logged'
  );
});

test('Hardening A: loadStateFromDisk keeps active when a key is present (prod-safety)', async () => {
  const ctx = mockCtx();
  const licensePath = path.join(ctx._appDir, 'license_state.json');
  fs.writeFileSync(
    licensePath,
    JSON.stringify({ status: 'active', license_key: 'DVHB-REAL-XXXX-AAAA', license_id: 'lic-1' }),
    'utf8'
  );

  const svc = createLicenseService(ctx);
  svc.loadStateFromDisk();
  assert.equal(svc.getStatus(), 'active', 'active WITH key must survive load (mirrors prod)');
});

test('Hardening A: revalidateLicense resets a key-less active status to none', async () => {
  const ctx = mockCtx();
  const svc = createLicenseService(ctx);
  svc.loadStateFromDisk();
  // Simulate a tampered in-memory state: active but no key persisted.
  svc.setStatusForTest('active');
  const r = await svc.revalidateLicense();
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no_license_active');
  assert.equal(svc.getStatus(), 'none', 'key-less active must be forced to none by the poller');
  assert.ok(
    ctx._logs.some(l => l.type === 'license_revalidate_no_key_reset'),
    'reset must be logged'
  );
});

test('persist + reload roundtrip preserves status', async () => {
  await withMockFetch(
    async () => ({
      ok: true, status: 200,
      json: async () => makeKeygenResponse({ valid: true, code: 'VALID' })
    }),
    async () => {
      const ctx = mockCtx();
      const svc1 = createLicenseService(ctx);
      svc1.loadStateFromDisk();
      await svc1.activateLicense('DVHB-ROUND-TRIP-XXXX-AAAA');
      assert.equal(svc1.getStatus(), 'active');

      // Tear down and re-instantiate against the same disk file
      const ctx2 = {
        ...ctx,
        state: {},
        _logs: [],
        pushLog: (type, data) => ctx2._logs.push({ type, data })
      };
      const svc2 = createLicenseService(ctx2);
      svc2.loadStateFromDisk();
      assert.equal(svc2.getStatus(), 'active', 'status should survive reload');
      assert.equal(svc2.getState().key_fingerprint, 'AAAA');
    }
  );
});

test('whitespace-padded key activates as trimmed key', async () => {
  await withMockFetch(
    async () => ({
      ok: true, status: 200,
      json: async () => makeKeygenResponse({ valid: true, code: 'VALID' })
    }),
    async (calls) => {
      const ctx = mockCtx();
      const svc = createLicenseService(ctx);
      svc.loadStateFromDisk();
      const r = await svc.activateLicense('  DVHB-XXXX-XXXX-XXXX-AAAA  \n');
      assert.equal(r.status, 'active');
      // Assert the request body contains the trimmed key (no surrounding whitespace)
      assert.equal(calls.length, 1);
      const body = JSON.parse(calls[0].init.body);
      assert.equal(body.meta.key, 'DVHB-XXXX-XXXX-XXXX-AAAA',
        'request body must carry trimmed key');
    }
  );
});

test('empty key returns ok:false error:empty_key without fetching', async () => {
  await withMockFetch(
    async () => { throw new Error('fetch must not be called'); },
    async (calls) => {
      const ctx = mockCtx();
      const svc = createLicenseService(ctx);
      svc.loadStateFromDisk();
      const r = await svc.activateLicense('   \t\n  ');
      assert.equal(r.ok, false);
      assert.equal(r.error, 'empty_key');
      assert.equal(calls.length, 0, 'fetch must not be invoked for empty key');
    }
  );
});

test('missing keygenAccount returns ok:false error:keygen_account_not_configured', async () => {
  const prevEnv = process.env.KEYGEN_ACCOUNT;
  delete process.env.KEYGEN_ACCOUNT;
  await withMockFetch(
    async () => { throw new Error('fetch must not be called'); },
    async (calls) => {
      const ctx = mockCtx({ cfg: { licensing: { keygenAccount: '' } } });
      const svc = createLicenseService(ctx);
      svc.loadStateFromDisk();
      const r = await svc.activateLicense('DVHB-NOCFG-XXXX-XXXX-AAAA');
      assert.equal(r.ok, false);
      assert.equal(r.error, 'keygen_account_not_configured');
      assert.equal(calls.length, 0, 'fetch must not run when account-slug is missing');
    }
  );
  if (prevEnv !== undefined) process.env.KEYGEN_ACCOUNT = prevEnv;
});

test('floating mode — no scope.machine sent in request body', async () => {
  await withMockFetch(
    async () => ({
      ok: true, status: 200,
      json: async () => makeKeygenResponse({ valid: true, code: 'VALID' })
    }),
    async (calls) => {
      const ctx = mockCtx();
      const svc = createLicenseService(ctx);
      svc.loadStateFromDisk();
      await svc.activateLicense('DVHB-FLOAT-XXXX-XXXX-AAAA');
      assert.equal(calls.length, 1);
      const body = JSON.parse(calls[0].init.body);
      // Floating: no scope, no machine fingerprint sent
      assert.equal(body.meta?.scope, undefined, 'meta.scope must be absent');
      assert.equal(body.meta?.machine, undefined, 'meta.machine must be absent');
    }
  );
});

test('active → SUSPENDED transition triggers operator notification', async () => {
  await withMockFetch(
    async () => ({
      ok: true, status: 200,
      json: async () => makeKeygenResponse({
        valid: false, code: 'SUSPENDED',
        attributes: { status: 'SUSPENDED' }
      })
    }),
    async () => {
      // Use a fake config that pretends ntfy is enabled — the ntfy factory's
      // notify() will be invoked. We stub fetch which both the license-service
      // AND the ntfy provider call — both go through globalThis.fetch.
      //
      // Track ntfy POSTs separately so we can assert the provider was reached.
      const ntfyCalls = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        if (typeof url === 'string' && url.includes('license.dvhub.de')) {
          return {
            ok: true, status: 200,
            json: async () => makeKeygenResponse({
              valid: false, code: 'SUSPENDED',
              attributes: { status: 'SUSPENDED' }
            })
          };
        }
        // Treat anything else as the ntfy provider call
        ntfyCalls.push({ url, init });
        return { ok: true, status: 200, json: async () => ({}) };
      };

      try {
        const ctx = mockCtx({
          cfg: {
            licensing: { keygenAccount: 'test1' },
            notifications: {
              providers: {
                ntfy: { enabled: true, topicUrl: 'https://ntfy.example.com/dvhub-test' }
              }
            }
          }
        });
        const svc = createLicenseService(ctx);
        svc.loadStateFromDisk();
        // Simulate prior-active state with a persisted plaintext key
        svc.setStatusForTest('active');
        svc.setLicenseKeyForTest('DVHB-WASACT-XXXX-XXXX-AAAA');

        const r = await svc.revalidateLicense();
        assert.equal(r.status, 'suspended');

        // Allow the fire-and-forget notify path to flush
        await new Promise(resolve => setImmediate(resolve));

        assert.ok(ntfyCalls.length >= 1, 'ntfy provider must be called on active->suspended');
        assert.match(ntfyCalls[0].url, /ntfy\.example\.com/);
      } finally {
        globalThis.fetch = realFetch;
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Tests — additional Plan-17-02 guarantees (security + persistence shape)
// ---------------------------------------------------------------------------

test('getState() never returns plaintext license_key', async () => {
  await withMockFetch(
    async () => ({
      ok: true, status: 200,
      json: async () => makeKeygenResponse({ valid: true, code: 'VALID' })
    }),
    async () => {
      const ctx = mockCtx();
      const svc = createLicenseService(ctx);
      svc.loadStateFromDisk();
      const FULL_KEY = 'DVHB-FULL-PLAINTEXT-XXXX-AAAA';
      await svc.activateLicense(FULL_KEY);
      const exported = svc.getState();
      assert.equal(exported.license_key, null,
        'getState() must redact license_key to null');
      assert.equal(exported.key_fingerprint, 'AAAA',
        'fingerprint (last-4) is the only UI surface for the key');
      // Internal state still holds the full key for re-validate
      assert.equal(ctx.state.license.license_key, FULL_KEY);
    }
  );
});

test('persisted file has mode 0600', async () => {
  if (process.platform === 'win32') return; // POSIX-only mode-bit semantics

  await withMockFetch(
    async () => ({
      ok: true, status: 200,
      json: async () => makeKeygenResponse({ valid: true, code: 'VALID' })
    }),
    async () => {
      const ctx = mockCtx();
      const svc = createLicenseService(ctx);
      svc.loadStateFromDisk();
      await svc.activateLicense('DVHB-MODE-XXXX-XXXX-AAAA');
      const licensePath = path.join(ctx._appDir, 'license_state.json');
      const stat = fs.statSync(licensePath);
      const perms = stat.mode & 0o777;
      assert.equal(perms, 0o600,
        `expected mode 0600, got 0${perms.toString(8)}`);
    }
  );
});
