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
function fakeVrm({ meFailures = [], statsStatus = null } = {}) {
  const calls = [];
  const fails = [...meFailures];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname);
    if (u.pathname === '/v2/users/me' && fails.length) {
      const status = fails.shift();
      return { ok: false, status, async json() { return { success: false }; } };
    }
    if (statsStatus && u.pathname.endsWith('/stats')) return { ok: false, status: statsStatus, async json() { return { success: false }; } };
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

// Gegenprüfung c21c131f (P3): die Auflösung wird bei 429/5xx wiederholt wie die
// Statistik-Abrufe selbst — sonst verliert ein einmaliger VRM-Schluckauf beim
// Start den automatischen Nachimport.
test('History-Import: users/me einmal 503 → wiederholt, Import gelingt', async () => {
  const { fetchImpl, calls } = fakeVrm({ meFailures: [503] });
  const waits = [];
  const manager = createHistoryImportManager({
    store: fakeStore(),
    fetchImpl,
    waitImpl: async (ms) => { waits.push(ms); },
    telemetryConfig: { historyImport: { enabled: true, provider: 'vrm', vrmPortalId: PORTAL_ID, vrmToken: 'tok-history-retry' } },
  });
  const result = await manager.importFromConfiguredSource({ start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T01:00:00.000Z' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls.filter((p) => p === '/v2/users/me').length, 2);
  assert.equal(waits.length, 1);
});

test('History-Import: Portal-ID nicht im Konto → keine Wiederholung', async () => {
  const { fetchImpl, calls } = fakeVrm();
  const manager = createHistoryImportManager({
    store: fakeStore(),
    fetchImpl,
    waitImpl: async () => {},
    telemetryConfig: { historyImport: { enabled: true, provider: 'vrm', vrmPortalId: 'deadbeef0001', vrmToken: 'tok-history-noretry' } },
  });
  await assert.rejects(manager.importFromConfiguredSource({ start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T01:00:00.000Z' }));
  assert.equal(calls.filter((p) => p === '/v2/users/me').length, 1);
});

test('PV-Strings: 429 bei der Auflösung → Status 429 kommt beim Nachladen an', async () => {
  const { fetchImpl } = fakeVrm({ meFailures: [429] });
  const svc = createPvStringsService({
    getCfg: () => ({
      telemetry: { historyImport: { vrmPortalId: PORTAL_ID, vrmToken: 'tok-pvs-429' } },
      pvStrings: { enabled: true, sources: [{ id: 's1', label: 'S1', kind: 'victron_vrm_tracker', instance: 0, tracker: 0 }] },
    }),
    telemetryStore: { async writeSamples() {} },
    fetchImpl,
    sleep: async () => {},
  });
  const r = await svc.syncWindow(1_700_000_000, 1_700_003_600);
  assert.equal(r.bySource.vrm.ok, false);
  assert.equal(r.bySource.vrm.status, 429);
});

test('VRM-Prognose: abgelehnter Statistik-Abruf (404) wird mit Stufe und Status geloggt', async () => {
  const { fetchImpl } = fakeVrm({ statsStatus: 404 });
  const logs = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const fetcher = createEpexFetcher({
      state: {},
      getCfg: () => ({ telemetry: { historyImport: { enabled: true, vrmPortalId: String(SITE_ID), vrmToken: 'tok-forecast-404' } } }),
      pushLog: (event, details) => logs.push({ event, details }),
      telemetryStore: { async writeForecastPoints(p) { return p.length; } },
    });
    await fetcher.fetchVrmForecast();
  } finally {
    globalThis.fetch = origFetch;
  }
  const errs = logs.filter((l) => l.event === 'vrm_forecast_error');
  assert.equal(errs.length, 1, 'einmal je Lauf, nicht je Tag');
  assert.equal(errs[0].details.stage, 'stats');
  assert.match(errs[0].details.error, /HTTP 404/);
});

// Gegenprüfung 6f05ca48 (P3): Netzfehler beim Start (DNS/WAN noch nicht da)
// werden bei der Auflösung ebenfalls wiederholt.
test('History-Import: users/me einmal Netzfehler → wiederholt, Import gelingt', async () => {
  const base = fakeVrm();
  let failed = false;
  const fetchImpl = async (url, opts) => {
    if (!failed && new URL(url).pathname === '/v2/users/me') {
      failed = true;
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    }
    return base.fetchImpl(url, opts);
  };
  const manager = createHistoryImportManager({
    store: fakeStore(),
    fetchImpl,
    waitImpl: async () => {},
    telemetryConfig: { historyImport: { enabled: true, provider: 'vrm', vrmPortalId: PORTAL_ID, vrmToken: 'tok-history-net' } },
  });
  const result = await manager.importFromConfiguredSource({ start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T01:00:00.000Z' });
  assert.equal(result.ok, true, JSON.stringify(result));
});

// Gegenprüfung 6f05ca48 (P2): Der Dienst bekam keinen waitImpl → alle
// Wiederholungs- und Schonpausen waren in Produktion No-ops.
test('History-Import: server.js gibt eine echte Pause (sleepMs) mit, sleepMs wartet wirklich', async () => {
  const fs = await import('node:fs');
  const { sleepMs } = await import('../history-import.js');
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const call = src.match(/createHistoryImportManager\(\{[\s\S]*?\}\)/);
  assert.ok(call, 'Aufruf in server.js gefunden');
  assert.match(call[0], /waitImpl:\s*sleepMs/);
  const t0 = Date.now();
  await sleepMs(40);
  assert.ok(Date.now() - t0 >= 35);
});

// Gegenprüfung ba005b6b (P2): auch die Statistik-Abrufe selbst werden bei
// Netzfehlern wiederholt (nicht nur 429/5xx).
test('History-Import: Statistik-Abruf einmal Netzfehler → wiederholt, Import gelingt', async () => {
  const base = fakeVrm();
  let failed = false;
  const waits = [];
  const fetchImpl = async (url, opts) => {
    if (!failed && new URL(url).pathname.endsWith('/stats')) {
      failed = true;
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    }
    return base.fetchImpl(url, opts);
  };
  const manager = createHistoryImportManager({
    store: fakeStore(),
    fetchImpl,
    waitImpl: async (ms) => { waits.push(ms); },
    telemetryConfig: { historyImport: { enabled: true, provider: 'vrm', vrmPortalId: String(SITE_ID), vrmToken: 'tok-stats-net' } },
  });
  const result = await manager.importFromConfiguredSource({ start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T01:00:00.000Z' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(waits.length, 1);
});

// Gegenprüfung 62848274 (P2): Abbruch beim Lesen der /stats-Antwort ist ein
// Netzfehler und wird wiederholt.
test('History-Import: /stats-Antwort bricht beim Lesen ab → wiederholt, Import gelingt', async () => {
  const base = fakeVrm();
  let broke = false;
  const fetchImpl = async (url, opts) => {
    const res = await base.fetchImpl(url, opts);
    if (!broke && new URL(url).pathname.endsWith('/stats')) {
      broke = true;
      return { ok: true, status: 200, async json() { throw Object.assign(new TypeError('terminated'), { cause: { code: 'ECONNRESET' } }); } };
    }
    return res;
  };
  const manager = createHistoryImportManager({
    store: fakeStore(), fetchImpl, waitImpl: async () => {},
    telemetryConfig: { historyImport: { enabled: true, provider: 'vrm', vrmPortalId: String(SITE_ID), vrmToken: 'tok-body-reset' } },
  });
  const result = await manager.importFromConfiguredSource({ start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T01:00:00.000Z' });
  assert.equal(result.ok, true, JSON.stringify(result));
});

// Gegenprüfung 62848274 (P3): /stats-Abruf hat ein Zeitlimit (signal).
test('History-Import: /stats-Abruf mit Zeitlimit (AbortSignal)', async () => {
  const base = fakeVrm();
  const signals = [];
  const fetchImpl = async (url, opts = {}) => {
    if (new URL(url).pathname.endsWith('/stats')) signals.push(opts.signal);
    return base.fetchImpl(url, opts);
  };
  const manager = createHistoryImportManager({
    store: fakeStore(), fetchImpl, waitImpl: async () => {},
    telemetryConfig: { historyImport: { enabled: true, provider: 'vrm', vrmPortalId: String(SITE_ID), vrmToken: 'tok-signal' } },
  });
  await manager.importFromConfiguredSource({ start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T01:00:00.000Z' });
  assert.equal(signals.length, 3);
  assert.ok(signals.every((s) => s && typeof s.aborted === 'boolean'), 'jeder /stats-Abruf hat ein signal');
});

// Gegenprüfung 62848274 (P2): scheitert der automatische Nachimport beim Start
// (z. B. WAN noch weg), wird das geloggt und bei vorübergehendem Fehler später
// erneut versucht (höchstens autoRetryDelaysMs.length Mal).
function gapStore() {
  return { ...fakeStore(), async listImportJobRanges() { return []; } };
}
async function flush() { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); }

test('Auto-Nachimport: Netzfehler → geloggt und neu geplant, dann erfolgreich', async () => {
  const base = fakeVrm();
  let netDown = true;
  const fetchImpl = async (url, opts) => {
    if (netDown && new URL(url).hostname === 'vrmapi.victronenergy.com') {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    }
    return base.fetchImpl(url, opts);
  };
  const logs = [];
  const scheduled = [];
  const manager = createHistoryImportManager({
    store: gapStore(), fetchImpl, waitImpl: async () => {},
    log: (event, details) => logs.push({ event, details }),
    scheduleImpl: (fn, ms) => { scheduled.push({ fn, ms }); },
    autoRetryDelaysMs: [1000, 2000],
    telemetryConfig: { historyImport: { enabled: true, provider: 'vrm', vrmPortalId: String(SITE_ID), vrmToken: 'tok-auto' } },
  });
  const r = await manager.startAutomaticBackfill({ now: '2026-01-08T00:00:00.000Z' });
  assert.equal(r.started, true);
  await flush();
  const err = logs.find((l) => l.event === 'history_auto_backfill_error');
  assert.ok(err, JSON.stringify(logs));
  assert.match(err.details.error, /ENOTFOUND/);
  assert.equal(err.details.retryInMs, 1000);
  assert.equal(scheduled.length, 1);
  netDown = false;
  scheduled[0].fn();
  await flush();
  assert.equal(scheduled.length, 1, 'nach Erfolg nichts mehr geplant');
});

test('Auto-Nachimport: dauerhafter Fehler (Portal-ID nicht im Konto) → geloggt, nicht neu geplant', async () => {
  const { fetchImpl } = fakeVrm();
  const logs = [];
  const scheduled = [];
  const manager = createHistoryImportManager({
    store: gapStore(), fetchImpl, waitImpl: async () => {},
    log: (event, details) => logs.push({ event, details }),
    scheduleImpl: (fn, ms) => { scheduled.push({ fn, ms }); },
    telemetryConfig: { historyImport: { enabled: true, provider: 'vrm', vrmPortalId: 'deadbeef0002', vrmToken: 'tok-auto-2' } },
  });
  await manager.startAutomaticBackfill({ now: '2026-01-08T00:00:00.000Z' });
  await flush();
  const err = logs.find((l) => l.event === 'history_auto_backfill_error');
  assert.ok(err);
  assert.equal(err.details.retryInMs, null);
  assert.equal(scheduled.length, 0);
});

test('server.js gibt dem History-Import pushLog als log mit', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const call = src.match(/createHistoryImportManager\(\{[\s\S]*?\}\)/);
  assert.match(call[0], /log:\s*pushLog/);
});
