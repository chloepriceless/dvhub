// test/migrations/018-gated.test.js
//
// Phase 23-02 — migration 018 must be a clean NO-OP on a box WITHOUT the
// timescaledb extension instead of a crash.
//
// 018:41 historically called `remove_retention_policy('timeseries_samples',
// if_exists => TRUE)` RAW. remove_retention_policy is a TimescaleDB function —
// on stock Postgres it raises `function ... does not exist`, EVEN when the
// runner's timescaledb flag is false (018 has no runner-skip like 014). The fix
// wraps ONLY the remove_retention_policy call in a `DO $$` guard that checks the
// REAL extension state via pg_extension. The schema_migrations self-register
// INSERT stays UN-gated so 018 always records itself (no endless re-run on a
// timescaledb-less box).
//
// Ebene A (Source-Grep, runs always — dev has no Postgres): regression-locks the
//   guard + the surviving T-0078 strings + the INSERT-outside-guard position.
// Ebene B (DATABASE_URL-gated): runs 018 against a real Postgres WITHOUT the
//   timescaledb extension and asserts it is a no-op (does not throw). Skips
//   cleanly when DATABASE_URL is unset (docker/pg absent on dev).

import test from 'node:test';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIG_DIR = path.join(__dirname, '../../db/migrations');
const sql018 = fs.readFileSync(path.join(MIG_DIR, '018-extend-telemetry-retention.sql'), 'utf8');

// Strip line comments so a comment mentioning the call never trips the check.
// Verbatim from 014-no-retention.test.js (single source of the helper).
const stripComments = (s) => s.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

const active = stripComments(sql018);

test('023-02: 018 guards remove_retention_policy with a pg_extension DO $$ block', () => {
  assert.match(
    active,
    /pg_extension\s+WHERE\s+extname\s*=\s*'timescaledb'/i,
    '018 must guard the remove_retention_policy call on the real timescaledb extension state'
  );
});

test('023-02: 018 preserves the T-0078 remove_retention_policy string', () => {
  assert.match(
    active,
    /remove_retention_policy\s*\(\s*'timeseries_samples'/i,
    'the guarded PERFORM must still carry the T-0078 string (014-no-retention.test.js greps for it)'
  );
});

test('023-02: 018 preserves the idempotent if_exists => TRUE', () => {
  assert.match(
    active,
    /if_exists\s*=>\s*TRUE/i,
    '018 removal must stay idempotent (no-op when the policy was never added)'
  );
});

test('023-02: schema_migrations INSERT (18,...) stays OUTSIDE the DO $$ guard', () => {
  const guardEnd = active.indexOf('END $$');
  const insertAt = active.indexOf('VALUES (18');
  assert.ok(guardEnd > -1, '018 must contain a DO $$ ... END $$ guard block');
  assert.ok(insertAt > -1, '018 must self-register via INSERT ... VALUES (18, ...)');
  assert.ok(
    guardEnd < insertAt,
    'the schema_migrations INSERT must come AFTER END $$ (un-gated) so 018 always records itself'
  );
});

// Ebene B — integration no-op run against a real Postgres WITHOUT timescaledb.
// Skip-gated on DATABASE_URL; pg imported lazily so the file loads on a fresh
// checkout without node_modules (matches the 019-series-metadata.test.js posture).
// NEVER point DATABASE_URL at prod / the `dvhub` DB — use an EPHEMERAL empty PG.
const DATABASE_URL = process.env.DATABASE_URL;
const RUN_PG_TESTS = !!DATABASE_URL;

describe('migration 018 — no-op without timescaledb extension', { skip: !RUN_PG_TESTS }, () => {
  /** @type {any} */
  let pool;

  before(async () => {
    const pg = (await import('pg')).default;
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    // 018 references schema_migrations; ensure the minimal table exists so the
    // un-gated INSERT does not fail for an unrelated (missing-table) reason on a
    // bare ephemeral DB. CREATE IF NOT EXISTS keeps this safe on a primed DB.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     integer PRIMARY KEY,
        description text,
        applied_at  timestamptz NOT NULL DEFAULT NOW()
      )
    `);
  });

  after(async () => {
    if (pool) await pool.end();
  });

  it('runs 018 cleanly on a Postgres WITHOUT the timescaledb extension (no-op, no throw)', async () => {
    await assert.doesNotReject(
      () => pool.query(sql018),
      'on stock Postgres the pg_extension guard must skip remove_retention_policy → no crash'
    );
  });
});
