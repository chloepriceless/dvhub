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
  const jobs = [];
  const store = { ...gapStore(), async writeImportJob(j) { jobs.push(j); return jobs.length; } };
  const manager = createHistoryImportManager({
    store, fetchImpl, waitImpl: async () => {},
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
  // Gegenprüfung 683fcb25 (P3): der Wiederholungslauf hat wirklich importiert.
  assert.ok(jobs.length > 0, 'Import-Job nach der Wiederholung geschrieben');
  assert.equal(logs.filter((l) => l.event === 'history_auto_backfill_error').length, 1);
});

test('Auto-Nachimport: Wiederholungen enden nach autoRetryDelaysMs', async () => {
  const fetchImpl = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };
  const logs = [];
  const scheduled = [];
  const manager = createHistoryImportManager({
    store: gapStore(), fetchImpl, waitImpl: async () => {},
    log: (event, details) => logs.push({ event, details }),
    scheduleImpl: (fn, ms) => { scheduled.push({ fn, ms }); },
    autoRetryDelaysMs: [1000, 2000],
    telemetryConfig: { historyImport: { enabled: true, provider: 'vrm', vrmPortalId: String(SITE_ID), vrmToken: 'tok-auto-end' } },
  });
  await manager.startAutomaticBackfill({ now: '2026-01-08T00:00:00.000Z' });
  await flush();
  scheduled[0].fn(); await flush();
  scheduled[1].fn(); await flush();
  assert.deepEqual(scheduled.map((x) => x.ms), [1000, 2000]);
  const errs = logs.filter((l) => l.event === 'history_auto_backfill_error');
  assert.equal(errs.length, 3);
  assert.equal(errs[2].details.retryInMs, null, 'letzter Versuch plant nichts mehr');
});

// Gegenprüfung 683fcb25 (P2): der Dienst liest die Konfiguration bei jedem
// Gebrauch neu (getTelemetryConfig) — sonst liefen Wiederholungen mit gelöschten
// Zugangsdaten weiter, und eine korrigierte Portal-/Site-ID wirkte erst nach Neustart.
test('Auto-Nachimport: Zugang inzwischen entfernt → Wiederholung ruft VRM nicht mehr', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };
  const scheduled = [];
  const cfg = { historyImport: { enabled: true, provider: 'vrm', vrmPortalId: String(SITE_ID), vrmToken: 'tok-auto-del' } };
  let current = cfg;
  const manager = createHistoryImportManager({
    store: gapStore(), fetchImpl, waitImpl: async () => {},
    scheduleImpl: (fn, ms) => { scheduled.push({ fn, ms }); },
    autoRetryDelaysMs: [1000],
    getTelemetryConfig: () => current,
  });
  await manager.startAutomaticBackfill({ now: '2026-01-08T00:00:00.000Z' });
  await flush();
  assert.equal(scheduled.length, 1);
  const before = calls;
  current = { historyImport: { enabled: false, provider: 'vrm', vrmPortalId: '' } }; // „Credentials entfernen“ = neues Objekt
  scheduled[0].fn(); await flush();
  assert.equal(calls, before, 'kein VRM-Aufruf mit gelöschtem Zugang');
});

test('History-Import: geänderte Portal-/Site-ID wirkt ohne Neustart (getTelemetryConfig)', async () => {
  const { fetchImpl, calls } = fakeVrm();
  let current = { historyImport: { enabled: true, provider: 'vrm', vrmPortalId: 'deadbeef0003', vrmToken: 'tok-live' } };
  const manager = createHistoryImportManager({ store: fakeStore(), fetchImpl, waitImpl: async () => {}, getTelemetryConfig: () => current });
  await assert.rejects(manager.importFromConfiguredSource({ start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T01:00:00.000Z' }));
  current = { historyImport: { ...current.historyImport, vrmPortalId: PORTAL_ID } };
  const r = await manager.importFromConfiguredSource({ start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T01:00:00.000Z' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(calls.includes(`/v2/installations/${SITE_ID}/stats`));
  assert.equal(manager.getStatus().vrmPortalId, PORTAL_ID);
});

test('server.js gibt dem History-Import einen Konfigurations-Getter', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const call = src.match(/createHistoryImportManager\(\{[\s\S]*?\}\)/);
  assert.match(call[0], /getTelemetryConfig:\s*\(\)\s*=>\s*cfg\.telemetry/);
});

// Gegenprüfung 683fcb25 (P3): Läuft beim Wiederholungstermin gerade ein anderer
// Nachimport, wird derselbe Versuch verschoben statt still verworfen.
test('Auto-Nachimport: Wiederholung trifft laufenden Nachimport → verschoben, nicht verloren', async () => {
  let netDown = true;
  const base = fakeVrm();
  let release;
  const gate = new Promise((r) => { release = r; });
  let holdStats = false;
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    if (u.hostname === 'vrmapi.victronenergy.com' && netDown) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    if (holdStats && u.pathname.endsWith('/stats')) await gate;
    return base.fetchImpl(url, opts);
  };
  const logs = [];
  const scheduled = [];
  const manager = createHistoryImportManager({
    store: gapStore(), fetchImpl, waitImpl: async () => {},
    log: (event, details) => logs.push({ event, details }),
    scheduleImpl: (fn, ms) => { scheduled.push({ fn, ms }); },
    autoRetryDelaysMs: [1000],
    telemetryConfig: { historyImport: { enabled: true, provider: 'vrm', vrmPortalId: String(SITE_ID), vrmToken: 'tok-busy' } },
  });
  await manager.startAutomaticBackfill({ now: '2026-01-08T00:00:00.000Z' });
  await flush();
  netDown = false;
  holdStats = true;
  const manual = manager.backfillHistoryFromConfiguredSource({ mode: 'gap' });
  await flush();
  scheduled[0].fn(); await flush();
  assert.equal(scheduled.length, 2, 'derselbe Versuch neu eingeplant');
  assert.equal(scheduled[1].ms, 1000);
  assert.ok(logs.some((l) => l.event === 'history_auto_backfill_deferred'));
  release();
  await manual;
});

// Gegenprüfung 683fcb25 (P3): Zeitlimit = wiederholbar, kaputtes JSON nicht.
test('History-Import: Zeitlimit beim /stats-Abruf → wiederholt', async () => {
  const base = fakeVrm();
  let timedOut = false;
  const fetchImpl = async (url, opts) => {
    if (!timedOut && new URL(url).pathname.endsWith('/stats')) {
      timedOut = true;
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    }
    return base.fetchImpl(url, opts);
  };
  const manager = createHistoryImportManager({
    store: fakeStore(), fetchImpl, waitImpl: async () => {},
    telemetryConfig: { historyImport: { enabled: true, provider: 'vrm', vrmPortalId: String(SITE_ID), vrmToken: 'tok-timeout' } },
  });
  const r = await manager.importFromConfiguredSource({ start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T01:00:00.000Z' });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('History-Import: kaputtes JSON bei /stats → kein Wiederholen', async () => {
  const base = fakeVrm();
  let statsCalls = 0;
  const fetchImpl = async (url, opts) => {
    if (new URL(url).pathname.endsWith('/stats')) {
      statsCalls += 1;
      return { ok: true, status: 200, async json() { throw new SyntaxError('Unexpected token <'); } };
    }
    return base.fetchImpl(url, opts);
  };
  const manager = createHistoryImportManager({
    store: fakeStore(), fetchImpl, waitImpl: async () => {},
    telemetryConfig: { historyImport: { enabled: true, provider: 'vrm', vrmPortalId: String(SITE_ID), vrmToken: 'tok-json' } },
  });
  await assert.rejects(manager.importFromConfiguredSource({ start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T01:00:00.000Z' }), SyntaxError);
  assert.equal(statsCalls, 1);
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

// Gegenprüfung a9e434f9 (P2): ein Lauf liest die Konfiguration einmal — ändert
// sich die Site-ID mittendrin, mischt er nicht zwei Anlagen und bucht die
// Abdeckung nicht auf die neue.
test('Nachimport: Site-ID-Wechsel während des Laufs → Lauf bleibt bei der alten Anlage', async () => {
  const { fetchImpl, calls } = fakeVrm();
  const jobs = [];
  const store = { ...gapStore(), async writeImportJob(j) { jobs.push(j); return jobs.length; } };
  let current = { historyImport: { enabled: true, provider: 'vrm', vrmPortalId: String(SITE_ID), vrmToken: 'tok-switch' } };
  const manager = createHistoryImportManager({
    store, fetchImpl,
    waitImpl: async () => { current = { historyImport: { ...current.historyImport, vrmPortalId: '999999' } }; },
    getTelemetryConfig: () => current,
  });
  const r = await manager.backfillHistoryFromConfiguredSource({ mode: 'gap', now: '2026-01-08T00:00:00.000Z' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const stats = calls.filter((p) => p.endsWith('/stats'));
  assert.ok(stats.length > 3, 'mehrere Fenster');
  assert.ok(stats.every((p) => p === `/v2/installations/${SITE_ID}/stats`), stats.join(','));
  assert.ok(jobs.every((j) => j.sourceAccount === String(SITE_ID)), JSON.stringify(jobs.map((j) => j.sourceAccount)));
});

test('Manueller Import: Site-ID-Wechsel während des Abrufs → Job unter der abgefragten Anlage', async () => {
  const base = fakeVrm();
  const jobs = [];
  const store = { ...fakeStore(), async writeImportJob(j) { jobs.push(j); return 1; } };
  let current = { historyImport: { enabled: true, provider: 'vrm', vrmPortalId: String(SITE_ID), vrmToken: 'tok-switch-2' } };
  const fetchImpl = async (url, opts) => {
    const res = await base.fetchImpl(url, opts);
    if (new URL(url).searchParams.get('type') === 'kwh') current = { historyImport: { ...current.historyImport, vrmPortalId: '999999' } };
    return res;
  };
  const manager = createHistoryImportManager({ store, fetchImpl, waitImpl: async () => {}, getTelemetryConfig: () => current });
  await manager.importFromConfiguredSource({ start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T01:00:00.000Z' });
  assert.equal(jobs.find((j) => j.jobType === 'vrm_history_import').sourceAccount, String(SITE_ID));
});

// Gegenprüfung a9e434f9 (P3): Beginnt während der Lücken-Suche ein anderer
// Nachimport, startet der automatische nicht zusätzlich.
test('Auto-Nachimport: anderer Nachimport startet während der Lücken-Suche → busy, kein zweiter Lauf', async () => {
  const { fetchImpl } = fakeVrm();
  let release;
  const gate = new Promise((r) => { release = r; });
  let first = true;
  const store = {
    ...gapStore(),
    async listImportJobRanges() { if (first) { first = false; await gate; } return []; },
  };
  const manager = createHistoryImportManager({
    store, fetchImpl, waitImpl: async () => {},
    telemetryConfig: { historyImport: { enabled: true, provider: 'vrm', vrmPortalId: String(SITE_ID), vrmToken: 'tok-race' } },
  });
  const auto = manager.startAutomaticBackfill({ now: '2026-01-08T00:00:00.000Z' });
  await flush();
  const manual = manager.backfillHistoryFromConfiguredSource({ mode: 'gap', now: '2026-01-08T00:00:00.000Z' });
  release();
  const r = await auto;
  assert.equal(r.started, false);
  assert.equal(r.busy, true);
  await manual;
});

// Gegenprüfung 73df19cf (P3): auch der Voll-Nachimport (inkl. Rückfall auf
// Tageswerte) bleibt bei einem Konfigurationsstand.
test('Voll-Nachimport: Site-ID-Wechsel zwischen Fenstern → bleibt bei der alten Anlage', async () => {
  const { fetchImpl, calls } = fakeVrm();
  const jobs = [];
  const store = { ...gapStore(), async writeImportJob(j) { jobs.push(j); return jobs.length; } };
  let current = { historyImport: { enabled: true, provider: 'vrm', vrmPortalId: String(SITE_ID), vrmToken: 'tok-full' } };
  const manager = createHistoryImportManager({
    store, fetchImpl,
    waitImpl: async () => { current = { historyImport: { ...current.historyImport, vrmPortalId: '999999' } }; },
    getTelemetryConfig: () => current,
  });
  const r = await manager.backfillHistoryFromConfiguredSource({ mode: 'full', now: '2026-01-29T00:00:00.000Z', maxLookbackDays: 21 });
  assert.equal(r.ok, true, JSON.stringify(r));
  const stats = calls.filter((p) => p.endsWith('/stats'));
  assert.ok(stats.length > 3, 'mehrere Fenster');
  assert.ok(stats.every((p) => p === `/v2/installations/${SITE_ID}/stats`), stats.join(','));
  assert.ok(jobs.length > 0 && jobs.every((j) => j.sourceAccount === String(SITE_ID)), JSON.stringify(jobs.map((j) => j.sourceAccount)));
});

test('Voll-Nachimport: Rückfall auf Tageswerte nutzt denselben Konfigurationsstand', async () => {
  const calls = [];
  const empty = { ok: true, status: 200, async json() { return { success: true, records: {} }; } };
  let current = { historyImport: { enabled: true, provider: 'vrm', vrmPortalId: String(SITE_ID), vrmToken: 'tok-full-days' } };
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(`${u.pathname}?${u.searchParams.get('interval')}`);
    // Wechsel schon beim ersten 15-min-Abruf: nimmt der Rückfall einen neuen
    // Stand statt runConfig, liest er 999999 (Gegenprüfung 8b22116d).
    if (u.searchParams.get('interval') === '15mins') current = { historyImport: { ...current.historyImport, vrmPortalId: '999999' } };
    if (u.hostname !== 'vrmapi.victronenergy.com') return { ok: true, status: 200, async json() { return { unix_seconds: [], price: [] }; } };
    return empty;
  };
  const jobs = [];
  const store = { ...gapStore(), async writeImportJob(j) { jobs.push(j); return jobs.length; } };
  const manager = createHistoryImportManager({ store, fetchImpl, waitImpl: async () => {}, getTelemetryConfig: () => current });
  const r = await manager.backfillHistoryFromConfiguredSource({ mode: 'full', now: '2026-01-29T00:00:00.000Z', maxLookbackDays: 21 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(calls.some((c) => c.endsWith('?days')), 'Rückfall auf Tageswerte lief');
  assert.ok(calls.every((c) => c.startsWith(`/v2/installations/${SITE_ID}/stats`)), calls.join(','));
  assert.ok(jobs.length > 0, 'Job geschrieben');
  assert.equal(jobs.at(-1).meta.interval, 'days');
  assert.ok(jobs.every((j) => j.sourceAccount === String(SITE_ID)), JSON.stringify(jobs.map((j) => j.sourceAccount)));
});

// Gesamtprüfung Release 1.0.9: Die Lückensuche selbst (Abdeckung aus der
// Datenbank) beim Start war ungeschützt — scheiterte sie (Datenbank noch nicht
// bereit), lehnte startAutomaticBackfill ab und nichts wurde wiederholt.
test('Auto-Nachimport: gescheiterte Lückensuche beim Start wird wiederholt', async () => {
  const base = fakeVrm();
  let dbDown = true;
  const store = { ...gapStore(), async listImportJobRanges() { if (dbDown) throw new Error('Datenbank nicht bereit'); return []; } };
  const logs = [];
  const scheduled = [];
  const manager = createHistoryImportManager({
    store, fetchImpl: base.fetchImpl, waitImpl: async () => {},
    log: (event, details) => logs.push({ event, details }),
    scheduleImpl: (fn, ms) => { scheduled.push({ fn, ms }); },
    autoRetryDelaysMs: [1000, 2000],
    telemetryConfig: { historyImport: { enabled: true, provider: 'vrm', vrmPortalId: String(SITE_ID), vrmToken: 'tok-gap-search' } },
  });
  const r = await manager.startAutomaticBackfill({ now: '2026-01-08T00:00:00.000Z' });
  assert.equal(r.started, false);
  assert.equal(scheduled.length, 1, 'Wiederholung geplant');
  assert.equal(scheduled[0].ms, 1000);
  assert.equal(logs.find((l) => l.event === 'history_auto_backfill_error')?.details?.phase, 'gap_search');
  dbDown = false;
  const second = await scheduled[0].fn(); await flush();
  assert.equal(second?.started, true, 'zweiter Versuch startet den Nachimport');
  assert.equal(scheduled.length, 1, 'nach Erfolg nichts mehr geplant');
});

// Gegenprüfung 0060ce70 (2× P3): eigener Versuchszähler für die Lückensuche;
// läuft gerade ein anderer Nachimport, wird der Versuch verschoben statt verworfen.
test('Auto-Nachimport: Lückensuche — eigener Zähler, belegt → verschoben, Aufgeben nach dem letzten Versuch', async () => {
  let dbDown = true;
  const store = { ...gapStore(), async listImportJobRanges() { if (dbDown) throw new Error('Datenbank nicht bereit'); return []; } };
  const logs = [];
  const scheduled = [];
  const fetchImpl = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };
  const manager = createHistoryImportManager({
    store, fetchImpl, waitImpl: async () => {},
    log: (event, details) => logs.push({ event, details }),
    scheduleImpl: (fn, ms) => { scheduled.push({ fn, ms }); },
    autoRetryDelaysMs: [1000, 2000],
    telemetryConfig: { historyImport: { enabled: true, provider: 'vrm', vrmPortalId: String(SITE_ID), vrmToken: 'tok-gap-own' } },
  });
  await manager.startAutomaticBackfill({ now: '2026-01-08T00:00:00.000Z' });
  await scheduled[0].fn(); await flush();                   // 2. Lückensuche scheitert
  assert.deepEqual(scheduled.map((x) => x.ms), [1000, 2000]);
  dbDown = false;
  await scheduled[1].fn(); await flush();                   // 3. Lückensuche gelingt, Nachimport scheitert (Netz)
  // Der Nachimport beginnt mit seinem ersten Versuch (1000 ms), nicht beim dritten.
  assert.equal(scheduled[2]?.ms, 1000, 'Nachimport-Versuche vollständig');
  // Aufgeben nach dem letzten Versuch der Lückensuche:
  const logs2 = [];
  const sched2 = [];
  const m2 = createHistoryImportManager({
    store: { ...gapStore(), async listImportJobRanges() { throw new Error('weg'); } }, fetchImpl, waitImpl: async () => {},
    log: (event, details) => logs2.push({ event, details }),
    scheduleImpl: (fn, ms) => { sched2.push({ fn, ms }); },
    autoRetryDelaysMs: [1000],
    telemetryConfig: { historyImport: { enabled: true, provider: 'vrm', vrmPortalId: String(SITE_ID), vrmToken: 'tok-gap-end' } },
  });
  await m2.startAutomaticBackfill({ now: '2026-01-08T00:00:00.000Z' });
  await sched2[0].fn(); await flush();
  assert.equal(sched2.length, 1);
  assert.equal(logs2.filter((l) => l.event === 'history_auto_backfill_error').pop().details.retryInMs, null);
});

test('Auto-Nachimport: Lückensuche-Wiederholung trifft auf laufenden Nachimport → verschoben', async () => {
  let dbDown = true;
  let release;
  const base = fakeVrm();
  const fetchImpl = async (url, opts) => { if (!release) await new Promise((r) => { release = r; }); return base.fetchImpl(url, opts); };
  const store = { ...gapStore(), async listImportJobRanges() { if (dbDown) throw new Error('Datenbank nicht bereit'); return []; } };
  const logs = [];
  const scheduled = [];
  const manager = createHistoryImportManager({
    store, fetchImpl, waitImpl: async () => {},
    log: (event, details) => logs.push({ event, details }),
    scheduleImpl: (fn, ms) => { scheduled.push({ fn, ms }); },
    autoRetryDelaysMs: [1000],
    telemetryConfig: { historyImport: { enabled: true, provider: 'vrm', vrmPortalId: String(SITE_ID), vrmToken: 'tok-gap-busy' } },
  });
  await manager.startAutomaticBackfill({ now: '2026-01-08T00:00:00.000Z' });
  dbDown = false;
  // Ein anderer Nachimport läuft (hängt im Abruf).
  const other = await manager.startAutomaticBackfill({ now: '2026-01-08T00:00:00.000Z', gapSearchAttempt: 5 });
  assert.equal(other.started, true);
  await scheduled[0].fn(); await flush();
  assert.ok(logs.some((l) => l.event === 'history_auto_backfill_deferred' && l.details.phase === 'gap_search'));
  assert.equal(scheduled.length, 2, 'derselbe Versuch neu geplant');
  release?.();
  await flush();
});
