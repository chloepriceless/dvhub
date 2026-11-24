// test/timescale-docker.test.js — DVhub gegen eine ECHTE TimescaleDB (Docker).
//
// Anlass 21.10.2026: Die CI prüfte die Datenbank nur gegen nacktes Postgres 16.
// Alles, was im Feld schiefging, lag aber in TimescaleDB selbst: Migration 014
// überspringt unter der Apache-Lizenz Kompression und Continuous Aggregates; nach
// der Nachrüstung auf Community fehlte die Kompression (tuneTimescale wollte eine
// Richtlinie ohne eingeschaltete Kompression anlegen → „columnstore not enabled“).
//
// Die Lizenz lässt sich nur beim Serverstart setzen („Cannot change a license in
// a running session“, auch nicht per ALTER DATABASE). Der Test startet darum
// selbst Container: erst mit timescaledb.license=apache, dann Community auf
// DEMSELBEN Volume — so wie eine Box, deren Paket gewechselt wurde.
//
// Läuft nur, wenn DVHUB_TS_IMAGE gesetzt ist (CI-Job timescale-docker, lokal
// z. B. DVHUB_TS_IMAGE=timescale/timescaledb:2.30.2-pg17 mit Colima/Docker).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { ensurePgSchema, runPendingMigrations, createTelemetryStorePg } from '../telemetry-store-pg.js';
import { tuneTimescale } from '../services/db-tuning.js';
import { createTelemetryTiers, ensureTierStorage, aggregatedUntil, pruneOneMinuteTier, floorQuarterMs } from '../services/telemetry-tiers.js';

const IMAGE = process.env.DVHUB_TS_IMAGE || '';
const PASSWORD = 'dvhub-ci';
const TS_CFG = { telemetry: { database: { timescaledb: true } } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const tag = `dvhub-tsdocker-${process.pid}`;
const started = [];
let volume = null;

/** Jeder Fall auf eigenem Volume; Container und Volume werden auch nach einem Fehlschlag entfernt. */
const pools = [];
const trackPool = (p) => { pools.push(p); return p; };
async function onFreshVolume(name, fn) {
  volume = docker('volume', 'create', `${tag}-${name}`);
  try {
    await fn();
  } finally {
    for (const p of pools.splice(0)) await p.end().catch(() => {});
    for (const c of started.splice(0)) { try { docker('rm', '-f', c); } catch { /* weg */ } }
    try { docker('volume', 'rm', '-f', volume); } catch { /* weg */ }
    volume = null;
  }
}

/** Container auf dem gemeinsamen Volume starten; liefert einen Pool, sobald die DB stabil antwortet. */
async function startServer({ license }) {
  const name = `${tag}-${started.length}`;
  const args = ['run', '-d', '--name', name, '-e', `POSTGRES_PASSWORD=${PASSWORD}`, '-e', 'POSTGRES_DB=dvhub',
    '-v', `${volume}:/var/lib/postgresql/data`, '-p', '127.0.0.1::5432', IMAGE];
  if (license) args.push('-c', `timescaledb.license=${license}`);
  docker(...args);
  started.push(name);
  const port = docker('port', name, '5432/tcp').split('\n')[0].split(':').pop();
  // Das Image startet beim ersten Mal einen Init-Server und danach den echten:
  // erst drei Antworten in Folge zählen.
  let ok = 0;
  for (let i = 0; i < 120 && ok < 3; i++) {
    const probe = new pg.Client({ host: '127.0.0.1', port: Number(port), user: 'postgres', password: PASSWORD, database: 'dvhub' });
    try { await probe.connect(); await probe.query('SELECT 1'); ok++; } catch { ok = 0; }
    await probe.end().catch(() => {});
    await sleep(500);
  }
  assert.equal(ok, 3, `TimescaleDB-Container ${name} antwortet nicht`);
  return { name, pool: trackPool(new pg.Pool({ host: '127.0.0.1', port: Number(port), user: 'postgres', password: PASSWORD, database: 'dvhub', max: 4 })) };
}

async function stopServer(server) {
  pools.splice(pools.indexOf(server.pool), 1);
  await server.pool.end().catch(() => {});
  docker('stop', '-t', '20', server.name);
  docker('rm', server.name);
  started.splice(started.indexOf(server.name), 1);
}

async function migrate(pool) {
  await ensurePgSchema(pool);
  return runPendingMigrations(pool, TS_CFG);
}

const one = async (pool, sql, params) => (await pool.query(sql, params)).rows[0];
const license = async (pool) => (await one(pool, "SELECT current_setting('timescaledb.license') AS l")).l;
const compressionOn = async (pool) => (await one(pool,
  "SELECT compression_enabled AS on FROM timescaledb_information.hypertables WHERE hypertable_name = 'timeseries_samples'"))?.on;
const compressAfter = async (pool) => (await one(pool,
  "SELECT config->>'compress_after' AS a FROM timescaledb_information.jobs WHERE proc_name = 'policy_compression' AND hypertable_name = 'timeseries_samples'"))?.a ?? null;
const cagg = async (pool) => Number((await one(pool, 'SELECT count(*) AS n FROM timescaledb_information.continuous_aggregates')).n);

/** Messwerte über mehrere Tage: ältere Tage landen in eigenen Chunks und werden komprimierbar. */
// Fester Anker (volle Stunde): ein zweiter Aufruf trifft dieselben Zeitstempel → Upsert.
const SAMPLES_END = Math.floor(Date.now() / 3600_000) * 3600_000 - 3600_000;
function samples(days, value) {
  const rows = [];
  for (let t = SAMPLES_END - days * 86400_000; t <= SAMPLES_END; t += 3600_000) {
    rows.push({ seriesKey: 'grid_total_w', scope: 'live', source: 'victron', quality: 'raw', ts: new Date(t), resolutionSeconds: 5, value, unit: 'W' });
  }
  return rows;
}

// Datenstufen (23.11.2026): Feinwerte über mehrere Tagesblöcke.
const TIER_BASE = floorQuarterMs(Date.now()) - 3 * 86400_000;
function tierSamples(fromMs, toMs) {
  const rows = [];
  for (let t = fromMs; t < toMs; t += 5000) {
    const i = (t - TIER_BASE) / 5000;
    rows.push({ seriesKey: 'grid_l1_w', scope: 'live', source: 'local_poll', quality: 'raw', ts: new Date(t).toISOString(), resolutionSeconds: 5, value: i % 120, unit: 'W' });
    rows.push({ seriesKey: 'battery_soc_pct', scope: 'live', source: 'local_poll', quality: 'raw', ts: new Date(t).toISOString(), resolutionSeconds: 5, value: 50 + (i % 10), unit: '%' });
  }
  return rows;
}
async function writeInParts(store, fromMs, toMs, stepMs = 6 * 3600_000) {
  for (let t = fromMs; t < toMs; t += stepMs) await store.writeSamples(tierSamples(t, Math.min(toMs, t + stepMs)));
}
async function runTiersToEnd(pool) {
  const tiers = createTelemetryTiers({ getDb: () => pool });
  for (let i = 0; i < 400; i++) {
    const r = await tiers.runOnce({ budget: 60_000 });
    assert.equal(r.error, undefined, r.error);
    if (r.done) return r;
  }
  throw new Error('Stufen nicht fertig');
}
const tierInfo = async (pool, table) => one(pool,
  'SELECT compression_enabled AS c FROM timescaledb_information.hypertables WHERE hypertable_name = $1', [table]);

describe('TimescaleDB echt (Docker)', { skip: !IMAGE && 'DVHUB_TS_IMAGE nicht gesetzt' }, () => {
  it('Apache → Community auf demselben Volume: tuneTimescale schaltet die Kompression nach, Daten bleiben', { timeout: 300_000 }, () => onFreshVolume('retrofit', async () => {
    // 1. Box mit Apache-Paket: 014 legt nur die Hypertable an.
    let srv = await startServer({ license: 'apache' });
    assert.equal(await license(srv.pool), 'apache');
    const m1 = await migrate(srv.pool);
    assert.deepEqual(m1.failed, [], `Migrationen unter Apache: ${JSON.stringify(m1.failed)}`);
    assert.deepEqual(m1.missing, []);
    assert.equal(await compressionOn(srv.pool), false, 'Apache: keine Kompression');
    assert.equal(await cagg(srv.pool), 0, 'Apache: keine Continuous Aggregates');
    const tA = await tuneTimescale((q, p) => srv.pool.query(q, p));
    assert.equal(tA.skipped, 'apache', 'unter Apache nichts versuchen, kein Fehler');
    const store = createTelemetryStorePg(srv.pool);
    await store.writeSamples(samples(10, 1));
    const before = Number((await one(srv.pool, 'SELECT count(*) AS n FROM timeseries_samples')).n);
    assert.ok(before > 200);
    await stopServer(srv);

    // 2. Nach dem Paketwechsel: Community-Lizenz, gleiche Daten.
    srv = await startServer({});
    assert.equal(await license(srv.pool), 'timescale');
    const m2 = await migrate(srv.pool);
    assert.deepEqual(m2.failed, []);
    assert.equal(await compressionOn(srv.pool), false, 'Voraussetzung: 014 holt die Kompression nicht nach');
    const t1 = await tuneTimescale((q, p) => srv.pool.query(q, p));
    assert.equal(t1.skipped, undefined);
    assert.equal(t1.deferred, undefined);
    assert.ok(t1.changed.includes('compression_enabled'), `changed: ${JSON.stringify(t1.changed)}`);
    assert.ok(t1.changed.includes('compress_after'));
    assert.equal(await compressionOn(srv.pool), true);
    assert.equal(await compressAfter(srv.pool), t1.compressAfter);
    const t2 = await tuneTimescale((q, p) => srv.pool.query(q, p));
    assert.deepEqual(t2.changed, [], 'zweiter Lauf ändert nichts');
    assert.equal((await one(srv.pool, 'SHOW lock_timeout')).lock_timeout, '0', 'SET LOCAL bleibt in seiner Transaktion');

    // 3. Komprimieren, danach lesen und in komprimierte Chunks schreiben (Upsert).
    const job = (await one(srv.pool, "SELECT job_id FROM timescaledb_information.jobs WHERE proc_name = 'policy_compression'")).job_id;
    await srv.pool.query(`CALL run_job(${Number(job)})`);
    const compressed = Number((await one(srv.pool, 'SELECT count(*) FILTER (WHERE is_compressed) AS n FROM timescaledb_information.chunks')).n);
    assert.ok(compressed > 0, 'ältere Chunks sind komprimiert');
    assert.equal(Number((await one(srv.pool, 'SELECT count(*) AS n FROM timeseries_samples')).n), before);
    await createTelemetryStorePg(srv.pool).writeSamples(samples(10, 7));
    const vals = await one(srv.pool, "SELECT count(*) AS n, min(value_num) AS lo, max(value_num) AS hi FROM timeseries_samples WHERE series_key = 'grid_total_w'");
    assert.deepEqual([Number(vals.n), vals.lo, vals.hi], [before, 7, 7], 'Upsert überschreibt auch in komprimierten Chunks');
  }));

  it('Community frisch: 014 mit Kompression und CAggs, tuneTimescale stellt nur nach', { timeout: 300_000 }, () => onFreshVolume('fresh', async () => {
    const srv = await startServer({});
    const m = await migrate(srv.pool);
    assert.deepEqual(m.failed, []);
    assert.ok(m.applied.includes('014-timescaledb.sql'));
    assert.equal(await compressionOn(srv.pool), true);
    assert.equal(await cagg(srv.pool), 2, '15-min- und 1-h-Aggregat');
    const t1 = await tuneTimescale((q, p) => srv.pool.query(q, p));
    assert.ok(!t1.changed.includes('compression_enabled'), 'Kompression war schon an');
    assert.deepEqual((await tuneTimescale((q, p) => srv.pool.query(q, p))).changed, []);
    const again = await migrate(srv.pool);
    assert.deepEqual([again.applied, again.failed], [[], []], 'zweiter Start: keine Migration offen');
    await stopServer(srv);
  }));

  it('Kompression nachschalten bei belegter Tabelle: verschoben statt Fehler, beim nächsten Lauf erledigt', { timeout: 300_000 }, () => onFreshVolume('lock', async () => {
    const srv = await startServer({});
    await migrate(srv.pool);
    await srv.pool.query("SELECT remove_compression_policy('timeseries_samples', if_exists => true)");
    await srv.pool.query('ALTER TABLE timeseries_samples SET (timescaledb.compress = false)');
    assert.equal(await compressionOn(srv.pool), false);
    // Ein Schreibvorgang hält die Tabelle in einer offenen Transaktion.
    const holder = await srv.pool.connect();
    await holder.query('BEGIN');
    await holder.query("INSERT INTO timeseries_samples (series_key, scope, source, quality, ts_utc, resolution_seconds, value_num) VALUES ('x', 'live', 'v', 'raw', now(), 5, 1)");
    const t0 = Date.now();
    const r = await tuneTimescale((q, p) => srv.pool.query(q, p));
    assert.equal(r.deferred, 'compression_lock_timeout');
    assert.ok(Date.now() - t0 < 30_000, 'wartet nur kurz (lock_timeout)');
    await holder.query('COMMIT');
    holder.release();
    const r2 = await tuneTimescale((q, p) => srv.pool.query(q, p));
    assert.ok(r2.changed.includes('compression_enabled'));
    assert.equal(await compressionOn(srv.pool), true);
    await stopServer(srv);
  }));

  it('Anbieterpreise (tariff_import_ct_kwh): schreiben, roh zurücklesen, Historien-Prüfwert ändert sich', { timeout: 300_000 }, () => onFreshVolume('tariff', async () => {
    const srv = await startServer({});
    await migrate(srv.pool);
    const store = createTelemetryStorePg(srv.pool);
    const start = Date.parse('2026-11-01T00:00:00Z');
    const bounds = ['2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z'];
    const fp0 = (await store.historySectionFingerprints({ boundaries: bounds }))[0].fp;
    const rows = (value) => Array.from({ length: 8 }, (_, i) => ({
      seriesKey: 'tariff_import_ct_kwh', scope: 'tariff', source: 'lichtblick', quality: 'raw',
      ts: new Date(start + i * 900_000).toISOString(), resolutionSeconds: 900, value: value + i, unit: 'ct/kWh'
    }));
    await store.writeSamples(rows(25));
    await store.writeSamples([{ ...rows(0)[0], source: 'tibber', value: 99 }, { ...rows(0)[0], scope: 'live', value: 1 }]);
    const all = await store.listSeriesSamples({ seriesKey: 'tariff_import_ct_kwh', scope: 'tariff' });
    assert.equal(all.length, 9, 'Bereich tariff, beide Anbieter, live nicht');
    assert.deepEqual(all.filter((r) => r.source === 'lichtblick').slice(0, 2).map((r) => [r.ts, r.value, r.resolutionSeconds]),
      [['2026-11-01T00:00:00.000Z', 25, 900], ['2026-11-01T00:15:00.000Z', 26, 900]]);
    const ranged = await store.listSeriesSamples({ seriesKey: 'tariff_import_ct_kwh', scope: 'tariff', start: '2026-11-01T01:00:00Z', end: '2026-11-01T01:30:00Z' });
    assert.deepEqual(ranged.map((r) => r.value), [29, 30]);
    // Neu abgeholt (Upsert): gleicher Schlüssel, neuer Wert, keine Doppelzeile
    await store.writeSamples(rows(40));
    const again = await store.listSeriesSamples({ seriesKey: 'tariff_import_ct_kwh', scope: 'tariff' });
    assert.equal(again.length, 9);
    assert.equal(again.find((r) => r.source === 'lichtblick').value, 40);
    const fp1 = (await store.historySectionFingerprints({ boundaries: bounds }))[0].fp;
    assert.notEqual(fp1, fp0, 'Anbieterpreise gehen in den Prüfwert der Historien-Ablage ein');
    await stopServer(srv);
  }));

  it('Datenstufen unter Community: Hypertables, immer komprimiert, Lesen und Nachzügler in komprimierten Blöcken, drop_chunks', { timeout: 600_000 }, () => onFreshVolume('tiers', async () => {
    const srv = await startServer({});
    await migrate(srv.pool);
    await tuneTimescale((q, p) => srv.pool.query(q, p));
    const store = createTelemetryStorePg(srv.pool);
    await writeInParts(store, TIER_BASE, TIER_BASE + 2 * 86400_000);
    const span = { start: new Date(TIER_BASE).toISOString(), end: new Date(TIER_BASE + 2 * 86400_000).toISOString() };
    // date_bin (neu) liefert dieselben Eimer wie time_bucket (bisher)
    const legacy = await srv.pool.query(`SELECT series_key, time_bucket('1 hour', ts_utc) AS b, SUM(value_num * resolution_seconds) / 3600 AS e, AVG(value_num) AS m
      FROM timeseries_samples WHERE series_key IN ('grid_l1_w', 'battery_soc_pct') AND ts_utc >= $1 AND ts_utc < $2 AND resolution_seconds < 900
      GROUP BY 1, 2 ORDER BY 2, 1`, [span.start, span.end]);
    const vizBefore = await store.queryBucketedSeries({ seriesKeys: ['grid_l1_w', 'battery_soc_pct'], ...span, bucketInterval: '1 hour' });
    assert.deepEqual(vizBefore.map((r) => [r.key, r.ts, r.value, r.value_avg]),
      legacy.rows.map((r) => [r.series_key, r.b.toISOString(), Number(r.e), Number(r.m)]));

    await runTiersToEnd(srv.pool);
    for (const t of ['timeseries_samples_1m', 'timeseries_samples_15m']) {
      const h = await tierInfo(srv.pool, t);
      assert.ok(h, `${t} ist Hypertable`);
      assert.equal(h.c, true, `${t} komprimiert (Community)`);
      const job = await one(srv.pool, "SELECT config->>'compress_after' AS a FROM timescaledb_information.jobs WHERE proc_name = 'policy_compression' AND hypertable_name = $1", [t]);
      assert.ok(job?.a, `${t} hat eine Kompressions-Regel`);
    }
    const again = await ensureTierStorage(srv.pool);
    assert.deepEqual(Object.values(again.tables).map((x) => x.changed), [[], []], 'zweiter Lauf ändert nichts');

    // Alles komprimieren (Rohwerte und Stufen), dann Rohwerte des ersten Tages weg
    await srv.pool.query("SELECT count(compress_chunk(c, if_not_compressed => true)) FROM show_chunks('timeseries_samples_1m') c");
    await srv.pool.query("SELECT count(compress_chunk(c, if_not_compressed => true)) FROM show_chunks('timeseries_samples_15m') c");
    const nComp = Number((await one(srv.pool, "SELECT count(*) AS n FROM timescaledb_information.chunks WHERE hypertable_name = 'timeseries_samples_1m' AND is_compressed")).n);
    assert.ok(nComp >= 2, `1-min-Blöcke komprimiert (${nComp})`);
    const cut = TIER_BASE + 86400_000;
    await srv.pool.query("DELETE FROM timeseries_samples WHERE scope = 'live' AND ts_utc < $1", [new Date(cut).toISOString()]);
    const viz = await store.queryBucketedSeries({ seriesKeys: ['grid_l1_w', 'battery_soc_pct'], ...span, bucketInterval: '1 hour' });
    assert.equal(viz.length, vizBefore.length, 'erster Tag aus der 15-min-Stufe');
    for (const [i, r] of viz.entries()) {
      assert.equal(r.ts, vizBefore[i].ts);
      assert.ok(Math.abs(r.value - vizBefore[i].value) < 1e-6, `Energie ${r.key} ${r.ts}`);
      assert.ok(Math.abs(r.value_avg - vizBefore[i].value_avg) < 1e-6, `Mittel ${r.key} ${r.ts}`);
    }
    const flat = await store.querySeries({ seriesKeys: ['grid_l1_w'], ...span, maxResolution: 900, bucketSec: 900 });
    assert.equal(flat.filter((r) => r.tier === '15m').length, 96, 'erster Tag: 96 Viertelstunden aus komprimierten Blöcken');

    // Nachzügler in einen komprimierten Stufen-Block
    await store.writeSamples([{ seriesKey: 'spaete_reihe_w', scope: 'live', source: 'local_poll', quality: 'raw', ts: new Date(TIER_BASE + 3000).toISOString(), resolutionSeconds: 5, value: 5, unit: 'W' }]);
    await runTiersToEnd(srv.pool);
    const late = await one(srv.pool, "SELECT n, value_avg FROM timeseries_samples_15m WHERE series_key = 'spaete_reihe_w'");
    assert.deepEqual([late.n, late.value_avg], [1, 5]);

    // Minutenwerte des ersten Tages per drop_chunks
    const until = await aggregatedUntil(srv.pool);
    assert.ok(Date.parse(until) >= TIER_BASE + 2 * 86400_000);
    const p = await pruneOneMinuteTier(srv.pool, { olderThan: new Date(cut + 86400_000).toISOString() });
    assert.ok(p.droppedChunks >= 1, `Blöcke entfernt (${JSON.stringify(p)})`);
    assert.equal(Number((await one(srv.pool, "SELECT count(*) AS n FROM timeseries_samples_15m WHERE bucket_ts < $1", [new Date(cut).toISOString()])).n) > 0, true, '15-min-Werte bleiben');
    await stopServer(srv);
  }));

  it('Datenstufen unter Apache und nach Nachrüstung: Hypertable ohne Kompression, alte normale Tabellen werden umgezogen', { timeout: 600_000 }, () => onFreshVolume('tiers-apache', async () => {
    const srv = await startServer({ license: 'apache' });
    // Erst ohne TimescaleDB (wie eine Box, deren Einrichtung scheiterte): normale Tabellen
    await ensurePgSchema(srv.pool);
    const m0 = await runPendingMigrations(srv.pool, {});
    assert.deepEqual(m0.failed, []);
    await srv.pool.query('DROP EXTENSION IF EXISTS timescaledb');
    const store = createTelemetryStorePg(srv.pool);
    await writeInParts(store, TIER_BASE, TIER_BASE + 6 * 3600_000);
    await runTiersToEnd(srv.pool);
    assert.equal((await ensureTierStorage(srv.pool)).mode, 'plain');
    const before = (await srv.pool.query('SELECT * FROM timeseries_samples_15m ORDER BY series_key, bucket_ts')).rows;
    assert.ok(before.length > 0);
    // Nachrüstung: TimescaleDB (Apache) kommt dazu → 014 macht die Rohwerte zur Hypertable
    const m1 = await migrate(srv.pool);
    assert.deepEqual(m1.failed, []);
    const st = await ensureTierStorage(srv.pool);
    assert.equal(st.mode, 'apache');
    for (const t of ['timeseries_samples_1m', 'timeseries_samples_15m']) {
      const h = await tierInfo(srv.pool, t);
      assert.ok(h, `${t} ist jetzt Hypertable`);
      assert.equal(h.c, false, 'Apache: keine Kompression');
    }
    assert.deepEqual((await srv.pool.query('SELECT * FROM timeseries_samples_15m ORDER BY series_key, bucket_ts')).rows, before, 'Daten umgezogen');
    // Weiter verdichten und Minutenwerte per drop_chunks löschen geht auch unter Apache
    await writeInParts(store, TIER_BASE + 6 * 3600_000, TIER_BASE + 30 * 3600_000);
    await runTiersToEnd(srv.pool);
    const p = await pruneOneMinuteTier(srv.pool, { olderThan: new Date(TIER_BASE + 26 * 3600_000).toISOString() });
    assert.ok(p.droppedChunks >= 1, JSON.stringify(p));
    await stopServer(srv);
  }));
});
