// test/migrations/021-inverter-efficiency-daily.test.js
//
// Migration 021 — Tagesaggregat Wechselrichter-Wirkungsgrad (Christin 2026-09-27).
//
// Ebene A (läuft immer, keine DB): die SQL-Datei legt die Tabelle mit
//   PRIMARY KEY (day, bucket), der Bucket-Prüfung und dem schema_migrations-
//   Eintrag 21 in einer Transaktion an.
// Ebene B ({ skip: !DATABASE_URL }): gegen eine EPHEMERE PG — nie prod —
//   idempotent anwendbar, UPSERT überschreibt statt zu duplizieren, unbekannte
//   Buckets werden abgewiesen.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { UPSERT_EFFICIENCY_SQL } from '../../services/inverter-efficiency/daily.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQL_PATH = path.join(__dirname, '../../db/migrations/021-inverter-efficiency-daily.sql');
const DATABASE_URL = process.env.DATABASE_URL;

describe('migration 021 — statisch', () => {
  const sql = fs.readFileSync(SQL_PATH, 'utf8');
  it('legt die Tabelle mit Tages-/Bereichs-Schlüssel an', () => {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS inverter_efficiency_daily/);
    assert.match(sql, /PRIMARY KEY \(day, bucket\)/);
    assert.match(sql, /CHECK \(bucket IN \('base', 'full'\)\)/);
  });
  it('registriert sich als Version 21 in einer Transaktion', () => {
    assert.match(sql, /^BEGIN;/m);
    assert.match(sql, /VALUES \(21,/);
    assert.match(sql, /ON CONFLICT \(version\) DO NOTHING/);
    assert.match(sql, /^COMMIT;/m);
  });
});

describe('migration 021 — gegen Postgres', { skip: !DATABASE_URL }, () => {
  let pool;
  before(async () => {
    const pg = (await import('pg')).default;
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, description TEXT, applied_at TIMESTAMPTZ)`);
    await pool.query('DROP TABLE IF EXISTS inverter_efficiency_daily');
    await pool.query('DELETE FROM schema_migrations WHERE version = 21');
  });
  after(async () => {
    if (!pool) return;
    await pool.query('DROP TABLE IF EXISTS inverter_efficiency_daily');
    await pool.query('DELETE FROM schema_migrations WHERE version = 21');
    await pool.end();
  });

  it('ist idempotent', async () => {
    const sql = fs.readFileSync(SQL_PATH, 'utf8');
    await pool.query(sql);
    await pool.query(sql);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM schema_migrations WHERE version = 21');
    assert.equal(rows[0].n, 1);
  });

  it('UPSERT überschreibt den Tag statt ihn zu verdoppeln', async () => {
    await pool.query(UPSERT_EFFICIENCY_SQL, ['2026-09-26', 'full', 1, 2, 3, 4, 24000]);
    await pool.query(UPSERT_EFFICIENCY_SQL, ['2026-09-26', 'full', 58088, 65413, 9828, 1907, 24000]);
    const { rows } = await pool.query(
      "SELECT ac_wh, samples FROM inverter_efficiency_daily WHERE day = '2026-09-26' AND bucket = 'full'");
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].ac_wh), 58088);
    assert.equal(rows[0].samples, 1907);
  });

  it('weist unbekannte Bereiche ab', async () => {
    await assert.rejects(
      pool.query(UPSERT_EFFICIENCY_SQL, ['2026-09-26', 'mid', 1, 1, 1, 1, 24000]),
      (e) => e.code === '23514'
    );
  });
});
