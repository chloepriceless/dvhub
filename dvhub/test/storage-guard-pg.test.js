// test/storage-guard-pg.test.js — Platz-Wache gegen eine echte TimescaleDB, je
// Edition (Kundenfall 23.11.2026: Apache-Box lief voll, weil compress_chunk die
// Wache abbrach und sie weder löschte noch warnte).
//
// Läuft nur mit DVHUB_TEST_PG_URL (Community) bzw. DVHUB_TEST_PG_URL_APACHE
// (Apache), sonst übersprungen — CI hat keine Datenbank. Lokal z. B.:
//   docker run -d --rm -p 127.0.0.1:55442:5432 -e POSTGRES_PASSWORD=x timescale/timescaledb:2.30.2-pg17
//   docker run -d --rm -p 127.0.0.1:55441:5432 -e POSTGRES_PASSWORD=x timescale/timescaledb:2.30.2-pg17 -c timescaledb.license=apache
//   DVHUB_TEST_PG_URL=postgres://postgres:x@127.0.0.1:55442/postgres \
//   DVHUB_TEST_PG_URL_APACHE=postgres://postgres:x@127.0.0.1:55441/postgres node --test test/storage-guard-pg.test.js
// Jeder Lauf legt eine eigene Datenbank an und entfernt sie danach.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { ensurePgSchema } from '../telemetry-store-pg.js';
import { ensureTierStorage } from '../services/telemetry-tiers.js';
import { createStorageGuard, COMPRESSION_WARNING_ID } from '../services/storage-guard.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL014 = fs.readFileSync(path.join(HERE, '..', 'db', 'migrations', '014-timescaledb.sql'), 'utf8');
const SQL027 = fs.readFileSync(path.join(HERE, '..', 'db', 'migrations', '027-telemetry-tiers.sql'), 'utf8');
const DAY = 86_400_000;

async function withFreshDb(url, fn) {
  const name = `sg_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const u = new URL(url); u.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: u.toString(), max: 3 });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
}

// Ein Live-Rohwert je Tag über 500 Tage, dazu Preise (live) und Altdaten (import).
async function seed(pool) {
  await ensurePgSchema(pool);
  await pool.query(SQL014);
  const now = Date.now();
  await pool.query(`INSERT INTO timeseries_samples (series_key, scope, source, quality, ts_utc, resolution_seconds, value_num)
    SELECT k, s, 'test', 'raw', to_timestamp($1::double precision / 1000) - g * INTERVAL '1 day', 5, g
      FROM generate_series(0, 500) g,
           (VALUES ('pv_total_w', 'live'), ('price_eur_mwh', 'live'), ('pv_total_w', 'import')) v(k, s)`, [now]);
  // Datenstufen (Migration 027): bis vor 2 Tagen sind 1-min- und 15-min-Werte vollständig.
  await pool.query(SQL027);
  await ensureTierStorage(pool);
  await pool.query("UPDATE telemetry_tier_state SET done_until = to_timestamp($1::double precision / 1000), started_from = to_timestamp($2::double precision / 1000) WHERE id = 'tiers'",
    [Math.floor((now - 2 * DAY) / 900_000) * 900_000, now - 501 * DAY]);
  // 1-min-Werte: einer je Tag über 500 Tage.
  await pool.query(`INSERT INTO timeseries_samples_1m (series_key, scope, source, bucket_ts, n, res_min, value_avg)
    SELECT 'pv_total_w', 'live', 'test', date_trunc('minute', to_timestamp($1::double precision / 1000) - g * INTERVAL '1 day'), 12, 5, g
      FROM generate_series(3, 500) g`, [now]);
}

const counts = async (pool, olderThanDays) => (await pool.query(`SELECT
    count(*) FILTER (WHERE scope = 'live' AND series_key = 'pv_total_w') AS live,
    count(*) FILTER (WHERE series_key LIKE 'price%') AS price,
    count(*) FILTER (WHERE scope = 'import') AS import
  FROM timeseries_samples WHERE ts_utc < now() - $1 * INTERVAL '1 day'`, [olderThanDays])).rows[0];

// 3 % frei → Stufe „kritisch“ (Notfall-Löschen; seit Schritt 3 erst dort).
const stat3 = () => ({ blocks: 1000, bsize: 1048576 * 3, bavail: 30 });

for (const [edition, url] of [['apache', process.env.DVHUB_TEST_PG_URL_APACHE], ['timescale', process.env.DVHUB_TEST_PG_URL]]) {
  test(`echte TimescaleDB (${edition}), kritisch wenig Platz: Hinweise stehen, alte Live-Rohwerte weg, Preise/Altdaten bleiben`,
    { skip: url ? false : `DVHUB_TEST_PG_URL${edition === 'apache' ? '_APACHE' : ''} nicht gesetzt` }, async () => {
      await withFreshDb(url, async (pool) => {
        const lic = (await pool.query("SELECT current_setting('timescaledb.license', true) AS l")).rows[0].l;
        assert.equal(lic, edition, 'richtige Instanz');
        await seed(pool);
        const before = await counts(pool, 366);
        assert.ok(Number(before.live) > 100);
        const warn = {}; const logs = [];
        const r = await createStorageGuard({
          getDb: () => pool, statfs: stat3,
          setWarning: (id, m, s) => { warn[id] = { m, s }; },
          pushLog: (e, d) => logs.push({ e, d }),
        }).check();
        assert.equal(r.level, 'kritisch');
        const comp = r.actions.find((a) => a.action === 'compress');
        const drop = r.actions.find((a) => a.action === 'drop_raw');
        assert.ok(drop && !drop.error, JSON.stringify(r.actions));
        assert.equal(drop.keepDays, 365);
        // drop_chunks arbeitet blockweise (014: 7-Tage-Blöcke) — jenseits der Blockgrenze ist alles weg.
        assert.equal(Number((await counts(pool, 365 + 7)).live), 0, 'Live-Rohwerte älter als 365 Tage entfernt');
        const after = await counts(pool, 366);
        assert.ok(Number(after.live) < 7, `höchstens der Block über der Grenze bleibt: ${after.live}`);
        assert.equal(after.price, before.price, 'Preise bleiben');
        assert.equal(after.import, before.import, 'Altdaten bleiben');
        assert.match(warn.storage.m, /Speicher kritisch/);
        if (edition === 'apache') {
          assert.equal(comp, undefined, 'kein compress_chunk unter Apache');
          assert.equal(warn[COMPRESSION_WARNING_ID].s, 'error');
          assert.match(warn[COMPRESSION_WARNING_ID].m, /Datenbank ohne Kompression: TimescaleDB läuft in der Apache-Edition/);
          assert.ok(logs.some((l) => l.e === 'storage_compression_failed'));
          assert.ok(Number.isFinite(r.db.samplesMb), 'hypertable_size geht auch unter Apache');
          assert.ok(Number.isFinite(r.db.tables.timeseries_samples_1m), JSON.stringify(r.db.tables));
          assert.equal(r.db.chunks, null);
        } else {
          assert.ok(comp && !comp.error && comp.chunks > 0, JSON.stringify(comp));
          assert.equal(warn[COMPRESSION_WARNING_ID]?.m ?? null, null, 'Community mit Kompression: kein Hinweis');
          assert.equal(r.compression.ok, true);
          // Karte „Speicher“: Aufteilung aus echten TimescaleDB-Funktionen.
          assert.ok(Number.isFinite(r.db.samplesMb), JSON.stringify(r.db));
          assert.ok(r.db.chunks > 0 && r.db.compressedChunks > 0, JSON.stringify(r.db));
          assert.ok('energy_slots_15m' in r.db.tables);
          assert.ok(Number.isFinite(r.db.tables.timeseries_samples_1m) && Number.isFinite(r.db.tables.timeseries_samples_15m), JSON.stringify(r.db.tables));
        }
      });
    });
}

test('echte TimescaleDB (timescale): pausierter Kompressions-Job → Hinweis „pausiert“ (Codex 949b20f2)',
  { skip: process.env.DVHUB_TEST_PG_URL ? false : 'DVHUB_TEST_PG_URL nicht gesetzt' }, async () => {
    await withFreshDb(process.env.DVHUB_TEST_PG_URL, async (pool) => {
      await seed(pool);
      const warn = {};
      const g = createStorageGuard({ getDb: () => pool, setWarning: (id, m) => { warn[id] = m; } });
      await g.checkCompression();
      assert.equal(warn[COMPRESSION_WARNING_ID] ?? null, null, 'Regel aus 014 eingeplant');
      await pool.query(`SELECT alter_job(job_id, scheduled => false) FROM timescaledb_information.jobs
        WHERE proc_name = 'policy_compression' AND hypertable_name = 'timeseries_samples'`);
      await g.checkCompression();
      assert.match(warn[COMPRESSION_WARNING_ID], /nicht eingerichtet oder pausiert/);
    });
  });

for (const [edition, url] of [['apache', process.env.DVHUB_TEST_PG_URL_APACHE], ['timescale', process.env.DVHUB_TEST_PG_URL]]) {
  test(`echte TimescaleDB (${edition}): Profil „winzig“ entfernt 5-s-Rohwerte älter als 30 Tage, Preise/Altdaten bleiben`,
    { skip: url ? false : 'DB-URL nicht gesetzt' }, async () => {
      await withFreshDb(url, async (pool) => {
        await seed(pool);
        const before = await counts(pool, 31 + 7);
        const g = createStorageGuard({ getDb: () => pool, statfs: () => ({ blocks: 100000, bsize: 1048576, bavail: 90000 }),
          initialProfile: 'winzig', profileIo: { writeFile() {}, rename() {} } });
        g.chooseProfile('winzig');   // stößt selbst einen Lauf an
        for (let i = 0; i < 400 && !g.status()?.actions; i++) await new Promise((res) => setTimeout(res, 10));
        const r = g.status();
        const ret = r.actions.find((a) => a.action === 'retain_raw');
        assert.ok(ret && !ret.error, JSON.stringify(r.actions));
        const after = await counts(pool, 31 + 7);
        assert.equal(Number(after.live), 0, 'Live-Rohwerte jenseits 30 Tage + Block weg');
        assert.equal(after.price, before.price);
        assert.equal(after.import, before.import);
        // Nie jünger als der verdichtete Stand (Datenstufen: vor 2 Tagen).
        assert.ok(Number((await counts(pool, 3)).live) > 20, 'jüngere Rohwerte bleiben');
      });
    });
}

test('echte TimescaleDB (timescale): tuneTimescale mit Profil „klein“ — 12-h-Blöcke, Kompression nach 12 h, Lauf alle 2 h',
  { skip: process.env.DVHUB_TEST_PG_URL ? false : 'DVHUB_TEST_PG_URL nicht gesetzt' }, async () => {
    const { tuneTimescale } = await import('../services/db-tuning.js');
    const { PROFILES } = await import('../services/storage-profile.js');
    await withFreshDb(process.env.DVHUB_TEST_PG_URL, async (pool) => {
      await seed(pool);
      const q = (s, p) => pool.query(s, p);
      const r = await tuneTimescale(q, PROFILES.klein);
      assert.deepEqual(r.changed.sort(), ['chunk_interval', 'compress_after', 'compress_schedule']);
      const again = await tuneTimescale(q, PROFILES.klein);
      assert.deepEqual(again.changed, [], 'idempotent');
      const j = (await pool.query(`SELECT extract(epoch FROM schedule_interval)::bigint AS s, (config->>'compress_after')::interval AS a
        FROM timescaledb_information.jobs WHERE proc_name = 'policy_compression' AND hypertable_name = 'timeseries_samples'`)).rows[0];
      assert.equal(Number(j.s), 7200);
      const d = (await pool.query(`SELECT extract(epoch FROM time_interval)::bigint AS s FROM timescaledb_information.dimensions
        WHERE hypertable_name = 'timeseries_samples'`)).rows[0];
      assert.equal(Number(d.s), 43200);
      const back = await tuneTimescale(q, PROFILES.gross);
      assert.ok(back.changed.includes('compress_after') && back.changed.includes('chunk_interval'));
    });
  });

for (const [edition, url] of [['apache', process.env.DVHUB_TEST_PG_URL_APACHE], ['timescale', process.env.DVHUB_TEST_PG_URL]]) {
  test(`echte TimescaleDB (${edition}): 1-min-Stufe nach Profil gekürzt (D1 a, E3 b)`,
    { skip: url ? false : 'DB-URL nicht gesetzt' }, async () => {
      await withFreshDb(url, async (pool) => {
        await seed(pool);
        const g = createStorageGuard({ getDb: () => pool, statfs: () => ({ blocks: 100000, bsize: 1048576, bavail: 90000 }),
          initialProfile: 'klein', profileIo: { writeFile() {}, rename() {} } });
        g.chooseProfile('klein');
        for (let i = 0; i < 400 && !g.status()?.actions; i++) await new Promise((res) => setTimeout(res, 10));
        const r = g.status();
        const keep = edition === 'apache' ? 90 : 365;   // Apache: ohne Kompression → 90 Tage (E3 b)
        assert.equal(r.profile.effective, edition === 'apache' ? 'winzig' : 'klein');
        const old = Number((await pool.query(
          `SELECT count(*) AS n FROM timeseries_samples_1m WHERE bucket_ts < now() - ($1 + 2) * INTERVAL '1 day'`, [keep])).rows[0].n);
        assert.equal(old, 0, `1-min-Werte älter als ${keep} Tage (+ Block) weg: ${JSON.stringify(r.actions)}`);
        const kept = Number((await pool.query(
          `SELECT count(*) AS n FROM timeseries_samples_1m WHERE bucket_ts > now() - ($1 - 2) * INTERVAL '1 day'`, [keep])).rows[0].n);
        assert.ok(kept > keep - 10, 'jüngere 1-min-Werte bleiben');
      });
    });
}

// E2E „kleine Platte“ S3 (24.11.): reines PostgreSQL (DVHUB_TEST_PG_URL_PLAIN, ohne TimescaleDB).
test('reines PostgreSQL: Hinweis „ohne Kompression“, Löschen gibt den Platz innerhalb der DB frei (VACUUM)',
  { skip: process.env.DVHUB_TEST_PG_URL_PLAIN ? false : 'DVHUB_TEST_PG_URL_PLAIN nicht gesetzt' }, async () => {
    await withFreshDb(process.env.DVHUB_TEST_PG_URL_PLAIN, async (pool) => {
      await ensurePgSchema(pool);
      await pool.query(SQL027);
      const now = Date.now();
      await pool.query("UPDATE telemetry_tier_state SET done_until = to_timestamp($1::double precision / 1000) WHERE id = 'tiers'", [now - 2 * DAY]);
      // ~100 000 alte Live-Rohwerte (älter als 365 Tage) + junge.
      await pool.query(`INSERT INTO timeseries_samples (series_key, scope, source, quality, ts_utc, resolution_seconds, value_num)
        SELECT 'grid_total_w', 'live', 'test', 'raw', to_timestamp($1::double precision / 1000) - (400 * INTERVAL '1 day') - g * INTERVAL '5 seconds', 5, g
          FROM generate_series(1, 100000) g`, [now]);
      // Junge Zeilen dahinter (wie im Betrieb) — sonst schneidet VACUUM die leere Tabelle einfach ab.
      await pool.query(`INSERT INTO timeseries_samples (series_key, scope, source, quality, ts_utc, resolution_seconds, value_num)
        SELECT 'grid_total_w', 'live', 'test', 'raw', to_timestamp($1::double precision / 1000) - (3 * INTERVAL '1 day') - g * INTERVAL '5 seconds', 5, g
          FROM generate_series(1, 20000) g`, [now]);
      const sizeBefore = Number((await pool.query("SELECT pg_relation_size('timeseries_samples') AS b")).rows[0].b);
      const warn = {};
      const r = await createStorageGuard({ getDb: () => pool, statfs: () => ({ blocks: 1000, bsize: 1048576 * 3, bavail: 30 }),
        setWarning: (id, m) => { warn[id] = m; } }).check();
      assert.equal(r.compression.ok, false);
      assert.equal(r.compression.reason, 'no_timescaledb');
      assert.match(warn[COMPRESSION_WARNING_ID], /TimescaleDB ist nicht installiert/);
      const del = r.actions.find((a) => a.mode === 'delete' && !a.error);
      assert.ok(del && del.rows > 0 && del.vacuumed, JSON.stringify(r.actions));
      const st = (await pool.query("SELECT last_vacuum FROM pg_stat_user_tables WHERE relname = 'timeseries_samples'")).rows[0];
      assert.ok(st.last_vacuum, 'VACUUM gelaufen');
      // Neue Zeilen nutzen den frei gewordenen Platz: die Tabelle wächst nicht über den Stand vor dem Löschen.
      await pool.query(`INSERT INTO timeseries_samples (series_key, scope, source, quality, ts_utc, resolution_seconds, value_num)
        SELECT 'grid_total_w', 'live', 'test', 'raw', now() - g * INTERVAL '5 seconds', 5, g FROM generate_series(1, 50000) g`);
      const after = Number((await pool.query("SELECT pg_relation_size('timeseries_samples') AS b")).rows[0].b);
      assert.ok(after <= sizeBefore, `wiederverwendet: ${sizeBefore} → ${after}`);
    });
  });
