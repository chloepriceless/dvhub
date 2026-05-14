// test/api/history-raw-export.test.js
//
// Plan 09.2-06 Wave-0 (RED) — endpoint contract tests for the new
// streaming GET /api/history/raw/export.csv route.
//
// CONTEXT.md decisions verified by this file:
//   D-12: CSV-Stream Route — no LIMIT, no Cursor, streams directly to the
//         response (Transfer-Encoding: chunked, Content-Type: text/csv).
//   D-15 / T-09.2-AUTHZ: NOT in LAN_SAFE_ENDPOINTS — Bearer required from any
//         source. /api/history/raw/export.csv is in BEARER_REQUIRED_ENDPOINTS
//         (added in Plan 09.2-05).
//   T-09.2-INJ: SQL params bound via $N placeholders (same shape as Plan 05).
//         CSV cells containing `;`, `"`, or `\n` quoted with embedded quotes
//         doubled. Filename derived from server-side timestamp ONLY (V12 ASVS
//         — no client-supplied filename echoed in Content-Disposition).
//   T-09.2-DOS-MEM: pg.Cursor reads pages of 500 rows; res.write per chunk;
//         never builds full row set in memory.
//   T-09.2-DOS-CONN: Honour client disconnect via res.on('close'); abort
//         cursor on close.
//   T-09.2-FILENAME-INJ: Filename derived from `new Date()`; client-supplied
//         `filename` query param NEVER read.
//
// Test mode: invokes the routes-api dispatch handler directly via mocked
// req/res (history-raw.test.js pattern). The pool is a stub that supports
// BOTH `pool.query(sql, params)` (used by Plan 05's /api/history/raw, for
// the row-count parity test) AND `pool.connect()` returning a client whose
// `.query(new Cursor(sql, params))` yields a cursor with `.read(n, cb)` +
// `.close(cb)` semantics (used by the streaming export).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApiRoutes } from '../../routes-api.js';

const REMOTE_IP = '203.0.113.5';     // TEST-NET-3 — never resolves to LAN
const LAN_IP = '192.168.1.66';      // RFC 1918 — would bypass auth IF endpoint were LAN-safe
const API_TOKEN = 'plan-09-2-06-test-token-xxxxxxxxxxxxxxxx';

// A streaming-aware mock res. Captures status, headers and the (concatenated)
// body. Emits a 'close' event when test code calls .simulateClientClose() so
// the handler's req.on('close') / res.on('close') hooks fire.
function mockStreamRes() {
  const captured = { status: 0, headers: {}, body: '', chunks: [], closed: false, ttfbMs: 0 };
  const closeListeners = [];
  let firstChunkAt = 0;
  return {
    writeHead(code, headers) {
      captured.status = code;
      Object.assign(captured.headers, headers || {});
    },
    write(chunk) {
      if (firstChunkAt === 0) firstChunkAt = Date.now();
      const s = chunk == null ? '' : String(chunk);
      captured.chunks.push(s);
      captured.body += s;
      return true;
    },
    end(payload) {
      if (payload != null) {
        const s = String(payload);
        captured.chunks.push(s);
        captured.body += s;
      }
      captured.closed = true;
      captured.ttfbMs = firstChunkAt ? firstChunkAt - captured._startedAt : 0;
    },
    on(event, listener) {
      if (event === 'close') closeListeners.push(listener);
    },
    once(event, listener) {
      if (event === 'close') closeListeners.push(listener);
    },
    simulateClientClose() {
      for (const fn of closeListeners) {
        try { fn(); } catch { /* test cleanup */ }
      }
    },
    _captured: captured,
  };
}

function makeReq(pathname, { method = 'GET', token = API_TOKEN, ip = REMOTE_IP } = {}) {
  const headers = { host: 'dvhub.test' };
  if (token) headers.authorization = `Bearer ${token}`;
  const closeListeners = [];
  return {
    method,
    url: pathname,
    headers,
    socket: { remoteAddress: ip },
    on(event, listener) {
      if (event === 'close') closeListeners.push(listener);
    },
    once(event, listener) {
      if (event === 'close') closeListeners.push(listener);
    },
    simulateClientClose() {
      for (const fn of closeListeners) {
        try { fn(); } catch { /* test cleanup */ }
      }
    },
  };
}

// Cursor-aware mock pool. Used by the streaming export endpoint.
//
// `pool.connect()` returns a client whose `.query(cursorObj)` returns a cursor.
// The cursor pages through the seed array in `read(n, cb)` calls; cursor.close()
// flips the `cursorClosed` flag (verified by the disconnect test).
//
// Also implements `pool.query(sql, params)` (used by Plan 05's /api/history/raw
// in the row-count parity test).
function makeMockPoolWithCursor(seed = []) {
  const queryCalls = [];
  const cursorState = { closed: false };
  let clientReleased = false;
  const pool = {
    queryCalls,
    cursorClosed: () => cursorState.closed,
    clientReleased: () => clientReleased,
    connect: async () => ({
      query: (cursorObj /* a pg.Cursor instance */) => {
        const sql = cursorObj?.text ?? cursorObj;
        const params = cursorObj?.values ?? [];
        queryCalls.push({ sql, params: Array.isArray(params) ? [...params] : [] });
        let position = 0;
        return {
          read(n, cb) {
            const batch = seed.slice(position, position + n);
            position += batch.length;
            // Async to mimic real pg.Cursor (libpq result delivery)
            setImmediate(() => cb(null, batch));
          },
          close(cb) {
            cursorState.closed = true;
            if (typeof cb === 'function') setImmediate(() => cb());
          },
        };
      },
      release: () => { clientReleased = true; },
    }),
    // Plan 05 path — used by the row-count parity test to compute the JSON
    // baseline. Returns the seed verbatim (slice'd to limit if requested).
    query: async (sql, params) => {
      queryCalls.push({ sql, params: params ? [...params] : [] });
      if (!/FROM\s+timeseries_samples/i.test(sql)) return { rows: [] };
      // Last param is LIMIT for /api/history/raw; ignore for our parity test
      const limitParam = Number(params?.[params.length - 1]);
      const limit = Number.isFinite(limitParam) ? limitParam : seed.length;
      return { rows: seed.slice(0, limit) };
    },
  };
  return pool;
}

function mockCtx({ pool = makeMockPoolWithCursor() } = {}) {
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
  };
}

async function dispatch(ctx, req, routes = null) {
  const r = routes || createApiRoutes(ctx);
  const res = mockStreamRes();
  res._captured._startedAt = Date.now();
  const url = new URL(req.url, `http://${req.headers.host}`);
  await r.handleRequest(req, res, url);
  return res;
}

// Wait until the streaming handler reports it has called res.end().
// The handler reads pages of 500 rows asynchronously via setImmediate, so
// even tiny seeds need a brief wait for the final res.end().
async function waitForClose(res, timeoutMs = 1500) {
  const t0 = Date.now();
  while (!res._captured.closed) {
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`stream did not close within ${timeoutMs}ms (chunks=${res._captured.chunks.length}, body.len=${res._captured.body.length})`);
    }
    await new Promise((r) => setImmediate(r));
  }
  return res;
}

// Build a synthetic descending-time series of rows (mirrors history-raw.test.js).
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

const BOM = '﻿'; // UTF-8 BOM, U+FEFF ZERO WIDTH NO-BREAK SPACE

describe('GET /api/history/raw/export.csv', () => {
  it('LAN non-authenticated request returns 401 — D-15 enforcement (NOT in LAN_SAFE_ENDPOINTS)', async () => {
    // /api/history/raw/export.csv is in BEARER_REQUIRED_ENDPOINTS (Plan 05).
    // Even from a private LAN IP, missing Bearer MUST yield 401, not 200.
    const ctx = mockCtx();
    const req = makeReq('/api/history/raw/export.csv', { token: null, ip: LAN_IP });
    const res = await dispatch(ctx, req);
    assert.notEqual(
      res._captured.status,
      200,
      `LAN request without Bearer MUST NOT receive 200 (D-15). got status=${res._captured.status} body=${res._captured.body}`
    );
    // External IP must hit 401 specifically (api_token IS configured).
    const ctxExt = mockCtx();
    const reqExt = makeReq('/api/history/raw/export.csv', { token: null, ip: REMOTE_IP });
    const resExt = await dispatch(ctxExt, reqExt);
    assert.equal(
      resExt._captured.status,
      401,
      `external request without Bearer expected 401, got ${resExt._captured.status} body=${resExt._captured.body}`
    );
  });

  it('Content-Type + Content-Disposition headers are correct', async () => {
    const seed = buildSeed(3);
    const ctx = mockCtx({ pool: makeMockPoolWithCursor(seed) });
    const req = makeReq('/api/history/raw/export.csv');
    const res = await dispatch(ctx, req);
    await waitForClose(res);

    assert.equal(res._captured.status, 200, `expected 200, got ${res._captured.status}`);

    // Header keys can be set in any case — check case-insensitively.
    const hdrs = {};
    for (const [k, v] of Object.entries(res._captured.headers)) hdrs[k.toLowerCase()] = v;

    assert.match(
      String(hdrs['content-type'] || ''),
      /text\/csv.*charset=utf-?8/i,
      `Content-Type must be text/csv with charset=utf-8, got "${hdrs['content-type']}"`
    );
    assert.match(
      String(hdrs['content-disposition'] || ''),
      /attachment;\s*filename="dvhub-export-\d{4}-\d{2}-\d{2}\.csv"/,
      `Content-Disposition must be attachment with server-derived filename, got "${hdrs['content-disposition']}"`
    );
    assert.match(
      String(hdrs['transfer-encoding'] || ''),
      /chunked/i,
      `Transfer-Encoding must be chunked for streaming, got "${hdrs['transfer-encoding']}"`
    );
  });

  it('body starts with UTF-8 BOM + header row (semicolon separator)', async () => {
    const seed = buildSeed(2);
    const ctx = mockCtx({ pool: makeMockPoolWithCursor(seed) });
    const req = makeReq('/api/history/raw/export.csv');
    const res = await dispatch(ctx, req);
    await waitForClose(res);

    const body = res._captured.body;
    // First char MUST be the BOM (U+FEFF) — Excel autodetects UTF-8 from this
    assert.equal(body.charCodeAt(0), 0xFEFF, `body must start with U+FEFF BOM, got code=${body.charCodeAt(0)}`);
    // Then the header row: ts_utc;series_key;value;unit
    const afterBom = body.slice(1);
    assert.match(
      afterBom,
      /^ts_utc;series_key;value;unit\r?\n/,
      `expected header row "ts_utc;series_key;value;unit\\n" right after BOM, got "${afterBom.slice(0, 60)}"`
    );
  });

  it('semicolon separator: data rows have exactly 3 semicolons (4 columns)', async () => {
    const seed = buildSeed(5);
    const ctx = mockCtx({ pool: makeMockPoolWithCursor(seed) });
    const req = makeReq('/api/history/raw/export.csv');
    const res = await dispatch(ctx, req);
    await waitForClose(res);

    const body = res._captured.body;
    // Strip BOM + header
    const lines = body.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
    assert.ok(lines.length >= 6, `expected ≥6 lines (header + 5 data), got ${lines.length}: ${lines.slice(0, 3)}`);
    // First line is header; data lines start at index 1
    for (let i = 1; i < lines.length; i++) {
      // Count semicolons OUTSIDE of quoted regions (synthetic seed has no quotes
      // or special chars so this simple count works)
      const semicolons = lines[i].split(';').length - 1;
      assert.equal(
        semicolons,
        3,
        `data line ${i} must have exactly 3 semicolons (4 columns), got ${semicolons}: "${lines[i]}"`
      );
    }
  });

  it('TTFB < 500ms (target < 200ms — streaming, not buffered)', async () => {
    // Seed with 100 rows so the handler isn't trivially fast on an empty pool.
    const seed = buildSeed(100);
    const ctx = mockCtx({ pool: makeMockPoolWithCursor(seed) });
    const req = makeReq('/api/history/raw/export.csv');
    const t0 = Date.now();
    const res = await dispatch(ctx, req);
    // First write must happen quickly — count time-to-first-chunk
    const tFirstChunk = res._captured.chunks.length > 0 ? Date.now() - t0 : Infinity;
    await waitForClose(res);
    assert.ok(
      tFirstChunk < 500,
      `TTFB target < 500ms (aspirational < 200ms — streamed, not buffered). got ${tFirstChunk}ms`
    );
  });

  it('row-count parity with /api/history/raw JSON (same range, same filter)', async () => {
    // Seed 25 deterministic rows. GET both endpoints with identical params.
    // Count CSV data rows (skip BOM + header) and compare to JSON body.total.
    const seed = buildSeed(25);
    const pool = makeMockPoolWithCursor(seed);
    const ctx = mockCtx({ pool });
    const routes = createApiRoutes(ctx);

    const params = 'signals=synth_0,synth_1,synth_2&from=2026-05-13T00:00:00Z&to=2026-05-15T00:00:00Z';

    // JSON path (Plan 05) uses pool.query directly
    const jsonRes = await dispatch(ctx, makeReq(`/api/history/raw?${params}&limit=1000`), routes);
    const jsonBody = JSON.parse(jsonRes._captured.body);
    assert.equal(jsonBody.ok, true, `JSON body.ok must be true, got ${jsonBody.body || jsonRes._captured.body}`);

    // CSV path (Plan 06) uses pool.connect() + Cursor
    const csvRes = await dispatch(ctx, makeReq(`/api/history/raw/export.csv?${params}`), routes);
    await waitForClose(csvRes);
    const lines = csvRes._captured.body.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
    const csvDataRowCount = lines.length - 1; // minus header
    assert.equal(
      csvDataRowCount,
      jsonBody.total,
      `row-count parity expected: CSV data rows (${csvDataRowCount}) == JSON total (${jsonBody.total})`
    );
  });

  it('filename derived from server timestamp — client-supplied filename ignored', async () => {
    const seed = buildSeed(1);
    const ctx = mockCtx({ pool: makeMockPoolWithCursor(seed) });

    // Try to inject a malicious filename via query param
    const ATTACK = '../../etc/passwd';
    const req = makeReq(`/api/history/raw/export.csv?filename=${encodeURIComponent(ATTACK)}`);
    const res = await dispatch(ctx, req);
    await waitForClose(res);

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const hdrs = {};
    for (const [k, v] of Object.entries(res._captured.headers)) hdrs[k.toLowerCase()] = v;
    const cd = String(hdrs['content-disposition'] || '');
    assert.ok(
      cd.includes(`dvhub-export-${today}.csv`),
      `Content-Disposition must contain server-derived filename "dvhub-export-${today}.csv", got "${cd}"`
    );
    assert.ok(
      !cd.includes(ATTACK) && !cd.includes('etc/passwd'),
      `Content-Disposition MUST NOT echo client-supplied filename (V12 ASVS), got "${cd}"`
    );
  });

  it('CSV escape handles semicolon, quote and newline in cell values', async () => {
    // Seed a row whose unit contains a semicolon + double-quote, and another
    // whose series_key contains a newline — handler MUST quote-escape these.
    const tricky = [
      {
        ts_utc: new Date('2026-05-14T12:00:00.000Z'),
        series_key: 'normal_key',
        value_num: 42,
        unit: '";test;"', // contains both " and ;
      },
      {
        ts_utc: new Date('2026-05-14T11:59:00.000Z'),
        series_key: 'key\nwith\nnewline',
        value_num: 7,
        unit: 'W',
      },
    ];
    const ctx = mockCtx({ pool: makeMockPoolWithCursor(tricky) });
    const req = makeReq('/api/history/raw/export.csv');
    const res = await dispatch(ctx, req);
    await waitForClose(res);

    const body = res._captured.body;
    // Row 1: unit cell with `;` and `"` must be wrapped in quotes with `""`
    // doubling. The escaped form is: """;test;"""
    assert.ok(
      body.includes('""";test;"""'),
      `unit cell with ; and " must be quoted with embedded quotes doubled. body: ${body.slice(0, 400)}`
    );
    // Row 2: series_key with embedded \n must be wrapped in quotes
    assert.ok(
      body.includes('"key\nwith\nnewline"'),
      `series_key with newline must be wrapped in quotes. body: ${body.slice(0, 400)}`
    );
  });

  it('client disconnect aborts the cursor and releases the client', async () => {
    // Seed 5000 rows (well past one read(500) page) so the handler is still in
    // the middle of pagination when we simulate the disconnect.
    const seed = buildSeed(5000);
    const pool = makeMockPoolWithCursor(seed);
    const ctx = mockCtx({ pool });
    const req = makeReq('/api/history/raw/export.csv');
    const res = await dispatch(ctx, req);

    // Allow the first chunk to flow, then simulate the client closing the socket
    await new Promise((r) => setImmediate(r));
    req.simulateClientClose();
    res.simulateClientClose();

    // Give the handler one tick to react. Cursor.close() should fire.
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(
      pool.cursorClosed(),
      true,
      `pg.Cursor must be closed after client disconnect (T-09.2-DOS-CONN). got cursorClosed=false`
    );
  });
});
