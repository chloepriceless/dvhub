// test/api/history-viz.test.js
//
// Plan 09.3-01 Wave 1 (RED → GREEN) — contract tests for the new
// /api/history/viz/* family + the createHistoryVizAggregator factory.
//
// CONTEXT.md decisions verified by this file:
//   D-08: aggregator factory exists at dvhub/services/history-viz/aggregator.js
//         and exports createHistoryVizAggregator(ctx).
//   D-09: 5min in-memory cache with 3-segment key `${card}:${view}:${date}`,
//         FIFO eviction at cap=200, 4xx/5xx never cached.
//   D-10: 14 cards (sankey, heatmap, ledger, day-profile, stack,
//         autarky-calendar, ring, duration, pheat, spaghetti, cycles, top10,
//         cal-year, scatter) reachable via dispatch under /api/history/viz/{slug}.
//   T-09.3-01: input validation rejects view∉{day,week,month,year} and
//         malformed date BEFORE cache write or DB call.
//   T-09.3-05: LAN-bypass prefix gate active — unauthenticated GET from a
//         LAN IP to /api/history/viz/{slug} returns the stub envelope (501),
//         NOT 401. From a REMOTE IP without Bearer the auth gate fires
//         (401 if token configured, 503 if not).
//
// Test mode: invokes the routes-api dispatch handler directly via mocked
// req/res (integrations-health.test.js pattern). The aggregator factory IS
// the SUT and is invoked via the real routes pipeline using a fresh ctx
// per test (the cache lives inside the factory closure inside ctx.historyVizApi
// — reuse the same routes/ctx pair across calls when verifying cache).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApiRoutes } from '../../routes-api.js';
import { createHistoryVizAggregator } from '../../services/history-viz/aggregator.js';

const REMOTE_IP = '203.0.113.5'; // TEST-NET-3 — never resolves to LAN
const LAN_IP = '127.0.0.1';      // loopback — counts as local network
const API_TOKEN = 'plan-09-3-01-test-token-xxxxxxxxxxxxxxxx';

const SLUGS = [
  'sankey', 'heatmap', 'ledger', 'day-profile', 'stack',
  'autarky-calendar', 'ring', 'duration', 'pheat', 'spaghetti',
  'cycles', 'top10', 'cal-year', 'scatter',
];

const SLUG_TO_METHOD = {
  sankey: 'getSankey', heatmap: 'getHeatmap', ledger: 'getLedger',
  'day-profile': 'getDayProfile', stack: 'getStack',
  'autarky-calendar': 'getAutarkyCalendar', ring: 'getRing',
  duration: 'getDuration', pheat: 'getPheat', spaghetti: 'getSpaghetti',
  cycles: 'getCycles', top10: 'getTop10', 'cal-year': 'getCalYear',
  scatter: 'getScatter',
};

function mockRes() {
  const captured = { status: 0, headers: {}, body: '' };
  return {
    writeHead(code, headers) { captured.status = code; Object.assign(captured.headers, headers); },
    end(payload) { captured.body = payload; },
    _captured: captured,
  };
}

function makeReq(pathname, { method = 'GET', token = API_TOKEN, ip = REMOTE_IP } = {}) {
  const headers = { host: 'dvhub.test' };
  if (token) headers.authorization = `Bearer ${token}`;
  return { method, url: pathname, headers, socket: { remoteAddress: ip } };
}

function mockCtx() {
  const cfg = {
    apiToken: API_TOKEN,
    epex: { enabled: false, timezone: 'Europe/Berlin' },
    optimizer: { enabled: false },
    schedule: { timezone: 'Europe/Berlin' },
    telemetry: { enabled: false },
    family: {},
    gridPositiveMeans: 'grid_import',
    keepalivePulseSec: 30,
    corsAllowedOrigins: [],
    allowedHosts: [],
    notifications: { enabled: false, providers: {} },
    integrations: { tesla: { enabled: false } },
    mqtt: {},
  };
  const ctx = {
    state: {
      meter: { ok: true, updatedAt: Date.now(), grid_total_w: 100 },
      victron: { soc: 50, batteryPowerW: 0, pvTotalW: 0, updatedAt: 0 },
      epex: { ok: false, data: [], updatedAt: 0 },
      energy: { day: null, importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0 },
      telemetry: { enabled: false, ok: false, dbPath: null, lastError: null, lastWriteAt: 0 },
      keepalive: { modbusLastQuery: null, appPulse: { periodSec: 30 } },
      schedule: { rules: [], config: {}, active: {}, lastWrite: {}, manualOverride: {}, lastEvalAt: 0 },
      ctrl: { forcedOff: false, offUntil: 0, lastSignal: 'init', updatedAt: 0, dvControl: null },
      log: [],
      forecast: null,
    },
    getCfg: () => cfg,
    getRawCfg: () => cfg,
    getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }),
    getConfigPath: () => '/tmp/config.json',
    getConfigDefinition: () => [],
    getAppVersion: () => ({ version: '0.9.0-test' }),
    getTransportType: () => 'modbus',
    getAppDir: () => '/tmp',
    getRepoRoot: () => '/tmp',
    getServiceActionsEnabled: () => false,
    getServiceName: () => 'dvhub',
    getServiceUseSudo: () => false,
    runServiceCommand: async () => ({ ok: true, stdout: 'active' }),
    controlValue: () => 'off',
    pushLog: () => {},
    telemetrySafeWrite: () => {},
    needsSetup: () => false,
    epexNowNext: () => null,
    expireLeaseIfNeeded: () => {},
    buildSystemDiscoveryPayload: async () => ({ ok: true }),
    db: null,
    telemetryStore: null,
  };
  // Wire the real factory — it IS the SUT.
  ctx.historyVizApi = createHistoryVizAggregator(ctx);
  return ctx;
}

async function dispatch(ctx, req) {
  const routes = createApiRoutes(ctx);
  const res = mockRes();
  const url = new URL(req.url, `http://${req.headers.host}`);
  await routes.handleRequest(req, res, url);
  return res._captured;
}

describe('createHistoryVizAggregator factory (D-08, D-09)', () => {
  it('exposes all 14 getXxx methods + bustCache', () => {
    const api = createHistoryVizAggregator(mockCtx());
    for (const slug of SLUGS) {
      const m = SLUG_TO_METHOD[slug];
      assert.equal(typeof api[m], 'function', `expected api.${m} to be a function`);
    }
    assert.equal(typeof api.bustCache, 'function', 'expected api.bustCache to be a function');
  });

  // Wave 2 (Plan 09.3-02) lit up 5 live builders (sankey, day-profile, stack,
  // heatmap, ledger). The remaining 9 stay 501 stubs until Waves 3-5. Test 1
  // asserts the stub envelope shape ONLY for the still-stubbed cards; the live
  // builders have dedicated contract tests in the Wave 2 suite below.
  const STUB_SLUGS = SLUGS.filter((s) => !['sankey', 'day-profile', 'stack', 'heatmap', 'ledger'].includes(s));

  it('Test 1 (envelope shape): each of 9 remaining stubs returns a 501 envelope with required keys', async () => {
    const api = createHistoryVizAggregator(mockCtx());
    assert.equal(STUB_SLUGS.length, 9, `expected 9 remaining stubs after Wave 2, got ${STUB_SLUGS.length}`);
    for (const slug of STUB_SLUGS) {
      const result = await api[SLUG_TO_METHOD[slug]]({ view: 'day', date: '2026-05-15' });
      assert.equal(result.status, 501, `${slug} expected status 501, got ${result.status}`);
      const b = result.body;
      assert.equal(b.ok, false, `${slug} envelope.ok should be false (stub)`);
      assert.equal(b.card, slug, `${slug} envelope.card mismatch`);
      assert.equal(b.view, 'day', `${slug} envelope.view mismatch`);
      assert.equal(b.date, '2026-05-15', `${slug} envelope.date mismatch`);
      assert.equal(typeof b.generatedAt, 'string', `${slug} envelope.generatedAt missing`);
      assert.match(b.generatedAt, /^\d{4}-\d{2}-\d{2}T/, `${slug} envelope.generatedAt not ISO`);
      assert.equal(b.cached, false, `${slug} envelope.cached should be false (stub miss)`);
      assert.equal(b.error, 'not_implemented', `${slug} envelope.error mismatch`);
    }
  });

  it('Test 2 (cache key isolation): same (card, date) but different view → different cache entries (RESEARCH §Pitfall 6)', () => {
    const api = createHistoryVizAggregator(mockCtx());
    const { cache, putCached } = api.__test_internals;
    putCached('sankey:day:2026-05-15', { tag: 'A' });
    putCached('sankey:week:2026-05-15', { tag: 'B' });
    assert.equal(cache.size, 2, 'expected two distinct cache entries');
    assert.equal(api.__test_internals.getCached('sankey:day:2026-05-15').tag, 'A');
    assert.equal(api.__test_internals.getCached('sankey:week:2026-05-15').tag, 'B');
    assert.notEqual(
      api.__test_internals.getCached('sankey:day:2026-05-15'),
      api.__test_internals.getCached('sankey:week:2026-05-15'),
      'cache entries must be distinct objects'
    );
  });

  it('Test 3 (input validation): bad view or bad date → 400 BEFORE cache write', async () => {
    const api = createHistoryVizAggregator(mockCtx());
    const r1 = await api.getSankey({ view: 'etc/passwd', date: '2026-05-15' });
    assert.equal(r1.status, 400, 'bad view should be 400');
    assert.equal(r1.body.ok, false);
    assert.equal(r1.body.error, 'invalid view');

    const r2 = await api.getSankey({ view: 'day', date: '2026-99-99' });
    assert.equal(r2.status, 400, 'bad date should be 400');
    assert.equal(r2.body.ok, false);
    assert.equal(r2.body.error, 'invalid date');

    // No cache write occurred for either bad call.
    assert.equal(api.__test_internals.cache.size, 0, 'invalid input must NOT populate cache');
  });

  it('Test 4 (LAN-bypass prefix gate): LAN IP without Bearer → stub; REMOTE IP without Bearer → 401/503', async () => {
    // Use a still-stubbed card (`ring`) so the auth-gate posture is exercised
    // without depending on a wired telemetryStore. Wave 2 lit `sankey` up so
    // the bare mockCtx (no telemetryStore) would 500 with a builder error
    // instead of returning the documented 501 stub — that's a separate code
    // path. The LAN-bypass invariant only cares about the auth gate sitting
    // BEFORE the dispatcher, which is what this test asserts.
    const ctx = mockCtx();
    const lanReq = makeReq('/api/history/viz/ring?view=day&date=2026-05-15', { token: null, ip: LAN_IP });
    const lanRes = await dispatch(ctx, lanReq);
    assert.equal(
      lanRes.status, 501,
      `LAN IP (${LAN_IP}) without Bearer should bypass auth and hit stub (got ${lanRes.status} ${lanRes.body})`
    );
    const lanBody = JSON.parse(lanRes.body);
    assert.equal(lanBody.card, 'ring');
    assert.equal(lanBody.error, 'not_implemented');

    const remReq = makeReq('/api/history/viz/ring?view=day&date=2026-05-15', { token: null, ip: REMOTE_IP });
    const remRes = await dispatch(ctx, remReq);
    assert.ok(
      remRes.status === 401 || remRes.status === 503,
      `REMOTE IP (${REMOTE_IP}) without Bearer should be rejected (got ${remRes.status})`
    );
  });

  it('Test 5 (404 on unknown slug): unknown card returns 404 with error message', async () => {
    const ctx = mockCtx();
    const req = makeReq('/api/history/viz/totally-fake?view=day&date=2026-05-15', { ip: LAN_IP });
    const captured = await dispatch(ctx, req);
    assert.equal(captured.status, 404, `unknown slug should be 404, got ${captured.status}`);
    const body = JSON.parse(captured.body);
    assert.equal(body.ok, false);
    assert.match(body.error, /unknown viz card/i);
    assert.match(body.error, /totally-fake/);
  });

  it('Test 6 (cache cap FIFO): inserting CAP+1 entries evicts the oldest (FIFO)', () => {
    const api = createHistoryVizAggregator(mockCtx());
    const { cache, putCached, CACHE_CAP } = api.__test_internals;
    // Sanity check the cap.
    assert.equal(CACHE_CAP, 200, 'expected CACHE_CAP=200 per D-09');
    for (let i = 0; i < CACHE_CAP; i++) {
      putCached(`card-${i}:day:2026-05-15`, { i });
    }
    assert.equal(cache.size, CACHE_CAP, `expected cache to fill to CAP=${CACHE_CAP}`);
    // The first-inserted key is the oldest by FIFO insertion order.
    assert.ok(cache.has('card-0:day:2026-05-15'), 'oldest key should still be present at cap');
    putCached(`card-${CACHE_CAP}:day:2026-05-15`, { i: CACHE_CAP });
    assert.equal(cache.size, CACHE_CAP, 'cache size should remain at cap after eviction');
    assert.ok(!cache.has('card-0:day:2026-05-15'), 'oldest key should be evicted');
    assert.ok(cache.has(`card-${CACHE_CAP}:day:2026-05-15`), 'newest key should be present');
  });

  it('Test 7 (4xx not cached): two consecutive 400s do NOT populate cache', async () => {
    const api = createHistoryVizAggregator(mockCtx());
    await api.getSankey({ view: 'BAD', date: '2026-05-15' });
    await api.getSankey({ view: 'BAD', date: '2026-05-15' });
    assert.equal(api.__test_internals.cache.size, 0, '4xx responses must never be cached');
  });
});

// =============================================================================
// Plan 09.3-02 Wave 2 — Card-specific builder contracts (Sankey, DayProfile,
// Stack, Heatmap, Ledger). Each test wires a mock telemetryStore.querySeries
// and ctx.db.query so the builders run against deterministic rows; the
// builders themselves remain the SUT.
//
// Series-key naming is the project canonical set (verified against
// dvhub/telemetry-store-pg.js:24-27): grid_import_w, grid_export_w,
// pv_total_w, battery_charge_w, battery_discharge_w, load_power_w.
// =============================================================================

const ANCHOR_DATE = '2026-05-14'; // a yesterday-stable choice
const SLOT_RES_SEC = 900;          // 15-min buckets, matches querySeries cap

function makeFlatSeriesRows({ start, end, key, watts, stepSec = SLOT_RES_SEC }) {
  // Generate one row per stepSec from start..end. ts as ISO string (matches
  // telemetry-store-pg.js querySeries return shape).
  const rows = [];
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  for (let t = startMs; t < endMs; t += stepSec * 1000) {
    rows.push({
      key,
      ts: new Date(t).toISOString(),
      value: watts,
      unit: 'W',
      resolution: stepSec,
    });
  }
  return rows;
}

function mockCtxWithStores({ querySeriesFn = async () => [], dbQueryFn = async () => ({ rows: [] }) } = {}) {
  const ctx = mockCtx();
  ctx.telemetryStore = { querySeries: querySeriesFn };
  ctx.db = { query: dbQueryFn };
  // Re-create the aggregator with the populated stores (the original mockCtx
  // wired a no-store factory).
  ctx.historyVizApi = createHistoryVizAggregator(ctx);
  return ctx;
}

describe('Plan 09.3-02 Wave 2 — Sankey/DayProfile/Stack/Heatmap/Ledger builders', () => {
  // -------------------------------------------------------------------------
  // Sankey (T1 + T2 — envelope + conservation)
  // -------------------------------------------------------------------------
  it('Test W2-1 (Sankey envelope): returns flows + totals with the documented keys', async () => {
    // Flat 2000W PV for the whole day, 1500W load, 200W grid_export, 300W battery_charge.
    // Day is 24h × 3600s × W/3600 → kWh; check the totals roughly add up.
    const querySeries = async ({ seriesKeys, start, end }) => {
      const all = [];
      for (const key of seriesKeys) {
        const w = (
          key === 'pv_total_w' ? 2000 :
          key === 'grid_export_w' ? 200 :
          key === 'grid_import_w' ? 100 :
          key === 'battery_charge_w' ? 300 :
          key === 'battery_discharge_w' ? 0 :
          key === 'load_power_w' ? 1500 :
          0
        );
        all.push(...makeFlatSeriesRows({ start, end, key, watts: w }));
      }
      return all;
    };
    const ctx = mockCtxWithStores({ querySeriesFn: querySeries });
    const r = await ctx.historyVizApi.getSankey({ view: 'day', date: ANCHOR_DATE });
    assert.equal(r.status, 200, `expected 200, got ${r.status} (body=${JSON.stringify(r.body)})`);
    const b = r.body;
    assert.equal(b.ok, true);
    assert.equal(b.card, 'sankey');
    assert.equal(b.view, 'day');
    assert.equal(b.date, ANCHOR_DATE);
    assert.ok(Array.isArray(b.flows), 'flows should be an array');
    assert.ok(b.flows.length >= 3, `expected at least 3 flows, got ${b.flows.length}`);
    for (const f of b.flows) {
      assert.equal(typeof f.from, 'string');
      assert.equal(typeof f.to, 'string');
      assert.equal(typeof f.flow, 'number');
    }
    assert.ok(b.totals && typeof b.totals.pvKwh === 'number', 'totals.pvKwh missing');
    assert.ok(typeof b.totals.eigenverbrauchKwh === 'number', 'totals.eigenverbrauchKwh missing');
    assert.ok(typeof b.totals.einspeisungKwh === 'number', 'totals.einspeisungKwh missing');
    // 2000W × 24h = 48 kWh
    assert.ok(b.totals.pvKwh > 40 && b.totals.pvKwh < 55, `pvKwh ~48 expected, got ${b.totals.pvKwh}`);
  });

  it('Test W2-2 (Sankey conservation): sum-from-PV ≈ totals.pvKwh ± 1%; sum-to-Eigenverbrauch ≈ totals.eigenverbrauchKwh ± 1%', async () => {
    const querySeries = async ({ seriesKeys, start, end }) => {
      const map = {
        pv_total_w: 3000, grid_export_w: 500, grid_import_w: 100,
        battery_charge_w: 400, battery_discharge_w: 200, load_power_w: 2000,
      };
      const all = [];
      for (const key of seriesKeys) all.push(...makeFlatSeriesRows({ start, end, key, watts: map[key] || 0 }));
      return all;
    };
    const ctx = mockCtxWithStores({ querySeriesFn: querySeries });
    const r = await ctx.historyVizApi.getSankey({ view: 'day', date: ANCHOR_DATE });
    assert.equal(r.status, 200);
    const b = r.body;
    const sumFromPv = b.flows.filter(f => f.from === 'PV').reduce((s, f) => s + f.flow, 0);
    const sumToEigen = b.flows.filter(f => f.to === 'Eigenverbrauch').reduce((s, f) => s + f.flow, 0);
    assert.ok(
      Math.abs(sumFromPv - b.totals.pvKwh) / Math.max(1e-6, b.totals.pvKwh) <= 0.01,
      `sum-from-PV (${sumFromPv}) should match totals.pvKwh (${b.totals.pvKwh}) within 1%`
    );
    assert.ok(
      Math.abs(sumToEigen - b.totals.eigenverbrauchKwh) / Math.max(1e-6, b.totals.eigenverbrauchKwh) <= 0.01,
      `sum-to-Eigenverbrauch (${sumToEigen}) should match totals.eigenverbrauchKwh (${b.totals.eigenverbrauchKwh}) within 1%`
    );
  });

  // -------------------------------------------------------------------------
  // DayProfile (T3 — shape)
  // -------------------------------------------------------------------------
  it('Test W2-3 (DayProfile shape): 24 entries each in pv[] and load[], h ∈ 0..23', async () => {
    const querySeries = async ({ seriesKeys, start, end }) => {
      const map = { pv_total_w: 1500, load_power_w: 800 };
      const all = [];
      for (const key of seriesKeys) all.push(...makeFlatSeriesRows({ start, end, key, watts: map[key] || 0 }));
      return all;
    };
    const ctx = mockCtxWithStores({ querySeriesFn: querySeries });
    const r = await ctx.historyVizApi.getDayProfile({ view: 'day', date: ANCHOR_DATE });
    assert.equal(r.status, 200, `expected 200, got ${r.status} (body=${JSON.stringify(r.body)})`);
    const b = r.body;
    assert.equal(b.card, 'day-profile');
    assert.equal(b.hours, 24);
    assert.ok(Array.isArray(b.pv) && b.pv.length === 24, `pv len 24 expected, got ${b.pv?.length}`);
    assert.ok(Array.isArray(b.load) && b.load.length === 24, `load len 24 expected, got ${b.load?.length}`);
    for (let i = 0; i < 24; i++) {
      assert.equal(b.pv[i].h, i, `pv[${i}].h mismatch`);
      assert.equal(typeof b.pv[i].w, 'number');
      assert.equal(b.load[i].h, i);
      assert.equal(typeof b.load[i].w, 'number');
    }
  });

  it('Test W2-3b (DayProfile rejects non-day views)', async () => {
    const ctx = mockCtxWithStores();
    const r = await ctx.historyVizApi.getDayProfile({ view: 'week', date: ANCHOR_DATE });
    assert.equal(r.status, 400, `expected 400 for view='week', got ${r.status}`);
    assert.match(r.body.error || '', /view/i);
  });

  // -------------------------------------------------------------------------
  // Stack (T4 — bucket counts across views)
  // -------------------------------------------------------------------------
  it('Test W2-4 (Stack across views): bucket counts 24/7/30-31/12', async () => {
    const querySeries = async ({ seriesKeys, start, end }) => {
      const map = {
        pv_total_w: 1000, battery_discharge_w: 200, grid_import_w: 100, load_power_w: 800,
      };
      const all = [];
      for (const key of seriesKeys) all.push(...makeFlatSeriesRows({ start, end, key, watts: map[key] || 0 }));
      return all;
    };
    const ctx = mockCtxWithStores({ querySeriesFn: querySeries });

    const day = await ctx.historyVizApi.getStack({ view: 'day', date: ANCHOR_DATE });
    assert.equal(day.status, 200);
    assert.equal(day.body.buckets, 24, `day buckets=24 expected, got ${day.body.buckets}`);
    assert.equal(day.body.bucketLabels.length, 24);
    assert.equal(day.body.pvDirectKwh.length, 24);
    assert.equal(day.body.loadKwh.length, 24);

    const wk = await ctx.historyVizApi.getStack({ view: 'week', date: ANCHOR_DATE });
    assert.equal(wk.status, 200);
    assert.equal(wk.body.buckets, 7);
    assert.equal(wk.body.bucketLabels.length, 7);

    const mo = await ctx.historyVizApi.getStack({ view: 'month', date: ANCHOR_DATE });
    assert.equal(mo.status, 200);
    assert.ok(mo.body.buckets === 30 || mo.body.buckets === 31, `month buckets 30|31 expected, got ${mo.body.buckets}`);

    const yr = await ctx.historyVizApi.getStack({ view: 'year', date: ANCHOR_DATE });
    assert.equal(yr.status, 200);
    assert.equal(yr.body.buckets, 12);
  });

  // -------------------------------------------------------------------------
  // Heatmap (T5 — shape; T6 — payload size)
  // -------------------------------------------------------------------------
  it('Test W2-5 (Heatmap shape week): xLabels.length=7, yLabels.length=24, matrix.length=168', async () => {
    const querySeries = async ({ seriesKeys, start, end }) => {
      const all = [];
      for (const key of seriesKeys) {
        if (key !== 'pv_total_w') continue;
        all.push(...makeFlatSeriesRows({ start, end, key, watts: 1500 }));
      }
      return all;
    };
    const ctx = mockCtxWithStores({ querySeriesFn: querySeries });
    const r = await ctx.historyVizApi.getHeatmap({ view: 'week', date: ANCHOR_DATE });
    assert.equal(r.status, 200, `expected 200, got ${r.status} (body=${JSON.stringify(r.body).slice(0, 200)})`);
    const b = r.body;
    assert.equal(b.card, 'heatmap');
    assert.equal(b.xLabels.length, 7, `week xLabels=7, got ${b.xLabels.length}`);
    assert.equal(b.yLabels.length, 24, `week yLabels=24, got ${b.yLabels.length}`);
    assert.equal(b.matrix.length, 168, `week matrix.length=168, got ${b.matrix.length}`);
    for (const c of b.matrix.slice(0, 3)) {
      assert.equal(typeof c.x, 'string');
      assert.equal(typeof c.y, 'number');
      assert.equal(typeof c.v, 'number');
    }
  });

  it('Test W2-5b (Heatmap rejects view=day): 400', async () => {
    const ctx = mockCtxWithStores();
    const r = await ctx.historyVizApi.getHeatmap({ view: 'day', date: ANCHOR_DATE });
    assert.equal(r.status, 400, `expected 400 for view='day', got ${r.status}`);
  });

  it('Test W2-6 (Heatmap payload size month ≤ 50_000 bytes)', async () => {
    const querySeries = async ({ seriesKeys, start, end }) => {
      const all = [];
      for (const key of seriesKeys) {
        if (key !== 'pv_total_w') continue;
        all.push(...makeFlatSeriesRows({ start, end, key, watts: 2000 }));
      }
      return all;
    };
    const ctx = mockCtxWithStores({ querySeriesFn: querySeries });
    const r = await ctx.historyVizApi.getHeatmap({ view: 'month', date: ANCHOR_DATE });
    assert.equal(r.status, 200);
    const bytes = Buffer.byteLength(JSON.stringify(r.body), 'utf8');
    assert.ok(bytes <= 50_000, `month payload should be <= 50KB, got ${bytes} bytes`);
  });

  // -------------------------------------------------------------------------
  // Ledger (T7 — shape + sort)
  // -------------------------------------------------------------------------
  it('Test W2-7 (Ledger shape + sort): slots ≤ 12, sorted by ts DESC, every entry shape', async () => {
    // Build 15 fake rows so the LIMIT 12 is exercised. Row shape mirrors what
    // the SQL adapter produces (column-name-mapped), all columns the live
    // builder needs are present.
    const dbQuery = async (sql, params) => {
      // Verify the builder used parameterized SQL
      assert.ok(Array.isArray(params) && params.length >= 1, 'getLedger MUST use parameterized SQL');
      // Generate 15 plan_slot-like rows in reverse-time order so the builder
      // can either rely on SQL ORDER or sort itself; either way the response
      // must come back DESC.
      const rows = [];
      for (let i = 14; i >= 0; i--) {
        const ts = new Date(`${ANCHOR_DATE}T${String(i).padStart(2, '0')}:00:00Z`).toISOString();
        rows.push({
          slot_start: ts,
          // Mix actions: even = sell (export), odd = buy (import)
          grid_import_wh: i % 2 === 0 ? 0 : 1400,
          grid_export_wh: i % 2 === 0 ? 1400 : 0,
          battery_charge_grid_wh: 0,
          battery_charge_pv_wh: 0,
          battery_discharge_load_wh: 0,
          battery_discharge_export_wh: 0,
          expected_profit_eur: 0.255,
          price_ct_kwh: 18.2,
        });
      }
      return { rows };
    };
    const ctx = mockCtxWithStores({ dbQueryFn: dbQuery });
    const r = await ctx.historyVizApi.getLedger({ view: 'day', date: ANCHOR_DATE });
    assert.equal(r.status, 200, `expected 200, got ${r.status} (body=${JSON.stringify(r.body).slice(0, 200)})`);
    const b = r.body;
    assert.equal(b.card, 'ledger');
    assert.ok(Array.isArray(b.slots), 'slots should be array');
    assert.ok(b.slots.length <= 12, `slots.length should be <= 12, got ${b.slots.length}`);
    // Sorted DESC by ts
    for (let i = 1; i < b.slots.length; i++) {
      assert.ok(b.slots[i - 1].ts >= b.slots[i].ts, `slots not DESC at ${i}: ${b.slots[i - 1].ts} < ${b.slots[i].ts}`);
    }
    // Per-entry shape
    for (const s of b.slots) {
      assert.equal(typeof s.ts, 'string');
      assert.ok(['sell', 'buy', 'hold'].includes(s.action), `bad action: ${s.action}`);
      assert.equal(typeof s.kwh, 'number');
      assert.equal(typeof s.priceCt, 'number');
      assert.equal(typeof s.revenueEur, 'number');
    }
    assert.equal(typeof b.totalEur, 'number');
  });

  it('Test W2-7b (Ledger rejects non-day views)', async () => {
    const ctx = mockCtxWithStores();
    const r = await ctx.historyVizApi.getLedger({ view: 'week', date: ANCHOR_DATE });
    assert.equal(r.status, 400, `expected 400 for view='week', got ${r.status}`);
  });

  // -------------------------------------------------------------------------
  // Cache hit envelope (T8 — second call mirrors top-level flag)
  // -------------------------------------------------------------------------
  it('Test W2-8 (cache hit envelope): second getSankey call returns cached:true at envelope AND top level', async () => {
    let calls = 0;
    const querySeries = async ({ seriesKeys, start, end }) => {
      calls++;
      const all = [];
      for (const key of seriesKeys) all.push(...makeFlatSeriesRows({ start, end, key, watts: 1000 }));
      return all;
    };
    const ctx = mockCtxWithStores({ querySeriesFn: querySeries });
    const r1 = await ctx.historyVizApi.getSankey({ view: 'day', date: ANCHOR_DATE });
    const r2 = await ctx.historyVizApi.getSankey({ view: 'day', date: ANCHOR_DATE });
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r1.cached, false, 'first call should be cached:false');
    assert.equal(r1.body.cached, false, 'first call body.cached should be false');
    assert.equal(r2.cached, true, 'second call should be cached:true at top level');
    assert.equal(r2.body.cached, true, 'second call body.cached should be true (envelope mirror)');
    assert.equal(calls, 1, `querySeries should run once for two cached calls; ran ${calls}`);
  });
});

// =============================================================================
// Plan 09.3-03 Wave 3 — Autarky-Calendar / 24h-Ring / Preis-Duration-Curve.
//
// These three cards (CONTEXT D-04 Gruppe B Tier-1) are simpler aggregations:
//   - autarky-calendar: per-day self-sufficiency % over a date range
//   - ring: day-only 24-hour PV + load + spot-price summary
//   - duration: price-sorted-descending slot curve with 2 thresholds
//
// Series-key naming continues the project-canonical set from Wave 2:
// load_power_w + grid_import_w (for autarky), pv_total_w + load_power_w
// (for ring). Spot price comes from shared.market_price_slots — verified
// column names: slot_start (TIMESTAMPTZ), price_kind ('market'), price_ct_kwh
// (NUMERIC). The plan-doc assumed `ts_utc` + `price_ct_per_kwh`; the real
// schema (009-shared-tables.sql:253-269) uses slot_start + price_ct_kwh.
// =============================================================================

describe('Plan 09.3-03 Wave 3 — AutarkyCalendar/Ring/Duration builders', () => {
  // -------------------------------------------------------------------------
  // AutarkyCalendar (W3-1 envelope shape, W3-2 values bounded)
  // -------------------------------------------------------------------------
  it('Test W3-1 (Autarky envelope shape): month view → xLabels span the range, matrix length = xLabels × yLabels', async () => {
    // Flat 800W load, 300W grid_import for a 30-day month window.
    const querySeries = async ({ seriesKeys, start, end }) => {
      const map = { load_power_w: 800, grid_import_w: 300 };
      const all = [];
      for (const key of seriesKeys) all.push(...makeFlatSeriesRows({ start, end, key, watts: map[key] || 0 }));
      return all;
    };
    const ctx = mockCtxWithStores({ querySeriesFn: querySeries });
    const r = await ctx.historyVizApi.getAutarkyCalendar({ view: 'month', date: ANCHOR_DATE });
    assert.equal(r.status, 200, `expected 200, got ${r.status} (body=${JSON.stringify(r.body).slice(0, 200)})`);
    const b = r.body;
    assert.equal(b.card, 'autarky-calendar');
    assert.ok(Array.isArray(b.xLabels), 'xLabels should be an array');
    // 30-day rolling window → 28..31 dates with data
    assert.ok(b.xLabels.length >= 28 && b.xLabels.length <= 31, `xLabels length 28-31 expected, got ${b.xLabels.length}`);
    assert.ok(Array.isArray(b.yLabels) && b.yLabels.length === 7, `yLabels should be 7 day-of-week labels, got ${b.yLabels?.length}`);
    assert.ok(Array.isArray(b.matrix), 'matrix should be an array');
    // One cell per actual date (each day maps to exactly one dow row).
    assert.equal(b.matrix.length, b.xLabels.length, `matrix.length (${b.matrix.length}) should equal xLabels.length (${b.xLabels.length})`);
    assert.ok(b.domain && b.domain.min === 0 && b.domain.max === 100, 'domain should be {min:0,max:100}');
  });

  it('Test W3-2 (Autarky values bounded): every matrix cell v ∈ [0, 100]', async () => {
    // grid_import > load on some rows to force the clamp at 0; grid_import = 0
    // on others to push toward 100. Builder must clamp regardless of input.
    const querySeries = async ({ seriesKeys, start, end }) => {
      const all = [];
      for (const key of seriesKeys) {
        // load_power_w 1000W flat; grid_import_w alternates 0 / 1500 (1500 > 1000
        // would yield negative autarky → must clamp to 0).
        const w = key === 'load_power_w' ? 1000 : (key === 'grid_import_w' ? 1500 : 0);
        all.push(...makeFlatSeriesRows({ start, end, key, watts: w }));
      }
      return all;
    };
    const ctx = mockCtxWithStores({ querySeriesFn: querySeries });
    const r = await ctx.historyVizApi.getAutarkyCalendar({ view: 'week', date: ANCHOR_DATE });
    assert.equal(r.status, 200);
    for (const cell of r.body.matrix) {
      assert.ok(cell.v >= 0 && cell.v <= 100, `cell v out of range: ${cell.v}`);
      assert.ok(typeof cell.x === 'string', 'cell.x should be a date string');
      assert.ok(typeof cell.y === 'number' && cell.y >= 0 && cell.y <= 6, `cell.y should be 0..6, got ${cell.y}`);
    }
  });

  // -------------------------------------------------------------------------
  // Ring (W3-3 view restriction, W3-4 totals consistency)
  // -------------------------------------------------------------------------
  it('Test W3-3 (Ring view restriction): view=week → 400; view=day → 200 with hourly.length=24', async () => {
    const querySeries = async ({ seriesKeys, start, end }) => {
      const map = { pv_total_w: 1200, load_power_w: 700 };
      const all = [];
      for (const key of seriesKeys) all.push(...makeFlatSeriesRows({ start, end, key, watts: map[key] || 0 }));
      return all;
    };
    const ctx = mockCtxWithStores({ querySeriesFn: querySeries });
    const wk = await ctx.historyVizApi.getRing({ view: 'week', date: ANCHOR_DATE });
    assert.equal(wk.status, 400, `expected 400 for view=week, got ${wk.status}`);
    assert.match(wk.body.error || '', /view/i);
    const day = await ctx.historyVizApi.getRing({ view: 'day', date: ANCHOR_DATE });
    assert.equal(day.status, 200, `expected 200 for view=day, got ${day.status} (body=${JSON.stringify(day.body).slice(0, 200)})`);
    assert.equal(day.body.card, 'ring');
    assert.ok(Array.isArray(day.body.hourly) && day.body.hourly.length === 24, `hourly should be 24 entries, got ${day.body.hourly?.length}`);
    for (let h = 0; h < 24; h++) {
      assert.equal(day.body.hourly[h].h, h, `hourly[${h}].h mismatch`);
      assert.equal(typeof day.body.hourly[h].pvKwh, 'number');
      assert.equal(typeof day.body.hourly[h].loadKwh, 'number');
      assert.equal(typeof day.body.hourly[h].spotCt, 'number');
    }
  });

  it('Test W3-4 (Ring totals consistency): totals.autarkyPct matches the per-hour deficit formula ± 1', async () => {
    const querySeries = async ({ seriesKeys, start, end }) => {
      // PV 1500W, load 1000W — PV exceeds load every hour → autarky should be 100.
      const map = { pv_total_w: 1500, load_power_w: 1000 };
      const all = [];
      for (const key of seriesKeys) all.push(...makeFlatSeriesRows({ start, end, key, watts: map[key] || 0 }));
      return all;
    };
    // No market-price rows — spot prices come back as 0; ring still builds.
    const ctx = mockCtxWithStores({ querySeriesFn: querySeries, dbQueryFn: async () => ({ rows: [] }) });
    const r = await ctx.historyVizApi.getRing({ view: 'day', date: ANCHOR_DATE });
    assert.equal(r.status, 200);
    const b = r.body;
    assert.ok(b.totals && typeof b.totals.pvKwh === 'number', 'totals.pvKwh missing');
    assert.ok(typeof b.totals.loadKwh === 'number', 'totals.loadKwh missing');
    assert.ok(typeof b.totals.autarkyPct === 'number', 'totals.autarkyPct missing');
    // Recompute autarkyPct from hourly deficit and compare ± 1.
    const deficit = b.hourly.reduce((s, h) => s + Math.max(0, h.loadKwh - h.pvKwh), 0);
    const expected = b.totals.loadKwh > 0
      ? Math.round((b.totals.loadKwh - deficit) / b.totals.loadKwh * 100)
      : 0;
    assert.ok(
      Math.abs(b.totals.autarkyPct - expected) <= 1,
      `autarkyPct (${b.totals.autarkyPct}) should match deficit formula (${expected}) ± 1`
    );
  });

  // -------------------------------------------------------------------------
  // Duration (W3-5 sorted DESC + rank, W3-6 thresholds source)
  // -------------------------------------------------------------------------
  it('Test W3-5 (Duration sorted): slots descending by priceCt, rank = index + 1', async () => {
    // Return prices in scrambled order; builder MUST sort DESC and re-rank.
    const dbQuery = async (sql, params) => {
      assert.ok(Array.isArray(params) && params.length >= 1, 'getDuration MUST use parameterized SQL');
      assert.match(sql, /market_price_slots/i, 'getDuration SQL should query market_price_slots');
      return { rows: [
        { price_ct_kwh: 8.2 }, { price_ct_kwh: 32.1 }, { price_ct_kwh: -2.4 },
        { price_ct_kwh: 38.4 }, { price_ct_kwh: 5.0 }, { price_ct_kwh: 15.5 },
      ] };
    };
    const ctx = mockCtxWithStores({ dbQueryFn: dbQuery });
    const r = await ctx.historyVizApi.getDuration({ view: 'day', date: ANCHOR_DATE });
    assert.equal(r.status, 200, `expected 200, got ${r.status} (body=${JSON.stringify(r.body).slice(0, 200)})`);
    const b = r.body;
    assert.equal(b.card, 'duration');
    assert.ok(Array.isArray(b.slots) && b.slots.length === 6, `expected 6 slots, got ${b.slots?.length}`);
    // Descending
    assert.ok(b.slots[0].priceCt >= b.slots[b.slots.length - 1].priceCt, 'slots should be DESC by priceCt');
    for (let i = 1; i < b.slots.length; i++) {
      assert.ok(b.slots[i - 1].priceCt >= b.slots[i].priceCt, `slots not DESC at index ${i}`);
    }
    // rank = index + 1
    for (let i = 0; i < b.slots.length; i++) {
      assert.equal(b.slots[i].rank, i + 1, `slot[${i}].rank should be ${i + 1}, got ${b.slots[i].rank}`);
    }
    assert.equal(b.slots[0].priceCt, 38.4, 'highest price should be first');
  });

  it('Test W3-6 (Duration thresholds + stats): thresholds resolved with cfg fallback, stats computed', async () => {
    const dbQuery = async () => ({ rows: [
      { price_ct_kwh: 3.0 }, { price_ct_kwh: 4.0 }, { price_ct_kwh: 14.0 },
      { price_ct_kwh: 16.0 }, { price_ct_kwh: 8.0 },
    ] });
    const ctx = mockCtxWithStores({ dbQueryFn: dbQuery });
    const r = await ctx.historyVizApi.getDuration({ view: 'day', date: ANCHOR_DATE });
    assert.equal(r.status, 200);
    const b = r.body;
    assert.ok(b.thresholds, 'thresholds object missing');
    // mockCtx cfg.optimizer has no chargeBelowCt/sellAboveCt → fallback {5, 12}.
    assert.equal(b.thresholds.chargeBelowCt, 5, 'chargeBelowCt fallback should be 5');
    assert.equal(b.thresholds.sellAboveCt, 12, 'sellAboveCt fallback should be 12');
    assert.ok(b.stats, 'stats object missing');
    assert.equal(typeof b.stats.meanCt, 'number', 'stats.meanCt should be a number');
    // mean of [3,4,14,16,8] = 9.0
    assert.ok(Math.abs(b.stats.meanCt - 9.0) < 0.01, `meanCt ~9.0 expected, got ${b.stats.meanCt}`);
    // hoursBelowChargeThreshold: prices < 5 → {3, 4} → count 2
    assert.equal(b.stats.hoursBelowChargeThreshold, 2, `hoursBelowChargeThreshold should be 2, got ${b.stats.hoursBelowChargeThreshold}`);
    // hoursAboveSellThreshold: prices > 12 → {14, 16} → count 2
    assert.equal(b.stats.hoursAboveSellThreshold, 2, `hoursAboveSellThreshold should be 2, got ${b.stats.hoursAboveSellThreshold}`);
  });

  // -------------------------------------------------------------------------
  // Cache (W3-7 — hit + per-(view,date) isolation across the 3 new cards)
  // -------------------------------------------------------------------------
  it('Test W3-7 (cache hit + isolation): each Wave-3 card caches; (view,date) keys never collide', async () => {
    let durationCalls = 0;
    const dbQuery = async () => { durationCalls++; return { rows: [{ price_ct_kwh: 10 }, { price_ct_kwh: 20 }] }; };
    const querySeries = async ({ seriesKeys, start, end }) => {
      const all = [];
      for (const key of seriesKeys) all.push(...makeFlatSeriesRows({ start, end, key, watts: 600 }));
      return all;
    };
    const ctx = mockCtxWithStores({ querySeriesFn: querySeries, dbQueryFn: dbQuery });

    // Duration cache hit on 2nd identical call.
    const d1 = await ctx.historyVizApi.getDuration({ view: 'day', date: ANCHOR_DATE });
    const d2 = await ctx.historyVizApi.getDuration({ view: 'day', date: ANCHOR_DATE });
    assert.equal(d1.cached, false, 'first duration call cached:false');
    assert.equal(d2.cached, true, 'second duration call cached:true');
    assert.equal(d2.body.cached, true, 'second duration body.cached:true');
    assert.equal(durationCalls, 1, `duration db.query should run once across two cached calls; ran ${durationCalls}`);

    // Isolation: (view=week) is a separate cache entry from (view=day).
    const dWeek = await ctx.historyVizApi.getDuration({ view: 'week', date: ANCHOR_DATE });
    assert.equal(dWeek.cached, false, 'view=week is a distinct cache key — must not be a hit');
    assert.equal(durationCalls, 2, 'view=week should trigger a fresh db.query');

    // Autarky + Ring also cache on 2nd call.
    const a1 = await ctx.historyVizApi.getAutarkyCalendar({ view: 'month', date: ANCHOR_DATE });
    const a2 = await ctx.historyVizApi.getAutarkyCalendar({ view: 'month', date: ANCHOR_DATE });
    assert.equal(a1.cached, false);
    assert.equal(a2.cached, true, 'autarky-calendar should cache on 2nd call');
    const ri1 = await ctx.historyVizApi.getRing({ view: 'day', date: ANCHOR_DATE });
    const ri2 = await ctx.historyVizApi.getRing({ view: 'day', date: ANCHOR_DATE });
    assert.equal(ri1.cached, false);
    assert.equal(ri2.cached, true, 'ring should cache on 2nd call');
  });
});
