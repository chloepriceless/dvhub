// test/telemetry-store-pg-writeload.test.js -- Schreib-/Leselast des PG-Stores:
// series_metadata nur fuer neue Reihen (einmal je Batch, gemerkt erst nach
// COMMIT) und getStatus ohne COUNT(*).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createTelemetryStorePg } from '../telemetry-store-pg.js';

function fakePool({ failInsert = false, noTimescale = false } = {}) {
  const sql = [];
  const existing = new Set(); // Unique-Keys, die "in der Tabelle" stehen
  const client = {
    query: async (text, params) => {
      sql.push({ text: String(text).replace(/\s+/g, ' ').trim(), params });
      if (failInsert && /INSERT INTO timeseries_samples/.test(text)) throw new Error('boom');
      if (/INSERT INTO timeseries_samples/.test(text)) {
        // Wie Postgres: je Zeile des Pakets ein RETURNING, inserted = neu.
        const [k, sc, so, q, ts, r] = params;
        return { rows: k.map((_, i) => {
          const key = [k[i], sc[i], so[i], q[i], ts[i], r[i]].join('|');
          const inserted = !existing.has(key);
          existing.add(key);
          return { series_key: k[i], scope: sc[i], source: so[i], quality: q[i], ts_utc: new Date(ts[i]), resolution_seconds: r[i], inserted };
        }) };
      }
      return { rows: [] };
    },
    release: () => {}
  };
  return {
    sql,
    connect: async () => client,
    query: async (text, params) => {
      const t = String(text).replace(/\s+/g, ' ').trim();
      sql.push({ text: t, params });
      if (/approximate_row_count/.test(t)) {
        if (noTimescale) throw new Error('function approximate_row_count does not exist');
        return { rows: [{ n: params[0] === 'timeseries_samples' ? 81000000 : 1600000 }] };
      }
      if (/reltuples/.test(t)) return { rows: [{ n: 42 }] };
      if (/MAX\(ts_utc\)/.test(t)) return { rows: [{ value: '2026-09-23T14:00:00Z' }] };
      return { rows: [] };
    }
  };
}

const row = (key, ts = '2026-09-23T14:00:00Z', value = 1) => ({ seriesKey: key, scope: 'live', source: 'local_poll', ts, resolutionSeconds: 5, value, unit: 'W' });
const metaInserts = (pool) => pool.sql.filter((q) => /INSERT INTO series_metadata/.test(q.text));
const sampleInserts = (pool) => pool.sql.filter((q) => /INSERT INTO timeseries_samples/.test(q.text));
const slotInserts = (pool) => pool.sql.filter((q) => /INSERT INTO energy_slots_15m/.test(q.text));

describe('PG-Store: Schreiblast', () => {
  test('series_metadata: eine Abfrage fuer alle neuen Reihen, danach keine mehr', async () => {
    const pool = fakePool();
    const store = createTelemetryStorePg(pool);
    await store.writeSamples([row('a'), row('b'), row('a', '2026-09-23T14:00:05Z')]);
    assert.equal(metaInserts(pool).length, 1);
    assert.deepEqual(metaInserts(pool)[0].params, [['a', 'b']]);
    await store.writeSamples([row('a'), row('b')]);
    assert.equal(metaInserts(pool).length, 1, 'bekannte Reihen: kein Upsert mehr');
    await store.writeSamples([row('a'), row('c')]);
    assert.equal(metaInserts(pool).length, 2);
    assert.deepEqual(metaInserts(pool)[1].params, [['c']]);
  });

  test('ROLLBACK: Reihe wird nicht als bekannt gemerkt', async () => {
    const pool = fakePool({ failInsert: true });
    const store = createTelemetryStorePg(pool);
    await assert.rejects(store.writeSamples([row('x')]), /boom/);
    await assert.rejects(store.writeSamples([row('x')]), /boom/);
    assert.equal(metaInserts(pool).length, 2, 'nach Rollback erneut versucht');
  });
});

describe('PG-Store: getStatus ohne COUNT(*)', () => {
  test('Zeilenzahlen geschaetzt, kein COUNT', async () => {
    const pool = fakePool();
    const st = await createTelemetryStorePg(pool).getStatus();
    assert.equal(st.sampleRows, 81000000);
    assert.equal(st.eventRows, 1600000);
    assert.equal(st.lastWriteAt, '2026-09-23T14:00:00.000Z');
    assert.ok(!pool.sql.some((q) => /COUNT\(\*\)/i.test(q.text)));
  });

  test('ohne TimescaleDB: reltuples', async () => {
    const st = await createTelemetryStorePg(fakePool({ noTimescale: true })).getStatus();
    assert.equal(st.sampleRows, 42);
  });
});

describe('PG-Store: Messwerte als Paket', () => {
  test('ein INSERT fuer alle Zeilen statt einem je Zeile', async () => {
    const pool = fakePool();
    await createTelemetryStorePg(pool).writeSamples([row('a'), row('b'), row('c'), row('a', '2026-09-23T14:00:05Z')]);
    assert.equal(sampleInserts(pool).length, 1);
    assert.equal(sampleInserts(pool)[0].params[0].length, 4);
  });

  test('doppelter Schluessel im Paket: letzter Wert gespeichert, einmal gezaehlt', async () => {
    const pool = fakePool();
    // grid_import_w -> Energie-Slot im Akkumulier-Modus (zaehlt nur neue Zeilen)
    await createTelemetryStorePg(pool).writeSamples([
      row('grid_import_w', '2026-09-23T14:00:00Z', 3600),
      row('grid_import_w', '2026-09-23T14:00:00Z', 7200)
    ]);
    const ins = sampleInserts(pool)[0].params;
    assert.deepEqual(ins[0], ['grid_import_w'], 'Postgres darf dieselbe Zeile nicht zweimal treffen');
    assert.deepEqual(ins[6], [7200], 'letzter Wert gewinnt (wie frueher: INSERT, dann UPDATE)');
    const slot = slotInserts(pool);
    assert.equal(slot.length, 1);
    // Erstes Vorkommen zaehlt: 3600 W x 5 s = 0,005 kWh
    assert.ok(Math.abs(slot[0].params[4][0] - 0.005) < 1e-9, String(slot[0].params[4][0]));
  });

  test('Wiederholung derselben Zeilen addiert keine Energie (T-0079 bleibt)', async () => {
    const pool = fakePool();
    const store = createTelemetryStorePg(pool);
    const batch = [row('grid_import_w', '2026-09-23T14:00:00Z', 3600), row('pv_total_w', '2026-09-23T14:00:00Z', 1000)];
    await store.writeSamples(batch);
    assert.equal(slotInserts(pool).length, 1, 'neu: ein Slot-INSERT fuer beide Reihen');
    assert.equal(slotInserts(pool)[0].params[1].length, 2);
    await store.writeSamples(batch);
    assert.equal(slotInserts(pool).length, 1, 'Replay: kein weiterer Akkumulier-Schreibvorgang');
  });

  test('VRM-Import ersetzt Slots (replace) — auch bei Wiederholung', async () => {
    const pool = fakePool();
    const store = createTelemetryStorePg(pool);
    const vrm = { seriesKey: 'pv_total_w', scope: 'history', source: 'vrm_import', quality: 'backfilled', ts: '2026-09-23T14:00:00Z', resolutionSeconds: 900, value: 4000, unit: 'W' };
    await store.writeSamples([vrm]);
    await store.writeSamples([vrm]);
    const slots = slotInserts(pool);
    assert.equal(slots.length, 2);
    assert.match(slots[1].text, /value_num = EXCLUDED\.value_num/);
  });
});
