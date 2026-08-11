// Zyklen-Karte im History-Explorer über einen Akku-Ausbau hinweg
// (Christin 2026-08-07).
//
// Zweiter Fundort desselben Fehlers: aggregator.js las ebenfalls die HEUTIGE
// Nennkapazität und teilte die Entladeenergie ganzer Wochen/Monate/Jahre
// dadurch. Heikler als in history-runtime.js, weil hier nach Wochentagen
// gruppiert wird — nach der Gruppierung ist das Datum weg, eine Division am
// Ende könnte nur noch EINE Kapazität benutzen.
//
// Die Karte hatte bis dahin keinen einzigen Test.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createHistoryVizAggregator } from '../services/history-viz/aggregator.js';

// Je eine volle Entladung der DAMALS verbauten Kapazität: 43 kWh im Februar
// (Stufe 1), 60 kWh im April (Stufe 2). Zusammen zwei volle Zyklen.
const DISCHARGE_BUCKETS = [
  { key: 'battery_discharge_w', bucket_ts: '2026-02-10T00:00:00.000Z', kwh: 43 },
  { key: 'battery_discharge_w', bucket_ts: '2026-04-10T00:00:00.000Z', kwh: 60 }
];

const STAGES = [
  { id: 'start', startDate: '2025-11-01', capacityWh: 43000 },
  { id: 'ausbau-2', startDate: '2026-03-15', capacityWh: 60000 },
  { id: 'ausbau-3', startDate: '2026-08-01', capacityWh: 77000 }
];

function aggregatorWith(optimizer) {
  return createHistoryVizAggregator({
    getCfg: () => ({ optimizer }),
    pushLog() {},
    db: {
      // Die Zyklen-Karte stellt genau eine Abfrage; der SQL-Text interessiert
      // hier nicht, nur die zurückgegebenen Buckets.
      async query() { return { rows: DISCHARGE_BUCKETS }; }
    },
    telemetryStore: null
  });
}

test('ohne Ausbaustufen rechnet die Karte alles mit der heutigen Kapazität (der Bug)', async () => {
  const res = await aggregatorWith({ batteryCapacityWh: 77000 })
    .getCycles({ view: 'year', date: '2026-06-01' });
  assert.equal(res.status, 200);
  // 43/77 = 0,558 und 60/77 = 0,779, aufsummiert 1,337 (die Karte summiert die
  // bereits gerundeten Wochentagswerte). Beide Tage waren in Wahrheit je ein
  // voller Zyklus — die Karte zeigte zusammen nur zwei Drittel davon.
  assert.equal(res.body.totals.cycles, 1.337);
});

test('mit Ausbaustufen zählt jeder Bucket gegen die damals verbaute Kapazität', async () => {
  const res = await aggregatorWith({ batteryCapacityWh: 77000, batteryStages: STAGES })
    .getCycles({ view: 'year', date: '2026-06-01' });
  assert.equal(res.status, 200);
  assert.equal(res.body.totals.cycles, 2);
});

test('die Wochentagssummen bleiben die Summe ihrer Teile', async () => {
  const res = await aggregatorWith({ batteryCapacityWh: 77000, batteryStages: STAGES })
    .getCycles({ view: 'year', date: '2026-06-01' });
  const perDowSum = res.body.perDow.reduce((sum, row) => sum + row.cycles, 0);
  assert.equal(Math.round(perDowSum * 1000) / 1000, res.body.totals.cycles);
  // Die Energien selbst sind von der Kapazität unabhängig und dürfen sich
  // durch die Umstellung nicht verändert haben.
  assert.equal(res.body.totals.dischargedKwh, 103);
});

test('ein späterer Ausbau verschiebt die Karte für vergangene Zeiträume nicht', async () => {
  const vorher = await aggregatorWith({
    batteryCapacityWh: 43000,
    batteryStages: [STAGES[0]]
  }).getCycles({ view: 'year', date: '2026-06-01' });

  const nachher = await aggregatorWith({
    batteryCapacityWh: 77000,
    batteryStages: STAGES
  }).getCycles({ view: 'year', date: '2026-06-01' });

  // Der Februar-Bucket ist in beiden Läufen ein voller Zyklus. Im ersten Lauf
  // erbt der April-Bucket die einzige Stufe (43 kWh) und ergibt 1,395 —
  // deshalb wird hier gezielt der Februar-Wochentag verglichen.
  const dowOf = (body, ts) => {
    const idx = (new Date(ts).getUTCDay() + 6) % 7;
    return body.perDow[idx].cycles;
  };
  assert.equal(dowOf(vorher.body, '2026-02-10T00:00:00.000Z'), 1);
  assert.equal(dowOf(nachher.body, '2026-02-10T00:00:00.000Z'), 1);
});

test('die Tagesansicht bleibt abgelehnt', async () => {
  const res = await aggregatorWith({ batteryCapacityWh: 77000 })
    .getCycles({ view: 'day', date: '2026-06-01' });
  assert.equal(res.status, 400);
});
