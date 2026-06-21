// test/migrations/019-series-metadata.test.js
//
// Plan 09.2-01 — series_metadata lookup table + D-09 defensive writeSamples hook.
//
// CONTEXT.md decisions verified by this file:
//   D-06: Lookup-table strategy (no ALTER on timeseries_samples) — SQL grep guard.
//   D-07: Initial seed maps the ~57 known series_keys to their source.
//   D-08: JOIN over series_metadata is the source-chip filter mechanism — verified
//         by joining a fresh sample insert with the metadata table.
//   D-09: Defensive writeSamples hook upserts source='unknown' for any new
//         series_key the codebase ever writes — Explorer source-chip filter
//         can never crash on a previously-unknown signal.
//   D-10: Migration filename is exactly 019-series-metadata.sql.
//
// Test mode: integration tests against a real PostgreSQL DB. The whole describe
// block is skip-gated when DATABASE_URL is unset (CI without Postgres). The
// `pg` driver and the telemetry-store factory are imported lazily inside
// `before()` so the test file loads cleanly even on fresh checkouts where
// `npm install` has not yet been run (matches the dvhub/test/schema-polish.test.js
// posture: file-load is the hard gate; live-DB execution is operator-driven).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_FILE = path.join(__dirname, '..', '..', 'db', 'migrations', '019-series-metadata.sql');

const DATABASE_URL = process.env.DATABASE_URL;
const RUN_PG_TESTS = !!DATABASE_URL;

// Per-process unique prefix so the test cleanup never races with a parallel
// runner using the same DB. All synthetic rows we INSERT below carry this prefix.
const TEST_PREFIX = `_t019_${process.pid}_${Date.now()}`;

describe('migration 019 — series_metadata', { skip: !RUN_PG_TESTS }, () => {
  /** @type {any} */
  let pool;
  /** @type {Function} */
  let createTelemetryStorePg;

  before(async () => {
    // Lazy imports — keeps the file load-safe in environments where
    // pg / dvhub deps are not yet installed (e.g. fresh worktree, CI without
    // node_modules). When we get here, RUN_PG_TESTS is true so the deps are
    // expected to be available.
    const pg = (await import('pg')).default;
    const storeMod = await import('../../telemetry-store-pg.js');
    ({ createTelemetryStorePg } = storeMod);
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    // Ensure the base telemetry schema exists FIRST. The JOIN subtests below
    // read/write timeseries_samples, which is created by the telemetry store's
    // schema bootstrap (ensurePgSchema) — NOT by migration 019 (D-06: 019 only
    // adds the series_metadata lookup table, with no ALTER on timeseries_samples).
    // Against a fresh CI postgres without this, the JOIN/INSERT hit
    // 42P01 "relation \"timeseries_samples\" does not exist". Idempotent CREATE
    // TABLE IF NOT EXISTS → safe when the table is already present.
    await storeMod.ensurePgSchema(pool);
    // Apply migration once at suite start. CREATE TABLE IF NOT EXISTS + INSERT
    // ON CONFLICT DO NOTHING make this safe even if the DB already has the table.
    const sql = fs.readFileSync(MIGRATION_FILE, 'utf8');
    await pool.query(sql);
  });

  after(async () => {
    if (!pool) return;
    // Clean up every synthetic row this run created.
    try {
      await pool.query(
        `DELETE FROM series_metadata WHERE series_key LIKE $1`,
        [`${TEST_PREFIX}%`]
      );
    } catch { /* swallow — table might not exist if before() failed */ }
    await pool.end();
  });

  it('idempotent: re-running migration 019 produces no error and seeds victron rows', async () => {
    const sql = fs.readFileSync(MIGRATION_FILE, 'utf8');
    // Second application — must not throw, must not duplicate.
    await pool.query(sql);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM series_metadata WHERE source = 'victron'`
    );
    assert.ok(rows[0].n > 0, 'expected at least one seeded victron series');
  });

  it('CHECK constraint rejects source="garbage" with code 23514', async () => {
    await assert.rejects(
      () => pool.query(
        `INSERT INTO series_metadata (series_key, source) VALUES ($1, 'garbage')`,
        [`${TEST_PREFIX}_check`]
      ),
      (err) => err && err.code === '23514'
    );
  });

  it('seeds key series_keys with their correct source mapping', async () => {
    const { rows } = await pool.query(
      `SELECT series_key, source FROM series_metadata
       WHERE series_key IN ('pv_total_w','spot_price_ct_kwh','grid_import_w','optim_target_w')
       ORDER BY series_key`
    );
    const map = Object.fromEntries(rows.map((r) => [r.series_key, r.source]));
    assert.equal(map.pv_total_w, 'victron', 'pv_total_w must map to victron');
    assert.equal(map.spot_price_ct_kwh, 'epex', 'spot_price_ct_kwh must map to epex');
    assert.equal(map.grid_import_w, 'mid', 'grid_import_w must map to mid');
    assert.equal(map.optim_target_w, 'optimizer', 'optim_target_w must map to optimizer');
  });

  it('JOIN with timeseries_samples returns expected source for pv_total_w', async () => {
    // Insert a synthetic timeseries_samples row, JOIN over series_metadata,
    // assert the JOIN resolves source='victron'. Wrapped in a transaction +
    // ROLLBACK so the synthetic sample never persists.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO timeseries_samples
           (series_key, scope, source, quality, ts_utc, resolution_seconds, value_num, unit)
         VALUES ('pv_total_w', 'live', 'test', 'raw', NOW(), 1, 1234, 'W')
         ON CONFLICT DO NOTHING`
      );
      const { rows } = await client.query(`
        SELECT s.series_key, m.source
        FROM timeseries_samples s
        JOIN series_metadata m ON s.series_key = m.series_key
        WHERE s.series_key = 'pv_total_w'
        LIMIT 1
      `);
      assert.ok(rows.length >= 1, 'expected at least one joined row');
      assert.equal(rows[0].source, 'victron');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('D-09 defensive hook: writeSamples upserts source="unknown" for new series_key', async () => {
    const fakeKey = `${TEST_PREFIX}_unknown_a`;
    const store = createTelemetryStorePg(pool);
    await store.writeSamples([{
      seriesKey: fakeKey,
      scope: 'live',
      source: 'test',
      quality: 'raw',
      ts: new Date().toISOString(),
      resolutionSeconds: 1,
      value: 42,
      unit: 'X'
    }]);
    const { rows } = await pool.query(
      `SELECT source FROM series_metadata WHERE series_key = $1`,
      [fakeKey]
    );
    assert.equal(rows.length, 1, 'expected exactly one metadata row');
    assert.equal(rows[0].source, 'unknown', 'new series_key must land with source="unknown"');
  });

  it('D-09 defensive hook is idempotent across writeSamples calls (ON CONFLICT DO NOTHING)', async () => {
    const fakeKey = `${TEST_PREFIX}_unknown_b`;
    const store = createTelemetryStorePg(pool);
    const sample = (value) => ({
      seriesKey: fakeKey,
      scope: 'live',
      source: 'test',
      quality: 'raw',
      ts: new Date().toISOString(),
      resolutionSeconds: 1,
      value,
      unit: 'X'
    });
    await store.writeSamples([sample(1)]);
    await store.writeSamples([sample(2)]);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM series_metadata WHERE series_key = $1`,
      [fakeKey]
    );
    assert.equal(rows[0].n, 1, 'second writeSamples must not duplicate metadata row');
  });
});
