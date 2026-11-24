// test/telemetry-tiers.test.js — Datenstufen 1 min / 15 min ohne Datenbank:
// Wertregel je Reihenart, Nachzügler-Markierung, Rückfall-Grenzen.
// Die SQL-Seite prüft test/telemetry-tiers-pg.test.js gegen echtes PostgreSQL
// und test/timescale-docker.test.js gegen TimescaleDB (Community/Apache).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  tierValueKind, tierRowValue, markTierDirty, readTierFallback, tierAggregateSql, gapIntervals,
  aggregatedUntil, tierCoverage, createTelemetryTiers, TIER_DIRTY_MARK_AGE_MS, TIER_1M_TABLE, TIER_15M_TABLE,
} from '../services/telemetry-tiers.js';
import { createTelemetryStorePg } from '../telemetry-store-pg.js';

test('Wertregel: Energie-Einheiten und Zustände → letzter Wert, sonst Mittelwert (herstellerunabhängig)', () => {
  assert.equal(tierValueKind('grid_l1_w', 'W'), 'avg');
  assert.equal(tierValueKind('battery_soc_pct', '%'), 'avg');
  assert.equal(tierValueKind('grid_voltage_l1_v', 'V'), 'avg');
  assert.equal(tierValueKind('battery_grid_share_wh', 'Wh'), 'last');
  assert.equal(tierValueKind('irgendein_zaehler', 'kWh'), 'last');
  assert.equal(tierValueKind('vrm_kwh_Pc', 'KWH'), 'last');
  assert.equal(tierValueKind('ess_mode', ''), 'last');
  assert.equal(tierValueKind('tesla_charging_state', null), 'last');
  assert.equal(tierValueKind('tesla_since', null), 'last');
  // Wert, Rückfall auf den anderen, Textreihe ohne Zahl
  assert.equal(tierRowValue({ value_avg: 5.5, value_last: 11, unit: 'W' }, 'grid_l1_w'), 5.5);
  assert.equal(tierRowValue({ value_avg: 1100, value_last: 1179, unit: 'Wh' }, 'battery_grid_share_wh'), 1179);
  assert.equal(tierRowValue({ value_avg: null, value_last: 3, unit: 'W' }, 'x_w'), 3);
  assert.equal(tierRowValue({ value_avg: null, value_last: null, value_text: 'zuhause' }, 'tesla_geofence'), null);
});

test('Verdichtungs-SQL: Feinwerte < 900 s, ohne ungültige, Ersetzen nur mit mindestens so vielen Proben', () => {
  const sql = tierAggregateSql(TIER_1M_TABLE, 60);
  assert.match(sql, /resolution_seconds < 900/);
  assert.match(sql, /quality <> 'invalid'/);
  assert.match(sql, /date_bin\(interval '60 seconds'/);
  assert.match(sql, /WHERE EXCLUDED\.n >= t\.n/);
  assert.doesNotMatch(sql, /scope = ANY/);
  assert.match(tierAggregateSql(TIER_15M_TABLE, 900, { scopeFilter: true }), /scope = ANY\(\$3::text\[\]\)/);
});

function recorder({ failInsert = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql).trim().split(/\s+/).slice(0, 4).join(' '), params });
      if (failInsert && /INSERT INTO telemetry_tier_dirty/.test(sql)) { const e = new Error('relation does not exist'); e.code = '42P01'; throw e; }
      return { rows: [] };
    },
  };
}

test('markTierDirty: nur alte Feinwerte, frische Live-Werte kosten keine Abfrage', async () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  const c = recorder();
  const fresh = [{ ts: new Date(now - 60_000), resolutionSeconds: 5 }];
  assert.equal(await markTierDirty(c, fresh, now), 0);
  assert.equal(c.calls.length, 0, 'Live-Pfad: keine zusätzliche Abfrage');
  const coarse = [{ ts: new Date(now - 86400_000), resolutionSeconds: 900 }];
  assert.equal(await markTierDirty(c, coarse, now), 0, 'VRM/Preise (900 s) betreffen die Stufen nicht');
  assert.equal(c.calls.length, 0);
  const old = [{ ts: new Date(now - TIER_DIRTY_MARK_AGE_MS - 1000).toISOString(), resolutionSeconds: 5 }];
  assert.equal(await markTierDirty(c, old, now), 1);
  assert.deepEqual(c.calls.map((x) => x.sql.split(' ')[0]), ['SAVEPOINT', 'INSERT', 'RELEASE']);
});

test('markTierDirty: fehlt die Tabelle, bleibt die Schreib-Transaktion heil (ROLLBACK TO SAVEPOINT)', async () => {
  const c = recorder({ failInsert: true });
  await markTierDirty(c, [{ ts: '2026-01-01T00:00:00Z', resolutionSeconds: 5 }], Date.parse('2026-11-23T12:00:00Z'));
  assert.deepEqual(c.calls.map((x) => x.sql.split(' ').slice(0, 2).join(' ')), ['SAVEPOINT dvhub_tier_dirty', 'INSERT INTO', 'ROLLBACK TO']);
});

test('gapIntervals: nur ganze Raster-Eimer ohne Rohzeile, auch hinter einer einzelnen Rohprobe', () => {
  const H0 = Date.parse('2026-11-01T00:00:00Z');
  const M = 60_000;
  // Rohprobe bei 00:00:03 mitten in einer gelöschten Stunde: Lücke danach bleibt (Codex e6fed14e)
  assert.deepEqual(gapIntervals([H0 + 3000], H0, H0 + 60 * M, M), [[H0 + M, H0 + 60 * M]]);
  // vollständige Rohwerte: keine Lücke
  const dense = Array.from({ length: 720 }, (_, i) => H0 + i * 5000);
  assert.deepEqual(gapIntervals(dense, H0, H0 + 60 * M, M), []);
  // Anfang/Ende nicht auf dem Raster: Randeimer zählen nicht
  assert.deepEqual(gapIntervals([], H0 + 30_000, H0 + 3 * M + 10_000, M), [[H0 + M, H0 + 3 * M]]);
  // Lücke in der Mitte
  assert.deepEqual(gapIntervals([H0, H0 + 10 * M], H0, H0 + 11 * M, M), [[H0 + M, H0 + 10 * M]]);
  assert.deepEqual(gapIntervals([], H0, H0 + 30_000, M), [], 'kürzer als ein Eimer');
  // Stunden-Zeile belegt alle vier Viertelstunden (Codex d4f9ddc0)
  const Q = 15 * M;
  assert.deepEqual(gapIntervals([[H0, H0 + 4 * Q]], H0, H0 + 8 * Q, Q), [[H0 + 4 * Q, H0 + 8 * Q]]);
  assert.deepEqual(gapIntervals([[H0 + Q + 1000, H0 + Q + 6000]], H0, H0 + 3 * Q, Q), [[H0, H0 + Q], [H0 + 2 * Q, H0 + 3 * Q]]);
});

test('readTierFallback: Lücken je Reihe; wo Minutenwerte fehlen, 15-min-Werte', async () => {
  const calls = [];
  const H0 = Date.parse('2026-11-01T00:00:00Z');
  const db = {
    async query(sql, params) {
      calls.push({ table: /timeseries_samples_1m/.test(sql) ? '1m' : '15m', params });
      if (/timeseries_samples_1m/.test(sql)) {
        // Minutenwerte erst ab 00:30 (davor gelöscht)
        return { rows: Array.from({ length: 30 }, (_, i) => ({ series_key: 'a', b: new Date(H0 + (30 + i) * 60_000), value_avg: 1, unit: 'W' })) };
      }
      return { rows: [{ series_key: 'a', b: new Date(H0), value_avg: 2, unit: 'W' },
        { series_key: 'fremd', b: new Date(H0), value_avg: 9 }] };
    },
  };
  const out = await readTierFallback(db, {
    keys: ['a'], rawTimesByKey: new Map([['a', [H0 + 60 * 60_000 + 7000]]]),
    startMs: H0, endMs: H0 + 2 * 3600_000, bucketSec: 60, resLimit: 61,
  });
  assert.equal(calls[0].table, '1m');
  assert.deepEqual(calls[0].params.slice(0, 3), [['a', 'a'],
    ['2026-11-01T00:00:00.000Z', '2026-11-01T01:01:00.000Z'],
    ['2026-11-01T01:00:00.000Z', '2026-11-01T02:00:00.000Z']], 'Lücke vor und hinter dem Rohwert-Eimer');
  assert.equal(calls[0].params[5], 60);
  assert.equal(calls[0].params[6], 61, 'gleicher Auflösungsfilter wie roh');
  assert.equal(calls[1].table, '15m');
  assert.deepEqual(calls[1].params.slice(1, 3).map((x) => x[0]), ['2026-11-01T00:00:00.000Z', '2026-11-01T00:30:00.000Z'], '15-min-Werte nur vor der ersten Minute');
  assert.equal(calls[1].params[5], 900);
  assert.equal(out.filter((r) => r.tier === '15m').length, 1, 'fremde Reihe verworfen');
  assert.equal(out.filter((r) => r.tier === '1m').length, 30);
});

test('readTierFallback: ab 15-min-Raster nur die 15-min-Stufe; ohne Lücke keine Abfrage', async () => {
  const calls = [];
  const H0 = Date.parse('2026-11-01T00:00:00Z');
  const db = { async query(sql, params) { calls.push({ sql, params }); return { rows: [] }; } };
  await readTierFallback(db, { keys: ['a'], rawTimesByKey: new Map([['a', [H0 + 6 * 3600_000]]]), startMs: H0, endMs: H0 + 86400_000, bucketSec: 900 });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /timeseries_samples_15m/);
  calls.length = 0;
  const quarters = Array.from({ length: 96 }, (_, i) => H0 + i * 900_000);
  await readTierFallback(db, { keys: ['a'], rawTimesByKey: new Map([['a', quarters]]), startMs: H0, endMs: H0 + 86400_000, bucketSec: 900 });
  assert.equal(calls.length, 0, 'jeder Eimer hat einen Rohwert');
});

test('Verdichter: scope-Liste wird erst UNTER der Zustandssperre gelesen (Codex e6fed14e)', async () => {
  const order = [];
  const client = {
    async query(sql) {
      const t = String(sql);
      if (/FOR UPDATE SKIP LOCKED/.test(t)) { order.push('lock'); return { rows: [{ done_until: new Date('2026-11-20T00:00:00Z') }] }; }
      if (/WITH RECURSIVE s/.test(t)) { order.push('scopes'); return { rows: [{ scope: 'live' }] }; }
      if (/telemetry_tier_dirty ORDER BY/.test(t)) return { rows: [] };
      if (/INSERT INTO timeseries_samples_1m/.test(t)) return { rowCount: 5, rows: [] };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const db = {
    async connect() { return client; },
    async query(sql) {
      if (/pg_extension/.test(sql)) return { rows: [] };          // ohne TimescaleDB
      if (/timescaledb_information/.test(sql)) throw new Error('keine TimescaleDB');
      if (/telemetry_tier_state s/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };
  const tiers = createTelemetryTiers({ getDb: () => db, now: () => Date.parse('2026-11-20T03:00:00Z') });
  await tiers.runOnce({ budget: 0 });
  assert.deepEqual(order.slice(0, 2), ['lock', 'scopes']);
});

test('aggregatedUntil: min(Zeiger, ältester Nachzügler); ohne Tabelle null', async () => {
  const db = (row) => ({ async query() { return { rows: row ? [row] : [] }; } });
  assert.equal(await aggregatedUntil(db({ done_until: new Date('2026-11-23T10:00:00Z'), dirty_from: null, dirty_n: 0 })), '2026-11-23T10:00:00.000Z');
  assert.equal(await aggregatedUntil(db({ done_until: new Date('2026-11-23T10:00:00Z'), dirty_from: new Date('2026-11-20T08:15:00Z'), dirty_n: 2 })), '2026-11-20T08:15:00.000Z');
  assert.equal(await aggregatedUntil(db({ done_until: null, dirty_from: null, dirty_n: 0 })), null, 'noch kein Lauf');
  assert.equal(await aggregatedUntil(db(null)), null);
  const missing = { async query() { const e = new Error('relation "telemetry_tier_state" does not exist'); e.code = '42P01'; throw e; } };
  assert.deepEqual(await tierCoverage(missing), { available: false, cursor: null, dirtyFrom: null, dirtyCount: 0, startedFrom: null, until: null, updatedAt: null });
  await assert.rejects(tierCoverage({ async query() { throw new Error('Verbindung weg'); } }), /Verbindung weg/);
});

test('Store-Rückfall: fehlt die Stufen-Tabelle, bleibt die Roh-Antwort und es wird 10 min nicht erneut gefragt', async () => {
  let tierQueries = 0;
  const pool = {
    async query(sql) {
      if (/timeseries_samples_1m|timeseries_samples_15m/.test(sql)) { tierQueries += 1; const e = new Error('fehlt'); e.code = '42P01'; throw e; }
      return { rows: [{ series_key: 'a', ts_utc: new Date('2026-11-01T06:00:00Z'), resolution_seconds: 5, value_num: 3, unit: 'W' }] };
    },
  };
  const store = createTelemetryStorePg(pool);
  const q = { seriesKeys: ['a'], start: '2026-11-01T00:00:00Z', end: '2026-11-01T12:00:00Z', maxResolution: 900 };
  const r1 = await store.querySeries(q);
  assert.deepEqual(r1.map((r) => r.value), [3]);
  assert.equal(tierQueries, 1);
  await store.querySeries(q);
  assert.equal(tierQueries, 1, 'gemerkt: Tabelle fehlt');
});

// Codex 2fe0149f: TeslaMate schreibt ohne Einheit — Ladezähler und Ja/Nein-Zustände als letzter Wert.
test('tierValueKind: tesla_charge_energy_added und tesla_plugged_in ohne Einheit → letzter Wert', () => {
  assert.equal(tierValueKind('tesla_charge_energy_added', null), 'last');
  assert.equal(tierValueKind('tesla_plugged_in', null), 'last');
  assert.equal(tierValueKind('tesla_charger_power', null), 'avg');
});

// Codex 2fe0149f: gescheiterte Einrichtung (Sperr-Timeout) wird wiederholt — höchstens stündlich.
test('ensureTierStorage: Fehler wird nach einer Stunde erneut versucht', async () => {
  let t = Date.parse('2026-11-24T03:00:00Z'); let fail = true; let creates = 0;
  const db = {
    async connect() { return { query: (sql) => db.query(sql), release() {} }; },
    async query(sql) {
      if (/pg_extension/.test(sql)) return { rows: [{}] };
      if (/timescaledb\.license/.test(sql)) return { rows: [{ lic: 'apache' }] };
      if (/timescaledb_information\.hypertables/.test(sql)) return { rows: [] };
      if (/create_hypertable/.test(sql)) { creates += 1; if (fail) { const e = new Error('lock timeout'); e.code = '55P03'; throw e; } return { rows: [] }; }
      if (/telemetry_tier_state/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };
  const tiers = createTelemetryTiers({ getDb: () => db, now: () => t });
  await tiers.runOnce({ budget: 0 });
  const first = creates;
  assert.ok(first > 0);
  t += 10 * 60_000; await tiers.runOnce({ budget: 0 });
  assert.equal(creates, first, 'nicht in jedem Lauf');
  fail = false; t += 60 * 60_000; await tiers.runOnce({ budget: 0 });
  assert.ok(creates > first, 'nach einer Stunde erneut');
  const after = creates;
  t += 2 * 60 * 60_000; await tiers.runOnce({ budget: 0 });
  assert.equal(creates, after, 'gelungen → nicht mehr');
});

// Codex 2fe0149f: später Rohwert mittendrin darf den Endwert aus den Stufen nicht verdrängen.
test('getSeriesBoundaryValues: spätere Stufen-Werte nach dem letzten Rohwert gewinnen', async () => {
  const start = '2026-11-01T00:00:00.000Z'; const end = '2026-11-02T00:00:00.000Z';
  const seen = [];
  const pool = {
    async query(sql, p) {
      if (/timeseries_samples_1m|timeseries_samples_15m/.test(sql)) {
        seen.push(p);
        return { rows: [{ v: Date.parse(p[1]) > Date.parse('2026-11-01T12:00:00Z') ? 80 : 50, b: '2026-11-01T23:45:00Z' }] };
      }
      return { rows: [{ start_value: 20, start_ts: '2026-11-01T00:00:05Z', end_value: 50, end_ts: '2026-11-01T12:00:00Z' }] };
    },
  };
  const out = await createTelemetryStorePg(pool).getSeriesBoundaryValues({ seriesKey: 'battery_soc_pct', start, end });
  assert.deepEqual(out, { startValue: 20, endValue: 80 });
  assert.equal(seen.length, 1, 'nur das Ende aus den Stufen');
  assert.ok(Date.parse(seen[0][1]) > Date.parse('2026-11-01T12:00:00Z'), 'nach dem letzten Rohwert gesucht');
});

// E2E „kleine Platte“ (24.11.): ohne Hypertable nach dem DELETE ein VACUUM (Platz wieder nutzbar).
import { pruneOneMinuteTier as prune1m } from '../services/telemetry-tiers.js';
test('pruneOneMinuteTier ohne TimescaleDB: VACUUM (ANALYZE) nach dem Löschen, ohne Löschen keins', async () => {
  for (const n of [5000, 0]) {
    const calls = []; let left = n;
    const db = { async query(sql) {
      calls.push(sql.replace(/\s+/g, ' ').trim());
      if (/telemetry_tier_state s/.test(sql)) return { rows: [{ done_until: new Date('2026-11-24T00:00:00Z'), dirty_from: null, dirty_n: 0 }] };
      if (/timescaledb_information/.test(sql)) throw new Error('keine TimescaleDB');
      if (/^DELETE FROM timeseries_samples_1m/.test(sql.trim())) { const k = left; left = 0; return { rowCount: k }; }
      return { rows: [] };
    } };
    const r = await prune1m(db, { olderThan: '2026-06-01T00:00:00Z' });
    assert.equal(r.deletedRows, n);
    assert.equal(calls.includes('VACUUM (ANALYZE) timeseries_samples_1m'), n > 0, `n=${n}`);
  }
});
