// test/migrations/014-no-retention.test.js
//
// T-0078 (P0-4): migration 014 must NOT install a chunk-dropping retention policy.
// A 45-day add_retention_policy in 014 dropped granular telemetry chunks
// permanently (NEVER-DELETE-DATA violation). On a fresh DB that ran 014 but
// failed/stalled before migration 018 (which removes it), the dropping policy
// would be live in the meantime. The fix removes the add at the source: a fresh DB
// never creates the policy; 018 stays as an idempotent no-op for existing DBs.
//
// Pure source-content assertions (no DB required) — they regression-lock the fix
// itself. The downstream "no retention policy exists on a fresh TimescaleDB" is a
// deploy-time observation (dev has no Postgres/TimescaleDB).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIG_DIR = path.join(__dirname, '../../db/migrations');
const sql014 = fs.readFileSync(path.join(MIG_DIR, '014-timescaledb.sql'), 'utf8');
const sql018 = fs.readFileSync(path.join(MIG_DIR, '018-extend-telemetry-retention.sql'), 'utf8');

// Strip line comments so a comment mentioning the old policy never trips the check.
const stripComments = (s) => s.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

test('T-0078: migration 014 does NOT add a retention (chunk-dropping) policy', () => {
  assert.doesNotMatch(
    stripComments(sql014),
    /add_retention_policy/i,
    '014 must not install a chunk-dropping retention policy (NEVER-DELETE-DATA)'
  );
});

test('T-0078: migration 014 still installs the compression policy (unbroken)', () => {
  assert.match(stripComments(sql014), /add_compression_policy/i,
    'compression policy must remain — it is what keeps indefinite retention cheap');
});

test('T-0078: migration 014 schema_migrations description no longer claims retention', () => {
  const valuesLine = sql014.split('\n').find((l) => /VALUES\s*\(\s*14\s*,/i.test(l)) || '';
  assert.ok(valuesLine, '014 must self-register into schema_migrations (VALUES (14, ...))');
  // The stale claim was "+ 45d retention"; "no retention: T-0078" is fine.
  assert.doesNotMatch(valuesLine, /\d+\s*d(ay)?s?\s*retention/i,
    '014 description must not advertise an active (N-day) retention policy');
});

test('T-0078: migration 018 still removes the policy idempotently (existing-DB safety net)', () => {
  const active018 = stripComments(sql018);
  assert.match(active018, /remove_retention_policy\s*\(\s*'timeseries_samples'/i,
    '018 must still remove the policy for DBs that already ran the old 014');
  assert.match(active018, /if_exists\s*=>\s*TRUE/i,
    '018 removal must be idempotent (no-op when the policy was never added)');
});
