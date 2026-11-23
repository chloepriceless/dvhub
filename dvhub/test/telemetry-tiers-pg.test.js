// test/telemetry-tiers-pg.test.js — Datenstufen 1 min / 15 min gegen echtes
// PostgreSQL (ohne TimescaleDB). Christin 23.11.2026: 5 s → 1 min → 15 min für
// ALLE Reihen (services/telemetry-tiers.js, Migration 027).
//
// Läuft nur mit DVHUB_TEST_PG_URL oder DATABASE_URL (CI: pg-integration), legt
// je Lauf eine eigene Datenbank an und löscht sie danach.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { ensurePgSchema, runPendingMigrations, createTelemetryStorePg } from '../telemetry-store-pg.js';
import {
  createTelemetryTiers, aggregatedUntil, tierCoverage, pruneOneMinuteTier, floorQuarterMs,
} from '../services/telemetry-tiers.js';

const URL = process.env.DVHUB_TEST_PG_URL || process.env.DATABASE_URL;
const MIN = 60_000;
const Q = 15 * MIN;
const H = 60 * MIN;

// Raster weit hinter „jetzt − 30 min“: ein Tag zurück, auf die Viertelstunde.
const BASE = floorQuarterMs(Date.now()) - 24 * H;
const at = (ms) => new Date(ms).toISOString();

/** Messwerte wie im Betrieb: 5-s-Live-Reihen, ein Zähler, Text, 5-min-Import, VRM, Preise. */
function makeSamples(fromMs, toMs) {
  const rows = [];
  for (let t = fromMs; t < toMs; t += 5000) {
    const i = (t - BASE) / 5000;
    // Leistung: Rampe, damit Mittel/Min/Max unterscheidbar sind
    rows.push({ seriesKey: 'grid_l1_w', scope: 'live', source: 'local_poll', ts: at(t), resolutionSeconds: 5, value: i % 120, unit: 'W' });
    // Energie-Reihe (auch in energy_slots_15m)
    rows.push({ seriesKey: 'grid_import_w', scope: 'live', source: 'local_poll', ts: at(t), resolutionSeconds: 5, value: 1200, unit: 'W' });
    // Zählerstand (Wh, steigt)
    rows.push({ seriesKey: 'battery_grid_share_wh', scope: 'live', source: 'local_poll', ts: at(t), resolutionSeconds: 5, value: 1000 + i, unit: 'Wh' });
  }
  // Ereignis-Reihen (TeslaMate): Text und Zahl+Text, unregelmäßig
  for (let t = fromMs; t < toMs; t += 7 * MIN) {
    rows.push({ seriesKey: 'tesla_geofence', scope: 'live', source: 'teslamate', ts: at(t + 1000), resolutionSeconds: 1, value: null, valueText: `ort-${(t - BASE) / (7 * MIN)}` });
    rows.push({ seriesKey: 'tesla_charging_state', scope: 'live', source: 'teslamate', ts: at(t + 2000), resolutionSeconds: 1, value: 2, valueText: 'Charging' });
  }
  // 5-min-Import (PV-String, scope history) — fein, also in den Stufen
  for (let t = fromMs; t < toMs; t += 5 * MIN) {
    rows.push({ seriesKey: 'pv_string_sued_w', scope: 'history', source: 'fronius_import', quality: 'backfilled', ts: at(t), resolutionSeconds: 300, value: 3000, unit: 'W' });
  }
  // Schon Viertelstunde: VRM-Import und Preise bleiben nur in timeseries_samples
  for (let t = fromMs; t < toMs; t += Q) {
    rows.push({ seriesKey: 'grid_import_w', scope: 'history', source: 'vrm_import', quality: 'backfilled', ts: at(t), resolutionSeconds: 900, value: 1100, unit: 'W' });
    rows.push({ seriesKey: 'price_ct_kwh', scope: 'forecast', source: 'price_api', ts: at(t), resolutionSeconds: 900, value: 12.5, unit: 'ct/kWh' });
  }
  // Ungültig markierte Probe zählt nicht
  rows.push({ seriesKey: 'grid_l1_w', scope: 'live', source: 'local_poll', quality: 'invalid', ts: at(fromMs + 2500), resolutionSeconds: 5, value: 99999, unit: 'W' });
  return rows;
}

describe('Datenstufen 1 min / 15 min (PostgreSQL ohne TimescaleDB)', { skip: !URL && 'DVHUB_TEST_PG_URL/DATABASE_URL nicht gesetzt' }, () => {
  let admin;
  const dbs = [];

  async function freshDb() {
    const name = `dvhub_tiers_${process.pid}_${dbs.length}`;
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.query(`CREATE DATABASE ${name}`);
    const u = new globalThis.URL(URL);
    u.pathname = `/${name}`;
    const pool = new pg.Pool({ connectionString: u.toString(), max: 4 });
    dbs.push({ name, pool });
    await ensurePgSchema(pool);
    const m = await runPendingMigrations(pool, {});
    assert.deepEqual(m.failed, [], JSON.stringify(m.failed));
    return pool;
  }

  before(async () => {
    admin = new pg.Client({ connectionString: URL });
    await admin.connect();
  });
  after(async () => {
    for (const { name, pool } of dbs) {
      await pool.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    }
    await admin?.end();
  });

  const one = async (pool, sql, params) => (await pool.query(sql, params)).rows[0];
  const tiers = (pool, opts = {}) => createTelemetryTiers({ getDb: () => pool, ...opts });
  async function runAll(t) {
    for (let i = 0; i < 500; i++) {
      const r = await t.runOnce({ budget: 60_000 });
      assert.equal(r.error, undefined, r.error);
      if (r.done) return r;
    }
    throw new Error('Stufen wurden nicht fertig');
  }
  async function snapshot(pool, table) {
    return (await pool.query(`SELECT * FROM ${table} ORDER BY series_key, scope, source, bucket_ts`)).rows
      .map((r) => ({ ...r, bucket_ts: r.bucket_ts.toISOString() }));
  }

  it('Migration 027 ist idempotent und legt Zeiger + Nachzügler-Tabelle an', async () => {
    const pool = await freshDb();
    const again = await runPendingMigrations(pool, {});
    assert.deepEqual(again.applied, [], 'zweiter Lauf wendet nichts an');
    assert.deepEqual(again.missing, []);
    // Datei ein zweites Mal direkt ausführen (z. B. Wiederholung nach Abbruch): kein Fehler
    const fs = await import('node:fs');
    const path = await import('node:path');
    const sql = fs.readFileSync(path.join(import.meta.dirname, '..', 'db', 'migrations', '027-telemetry-tiers.sql'), 'utf8');
    await pool.query(sql);
    const st = await one(pool, "SELECT done_until FROM telemetry_tier_state WHERE id = 'tiers'");
    assert.equal(st.done_until, null, 'noch kein Lauf');
    assert.equal((await tierCoverage(pool)).until, null);
    assert.equal(await aggregatedUntil(pool), null, 'nichts verdichtet → nichts löschen');
  });

  it('Aggregation je Art: Leistung Mittel/Min/Max, Zähler letzter Wert, Text letzter, 5-min-Import mit, VRM/Preise/ungültig nicht', async () => {
    const pool = await freshDb();
    const store = createTelemetryStorePg(pool);
    await store.writeSamples(makeSamples(BASE, BASE + 2 * H));
    const slotsBefore = (await pool.query('SELECT slot_start_utc, series_key, source_kind, value_num, meta_json FROM energy_slots_15m ORDER BY 1, 2, 3')).rows;
    const rawBefore = Number((await one(pool, 'SELECT count(*) AS n FROM timeseries_samples')).n);

    const r = await runAll(tiers(pool));
    assert.ok(r.coverage.until, 'Zeiger gesetzt');

    // Erste Minute grid_l1_w: Proben 0..11 (Rampe), die ungültige 99999 fehlt
    const m0 = await one(pool, `SELECT * FROM timeseries_samples_1m WHERE series_key = 'grid_l1_w' AND bucket_ts = $1`, [at(BASE)]);
    assert.equal(m0.n, 12);
    assert.equal(m0.covered_s, 60);
    assert.equal(m0.res_min, 5);
    assert.equal(m0.value_avg, 5.5);
    assert.equal(m0.value_min, 0);
    assert.equal(m0.value_max, 11);
    assert.equal(m0.value_first, 0);
    assert.equal(m0.value_last, 11);
    // Viertelstunde: 180 Proben, Rampe 0..119 dann 0..59
    const q0 = await one(pool, `SELECT * FROM timeseries_samples_15m WHERE series_key = 'grid_l1_w' AND bucket_ts = $1`, [at(BASE)]);
    assert.equal(q0.n, 180);
    assert.equal(q0.value_max, 119);
    const expectedAvg = (Array.from({ length: 120 }, (_, i) => i).reduce((a, b) => a + b, 0) + Array.from({ length: 60 }, (_, i) => i).reduce((a, b) => a + b, 0)) / 180;
    assert.ok(Math.abs(q0.value_avg - expectedAvg) < 1e-9);
    // Zähler: letzter Wert der Viertelstunde = 1000 + 179
    const c = await one(pool, `SELECT value_first, value_last FROM timeseries_samples_15m WHERE series_key = 'battery_grid_share_wh' AND bucket_ts = $1`, [at(BASE)]);
    assert.equal(c.value_first, 1000);
    assert.equal(c.value_last, 1179);
    // Text: letzter Text der Viertelstunde (Proben bei +0:01 und +7:01 und +14:01 min)
    const g = await one(pool, `SELECT n, value_text, value_avg FROM timeseries_samples_15m WHERE series_key = 'tesla_geofence' AND bucket_ts = $1`, [at(BASE)]);
    assert.equal(g.value_text, 'ort-2');
    assert.equal(g.value_avg, null, 'reine Textreihe hat keinen Mittelwert');
    assert.equal(g.n, 3);
    const cs = await one(pool, `SELECT value_text, value_last FROM timeseries_samples_1m WHERE series_key = 'tesla_charging_state' AND bucket_ts = $1`, [at(BASE)]);
    assert.equal(cs.value_text, 'Charging');
    assert.equal(cs.value_last, 2);
    // 5-min-Import: in beiden Stufen, gewichtet mit 300 s
    const pv = await one(pool, `SELECT n, covered_s, res_min, value_avg FROM timeseries_samples_15m WHERE series_key = 'pv_string_sued_w' AND bucket_ts = $1`, [at(BASE)]);
    assert.deepEqual([pv.n, pv.covered_s, pv.res_min, pv.value_avg], [3, 900, 300, 3000]);
    // VRM (900 s) und Preise nicht in den Stufen; grid_import_w nur mit der Live-Quelle
    const scopes = (await pool.query(`SELECT DISTINCT series_key, scope, source FROM timeseries_samples_15m ORDER BY 1, 2, 3`)).rows
      .map((x) => `${x.series_key}|${x.scope}|${x.source}`);
    assert.deepEqual(scopes, [
      'battery_grid_share_wh|live|local_poll', 'grid_import_w|live|local_poll', 'grid_l1_w|live|local_poll',
      'pv_string_sued_w|history|fronius_import', 'tesla_charging_state|live|teslamate', 'tesla_geofence|live|teslamate',
    ]);
    // Bestand unverändert: energy_slots_15m und Rohwerte
    const slotsAfter = (await pool.query('SELECT slot_start_utc, series_key, source_kind, value_num, meta_json FROM energy_slots_15m ORDER BY 1, 2, 3')).rows;
    assert.deepEqual(slotsAfter, slotsBefore, 'energy_slots_15m bleibt gleich');
    assert.equal(Number((await one(pool, 'SELECT count(*) AS n FROM timeseries_samples')).n), rawBefore, 'Rohwerte bleiben');
    // Je Reihe: Σ n der 15-min-Stufe = Zahl der gültigen Feinwerte (keine Doppelten, keine Lücke)
    const sums = (await pool.query(`SELECT series_key, sum(n)::int AS n FROM timeseries_samples_15m GROUP BY 1 ORDER BY 1`)).rows;
    const raw = (await pool.query(`SELECT series_key, count(*)::int AS n FROM timeseries_samples
      WHERE resolution_seconds < 900 AND quality <> 'invalid' GROUP BY 1 ORDER BY 1`)).rows;
    assert.deepEqual(sums, raw);
    const sums1 = (await pool.query(`SELECT series_key, sum(n)::int AS n FROM timeseries_samples_1m GROUP BY 1 ORDER BY 1`)).rows;
    assert.deepEqual(sums1, raw);
  });

  it('Rückfüllung in Portionen und Wiederaufnahme nach Neustart: gleiches Ergebnis wie am Stück, keine Doppelten', async () => {
    const a = await freshDb();
    const b = await freshDb();
    const samples = makeSamples(BASE - 6 * H, BASE);
    await createTelemetryStorePg(a).writeSamples(samples);
    await createTelemetryStorePg(b).writeSamples(samples);
    await runAll(tiers(a));
    // b: 1-h-Portionen, je „Lauf“ nur eine Transaktion, dazwischen neue Instanz (Neustart)
    let portions = 0;
    let lastTo = null;
    for (let i = 0; i < 100; i++) {
      const t = tiers(b, { portionMs: H });
      const r = await t.runOnce({ budget: 0 });   // genau ein Schritt je Lauf
      assert.equal(r.error, undefined, r.error);
      if (r.to) {
        // Portion mit Daten höchstens 1 h; leere Strecke wird in einem Schritt übersprungen
        if (r.rows > 0) assert.ok(Date.parse(r.to) - Date.parse(r.from) <= H, 'Portion höchstens 1 h');
        if (lastTo) assert.equal(r.from, lastTo, 'nahtlos am alten Zeiger weiter');
        lastTo = r.to;
        portions += 1;
      }
      if (r.done) break;
    }
    assert.ok(portions >= 6, `mindestens 6 Portionen (${portions})`);
    assert.deepEqual(await snapshot(b, 'timeseries_samples_1m'), await snapshot(a, 'timeseries_samples_1m'));
    assert.deepEqual(await snapshot(b, 'timeseries_samples_15m'), await snapshot(a, 'timeseries_samples_15m'));
    // Erneut ab Anfang verdichten (Zeiger zurück): keine Doppelten, gleiche Werte
    await b.query("UPDATE telemetry_tier_state SET done_until = started_from WHERE id = 'tiers'");
    await runAll(tiers(b));
    assert.deepEqual(await snapshot(b, 'timeseries_samples_15m'), await snapshot(a, 'timeseries_samples_15m'));
  });

  it('Nachzügler: spät geschriebene Feinwerte werden markiert und nachverdichtet; Rest ersetzt nie den vollen Eimer', async () => {
    const pool = await freshDb();
    const store = createTelemetryStorePg(pool);
    await store.writeSamples(makeSamples(BASE, BASE + H));
    await runAll(tiers(pool));
    const cursor = (await tierCoverage(pool)).cursor;
    // Neue Reihe kommt verspätet für eine alte Viertelstunde (z. B. Puffer nach DB-Ausfall)
    await store.writeSamples([{ seriesKey: 'neue_reihe_w', scope: 'live', source: 'local_poll', ts: at(BASE + 20 * MIN + 3000), resolutionSeconds: 5, value: 42, unit: 'W' }]);
    const cov = await tierCoverage(pool);
    assert.equal(cov.dirtyFrom, at(BASE + Q), 'Viertelstunde markiert');
    assert.equal(await aggregatedUntil(pool), at(BASE + Q), 'Aufbewahrung darf nur bis zur offenen Viertelstunde');
    await runAll(tiers(pool));
    assert.equal((await tierCoverage(pool)).dirtyCount, 0);
    assert.equal(await aggregatedUntil(pool), cursor);
    const nr = await one(pool, `SELECT n, value_avg FROM timeseries_samples_15m WHERE series_key = 'neue_reihe_w'`);
    assert.deepEqual([nr.n, nr.value_avg], [1, 42]);
    // Rohwerte einer verdichteten Viertelstunde weg, dann ein Nachzügler darin:
    // der volle 15-min-Eimer bleibt (n 180), nicht durch den einen Rest ersetzt
    await pool.query(`DELETE FROM timeseries_samples WHERE series_key = 'grid_l1_w' AND ts_utc < $1`, [at(BASE + Q)]);
    await store.writeSamples([{ seriesKey: 'grid_l1_w', scope: 'live', source: 'local_poll', ts: at(BASE + 3000), resolutionSeconds: 5, value: 7, unit: 'W' }]);
    await runAll(tiers(pool));
    const q0 = await one(pool, `SELECT n, value_max FROM timeseries_samples_15m WHERE series_key = 'grid_l1_w' AND bucket_ts = $1`, [at(BASE)]);
    assert.deepEqual([q0.n, q0.value_max], [180, 119]);
  });

  it('Lücken werden übersprungen, ohne Feinwerte bleibt der Zeiger beim Ziel', async () => {
    const pool = await freshDb();
    const store = createTelemetryStorePg(pool);
    await store.writeSamples(makeSamples(BASE - 20 * 24 * H, BASE - 20 * 24 * H + Q));
    await store.writeSamples(makeSamples(BASE, BASE + Q));
    const r = await tiers(pool).runOnce({ budget: 60_000 });
    assert.ok(r.done);
    assert.ok(r.portions < 20, `Lücke von 20 Tagen in wenigen Schritten (${r.portions})`);
    assert.equal(Number((await one(pool, 'SELECT count(DISTINCT bucket_ts) AS n FROM timeseries_samples_15m')).n), 2);
    const empty = await freshDb();
    const e = await tiers(empty).runOnce();
    assert.ok(e.done);
    const cur = Date.parse((await tierCoverage(empty)).cursor);
    assert.ok(Math.abs(cur - floorQuarterMs(Date.now() - 30 * MIN)) <= Q, 'ohne Daten: Zeiger beim Ziel');
  });

  it('Abfrage-Rückfall: fehlen Rohwerte, kommen 1-min- bzw. 15-min-Werte; mit Rohwerten unverändert', async () => {
    const pool = await freshDb();
    const store = createTelemetryStorePg(pool);
    await store.writeSamples(makeSamples(BASE, BASE + 2 * H));
    const keys = ['grid_l1_w', 'battery_grid_share_wh', 'tesla_geofence'];
    const span = { start: at(BASE), end: at(BASE + 2 * H) };
    // Antworten VOR den Stufen
    const flatBefore = await store.querySeries({ seriesKeys: keys, ...span, maxResolution: 900 });
    const bucketBefore = await store.querySeries({ seriesKeys: keys, ...span, maxResolution: 900, bucketSec: 900 });
    const streamBefore = [];
    for await (const rows of store.iterateSeriesBuckets({ seriesKeys: keys, ...span, bucketSec: 60 })) streamBefore.push(...rows);
    const viz = (s) => s.queryBucketedSeries({ seriesKeys: ['grid_l1_w', 'grid_import_w'], ...span, bucketInterval: '15 minutes' });
    const vizBefore = await viz(store);
    const boundBefore = await store.getSeriesBoundaryValues({ seriesKey: 'battery_grid_share_wh', ...span });
    // Ende mitten in einer Viertelstunde (Codex e6fed14e): nur Rohwerte bis end
    const vizPart = (st) => st.queryBucketedSeries({ seriesKeys: ['grid_l1_w'], start: at(BASE), end: at(BASE + 7 * MIN), bucketInterval: '15 minutes' });
    const vizPartBefore = await vizPart(store);
    // Wechselnde Auflösung (5 s / 15 s): Mittel wie roh ungewichtet (Codex e6fed14e)
    await store.writeSamples([
      { seriesKey: 'var_w', scope: 'live', source: 'local_poll', ts: at(BASE), resolutionSeconds: 5, value: 0, unit: 'W' },
      { seriesKey: 'var_w', scope: 'live', source: 'local_poll', ts: at(BASE + 5000), resolutionSeconds: 15, value: 100, unit: 'W' },
    ]);
    const varViz = (st) => st.queryBucketedSeries({ seriesKeys: ['var_w'], ...span, bucketInterval: '15 minutes' });
    const varBefore = await varViz(store);
    assert.equal(varBefore[0].value_avg, 50);
    await runAll(tiers(pool));
    assert.deepEqual(await vizPart(store), vizPartBefore, 'Stufen-Eimer über end hinaus zählen nicht');
    // Mit Rohwerten: alles gleich
    assert.deepEqual(await store.querySeries({ seriesKeys: keys, ...span, maxResolution: 900 }), flatBefore);
    assert.deepEqual(await store.querySeries({ seriesKeys: keys, ...span, maxResolution: 900, bucketSec: 900 }), bucketBefore);
    const streamAfter = [];
    for await (const rows of store.iterateSeriesBuckets({ seriesKeys: keys, ...span, bucketSec: 60 })) streamAfter.push(...rows);
    assert.deepEqual(streamAfter, streamBefore);
    assert.deepEqual(await viz(store), vizBefore);
    assert.deepEqual(await store.getSeriesBoundaryValues({ seriesKey: 'battery_grid_share_wh', ...span }), boundBefore);

    // Rohwerte der ersten Stunde weg (wie die Aufbewahrung es täte)
    const cut = BASE + H;
    await pool.query(`DELETE FROM timeseries_samples WHERE scope = 'live' AND ts_utc < $1`, [at(cut)]);
    // flach: 1-min-Werte bis zur ersten Rohzeile, danach roh wie vorher
    const flat = await store.querySeries({ seriesKeys: ['grid_l1_w'], ...span, maxResolution: 900 });
    const tierRows = flat.filter((r) => r.tier);
    assert.equal(tierRows.length, 60, 'eine Zeile je Minute der fehlenden Stunde');
    assert.equal(tierRows[0].resolution, 60);
    assert.equal(tierRows[0].value, 5.5, 'Leistung: Mittelwert');
    assert.ok(tierRows.every((r) => new Date(r.ts).getTime() < cut));
    assert.deepEqual(flat.filter((r) => !r.tier), flatBefore.filter((r) => r.key === 'grid_l1_w' && new Date(r.ts).getTime() >= cut), 'Rohteil unverändert');
    // Zähler: letzter Wert
    const cnt = await store.querySeries({ seriesKeys: ['battery_grid_share_wh'], ...span, maxResolution: 900, bucketSec: 900 });
    assert.equal(cnt[0].value, 1179, 'Zählerstand: letzter Wert der Viertelstunde');
    assert.equal(cnt[0].tier, '15m');
    assert.equal(cnt.filter((r) => r.tier).length, 4);
    // Strom (Explorer, 60 s): Lücke gefüllt, Raster nahtlos
    const stream = [];
    for await (const rows of store.iterateSeriesBuckets({ seriesKeys: ['grid_l1_w'], ...span, bucketSec: 60 })) stream.push(...rows);
    assert.equal(stream.length, 120);
    assert.deepEqual(stream.map((r) => r.ts), Array.from({ length: 120 }, (_, i) => at(BASE + i * MIN)));
    // History-Viz (SoC-Spaghetti, Preise): Stufe statt Lücke, Energie exakt
    const v = await viz(store);
    // (zweite Viertelstunde: in der ersten zählte roh die ungültige Probe mit, die Stufe nicht)
    const v0 = v.find((r) => r.key === 'grid_l1_w' && r.ts === at(BASE + Q));
    const b0 = vizBefore.find((r) => r.key === 'grid_l1_w' && r.ts === at(BASE + Q));
    assert.ok(Math.abs(v0.value - b0.value) < 1e-9, 'Energie-Mittel gleich');
    // grid_import_w hat dort VRM-Werte (900 s); die eigenen Werte (Stufe) gehen vor
    const g0 = v.find((r) => r.key === 'grid_import_w' && r.ts === at(BASE));
    assert.equal(g0.value, 1200);
    const varAfter = await varViz(store);
    assert.equal(varAfter[0].value_avg, 50, 'ungewichtetes Mittel auch aus der Stufe');
    assert.ok(Math.abs(varAfter[0].value - varBefore[0].value) < 1e-9, 'Energie gleich');
    // Randwerte: Startwert aus der Stufe statt erst ab der ersten Rohzeile
    const bound = await store.getSeriesBoundaryValues({ seriesKey: 'battery_grid_share_wh', ...span });
    assert.deepEqual(bound, boundBefore);
    // Stunden-Zeile (VRM) belegt ihre ganze Stunde: keine Stufen-Zeilen daneben (Codex d4f9ddc0)
    await store.writeSamples([{ seriesKey: 'grid_l1_w', scope: 'history', source: 'vrm_import', quality: 'backfilled', ts: at(BASE), resolutionSeconds: 3600, value: 90, unit: 'W' }]);
    const hourly = await store.querySeries({ seriesKeys: ['grid_l1_w'], ...span, maxResolution: 3600, bucketSec: 900 });
    assert.equal(hourly.filter((r) => r.tier).length, 0, 'Stunde mit VRM-Wert bleibt ohne Stufe');
    assert.equal(hourly.filter((r) => new Date(r.ts).getTime() < cut).length, 1);
    await pool.query(`DELETE FROM timeseries_samples WHERE series_key = 'grid_l1_w' AND resolution_seconds = 3600`);
    // Eine einzelne Rohprobe mitten im gelöschten Bereich verdeckt den Rest nicht (Codex e6fed14e)
    await pool.query(`INSERT INTO timeseries_samples (series_key, scope, source, quality, ts_utc, resolution_seconds, value_num, unit)
      VALUES ('grid_l1_w', 'live', 'local_poll', 'raw', $1, 5, 77, 'W')`, [at(BASE + 10 * MIN + 3000)]);
    const lone = await store.querySeries({ seriesKeys: ['grid_l1_w'], ...span, maxResolution: 900 });
    assert.equal(lone.filter((r) => r.tier).length, 59, 'alle Minuten außer der mit Rohprobe');
    assert.equal(lone.filter((r) => !r.tier && new Date(r.ts).getTime() < cut).length, 1);
    await pool.query(`DELETE FROM timeseries_samples WHERE series_key = 'grid_l1_w' AND value_num = 77`);
    // Minutenwerte löschen (Profil „winzig“): dann 15-min-Werte
    const p = await pruneOneMinuteTier(pool, { olderThan: at(BASE + 30 * MIN) });
    assert.equal(p.cutoff, at(BASE + 30 * MIN));
    assert.ok(p.deletedRows > 0);
    const mixed = await store.querySeries({ seriesKeys: ['grid_l1_w'], ...span, maxResolution: 900 });
    const t15 = mixed.filter((r) => r.tier === '15m');
    const t1 = mixed.filter((r) => r.tier === '1m');
    assert.equal(t15.length, 2, 'die ersten 30 min als Viertelstunden');
    assert.equal(t1.length, 30, 'dann Minuten bis zur ersten Rohzeile');
    assert.equal(Number((await one(pool, 'SELECT count(*) AS n FROM timeseries_samples_15m')).n) > 0, true, '15-min-Werte bleiben');
  });

  it('pruneOneMinuteTier löscht nie jenseits von aggregatedUntil', async () => {
    const pool = await freshDb();
    await createTelemetryStorePg(pool).writeSamples(makeSamples(BASE, BASE + H));
    await runAll(tiers(pool));
    await pool.query("UPDATE telemetry_tier_state SET done_until = $1 WHERE id = 'tiers'", [at(BASE + Q)]);
    const r = await pruneOneMinuteTier(pool, { olderThan: at(BASE + H) });
    assert.equal(r.cutoff, at(BASE + Q));
    const left = await one(pool, 'SELECT min(bucket_ts) AS m FROM timeseries_samples_1m');
    assert.equal(left.m.toISOString(), at(BASE + Q));
  });
});
