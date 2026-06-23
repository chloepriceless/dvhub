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
import crypto from 'node:crypto';

import { createLicenseService } from '../services/license/index.js';

// --- Hardening B helpers: mint a Keygen-format ED25519_SIGN key with an ephemeral keypair ---
function rawPubHex(publicKey) {
  return publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
}
function mintSignedKey(privateKey, payloadObj) {
  const payloadB64url = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
  const signingData = `key/${payloadB64url}`;
  const sig = crypto.sign(null, Buffer.from(signingData, 'utf8'), privateKey);
  return `${signingData}.${sig.toString('base64')}`;
}

// --- Hardening C helper: mint a Keygen-format offline machine file (node-lock) ---
function mintMachineFile(privateKey, fingerprint, expiry = null) {
  const dataset = {
    data: { type: 'machines', id: 'm1', attributes: { fingerprint, expiry } },
    included: [{ type: 'licenses', id: 'lic-1' }],
    meta: { expiry }
  };
  const enc = Buffer.from(JSON.stringify(dataset), 'utf8').toString('base64');
  const sig = crypto.sign(null, Buffer.from(`machine/${enc}`, 'utf8'), privateKey).toString('base64');
  const inner = Buffer.from(JSON.stringify({ enc, sig, alg: 'base64+ed25519' }), 'utf8').toString('base64');
  const wrapped = inner.replace(/(.{64})/g, '$1\n');       // PEM-style line wrap → exercise whitespace stripping
  return `-----BEGIN MACHINE FILE-----\n${wrapped}\n-----END MACHINE FILE-----\n`;
}

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

// --- Hardening B (2026-06-22): offline Ed25519 signature verification of signed keys ---

test('Hardening B: loadStateFromDisk keeps active for a validly-signed Keygen key', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const ctx = mockCtx();
  ctx.accountPublicKey = rawPubHex(publicKey);
  const signedKey = mintSignedKey(privateKey, { license: 'x', policy: 'p' });
  const licensePath = path.join(ctx._appDir, 'license_state.json');
  fs.writeFileSync(
    licensePath,
    JSON.stringify({ status: 'active', license_key: signedKey, license_id: 'lic-1' }),
    'utf8'
  );
  const svc = createLicenseService(ctx);
  svc.loadStateFromDisk();
  assert.equal(svc.getStatus(), 'active', 'a validly-signed key must stay active');
});

test('Hardening B: loadStateFromDisk rejects a tampered signed key', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const ctx = mockCtx();
  ctx.accountPublicKey = rawPubHex(publicKey);
  const signedKey = mintSignedKey(privateKey, { license: 'x' });
  const sig = signedKey.slice(signedKey.lastIndexOf('.') + 1);
  const forged = `key/${Buffer.from(JSON.stringify({ license: 'HACKED' }), 'utf8').toString('base64url')}.${sig}`;
  const licensePath = path.join(ctx._appDir, 'license_state.json');
  fs.writeFileSync(
    licensePath,
    JSON.stringify({ status: 'active', license_key: forged, license_id: 'lic-1' }),
    'utf8'
  );
  const svc = createLicenseService(ctx);
  svc.loadStateFromDisk();
  assert.equal(svc.getStatus(), 'none', 'a tampered signed key must be rejected');
  assert.ok(
    ctx._logs.some(l => l.type === 'license_state_signature_invalid'),
    'signature rejection must be logged'
  );
});

test('Hardening B: non-signed (legacy/test) keys bypass signature check (stay Stufe-A)', () => {
  const ctx = mockCtx();
  ctx.accountPublicKey = '2b8cc3310c0958f58bf9b9d3a52cb868f8f2c2260a679b5ebf4b41ed9038c5c3';
  const licensePath = path.join(ctx._appDir, 'license_state.json');
  fs.writeFileSync(
    licensePath,
    JSON.stringify({ status: 'active', license_key: 'DVHB-LEGACY-XXXX-AAAA', license_id: 'lic-1' }),
    'utf8'
  );
  const svc = createLicenseService(ctx);
  svc.loadStateFromDisk();
  assert.equal(svc.getStatus(), 'active', 'non key/-prefixed keys are not signature-checked');
});

// --- Hardening C (2026-06-22): offline node-lock — machine file ⇔ appliance-id ---

const NODELOCK_CFG = { cfg: { licensing: { keygenAccount: 'test1', nodeLock: true } } };

function writeNodeLockState(appDir, { signedKey, machineFile }) {
  fs.writeFileSync(
    path.join(appDir, 'license_state.json'),
    JSON.stringify({ status: 'active', license_key: signedKey, license_id: 'lic-1', machine_file: machineFile }),
    'utf8'
  );
}

test('Hardening C: node-lock keeps active when machine-file fingerprint == appliance-id', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const ctx = mockCtx(NODELOCK_CFG);
  ctx.accountPublicKey = rawPubHex(publicKey);
  const applianceId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
  fs.writeFileSync(path.join(ctx._appDir, 'appliance-id'), applianceId + '\n', 'utf8');
  writeNodeLockState(ctx._appDir, {
    signedKey: mintSignedKey(privateKey, { license: 'x' }),
    machineFile: mintMachineFile(privateKey, applianceId)
  });
  const svc = createLicenseService(ctx);
  svc.loadStateFromDisk();
  assert.equal(svc.getStatus(), 'active', 'matching fingerprint must stay active');
  assert.equal(svc.getState().machine_file, null, 'machine_file must never leak via getState()');
});

test('Hardening C: node-lock rejects when machine-file fingerprint != appliance-id', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const ctx = mockCtx(NODELOCK_CFG);
  ctx.accountPublicKey = rawPubHex(publicKey);
  fs.writeFileSync(path.join(ctx._appDir, 'appliance-id'), 'box-this\n', 'utf8');
  writeNodeLockState(ctx._appDir, {
    signedKey: mintSignedKey(privateKey, { license: 'x' }),
    machineFile: mintMachineFile(privateKey, 'box-other')      // bound to a DIFFERENT box
  });
  const svc = createLicenseService(ctx);
  svc.loadStateFromDisk();
  assert.equal(svc.getStatus(), 'none', 'a foreign-bound machine file must be rejected');
  assert.ok(
    ctx._logs.some(l => l.type === 'license_node_lock_fingerprint_mismatch'),
    'fingerprint mismatch must be logged'
  );
});

test('Hardening C: node-lock rejects when appliance-id is missing on this host', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const ctx = mockCtx(NODELOCK_CFG);
  ctx.accountPublicKey = rawPubHex(publicKey);
  // No appliance-id file written.
  writeNodeLockState(ctx._appDir, {
    signedKey: mintSignedKey(privateKey, { license: 'x' }),
    machineFile: mintMachineFile(privateKey, 'box-anything')
  });
  const svc = createLicenseService(ctx);
  svc.loadStateFromDisk();
  assert.equal(svc.getStatus(), 'none', 'cannot bind without a local appliance-id');
  assert.ok(ctx._logs.some(l => l.type === 'license_node_lock_no_appliance_id'));
});

test('Hardening C: node-lock rejects a machine file signed by the wrong key', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const other = crypto.generateKeyPairSync('ed25519');
  const ctx = mockCtx(NODELOCK_CFG);
  ctx.accountPublicKey = rawPubHex(publicKey);
  const applianceId = 'box-this';
  fs.writeFileSync(path.join(ctx._appDir, 'appliance-id'), applianceId + '\n', 'utf8');
  writeNodeLockState(ctx._appDir, {
    signedKey: mintSignedKey(privateKey, { license: 'x' }),       // license key is genuine (B passes)
    machineFile: mintMachineFile(other.privateKey, applianceId)   // machine file is forged
  });
  const svc = createLicenseService(ctx);
  svc.loadStateFromDisk();
  assert.equal(svc.getStatus(), 'none', 'a forged machine file must be rejected');
  assert.ok(ctx._logs.some(l => l.type === 'license_machine_file_invalid'));
});

test('Hardening C: node-lock OFF leaves a mismatched machine file inert (no enforcement)', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const ctx = mockCtx();                                          // nodeLock defaults OFF
  ctx.accountPublicKey = rawPubHex(publicKey);
  fs.writeFileSync(path.join(ctx._appDir, 'appliance-id'), 'box-this\n', 'utf8');
  writeNodeLockState(ctx._appDir, {
    signedKey: mintSignedKey(privateKey, { license: 'x' }),
    machineFile: mintMachineFile(privateKey, 'box-other')         // would mismatch IF enforced
  });
  const svc = createLicenseService(ctx);
  svc.loadStateFromDisk();
  assert.equal(svc.getStatus(), 'active', 'node-lock OFF must not enforce the binding');
});

test('Hardening C: node-lock ON with NO machine file is grandfathered (floating stays active)', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const ctx = mockCtx(NODELOCK_CFG);
  ctx.accountPublicKey = rawPubHex(publicKey);
  fs.writeFileSync(path.join(ctx._appDir, 'appliance-id'), 'box-this\n', 'utf8');
  fs.writeFileSync(
    path.join(ctx._appDir, 'license_state.json'),
    JSON.stringify({ status: 'active', license_key: mintSignedKey(privateKey, { license: 'x' }), license_id: 'lic-1' }),
    'utf8'
  );
  const svc = createLicenseService(ctx);
  svc.loadStateFromDisk();
  assert.equal(svc.getStatus(), 'active', 'a legacy floating licence (no machine file) is not enforced');
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

// --- Stufe C (2026-06-23): activateNodeLock — Server-Proxy activation flow ---
// The proxy mints the signed machine file; the appliance verifies it OFFLINE
// and only persists a file whose bound fingerprint == its own appliance-id.
const PROXY_CFG = {
  cfg: { licensing: { keygenAccount: 'test1', activationProxyUrl: 'https://proxy.test/activate' } }
};

test('activateNodeLock: proxy machine file (fp==appliance-id) verifies offline + persists', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const ctx = mockCtx(PROXY_CFG);
  ctx.accountPublicKey = rawPubHex(publicKey);
  const applianceId = 'box-alpha';
  fs.writeFileSync(path.join(ctx._appDir, 'appliance-id'), applianceId + '\n', 'utf8');
  const svc = createLicenseService(ctx);

  const machineFile = mintMachineFile(privateKey, applianceId);
  await withMockFetch(
    () => ({ ok: true, status: 200, json: async () => ({ ok: true, machineFile, machineId: 'mach-xyz' }) }),
    async (calls) => {
      const r = await svc.activateNodeLock('key/customer-key');
      assert.equal(r.ok, true);
      assert.equal(r.fingerprint, applianceId);
      assert.equal(r.machineId, 'mach-xyz');
      // Request hit the proxy with {licenseKey, applianceId}.
      assert.equal(calls[0].url, 'https://proxy.test/activate');
      const sent = JSON.parse(calls[0].init.body);
      assert.equal(sent.licenseKey, 'key/customer-key');
      assert.equal(sent.applianceId, applianceId);
      // Persisted, but NEVER leaked via getState().
      assert.equal(ctx.state.license.machine_file, machineFile);
      assert.equal(ctx.state.license.machine_id, 'mach-xyz');
      assert.equal(svc.getState().machine_file, null);
      assert.ok(ctx._logs.some(l => l.type === 'license_nodelock_bound'));
    }
  );
});

test('activateNodeLock: rejects a machine file bound to a DIFFERENT box (no persist)', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const ctx = mockCtx(PROXY_CFG);
  ctx.accountPublicKey = rawPubHex(publicKey);
  fs.writeFileSync(path.join(ctx._appDir, 'appliance-id'), 'box-this\n', 'utf8');
  const svc = createLicenseService(ctx);

  const machineFile = mintMachineFile(privateKey, 'box-other');  // bound elsewhere
  await withMockFetch(
    () => ({ ok: true, status: 200, json: async () => ({ ok: true, machineFile }) }),
    async () => {
      const r = await svc.activateNodeLock('key/customer-key');
      assert.equal(r.ok, false);
      assert.equal(r.error, 'fingerprint_mismatch');
      assert.equal(ctx.state.license.machine_file, null, 'must not persist a foreign-bound file');
      assert.ok(ctx._logs.some(l => l.type === 'license_nodelock_fingerprint_mismatch'));
    }
  );
});

test('activateNodeLock: rejects a machine file forged with the wrong key (no persist)', async () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const forger = crypto.generateKeyPairSync('ed25519');
  const ctx = mockCtx(PROXY_CFG);
  ctx.accountPublicKey = rawPubHex(publicKey);
  const applianceId = 'box-alpha';
  fs.writeFileSync(path.join(ctx._appDir, 'appliance-id'), applianceId + '\n', 'utf8');
  const svc = createLicenseService(ctx);

  const machineFile = mintMachineFile(forger.privateKey, applianceId);  // signed by wrong key
  await withMockFetch(
    () => ({ ok: true, status: 200, json: async () => ({ ok: true, machineFile }) }),
    async () => {
      const r = await svc.activateNodeLock('key/customer-key');
      assert.equal(r.ok, false);
      assert.equal(r.error, 'machine_file_invalid');
      assert.equal(ctx.state.license.machine_file, null);
      assert.ok(ctx._logs.some(l => l.type === 'license_nodelock_verify_failed'));
    }
  );
});

test('activateNodeLock: surfaces 409 machine_slot_taken with boundFingerprint (no persist)', async () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const ctx = mockCtx(PROXY_CFG);
  ctx.accountPublicKey = rawPubHex(publicKey);
  fs.writeFileSync(path.join(ctx._appDir, 'appliance-id'), 'box-this\n', 'utf8');
  const svc = createLicenseService(ctx);

  await withMockFetch(
    () => ({ ok: false, status: 409, json: async () => ({ ok: false, code: 'machine_slot_taken', boundFingerprint: 'box-other' }) }),
    async () => {
      const r = await svc.activateNodeLock('key/customer-key');
      assert.equal(r.ok, false);
      assert.equal(r.error, 'machine_slot_taken');
      assert.equal(r.status, 409);
      assert.equal(r.boundFingerprint, 'box-other');
      assert.equal(ctx.state.license.machine_file, null);
    }
  );
});

test('activateNodeLock: no appliance-id on this host → no_appliance_id without fetching', async () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const ctx = mockCtx(PROXY_CFG);
  ctx.accountPublicKey = rawPubHex(publicKey);
  // No appliance-id file written.
  const svc = createLicenseService(ctx);
  let fetched = false;
  await withMockFetch(
    () => { fetched = true; return { ok: true, status: 200, json: async () => ({}) }; },
    async () => {
      const r = await svc.activateNodeLock('key/customer-key');
      assert.equal(r.ok, false);
      assert.equal(r.error, 'no_appliance_id');
      assert.equal(fetched, false, 'must not contact the proxy without a local appliance-id');
    }
  );
});

// --- Hardening (2026-06-23): trusted-time high-water mark (Codex #4) ---
// Offline grace must not be rewindable by clock-rollback. The monotone
// high-water is taken from Keygen's meta.ts on every validate response.
function makeKeygenResponseTs(ts, over = {}) {
  return { ...makeKeygenResponse({ valid: true, code: 'VALID', ...over }), meta: { valid: true, code: 'VALID', ts } };
}

test('trusted-time: validate response records server meta.ts as the high-water', async () => {
  await withMockFetch(
    () => ({ ok: true, status: 200, json: async () => makeKeygenResponse({ valid: true, code: 'VALID' }) }),
    async () => {
      const ctx = mockCtx();
      const svc = createLicenseService(ctx);
      await svc.activateLicense('DVHB-TT-XXXX-XXXX-AAAA');
      // makeKeygenResponse sets meta.ts = '2026-05-20T00:00:00Z'.
      assert.equal(svc.getState().last_server_ts, '2026-05-20T00:00:00.000Z');
    }
  );
});

test('trusted-time: high-water is monotone — an older server ts is ignored', async () => {
  const ctx = mockCtx();
  const svc = createLicenseService(ctx);
  let n = 0;
  await withMockFetch(
    () => { n += 1; return { ok: true, status: 200, json: async () => makeKeygenResponseTs(n === 1 ? '2026-05-20T00:00:00Z' : '2026-01-01T00:00:00Z') }; },
    async () => {
      await svc.activateLicense('K1');         // high ts
      await svc.activateLicense('K2');         // earlier ts — must NOT lower the high-water
      assert.equal(svc.getState().last_server_ts, '2026-05-20T00:00:00.000Z');
    }
  );
});

test('trusted-time: trustedNowMs() floors at the high-water (rollback-resistant)', async () => {
  const ctx = mockCtx();
  const svc = createLicenseService(ctx);
  const future = '2999-01-01T00:00:00Z';
  await withMockFetch(
    () => ({ ok: true, status: 200, json: async () => makeKeygenResponseTs(future) }),
    async () => {
      await svc.activateLicense('K1');
      assert.ok(svc.trustedNowMs() >= Date.parse(future),
        'trusted now must never predate the server high-water');
    }
  );
});

test('trusted-time: loadStateFromDisk logs rollback when local clock is far behind high-water', () => {
  const ctx = mockCtx();
  fs.writeFileSync(
    path.join(ctx._appDir, 'license_state.json'),
    JSON.stringify({ status: 'active', license_key: 'LEGACY-KEY', last_server_ts: '2999-01-01T00:00:00Z' }),
    'utf8'
  );
  const svc = createLicenseService(ctx);
  svc.loadStateFromDisk();
  assert.ok(ctx._logs.some(l => l.type === 'license_clock_rollback_detected'),
    'a far-future high-water vs local now must be flagged');
});

// --- Hardening (2026-06-23): offline grace states from SIGNED expiry (Codex #5) ---
const DAY = 24 * 60 * 60 * 1000;
function loadNodeLocked({ expiry, lastServerTs = null }) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const ctx = mockCtx();                                   // nodeLock OFF — grace is independent
  ctx.accountPublicKey = rawPubHex(publicKey);
  const applianceId = 'box-grace';
  fs.writeFileSync(path.join(ctx._appDir, 'appliance-id'), applianceId + '\n', 'utf8');
  const machineFile = mintMachineFile(privateKey, applianceId, expiry);
  const rec = { status: 'active', license_key: 'LEGACY-KEY', machine_file: machineFile };
  if (lastServerTs) rec.last_server_ts = lastServerTs;
  fs.writeFileSync(path.join(ctx._appDir, 'license_state.json'), JSON.stringify(rec), 'utf8');
  const svc = createLicenseService(ctx);
  svc.loadStateFromDisk();
  return { svc, ctx };
}
const denyRes = () => ({ _code: 0, writeHead(c) { this._code = c; }, end() {} });

test('grace: node-locked with a FUTURE signed expiry → active', () => {
  const { svc } = loadNodeLocked({ expiry: new Date(Date.now() + 365 * DAY).toISOString() });
  assert.equal(svc.effectiveStatus(), 'active');
  assert.equal(svc.requirePro({}, denyRes(), 'family-dashboard'), true);
});

test('grace: signed expiry just passed (within 14d) → grace, Pro still allowed', () => {
  const { svc } = loadNodeLocked({ expiry: new Date(Date.now() - 1 * DAY).toISOString() });
  assert.equal(svc.effectiveStatus(), 'grace');
  assert.equal(svc.requirePro({}, denyRes(), 'family-dashboard'), true);
  assert.ok(svc.getState().grace_until, 'grace_until set for the UI countdown');
});

test('grace: signed expiry + 14d passed → effectiveStatus expired_offline (diagnostic; enforcement deferred)', () => {
  const { svc } = loadNodeLocked({ expiry: new Date(Date.now() - 20 * DAY).toISOString() });
  assert.equal(svc.effectiveStatus(), 'expired_offline');
  // Codex-Refute-v2: requirePro does NOT yet enforce expired_offline (would cut off
  // renewing monthly customers until the server re-checkout exists). Base status
  // active → still allowed; effective_status surfaces the state for the UI.
  assert.equal(svc.requirePro({}, denyRes(), 'family-dashboard'), true);
});

test('grace: perpetual/floating (no machine file) stays active offline (Christin A+D)', () => {
  const ctx = mockCtx();
  fs.writeFileSync(path.join(ctx._appDir, 'license_state.json'),
    JSON.stringify({ status: 'active', license_key: 'LEGACY-KEY' }), 'utf8');
  const svc = createLicenseService(ctx);
  svc.loadStateFromDisk();
  assert.equal(svc.effectiveStatus(), 'active');
  assert.equal(svc.getState().grace_until, null);
});

test('grace+replay defense: a trusted high-water past expiry+grace forces expired_offline', () => {
  // File would be in GRACE by wall-clock (expiry 1h ago), but the server-time
  // high-water has advanced 20 days → trustedNow > expiry+grace → expired.
  const { svc } = loadNodeLocked({
    expiry: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
    lastServerTs: new Date(Date.now() + 20 * DAY).toISOString()
  });
  assert.equal(svc.effectiveStatus(), 'expired_offline');
  // diagnostic-only (see above) — base status active still allows Pro for now.
  assert.equal(svc.requirePro({}, denyRes(), 'family-dashboard'), true);
});
