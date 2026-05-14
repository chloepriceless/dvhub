// test/api/history-raw-parquet.test.js
//
// Plan 09.2-08 Wave-0 (RED) — endpoint contract + round-trip tests for the
// new streaming GET /api/history/raw/export.parquet route.
//
// CONTEXT.md decisions verified by this file:
//   D-13 / D-24 (revised): @dsnp/parquetjs (pure-JS Parquet writer) — apache-arrow
//         JS package does NOT support Parquet write (RESEARCH O-1).
//   D-15 / T-09.2-AUTHZ: NOT in LAN_SAFE_ENDPOINTS — Bearer required from any
//         source. /api/history/raw/export.parquet is in BEARER_REQUIRED_ENDPOINTS
//         (added in Plan 09.2-05 forward-compat).
//   T-09.2-INJ: SQL params bound via $N placeholders (same shape as Plan 05/06).
//   T-09.2-DOS-MEM: pg.Cursor reads pages of 500 rows; ParquetWriter.appendRow
//         per cursor row; never builds full row set in memory.
//   T-09.2-FILENAME-INJ: Filename derived from server-side `new Date()`; client
//         `?filename=` query param NEVER read (V12 ASVS).
//   Round-trip: write Parquet → ParquetReader.openBuffer → iterate cursor →
//         row count parity with the synthetic seed.
//
// Test mode: same scaffolding as history-raw-export.test.js (Plan 09.2-06).
// Mocked req/res; cursor-aware mock pool (pool.connect() → client.query(Cursor)
// → cursor with read(n, cb) + close(cb)). The mock res captures chunks as
// Buffer-friendly strings so we can reconstruct the response body for
// ParquetReader.openBuffer().

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import parquet from '@dsnp/parquetjs';
import { createApiRoutes } from '../../routes-api.js';

const REMOTE_IP = '203.0.113.5';     // TEST-NET-3 — never resolves to LAN
const LAN_IP = '192.168.1.66';      // RFC 1918 — would bypass auth IF endpoint were LAN-safe
const API_TOKEN = 'plan-09-2-08-test-token-xxxxxxxxxxxxxxxx';

// A streaming-aware mock res. Captures status, headers and the (concatenated)
// body as Buffers so we can pass to ParquetReader.openBuffer (binary-safe).
function mockStreamRes() {
  const captured = {
    status: 0,
    headers: {},
    chunks: [],     // Array of Buffer
    closed: false,
    _startedAt: 0,
  };
  const closeListeners = [];
  return {
    writeHead(code, headers) {
      captured.status = code;
      Object.assign(captured.headers, headers || {});
    },
    write(chunk, cb) {
      // Parquet writes binary buffers; preserve them. ParquetEnvelopeWriter (via
      // util.oswrite) calls res.write(buf, callback) — we MUST invoke the
      // callback or writer.close() will hang. Real http.ServerResponse honors
      // the same contract; this mock matches it.
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      captured.chunks.push(buf);
      if (typeof cb === 'function') cb();
      return true;
    },
    end(payload, cb) {
      // Two call shapes: end(cb) or end(payload, cb). The streaming exporters
      // generally use end() with no payload; the writer-side osend uses end(cb).
      let callback = cb;
      if (typeof payload === 'function') {
        callback = payload;
      } else if (payload != null) {
        const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
        captured.chunks.push(buf);
      }
      captured.closed = true;
      if (typeof callback === 'function') callback();
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

function bodyBuffer(res) {
  return Buffer.concat(res._captured.chunks);
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

// Cursor-aware mock pool. Same shape as Plan 06's makeMockPoolWithCursor.
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
    // Plan 05 path (not used by parquet endpoint; included for safety).
    query: async (sql, params) => {
      queryCalls.push({ sql, params: params ? [...params] : [] });
      return { rows: seed };
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
    db: pool,
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
async function waitForClose(res, timeoutMs = 3000) {
  const t0 = Date.now();
  while (!res._captured.closed) {
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`stream did not close within ${timeoutMs}ms (chunks=${res._captured.chunks.length}, body.len=${bodyBuffer(res).length})`);
    }
    await new Promise((r) => setImmediate(r));
  }
  return res;
}

// Build a synthetic descending-time series of rows.
function buildSeed(count, { startIso = '2026-05-14T12:00:00.000Z', stepSec = 60 } = {}) {
  const startMs = Date.parse(startIso);
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      ts_utc: new Date(startMs - i * stepSec * 1000),
      series_key: 'pv_total_w',
      value_num: 1000 + i,
      unit: 'W',
    });
  }
  return rows;
}

describe('GET /api/history/raw/export.parquet', () => {
  it('LAN non-authenticated request returns 401 — D-15 enforcement (NOT in LAN_SAFE_ENDPOINTS)', async () => {
    // /api/history/raw/export.parquet is in BEARER_REQUIRED_ENDPOINTS (Plan 05).
    // Even from a private LAN IP, missing Bearer MUST yield 401, not 200.
    const ctx = mockCtx();
    const req = makeReq('/api/history/raw/export.parquet', { token: null, ip: LAN_IP });
    const res = await dispatch(ctx, req);
    assert.notEqual(
      res._captured.status,
      200,
      `LAN request without Bearer MUST NOT receive 200 (D-15). got status=${res._captured.status}`
    );
    // External IP must hit 401 specifically.
    const ctxExt = mockCtx();
    const reqExt = makeReq('/api/history/raw/export.parquet', { token: null, ip: REMOTE_IP });
    const resExt = await dispatch(ctxExt, reqExt);
    assert.equal(
      resExt._captured.status,
      401,
      `external request without Bearer expected 401, got ${resExt._captured.status}`
    );
  });

  it('Content-Type + Content-Disposition + Transfer-Encoding headers are correct', async () => {
    const seed = buildSeed(3);
    const ctx = mockCtx({ pool: makeMockPoolWithCursor(seed) });
    const req = makeReq('/api/history/raw/export.parquet');
    const res = await dispatch(ctx, req);
    await waitForClose(res);

    assert.equal(res._captured.status, 200, `expected 200, got ${res._captured.status}`);

    const hdrs = {};
    for (const [k, v] of Object.entries(res._captured.headers)) hdrs[k.toLowerCase()] = v;

    assert.match(
      String(hdrs['content-type'] || ''),
      /(application\/octet-stream|application\/vnd\.apache\.parquet)/,
      `Content-Type must be application/octet-stream or application/vnd.apache.parquet, got "${hdrs['content-type']}"`
    );
    assert.match(
      String(hdrs['content-disposition'] || ''),
      /attachment;\s*filename="dvhub-export-\d{4}-\d{2}-\d{2}\.parquet"/,
      `Content-Disposition must be attachment with server-derived filename, got "${hdrs['content-disposition']}"`
    );
    assert.match(
      String(hdrs['transfer-encoding'] || ''),
      /chunked/i,
      `Transfer-Encoding must be chunked for streaming, got "${hdrs['transfer-encoding']}"`
    );
  });

  it('round-trip: ParquetReader reads back exactly the seeded rows (count parity + shape)', async () => {
    // Seed 25 deterministic rows. After streaming, capture the body Buffer,
    // open via ParquetReader.openBuffer, iterate the cursor, count rows, and
    // assert row shape matches.
    const seed = buildSeed(25);
    const ctx = mockCtx({ pool: makeMockPoolWithCursor(seed) });
    const req = makeReq('/api/history/raw/export.parquet');
    const res = await dispatch(ctx, req);
    await waitForClose(res);

    assert.equal(res._captured.status, 200, `expected 200, got ${res._captured.status}`);

    const buf = bodyBuffer(res);
    assert.ok(buf.length > 0, 'response body must be non-empty');
    // Parquet magic number "PAR1" at start AND end of file
    assert.equal(buf.subarray(0, 4).toString('ascii'), 'PAR1', `parquet magic header expected "PAR1", got "${buf.subarray(0, 4).toString('ascii')}"`);
    assert.equal(buf.subarray(buf.length - 4).toString('ascii'), 'PAR1', `parquet magic footer expected "PAR1", got "${buf.subarray(buf.length - 4).toString('ascii')}"`);

    const reader = await parquet.ParquetReader.openBuffer(buf);
    const cursor = reader.getCursor();
    let row;
    let count = 0;
    let firstRow = null;
    while ((row = await cursor.next())) {
      count++;
      if (firstRow == null) firstRow = row;
      // Schema: ts_utc UTF8, series_key UTF8, value DOUBLE optional, unit UTF8 optional.
      // @dsnp/parquetjs returns UTF8 fields as Buffer by default — coerce to string.
      const tsUtc = row.ts_utc != null ? String(row.ts_utc) : '';
      const seriesKey = row.series_key != null ? String(row.series_key) : '';
      assert.ok(tsUtc.length > 0, `row ${count}: ts_utc must be non-empty, got "${tsUtc}"`);
      assert.equal(seriesKey, 'pv_total_w', `row ${count}: series_key must be "pv_total_w", got "${seriesKey}"`);
      assert.equal(typeof row.value, 'number', `row ${count}: value must be number, got ${typeof row.value} (${row.value})`);
    }
    await reader.close();
    assert.equal(count, 25, `round-trip row-count parity: expected 25 rows, got ${count}`);
  });

  it('filename derived from server timestamp — client-supplied filename ignored (T-09.2-FILENAME-INJ)', async () => {
    const seed = buildSeed(1);
    const ctx = mockCtx({ pool: makeMockPoolWithCursor(seed) });

    const ATTACK = '../../etc/passwd';
    const req = makeReq(`/api/history/raw/export.parquet?filename=${encodeURIComponent(ATTACK)}`);
    const res = await dispatch(ctx, req);
    await waitForClose(res);

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const hdrs = {};
    for (const [k, v] of Object.entries(res._captured.headers)) hdrs[k.toLowerCase()] = v;
    const cd = String(hdrs['content-disposition'] || '');
    assert.ok(
      cd.includes(`dvhub-export-${today}.parquet`),
      `Content-Disposition must contain server-derived filename "dvhub-export-${today}.parquet", got "${cd}"`
    );
    assert.ok(
      !cd.includes(ATTACK) && !cd.includes('etc/passwd'),
      `Content-Disposition MUST NOT echo client-supplied filename (V12 ASVS), got "${cd}"`
    );
  });
});
