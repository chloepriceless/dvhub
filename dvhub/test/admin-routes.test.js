// test/admin-routes.test.js — Routen aus routes/admin-routes.js, die sonst
// kein Test über createApiRoutes().handleRequest erreicht (2026-10-15, beim
// Herauslösen aus routes-api.js). Die übrigen Admin-/DB-Routen prüfen
// admin-health, token-lifecycle, selfupdate-downgrade-guard, container-runtime
// und lan-trust.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mockCtx, call } from './helpers/api-routes-harness.js';

describe('routes/admin-routes.js über handleRequest', () => {
  it('GET /api/db/backup/status ohne Sicherungsdienst → 503', async () => {
    const r = await call(mockCtx(), '/api/db/backup/status');
    assert.equal(r.status, 503);
    assert.deepEqual(r.body, { ok: false, error: 'backup scheduler unavailable' });
  });

  it('GET /api/db/backup/status → Zustand des Sicherungsdienstes', async () => {
    const status = { lastRunAt: '2026-10-15T01:00:00Z', lastOk: true };
    const r = await call(mockCtx({ extra: { dbBackupScheduler: { getStatus: () => status } } }), '/api/db/backup/status');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, status });
  });

  it('GET /api/db/timescale/status ohne Telemetrie-Datenbank → 503', async () => {
    const r = await call(mockCtx({ raw: { telemetry: { enabled: false } } }), '/api/db/timescale/status');
    assert.equal(r.status, 503);
    assert.deepEqual(r.body, { ok: false, error: 'telemetry database disabled' });
  });
});
