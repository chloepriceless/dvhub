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
  COVERAGE_RESCAN_MS,
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
  const job = createCoverageBackfill({ getDb: () => db, now: () => t });
  assert.deepEqual(await job.runOnce(), { day: '2026-11-02', updated: 7, remaining: 1 });
  const upd = db.calls.find((c) => c.params?.[0] === '2026-11-02T00:00:00.000Z');
  assert.deepEqual(upd.params, ['2026-11-02T00:00:00.000Z', '2026-11-03T00:00:00.000Z']);
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

async function seedRaw(client, { startIso, count, stepS = 5, res = 5, scope = 'live', source = 'local_poll', series = 'battery_discharge_w', staleEvery = 0, metaType }) {
  const start = Date.parse(startIso);
  for (let i = 0; i < count; i += 1) {
    const meta = staleEvery && i % staleEvery === 0 ? JSON.stringify({ stale: true }) : null;
    await client.query(
      `INSERT INTO timeseries_samples (series_key, scope, source, ts_utc, resolution_seconds, value_num, meta_json)
       VALUES ($1, $2, $3, $4, $5, 1000, $6::text::${metaType})`,
      [series, scope, source, new Date(start + i * stepS * 1000).toISOString(), res, meta]
    );
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

for (const metaType of ['jsonb', 'text']) {
  test(`T14 SQL (meta_json ${metaType}): Abdeckung wie der Live-Pfad, danach gewinnt der vollständige eigene Wert`, { skip }, async () => {
    const client = new pg.Client({ connectionString: URL });
    await client.connect();
    try {
      await client.query(`CREATE TEMP TABLE timeseries_samples (id bigserial, series_key text, scope text, source text,
        ts_utc timestamptz, resolution_seconds integer, value_num double precision, meta_json ${metaType})`);
      await client.query(`CREATE TEMP TABLE energy_slots_15m (id bigserial PRIMARY KEY, slot_start_utc timestamptz, series_key text,
        source_kind text, quality text, value_num double precision, unit text, meta_json ${metaType},
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now() - interval '30 days')`);
      const slots = ['00:00', '00:15', '00:30', '00:45', '01:00'].map((hm) => `2026-11-01T${hm}:00.000Z`);
      for (const slot of slots) {
        await client.query(`INSERT INTO energy_slots_15m (slot_start_utc, series_key, source_kind, quality, value_num, meta_json)
          VALUES ($1, 'battery_discharge_w', 'local_live', 'raw_derived', 0.25, NULL), ($1, 'battery_discharge_w', 'vrm_import', 'backfilled', 0.2, NULL)`, [slot]);
      }
      // E hat schon eine Abdeckung (seit 1.0.10) — bleibt, wie sie ist.
      await client.query(`UPDATE energy_slots_15m SET meta_json = '{"coverageS":777,"samples":3,"maxResS":5}'
        WHERE slot_start_utc = $1 AND source_kind = 'local_live'`, [slots[4]]);
      // A: 180 Proben à 5 s → 900 s, vollständig.
      await seedRaw(client, { startIso: slots[0], count: 180, metaType });
      // VRM-Rohwerte im selben Slot zählen nicht.
      await seedRaw(client, { startIso: slots[0], count: 3, stepS: 300, res: 300, scope: 'history', source: 'vrm_import', metaType });
      // B: 90 Proben → 450 s, unvollständig.
      await seedRaw(client, { startIso: slots[1], count: 90, metaType });
      // C: 180 Proben, jede 9. veraltet (20 Stück) → 160 × 5 = 800 s; eine Probe 120 s → Gutschrift 90, maxRes 120.
      await seedRaw(client, { startIso: slots[2], count: 179, staleEvery: 9, metaType });
      await seedRaw(client, { startIso: '2026-11-01T00:44:55.000Z', count: 1, res: 120, metaType });
      // D: keine Rohwerte. Anderer Tag: nicht in diesem Lauf.
      await seedRaw(client, { startIso: '2026-11-02T00:00:00.000Z', count: 10, metaType });
      await client.query(`INSERT INTO energy_slots_15m (slot_start_utc, series_key, source_kind, quality, value_num, meta_json)
        VALUES ('2026-11-02T00:00:00Z', 'battery_discharge_w', 'local_live', 'raw_derived', 0.01, NULL)`);

      const res = await client.query(coverageUpdateSql(metaType), ['2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z']);
      assert.equal(res.rowCount, 4, 'A–D, nicht E, nicht VRM, nicht der Folgetag');
      const meta = async (slot, kind) => JSON.parse((await slotRow(client, slot, kind))?.meta_json || 'null');
      assert.deepEqual(await meta(slots[0]), { coverageS: 900, samples: 180, maxResS: 5, coverageBackfill: true });
      assert.deepEqual(await meta(slots[1]), { coverageS: 450, samples: 90, maxResS: 5, coverageBackfill: true });
      // 179 Proben, 20 veraltet (i = 0, 9, …, 171) → 159 × 5 = 795 s + 90 s = 885 s, 180 Proben, längste 120 s.
      assert.deepEqual(await meta(slots[2]), { coverageS: 885, samples: 180, maxResS: 120, coverageBackfill: true });
      assert.deepEqual(await meta(slots[3]), { coverageS: 0, samples: 0, maxResS: 0, coverageBackfill: true });
      assert.deepEqual(await meta(slots[4]), { coverageS: 777, samples: 3, maxResS: 5 });
      assert.equal(await meta(slots[0], 'vrm_import'), null);
      assert.equal(await meta('2026-11-02T00:00:00.000Z'), null);
      // updated_at neu → die vorberechnete Jahres-Historie rechnet den Monat neu.
      const a = await slotRow(client, slots[0]);
      assert.ok(Date.now() - new Date(a.updated_at).getTime() < 60_000);
      // Quellwahl (energy-source-rule.js): A eigener Wert, B–D weiter VRM (wie vorher), C wegen 120-s-Probe.
      for (const [slot, expected] of [[slots[0], 'local_live'], [slots[1], 'vrm_import'], [slots[2], 'vrm_import'], [slots[3], 'vrm_import']]) {
        const local = await slotRow(client, slot, 'local_live');
        const vrm = await slotRow(client, slot, 'vrm_import');
        const chosen = pickSlotSourceRow(new Map([['local_live', local], ['vrm_import', vrm]]), ['vrm_import', 'local_live']);
        assert.equal(chosen.source_kind, expected, slot);
      }
      assert.equal(isCompleteLocalSlotRow(await slotRow(client, slots[0])), true);
      // Idempotent: zweiter Lauf ändert nichts.
      const again = await client.query(coverageUpdateSql(metaType), ['2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z']);
      assert.equal(again.rowCount, 0);
      // Offene Tage: nur noch der Folgetag.
      const open = await client.query(OPEN_DAYS_SQL);
      assert.deepEqual(open.rows.map((r) => r.day), ['2026-11-02']);
    } finally {
      await client.end();
    }
  });
}
