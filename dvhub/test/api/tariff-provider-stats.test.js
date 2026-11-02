// GET /api/tariff-provider/stats — Auswertung Anbieterpreis ↔ Day-Ahead
// (Christin 01.11.2026). Aufruf direkt über createApiRoutes, ohne Server/DB.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApiRoutes } from '../../routes-api.js';

const REMOTE_IP = '203.0.113.5'; // TEST-NET-3 — kein LAN
const API_TOKEN = 'tariff-stats-test-token-xxxxxxxxxxxxxxxxxx';

function mockRes() {
  const captured = { status: 0, headers: {}, body: '' };
  return {
    writeHead(code, headers) { captured.status = code; Object.assign(captured.headers, headers); },
    end(payload) { captured.body = payload; },
    _captured: captured
  };
}

function makeReq(pathname, { token = API_TOKEN } = {}) {
  const headers = { host: 'dvhub.test' };
  if (token) headers.authorization = `Bearer ${token}`;
  return { method: 'GET', url: pathname, headers, socket: { remoteAddress: REMOTE_IP } };
}

function mockCtx(tariffProvider) {
  const cfg = {
    apiToken: API_TOKEN, epex: { enabled: false, timezone: 'Europe/Berlin' }, optimizer: { enabled: false },
    schedule: { timezone: 'Europe/Berlin' }, telemetry: { enabled: false }, family: {}, corsAllowedOrigins: [], allowedHosts: [],
    notifications: { enabled: false, providers: {} }, integrations: {}
  };
  return {
    state: { epex: { ok: false, data: [] }, log: [], telemetry: { enabled: false } },
    getCfg: () => cfg, getRawCfg: () => cfg,
    getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }),
    pushLog: () => {}, telemetrySafeWrite: () => {}, needsSetup: () => false,
    tariffProvider
  };
}

async function dispatch(ctx, req) {
  const routes = createApiRoutes(ctx);
  const res = mockRes();
  await routes.handleRequest(req, res, new URL(req.url, `http://${req.headers.host}`));
  return res._captured;
}

describe('GET /api/tariff-provider/stats', () => {
  it('ohne Zugangsschlüssel von außen: 401', async () => {
    const r = await dispatch(mockCtx({ stats: async () => ({ ok: true }) }), makeReq('/api/tariff-provider/stats', { token: null }));
    assert.equal(r.status, 401);
  });

  it('reicht den Zeitraum durch und liefert die Kennzahlen', async () => {
    const seen = [];
    const ctx = mockCtx({ stats: async (q) => { seen.push(q); return { ok: true, provider: 'lichtblick', days: 7, pairs: 3 }; } });
    const r = await dispatch(ctx, makeReq('/api/tariff-provider/stats?days=7'));
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(seen, [{ days: '7' }]);
    assert.deepEqual(JSON.parse(r.body), { ok: true, provider: 'lichtblick', days: 7, pairs: 3 });
  });

  it('ohne Dienst 503, Fehler der Auswertung 500 ohne Absturz', async () => {
    assert.equal((await dispatch(mockCtx(undefined), makeReq('/api/tariff-provider/stats'))).status, 503);
    const r = await dispatch(mockCtx({ stats: async () => { throw new Error('db weg'); } }), makeReq('/api/tariff-provider/stats'));
    assert.equal(r.status, 500);
    assert.equal(JSON.parse(r.body).ok, false);
  });
});
