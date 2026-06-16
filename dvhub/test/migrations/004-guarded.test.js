// test/migrations/004-guarded.test.js
//
// T-0224 fresh-install finding — migration 004 must be ORDER-INDEPENDENT and
// idempotent. pv_forecasts / forecast_accuracy are created lazily by
// forecast-store.js (after the migration runner runs), so on a FRESH install
// 004 reached `ALTER TABLE pv_forecasts …` before the table existed → 42P01 →
// the whole 004 transaction aborted, v4 never registered, and the
// tesla_snapshots block never ran. Fix: every ALTER is wrapped in an
// information_schema table-existence + pg_constraint constraint-existence DO-
// block guard (like 018's pg_extension guard) → no-op when absent/already-
// constrained, safe retrofit otherwise, ALWAYS registers v4.
//
// Ebene A (Source-Grep, runs always — dev has no Postgres): regression-locks
//   that NO raw top-level ALTER on pv_forecasts/forecast_accuracy survives, that
//   both tables are existence-guarded, and that v4 self-registers.
// Ebene B (DATABASE_URL-gated): runs 004 against a real Postgres where those
//   tables do NOT exist and asserts it is a clean no-op AND registers v4. Skips
//   cleanly when DATABASE_URL is unset. NEVER point it at prod / the `dvhub` DB.

import test from 'node:test';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIG_DIR = path.join(__dirname, '../../db/migrations');
const sql004 = fs.readFileSync(path.join(MIG_DIR, '004-check-constraints.sql'), 'utf8');

// Strip line comments so a comment never trips the checks (verbatim helper).
const stripComments = (s) => s.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const active = stripComments(sql004);

test('023/T-0224: 004 has NO raw top-level ALTER on pv_forecasts/forecast_accuracy', () => {
  // After the fix every ALTER lives inside an EXECUTE '...' string within a
  // guarded DO-block, so a bare statement-start `ALTER TABLE pv_forecasts` (or
  // forecast_accuracy) must NOT appear — that raw form is what crashed fresh DBs.
  assert.doesNotMatch(
    active,
    /(^|\n)\s*ALTER\s+TABLE\s+(pv_forecasts|forecast_accuracy)\b/i,
    'pv_forecasts/forecast_accuracy ALTERs must be guarded inside DO-blocks, not raw'
  );
});

test('023/T-0224: 004 existence-guards pv_forecasts before altering it', () => {
  assert.match(active, /information_schema\.tables/i);
  assert.match(active, /table_name\s*=\s*'pv_forecasts'/i,
    '004 must check pv_forecasts exists before adding its constraint (ordering-safe)');
  assert.match(active, /table_name\s*=\s*'forecast_accuracy'/i,
    '004 must check forecast_accuracy exists before adding its constraints');
});

test('023/T-0224: 004 is idempotent via pg_constraint existence checks', () => {
  assert.match(active, /pg_constraint\s+WHERE\s+conname\s*=\s*'pv_forecasts_confidence_range'/i,
    '004 must skip the constraint if it already exists (safe retrofit / re-run)');
});

test('023/T-0224: 004 always self-registers v4 in schema_migrations', () => {
  assert.match(active, /INSERT\s+INTO\s+schema_migrations/i);
  assert.match(active, /VALUES\s*\(\s*4\s*,/i,
    '004 must record version 4 so it is no longer a permanent no-show on fresh DBs');
});

// Ebene B — integration no-op run against a real Postgres where the target
// tables do NOT exist. Proves the ordering fix. Skip-gated on DATABASE_URL; pg
// imported lazily. NEVER point DATABASE_URL at prod / the `dvhub` DB.
const DATABASE_URL = process.env.DATABASE_URL;
const RUN_PG_TESTS = !!DATABASE_URL;

describe('migration 004 — no-op when forecast tables are absent (fresh-install order)', { skip: !RUN_PG_TESTS }, () => {
  /** @type {any} */
  let pool;

  before(async () => {
    const pg = (await import('pg')).default;
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     integer PRIMARY KEY,
        description text,
        applied_at  timestamptz NOT NULL DEFAULT NOW()
      )
    `);
    // Simulate the fresh-install order: forecast tables NOT yet created.
    await pool.query('DROP TABLE IF EXISTS pv_forecasts, forecast_accuracy, tesla_snapshots CASCADE');
    await pool.query('DELETE FROM schema_migrations WHERE version = 4');
  });

  after(async () => {
    if (pool) await pool.end();
  });

  it('runs 004 cleanly when pv_forecasts/forecast_accuracy do not exist (no throw)', async () => {
    await assert.doesNotReject(
      () => pool.query(sql004),
      'the table-existence guards must skip the ALTERs → no 42P01 crash on a fresh DB'
    );
  });

  it('registers version 4 even when the forecast tables were absent', async () => {
    const r = await pool.query('SELECT 1 FROM schema_migrations WHERE version = 4');
    assert.equal(r.rowCount, 1, '004 must self-register v4 regardless of table presence');
  });
});
