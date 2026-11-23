// test/history-coverage-backfill.test.js — Abdeckung der eigenen 15-min-Werte
// für den Altbestand aus den Rohwerten (T14 = C, Christin 24.11.2026).
// Erwartungen von Hand nachgerechnet (Gutschrift je Probe = min(Auflösung, 90 s),
// veraltet 0, wie energy-source-rule.js localSampleCreditSeconds).
//
// SQL-Fall läuft nur mit DVHUB_TEST_PG_URL oder DATABASE_URL, sonst übersprungen.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import {
  COVERAGE_AGREE_ABS_KWH,
  COVERAGE_AGREE_REL,
  COVERAGE_CHECK_SERIES,
  COVERAGE_RAW_SERIES,
  COVERAGE_RESCAN_MS,
  COVERAGE_UPDATE_PARAMS,
  META_TYPE_SQL,
  OPEN_DAYS_SQL,
  coverageUpdateSql,
  createCoverageBackfill
} from '../services/history-backfill/coverage.js';
import { isCompleteLocalSlotRow, pickSlotSourceRow } from '../energy-source-rule.js';

// ── Ablauf (ohne Datenbank) ──────────────────────────────────────────────────

function fakeDb({ openDays = [['2026-11-02', '2026-11-01'], []], metaType = 'jsonb', fail = false } = {}) {
  const calls = [];
  let scans = 0;
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (fail) throw new Error('boom');
      if (sql === META_TYPE_SQL) return { rows: [{ data_type: metaType }] };
      if (sql === OPEN_DAYS_SQL) return { rows: (openDays[scans++] || []).map((day) => ({ day })) };
      return { rowCount: 7, rows: [] };
    }
  };
}

test('T14: je Lauf ein Tag, neueste zuerst; danach Kontroll-Scan, dann Ruhe für 24 h', async () => {
  let t = 0;
  const db = fakeDb();
  const changed = [];
  const job = createCoverageBackfill({ getDb: () => db, now: () => t, onDayUpdated: (from) => changed.push(from) });
  assert.deepEqual(await job.runOnce(), { day: '2026-11-02', updated: 7, remaining: 1 });
  const upd = db.calls.find((c) => c.params?.[0] === '2026-11-02T00:00:00.000Z');
  assert.deepEqual(upd.params, ['2026-11-02T00:00:00.000Z', '2026-11-03T00:00:00.000Z', 0.02, 0.05, COVERAGE_CHECK_SERIES, COVERAGE_RAW_SERIES]);
  assert.deepEqual(COVERAGE_UPDATE_PARAMS('a', 'b'), ['a', 'b', COVERAGE_AGREE_ABS_KWH, COVERAGE_AGREE_REL, COVERAGE_CHECK_SERIES, COVERAGE_RAW_SERIES]);
  // Nur gespeicherte Energie-Reihen, nicht etwa Ladestand oder Preise.
  assert.ok(COVERAGE_RAW_SERIES.includes('battery_discharge_w') && !COVERAGE_RAW_SERIES.includes('battery_soc_pct'));
  // Codex 14c21520: nach jedem Tag mit Änderungen den Prüfwert-Speicher der Historie verwerfen.
  assert.deepEqual(changed, ['2026-11-02T00:00:00.000Z']);
  assert.equal(upd.sql, coverageUpdateSql('jsonb'));
  assert.deepEqual(await job.runOnce(), { day: '2026-11-01', updated: 7, remaining: 0 });
  // Kontroll-Scan findet nichts mehr → fertig; ein Lauf kurz danach fragt nicht einmal.
  assert.deepEqual(await job.runOnce(), { done: true });
  const before = db.calls.length;
  t += COVERAGE_RESCAN_MS - 1;
  assert.deepEqual(await job.runOnce(), { skipped: 'done' });
  assert.equal(db.calls.length, before);
  // Nach 24 h wieder ein Kontroll-Scan.
  t += 1;
  assert.deepEqual(await job.runOnce(), { done: true });
  assert.equal(db.calls.filter((c) => c.sql === OPEN_DAYS_SQL).length, 3);
  // Spaltentyp nur einmal gelesen.
  assert.equal(db.calls.filter((c) => c.sql === META_TYPE_SQL).length, 1);
});

test('T14: TEXT-Spalte schreibt Text, Fehler meldet und liest beim nächsten Lauf neu ein', async () => {
  const db = fakeDb({ metaType: 'text' });
  const job = createCoverageBackfill({ getDb: () => db });
  await job.runOnce();
  assert.ok(db.calls.some((c) => c.sql === coverageUpdateSql('text')));
  assert.match(coverageUpdateSql('text'), /\)::text, updated_at = now\(\)/);
  assert.doesNotMatch(coverageUpdateSql('jsonb'), /\)::text, updated_at/);
  const logs = [];
  const broken = createCoverageBackfill({ getDb: () => fakeDb({ fail: true }), pushLog: (e, d) => logs.push({ e, d }) });
  assert.equal((await broken.runOnce()).error, 'boom');
  assert.equal(logs[0].e, 'history_coverage_backfill_error');
  assert.deepEqual(await createCoverageBackfill({ getDb: () => null }).runOnce(), { skipped: 'no database' });
});

// ── SQL gegen echtes PostgreSQL ──────────────────────────────────────────────

const URL = process.env.DVHUB_TEST_PG_URL || process.env.DATABASE_URL;
const skip = URL ? false : 'DVHUB_TEST_PG_URL/DATABASE_URL nicht gesetzt';

async function seedRaw(client, { startIso, endIso, stepS = 5, res = 5, scope = 'live', source = 'local_poll', series, staleEvery = 0, skip = null, metaType }) {
  const values = [];
  const params = [];
  let i = 0;
  for (let t = Date.parse(startIso); t < Date.parse(endIso); t += stepS * 1000, i += 1) {
    if (skip && t >= Date.parse(skip[0]) && t < Date.parse(skip[1])) continue;
    const meta = staleEvery && i % staleEvery === 0 ? JSON.stringify({ stale: true }) : null;
    for (const key of series) {
      params.push(key, scope, source, new Date(t).toISOString(), res, meta);
      const n = params.length;
      values.push(`($${n - 5}, $${n - 4}, $${n - 3}, $${n - 2}::timestamptz, $${n - 1}, 1000, $${n}::text::${metaType})`);
    }
  }
  for (let k = 0; k < values.length; k += 6000) {
    await client.query(`INSERT INTO timeseries_samples (series_key, scope, source, ts_utc, resolution_seconds, value_num, meta_json) VALUES ${values.slice(k, k + 6000).join(',')}`,
      params.slice(k * 6, (k + 6000) * 6));
  }
}

async function slotRow(client, slot, sourceKind = 'local_live', series = 'battery_discharge_w') {
  const { rows } = await client.query(
    `SELECT source_kind, meta_json::text AS meta, updated_at FROM energy_slots_15m
     WHERE slot_start_utc = $1 AND series_key = $2 AND source_kind = $3`,
    [slot, series, sourceKind]
  );
  return rows[0] ? { source_kind: rows[0].source_kind, meta_json: rows[0].meta, updated_at: rows[0].updated_at } : null;
}

const SERIES = ['battery_discharge_w', 'grid_import_w'];

for (const metaType of ['jsonb', 'text']) {
  test(`T14 SQL (meta_json ${metaType}): Abdeckung aus Zeitstempeln, nur mit VRM-Bestätigung gewinnt der eigene Wert`, { skip }, async () => {
    const client = new pg.Client({ connectionString: URL });
    await client.connect();
    try {
      await client.query(`CREATE TEMP TABLE timeseries_samples (id bigserial, series_key text, scope text, source text,
        ts_utc timestamptz, resolution_seconds integer, value_num double precision, meta_json ${metaType})`);
      await client.query(`CREATE TEMP TABLE energy_slots_15m (id bigserial PRIMARY KEY, slot_start_utc timestamptz, series_key text,
        source_kind text, quality text, value_num double precision, unit text, meta_json ${metaType},
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now() - interval '30 days')`);
      const slots = ['00:00', '00:15', '00:30', '00:45', '01:00', '01:15'].map((hm) => `2026-11-01T${hm}:00.000Z`);
      // Eigene und VRM-Werte je Slot; Netzbezug lokal/VRM: C passt nicht (1,0 gegen 0,5).
      const gridLocal = [0.5, 0.5, 1.0, 0.5, 0.5, 0.5];
      for (const [i, slot] of slots.entries()) {
        await client.query(`INSERT INTO energy_slots_15m (slot_start_utc, series_key, source_kind, quality, value_num, meta_json) VALUES
          ($1, 'battery_discharge_w', 'local_live', 'raw_derived', 0.25, NULL), ($1, 'battery_discharge_w', 'vrm_import', 'backfilled', 0.2, NULL),
          ($1, 'grid_import_w', 'local_live', 'raw_derived', $2, NULL), ($1, 'grid_import_w', 'vrm_import', 'backfilled', 0.5, NULL)`, [slot, gridLocal[i]]);
      }
      // E hat schon eine Abdeckung (seit 1.0.10) — bleibt, wie sie ist.
      await client.query(`UPDATE energy_slots_15m SET meta_json = '{"coverageS":777,"samples":3,"maxResS":5}'
        WHERE slot_start_utc = $1 AND source_kind = 'local_live'`, [slots[4]]);
      // F: keine Vergleichsreihe (nur Akku lokal) → nicht bestätigt.
      await client.query(`DELETE FROM energy_slots_15m WHERE slot_start_utc = $1 AND series_key = 'grid_import_w'`, [slots[5]]);
      // Rohwerte durchgehend alle 5 s ab 23:58 des Vortags (Abstand zur vorigen Probe auch am Tagesanfang),
      // in B eine Lücke 00:20–00:25.
      await seedRaw(client, { startIso: '2026-10-31T23:58:00.000Z', endIso: '2026-11-01T00:45:00.000Z', series: SERIES, skip: ['2026-11-01T00:20:00.000Z', '2026-11-01T00:25:00.000Z'], metaType });
      // D: alter Schreiber, 5,3-s-Takt mit einzeln gerundeter Auflösung 5 s (Codex 14c21520).
      await seedRaw(client, { startIso: '2026-11-01T00:45:00.000Z', endIso: '2026-11-01T01:00:00.000Z', stepS: 5.3, res: 5, series: SERIES, metaType });
      // E/F: weiter alle 5 s, jede 10. Probe veraltet (gekennzeichnet).
      await seedRaw(client, { startIso: '2026-11-01T01:00:00.000Z', endIso: '2026-11-01T01:30:00.000Z', series: SERIES, staleEvery: 10, metaType });
      // VRM-Rohwerte zählen nicht. Anderer Tag: nicht in diesem Lauf.
      await seedRaw(client, { startIso: slots[0], endIso: slots[1], stepS: 300, res: 300, scope: 'history', source: 'vrm_import', series: SERIES, metaType });
      await client.query(`INSERT INTO energy_slots_15m (slot_start_utc, series_key, source_kind, quality, value_num, meta_json)
        VALUES ('2026-11-02T00:00:00Z', 'battery_discharge_w', 'local_live', 'raw_derived', 0.01, NULL)`);

      const res = await client.query(coverageUpdateSql(metaType), COVERAGE_UPDATE_PARAMS('2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z'));
      assert.equal(res.rowCount, 9, 'A–D je 2 Reihen + F (1 Reihe), nicht E, nicht VRM, nicht der Folgetag');
      const meta = async (slot, kind = 'local_live', series = 'battery_discharge_w') => JSON.parse((await slotRow(client, slot, kind, series))?.meta_json || 'null');
      // A: 180 Abstände à 5 s = 900 s, bestätigt.
      assert.deepEqual(await meta(slots[0]), { coverageS: 900, samples: 180, maxResS: 5, coverageBackfill: 'raw' });
      assert.deepEqual(await meta(slots[0], 'local_live', 'grid_import_w'), { coverageS: 900, samples: 180, maxResS: 5, coverageBackfill: 'raw' });
      // B: 00:15–00:20 60 Proben à 5 s = 300 s; die erste nach der Lücke (00:25) überspannt 305 s → 0 s,
      // maxRes 305; danach 59 × 5 = 295 s → 595 s aus 120 Proben, nie vollständig.
      assert.deepEqual(await meta(slots[1]), { coverageS: 595, samples: 120, maxResS: 305, coverageBackfill: 'raw' });
      // C: Netzbezug passt nicht zum VRM-Import → keine Abdeckung, nur Vermerk.
      assert.deepEqual(await meta(slots[2]), { coverageBackfill: 'vrm-mismatch' });
      // D: 5,3-s-Takt — aus den Zeitstempeln 900 s (gerundete Auflösungen ergäben nur 170 × 5 = 850 s).
      const d = await meta(slots[3]);
      assert.equal(d.coverageBackfill, 'raw');
      assert.ok(Math.abs(d.coverageS - 900) < 5.31, `D coverageS ${d.coverageS}`);
      assert.equal(d.samples, 170);
      // E unverändert; F ohne Vergleichsreihe → unbestätigt.
      assert.deepEqual(await meta(slots[4]), { coverageS: 777, samples: 3, maxResS: 5 });
      assert.deepEqual(await meta(slots[5]), { coverageBackfill: 'unverified' });
      assert.equal(await meta(slots[0], 'vrm_import'), null);
      assert.equal(await meta('2026-11-02T00:00:00.000Z'), null);
      // updated_at neu → die vorberechnete Jahres-Historie rechnet den Monat neu.
      assert.ok(Date.now() - new Date((await slotRow(client, slots[0])).updated_at).getTime() < 60_000);
      // Quellwahl (energy-source-rule.js): A und D eigener Wert; B (Lücke), C (passt nicht), F weiter VRM.
      for (const [slot, expected] of [[slots[0], 'local_live'], [slots[1], 'vrm_import'], [slots[2], 'vrm_import'], [slots[3], 'local_live'], [slots[5], 'vrm_import']]) {
        const local = await slotRow(client, slot, 'local_live');
        const vrm = await slotRow(client, slot, 'vrm_import');
        const chosen = pickSlotSourceRow(new Map([['local_live', local], ['vrm_import', vrm]]), ['vrm_import', 'local_live']);
        assert.equal(chosen.source_kind, expected, slot);
      }
      assert.equal(isCompleteLocalSlotRow(await slotRow(client, slots[0])), true);
      // Idempotent: zweiter Lauf ändert nichts; offen ist nur noch der Folgetag.
      const again = await client.query(coverageUpdateSql(metaType), COVERAGE_UPDATE_PARAMS('2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z'));
      assert.equal(again.rowCount, 0);
      const open = await client.query(OPEN_DAYS_SQL);
      assert.deepEqual(open.rows.map((r) => r.day), ['2026-11-02']);
    } finally {
      await client.end();
    }
  });
}
