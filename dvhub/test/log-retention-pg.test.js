// Laufreihen-Verdichtung gegen echtes PostgreSQL (DATABASE_URL-gated wie die
// Migrations-Tests). Christin 2026-10-18: nach 14 Tagen bleibt je Tag die
// Vorhersage, mit der der Tag geplant war — der Day-Ahead-Plan vom Vortag:
// erster Lauf ≥ 30 min nach Eingang der Day-Ahead-Preise (audit_log
// epex_dayahead_arrived), sonst ab 14:30 am Vortag; nur die Slots des Tages.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { OPTIMIZER_RUN_RETENTION_SQL, SERIES_RETENTION_SQL } from '../services/log-retention.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe('Laufreihen: Day-Ahead-Plan je Tag (PostgreSQL)', { skip: !DATABASE_URL }, () => {
  let client;
  const TZ = 'Europe/Berlin';
  const at = (s) => new Date(s).toISOString();
  // Läufe wie im Betrieb: [id, Start] — Reihen stündlich über 48 h ab Start.
  const RUNS = [
    [1, '2026-09-08T12:00:00+02:00'],
    [2, '2026-09-09T00:15:00+02:00'],
    [3, '2026-09-09T14:10:00+02:00'],   // kurz nach Eingang — EOS noch ohne neue Preise
    [4, '2026-09-09T14:40:00+02:00'],   // ≥ 30 min nach Eingang ← bleibt für den 10.09.
    [5, '2026-09-10T08:00:00+02:00'],
    [6, '2026-09-10T15:00:00+02:00'],   // ohne Eingangs-Eintrag: ab 14:30 ← bleibt für den 11.09.
  ];

  before(async () => {
    const pg = await import('pg');
    client = new pg.default.Client({ connectionString: DATABASE_URL });
    await client.connect();
    await client.query('DROP SCHEMA IF EXISTS lr_test CASCADE; CREATE SCHEMA lr_test; SET search_path TO lr_test');
    await client.query(`CREATE TABLE optimizer_runs (id bigint PRIMARY KEY, run_started_at timestamptz NOT NULL);
      CREATE TABLE optimizer_run_series (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        optimizer_run_id bigint NOT NULL, series_key text NOT NULL, scope text NOT NULL,
        ts_utc timestamptz NOT NULL, resolution_seconds integer NOT NULL, value_num double precision, unit text);
      CREATE TABLE audit_log (id bigint GENERATED ALWAYS AS IDENTITY, ts_utc timestamptz NOT NULL, event_type text, payload jsonb)`);
    await client.query(`INSERT INTO audit_log (ts_utc, event_type, payload) VALUES
      ($1, 'epex_dayahead_arrived', '{"date":"2026-09-10","triggering":"eos_bridge_push"}'),
      ($2, 'epex_dayahead_arrived', '{"date":"2026-09-10","triggering":"eos_bridge_push"}')`,
    [at('2026-09-09T14:05:00+02:00'), at('2026-09-09T18:00:00+02:00')]);
    for (const [id, start] of RUNS) {
      await client.query('INSERT INTO optimizer_runs VALUES ($1, $2)', [id, at(start)]);
      await client.query(`INSERT INTO optimizer_run_series (optimizer_run_id, series_key, scope, ts_utc, resolution_seconds, value_num)
        SELECT $1, k, 'plan', ts, 3600, 1
          FROM generate_series(date_trunc('hour', $2::timestamptz) + interval '1 hour', $2::timestamptz + interval '48 hours', interval '1 hour') ts,
               unnest(ARRAY['battery_power_w','price_import_ct_kwh']) k`, [id, at(start)]);
    }
  });
  after(async () => { await client?.query('DROP SCHEMA IF EXISTS lr_test CASCADE'); await client?.end(); });

  const runsOnDay = async (day) => (await client.query(
    `SELECT DISTINCT optimizer_run_id AS id FROM optimizer_run_series
      WHERE ts_utc >= ($1::date::timestamp AT TIME ZONE $2) AND ts_utc < (($1::date + 1)::timestamp AT TIME ZONE $2)
      ORDER BY 1`, [day, TZ])).rows.map((r) => Number(r.id));

  it('ältester Tag mit mehreren Läufen vor dem Stichtag', async () => {
    const r = await client.query(SERIES_RETENTION_SQL.oldestMultiRunDay, [TZ, at('2026-09-12T00:00:00+02:00')]);
    assert.equal(r.rows[0]?.day, '2026-09-09', '08.09. hat nur einen Lauf');
  });

  it('Day-Ahead-Plan: erster Lauf ≥ 30 min nach dem ersten Eingang bleibt, nur mit den Slots des Tages', async () => {
    assert.deepEqual(await runsOnDay('2026-09-10'), [1, 2, 3, 4, 5, 6]);
    const before11 = await runsOnDay('2026-09-11');
    const del = await client.query(SERIES_RETENTION_SQL.thinSeriesDay, ['2026-09-10', TZ]);
    assert.ok(del.rowCount > 0);
    assert.deepEqual(await runsOnDay('2026-09-10'), [4]);
    const n = await client.query(`SELECT count(*)::int AS n FROM optimizer_run_series WHERE optimizer_run_id = 4
      AND ts_utc >= ('2026-09-10'::date::timestamp AT TIME ZONE $1) AND ts_utc < ('2026-09-11'::date::timestamp AT TIME ZONE $1)`, [TZ]);
    assert.equal(n.rows[0].n, 24 * 2, 'ganzer Tag, beide Reihen');
    assert.deepEqual(await runsOnDay('2026-09-11'), before11, 'Folgetag unberührt');
    assert.equal((await client.query(SERIES_RETENTION_SQL.thinSeriesDay, ['2026-09-10', TZ])).rowCount, 0, 'idempotent');
  });

  it('ohne Eingangs-Eintrag gilt 14:30 am Vortag', async () => {
    assert.deepEqual(await runsOnDay('2026-09-11'), [2, 3, 4, 5, 6], 'Lauf 2 reicht bis 00:00');
    await client.query(SERIES_RETENTION_SQL.thinSeriesDay, ['2026-09-11', TZ]);
    assert.deepEqual(await runsOnDay('2026-09-11'), [6]);
  });

  it('Läufe: ohne Reihen und älter als der Stichtag weg, der jüngste je Optimierer bleibt', async () => {
    await client.query(`CREATE TABLE lr_runs (id bigint PRIMARY KEY, optimizer text NOT NULL, run_started_at timestamptz NOT NULL);
      CREATE TABLE lr_series (optimizer_run_id bigint NOT NULL)`);
    await client.query(`INSERT INTO lr_runs VALUES
      (10, 'eos', '2026-09-01T10:00:00Z'),    -- alt, ohne Reihen → weg
      (11, 'eos', '2026-09-01T10:05:00Z'),    -- alt, behaltener Tagesplan (Reihen) → bleibt
      (12, 'eos', '2026-09-20T10:00:00Z'),    -- nach dem Stichtag → bleibt
      (20, 'emhass', '2026-08-01T10:00:00Z'), -- alt, ohne Reihen → weg
      (21, 'emhass', '2026-08-02T10:00:00Z')  -- alt, aber jüngster emhass-Lauf → bleibt`);
    await client.query('INSERT INTO lr_series VALUES (11)');
    const text = OPTIMIZER_RUN_RETENTION_SQL.deleteRunsWithoutSeries
      .replaceAll('optimizer_run_series', 'lr_series').replaceAll('optimizer_runs', 'lr_runs');
    const del = await client.query(text, [at('2026-09-10T00:00:00Z'), 1000]);
    assert.equal(del.rowCount, 2);
    const left = (await client.query('SELECT id FROM lr_runs ORDER BY id')).rows.map((r) => Number(r.id));
    assert.deepEqual(left, [11, 12, 21]);
    assert.equal((await client.query(text, [at('2026-09-10T00:00:00Z'), 1000])).rowCount, 0, 'idempotent');
  });

  it('kein Lauf nach dem Anker: der früheste mit Werten des Tages bleibt', async () => {
    // 09.09.: Anker 08.09. 14:30 (kein Eintrag) — Lauf 1 startete 12:00 → kein Lauf danach am Vortag,
    // aber 2, 3, 4 starten am Tag selbst nach dem Anker → frühester davon (2).
    await client.query(SERIES_RETENTION_SQL.thinSeriesDay, ['2026-09-09', TZ]);
    assert.deepEqual(await runsOnDay('2026-09-09'), [2]);
  });
});
