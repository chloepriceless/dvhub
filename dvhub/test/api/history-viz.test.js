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

  it('Test 1 (envelope shape): each of 14 stubs returns a 501 envelope with required keys', async () => {
    const api = createHistoryVizAggregator(mockCtx());
    for (const slug of SLUGS) {
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

  it('Test 4 (LAN-bypass prefix gate): LAN IP without Bearer → 501 stub; REMOTE IP without Bearer → 401/503', async () => {
    const ctx = mockCtx();
    const lanReq = makeReq('/api/history/viz/sankey?view=day&date=2026-05-15', { token: null, ip: LAN_IP });
    const lanRes = await dispatch(ctx, lanReq);
    assert.equal(
      lanRes.status, 501,
      `LAN IP (${LAN_IP}) without Bearer should bypass auth and hit stub (got ${lanRes.status} ${lanRes.body})`
    );
    const lanBody = JSON.parse(lanRes.body);
    assert.equal(lanBody.card, 'sankey');
    assert.equal(lanBody.error, 'not_implemented');

    const remReq = makeReq('/api/history/viz/sankey?view=day&date=2026-05-15', { token: null, ip: REMOTE_IP });
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
