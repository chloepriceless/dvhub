// test/api/history-raw.test.js
//
// Plan 09.2-05 Wave-0 (RED) — endpoint contract tests for the new
// GET /api/history/raw route.
//
// CONTEXT.md decisions verified by this file:
//   D-11: Response shape `{ ok, rows, next_cursor, total, query_ms }` with rows
//         as `[ts_iso, series_key, value, unit]` tuples ordered ts_utc DESC.
//   D-14: 60s in-memory LRU cache, cap 100 entries, FIFO eviction. Identical
//         params within TTL share payload (mock pool called once).
//   D-15 / T-09.2-AUTHZ: NOT in LAN_SAFE_ENDPOINTS — Bearer required from any
//         source. LAN-IP without Bearer → 401 (NOT 200). Tested using REMOTE_IP
//         (TEST-NET-3) so the LAN auth-bypass cannot mask a missing-auth bug,
//         AND with a private LAN-IP to assert that LAN-bypass still doesn't
//         apply (the endpoint is explicitly excluded from the allowlist).
//   D-16: ORDER BY ts_utc DESC + LIMIT n + time-range WHERE for TimescaleDB
//         chunk-pruning. Verified by SQL-string regex.
//   T-09.2-INJ: All values bound via $N placeholders. Mock pool captures
//         params arrays; injection-attempt strings land as ANY array elements,
//         never substring-injected into SQL.
//   T-09.2-DOS-MEM: Server-side cap at 10000 regardless of client value.
//         Mock pool inspects the actual SQL `LIMIT $N` param.
//   T-09.2-CURSOR-SKIP: Cursor pagination reconstructs all rows with no
//         duplicates and no skips. Two consecutive pages stitched together
//         match the seed set 1:1.
//
// Test mode: invokes the routes-api dispatch handler directly via mocked
// req/res (admin-health.test.js + integrations-health.test.js pattern).
// No live HTTP server, no real DB. The pool is a stub that records
// `pool.query(sql, params)` calls and synthesises rows from a seed array.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApiRoutes } from '../../routes-api.js';

const REMOTE_IP = '203.0.113.5';      // TEST-NET-3 — never resolves to LAN
const LAN_IP = '192.168.1.66';       // RFC 1918 — would bypass auth IF endpoint were LAN-safe
const API_TOKEN = 'plan-09-2-05-test-token-xxxxxxxxxxxxxxxx';

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

// Mock PG pool that records all queries and synthesises rows from a seed array.
// The seed is a list of `{ ts_utc: Date, series_key, value_num, unit }` objects
// ordered DESC by ts_utc. The mock honours the cursor (`AND s.ts_utc < $N`) and
// limit (`LIMIT $N`) by slicing the seed appropriately.
function makeMockPool(seed = []) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params: params ? [...params] : [] });
      // Only honour SELECTs against timeseries_samples — anything else returns empty.
      if (!/FROM\s+timeseries_samples/i.test(sql)) {
        return { rows: [] };
      }
      // Last param is always the LIMIT (per handler contract). Extract.
      const limitParam = Number(params[params.length - 1]);
      const limit = Number.isFinite(limitParam) ? limitParam : seed.length;
      // Find the cursor param by scanning for any timestamptz-cast WHERE on ts_utc.
      // Simpler heuristic: if the SQL contains a cursor clause, the LAST timestamp
      // in params (immediately before the LIMIT) is the cursor.
      let filtered = seed;
      const cursorMatch = sql.match(/AND\s+s\.ts_utc\s+<\s+\$(\d+)::timestamptz[^,]*?LIMIT/i);
      if (cursorMatch) {
        // Find the param at position cursorMatch[1] (1-indexed)
        const cursorIdx = Number(cursorMatch[1]) - 1;
        const cursorVal = params[cursorIdx];
        if (cursorVal) {
          const cursorMs = Date.parse(cursorVal);
          if (Number.isFinite(cursorMs)) {
            filtered = seed.filter((r) => {
              const tsMs = r.ts_utc instanceof Date ? r.ts_utc.getTime() : Date.parse(r.ts_utc);
              return tsMs < cursorMs;
            });
          }
        }
      }
      return { rows: filtered.slice(0, limit) };
    },
  };
}

function mockCtx({ pool = makeMockPool() } = {}) {
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
  return {
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
    healthTracker: {
      snapshot: () => ({}),
      recordSample: () => {},
      persistSnapshot: async () => {},
      loadSnapshot: async () => {},
      close: () => {},
    },
    telemetryStore: { pool },
    db: pool,
  };
}

async function dispatch(ctx, req, routes = null) {
  const r = routes || createApiRoutes(ctx);
  const res = mockRes();
  const url = new URL(req.url, `http://${req.headers.host}`);
  await r.handleRequest(req, res, url);
  return res._captured;
}

// Build a synthetic descending-time series of rows. ts0 is the newest
// timestamp; subsequent rows decrement by 60 seconds.
function buildSeed(count, { startIso = '2026-05-14T12:00:00.000Z', stepSec = 60 } = {}) {
  const startMs = Date.parse(startIso);
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      ts_utc: new Date(startMs - i * stepSec * 1000),
      series_key: `synth_${i % 3}`,
      value_num: i * 1.5,
      unit: i % 2 === 0 ? 'W' : '%',
    });
  }
  return rows;
}

describe('GET /api/history/raw', () => {
  it('LAN non-authenticated request returns 401 — D-15 enforcement', async () => {
    // NOT in LAN_SAFE_ENDPOINTS — even from a private LAN address, missing
    // Bearer token MUST result in 401 (or 503 if api_token unset). 200 is a
    // bug. We send from a LAN IP WITHOUT the Bearer header so this test fails
    // if a future commit accidentally adds /api/history/raw to LAN_SAFE_ENDPOINTS.
    const ctx = mockCtx();
    const req = makeReq('/api/history/raw', { token: null, ip: LAN_IP });
    const captured = await dispatch(ctx, req);
    assert.notEqual(
      captured.status,
      200,
      `LAN request without Bearer MUST NOT receive 200 (D-15). got status=${captured.status} body=${captured.body}`
    );
    // From an external IP the same request must hit 401 specifically (api_token IS configured).
    const reqExt = makeReq('/api/history/raw', { token: null, ip: REMOTE_IP });
    const capturedExt = await dispatch(mockCtx(), reqExt);
    assert.equal(
      capturedExt.status,
      401,
      `external request without Bearer expected 401, got ${capturedExt.status} body=${capturedExt.body}`
    );
  });

  it('authenticated request returns 200 + correct shape', async () => {
    const seed = buildSeed(5);
    const ctx = mockCtx({ pool: makeMockPool(seed) });
    const req = makeReq('/api/history/raw');
    const captured = await dispatch(ctx, req);
    assert.equal(captured.status, 200, `expected 200, got ${captured.status} body=${captured.body}`);
    const body = JSON.parse(captured.body);
    for (const k of ['ok', 'rows', 'next_cursor', 'total', 'query_ms']) {
      assert.ok(k in body, `response body missing required key "${k}"`);
    }
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.rows), `rows must be an array, got ${typeof body.rows}`);
    assert.equal(typeof body.query_ms, 'number');
    assert.ok(body.query_ms >= 0 && Number.isFinite(body.query_ms), `query_ms must be a finite non-negative number, got ${body.query_ms}`);
  });

  it('rows are [ts_iso, series_key, value, unit] tuples ordered ts_utc DESC', async () => {
    const seed = buildSeed(3);
    const ctx = mockCtx({ pool: makeMockPool(seed) });
    const req = makeReq('/api/history/raw');
    const captured = await dispatch(ctx, req);
    const body = JSON.parse(captured.body);
    assert.equal(body.rows.length, 3);
    // Each row must be a 4-element array [ts, key, value, unit]
    for (const row of body.rows) {
      assert.ok(Array.isArray(row), `row must be an array, got ${typeof row}`);
      assert.equal(row.length, 4, `row must have 4 elements, got ${row.length}`);
      assert.equal(typeof row[0], 'string', 'row[0] (ts) must be ISO string');
      assert.equal(typeof row[1], 'string', 'row[1] (series_key) must be string');
    }
    // DESC order: row[0][0] > row[1][0] > row[2][0]
    assert.ok(row0gt(body.rows), 'rows must be ordered ts DESC');
    function row0gt(rows) {
      for (let i = 1; i < rows.length; i++) {
        if (Date.parse(rows[i - 1][0]) <= Date.parse(rows[i][0])) return false;
      }
      return true;
    }
  });

  it('limit capped at 10000 server-side regardless of client value', async () => {
    // Caller sends `?limit=99999`; handler MUST cap to 10000 and pass
    // `LIMIT 10001` (limit+1 for "has more" detection) to the DB.
    const ctx = mockCtx({ pool: makeMockPool([]) });
    const req = makeReq('/api/history/raw?limit=99999');
    await dispatch(ctx, req);
    const lastCall = ctx.telemetryStore.pool.calls[ctx.telemetryStore.pool.calls.length - 1];
    assert.ok(lastCall, 'handler must have called pool.query');
    const limitParam = Number(lastCall.params[lastCall.params.length - 1]);
    assert.ok(
      limitParam <= 10001,
      `limit param sent to DB must be <= 10001 (10000 cap + 1 for has-more), got ${limitParam}`
    );
  });

  it('two-page cursor reconstruction has no duplicates and no skips', async () => {
    // Seed 25 rows, paginate with limit=10. Page 1 yields rows 0..9 + cursor.
    // Page 2 (cursor) yields 10..19 + cursor. Page 3 yields the final 5.
    // Union must equal seed 1:1, no dupes.
    const seed = buildSeed(25, { stepSec: 60 });
    const pool = makeMockPool(seed);
    const ctx = mockCtx({ pool });
    const routes = createApiRoutes(ctx);

    const page1 = JSON.parse((await dispatch(ctx, makeReq('/api/history/raw?limit=10'), routes)).body);
    assert.equal(page1.rows.length, 10, `page1 rows expected 10, got ${page1.rows.length}`);
    assert.ok(page1.next_cursor, 'page1 must have next_cursor (more rows exist)');

    const page2 = JSON.parse((await dispatch(ctx, makeReq(`/api/history/raw?limit=10&cursor=${encodeURIComponent(page1.next_cursor)}`), routes)).body);
    assert.equal(page2.rows.length, 10, `page2 rows expected 10, got ${page2.rows.length}`);
    assert.ok(page2.next_cursor, 'page2 must have next_cursor (5 more rows exist)');

    const page3 = JSON.parse((await dispatch(ctx, makeReq(`/api/history/raw?limit=10&cursor=${encodeURIComponent(page2.next_cursor)}`), routes)).body);
    assert.equal(page3.rows.length, 5, `page3 rows expected 5, got ${page3.rows.length}`);
    assert.equal(page3.next_cursor, null, 'page3 must have null next_cursor (no more rows)');

    // Reconstruct: union of all three pages must have 25 unique tuples
    const unionTimestamps = [...page1.rows, ...page2.rows, ...page3.rows].map((r) => r[0]);
    const unique = new Set(unionTimestamps);
    assert.equal(unionTimestamps.length, 25, `total union row count must be 25, got ${unionTimestamps.length}`);
    assert.equal(unique.size, 25, `union must have 25 UNIQUE timestamps, got ${unique.size} (duplicates detected)`);
    // Verify no skips: every seed timestamp appears
    const seedTimestamps = new Set(seed.map((r) => r.ts_utc.toISOString()));
    for (const ts of seedTimestamps) {
      assert.ok(unique.has(ts), `seed ts ${ts} missing from union — pagination skipped a row`);
    }
  });

  it('invalid ISO timestamp in `from` returns 400 (not 500, not crash)', async () => {
    const ctx = mockCtx();
    const req = makeReq('/api/history/raw?from=not-a-date');
    const captured = await dispatch(ctx, req);
    assert.equal(captured.status, 400, `expected 400 for invalid from, got ${captured.status} body=${captured.body}`);
    const body = JSON.parse(captured.body);
    assert.equal(body.ok, false, 'body.ok must be false on validation error');
    assert.ok(typeof body.error === 'string' && body.error.length > 0, 'body.error must be a non-empty string');
    // Ensure we did NOT reach the DB
    assert.equal(ctx.telemetryStore.pool.calls.length, 0, 'pool.query MUST NOT be called when params fail validation');
  });

  it('signals param uses parameterized ANY array — no SQL injection (DROP TABLE attempt)', async () => {
    // Send a SQL injection payload as a signal value. It must land in the params
    // array as a single text element, not be substring-injected into the SQL.
    const ATTACK = "a';DROP TABLE timeseries_samples;--";
    const ctx = mockCtx({ pool: makeMockPool([]) });
    const req = makeReq(`/api/history/raw?signals=${encodeURIComponent(ATTACK)}`);
    await dispatch(ctx, req);
    const call = ctx.telemetryStore.pool.calls[ctx.telemetryStore.pool.calls.length - 1];
    assert.ok(call, 'handler must have called pool.query');
    // The attack string must NOT appear inside the SQL string itself
    assert.equal(
      call.sql.includes(ATTACK),
      false,
      `attack payload found IN SQL STRING — string concat detected. SQL: ${call.sql}`
    );
    // It MUST appear as an element of one of the params (the text[] array binding)
    const flat = call.params.flatMap((p) => (Array.isArray(p) ? p : [p]));
    assert.ok(
      flat.includes(ATTACK),
      `attack payload should appear as a parameterized value, but did not. params: ${JSON.stringify(call.params)}`
    );
    // Also verify the parameterized array placeholder syntax appears
    assert.match(call.sql, /ANY\(\$\d+::text\[\]\)/, 'SQL must use ANY($N::text[]) for arrays — got: ' + call.sql);
  });

  it('sources param JOINs with series_metadata using parameterized array', async () => {
    const ctx = mockCtx({ pool: makeMockPool([]) });
    const req = makeReq('/api/history/raw?sources=victron,mid');
    await dispatch(ctx, req);
    const call = ctx.telemetryStore.pool.calls[ctx.telemetryStore.pool.calls.length - 1];
    assert.ok(call, 'handler must have called pool.query');
    assert.match(call.sql, /JOIN\s+series_metadata/i, 'SQL must JOIN series_metadata when sources param is set');
    assert.match(call.sql, /m\.source\s*=\s*ANY\(\$\d+::text\[\]\)/i, 'sources filter must use parameterized text[] array');
    // Also assert ORDER BY ts_utc DESC for chunk-pruning (D-16)
    assert.match(call.sql, /ORDER BY\s+s\.ts_utc\s+DESC/i, 'SQL must ORDER BY s.ts_utc DESC for TimescaleDB chunk-pruning (D-16)');
    // Params include the sources array
    const flat = call.params.flatMap((p) => (Array.isArray(p) ? p : [p]));
    assert.ok(flat.includes('victron') && flat.includes('mid'), `params must contain victron + mid, got ${JSON.stringify(call.params)}`);
  });

  it('cache hit (D-14): identical params within 60s share payload — pool called exactly once', async () => {
    const seed = buildSeed(3);
    const pool = makeMockPool(seed);
    const ctx = mockCtx({ pool });
    // Cache lives in the routes closure — must reuse the same routes instance
    const routes = createApiRoutes(ctx);

    const r1 = JSON.parse((await dispatch(ctx, makeReq('/api/history/raw?signals=synth_0,synth_1&limit=5'), routes)).body);
    const r2 = JSON.parse((await dispatch(ctx, makeReq('/api/history/raw?signals=synth_0,synth_1&limit=5'), routes)).body);
    assert.deepEqual(r1.rows, r2.rows, 'cached response should return identical rows');
    // Pool query must have run exactly once across two identical requests
    const queryCalls = pool.calls.filter((c) => /FROM\s+timeseries_samples/i.test(c.sql));
    assert.equal(
      queryCalls.length,
      1,
      `pool.query against timeseries_samples should fire once for two cached calls, got ${queryCalls.length}`
    );
  });

  it('cache eviction at cap 100 — 101 distinct param tuples = 101 query calls', async () => {
    const pool = makeMockPool([]);
    const ctx = mockCtx({ pool });
    const routes = createApiRoutes(ctx);
    // Fire 101 requests with distinct `limit=` values so each lands in a unique cache key.
    for (let i = 1; i <= 101; i++) {
      const req = makeReq(`/api/history/raw?limit=${i}`);
      await dispatch(ctx, req, routes);
    }
    const queryCalls = pool.calls.filter((c) => /FROM\s+timeseries_samples/i.test(c.sql));
    assert.equal(
      queryCalls.length,
      101,
      `101 distinct cache keys must produce 101 DB calls (no spurious cache hits), got ${queryCalls.length}`
    );
    // Now re-fire request #1 (limit=1). With cap=100 + FIFO eviction, the
    // oldest entry (i=1) was evicted by the time we inserted i=101. So the
    // re-fire must be a CACHE MISS → 102 total calls.
    await dispatch(ctx, makeReq('/api/history/raw?limit=1'), routes);
    const queryCallsAfter = pool.calls.filter((c) => /FROM\s+timeseries_samples/i.test(c.sql));
    assert.equal(
      queryCallsAfter.length,
      102,
      `re-fire of evicted cache entry must miss → 102 total DB calls, got ${queryCallsAfter.length}`
    );
  });
});
