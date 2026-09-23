// test/telemetry-store-pg-writeload.test.js -- Schreib-/Leselast des PG-Stores:
// series_metadata nur fuer neue Reihen (einmal je Batch, gemerkt erst nach
// COMMIT) und getStatus ohne COUNT(*).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createTelemetryStorePg } from '../telemetry-store-pg.js';

function fakePool({ failInsert = false, noTimescale = false } = {}) {
  const sql = [];
  const client = {
    query: async (text, params) => {
      sql.push({ text: String(text).replace(/\s+/g, ' ').trim(), params });
      if (failInsert && /INSERT INTO timeseries_samples/.test(text)) throw new Error('boom');
      if (/INSERT INTO timeseries_samples/.test(text)) return { rows: [{ inserted: true }] };
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

const row = (key, ts = '2026-09-23T14:00:00Z') => ({ seriesKey: key, scope: 'live', source: 'local_poll', ts, resolutionSeconds: 5, value: 1, unit: 'W' });
const metaInserts = (pool) => pool.sql.filter((q) => /INSERT INTO series_metadata/.test(q.text));

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
