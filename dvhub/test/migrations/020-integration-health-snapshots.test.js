// test/migrations/020-integration-health-snapshots.test.js
//
// Phase 09.2 Plan 02 — integration tests for migration 020.
//
// Verifies that `dvhub/db/migrations/020-integration-health-snapshots.sql`:
//   1. Creates `integration_health_snapshots` with the documented shape
//      (system TEXT PRIMARY KEY, snapshot_jsonb JSONB NOT NULL,
//       taken_at TIMESTAMPTZ NOT NULL DEFAULT now()).
//   2. Picks up `system` as the PRIMARY KEY (the bound on row growth).
//   3. Is idempotent — re-running the SQL leaves exactly one
//      schema_migrations row for version 20.
//   4. Honours UPSERT semantics: two writes to the same `system` via
//      `INSERT … ON CONFLICT (system) DO UPDATE` yield exactly one row
//      with the latest payload (D-02 mitigation for T-09.2-DOS-DISK).
//   5. Rejects a plain duplicate INSERT (no ON CONFLICT) with
//      Postgres error code `23505` (unique_violation) — proves the
//      PRIMARY KEY is what bounds the table.
//
// Tests skip cleanly when DATABASE_URL is unset so `npm test` (which
// runs without a live Postgres in CI) is unaffected.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQL_PATH = path.join(__dirname, '../../db/migrations/020-integration-health-snapshots.sql');

const DATABASE_URL = process.env.DATABASE_URL;
const RUN_PG_TESTS = !!DATABASE_URL;

describe('migration 020 — integration_health_snapshots', { skip: !RUN_PG_TESTS }, () => {
  let pool;

  before(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    // Make sure schema_migrations exists — every migration self-registers
    // into it. ensurePgSchema() in production wires this up; here we
    // create the minimal shape so the test doesn't depend on boot order.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const sql = fs.readFileSync(SQL_PATH, 'utf8');
    await pool.query(sql);
  });

  after(async () => {
    if (pool) await pool.end();
  });

  it('table exists with expected columns', async () => {
    const { rows } = await pool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'integration_health_snapshots'
      ORDER BY column_name
    `);
    const cols = Object.fromEntries(rows.map(r => [r.column_name, r]));
    assert.ok(cols.system, 'system column exists');
    assert.equal(cols.system.data_type, 'text');
    assert.equal(cols.system.is_nullable, 'NO');
    assert.ok(cols.snapshot_jsonb, 'snapshot_jsonb column exists');
    assert.equal(cols.snapshot_jsonb.data_type, 'jsonb');
    assert.equal(cols.snapshot_jsonb.is_nullable, 'NO');
    assert.ok(cols.taken_at, 'taken_at column exists');
    assert.equal(cols.taken_at.data_type, 'timestamp with time zone');
    assert.equal(cols.taken_at.is_nullable, 'NO');
  });

  it('PRIMARY KEY is system', async () => {
    const { rows } = await pool.query(`
      SELECT a.attname
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'integration_health_snapshots'::regclass
        AND i.indisprimary
    `);
    assert.deepEqual(rows.map(r => r.attname), ['system']);
  });

  it('idempotent re-run', async () => {
    const sql = fs.readFileSync(SQL_PATH, 'utf8');
    await pool.query(sql); // second run — must not throw
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM schema_migrations WHERE version = 20`
    );
    assert.equal(rows[0].n, 1);
  });

  it('UPSERT semantics: two writes for same system → 1 row', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        INSERT INTO integration_health_snapshots (system, snapshot_jsonb, taken_at)
        VALUES ('_t_victron', '{"version":1,"latencyMs":12}'::jsonb, NOW())
        ON CONFLICT (system) DO UPDATE
          SET snapshot_jsonb = EXCLUDED.snapshot_jsonb, taken_at = EXCLUDED.taken_at
      `);
      await client.query(`
        INSERT INTO integration_health_snapshots (system, snapshot_jsonb, taken_at)
        VALUES ('_t_victron', '{"version":1,"latencyMs":17}'::jsonb, NOW())
        ON CONFLICT (system) DO UPDATE
          SET snapshot_jsonb = EXCLUDED.snapshot_jsonb, taken_at = EXCLUDED.taken_at
      `);
      const { rows } = await client.query(
        `SELECT (snapshot_jsonb->>'latencyMs')::int AS lat
         FROM integration_health_snapshots
         WHERE system = '_t_victron'`
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].lat, 17);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('plain duplicate INSERT (no ON CONFLICT) fails with unique_violation', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        INSERT INTO integration_health_snapshots (system, snapshot_jsonb)
        VALUES ('_t_dup', '{"version":1}'::jsonb)
      `);
      await assert.rejects(
        client.query(`
          INSERT INTO integration_health_snapshots (system, snapshot_jsonb)
          VALUES ('_t_dup', '{"version":1}'::jsonb)
        `),
        (err) => err.code === '23505'
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
