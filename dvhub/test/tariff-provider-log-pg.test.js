// Anbieterpreise dauerhaft mitloggen (Christin 01.11.2026) — gegen echtes
// PostgreSQL: Upsert ohne Doppel bei wiederholtem Abruf, Abrufzeit im Eintrag,
// Auswertung gegen Day-Ahead über den echten PG-Store, und die Platz-Wache
// lässt die Anbieterpreise stehen (nur 5-s-Live-Rohwerte gehen).
//
// Läuft nur mit DVHUB_TEST_PG_URL oder DATABASE_URL (CI: pg-integration), legt
// nur TEMP-Tabellen an.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { createTelemetryStorePg } from '../telemetry-store-pg.js';
import { createTariffProviderService, SERIES_KEY } from '../services/tariff-provider/index.js';
import { clearProviderPrices } from '../services/tariff-provider/price-store.js';
import { createStorageGuard } from '../services/storage-guard.js';
import { localMidnight } from '../services/tariff-provider/common.js';

const URL = process.env.DVHUB_TEST_PG_URL || process.env.DATABASE_URL;
const skip = URL ? false : 'DVHUB_TEST_PG_URL/DATABASE_URL nicht gesetzt';
const Q = 900_000;

async function withDb(fn) {
  const client = new pg.Client({ connectionString: URL });
  await client.connect();
  try {
    await client.query(`CREATE TEMP TABLE timeseries_samples (
      id BIGSERIAL PRIMARY KEY, series_key text NOT NULL, scope text NOT NULL, source text NOT NULL, quality text NOT NULL,
      ts_utc timestamptz NOT NULL, resolution_seconds integer NOT NULL, value_num double precision, value_text text,
      unit text, meta_json jsonb, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (series_key, scope, source, quality, ts_utc, resolution_seconds))`);
    await client.query('CREATE TEMP TABLE series_metadata (series_key text PRIMARY KEY, source text NOT NULL)');
    await client.query('CREATE TEMP TABLE energy_slots_15m (series_key text, slot_start_utc timestamptz)');
    const pool = { query: (text, params) => client.query(text, params), connect: async () => ({ query: (t, p) => client.query(t, p), release() {} }) };
    return await fn(client, createTelemetryStorePg(pool), pool);
  } finally {
    await client.end();
  }
}

function dayPrices(date, fn) {
  const start = localMidnight(date).ms;
  return Array.from({ length: 96 }, (_, i) => ({ ts: start + i * Q, ctKwh: fn(i), durationMs: Q }));
}

test('PG: wiederholter Abruf ohne Doppel, geänderter Preis mit Abrufzeit und Vorwert, Auswertung gegen Day-Ahead', { skip }, async () => {
  clearProviderPrices();
  await withDb(async (client, store) => {
    // Day-Ahead wie im Betrieb (price_ct_kwh, scope live) für den 01.11.
    const start = localMidnight('2026-11-01').ms;
    await store.writeSamples(Array.from({ length: 96 }, (_, i) => ({
      seriesKey: 'price_ct_kwh', scope: 'live', source: 'epex', quality: 'raw',
      ts: new Date(start + i * Q).toISOString(), resolutionSeconds: 900, value: i / 4, unit: 'ct/kWh'
    })));
    let now = Date.parse('2026-11-01T10:00:00Z');
    // LichtBlick-artig: netto 18 ct + 1,1 × Börse, brutto mit 19 % MwSt.
    let prices = dayPrices('2026-11-01', (i) => Math.round((18 + 1.1 * (i / 4)) * 1.19 * 1e5) / 1e5);
    const writes = [];
    const ctx = {
      state: { epex: { data: [] } },
      getCfg: () => ({ userEnergyPricing: { mode: 'provider', provider: { name: 'lichtblick', priceBasis: 'gross_total', lichtblick: { email: 'kunde@example.invalid', password: 'x' } } } }),
      pushLog: () => {},
      telemetryStore: store,
      telemetrySafeWrite: (fn) => { const p = fn(); writes.push(p); return p; }
    };
    const svc = createTariffProviderService(ctx, { now: () => now, fetchLichtblick: async () => ({ provider: 'lichtblick', account: null, slots: prices }) });
    await svc.loadFromDb();

    await svc.refresh();
    await Promise.all(writes);
    now += 3_600_000;
    await svc.refresh();
    prices = prices.map((p, i) => (i === 40 ? { ...p, ctKwh: 40.5 } : p));
    now += 3_600_000;
    await svc.refresh();
    await Promise.all(writes);
    await new Promise((r) => setImmediate(r));

    const rows = (await client.query(`SELECT ts_utc, value_num, meta_json FROM timeseries_samples
      WHERE series_key = $1 AND scope = 'tariff' AND source = 'lichtblick' ORDER BY ts_utc`, [SERIES_KEY])).rows;
    assert.equal(rows.length, 96, 'eine Zeile je Viertelstunde, kein Doppel');
    assert.equal(rows[0].meta_json.fetchedAt, '2026-11-01T10:00:00.000Z');
    assert.equal(rows[0].meta_json.priceBasis, 'gross_total');
    assert.equal(rows[40].value_num, 40.5);
    assert.equal(rows[40].meta_json.fetchedAt, '2026-11-01T12:00:00.000Z');
    assert.ok(Math.abs(rows[40].meta_json.previousCtKwh - (18 + 1.1 * 10) * 1.19) < 1e-3, 'Vorwert gemerkt');
    assert.equal(writes.length, 2, 'der zweite Abruf ohne Änderung schreibt nichts');

    now = Date.parse('2026-11-02T10:00:00Z');
    const s = await svc.stats({ days: 7 });
    assert.equal(s.ok, true);
    assert.equal(s.pairs, 96);
    // ein Ausreißer (40,5 statt ~34,6) verschiebt die Gerade kaum
    assert.ok(Math.abs(s.formula.net.slope - 1.1) < 0.05, `b ${s.formula.net.slope}`);
    assert.ok(Math.abs(s.formula.net.interceptCtKwh - 18) < 0.5, `a ${s.formula.net.interceptCtKwh}`);
    assert.ok(s.formula.maxAbsDeviationCtKwh > 5, 'Ausreißer sichtbar');
  });
});

test('PG: Platz-Wache ohne TimescaleDB entfernt alte 5-s-Rohwerte, Anbieterpreise bleiben', { skip }, async () => {
  await withDb(async (client, store, pool) => {
    const old = '2025-01-10T10:00:00.000Z';
    await client.query(`INSERT INTO timeseries_samples (series_key, scope, source, quality, ts_utc, resolution_seconds, value_num) VALUES
      ('grid_total_w', 'live', 'local_poll', 'raw', $1, 5, 100),
      ($2, 'tariff', 'lichtblick', 'raw', $1, 900, 33.3),
      ('price_ct_kwh', 'live', 'epex', 'raw', $1, 900, 9.9)`, [old, SERIES_KEY]);
    await client.query("INSERT INTO energy_slots_15m VALUES ('grid_import_wh', '2026-10-31T00:00:00Z')");
    const guard = createStorageGuard({
      getDb: () => pool,
      getDataDir: () => '/',
      statfs: () => ({ blocks: 1000, bsize: 1024 * 1024, bavail: 50 }),   // 5 % frei → „wenig“
      now: () => Date.parse('2026-11-01T00:00:00Z')
    });
    const r = await guard.check();
    assert.ok(r.actions.some((a) => a.action === 'drop_raw'), JSON.stringify(r.actions));
    const left = (await client.query('SELECT series_key FROM timeseries_samples ORDER BY series_key')).rows.map((x) => x.series_key);
    assert.deepEqual(left, ['price_ct_kwh', SERIES_KEY]);
  });
});
