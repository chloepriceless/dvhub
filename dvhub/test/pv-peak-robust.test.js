// test/pv-peak-robust.test.js — gemessener PV-Peak für die Lizenz-Under-Report-
// Erkennung gegen eine echte PostgreSQL (Support-Fall 2026-10-15, Loxone): Der
// PV-Wert sprang mehrmals täglich für 10–60 s um +15 … +28 kW. Das rohe
// Tagesmaximum lag damit bei 52,4 kW (36 kWp) → Lizenz-Hinweis, obwohl die
// Anlage korrekt lizenziert ist.
//
// Läuft nur mit DVHUB_TEST_PG_URL (z. B. postgres://postgres:test@127.0.0.1:55432/postgres),
// sonst übersprungen — CI hat keine Datenbank.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { RECENT_PV_PEAK_SQL } from '../telemetry-store-pg.js';

const URL = process.env.DVHUB_TEST_PG_URL;
const skip = URL ? false : 'DVHUB_TEST_PG_URL nicht gesetzt';

// Tage mit 30 min Klarhimmel-Plateau bei plateauW, Abtastung alle 5 s, dazu
// je Tag ein Sprung um +20 kW für spikeS Sekunden.
async function seed(client, { days = 6, plateauW = 30000, spikeS = 60 } = {}) {
  await client.query('CREATE TEMP TABLE timeseries_samples (series_key text, ts_utc timestamptz, value_num double precision)');
  const rows = [];
  for (let d = 1; d <= days; d++) {
    const start = Date.now() - d * 86400000 - 3600000;
    for (let s = 0; s < 1800; s += 5) {
      const spike = s >= 600 && s < 600 + spikeS;
      rows.push([new Date(start + s * 1000).toISOString(), spike ? plateauW + 20000 : plateauW]);
    }
  }
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const values = chunk.map((_, j) => `('pv_total_w', $${2 * j + 1}::timestamptz, $${2 * j + 2}::double precision)`).join(',');
    await client.query(`INSERT INTO timeseries_samples VALUES ${values}`, chunk.flat());
  }
}

async function withDb(fn) {
  const client = new pg.Client({ connectionString: URL });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

test('60-s-Sprung um +20 kW hebt den Peak nicht an (5-min-Fenster, P75)', { skip }, async () => {
  await withDb(async (client) => {
    await seed(client, { spikeS: 60 });
    const { rows } = await client.query(RECENT_PV_PEAK_SQL, [14, 0.95]);
    assert.equal(Number(rows[0].day_count), 6);
    assert.equal(Number(rows[0].peak), 30000);
  });
});

test('dauerhaft höhere Leistung zählt weiter (keine Lücke für zu niedrige kWp)', { skip }, async () => {
  await withDb(async (client) => {
    await seed(client, { plateauW: 52000, spikeS: 0 });
    const { rows } = await client.query(RECENT_PV_PEAK_SQL, [14, 0.95]);
    assert.equal(Number(rows[0].peak), 52000);
  });
});

test('Sprung länger als ein Viertel des Fensters (2 min) zählt — Grenze des Filters', { skip }, async () => {
  await withDb(async (client) => {
    await seed(client, { spikeS: 120 });
    const { rows } = await client.query(RECENT_PV_PEAK_SQL, [14, 0.95]);
    assert.equal(Number(rows[0].peak), 50000);
  });
});
