// test/inverter-efficiency-acpv-stale.test.js — Wechselrichter-Wirkungsgrad (daily.js):
// zweite AC-PV-Position abziehen, veraltete Proben verwerfen (Christin 24.11.2026,
// Nebenbefund T12). SQL-Fall nur mit DVHUB_TEST_PG_URL oder DATABASE_URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { DAILY_EFFICIENCY_SQL, EFFICIENCY_SERIES_KEYS, EFFICIENCY_BIN_EDGES } from '../services/inverter-efficiency/daily.js';

const URL = process.env.DVHUB_TEST_PG_URL || process.env.DATABASE_URL;
const skip = URL ? false : 'DVHUB_TEST_PG_URL/DATABASE_URL nicht gesetzt';

test('Wirkungsgrad liest PV gesamt mit (zweite AC-PV-Position)', () => {
  assert.ok(EFFICIENCY_SERIES_KEYS.includes('pv_total_w'));
});

async function seed(client, startIso, series, { stale = false, durationS = 600 } = {}) {
  const values = []; const params = [];
  const meta = stale ? JSON.stringify({ stale: true }) : null;
  for (let s = 0; s <= durationS; s += 5) {
    const ts = new Date(Date.parse(startIso) + s * 1000).toISOString();
    for (const [key, value] of Object.entries(series)) {
      params.push(key, ts, value, meta);
      const n = params.length;
      values.push(`($${n - 3}, 'live', $${n - 2}::timestamptz, $${n - 1}::double precision, $${n}::text::jsonb)`);
    }
  }
  await client.query(`INSERT INTO timeseries_samples (series_key, scope, ts_utc, value_num, meta_json) VALUES ${values.join(',')}`, params);
}

test('η: zweite AC-PV-Position (nur in PV gesamt) wird abgezogen, veraltete Proben zählen nicht', { skip }, async () => {
  const client = new pg.Client({ connectionString: URL });
  await client.connect();
  try {
    await client.query('CREATE TEMP TABLE timeseries_samples (series_key text, scope text, ts_utc timestamptz, value_num double precision, meta_json jsonb)');
    const base = { battery_power_w: -2000, grid_import_w: 0, grid_export_w: 0, pv_dc_w: 0, battery_soc_pct: 50 };
    // Akku −2000 W DC; Last 1990 W, davon 150 W aus AC-PV an der zweiten Position (keine pv_ac_l*-Reihen):
    // Wechselrichter gibt 1990 − 150 = 1840 W ab (η 0,92). Bisher: 1990 W (η 0,995).
    await seed(client, '2026-10-20T00:00:00Z', { ...base, load_power_w: 1990, pv_total_w: 150 });
    // Nach einem Lesefehler gehaltene Werte (stale) — zählen nicht, auch nicht der Abstand danach.
    await seed(client, '2026-10-20T00:10:05Z', { ...base, load_power_w: 1500, pv_total_w: 0 }, { stale: true, durationS: 300 });
    await seed(client, '2026-10-20T00:15:10Z', { ...base, load_power_w: 1990, pv_total_w: 150 }, { durationS: 10 });
    const { rows } = await client.query(DAILY_EFFICIENCY_SQL, ['2026-10-20', 'Europe/Berlin', EFFICIENCY_SERIES_KEYS, 10000, EFFICIENCY_BIN_EDGES]);
    assert.equal(rows.length, 1);
    // 600 s aus dem ersten Fenster + 10 s danach: 00:15:10 hat einen veralteten Vorgänger und zählt
    // nicht, 00:15:15 und 00:15:20 je 5 s.
    assert.equal(Number(rows[0].seconds), 610);
    // 1840 W × 610 s / 3600 = 311,78 Wh AC, 2000 W × 610 s / 3600 = 338,89 Wh DC.
    assert.ok(Math.abs(Number(rows[0].ac_wh) - 1840 * 610 / 3600) < 0.01, `ac_wh ${rows[0].ac_wh}`);
    assert.ok(Math.abs(Number(rows[0].dc_wh) - 2000 * 610 / 3600) < 0.01, `dc_wh ${rows[0].dc_wh}`);
  } finally {
    await client.end();
  }
});
