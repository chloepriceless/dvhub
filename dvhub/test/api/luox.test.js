// /api/luox* (T-0417): Zustand, Vertragsliste für die Auswahl, Verbindungstest,
// „Jetzt abrufen“, Abgleich der Direktvermarktung. Direkt über createApiRoutes,
// ohne Server/DB; Dienst nachgebaut.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApiRoutes } from '../../routes-api.js';

const REMOTE_IP = '203.0.113.5'; // TEST-NET-3 — kein LAN
const API_TOKEN = 'luox-route-test-token-xxxxxxxxxxxxxxxxxxxx';

function mockRes() {
  const captured = { status: 0, headers: {}, body: '' };
  return {
    writeHead(code, headers) { captured.status = code; Object.assign(captured.headers, headers); },
    end(payload) { captured.body = payload; },
    _captured: captured
  };
}

function makeReq(pathname, { token = API_TOKEN, method = 'GET', body = null } = {}) {
  const headers = { host: 'dvhub.test' };
  if (token) headers.authorization = `Bearer ${token}`;
  const req = { method, url: pathname, headers, socket: { remoteAddress: REMOTE_IP } };
  if (body != null) {
    const buf = Buffer.from(JSON.stringify(body));
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(buf.length);
    req[Symbol.asyncIterator] = async function* gen() { yield buf; };
    req.on = (ev, fn) => {
      if (ev === 'data') setImmediate(() => fn(buf));
      if (ev === 'end') setImmediate(() => setImmediate(fn));
      return req;
    };
  }
  return req;
}

function mockCtx(luox) {
  const cfg = {
    apiToken: API_TOKEN, epex: { enabled: false, timezone: 'Europe/Berlin' }, optimizer: { enabled: false },
    schedule: { timezone: 'Europe/Berlin' }, telemetry: { enabled: false }, family: {}, corsAllowedOrigins: [], allowedHosts: [],
    notifications: { enabled: false, providers: {} }, integrations: {}
  };
  const logs = [];
  return {
    state: { epex: { ok: false, data: [] }, log: [], telemetry: { enabled: false } },
    getCfg: () => cfg, getRawCfg: () => cfg,
    getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }),
    pushLog: (e, d) => logs.push({ e, d }), telemetrySafeWrite: () => {}, needsSetup: () => false,
    luox, logs
  };
}

async function dispatch(ctx, req) {
  const routes = createApiRoutes(ctx);
  const res = mockRes();
  await routes.handleRequest(req, res, new URL(req.url, `http://${req.headers.host}`));
  return res._captured;
}

describe('/api/luox', () => {
  it('ohne Zugangsschlüssel von außen: 401 (alle Routen)', async () => {
    for (const [p, method] of [['/api/luox', 'GET'], ['/api/luox/contracts', 'GET'], ['/api/luox/settlement', 'GET'], ['/api/luox/refresh', 'POST']]) {
      const r = await dispatch(mockCtx({}), makeReq(p, { token: null, method }));
      assert.equal(r.status, 401, p);
    }
  });

  it('Zustand', async () => {
    const r = await dispatch(mockCtx({ getState: () => ({ notice: 'x', portal: { configured: true } }) }), makeReq('/api/luox'));
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { ok: true, state: { notice: 'x', portal: { configured: true } } });
  });

  it('Vertragsliste: Art wird geprüft; Fehler lässt die Auswahl „automatisch“ bedienbar', async () => {
    const seen = [];
    const ok = await dispatch(mockCtx({ listContracts: async (q) => { seen.push(q); return { ok: true, options: [{ value: '', label: 'auto' }, { value: 'P1', label: 'P1' }] }; } }),
      makeReq('/api/luox/contracts?kind=producer'));
    assert.equal(ok.status, 200);
    assert.deepEqual(seen, [{ kind: 'producer', fresh: false }]);
    await dispatch(mockCtx({ listContracts: async (q) => { seen.push(q); return { ok: true, options: [] }; } }), makeReq('/api/luox/contracts?kind=../../x&fresh=1'));
    assert.deepEqual(seen[1], { kind: '', fresh: true });
    const err = await dispatch(mockCtx({ listContracts: async () => { throw Object.assign(new Error('E-Mail und Passwort fehlen'), { code: 'not_configured' }); } }),
      makeReq('/api/luox/contracts?kind=consumer'));
    assert.equal(err.status, 200);
    const body = JSON.parse(err.body);
    assert.equal(body.ok, false);
    assert.equal(body.code, 'not_configured');
    assert.deepEqual(body.options.map((o) => o.value), ['']);
  });

  it('Abgleich: Zeitraum wird durchgereicht; ohne Dienst 503', async () => {
    const seen = [];
    const r = await dispatch(mockCtx({ settlementReport: async (q) => { seen.push(q); return { ok: true, days: [] }; } }), makeReq('/api/luox/settlement?days=14'));
    assert.equal(r.status, 200);
    assert.deepEqual(seen, [{ days: '14' }]);
    assert.equal((await dispatch(mockCtx(undefined), makeReq('/api/luox/settlement'))).status, 503);
  });

  it('Jetzt abrufen: Ergebnis + Zustand', async () => {
    const r = await dispatch(mockCtx({ refresh: async () => ({ ok: true, dayAhead: { today: 96 } }), getState: () => ({ portal: { configured: true } }) }),
      makeReq('/api/luox/refresh', { method: 'POST', body: {} }));
    assert.equal(r.status, 200, r.body);
    const body = JSON.parse(r.body);
    assert.equal(body.dayAhead.today, 96);
    assert.equal(body.state.portal.configured, true);
  });
});
