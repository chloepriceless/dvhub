// Zyklenberechnung über einen Akku-Ausbau hinweg (Christin 2026-08-07).
//
// Der Bug: computeCycles() teilte jede historische Zeile durch die HEUTIGE
// Nennkapazität. Nach dem Ausbau 43 → 60 → 77 kWh sank damit rückwirkend jeder
// frühere Zyklenwert, obwohl an der Vergangenheit nichts passiert war.
//
// Zusätzlich geprüft: die KPI-Summe. Sie war früher
// Gesamtentladung ÷ heutige Kapazität und stimmte damit über einen Ausbau
// hinweg nicht einmal mit der Summe ihrer eigenen Zeilen überein.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createHistoryRuntime } from '../history-runtime.js';

const STAGES = [
  { id: 'start', startDate: '2025-11-01', capacityWh: 43000 },
  { id: 'ausbau-2', startDate: '2026-03-15', capacityWh: 60000 },
  { id: 'ausbau-3', startDate: '2026-08-01', capacityWh: 77000 }
];

// Zwei Tage, je exakt eine volle Entladung der DAMALS verbauten Kapazität:
// 43 kWh im Februar, 60 kWh im April. Beide Tage müssen als 1,00 Zyklus
// erscheinen — unabhängig davon, was heute verbaut ist.
function createStore() {
  return {
    // start/end MÜSSEN respektiert werden: reicht der Zeitraum über heute
    // hinaus, fragt der Runtime zweimal ab (Historie bis heute, Live ab heute)
    // und hängt beides aneinander. Eine Fixture, die den Filter ignoriert,
    // liefert jeden Slot doppelt und verdoppelt still alle Zyklenwerte.
    listAggregatedEnergySlots({ start, end }) {
      return SLOTS.filter((slot) => slot.ts >= start && slot.ts < end);
    },
    // Preise spielen für die Zyklen keine Rolle, der Runtime verlangt die
    // Methode aber.
    listPriceSlots() { return []; }
  };
}

const SLOTS = [
  {
    ts: '2026-02-10T11:00:00.000Z',
    importKwh: 0, exportKwh: 0, gridKwh: 0, pvKwh: 0,
    batteryKwh: 43, batteryChargeKwh: 0, batteryDischargeKwh: 43,
    loadKwh: 43, estimated: false, incomplete: false
  },
  {
    ts: '2026-04-10T11:00:00.000Z',
    importKwh: 0, exportKwh: 0, gridKwh: 0, pvKwh: 0,
    batteryKwh: 60, batteryChargeKwh: 0, batteryDischargeKwh: 60,
    loadKwh: 60, estimated: false, incomplete: false
  }
];

function runtimeWith(optimizer) {
  return createHistoryRuntime({
    store: createStore(),
    getOptimizerConfig: () => optimizer,
    getCurrentDate: () => '2026-08-07'
  });
}

test('ohne Ausbaustufen rechnet jede Zeile mit der heutigen Kapazität (der Bug)', async () => {
  // Dokumentiert das alte Verhalten, damit sichtbar bleibt, was die Stufen
  // reparieren: der Februar-Tag mit 43 kWh Entladung erscheint bei heute
  // 77 kWh Nennkapazität als 0,56 Zyklen statt als 1,00.
  const summary = await runtimeWith({ batteryCapacityWh: 77000 })
    .getSummary({ view: 'year', date: '2026-06-01' });
  const rows = Object.fromEntries(summary.rows.map((row) => [row.key, row.cycles]));
  assert.equal(rows['2026-02'], 0.56);
  assert.equal(rows['2026-04'], 0.78);
});

test('mit Ausbaustufen sieht jeder Tag die damals verbaute Kapazität', async () => {
  const summary = await runtimeWith({ batteryCapacityWh: 77000, batteryStages: STAGES })
    .getSummary({ view: 'year', date: '2026-06-01' });
  const rows = Object.fromEntries(summary.rows.map((row) => [row.key, row.cycles]));
  assert.equal(rows['2026-02'], 1);
  assert.equal(rows['2026-04'], 1);
});

test('ein späterer Ausbau verschiebt die bereits berechnete Historie nicht mehr', async () => {
  // Die eigentliche Zusage an den Betreiber: derselbe Februar-Tag liefert
  // denselben Wert, egal wie viele Ausbaustufen danach noch dazukommen.
  const vorDemAusbau = await runtimeWith({
    batteryCapacityWh: 43000,
    batteryStages: [STAGES[0]]
  }).getSummary({ view: 'year', date: '2026-06-01' });

  const nachDreiAusbauten = await runtimeWith({
    batteryCapacityWh: 77000,
    batteryStages: STAGES
  }).getSummary({ view: 'year', date: '2026-06-01' });

  const februarVorher = vorDemAusbau.rows.find((row) => row.key === '2026-02').cycles;
  const februarNachher = nachDreiAusbauten.rows.find((row) => row.key === '2026-02').cycles;
  assert.equal(februarVorher, 1);
  assert.equal(februarNachher, 1);
});

test('die KPI-Summe ist die Summe ihrer Zeilen, nicht Gesamtenergie durch eine Kapazität', async () => {
  const summary = await runtimeWith({ batteryCapacityWh: 77000, batteryStages: STAGES })
    .getSummary({ view: 'year', date: '2026-06-01' });
  const zeilensumme = summary.rows.reduce((sum, row) => sum + Number(row.cycles || 0), 0);
  assert.equal(summary.kpis.cycles, 2);
  assert.equal(Math.round(zeilensumme * 100) / 100, summary.kpis.cycles);
  // Der alte Weg hätte (43+60)/77 = 1,34 ergeben — beide Tage zusammen sind
  // aber nachweislich zwei volle Zyklen.
  assert.notEqual(summary.kpis.cycles, 1.34);
});

test('eine Jahreszeile mit Ausbau in der Mitte wird slot-genau gerechnet', async () => {
  // Die Ansicht "alle" fasst ein ganzes Jahr in EINE Zeile. Es gibt für sie
  // keine eine Kapazität, durch die man ihre Summe teilen dürfte.
  const summary = await runtimeWith({ batteryCapacityWh: 77000, batteryStages: STAGES })
    .getSummary({ view: 'all', date: '2026-06-01' });
  const jahr = summary.rows.find((row) => row.key === '2026');
  assert.equal(jahr.cycles, 2);
});

test('ohne jede Kapazitätsangabe bleibt cycles null statt zu raten', async () => {
  const summary = await runtimeWith({})
    .getSummary({ view: 'year', date: '2026-06-01' });
  assert.equal(summary.kpis.cycles, null);
  for (const row of summary.rows) assert.equal(row.cycles, null);
});

test('die KPI-Kachel zeigt weiterhin die HEUTE gültige Nennkapazität', async () => {
  // Sie beschriftet den Akku, nicht den Zeitraum — 2026-08-07 liegt in der
  // dritten Stufe.
  const summary = await runtimeWith({ batteryCapacityWh: 77000, batteryStages: STAGES })
    .getSummary({ view: 'year', date: '2026-06-01' });
  assert.equal(summary.kpis.batteryNominalCapacityKwh, 77);
});
