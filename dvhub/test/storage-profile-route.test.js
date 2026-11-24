// test/storage-profile-route.test.js — POST /api/storage/profile (Einstellungen →
// Speicher, „Vorschlag übernehmen“, Speicher-Konzept S2 a) und GET
// /api/storage/status mit Profil, Docker- und „Vollständig“-Hinweis.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiRoutes } from '../routes-api.js';

function mockRes() {
  const captured = { status: 0, body: '' };
  return { headersSent: false, setHeader() {}, writeHead(code) { captured.status = code; this.headersSent = true; }, end(p) { captured.body = p; }, _captured: captured };
}
function makeReq(method, url, body) {
  const raw = body == null ? '' : JSON.stringify(body);
  const req = {
    method, url, headers: { host: '127.0.0.1:8080', 'content-type': 'application/json', 'user-agent': 'Browser/1' },
    socket: { remoteAddress: '127.0.0.1' },
    on(ev, cb) {
      if (ev === 'data') setTimeout(() => { if (raw) cb(Buffer.from(raw)); req._end?.(); }, 0);
      else if (ev === 'end') req._end = cb;
      return req;
    },
    destroy() {},
  };
  return req;
}
const cfg = { schedule: { timezone: 'Europe/Berlin' }, security: { lanTrust: 'open' }, telemetry: { logRetention: { mode: 'full' } } };
function ctxWith(extra) {
  return {
    getCfg: () => cfg, getRawCfg: () => JSON.parse(JSON.stringify(cfg)), pushLog: () => {}, needsSetup: () => false,
    getAppDir: () => '/tmp', licenseService: { requirePro: () => true, isProActive: () => true }, processRole: 'monolith', state: {},
    ...extra,
  };
}
async function call(ctx, method, path, body) {
  const res = mockRes();
  await createApiRoutes(ctx).handleRequest(makeReq(method, path, body), res, new URL(`http://x${path}`));
  return { status: res._captured.status, body: JSON.parse(res._captured.body || '{}') };
}

test('POST /api/storage/profile: gültige Wahl geht an die Wache, ungültige → 400', async () => {
  const seen = [];
  const ctx = ctxWith({ chooseStorageProfile: async (c) => { seen.push(c); return { ok: true, mode: 'auto', base: 'klein' }; } });
  const ok = await call(ctx, 'POST', '/api/storage/profile', { choice: 'auto' });
  assert.equal(ok.status, 200);
  assert.deepEqual(seen, ['auto']);
  const bad = await call(ctx, 'POST', '/api/storage/profile', { choice: 'riesig' });
  assert.equal(bad.status, 400);
  assert.deepEqual(seen, ['auto']);
});

test('POST /api/storage/profile: Worker startet noch → 503', async () => {
  const ctx = ctxWith({ chooseStorageProfile: async () => ({ ok: false, error: 'runtime_worker_unavailable' }) });
  assert.equal((await call(ctx, 'POST', '/api/storage/profile', { choice: 'klein' })).status, 503);
});

test('GET /api/storage/status: Profil aus dem Lauf, Hinweise für Docker und „Vollständig“', async () => {
  const ctx = ctxWith({ storageGuard: { status: () => ({ level: 'ok', profile: { effective: 'klein' } }), compressionStatus: () => ({ ok: true }) } });
  const r = await call(ctx, 'GET', '/api/storage/status');
  assert.equal(r.status, 200);
  assert.equal(r.body.profile.effective, 'klein');
  assert.equal(r.body.logMode, 'full');
  assert.equal(typeof r.body.container, 'boolean');
});
