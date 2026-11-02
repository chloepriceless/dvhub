// test/vrm-site-callers.test.js — GH #32: alle VRM-Aufrufer nutzen die Site-ID.
// Steht im Feld die Hex-Portal-ID, lösen History-Import, VRM-Prognose
// (epex-fetch) und PV-Strings sie zuerst auf und rufen dann
// /v2/installations/<idSite>/… — nie /v2/installations/<Portal-ID>/….

import test from 'node:test';
import assert from 'node:assert/strict';

import { createHistoryImportManager } from '../history-import.js';
import { createEpexFetcher } from '../epex-fetch.js';
import { createPvStringsService } from '../services/pv-strings/index.js';

const PORTAL_ID = 'a1b2c3d4e5f6';
const SITE_ID = 123456;

// VRM-Stub: Konto mit zwei Anlagen; alles unter /v2/installations/<idSite>/
// antwortet nur für die numerische Site-ID, eine Portal-ID dort ergibt 404
// (wie die echte API).
function fakeVrm() {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname);
    const ok = (body) => ({ ok: true, status: 200, async json() { return body; }, async text() { return JSON.stringify(body); } });
    if (u.hostname !== 'vrmapi.victronenergy.com') return ok({ unix_seconds: [], price: [] });
    if (u.pathname === '/v2/users/me') return ok({ success: true, user: { id: 42 } });
    if (u.pathname === '/v2/users/42/installations') {
      return ok({ success: true, records: [{ idSite: 1, identifier: 'ffffffffffff' }, { idSite: SITE_ID, identifier: PORTAL_ID }] });
    }
    const m = /^\/v2\/installations\/([^/]+)\/(.+)$/.exec(u.pathname);
    if (!m || m[1] !== String(SITE_ID)) return { ok: false, status: 404, async json() { return { success: false }; } };
    if (m[2] === 'stats') {
      const type = u.searchParams.get('type');
      if (type === 'forecast') return ok({ success: true, records: { solar_yield_forecast: [[Date.UTC(2026, 10, 2, 10), 1000]] } });
      return ok({ success: true, records: type === 'venus' ? { Pdc: [[Date.UTC(2026, 0, 1), 1200]] } : {} });
    }
    if (m[2] === 'diagnostics') return ok({ success: true, records: [] });
    return ok({ success: true, records: {} });
  };
  return { fetchImpl, calls };
}

function fakeStore() {
  return {
    async writeSamples() {},
    async writeImportJob() { return 1; },
    async getTelemetryBounds() { return { earliest: null, latest: null }; },
    async listMissingPriceBuckets() { return []; },
    async listImportJobRanges() { return []; },
  };
}

test('History-Import: Portal-ID im Feld → Statistik über die aufgelöste Site-ID', async () => {
  const { fetchImpl, calls } = fakeVrm();
  const manager = createHistoryImportManager({
    store: fakeStore(),
    fetchImpl,
    telemetryConfig: { historyImport: { enabled: true, provider: 'vrm', vrmPortalId: PORTAL_ID, vrmToken: 'tok-history' } },
  });
  const result = await manager.importFromConfiguredSource({
    start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T01:00:00.000Z', interval: '15mins',
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const stats = calls.filter((p) => p.endsWith('/stats'));
  assert.equal(stats.length, 3);
  assert.ok(stats.every((p) => p === `/v2/installations/${SITE_ID}/stats`), stats.join(','));
  assert.equal(calls.filter((p) => p === '/v2/users/me').length, 1, 'einmal aufgelöst, dann zwischengespeichert');
});

test('History-Import: Portal-ID nicht im Konto → Fehler nennt den Grund statt HTTP 404', async () => {
  const { fetchImpl, calls } = fakeVrm();
  const manager = createHistoryImportManager({
    store: fakeStore(),
    fetchImpl,
    telemetryConfig: { historyImport: { enabled: true, provider: 'vrm', vrmPortalId: 'deadbeef0000', vrmToken: 'tok-history-2' } },
  });
  await assert.rejects(
    manager.importFromConfiguredSource({ start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T01:00:00.000Z' }),
    /deadbeef0000.*nicht/
  );
  assert.equal(calls.some((p) => p.endsWith('/stats')), false);
});

test('History-Import: falsche Site-ID → 404-Meldung mit Hinweis auf die Site-ID', async () => {
  const { fetchImpl } = fakeVrm();
  const manager = createHistoryImportManager({
    store: fakeStore(),
    fetchImpl,
    telemetryConfig: { historyImport: { enabled: true, provider: 'vrm', vrmPortalId: '123', vrmToken: 'tok' } },
  });
  await assert.rejects(
    manager.importFromConfiguredSource({ start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T01:00:00.000Z' }),
    (e) => /HTTP 404/.test(e.message) && /Site-ID/.test(e.message)
  );
});

test('VRM-Prognose (epex-fetch): Portal-ID → Prognose über die Site-ID', async () => {
  const { fetchImpl, calls } = fakeVrm();
  const points = [];
  const logs = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const fetcher = createEpexFetcher({
      state: {},
      getCfg: () => ({ telemetry: { historyImport: { enabled: true, vrmPortalId: PORTAL_ID, vrmToken: 'tok-forecast' } } }),
      pushLog: (event, details) => logs.push({ event, details }),
      telemetryStore: { async writeForecastPoints(p) { points.push(...p); return p.length; } },
    });
    await fetcher.fetchVrmForecast();
  } finally {
    globalThis.fetch = origFetch;
  }
  const stats = calls.filter((p) => p.endsWith('/stats'));
  assert.equal(stats.length, 3, calls.join(','));
  assert.ok(stats.every((p) => p === `/v2/installations/${SITE_ID}/stats`), stats.join(','));
  assert.ok(points.length > 0, 'Prognosepunkte geschrieben');
});

test('VRM-Prognose (epex-fetch): Portal-ID nicht im Konto → geloggt statt still verworfen', async () => {
  const { fetchImpl, calls } = fakeVrm();
  const logs = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const fetcher = createEpexFetcher({
      state: {},
      getCfg: () => ({ telemetry: { historyImport: { enabled: true, vrmPortalId: 'deadbeef0000', vrmToken: 'tok-forecast-2' } } }),
      pushLog: (event, details) => logs.push({ event, details }),
      telemetryStore: { async writeForecastPoints(p) { return p.length; } },
    });
    await fetcher.fetchVrmForecast();
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.equal(calls.some((p) => p.endsWith('/stats')), false);
  const err = logs.find((l) => l.event === 'vrm_forecast_error');
  assert.ok(err, JSON.stringify(logs));
  assert.match(err.details.error, /deadbeef0000/);
});

test('PV-Strings: Tracker-Suche mit Portal-ID → Diagnose über die Site-ID', async () => {
  const { fetchImpl, calls } = fakeVrm();
  const svc = createPvStringsService({
    getCfg: () => ({ telemetry: { historyImport: { vrmPortalId: PORTAL_ID, vrmToken: 'tok-pvs' } }, pvStrings: { enabled: false, sources: [] } }),
    telemetryStore: { async writeSamples() {} },
    fetchImpl,
    sleep: async () => {},
  });
  const r = await svc.discover();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(calls.includes(`/v2/installations/${SITE_ID}/diagnostics`), calls.join(','));
  assert.equal(calls.some((p) => p.includes(PORTAL_ID)), false);
});

test('PV-Strings: Portal-ID nicht im Konto → Fehlertext statt Absturz', async () => {
  const { fetchImpl } = fakeVrm();
  const svc = createPvStringsService({
    getCfg: () => ({ telemetry: { historyImport: { vrmPortalId: 'deadbeef0000', vrmToken: 'tok-pvs-2' } }, pvStrings: { enabled: false, sources: [] } }),
    telemetryStore: { async writeSamples() {} },
    fetchImpl,
    sleep: async () => {},
  });
  const r = await svc.discover();
  assert.equal(r.ok, false);
  assert.match(r.error, /deadbeef0000/);
});
