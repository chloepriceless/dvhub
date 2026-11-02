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

// GH #32 (stefan-12): „Historie importieren“ (/api/history/import) hatte kein
// try/catch — ein Throw aus dem Import (VRM 404, Portal-ID nicht im Konto)
// endete als generischer 500 „internal server error“. Jetzt wie beim
// Nachimport: 502 mit Grund + Log history_import_finished status=error.
describe('POST /api/history/import — Fehler aus dem Import werden benannt', () => {
  it('Import wirft → 502 mit Fehlertext, kein generischer 500', async () => {
    const { ctx, logs } = makeCtx({ importFromConfiguredSource: async () => { throw new Error('VRM-Portal-ID „deadbeef0000“ ist in diesem VRM-Konto nicht zu finden'); } });
    const { srv, baseUrl } = await startHandler(ctx);
    after(() => new Promise((r) => srv.close(r)));
    const res = await fetch(baseUrl + '/api/history/import', { method: 'POST', headers, body: JSON.stringify({ start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' }) });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /deadbeef0000/);
    const fin = logs.find(l => l.event === 'history_import_finished');
    assert.ok(fin, 'history_import_finished geloggt');
    assert.equal(fin.details.status, 'error');
    assert.match(fin.details.errorMessage, /nicht zu finden/);
  });

  it('Lücken-Import (mode=backfill) wirft → 502 mit Fehlertext', async () => {
    const { ctx } = makeCtx({ backfillHistoryFromConfiguredSource: async () => { throw new Error('VRM stats request failed for venus: HTTP 404'); } });
    const { srv, baseUrl } = await startHandler(ctx);
    after(() => new Promise((r) => srv.close(r)));
    const res = await fetch(baseUrl + '/api/history/import', { method: 'POST', headers, body: JSON.stringify({ mode: 'backfill' }) });
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /HTTP 404/);
  });

  it('Zeilen-Import (rows) wird abgewartet → 200 mit Ergebnis', async () => {
    const { ctx } = makeCtx({ importSamples: async () => ({ ok: true, jobId: 7, importedRows: 1 }) });
    const { srv, baseUrl } = await startHandler(ctx);
    after(() => new Promise((r) => srv.close(r)));
    const res = await fetch(baseUrl + '/api/history/import', { method: 'POST', headers, body: JSON.stringify({ rows: [{ seriesKey: 'pv_w', ts: '2026-01-01T00:00:00Z', value: 1 }] }) });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).importedRows, 1);
  });
});
