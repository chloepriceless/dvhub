// test/history-backfill-error.test.js -- GH #16 (FrodoVDR): der VRM-Nachimport
// meldete "internal server error" statt des eigentlichen Grunds. Wirft der
// Import (z. B. fehlender VRM-Token, VRM-API 401/5xx), fing die Route den
// Fehler nicht ab → generischer 500 ohne Text. Jetzt: 502 mit der Fehlermeldung
// und Log-Eintrag backfill_finished status=error.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createApiRoutes } from '../routes-api.js';

const TEST_TOKEN = 'x'.repeat(64);

function makeCtx(importManager) {
  const raw = { apiToken: TEST_TOKEN, trustProxy: true, trustedProxyIps: ['127.0.0.1'], allowedHosts: [], corsAllowedOrigins: [] };
  const logs = [];
  return {
    ctx: {
      state: {},
      pushLog: (event, details) => logs.push({ event, details }),
      getCfg: () => raw,
      getRawCfg: () => raw,
      needsSetup: () => false,
      getAppDir: () => process.cwd(),
      getAppVersion: () => ({ versionLabel: 'test' }),
      assertValidRuntimeCommand: () => ({}),
      historyImportManager: importManager
    },
    logs
  };
}

async function startHandler(ctx) {
  const routes = createApiRoutes(ctx);
  const srv = createServer((req, res) => {
    Promise.resolve()
      .then(() => routes.handleRequest(req, res, new URL(req.url, `http://${req.headers.host}`)))
      .then((handled) => { if (handled === false) routes.serveStatic(req, res); })
      .catch((e) => { if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'internal server error', detail: String(e && e.message) })); } });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, baseUrl: `http://127.0.0.1:${srv.address().port}` };
}

const headers = { 'Authorization': 'Bearer ' + TEST_TOKEN, 'Content-Type': 'application/json' };

describe('POST /api/history/backfill/vrm — Fehler aus dem Import werden benannt', () => {
  it('Import wirft → 502 mit Fehlertext, kein generischer 500', async () => {
    const { ctx, logs } = makeCtx({ backfillHistoryFromConfiguredSource: async () => { throw new Error('VRM API 401: token invalid'); } });
    const { srv, baseUrl } = await startHandler(ctx);
    after(() => new Promise((r) => srv.close(r)));
    const res = await fetch(baseUrl + '/api/history/backfill/vrm', { method: 'POST', headers, body: JSON.stringify({ mode: 'gap' }) });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /VRM API 401/);
    const fin = logs.find(l => l.event === 'backfill_finished');
    assert.ok(fin, 'backfill_finished geloggt');
    assert.equal(fin.details.status, 'error');
    assert.match(fin.details.error, /token invalid/);
  });

  it('Import liefert ok:false → 400 mit dem gelieferten Fehler (unverändert)', async () => {
    const { ctx } = makeCtx({ backfillHistoryFromConfiguredSource: async () => ({ ok: false, error: 'history import not configured' }) });
    const { srv, baseUrl } = await startHandler(ctx);
    after(() => new Promise((r) => srv.close(r)));
    const res = await fetch(baseUrl + '/api/history/backfill/vrm', { method: 'POST', headers, body: JSON.stringify({ mode: 'gap' }) });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'history import not configured');
  });

  it('Import ok → 200 (unverändert)', async () => {
    const { ctx } = makeCtx({ backfillHistoryFromConfiguredSource: async () => ({ ok: true, daysDone: 2, importedRows: 192 }) });
    const { srv, baseUrl } = await startHandler(ctx);
    after(() => new Promise((r) => srv.close(r)));
    const res = await fetch(baseUrl + '/api/history/backfill/vrm', { method: 'POST', headers, body: JSON.stringify({ mode: 'gap' }) });
    assert.equal(res.status, 200);
  });
});
