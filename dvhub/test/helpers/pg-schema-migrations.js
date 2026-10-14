// test/helpers/pg-schema-migrations.js — schema_migrations für PG-Migrations-
// tests anlegen, auch wenn mehrere Testdateien gleichzeitig laufen (2026-10-15).
//
// Paralleles `CREATE TABLE IF NOT EXISTS` in derselben Datenbank kann trotz
// IF NOT EXISTS mit `duplicate key value violates unique constraint
// "pg_type_typname_nsp_index"` scheitern (CI pg-integration, df87269f). Eine
// Advisory-Sperre in der Transaktion macht das Anlegen nacheinander. Eine
// Form für alle Tests: vorher legte die zuerst laufende Datei ihre Variante an.

const LOCK_KEY = 4_711_018;

export async function ensureSchemaMigrations(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     integer PRIMARY KEY,
        description text,
        applied_at  timestamptz NOT NULL DEFAULT NOW()
      )
    `);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
