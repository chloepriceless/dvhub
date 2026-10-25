// test/inverter-efficiency-second-gx.test.js -- Wirkungsgrad mit zweiter GX-
// Anlage (Review 25.10.2026, P2). Seit multi-gx ist load_power_w um die
// Akkuleistung der zweiten Anlage korrigiert (polling.js: Last = gemessen −
// Akku 2, + = Laden). Die Bilanz AC = Last + Einspeisung − Bezug − AC-PV gilt
// aber fuer die von der HAUPT-GX gemessene Last. Sonst zaehlt die Entladung
// von Akku 2 als AC-Leistung des Haupt-Wechselrichters.
//
// SQL-Fall laeuft nur mit DVHUB_TEST_PG_URL oder DATABASE_URL, sonst uebersprungen.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import {
  DAILY_EFFICIENCY_SQL,
  EFFICIENCY_SERIES_KEYS,
  EFFICIENCY_BIN_EDGES
} from '../services/inverter-efficiency/daily.js';

// In CI (pg-integration) ist DATABASE_URL gesetzt; die Tests legen nur TEMP-Tabellen an.
const URL = process.env.DVHUB_TEST_PG_URL || process.env.DATABASE_URL;
const skip = URL ? false : 'DVHUB_TEST_PG_URL/DATABASE_URL nicht gesetzt';

test('Wirkungsgrad liest die Akku-2-Reihen mit, um die gemessene Last zurueckzurechnen', () => {
  assert.ok(EFFICIENCY_SERIES_KEYS.includes('second_battery_charge_w'));
  assert.ok(EFFICIENCY_SERIES_KEYS.includes('second_battery_discharge_w'));
});

// 10 min im 5-s-Takt: Haupt-Akku 2000 W DC, Haupt-WR gibt 1840 W AC ab (η 0,92).
async function seedWindow(client, startIso, { loadW, secondChargeW, secondDischargeW, measuredW }) {
  const startMs = new Date(startIso).getTime();
  const values = [];
  const params = [];
  for (let s = 0; s <= 600; s += 5) {
    const ts = new Date(startMs + s * 1000).toISOString();
    const series = {
      battery_power_w: -2000,
      load_power_w: loadW,
      grid_import_w: 0,
      grid_export_w: 0,
      pv_dc_w: 0,
      battery_soc_pct: 50,
      ...(secondChargeW == null ? {} : { second_battery_charge_w: secondChargeW, second_battery_discharge_w: secondDischargeW }),
      ...(measuredW == null ? {} : { load_measured_w: measuredW })
    };
    for (const [key, value] of Object.entries(series)) {
      params.push(key, ts, value);
      values.push(`($${params.length - 2}, 'live', $${params.length - 1}::timestamptz, $${params.length}::double precision)`);
    }
  }
  await client.query(`INSERT INTO timeseries_samples (series_key, scope, ts_utc, value_num) VALUES ${values.join(',')}`, params);
}

async function runDay(windows) {
  const client = new pg.Client({ connectionString: URL });
  await client.connect();
  try {
    await client.query('CREATE TEMP TABLE timeseries_samples (series_key text, scope text, ts_utc timestamptz, value_num double precision)');
    for (const w of windows) await seedWindow(client, w.start, w);
    const { rows } = await client.query(DAILY_EFFICIENCY_SQL, ['2026-10-20', 'Europe/Berlin', EFFICIENCY_SERIES_KEYS, 10000, EFFICIENCY_BIN_EDGES]);
    return rows;
  } finally {
    await client.end();
  }
}

test('η mit zweiter GX: Akku 2 entlaedt bzw. laedt, Haupt-WR bleibt bei 92 %', { skip }, async () => {
  const rows = await runDay([
    // Akku 2 entlaedt 1000 W ins Haus: Hauslast 2840 W = 1840 (Haupt-WR) + 1000.
    { start: '2026-10-20T00:00:00.000Z', loadW: 2840, secondChargeW: 0, secondDischargeW: 1000 },
    // Akku 2 laedt 500 W aus dem Hausnetz: Hauslast 1340 W = 1840 − 500.
    { start: '2026-10-20T03:00:00.000Z', loadW: 1340, secondChargeW: 500, secondDischargeW: 0 }
  ]);
  // AC 1840 W / Pnom 10000 W = 0,184 → Bin 9 = [0,15; 0,20).
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].bin), 9);
  assert.equal(Number(rows[0].seconds), 1200);
  // 2 × 1840 W × 600 s / 3600 = 613,33 Wh AC, 2 × 2000 W × 600 s / 3600 = 666,67 Wh DC.
  assert.ok(Math.abs(Number(rows[0].ac_wh) - 613.333) < 0.01, `ac_wh ${rows[0].ac_wh}`);
  assert.ok(Math.abs(Number(rows[0].dc_wh) - 666.667) < 0.01, `dc_wh ${rows[0].dc_wh}`);
});

test('η ohne zweite GX unveraendert (keine Akku-2-Reihen)', { skip }, async () => {
  const rows = await runDay([{ start: '2026-10-20T00:00:00.000Z', loadW: 1840 }]);
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].bin), 9);
  assert.ok(Math.abs(Number(rows[0].ac_wh) - 306.667) < 0.01);
  assert.ok(Math.abs(Number(rows[0].dc_wh) - 333.333) < 0.01);
});

test('η mit zweiter GX: gekappte Last (0 W) — die gemessene Last zaehlt, nicht das Rueckrechnen', { skip }, async () => {
  // Haupt-GX misst 1840 W, die (bis 20 s alte) Akku-2-Leistung sagt 2500 W Laden:
  // polling.js speichert max(0, 1840 − 2500) = 0. Rueckgerechnet waeren es 2500 W.
  const rows = await runDay([
    { start: '2026-10-20T00:00:00.000Z', loadW: 0, secondChargeW: 2500, secondDischargeW: 0, measuredW: 1840 }
  ]);
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].bin), 9);
  assert.ok(Math.abs(Number(rows[0].ac_wh) - 306.667) < 0.01, `ac_wh ${rows[0].ac_wh}`);
  assert.ok(Math.abs(Number(rows[0].dc_wh) - 333.333) < 0.01);
});

test('Wirkungsgrad liest die gemessene Last mit', () => {
  assert.ok(EFFICIENCY_SERIES_KEYS.includes('load_measured_w'));
});
