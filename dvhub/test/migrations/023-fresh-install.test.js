// test/migrations/023-fresh-install.test.js
//
// Phase 23-01 — Frischinstall-Crash-Quelle #1: install.sh kopiert
// config.example.json 1:1 zur Live-config.json. Dort steuert
// telemetry.database.timescaledb den EINZIGEN Runner-Skip in
// telemetry-store-pg.js (`!== true` → 014-timescaledb.sql wird übersprungen).
// Steht der Default auf true, läuft Migration 014 auf der Frischbox und
// scheitert sofort an `CREATE EXTENSION IF NOT EXISTS timescaledb` (das Paket
// installiert install.sh nie). Default muss false sein → 014 sauber skippen.
//
// Ebene A (läuft IMMER, kein DB): JSON-Parse von config.example.json und
//   assert, dass telemetry.database.timescaledb === false (Frischinstall-Default).
//   Imports/__dirname-Auflösung verbatim aus 014-no-retention.test.js.
// Ebene B ({ skip: !DATABASE_URL }): Integration gegen eine EPHEMERE leere PG —
//   NIE prod/`dvhub`-DB. runPendingMigrations(pool, {timescaledb:false}) wirft
//   nicht, und 014 fehlt danach in schema_migrations (version = 14). Skeleton
//   (lazy pg-import, Per-PID-Prefix, before/after pool.end) aus
//   019-series-metadata.test.js. Auf dev sind docker/pg_isready nicht vorhanden
//   — ohne DATABASE_URL skippt Ebene B sauber.

import test, { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '..', '..', 'config.example.json');

// ---------------------------------------------------------------------------
// Ebene A — Default-Assert (kein DB nötig, läuft immer in npm test)
// ---------------------------------------------------------------------------

const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

test('Frischinstall-Default: telemetry.database.timescaledb === false', () => {
  assert.equal(
    CONFIG?.telemetry?.database?.timescaledb,
    false,
    'config.example.json muss timescaledb:false seeden, sonst crasht Migration 014 ' +
    'auf der Frischbox an CREATE EXTENSION timescaledb (Paket wird nie installiert)'
  );
});

test('config.example.json bleibt valides JSON mit telemetry.database-Block', () => {
  assert.ok(CONFIG.telemetry, 'telemetry-Block muss existieren');
  assert.ok(CONFIG.telemetry.database, 'telemetry.database-Block muss existieren');
  assert.equal(
    typeof CONFIG.telemetry.database.timescaledb,
    'boolean',
    'timescaledb muss ein boolean bleiben (Runner-Skip liest !== true)'
  );
});

// ---------------------------------------------------------------------------
// Ebene B — Integration gegen ephemere leere PG (DATABASE_URL-gated)
// ---------------------------------------------------------------------------
//
// Skip-gated wenn DATABASE_URL nicht gesetzt ist (dev/CI ohne Postgres). pg-Driver
// und der telemetry-store werden lazy in before() importiert, damit die Datei auf
// frischen Checkouts (ohne node_modules) load-safe bleibt — gleiche Posture wie
// 019-series-metadata.test.js. NIEMALS gegen die prod-`dvhub`-DB laufen lassen.

const DATABASE_URL = process.env.DATABASE_URL;
const RUN_PG_TESTS = !!DATABASE_URL;

// Per-Prozess-eindeutiger Prefix, damit Cleanup nie mit einem parallelen Runner
// auf derselben DB rennt.
const TEST_PREFIX = `_t023_${process.pid}_${Date.now()}`;

describe('Phase 23-01 — Frischinstall-Migrationslauf (timescaledb:false skippt 014)', { skip: !RUN_PG_TESTS }, () => {
  /** @type {any} */
  let pool;
  /** @type {Function} */
  let runPendingMigrations;

  before(async () => {
    // Lazy imports — load-safe ohne node_modules. Hier ist RUN_PG_TESTS true,
    // also sind die deps erwartbar verfügbar.
    const pg = (await import('pg')).default;
    ({ runPendingMigrations } = await import('../../telemetry-store-pg.js'));
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });

  after(async () => {
    if (!pool) return;
    await pool.end();
  });

  it('runPendingMigrations(pool, {timescaledb:false}) wirft nicht und überspringt 014', async () => {
    await assert.doesNotReject(
      () => runPendingMigrations(pool, { telemetry: { database: { timescaledb: false } } }),
      'Migrationskette muss mit timescaledb:false sauber durchlaufen (014 skip statt CREATE-EXTENSION-Crash)'
    );

    // 014 darf nicht angewendet worden sein → kein schema_migrations-Eintrag für version 14.
    const { rows } = await pool.query(
      'SELECT 1 FROM schema_migrations WHERE version = 14'
    );
    assert.equal(
      rows.length,
      0,
      'Migration 014 (TimescaleDB) muss bei timescaledb:false übersprungen werden — kein schema_migrations-Eintrag erwartet'
    );
  });
});
