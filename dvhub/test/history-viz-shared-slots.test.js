// Gemeinsamer Abruf der 15-min-Energiewerte für Tag/Woche/Monat (2026-10-03):
// die Karten einer Ansicht laden energy_slots_15m einmal und bündeln selbst.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createHistoryVizAggregator } from '../services/history-viz/aggregator.js';

// Eine Monatsansicht: vier Viertelstunden einer Stunde plus eine aus der
// nächsten, zwei Reihen.
const ROWS = [
  { slot_start_utc: new Date('2026-06-10T10:00:00Z'), series_key: 'battery_discharge_w', value_num: 1 },
  { slot_start_utc: new Date('2026-06-10T10:15:00Z'), series_key: 'battery_discharge_w', value_num: 2 },
  { slot_start_utc: new Date('2026-06-10T10:30:00Z'), series_key: 'battery_discharge_w', value_num: 3 },
  { slot_start_utc: new Date('2026-06-10T10:45:00Z'), series_key: 'battery_discharge_w', value_num: 4 },
  { slot_start_utc: new Date('2026-06-10T11:00:00Z'), series_key: 'battery_discharge_w', value_num: 5 },
  { slot_start_utc: new Date('2026-06-10T10:00:00Z'), series_key: 'battery_charge_w', value_num: 7 },
];

function aggregator(queries) {
  return createHistoryVizAggregator({
    getCfg: () => ({ optimizer: { batteryCapacityWh: 10000 } }),
    pushLog() {},
    db: {
      async query(sql, params) {
        queries.push({ sql: String(sql), params });
        return { rows: /history-viz shared energy slots/.test(sql) ? ROWS : [] };
      },
    },
    telemetryStore: null,
  });
}

test('Monat: einmal laden, stündlich bündeln wie time_bucket, zweiter Abruf aus dem Zwischenspeicher', async () => {
  const queries = [];
  const agg = aggregator(queries);
  const a = await agg.getCycles({ view: 'month', date: '2026-06-15' });
  assert.equal(a.status, 200);
  const shared = queries.filter((q) => /history-viz shared energy slots/.test(q.sql));
  assert.equal(shared.length, 1, 'ein gemeinsamer Abruf');
  // 10+11 Uhr Entladung 1+2+3+4 + 5 = 15 kWh → 1,5 Zyklen bei 10 kWh
  assert.equal(a.body.totals.cycles, 1.5);

  const b = await agg.getCycles({ view: 'month', date: '2026-06-15' });
  assert.equal(b.body.totals.cycles, 1.5);
  assert.equal(queries.filter((q) => /history-viz shared energy slots/.test(q.sql)).length, 1,
    'innerhalb von 2 min keine zweite Datenbankabfrage');
});
