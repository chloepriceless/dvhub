import test from 'node:test';
import assert from 'node:assert/strict';

import { createHistoryRuntime } from '../history-runtime.js';

// Börsenerlös je Einspeisequelle: was hat die Einspeisung AUS DEM SPEICHER an
// der Börse erlöst, was die PV-DIREKT-Einspeisung — als Betrag und als ct/kWh.
// Der Sinn liegt im Unterschied der beiden Sätze: PV speist tagsüber in die
// billigen Stunden (hier 7 ct), der Speicher entlädt gezielt in die teuren
// (hier 18 ct). Ein gemeinsamer Schnitt (avgSpotPriceCtKwh) verdeckt genau das.
//
// Rot-zuerst: ohne die Aufteilung liefert getSummary die Felder nicht
// (undefined), der Test schlägt fehl; mit dem Fix müssen Slot, KPIs, Zeile
// und Chart-Reihe die Aufteilung tragen und exakt zum Gesamterlös addieren.

const PRICE_TS_PV = '2026-03-09T11:00:00.000Z';   // 7 ct — PV-Direkt-Export
const PRICE_TS_BAT = '2026-03-09T18:00:00.000Z';  // 18 ct — Speicher-Export
const PRICE_TS_NONE = '2026-03-10T11:00:00.000Z'; // kein Preis vorhanden

function slot(ts, { solarToGridKwh = 0, batteryToGridKwh = 0 }) {
  const exportKwh = solarToGridKwh + batteryToGridKwh;
  return {
    ts, importKwh: 0, exportKwh, gridKwh: 0, pvKwh: solarToGridKwh, pvAcKwh: 0,
    batteryKwh: -batteryToGridKwh, batteryChargeKwh: 0, batteryDischargeKwh: batteryToGridKwh,
    loadKwh: 0, solarDirectUseKwh: 0, solarToBatteryKwh: 0, solarToGridKwh,
    gridDirectUseKwh: 0, gridToBatteryKwh: 0, batteryDirectUseKwh: 0, batteryToGridKwh,
    selfConsumptionKwh: 0, estimated: false, incomplete: false
  };
}

function makeRuntime() {
  return createHistoryRuntime({
    store: {
      listAggregatedEnergySlots() {
        return [
          slot(PRICE_TS_PV, { solarToGridKwh: 1.0 }),
          slot(PRICE_TS_BAT, { batteryToGridKwh: 0.5 }),
          slot(PRICE_TS_NONE, { solarToGridKwh: 0.2 })
        ];
      },
      listPriceSlots() {
        return [
          { ts: PRICE_TS_PV, priceCtKwh: 7, priceEurMwh: 70 },
          { ts: PRICE_TS_BAT, priceCtKwh: 18, priceEurMwh: 180 }
        ];
      }
    },
    getPricingConfig: () => ({}),
    getCurrentDate: () => '2027-04-02'
  });
}

test('Börsenerlös wird je Einspeisequelle ausgewiesen — Speicher und PV-direkt getrennt, Summe = Gesamterlös', async () => {
  const runtime = makeRuntime();
  const summary = await runtime.getSummary({ view: 'week', date: '2026-03-09' });
  const k = summary.kpis;

  // Beträge: 1,0 kWh × 7 ct = 0,07 € (PV), 0,5 kWh × 18 ct = 0,09 € (Speicher).
  assert.equal(k.exportPvRevenueEur, 0.07);
  assert.equal(k.exportBatteryRevenueEur, 0.09);
  assert.equal(k.exportRevenueEur, 0.16);
  assert.equal(round2(k.exportPvRevenueEur + k.exportBatteryRevenueEur), k.exportRevenueEur);

  // Sätze je kWh — DAS ist die Aussage: Speicher 18 ct, PV 7 ct. Nenner sind
  // nur die BEWERTETEN kWh (1,0 bzw. 0,5) — der preislose 0,2-kWh-Slot darf den
  // PV-Satz nicht auf 5,83 drücken. (Der bestehende Gesamtschnitt
  // avgSpotPriceCtKwh teilt dagegen durch ALLE Export-kWh; das bleibt hier
  // bewusst unangetastet und ungeprüft.)
  assert.equal(k.exportPvCtKwh, 7);
  assert.equal(k.exportBatteryCtKwh, 18);
  assert.equal(k.exportPvValuedKwh, 1);
  assert.equal(k.exportBatteryValuedKwh, 0.5);

  // Der Slot ohne Preis bleibt wie beim Gesamterlös unbewertet (null), nicht 0:
  // er darf den PV-Satz nicht nach unten ziehen.
  const unpriced = summary.slots.find((s) => s.ts === PRICE_TS_NONE);
  assert.equal(unpriced.exportRevenueEur, null);
  assert.equal(unpriced.exportPvRevenueEur, null);
  assert.equal(unpriced.exportBatteryRevenueEur, null);
});

test('Zeilen und Chart-Reihen tragen die Aufteilung mit', async () => {
  const runtime = makeRuntime();
  const summary = await runtime.getSummary({ view: 'week', date: '2026-03-09' });

  // Wochenansicht → eine Zeile je Tag; der 09.03. hält beide bepreisten Slots.
  const day = summary.rows.find((r) => r.key === '2026-03-09');
  assert.ok(day, 'Zeile für 2026-03-09 fehlt');
  assert.equal(day.exportPvRevenueEur, 0.07);
  assert.equal(day.exportBatteryRevenueEur, 0.09);
  assert.equal(day.exportPvCtKwh, 7);
  assert.equal(day.exportBatteryCtKwh, 18);

  const bar = summary.charts.periodFinancialBars.find((b) => b.label === day.label);
  assert.ok(bar, 'Finanz-Balken für den Tag fehlt');
  assert.equal(bar.exportPvRevenueEur, 0.07);
  assert.equal(bar.exportBatteryRevenueEur, 0.09);

  // Ein Tag ohne Speicher-Export: Satz null, nicht 0 — es wurde nichts erlöst,
  // weil nichts eingespeist wurde, nicht weil der Preis 0 war.
  const dayNoBattery = summary.rows.find((r) => r.key === '2026-03-10');
  assert.ok(dayNoBattery);
  assert.equal(dayNoBattery.exportBatteryCtKwh, null);
});

function round2(v) { return Math.round((v + Number.EPSILON) * 100) / 100; }
