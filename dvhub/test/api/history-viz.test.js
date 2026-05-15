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
