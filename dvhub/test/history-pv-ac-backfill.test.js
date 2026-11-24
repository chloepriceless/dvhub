// test/history-pv-ac-backfill.test.js — pvAcKwh für den Altbestand aus den
// Rohwerten (Christin 24.11.2026, Nebenbefund T12). Von Hand nachgerechnet.
//
// SQL-Fall läuft nur mit DVHUB_TEST_PG_URL oder DATABASE_URL, sonst übersprungen.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import {
  PV_AC_FIRST_RAW_SQL,
  PV_AC_INSERT_SQL,
  PV_AC_OPEN_DAYS_SQL,
  createPvAcBackfill
} from '../services/history-backfill/pv-ac.js';

function fakeDb({ firstDay = '2026-03-26', openDays = [['2026-11-20', '2026-11-19'], ['2026-11-20', '2026-11-19']] } = {}) {
  const calls = [];
  let scans = 0;
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql === PV_AC_FIRST_RAW_SQL) return { rows: [{ first_day: firstDay }] };
      if (sql === PV_AC_OPEN_DAYS_SQL) return { rows: (openDays[scans++] || []).map((day) => ({ day })) };
      return { rowCount: 96, rows: [] };
    }
  };
}

test('pvAc: ab dem ersten Rohdaten-Tag, nur abgeschlossene Tage, jeder Tag einmal je Prozess', async () => {
  const t = Date.parse('2026-11-24T10:00:00Z');
  const db = fakeDb();
  const changed = [];
  const job = createPvAcBackfill({ getDb: () => db, now: () => t, onDayUpdated: (d) => changed.push(d) });
  assert.deepEqual(await job.runOnce(), { day: '2026-11-20', inserted: 96, remaining: 1 });
  const scan = db.calls.find((c) => c.sql === PV_AC_OPEN_DAYS_SQL);
  // Vor gestern (UTC): bis 2026-11-23T00:00Z exklusiv.
  assert.deepEqual(scan.params, ['2026-03-26T00:00:00.000Z', '2026-11-23T00:00:00.000Z']);
  assert.deepEqual(db.calls.find((c) => c.sql === PV_AC_INSERT_SQL).params, ['2026-11-20T00:00:00.000Z', '2026-11-21T00:00:00.000Z']);
  assert.equal((await job.runOnce()).day, '2026-11-19');
  // Kontroll-Scan liefert dieselben (Slots ohne Rohwerte bleiben offen) → schon bearbeitet → fertig.
  assert.deepEqual(await job.runOnce(), { done: true });
  assert.deepEqual(changed, ['2026-11-20T00:00:00.000Z', '2026-11-19T00:00:00.000Z']);
  // Ohne eigene Rohwerte nichts zu tun.
  const none = createPvAcBackfill({ getDb: () => fakeDb({ firstDay: null }) });
  assert.deepEqual(await none.runOnce(), { done: true });
});

test('pvAc (Codex eea3b53a): ein fehlgeschlagener Tag wird beim nächsten Lauf wiederholt', async () => {
  const t = Date.parse('2026-11-24T10:00:00Z');
  const db = fakeDb({ openDays: [['2026-11-20'], ['2026-11-20'], []] });
  let fail = true;
  const flaky = { calls: db.calls, async query(sql, params) {
    if (sql === PV_AC_INSERT_SQL && fail) { fail = false; throw new Error('timeout'); }
    return db.query(sql, params);
  } };
  const job = createPvAcBackfill({ getDb: () => flaky, now: () => t });
  assert.equal((await job.runOnce()).error, 'timeout');
  assert.deepEqual(await job.runOnce(), { day: '2026-11-20', inserted: 96, remaining: 0 });
});

const URL = process.env.DVHUB_TEST_PG_URL || process.env.DATABASE_URL;
const skip = URL ? false : 'DVHUB_TEST_PG_URL/DATABASE_URL nicht gesetzt';

for (const metaType of ['jsonb', 'text']) {
  test(`pvAc SQL (meta_json ${metaType}): AC-PV = PV gesamt − DC-PV je Slot, Vermerk von pv_total_w`, { skip }, async () => {
    const client = new pg.Client({ connectionString: URL });
    await client.connect();
    try {
      await client.query(`CREATE TEMP TABLE timeseries_samples (id bigserial, series_key text, scope text, source text,
        ts_utc timestamptz, resolution_seconds integer, value_num double precision, meta_json ${metaType})`);
      await client.query(`CREATE TEMP TABLE energy_slots_15m (id bigserial PRIMARY KEY, slot_start_utc timestamptz, series_key text,
        source_kind text, quality text, value_num double precision, unit text, meta_json ${metaType},
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
        UNIQUE (slot_start_utc, series_key, source_kind))`);
      const at = (hm) => `2026-11-01T${hm}:00.000Z`;
      const [A, B, C, D, E] = ['10:00', '10:15', '10:30', '10:45', '11:00'].map(at);
      const raw = async (startIso, series) => {
        const values = []; const params = [];
        for (let i = 0; i < 180; i += 1) {
          const ts = new Date(Date.parse(startIso) + i * 5000).toISOString();
          for (const [key, value] of Object.entries(series)) {
            params.push(key, ts, value);
            values.push(`($${params.length - 2}, 'live', 'local_poll', $${params.length - 1}::timestamptz, 5, $${params.length}::double precision)`);
          }
        }
        await client.query(`INSERT INTO timeseries_samples (series_key, scope, source, ts_utc, resolution_seconds, value_num) VALUES ${values.join(',')}`, params);
      };
      // A: PV gesamt 3000 W, DC 1000 W → AC 2000 W × 900 s = 0,5 kWh.
      await raw(A, { pv_total_w: 3000, pv_dc_w: 1000 });
      // B: nur AC-PV (keine DC-Reihe) 1200 W → 0,3 kWh.
      await raw(B, { pv_total_w: 1200 });
      // C: nur DC-PV → 0 kWh (Zeile mit 0, damit der Tag erledigt ist).
      await raw(C, { pv_total_w: 800, pv_dc_w: 800 });
      // D: hat schon eine eigene pv_ac_w-Zeile. E: kein eigener pv_total_w-Slot.
      await raw(D, { pv_total_w: 2000, pv_dc_w: 0 });
      await raw(E, { pv_total_w: 2000, pv_dc_w: 0 });
      // P (Codex eea3b53a): Rohwerte nur noch zur Hälfte da (Platz-Wache) — PV gesamt aus den
      // Proben 0,375 statt gespeichert 0,75 kWh → nicht eintragen.
      const P = at('11:15');
      await raw(P, { pv_total_w: 3000, pv_dc_w: 1000 });
      await client.query(`DELETE FROM timeseries_samples WHERE ts_utc >= $1::timestamptz + interval '450 seconds' AND ts_utc < $1::timestamptz + interval '900 seconds'`, [P]);
      // VRM-Rohwerte zählen nicht.
      await client.query(`INSERT INTO timeseries_samples (series_key, scope, source, ts_utc, resolution_seconds, value_num)
        VALUES ('pv_total_w', 'history', 'vrm_import', $1, 900, 99999)`, [A]);
      const meta = JSON.stringify({ coverageS: 900, samples: 180, maxResS: 5 });
      // Gespeicherte PV gesamt je Slot = Rohwerte × 900 s (A 0,75, B 0,3, C 0,2, D 0,5, P 0,75 kWh).
      for (const [slot, kwh] of [[A, 0.75], [B, 0.3], [C, 0.2], [D, 0.5], [at('11:15'), 0.75]]) {
        await client.query(`INSERT INTO energy_slots_15m (slot_start_utc, series_key, source_kind, quality, value_num, meta_json)
          VALUES ($1, 'pv_total_w', 'local_live', 'raw_derived', $3, $2::text::${metaType})`, [slot, meta, kwh]);
      }
      await client.query(`INSERT INTO energy_slots_15m (slot_start_utc, series_key, source_kind, quality, value_num, meta_json)
        VALUES ($1, 'pv_ac_w', 'local_live', 'raw_derived', 0.123, NULL), ($2, 'pv_ac_w', 'vrm_import', 'backfilled', 0.4, NULL)`, [D, A]);

      const open = await client.query(PV_AC_OPEN_DAYS_SQL, ['2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z']);
      assert.deepEqual(open.rows.map((r) => r.day), ['2026-11-01']);
      const res = await client.query(PV_AC_INSERT_SQL, ['2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z']);
      assert.equal(res.rowCount, 3, 'A, B, C — nicht D (schon da), nicht E (kein eigener PV-Slot), nicht P (Rohwerte unvollständig)');
      const { rows } = await client.query(`SELECT slot_start_utc, value_num, meta_json::text AS meta FROM energy_slots_15m
        WHERE series_key = 'pv_ac_w' AND source_kind = 'local_live' ORDER BY slot_start_utc`);
      const bySlot = new Map(rows.map((r) => [new Date(r.slot_start_utc).toISOString(), r]));
      assert.ok(Math.abs(bySlot.get(A).value_num - 0.5) < 1e-9);
      assert.ok(Math.abs(bySlot.get(B).value_num - 0.3) < 1e-9);
      assert.equal(bySlot.get(C).value_num, 0);
      assert.equal(bySlot.get(D).value_num, 0.123);
      assert.equal(bySlot.has(E), false);
      assert.deepEqual(JSON.parse(bySlot.get(A).meta), { coverageS: 900, samples: 180, maxResS: 5 });
      assert.equal(bySlot.has(at('11:15')), false);
      // Idempotent. P bleibt offen (nichts zu raten) — darum merkt sich der Job bearbeitete Tage.
      assert.equal((await client.query(PV_AC_INSERT_SQL, ['2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z'])).rowCount, 0);
      // Codex eea3b53a: solange coverage.js den Tag nicht abgeschlossen hat, ist er nicht offen.
      await client.query(`INSERT INTO energy_slots_15m (slot_start_utc, series_key, source_kind, quality, value_num, meta_json)
        VALUES ('2026-11-05T10:00:00Z', 'pv_total_w', 'local_live', 'raw_derived', 0.5, NULL)`);
      const open2 = await client.query(PV_AC_OPEN_DAYS_SQL, ['2026-11-01T00:00:00Z', '2026-11-06T00:00:00Z']);
      assert.deepEqual(open2.rows.map((r) => r.day), ['2026-11-01']);
    } finally {
      await client.end();
    }
  });
}

// Codex Integration 24.11. (P2): offen sind nur Tage, die die Abdeckung schon fertig hat. Solange sie läuft, ist der
// AC-PV-Nachtrag nicht fertig (für die Platz-Wache) und ein leerer Scan pausiert nicht 24 h.
test('pvAc isDone: erst mit fertiger Abdeckung und einem Durchgang danach; vorher kein Tages-Pausieren', async () => {
  const t = Date.parse('2026-11-24T10:00:00Z');
  let upstream = false;
  const db = fakeDb({ openDays: [[], ['2026-11-18'], []] });
  const job = createPvAcBackfill({ getDb: () => db, now: () => t, upstreamDone: () => upstream });
  const r1 = await job.runOnce();
  assert.equal(r1.done, undefined, JSON.stringify(r1));
  assert.equal(job.isDone(), false, 'Abdeckung läuft noch');
  upstream = true;
  assert.equal((await job.runOnce()).day, '2026-11-18', 'nicht 24 h pausiert, neuer Scan');
  assert.equal(job.isDone(), true, 'Durchgang nach fertiger Abdeckung');
});

// Codex 1436c2fa (P2): wird die Abdeckung WÄHREND des Scans fertig, darf dieser Scan nicht als „nach der Abdeckung“
// zählen (seine Momentaufnahme kann den zuletzt abgedeckten Tag noch nicht enthalten).
test('pvAc isDone: Vorstufen-Zustand gilt vom Beginn des Scans', async () => {
  const t = Date.parse('2026-11-24T10:00:00Z');
  let upstream = false;
  const base = fakeDb({ openDays: [[], []] });
  const db = { calls: base.calls, async query(sql, p) {
    const r = await base.query(sql, p);
    if (sql === PV_AC_OPEN_DAYS_SQL) upstream = true;   // Abdeckung wird während der Abfrage fertig
    return r;
  } };
  const job = createPvAcBackfill({ getDb: () => db, now: () => t, upstreamDone: () => upstream });
  await job.runOnce();
  assert.equal(job.isDone(), false, 'Scan begann vor dem Ende der Abdeckung');
  await job.runOnce();
  assert.equal(job.isDone(), true, 'nächster Scan beginnt nach dem Ende');
});
