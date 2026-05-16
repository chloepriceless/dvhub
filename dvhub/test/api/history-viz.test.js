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
  'cycles', 'top10', 'cal-year', 'scatter', 'neg-price',
];

const SLUG_TO_METHOD = {
  sankey: 'getSankey', heatmap: 'getHeatmap', ledger: 'getLedger',
  'day-profile': 'getDayProfile', stack: 'getStack',
  'autarky-calendar': 'getAutarkyCalendar', ring: 'getRing',
  duration: 'getDuration', pheat: 'getPheat', spaghetti: 'getSpaghetti',
  cycles: 'getCycles', top10: 'getTop10', 'cal-year': 'getCalYear',
  scatter: 'getScatter', 'neg-price': 'getNegPrice',
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
  it('exposes all 15 getXxx methods + bustCache', () => {
    const api = createHistoryVizAggregator(mockCtx());
    for (const slug of SLUGS) {
      const m = SLUG_TO_METHOD[slug];
      assert.equal(typeof api[m], 'function', `expected api.${m} to be a function`);
    }
    assert.equal(typeof api.bustCache, 'function', 'expected api.bustCache to be a function');
  });

  // Wave 2 (Plan 09.3-02) lit 5 live builders (sankey, day-profile, stack,
  // heatmap, ledger); Wave 3 (Plan 09.3-03) lit 3 more (autarky-calendar,
  // ring, duration); Wave 4 (Plan 09.3-04) lit 3 more (pheat, spaghetti,
  // cycles); Wave 5 (Plan 09.3-05) lit the FINAL 3 (top10, cal-year, scatter).
  // All 14 builders are now live → STUB_SLUGS is empty. Test 1 keeps the
  // 0-stub assertion as a regression guard; the live builders have dedicated
  // contract tests in the wave suites below.
  const LIVE_SLUGS = [
    'sankey', 'day-profile', 'stack', 'heatmap', 'ledger',
    'autarky-calendar', 'ring', 'duration',
    'pheat', 'spaghetti', 'cycles',
    'top10', 'cal-year', 'scatter', 'neg-price',
  ];
  const STUB_SLUGS = SLUGS.filter((s) => !LIVE_SLUGS.includes(s));

  it('Test 1 (envelope shape): each remaining stub returns a 501 envelope with required keys', async () => {
    const api = createHistoryVizAggregator(mockCtx());
    // Wave 5 (Plan 09.3-05) lights the final 3 builders (top10, cal-year,
    // scatter). After this plan ALL 14 builders are live → STUB_SLUGS is empty
    // and this loop is a no-op (the contract still asserts the count).
    assert.equal(STUB_SLUGS.length, 0, `expected 0 remaining stubs after Wave 5, got ${STUB_SLUGS.length}`);
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

  it('Test 4 (LAN-bypass prefix gate): LAN IP without Bearer → reaches dispatcher; REMOTE IP without Bearer → 401/503', async () => {
    // After Wave 5 ALL 14 builders are live, so there is no longer a 501-stub
    // slug to point this at. The LAN-bypass invariant only cares that the auth
    // gate sits BEFORE the dispatcher: a LAN IP without Bearer must REACH the
    // builder (any non-401/403 status proves the gate was bypassed — here the
    // bare mockCtx has no `db`, so `getTop10` runs its query path against a
    // null db and returns a 200 with empty slots); a REMOTE IP without Bearer
    // must still be rejected by the gate (401 if token configured, 503 if not).
    // Use view=week — getTop10 rejects view=day (period roll-up), and a 400
    // validation envelope would not exercise the builder body.
    const ctx = mockCtx();
    const lanReq = makeReq('/api/history/viz/top10?view=week&date=2026-05-15', { token: null, ip: LAN_IP });
    const lanRes = await dispatch(ctx, lanReq);
    assert.ok(
      lanRes.status !== 401 && lanRes.status !== 403,
      `LAN IP (${LAN_IP}) without Bearer should bypass auth and reach the dispatcher (got ${lanRes.status} ${lanRes.body})`
    );
    const lanBody = JSON.parse(lanRes.body);
    assert.equal(lanBody.card, 'top10', 'LAN response should come from the top10 builder');

    const remReq = makeReq('/api/history/viz/top10?view=week&date=2026-05-15', { token: null, ip: REMOTE_IP });
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

// queryBucketedSeries mock — RC-1 (Phase 09.3) moved history-viz downsampling
// into SQL via TimescaleDB time_bucket(). The aggregator builders now call
// telemetryStore.queryBucketedSeries instead of querySeries. This adapter
// reproduces the production contract on top of a plain querySeries mock:
// it groups the raw rows into time buckets and emits one row per bucket with
//   value      = SUM(v × resolution) / bucketSeconds  (energy-equivalent avg W
//                — so value × resolution / 3_600_000 = exact bucket kWh)
//   value_avg  = AVG(v)                               (plain mean — for ratio
//                series like battery_soc_pct)
//   resolution = bucketSeconds
// matching the real telemetry-store-pg.js queryBucketedSeries return shape.
const BUCKET_INTERVAL_SECONDS = {
  '5 minutes': 300,
  '10 minutes': 600,
  '15 minutes': 900,
  '30 minutes': 1800,
  '1 hour': 3600,
  '1 day': 86400,
};

function bucketRawRows(rawRows, bucketSec) {
  // group key = `${series_key}|${bucketStartMs}`
  const groups = new Map();
  for (const r of rawRows) {
    const tsMs = Date.parse(r.ts);
    if (!Number.isFinite(tsMs)) continue;
    const bucketMs = Math.floor(tsMs / (bucketSec * 1000)) * bucketSec * 1000;
    const gk = `${r.key}|${bucketMs}`;
    if (!groups.has(gk)) {
      groups.set(gk, { key: r.key, bucketMs, energyWs: 0, sum: 0, count: 0, unit: r.unit });
    }
    const g = groups.get(gk);
    const v = Number(r.value);
    const res = Number(r.resolution || 0);
    if (Number.isFinite(v)) {
      g.energyWs += v * (Number.isFinite(res) ? res : 0);
      g.sum += v;
      g.count += 1;
    }
  }
  const out = [];
  for (const g of groups.values()) {
    out.push({
      key: g.key,
      ts: new Date(g.bucketMs).toISOString(),
      value: g.energyWs / bucketSec,
      value_avg: g.count > 0 ? g.sum / g.count : 0,
      unit: g.unit,
      resolution: bucketSec,
    });
  }
  out.sort((a, b) => (a.ts === b.ts ? a.key.localeCompare(b.key) : a.ts.localeCompare(b.ts)));
  return out;
}

function mockCtxWithStores({ querySeriesFn = async () => [], dbQueryFn = async () => ({ rows: [] }) } = {}) {
  const ctx = mockCtx();
  // queryBucketedSeries adapter — runs querySeriesFn to get raw rows, then
  // buckets them per the requested interval (mirrors the SQL GROUP BY).
  const queryBucketedSeriesFn = async ({ seriesKeys, start, end, bucketInterval }) => {
    const bucketSec = BUCKET_INTERVAL_SECONDS[bucketInterval];
    assert.ok(bucketSec, `mock queryBucketedSeries: unknown bucketInterval '${bucketInterval}'`);
    const rawRows = await querySeriesFn({ seriesKeys, start, end, maxResolution: 900 });
    return bucketRawRows(rawRows, bucketSec);
  };
  ctx.telemetryStore = { querySeries: querySeriesFn, queryBucketedSeries: queryBucketedSeriesFn };
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

  it('Test W2-2 (Sankey conservation): per-bucket decomposition — sum-from-PV == total PV, sum-to-Eigenverbrauch == total load', async () => {
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
    const sumToEinspeisung = b.flows.filter(f => f.to === 'Einspeisung').reduce((s, f) => s + f.flow, 0);
    // CONSERVATION — the per-bucket decomposition makes sum-from-PV exactly
    // equal total PV (no overshoot from grid-arbitrage charging).
    assert.ok(
      Math.abs(sumFromPv - b.totals.pvKwh) <= 0.05,
      `sum-from-PV (${sumFromPv}) MUST equal totals.pvKwh (${b.totals.pvKwh}) ± rounding`
    );
    // sum-to-Eigenverbrauch == total household load == totals.eigenverbrauchKwh.
    assert.ok(
      Math.abs(sumToEigen - b.totals.eigenverbrauchKwh) <= 0.05,
      `sum-to-Eigenverbrauch (${sumToEigen}) MUST equal totals.eigenverbrauchKwh (${b.totals.eigenverbrauchKwh}) ± rounding`
    );
    // einspeisung total = sum of flows into Einspeisung (PV + battery).
    assert.ok(
      Math.abs(sumToEinspeisung - b.totals.einspeisungKwh) <= 0.05,
      `sum-to-Einspeisung (${sumToEinspeisung}) MUST equal totals.einspeisungKwh (${b.totals.einspeisungKwh}) ± rounding`
    );
  });

  it('Test W2-2b (Sankey grid-arbitrage conservation): charge+export > PV must NOT make PV-out flows overshoot total PV', async () => {
    // Round-2 bug repro — a grid-arbitrage battery charges from the grid in
    // cheap hours, so over the period batteryCharge + gridExport can exceed PV.
    // PV 1000W, load 800W, export 600W, charge 900W → charge+export=1500 > 1000.
    // The old period-level decomposition overshot PV; per-bucket cannot.
    const querySeries = async ({ seriesKeys, start, end }) => {
      const map = {
        pv_total_w: 1000, grid_export_w: 600, grid_import_w: 700,
        battery_charge_w: 900, battery_discharge_w: 100, load_power_w: 800,
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
    assert.ok(
      sumFromPv <= b.totals.pvKwh + 0.05,
      `PV-out flows (${sumFromPv}) MUST NOT exceed total PV (${b.totals.pvKwh})`
    );
    assert.ok(
      Math.abs(sumFromPv - b.totals.pvKwh) <= 0.05,
      `PV-out flows (${sumFromPv}) MUST conserve to total PV (${b.totals.pvKwh})`
    );
    // Grid→Akku flow must appear when the battery charges beyond what PV covers.
    const gridToBattery = b.flows.find(f => f.from === 'Netzbezug' && f.to === 'Akku-Laden');
    assert.ok(gridToBattery && gridToBattery.flow > 0, 'grid-arbitrage charging should yield a Netzbezug→Akku-Laden flow');
  });

  it('Test W2-2c (Sankey flow types): from/to use the 7 documented edge types', async () => {
    const querySeries = async ({ seriesKeys, start, end }) => {
      const map = {
        pv_total_w: 2000, grid_export_w: 300, grid_import_w: 400,
        battery_charge_w: 600, battery_discharge_w: 500, load_power_w: 1500,
      };
      const all = [];
      for (const key of seriesKeys) all.push(...makeFlatSeriesRows({ start, end, key, watts: map[key] || 0 }));
      return all;
    };
    const ctx = mockCtxWithStores({ querySeriesFn: querySeries });
    const r = await ctx.historyVizApi.getSankey({ view: 'day', date: ANCHOR_DATE });
    assert.equal(r.status, 200);
    const ALLOWED_FROM = new Set(['PV', 'Netzbezug', 'Akku-Entladen']);
    const ALLOWED_TO = new Set(['Eigenverbrauch', 'Akku-Laden', 'Einspeisung']);
    for (const f of r.body.flows) {
      assert.ok(ALLOWED_FROM.has(f.from), `unexpected flow.from '${f.from}'`);
      assert.ok(ALLOWED_TO.has(f.to), `unexpected flow.to '${f.to}'`);
    }
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

  it('Test W2-4b (RC-E — Stack PV-Direkt bucket-join): pvDirectKwh non-zero even when PV and load sample at different timestamps', async () => {
    // RC-E — the old getStack joined PV and load on the EXACT ts string; PV and
    // load are sampled at different ts_utc so the join almost never matched and
    // pvDirectKwh collapsed to all-zeros. The fix bucket-integrates PV and load
    // separately, then takes min() per bucket. Here PV rows are offset by 5 min
    // from load rows — under the old exact-ts join pvDirect would be all-zeros;
    // under the bucket-join it is min(pvBucketKwh, loadBucketKwh).
    const querySeries = async ({ seriesKeys, start, end }) => {
      const all = [];
      for (const key of seriesKeys) {
        if (key === 'pv_total_w') {
          // PV 2000W, samples on the 5-min grid (offset 0).
          all.push(...makeFlatSeriesRows({ start, end, key, watts: 2000, stepSec: 300 }));
        } else if (key === 'load_power_w') {
          // load 1200W, samples offset by 150 s so they never share a ts with PV.
          const rows = makeFlatSeriesRows({ start, end, key, watts: 1200, stepSec: 300 });
          all.push(...rows.map((r) => ({ ...r, ts: new Date(Date.parse(r.ts) + 150_000).toISOString() })));
        }
      }
      return all;
    };
    const ctx = mockCtxWithStores({ querySeriesFn: querySeries });
    const r = await ctx.historyVizApi.getStack({ view: 'day', date: ANCHOR_DATE });
    assert.equal(r.status, 200);
    const b = r.body;
    assert.equal(b.pvDirectKwh.length, 24);
    const totalPvDirect = b.pvDirectKwh.reduce((s, x) => s + x, 0);
    assert.ok(totalPvDirect > 0, `RC-E: pvDirectKwh should be non-zero, got total ${totalPvDirect}`);
    // PV-direct per bucket = min(pv, load). PV (2000W) > load (1200W) every
    // bucket → pvDirect tracks loadKwh. Check the per-bucket identity holds.
    for (let i = 0; i < 24; i++) {
      assert.ok(
        Math.abs(b.pvDirectKwh[i] - Math.min(b.pvDirectKwh[i], b.loadKwh[i])) < 1e-9,
        `pvDirectKwh[${i}] (${b.pvDirectKwh[i]}) must be <= loadKwh[${i}] (${b.loadKwh[i]})`
      );
      assert.ok(b.pvDirectKwh[i] <= b.loadKwh[i] + 1e-9, `pvDirectKwh[${i}] should not exceed loadKwh[${i}]`);
    }
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
    // RC-2 — matrix cell coords MUST be the exact label strings the Chart.js
    // type:'category' scale matches by `===`. x = date string, y = hour string.
    for (const c of b.matrix.slice(0, 3)) {
      assert.equal(typeof c.x, 'string');
      assert.equal(typeof c.y, 'string');
      assert.ok(b.xLabels.includes(c.x), `cell.x '${c.x}' should be a member of xLabels`);
      assert.ok(b.yLabels.includes(c.y), `cell.y '${c.y}' should be a member of yLabels`);
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

  it('Test W2-6b (Heatmap granularity param): 1h default = 24 y-rows; 15min = 96 y-rows; cache keys do not collide', async () => {
    // makeFlatSeriesRows emits 15-min samples → both 1h and 15min granularity
    // have data. PV 2000W flat for a week.
    const querySeries = async ({ seriesKeys, start, end }) => {
      const all = [];
      for (const key of seriesKeys) {
        if (key !== 'pv_total_w') continue;
        all.push(...makeFlatSeriesRows({ start, end, key, watts: 2000 }));
      }
      return all;
    };
    const ctx = mockCtxWithStores({ querySeriesFn: querySeries });

    // Default (no param) → 1h granularity, 24 hourly rows.
    const def = await ctx.historyVizApi.getHeatmap({ view: 'week', date: ANCHOR_DATE });
    assert.equal(def.status, 200);
    assert.equal(def.body.granularity, '1h', 'default granularity should be 1h');
    assert.equal(def.body.yLabels.length, 24, `1h heatmap → 24 y-rows, got ${def.body.yLabels.length}`);
    assert.equal(def.body.matrix.length, def.body.xLabels.length * 24);

    // Explicit 15min → 96 fifteen-minute rows.
    const fine = await ctx.historyVizApi.getHeatmap({ view: 'week', date: ANCHOR_DATE, granularity: '15min' });
    assert.equal(fine.status, 200);
    assert.equal(fine.body.granularity, '15min', 'explicit 15min granularity should round-trip');
    assert.equal(fine.body.yLabels.length, 96, `15min heatmap → 96 y-rows, got ${fine.body.yLabels.length}`);
    assert.equal(fine.body.matrix.length, fine.body.xLabels.length * 96);
    // y-labels are HH:MM strings; cells match them by ===.
    assert.match(fine.body.yLabels[0], /^00:00$/);
    assert.match(fine.body.yLabels[95], /^23:45$/);
    for (const c of fine.body.matrix.slice(0, 3)) {
      assert.ok(fine.body.yLabels.includes(c.y), `cell.y '${c.y}' should be a member of yLabels`);
    }

    // Cache isolation — the 15min call must NOT serve the 1h cached payload.
    assert.equal(fine.cached, false, '15min granularity is a distinct cache key — must not be a 1h hit');
    const fine2 = await ctx.historyVizApi.getHeatmap({ view: 'week', date: ANCHOR_DATE, granularity: '15min' });
    assert.equal(fine2.cached, true, '2nd 15min call should hit cache');
    assert.equal(fine2.body.yLabels.length, 96, 'cached 15min payload keeps 96 rows');
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
// (for ring). Plan 09.4-A — spot price comes from public.timeseries_samples
// (series_key='price_ct_kwh', columns ts_utc + value_num). The earlier
// shared.market_price_slots source was never populated on prod (0 rows).
// =============================================================================

describe('Plan 09.3-03 Wave 3 — AutarkyCalendar/Ring/Duration builders', () => {
  // -------------------------------------------------------------------------
  // AutarkyCalendar (W3-1 envelope shape, W3-2 values bounded)
  // -------------------------------------------------------------------------
  it('Test W3-1 (Autarky calendar shape): month view → mode:calendar, xLabels span the range, periodTotal donut', async () => {
    // Flat 800W load, 300W grid_import for a 30-day month window. With the
    // round-2 per-bucket decomposition, grid covers load directly (no PV/
    // battery rows) → autarky 0%, periodTotal.shares.grid == total load.
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
    assert.equal(b.mode, 'calendar', 'month view should be mode:calendar');
    assert.ok(Array.isArray(b.xLabels), 'xLabels should be an array');
    // 30-day rolling window → 28..31 dates with data
    assert.ok(b.xLabels.length >= 28 && b.xLabels.length <= 31, `xLabels length 28-31 expected, got ${b.xLabels.length}`);
    assert.ok(Array.isArray(b.yLabels) && b.yLabels.length === 7, `yLabels should be 7 day-of-week labels, got ${b.yLabels?.length}`);
    assert.ok(Array.isArray(b.matrix), 'matrix should be an array');
    // One cell per actual date (each day maps to exactly one dow row).
    assert.equal(b.matrix.length, b.xLabels.length, `matrix.length (${b.matrix.length}) should equal xLabels.length (${b.xLabels.length})`);
    assert.ok(b.domain && b.domain.min === 0 && b.domain.max === 100, 'domain should be {min:0,max:100}');
    // periodTotal — overall-autarky summary alongside the calendar.
    assert.ok(b.periodTotal, 'month view should add a periodTotal summary');
    assert.equal(typeof b.periodTotal.autarkyPct, 'number');
    assert.ok(b.periodTotal.shares
      && typeof b.periodTotal.shares.pvDirect === 'number'
      && typeof b.periodTotal.shares.battery === 'number'
      && typeof b.periodTotal.shares.grid === 'number',
    'periodTotal.shares should carry pvDirect/battery/grid');
    // No PV/battery → autarky 0, grid carries the whole household load.
    assert.equal(b.periodTotal.autarkyPct, 0, 'grid-only month should be 0% autarky');
    assert.ok(b.periodTotal.shares.grid > 0, 'periodTotal.shares.grid should be the whole load');
  });

  it('Test W3-1b (Autarky day view → donut): mode:donut, autarkyPct + shares, agrees with Sankey decomposition', async () => {
    // pv 2000W, load 1500W, charge 300W, discharge 400W, export 200W, import 100W.
    // Per bucket: pvToLoad=min(2000,1500)=1500, batteryToLoad=min(400,0)=0,
    // gridToLoad=0 → autarky 100% (load fully covered by PV directly).
    const querySeries = async ({ seriesKeys, start, end }) => {
      const map = {
        pv_total_w: 2000, load_power_w: 1500, battery_charge_w: 300,
        battery_discharge_w: 400, grid_export_w: 200, grid_import_w: 100,
      };
      const all = [];
      for (const key of seriesKeys) all.push(...makeFlatSeriesRows({ start, end, key, watts: map[key] || 0 }));
      return all;
    };
    const ctx = mockCtxWithStores({ querySeriesFn: querySeries });
    const r = await ctx.historyVizApi.getAutarkyCalendar({ view: 'day', date: ANCHOR_DATE });
    assert.equal(r.status, 200, `expected 200, got ${r.status} (body=${JSON.stringify(r.body).slice(0, 200)})`);
    const b = r.body;
    assert.equal(b.card, 'autarky-calendar');
    assert.equal(b.mode, 'donut', 'day view should be mode:donut');
    assert.equal(typeof b.autarkyPct, 'number', 'donut payload should carry autarkyPct');
    assert.ok(b.shares
      && typeof b.shares.pvDirect === 'number'
      && typeof b.shares.battery === 'number'
      && typeof b.shares.grid === 'number',
    'donut payload should carry shares.{pvDirect,battery,grid}');
    assert.equal(b.autarkyPct, 100, 'PV fully covers load → 100% autarky');
    assert.ok(b.shares.grid < 0.05, 'no grid-to-load when PV covers the whole load');
    // Day-Autarky must agree with day-Sankey (same per-bucket decomposition).
    const sankey = await ctx.historyVizApi.getSankey({ view: 'day', date: ANCHOR_DATE });
    const pvToLoad = sankey.body.flows.find(f => f.from === 'PV' && f.to === 'Eigenverbrauch');
    assert.ok(
      Math.abs(b.shares.pvDirect - (pvToLoad ? pvToLoad.flow : 0)) <= 0.05,
      'autarky day shares.pvDirect must equal the Sankey PV→Eigenverbrauch flow'
    );
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
    // RC-2 — cell.y is the German DOW label string (member of yLabels), not a
    // numeric index, so the Chart.js type:'category' scale can match it.
    for (const cell of r.body.matrix) {
      assert.ok(cell.v >= 0 && cell.v <= 100, `cell v out of range: ${cell.v}`);
      assert.ok(typeof cell.x === 'string', 'cell.x should be a date string');
      assert.ok(typeof cell.y === 'string', `cell.y should be a DOW label string, got ${typeof cell.y}`);
      assert.ok(r.body.yLabels.includes(cell.y), `cell.y '${cell.y}' should be a member of yLabels`);
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
      assert.match(sql, /timeseries_samples/i, 'getDuration SQL should query timeseries_samples (Plan 09.4-A)');
      assert.match(sql, /price_ct_kwh/i, "getDuration SQL should select the 'price_ct_kwh' series");
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

// =============================================================================
// Plan 09.3-04 Wave 4 — Preis-Heatmap (dow×hour) / SOC-Spaghetti / Zyklen-
// Histogramm. CONTEXT D-04 Gruppe B Tier-2 + D-05 cycle-counter.
//
//   - pheat:     7 dow × 24 hour avg-spot-price matrix from
//                public.timeseries_samples (4-stop interpolated color scale).
//   - spaghetti: up to 30 day-line datasets of 24h hourly SOC, "Heute"
//                highlighted; single querySeries call (RESEARCH §Pitfall 5).
//   - cycles:    7-dow bars (geladen/entladen kWh stacked) + cycles line; the
//                cycle-counter uses cumulative |ΔSOC|/200 (RESEARCH §Cycle-
//                Counter Algorithm), equivalent to the existing kpis.cycles
//                discharge-energy/capacity formula in history-runtime.js.
//
// Plan 09.4-A — Pheat's spot price comes from public.timeseries_samples
// (series_key='price_ct_kwh', columns ts_utc + value_num). The earlier
// shared.market_price_slots source was never populated on prod (0 rows).
// =============================================================================

// Build battery_soc_pct querySeries rows from a flat list of SOC percentages,
// evenly spaced from `start` across `stepSec`. Used by the cycle-counter +
// spaghetti tests so the builder runs against deterministic SOC series.
function makeSocRows({ start, values, stepSec = SLOT_RES_SEC }) {
  const rows = [];
  const startMs = Date.parse(start);
  for (let i = 0; i < values.length; i++) {
    rows.push({
      key: 'battery_soc_pct',
      ts: new Date(startMs + i * stepSec * 1000).toISOString(),
      value: values[i],
      unit: '%',
      resolution: stepSec,
    });
  }
  return rows;
}

describe('Plan 09.3-04 Wave 4 — Pheat/Spaghetti/Cycles builders', () => {
  // -------------------------------------------------------------------------
  // Pheat (W4-1 — 7×24 matrix shape)
  // -------------------------------------------------------------------------
  it('Test W4-1 (Pheat shape): month view → 168-cell matrix, every v ≥ 0, domain.unit ct/kWh', async () => {
    // db.query returns dow×hour rows; build a deterministic full grid.
    const dbQuery = async (sql, params) => {
      assert.ok(Array.isArray(params) && params.length >= 1, 'getPheat MUST use parameterized SQL');
      assert.match(sql, /timeseries_samples/i, 'getPheat SQL should query timeseries_samples (Plan 09.4-A)');
      assert.match(sql, /price_ct_kwh/i, "getPheat SQL should select the 'price_ct_kwh' series");
      const rows = [];
      for (let dow = 0; dow < 7; dow++) {
        for (let hr = 0; hr < 24; hr++) {
          rows.push({ dow, hr, avg_ct: 5 + hr * 0.5 });
        }
      }
      return { rows };
    };
    const ctx = mockCtxWithStores({ dbQueryFn: dbQuery });
    const r = await ctx.historyVizApi.getPheat({ view: 'month', date: ANCHOR_DATE });
    assert.equal(r.status, 200, `expected 200, got ${r.status} (body=${JSON.stringify(r.body).slice(0, 200)})`);
    const b = r.body;
    assert.equal(b.card, 'pheat');
    assert.ok(Array.isArray(b.xLabels) && b.xLabels.length === 24, `xLabels=24 expected, got ${b.xLabels?.length}`);
    assert.ok(Array.isArray(b.yLabels) && b.yLabels.length === 7, `yLabels=7 expected, got ${b.yLabels?.length}`);
    assert.ok(Array.isArray(b.matrix) && b.matrix.length === 168, `matrix.length=168 expected, got ${b.matrix?.length}`);
    // RC-2 — pheat is a matrix card: both cell.x (hour label) and cell.y (DOW
    // label) MUST be the exact label strings the type:'category' scale matches.
    for (const c of b.matrix) {
      assert.equal(typeof c.x, 'string', 'cell.x should be an hour label string');
      assert.equal(typeof c.y, 'string', 'cell.y should be a DOW label string');
      assert.ok(b.xLabels.includes(c.x), `cell.x '${c.x}' should be a member of xLabels`);
      assert.ok(b.yLabels.includes(c.y), `cell.y '${c.y}' should be a member of yLabels`);
      assert.ok(c.v >= 0, `cell.v should be >= 0, got ${c.v}`);
    }
    assert.ok(b.domain && b.domain.unit === 'ct/kWh', `domain.unit should be 'ct/kWh', got ${b.domain?.unit}`);
  });

  // -------------------------------------------------------------------------
  // Spaghetti (W4-2 shape + isToday, W4-3 payload size, W4-4 view rejection)
  // -------------------------------------------------------------------------
  it('Test W4-2 (Spaghetti shape + isToday): ≤30 series, exactly one isToday matching todayDate, 24 points each', async () => {
    // 30 days of SOC samples (1 per hour) ending at ANCHOR_DATE.
    const querySeries = async ({ seriesKeys, start }) => {
      assert.ok(seriesKeys.includes('battery_soc_pct'), 'getSpaghetti should query battery_soc_pct');
      const startMs = Date.parse(start);
      const rows = [];
      // hourly samples for 30 days
      for (let h = 0; h < 30 * 24; h++) {
        rows.push({
          key: 'battery_soc_pct',
          ts: new Date(startMs + h * 3600 * 1000).toISOString(),
          value: 40 + (h % 24) * 2,
          unit: '%',
          resolution: 900,
        });
      }
      return rows;
    };
    const ctx = mockCtxWithStores({ querySeriesFn: querySeries });
    const r = await ctx.historyVizApi.getSpaghetti({ view: 'month', date: ANCHOR_DATE });
    assert.equal(r.status, 200, `expected 200, got ${r.status} (body=${JSON.stringify(r.body).slice(0, 200)})`);
    const b = r.body;
    assert.equal(b.card, 'spaghetti');
    assert.ok(Array.isArray(b.series), 'series should be an array');
    assert.ok(b.series.length <= 30, `series.length should be <= 30, got ${b.series.length}`);
    const todayEntries = b.series.filter((s) => s.isToday === true);
    assert.equal(todayEntries.length, 1, `exactly one isToday entry expected, got ${todayEntries.length}`);
    assert.equal(todayEntries[0].date, b.todayDate, 'isToday entry date should equal todayDate');
    for (const s of b.series) {
      assert.ok(Array.isArray(s.points) && s.points.length === 24, `every series should have 24 points, ${s.date} has ${s.points?.length}`);
    }
  });

  it('Test W4-3 (Spaghetti payload size): JSON ≤ 50_000 bytes', async () => {
    const querySeries = async ({ seriesKeys, start }) => {
      const startMs = Date.parse(start);
      const rows = [];
      for (let h = 0; h < 30 * 24; h++) {
        rows.push({
          key: 'battery_soc_pct',
          ts: new Date(startMs + h * 3600 * 1000).toISOString(),
          value: 55.5 + (h % 24),
          unit: '%',
          resolution: 900,
        });
      }
      return rows;
    };
    const ctx = mockCtxWithStores({ querySeriesFn: querySeries });
    const r = await ctx.historyVizApi.getSpaghetti({ view: 'year', date: ANCHOR_DATE });
    assert.equal(r.status, 200);
    const bytes = Buffer.byteLength(JSON.stringify(r.body), 'utf8');
    assert.ok(bytes <= 50_000, `spaghetti payload should be <= 50KB, got ${bytes} bytes`);
  });

  it('Test W4-3b (Spaghetti year → ISO-week lines): year view aggregates SOC to ~52 weekly lines labelled "KW NN"', async () => {
    // A full year of hourly SOC samples → year view must collapse to ISO
    // calendar weeks (~52 lines), NOT one line per day (~365).
    const querySeries = async ({ seriesKeys, start, end }) => {
      const startMs = Date.parse(start);
      const endMs = Date.parse(end);
      const rows = [];
      let i = 0;
      for (let t = startMs; t < endMs; t += 3600 * 1000) {
        rows.push({
          key: 'battery_soc_pct',
          ts: new Date(t).toISOString(),
          value: 40 + ((i++) % 24) * 2,
          unit: '%',
          resolution: 3600,
        });
      }
      return rows;
    };
    const ctx = mockCtxWithStores({ querySeriesFn: querySeries });
    const r = await ctx.historyVizApi.getSpaghetti({ view: 'year', date: ANCHOR_DATE });
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
    const b = r.body;
    assert.ok(Array.isArray(b.series), 'series should be an array');
    // A 12-month window spans 52-54 ISO weeks.
    assert.ok(b.series.length >= 50 && b.series.length <= 54,
      `year view should produce ~52 weekly lines, got ${b.series.length}`);
    for (const s of b.series) {
      assert.match(s.label || '', /^KW \d+$/, `year-view line label should be "KW NN", got ${s.label}`);
      assert.ok(Array.isArray(s.points) && s.points.length === 24, `weekly line should still have 24 points, got ${s.points?.length}`);
    }
  });

  it('Test W4-3c (Spaghetti week unchanged): week view still emits one line per day', async () => {
    const querySeries = async ({ seriesKeys, start, end }) => {
      const startMs = Date.parse(start);
      const endMs = Date.parse(end);
      const rows = [];
      for (let t = startMs; t < endMs; t += 3600 * 1000) {
        rows.push({
          key: 'battery_soc_pct', ts: new Date(t).toISOString(),
          value: 50, unit: '%', resolution: 3600,
        });
      }
      return rows;
    };
    const ctx = mockCtxWithStores({ querySeriesFn: querySeries });
    const r = await ctx.historyVizApi.getSpaghetti({ view: 'week', date: ANCHOR_DATE });
    assert.equal(r.status, 200);
    // 7-day window → 7 per-day lines, each keyed by a YYYY-MM-DD date string.
    assert.equal(r.body.series.length, 7, `week view should emit 7 day-lines, got ${r.body.series.length}`);
    for (const s of r.body.series) {
      assert.match(s.date || '', /^\d{4}-\d{2}-\d{2}$/, `week-view line should key by date, got ${s.date}`);
    }
  });

  it('Test W4-4 (Spaghetti view rejection): view=day → 400 with error', async () => {
    const ctx = mockCtxWithStores();
    const r = await ctx.historyVizApi.getSpaghetti({ view: 'day', date: ANCHOR_DATE });
    assert.equal(r.status, 400, `expected 400 for view='day', got ${r.status}`);
    assert.match(r.body.error || '', /view/i);
  });

  // -------------------------------------------------------------------------
  // Cycles (W4-5 view rejection, W4-6 formula sanity, W4-7 dow distribution)
  // -------------------------------------------------------------------------
  it('Test W4-5 (Cycles view rejection): view=day → 400', async () => {
    const ctx = mockCtxWithStores();
    const r = await ctx.historyVizApi.getCycles({ view: 'day', date: ANCHOR_DATE });
    assert.equal(r.status, 400, `expected 400 for view='day', got ${r.status}`);
    assert.match(r.body.error || '', /view/i);
  });

  it('Test W4-6 (Cycles formula sanity): SOC [0,100,0,100,0] → cumulative cycles 2.0', async () => {
    // 4 transitions of 100% absolute change = 400 cumulative → 400/200 = 2.0.
    // All 5 samples land on the SAME day so the per-DOW sum collapses to one DOW.
    const querySeries = async ({ seriesKeys, start }) => {
      assert.ok(seriesKeys.includes('battery_soc_pct'), 'getCycles should query battery_soc_pct');
      // 5 samples 1h apart, all within the same UTC day (start..start+4h).
      return makeSocRows({ start, values: [0, 100, 0, 100, 0], stepSec: 3600 });
    };
    const ctx = mockCtxWithStores({ querySeriesFn: querySeries });
    const r = await ctx.historyVizApi.getCycles({ view: 'week', date: ANCHOR_DATE });
    assert.equal(r.status, 200, `expected 200, got ${r.status} (body=${JSON.stringify(r.body).slice(0, 200)})`);
    const b = r.body;
    assert.equal(b.card, 'cycles');
    assert.ok(Array.isArray(b.perDow) && b.perDow.length === 7, `perDow should be 7 entries, got ${b.perDow?.length}`);
    const totalCycles = b.perDow.reduce((s, d) => s + d.cycles, 0);
    assert.ok(Math.abs(totalCycles - 2.0) < 0.001, `cumulative cycles should be 2.0, got ${totalCycles}`);
    assert.ok(b.totals && Math.abs(b.totals.cycles - 2.0) < 0.001, `totals.cycles should be 2.0, got ${b.totals?.cycles}`);
  });

  it('Test W4-7 (Cycles dow distribution): cycles only on Wednesday → perDow[2] > 0, perDow[0] === 0', async () => {
    // ANCHOR_DATE 2026-05-14 is a Thursday; the rolling-week window starting
    // 6 days earlier covers Fri 05-08 .. Thu 05-14. 2026-05-13 is a Wednesday.
    // Put SOC swings ONLY on 2026-05-13; all other days get a flat SOC.
    const querySeries = async ({ seriesKeys, start, end }) => {
      const rows = [];
      const startMs = Date.parse(start);
      const endMs = Date.parse(end);
      for (let t = startMs; t < endMs; t += 3600 * 1000) {
        const d = new Date(t);
        const dateKey = d.toISOString().slice(0, 10);
        // Wednesday 2026-05-13 → alternating 0/100; everything else flat 50.
        const isWed = dateKey === '2026-05-13';
        const hr = d.getUTCHours();
        rows.push({
          key: 'battery_soc_pct',
          ts: d.toISOString(),
          value: isWed ? (hr % 2 === 0 ? 0 : 100) : 50,
          unit: '%',
          resolution: 3600,
        });
      }
      return rows;
    };
    const ctx = mockCtxWithStores({ querySeriesFn: querySeries });
    const r = await ctx.historyVizApi.getCycles({ view: 'week', date: ANCHOR_DATE });
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
    const perDow = r.body.perDow;
    // Mo=0..So=6 → Mittwoch index = 2.
    assert.ok(perDow[2].cycles > 0, `Mittwoch (perDow[2]) cycles should be > 0, got ${perDow[2].cycles}`);
    assert.equal(perDow[0].cycles, 0, `Montag (perDow[0]) cycles should be 0, got ${perDow[0].cycles}`);
  });

  // -------------------------------------------------------------------------
  // Cache (W4-8 — each Wave-4 card serves cached on 2nd call)
  // -------------------------------------------------------------------------
  it('Test W4-8 (cache hit): pheat/spaghetti/cycles each serve cached on the 2nd call', async () => {
    let pheatCalls = 0;
    let socCalls = 0;
    const dbQuery = async () => {
      pheatCalls++;
      const rows = [];
      for (let dow = 0; dow < 7; dow++) for (let hr = 0; hr < 24; hr++) rows.push({ dow, hr, avg_ct: 10 });
      return { rows };
    };
    const querySeries = async ({ start }) => {
      socCalls++;
      return makeSocRows({ start, values: [10, 50, 90, 50, 10], stepSec: 3600 });
    };
    const ctx = mockCtxWithStores({ querySeriesFn: querySeries, dbQueryFn: dbQuery });

    const p1 = await ctx.historyVizApi.getPheat({ view: 'month', date: ANCHOR_DATE });
    const p2 = await ctx.historyVizApi.getPheat({ view: 'month', date: ANCHOR_DATE });
    assert.equal(p1.cached, false, 'first pheat call cached:false');
    assert.equal(p2.cached, true, 'second pheat call cached:true');
    assert.equal(p2.body.cached, true, 'second pheat body.cached:true');
    assert.equal(pheatCalls, 1, `pheat db.query should run once for two cached calls; ran ${pheatCalls}`);

    const s1 = await ctx.historyVizApi.getSpaghetti({ view: 'week', date: ANCHOR_DATE });
    const s2 = await ctx.historyVizApi.getSpaghetti({ view: 'week', date: ANCHOR_DATE });
    assert.equal(s1.cached, false, 'first spaghetti call cached:false');
    assert.equal(s2.cached, true, 'second spaghetti call cached:true');

    const c1 = await ctx.historyVizApi.getCycles({ view: 'week', date: ANCHOR_DATE });
    const c2 = await ctx.historyVizApi.getCycles({ view: 'week', date: ANCHOR_DATE });
    assert.equal(c1.cached, false, 'first cycles call cached:false');
    assert.equal(c2.cached, true, 'second cycles call cached:true');
    assert.equal(c2.body.cached, true, 'second cycles body.cached:true');
  });
});

// =============================================================================
// Plan 09.4 — Negativpreis-Heatmap (slug: neg-price). A dedicated matrix card
// visualising WHEN the EPEX spot price was negative. month|year only.
//
//   month: x = day-of-month "01".."31", y = hour "00".."23", v = MEAN price.
//   year:  x = month "Jan".."Dez",      y = day "1".."31",   v = MIN price.
//
// The builder reads `timeseries_samples` (series_key='price_ct_kwh') via the
// established price path; the raw SIGNED price (negatives included, never
// clamped) is emitted as cell `v`. domain exposes the true signed min/max.
// RC-2 — matrix cell x/y are the exact category label STRINGS.
// =============================================================================
describe('Plan 09.4 — Negativpreis-Heatmap (neg-price) builder', () => {
  it('Test 09.4-1 (month shape): 31×24 matrix, RC-2 string coords, domain.unit ct/kWh', async () => {
    const dbQuery = async (sql, params) => {
      assert.ok(Array.isArray(params) && params.length >= 1, 'getNegPrice MUST use parameterized SQL');
      assert.match(sql, /timeseries_samples/i, 'SQL should query timeseries_samples');
      assert.match(sql, /price_ct_kwh/i, "SQL should select the 'price_ct_kwh' series");
      assert.match(sql, /AVG\(/i, 'month view should aggregate via AVG (per-bucket mean)');
      const rows = [];
      for (let dom = 1; dom <= 31; dom++) {
        for (let hr = 0; hr < 24; hr++) rows.push({ dom, hr, agg_ct: 6.5 });
      }
      return { rows };
    };
    const ctx = mockCtxWithStores({ dbQueryFn: dbQuery });
    const r = await ctx.historyVizApi.getNegPrice({ view: 'month', date: ANCHOR_DATE });
    assert.equal(r.status, 200, `expected 200, got ${r.status} (body=${JSON.stringify(r.body).slice(0, 200)})`);
    const b = r.body;
    assert.equal(b.card, 'neg-price');
    assert.equal(b.view, 'month');
    assert.equal(b.date, ANCHOR_DATE);
    assert.ok(typeof b.generatedAt === 'string', 'generatedAt should be a string');
    assert.equal(b.cached, false, 'first call cached:false');
    assert.ok(Array.isArray(b.xLabels) && b.xLabels.length === 31, `xLabels=31 expected, got ${b.xLabels?.length}`);
    assert.ok(Array.isArray(b.yLabels) && b.yLabels.length === 24, `yLabels=24 expected, got ${b.yLabels?.length}`);
    assert.ok(Array.isArray(b.matrix) && b.matrix.length === 31 * 24, `matrix.length=744 expected, got ${b.matrix?.length}`);
    for (const c of b.matrix) {
      assert.equal(typeof c.x, 'string', 'cell.x should be a label string (RC-2)');
      assert.equal(typeof c.y, 'string', 'cell.y should be a label string (RC-2)');
      assert.ok(b.xLabels.includes(c.x), `cell.x '${c.x}' should be a member of xLabels`);
      assert.ok(b.yLabels.includes(c.y), `cell.y '${c.y}' should be a member of yLabels`);
    }
    assert.ok(b.domain && b.domain.unit === 'ct/kWh', `domain.unit should be 'ct/kWh', got ${b.domain?.unit}`);
  });

  it('Test 09.4-2 (negative prices preserved, not clamped): a −4.2 ct cell stays −4.2', async () => {
    // One day-hour deeply negative; everything else positive.
    const dbQuery = async () => {
      const rows = [];
      for (let dom = 1; dom <= 31; dom++) {
        for (let hr = 0; hr < 24; hr++) {
          rows.push({ dom, hr, agg_ct: (dom === 12 && hr === 13) ? -4.2 : 8.0 });
        }
      }
      return { rows };
    };
    const ctx = mockCtxWithStores({ dbQueryFn: dbQuery });
    const r = await ctx.historyVizApi.getNegPrice({ view: 'month', date: ANCHOR_DATE });
    assert.equal(r.status, 200);
    const b = r.body;
    // day-of-month 12 → xLabels[11]="12"; hour 13 → yLabels[13]="13".
    const cell = b.matrix.find((c) => c.x === '12' && c.y === '13');
    assert.ok(cell, 'expected a cell for day 12 hour 13');
    assert.ok(Math.abs(cell.v - (-4.2)) < 0.001, `negative price MUST NOT be clamped — got ${cell.v}`);
    assert.ok(b.domain.min < 0, `domain.min should be negative, got ${b.domain.min}`);
    assert.ok(Math.abs(b.domain.min - (-4.2)) < 0.001, `domain.min should be the deepest negative −4.2, got ${b.domain.min}`);
    assert.ok(b.domain.max > 0, `domain.max should be positive, got ${b.domain.max}`);
  });

  it('Test 09.4-3 (year shape): 12×31 matrix, month×day, MIN aggregate', async () => {
    const dbQuery = async (sql) => {
      assert.match(sql, /MIN\(/i, 'year view should aggregate via MIN (deeply-negative days stand out)');
      // ANCHOR_DATE 2026-05-14 → 12-month window 2025-06 .. 2026-05.
      // Provide one negative-min day in the anchor month.
      return { rows: [
        { yr: 2026, mon: 5, dom: 14, agg_ct: -7.5 },
        { yr: 2026, mon: 5, dom: 1, agg_ct: 3.0 },
        { yr: 2025, mon: 6, dom: 30, agg_ct: 2.0 },
      ] };
    };
    const ctx = mockCtxWithStores({ dbQueryFn: dbQuery });
    const r = await ctx.historyVizApi.getNegPrice({ view: 'year', date: ANCHOR_DATE });
    assert.equal(r.status, 200, `expected 200, got ${r.status} (body=${JSON.stringify(r.body).slice(0, 200)})`);
    const b = r.body;
    assert.equal(b.card, 'neg-price');
    assert.ok(Array.isArray(b.xLabels) && b.xLabels.length === 12, `xLabels=12 months expected, got ${b.xLabels?.length}`);
    assert.ok(Array.isArray(b.yLabels) && b.yLabels.length === 31, `yLabels=31 days expected, got ${b.yLabels?.length}`);
    assert.ok(Array.isArray(b.matrix) && b.matrix.length === 12 * 31, `matrix.length=372 expected, got ${b.matrix?.length}`);
    for (const c of b.matrix) {
      assert.equal(typeof c.x, 'string', 'cell.x should be a month label string (RC-2)');
      assert.equal(typeof c.y, 'string', 'cell.y should be a day label string (RC-2)');
      assert.ok(b.xLabels.includes(c.x), `cell.x '${c.x}' should be a member of xLabels`);
      assert.ok(b.yLabels.includes(c.y), `cell.y '${c.y}' should be a member of yLabels`);
    }
    // The −7.5 day must surface as domain.min and be present in the matrix.
    assert.ok(Math.abs(b.domain.min - (-7.5)) < 0.001, `domain.min should be −7.5, got ${b.domain.min}`);
    const negCell = b.matrix.find((c) => c.v === -7.5);
    assert.ok(negCell, 'the −7.5 minimum-price day should appear as a matrix cell');
  });

  it('Test 09.4-4 (view rejection): day + week → 400 with error', async () => {
    const ctx = mockCtxWithStores();
    for (const view of ['day', 'week']) {
      const r = await ctx.historyVizApi.getNegPrice({ view, date: ANCHOR_DATE });
      assert.equal(r.status, 400, `expected 400 for view='${view}', got ${r.status}`);
      assert.match(r.body.error || '', /view/i);
    }
  });

  it('Test 09.4-5 (empty window): no priced samples → 200, flat 0 domain', async () => {
    const ctx = mockCtxWithStores({ dbQueryFn: async () => ({ rows: [] }) });
    const r = await ctx.historyVizApi.getNegPrice({ view: 'month', date: ANCHOR_DATE });
    assert.equal(r.status, 200, `empty window should still be 200, got ${r.status}`);
    assert.equal(r.body.domain.min, 0, 'empty-window domain.min should be 0 (no Infinity leak)');
    assert.equal(r.body.domain.max, 0, 'empty-window domain.max should be 0 (no -Infinity leak)');
  });

  it('Test 09.4-6 (cache hit): 2nd call serves cached', async () => {
    let calls = 0;
    const dbQuery = async () => {
      calls++;
      const rows = [];
      for (let dom = 1; dom <= 31; dom++) for (let hr = 0; hr < 24; hr++) rows.push({ dom, hr, agg_ct: -1.0 });
      return { rows };
    };
    const ctx = mockCtxWithStores({ dbQueryFn: dbQuery });
    const r1 = await ctx.historyVizApi.getNegPrice({ view: 'month', date: ANCHOR_DATE });
    const r2 = await ctx.historyVizApi.getNegPrice({ view: 'month', date: ANCHOR_DATE });
    assert.equal(r1.cached, false, 'first call cached:false');
    assert.equal(r2.cached, true, 'second call cached:true');
    assert.equal(r2.body.cached, true, 'second body.cached:true');
    assert.equal(calls, 1, `db.query should run once for two cached calls; ran ${calls}`);
  });
});

// =============================================================================
// Plan 09.3-05 Wave 5 — Top-10-Slots / Cal-Heatmap-12-Monat / Wetter×Erlös-
// Scatter. CONTEXT D-05 (Top10/CalYear) + D-06 (14th card = weather scatter).
//
//   - top10:    the 10 highest-revenue sell slots in the period, sorted DESC.
//   - cal-year: 12-month × 31-day matrix of signed daily net-€ (diverging
//               palette on the frontend — domain straddles 0).
//   - scatter:  per-day GHI vs net-€ point cloud, point colour = autarky %.
//
// SCHEMA REALITY (Plan 09.4-B): the Phase-08.1 `opt.plan_slots` table is 0
// rows on prod — nothing populates it, and there is NO `expected_profit_eur`
// column anywhere in the legacy schema. The Wave-5 dispatch builders are
// re-pointed at `public.energy_slots_15m` — an EAV table (slot_start_utc,
// series_key, source_kind, value_num) where value_num is the per-15-min ENERGY
// in kWh. The builders pivot the `grid_import_w` / `grid_export_w` series and
// join the EPEX price (`timeseries_samples` series_key='price_ct_kwh'). The
// per-slot net € is DERIVED — (export_kwh − import_kwh) × price_ct_kwh / 100 —
// since no stored profit column exists; daily net-€ = SUM of it. The aggregator
// SQL exposes a `slot_net` CTE with columns ts/import_kwh/export_kwh/
// price_ct_kwh/net_eur, so the test doubles below feed rows in that shape.
//
// Weather: `weather_forecasts` — ts_utc (TIMESTAMPTZ), ghi_wm2 (DOUBLE
// PRECISION, NULLABLE). The open_meteo_archive provider holds a full year of
// historical GHI. getScatter joins daily-mean GHI (ghi_wm2 IS NOT NULL) to
// daily net-€; days with no GHI row are omitted.
//
// Test 9 (SQL-throw path) uses a hand-rolled throwing stub for ctx.db.query
// (node:test has no mock library wired in this project — the existing Wave
// 2-4 tests all use plain async function doubles); the assertion wraps the
// builder call in try/catch and fails if any exception escapes.
// =============================================================================

// Plan 09.4-B — build slot_net-CTE-shaped rows for a given UTC day range. Each
// "slot" is a 15-min interval sourced from energy_slots_15m (realized flows in
// kWh) joined to the EPEX price; net_eur is the DERIVED per-slot cashflow
// (export−import)×price/100. Export-heavy slots (sell) carry a positive net.
function makeDispatchSlotRows({ start, end, exportKwh = 1.4, importKwh = 0, priceCt = 18.2, stepSec = SLOT_RES_SEC }) {
  const rows = [];
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  for (let t = startMs; t < endMs; t += stepSec * 1000) {
    rows.push({
      ts: new Date(t).toISOString(),
      import_kwh: importKwh,
      export_kwh: exportKwh,
      price_ct_kwh: priceCt,
      net_eur: ((exportKwh - importKwh) * priceCt) / 100,
    });
  }
  return rows;
}

describe('Plan 09.3-05 Wave 5 — Top10/CalYear/Scatter builders', () => {
  // -------------------------------------------------------------------------
  // Top10 (W5-1 sort + cap, W5-2 view rejection)
  // -------------------------------------------------------------------------
  it('Test W5-1 (Top10 sort + cap): slots.length ≤ 10, sorted DESC by revenueEur', async () => {
    // 20 slots with varied profit so the LIMIT 10 + DESC sort are exercised.
    const dbQuery = async (sql, params) => {
      assert.ok(Array.isArray(params) && params.length >= 1, 'getTop10 MUST use parameterized SQL');
      assert.match(sql, /energy_slots_15m/i, 'getTop10 SQL should query energy_slots_15m (Plan 09.4-B)');
      const rows = [];
      for (let i = 0; i < 20; i++) {
        rows.push({
          ts: new Date(`${ANCHOR_DATE}T${String(i % 24).padStart(2, '0')}:00:00Z`).toISOString(),
          import_kwh: 0,
          export_kwh: 1.0 + i * 0.05,
          price_ct_kwh: 20 + i,
          net_eur: (i * 0.07),  // ascending net
        });
      }
      return { rows };
    };
    const ctx = mockCtxWithStores({ dbQueryFn: dbQuery });
    const r = await ctx.historyVizApi.getTop10({ view: 'month', date: ANCHOR_DATE });
    assert.equal(r.status, 200, `expected 200, got ${r.status} (body=${JSON.stringify(r.body).slice(0, 200)})`);
    const b = r.body;
    assert.equal(b.card, 'top10');
    assert.ok(Array.isArray(b.slots), 'slots should be an array');
    assert.ok(b.slots.length <= 10, `slots.length should be <= 10, got ${b.slots.length}`);
    for (let i = 1; i < b.slots.length; i++) {
      assert.ok(
        b.slots[i - 1].revenueEur >= b.slots[i].revenueEur,
        `slots not DESC by revenueEur at index ${i}: ${b.slots[i - 1].revenueEur} < ${b.slots[i].revenueEur}`
      );
    }
    for (const s of b.slots) {
      assert.equal(typeof s.ts, 'string');
      assert.equal(typeof s.kwh, 'number');
      assert.equal(typeof s.priceCt, 'number');
      assert.equal(typeof s.revenueEur, 'number');
      assert.ok(['sell', 'buy', 'hold'].includes(s.action), `bad action: ${s.action}`);
    }
    assert.equal(typeof b.totalEur, 'number', 'totalEur should be a number');
  });

  it('Test W5-2 (Top10 view rejection): view=day → 400', async () => {
    const ctx = mockCtxWithStores();
    const r = await ctx.historyVizApi.getTop10({ view: 'day', date: ANCHOR_DATE });
    assert.equal(r.status, 400, `expected 400 for view='day', got ${r.status}`);
    assert.match(r.body.error || '', /view/i);
  });

  // -------------------------------------------------------------------------
  // CalYear (W5-3 signed-domain shape, W5-4 view rejection)
  // -------------------------------------------------------------------------
  it('Test W5-3 (CalYear shape): year view → matrix straddles 0, domain.min<0 && domain.max>0', async () => {
    // Mixed-sign daily net-€: half the days profit, half lose money.
    const dbQuery = async (sql, params) => {
      assert.ok(Array.isArray(params) && params.length >= 1, 'getCalYear MUST use parameterized SQL');
      // Aggregate-per-day style rows: {d: 'YYYY-MM-DD', net_eur: signed}.
      const rows = [];
      for (let m = 0; m < 12; m++) {
        for (let day = 1; day <= 5; day++) {
          // alternate sign per day so the diverging palette has a real midpoint
          const signed = ((m + day) % 2 === 0) ? (1.5 + m * 0.1) : -(2.0 + day * 0.1);
          rows.push({
            d: `2026-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
            net_eur: signed,
          });
        }
      }
      return { rows };
    };
    const ctx = mockCtxWithStores({ dbQueryFn: dbQuery });
    const r = await ctx.historyVizApi.getCalYear({ view: 'year', date: ANCHOR_DATE });
    assert.equal(r.status, 200, `expected 200, got ${r.status} (body=${JSON.stringify(r.body).slice(0, 200)})`);
    const b = r.body;
    assert.equal(b.card, 'cal-year');
    assert.ok(Array.isArray(b.xLabels) && b.xLabels.length === 12, `xLabels=12 expected, got ${b.xLabels?.length}`);
    assert.ok(Array.isArray(b.yLabels) && b.yLabels.length === 31, `yLabels=31 expected, got ${b.yLabels?.length}`);
    assert.ok(Array.isArray(b.matrix) && b.matrix.length > 0, 'matrix should be a non-empty array');
    // RC-2 — cell.x (month label) and cell.y (day-of-month label) MUST both be
    // the exact label strings the type:'category' scale matches by `===`.
    for (const c of b.matrix.slice(0, 5)) {
      assert.equal(typeof c.x, 'string', 'cell.x should be a month label');
      assert.equal(typeof c.y, 'string', 'cell.y should be a day-of-month label string');
      assert.ok(b.xLabels.includes(c.x), `cell.x '${c.x}' should be a member of xLabels`);
      assert.ok(b.yLabels.includes(c.y), `cell.y '${c.y}' should be a member of yLabels`);
      assert.equal(typeof c.v, 'number', 'cell.v should be signed net-€');
    }
    assert.ok(b.domain, 'domain object missing');
    assert.ok(b.domain.min < 0, `domain.min should be < 0 for signed data, got ${b.domain.min}`);
    assert.ok(b.domain.max > 0, `domain.max should be > 0 for signed data, got ${b.domain.max}`);
    assert.equal(b.domain.unit, '€', `domain.unit should be '€', got ${b.domain.unit}`);
  });

  it('Test W5-4 (CalYear view rejection): view=month → 400', async () => {
    const ctx = mockCtxWithStores();
    const r = await ctx.historyVizApi.getCalYear({ view: 'month', date: ANCHOR_DATE });
    assert.equal(r.status, 400, `expected 400 for view='month', got ${r.status}`);
    assert.match(r.body.error || '', /view/i);
  });

  // -------------------------------------------------------------------------
  // Scatter (W5-5 NULL-GHI handling, W5-6 empty fallback, W5-7 view rejection,
  // W5-9 SQL-throw path)
  // -------------------------------------------------------------------------
  it('Test W5-5 (Scatter NULL handling): days with NULL ghi excluded from points', async () => {
    // The builder JOINs daily-net-€ to daily-mean-GHI; the SQL filters
    // ghi_wm2 IS NOT NULL, so a day whose only GHI row is NULL has no GHI row
    // to join and is dropped. Simulate that by returning a join result that
    // already excludes the NULL-GHI day (mirrors the WHERE clause behaviour).
    const dbQuery = async (sql, params) => {
      assert.ok(Array.isArray(params) && params.length >= 1, 'getScatter MUST use parameterized SQL');
      // 3 days have GHI, 1 day (2026-04-18) had only NULL ghi → not in the join.
      return { rows: [
        { d: '2026-04-16', ghi: 4250, net_eur: 2.3, autarky_pct: 78 },
        { d: '2026-04-17', ghi: 3100, net_eur: 1.1, autarky_pct: 64 },
        { d: '2026-04-19', ghi: 5400, net_eur: 3.0, autarky_pct: 88 },
      ] };
    };
    const ctx = mockCtxWithStores({ dbQueryFn: dbQuery });
    const r = await ctx.historyVizApi.getScatter({ view: 'month', date: ANCHOR_DATE });
    assert.equal(r.status, 200, `expected 200, got ${r.status} (body=${JSON.stringify(r.body).slice(0, 200)})`);
    const b = r.body;
    assert.equal(b.card, 'scatter');
    assert.equal(b.weatherDataAvailable, true, 'weatherDataAvailable should be true with 3 GHI days');
    assert.ok(Array.isArray(b.points) && b.points.length === 3, `expected 3 points, got ${b.points?.length}`);
    assert.ok(!b.points.some((p) => p.date === '2026-04-18'), 'NULL-GHI day must be excluded');
    for (const p of b.points) {
      assert.equal(typeof p.date, 'string');
      assert.equal(typeof p.ghi, 'number');
      assert.ok(Number.isFinite(p.ghi), `ghi should be finite, got ${p.ghi}`);
      assert.equal(typeof p.netEur, 'number');
      assert.equal(typeof p.autarkyPct, 'number');
    }
    assert.ok(b.correlation && typeof b.correlation.r === 'number', 'correlation.r should be a number');
    assert.equal(b.correlation.n, 3, `correlation.n should be 3, got ${b.correlation?.n}`);
  });

  it('Test W5-6 (Scatter empty fallback): 0 weather rows → 200 with weatherDataAvailable:false', async () => {
    // No joined rows at all (no weather data backfilled yet — RESEARCH A2).
    const ctx = mockCtxWithStores({ dbQueryFn: async () => ({ rows: [] }) });
    const r = await ctx.historyVizApi.getScatter({ view: 'week', date: ANCHOR_DATE });
    assert.equal(r.status, 200, `0-rows path MUST be 200 (NOT 500), got ${r.status}`);
    const b = r.body;
    assert.equal(b.card, 'scatter');
    assert.equal(b.weatherDataAvailable, false, 'weatherDataAvailable should be false with 0 rows');
    assert.ok(Array.isArray(b.points) && b.points.length === 0, 'points should be an empty array');
    assert.ok(b.correlation && b.correlation.r === 0 && b.correlation.n === 0, 'correlation should be {r:0,n:0}');
  });

  it('Test W5-7 (Scatter view rejection): view=day → 400', async () => {
    const ctx = mockCtxWithStores();
    const r = await ctx.historyVizApi.getScatter({ view: 'day', date: ANCHOR_DATE });
    assert.equal(r.status, 400, `expected 400 for view='day', got ${r.status}`);
    assert.match(r.body.error || '', /view/i);
  });

  // -------------------------------------------------------------------------
  // Cache (W5-8 — each Wave-5 card serves cached on the 2nd call)
  // -------------------------------------------------------------------------
  it('Test W5-8 (cache hit): top10/cal-year/scatter each serve cached on the 2nd call', async () => {
    let top10Calls = 0;
    let calYearCalls = 0;
    let scatterCalls = 0;
    const dbQuery = async (sql) => {
      if (/LIMIT\s+10/i.test(sql)) {
        top10Calls++;
        return { rows: makeDispatchSlotRows({
          start: '2026-05-01T00:00:00Z', end: '2026-05-02T00:00:00Z',
        }) };
      }
      if (/ghi/i.test(sql)) {
        scatterCalls++;
        return { rows: [{ d: '2026-05-10', ghi: 4000, net_eur: 2.0, autarky_pct: 70 }] };
      }
      calYearCalls++;
      return { rows: [{ d: '2026-05-10', net_eur: 1.5 }] };
    };
    const ctx = mockCtxWithStores({ dbQueryFn: dbQuery });

    const t1 = await ctx.historyVizApi.getTop10({ view: 'month', date: ANCHOR_DATE });
    const t2 = await ctx.historyVizApi.getTop10({ view: 'month', date: ANCHOR_DATE });
    assert.equal(t1.cached, false, 'first top10 call cached:false');
    assert.equal(t2.cached, true, 'second top10 call cached:true');
    assert.equal(t2.body.cached, true, 'second top10 body.cached:true');
    assert.equal(top10Calls, 1, `top10 db.query should run once for two cached calls; ran ${top10Calls}`);

    const y1 = await ctx.historyVizApi.getCalYear({ view: 'year', date: ANCHOR_DATE });
    const y2 = await ctx.historyVizApi.getCalYear({ view: 'year', date: ANCHOR_DATE });
    assert.equal(y1.cached, false, 'first cal-year call cached:false');
    assert.equal(y2.cached, true, 'second cal-year call cached:true');
    assert.equal(calYearCalls, 1, `cal-year db.query should run once for two cached calls; ran ${calYearCalls}`);

    const s1 = await ctx.historyVizApi.getScatter({ view: 'month', date: ANCHOR_DATE });
    const s2 = await ctx.historyVizApi.getScatter({ view: 'month', date: ANCHOR_DATE });
    assert.equal(s1.cached, false, 'first scatter call cached:false');
    assert.equal(s2.cached, true, 'second scatter call cached:true');
    assert.equal(s2.body.cached, true, 'second scatter body.cached:true');
    assert.equal(scatterCalls, 1, `scatter db.query should run once for two cached calls; ran ${scatterCalls}`);
  });

  // -------------------------------------------------------------------------
  // Scatter SQL-throw path (W5-9 — structured 500 envelope, no uncaught)
  // -------------------------------------------------------------------------
  it('Test W5-9 (Scatter SQL-throw path): db.query throws → structured 500 envelope, no uncaught exception', async () => {
    // Simulate a missing-column failure (PG SQLSTATE 42703 — e.g. a column
    // rename drift). The builder MUST catch it, pushLog the underlying error,
    // and return a structured 500 envelope — never let the exception escape.
    const queryError = new Error('column "value_num" does not exist');
    queryError.code = '42703';
    const throwingDbQuery = async () => { throw queryError; };

    // Capture pushLog invocations to assert the error was logged.
    const ctx = mockCtx();
    const pushLogCalls = [];
    ctx.pushLog = (...args) => { pushLogCalls.push(args); };
    ctx.telemetryStore = { querySeries: async () => [] };
    ctx.db = { query: throwingDbQuery };
    ctx.historyVizApi = createHistoryVizAggregator(ctx);

    let result;
    try {
      result = await ctx.historyVizApi.getScatter({ view: 'month', date: ANCHOR_DATE });
    } catch (e) {
      assert.fail(`getScatter let an exception escape (must catch + return 500 envelope): ${e.message}`);
    }
    assert.equal(result.status, 500, `SQL-throw path should return status 500, got ${result.status}`);
    const b = result.body;
    assert.equal(b.ok, false, 'error envelope ok should be false');
    assert.equal(b.card, 'scatter', 'error envelope card should be scatter');
    assert.match(String(b.error || ''), /aggregator failed/i, `error envelope should say 'aggregator failed', got ${b.error}`);
    assert.equal(result.cached, false, 'error envelope must not be cached');
    // pushLog must have been invoked with the underlying error.
    assert.ok(pushLogCalls.length >= 1, 'pushLog should be invoked on the SQL-throw path');
    const logged = JSON.stringify(pushLogCalls);
    assert.match(logged, /scatter/i, 'pushLog payload should reference the scatter aggregator');
  });
});
