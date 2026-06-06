import test from 'node:test';
import assert from 'node:assert/strict';

import { ensurePgSchema } from '../telemetry-store-pg.js';

// T-0106 (incident 2026-06-06): ensurePgSchema's ownership-normalisation loop
// ("ALTER TABLE public.X OWNER TO current_user" for every public table not owned
// by the app user) MUST be non-fatal per table. ALTER OWNER requires being the
// table's owner/superuser; on a multi-owner DB a foreign (e.g. postgres-owned)
// table raises "must be owner of table X". Before the fix that single error
// aborted ensurePgSchema → telemetry store init threw → dbPool stayed null → the
// whole telemetry + forecast-store DB layer went dark after a restart.

function makeMockPool({ foreignTables = [], unownable = new Set() } = {}) {
  const altered = [];
  return {
    altered,
    async query(sql) {
      if (/SELECT\s+tablename\s+FROM\s+pg_tables/i.test(sql)) {
        return { rows: foreignTables.map((t) => ({ tablename: t })) };
      }
      const m = sql.match(/ALTER TABLE public\.(\w+) OWNER TO current_user/i);
      if (m) {
        if (unownable.has(m[1])) {
          throw new Error(`must be owner of table ${m[1]}`);
        }
        altered.push(m[1]);
        return { rows: [] };
      }
      // CREATE TABLE IF NOT EXISTS … and every other setup statement.
      return { rows: [] };
    },
  };
}

test('ensurePgSchema does NOT throw when an ownership ALTER fails on a foreign table (T-0106)', async () => {
  const pool = makeMockPool({
    foreignTables: ['victron_internals', 'good_table'],
    unownable: new Set(['victron_internals']),
  });
  // The whole point: a single un-ownable table must not abort schema init.
  await assert.doesNotReject(() => ensurePgSchema(pool));
  // It still re-owned the table it COULD own (best-effort preserved).
  assert.deepEqual(pool.altered, ['good_table']);
});

test('ensurePgSchema re-owns all foreign tables when permitted (happy path)', async () => {
  const pool = makeMockPool({ foreignTables: ['a_tbl', 'b_tbl'], unownable: new Set() });
  await assert.doesNotReject(() => ensurePgSchema(pool));
  assert.deepEqual(pool.altered.sort(), ['a_tbl', 'b_tbl']);
});

test('ensurePgSchema is a no-op for ownership when no foreign tables exist', async () => {
  const pool = makeMockPool({ foreignTables: [] });
  await assert.doesNotReject(() => ensurePgSchema(pool));
  assert.deepEqual(pool.altered, []);
});
