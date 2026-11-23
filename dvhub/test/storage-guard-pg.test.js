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
import { createStorageGuard, COMPRESSION_WARNING_ID } from '../services/storage-guard.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL014 = fs.readFileSync(path.join(HERE, '..', 'db', 'migrations', '014-timescaledb.sql'), 'utf8');
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
  await pool.query(`INSERT INTO energy_slots_15m (slot_start_utc, series_key, source_kind, quality, value_num)
    VALUES (to_timestamp($1::double precision / 1000), 'pv_total_w', 'live', 'raw', 1)`, [now - 2 * DAY]);
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
        } else {
          assert.ok(comp && !comp.error && comp.chunks > 0, JSON.stringify(comp));
          assert.equal(warn[COMPRESSION_WARNING_ID]?.m ?? null, null, 'Community mit Kompression: kein Hinweis');
          assert.equal(r.compression.ok, true);
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
        g.chooseProfile('winzig');
        const r = await g.check();
        const ret = r.actions.find((a) => a.action === 'retain_raw');
        assert.ok(ret && !ret.error, JSON.stringify(r.actions));
        const after = await counts(pool, 31 + 7);
        assert.equal(Number(after.live), 0, 'Live-Rohwerte jenseits 30 Tage + Block weg');
        assert.equal(after.price, before.price);
        assert.equal(after.import, before.import);
        // Nie jünger als der verdichtete Stand (energy_slots_15m: vor 2 Tagen).
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
