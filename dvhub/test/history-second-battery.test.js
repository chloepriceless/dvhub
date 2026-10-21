// test/history-second-battery.test.js -- Akku der zweiten GX-Anlage in der
// Historie (Chrissi 21.10.2026: „kannst die Akkus dort getrennt aufzeigen“).
// Akku 2 wird je Slot, Zeile, KPI und Chart als eigene Groesse summiert; seine
// Einspeisung wird wie die des Hauptakkus mit dem Slotpreis bewertet. Der
// Gesamterloes (exportRevenueEur) kommt weiter aus dem Zaehler (exportKwh) und
// enthaelt die Akku-2-Einspeisung schon — er darf sich nicht verdoppeln.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createHistoryRuntime, createHistoryApiHandlers, SUMMARY_CACHE_VERSION } from '../history-runtime.js';

const TS_PV = '2026-03-09T11:00:00.000Z';    // 7 ct — PV laedt beide Akkus, speist ein
const TS_NIGHT = '2026-03-09T18:00:00.000Z'; // 18 ct — beide Akkus speisen ein
const TS_ONLY2 = '2026-03-10T02:00:00.000Z'; // kein Preis — nur Akku 2 versorgt das Haus

const EMPTY = {
  importKwh: 0, exportKwh: 0, gridKwh: 0, pvKwh: 0, pvAcKwh: 0, batteryKwh: 0, batteryChargeKwh: 0, batteryDischargeKwh: 0,
  loadKwh: 0, solarDirectUseKwh: 0, solarToBatteryKwh: 0, solarToGridKwh: 0, gridDirectUseKwh: 0, gridToBatteryKwh: 0,
  batteryDirectUseKwh: 0, batteryToGridKwh: 0, selfConsumptionKwh: 0,
  secondBatteryChargeKwh: 0, secondBatteryDischargeKwh: 0, secondSolarToBatteryKwh: 0, secondGridToBatteryKwh: 0,
  secondBatteryToGridKwh: 0, secondBatteryDirectUseKwh: 0,
  estimated: false, incomplete: false
};

const SLOTS = [
  {
    ...EMPTY, ts: TS_PV, pvKwh: 3, exportKwh: 1, loadKwh: 1,
    solarDirectUseKwh: 1, solarToBatteryKwh: 0.5, solarToGridKwh: 1, batteryChargeKwh: 0.5,
    secondSolarToBatteryKwh: 0.5, secondBatteryChargeKwh: 0.5
  },
  {
    ...EMPTY, ts: TS_NIGHT, exportKwh: 1.5, loadKwh: 0.7,
    batteryDischargeKwh: 0.8, batteryDirectUseKwh: 0.3, batteryToGridKwh: 0.5,
    secondBatteryDischargeKwh: 1.4, secondBatteryDirectUseKwh: 0.4, secondBatteryToGridKwh: 1
  },
  {
    ...EMPTY, ts: TS_ONLY2, loadKwh: 0.4, secondBatteryDischargeKwh: 0.4, secondBatteryDirectUseKwh: 0.4
  }
];

const stripSecond = (slot) => Object.fromEntries(Object.entries(slot).filter(([k]) => !k.startsWith('second')));

function makeRuntime(slots = SLOTS) {
  return createHistoryRuntime({
    store: {
      listAggregatedEnergySlots: () => slots.map((s) => ({ ...s })),
      listPriceSlots: () => [
        { ts: TS_PV, priceCtKwh: 7, priceEurMwh: 70 },
        { ts: TS_NIGHT, priceCtKwh: 18, priceEurMwh: 180 }
      ]
    },
    getPricingConfig: () => ({}),
    getCurrentDate: () => '2027-04-02'
  });
}

test('Cache-Version erhoeht: alte Monatsstaende ohne Akku 2 werden neu gerechnet', () => {
  assert.equal(SUMMARY_CACHE_VERSION, 2);
});

test('KPIs summieren Akku 2 getrennt und bewerten seine Einspeisung', async () => {
  const summary = await makeRuntime().getSummary({ view: 'week', date: '2026-03-09', includeSlots: true });
  const k = summary.kpis;
  assert.equal(k.secondBatteryChargeKwh, 0.5);
  assert.equal(k.secondBatteryDischargeKwh, 1.8);
  assert.equal(k.secondSolarToBatteryKwh, 0.5);
  assert.equal(k.secondGridToBatteryKwh, 0);
  assert.equal(k.secondBatteryToGridKwh, 1);
  assert.equal(k.secondBatteryDirectUseKwh, 0.8);
  // Hauptakku bleibt fuer sich.
  assert.equal(k.batteryToGridKwh, 0.5);
  assert.equal(k.batteryDischargeKwh, 0.8);
  // 1,0 kWh × 18 ct = 0,18 € aus Akku 2, 0,5 kWh × 18 ct = 0,09 € aus Akku 1.
  assert.equal(k.exportSecondBatteryRevenueEur, 0.18);
  assert.equal(k.exportSecondBatteryValuedKwh, 1);
  assert.equal(k.exportSecondBatteryCtKwh, 18);
  assert.equal(k.exportBatteryRevenueEur, 0.09);
  // Teilbetraege PV + Akku 1 + Akku 2 = Zaehler-Erloes (1,0×7 + 1,5×18 = 0,34 €).
  assert.equal(k.exportRevenueEur, 0.34);
  assert.equal(Math.round((k.exportPvRevenueEur + k.exportBatteryRevenueEur + k.exportSecondBatteryRevenueEur) * 100) / 100, 0.34);
});

test('Gesamterloes zaehlt Akku 2 nicht doppelt', async () => {
  const withSecond = await makeRuntime().getSummary({ view: 'week', date: '2026-03-09' });
  const withoutFields = await makeRuntime(SLOTS.map(stripSecond)).getSummary({ view: 'week', date: '2026-03-09' });
  assert.equal(withSecond.kpis.exportRevenueEur, withoutFields.kpis.exportRevenueEur);
  assert.equal(withSecond.kpis.netEur, withoutFields.kpis.netEur);
  assert.equal(withoutFields.kpis.exportSecondBatteryRevenueEur, 0);
  assert.equal(withoutFields.kpis.exportSecondBatteryCtKwh, null);
});

test('Akku 2 ist eigene Quelle des Hausverbrauchs: Anteile summieren sich zur Last', async () => {
  const summary = await makeRuntime().getSummary({ view: 'week', date: '2026-03-09', includeSlots: true });
  const night = summary.slots.find((s) => s.ts === TS_ONLY2);
  // Nur Akku 2 liefert: ohne ihn als Quelle bliebe der Verbrauch unversorgt (0).
  assert.equal(night.secondBatteryShareKwh, 0.4);
  assert.equal(night.batteryShareKwh, 0);
  assert.equal(night.selfConsumptionKwh, 0.4);
  const k = summary.kpis;
  const shares = k.gridShareKwh + k.pvShareKwh + k.batteryShareKwh + k.secondBatteryShareKwh;
  assert.ok(Math.abs(shares - k.loadKwh) < 0.011, `Anteile ${shares} vs. Last ${k.loadKwh}`);
});

test('Zeilen, Charts und Reihen tragen Akku 2', async () => {
  const week = await makeRuntime().getSummary({ view: 'week', date: '2026-03-09', includeSlots: true });
  const day = week.rows.find((r) => r.key === '2026-03-09');
  assert.equal(day.secondBatteryToGridKwh, 1);
  assert.equal(day.secondSolarToBatteryKwh, 0.5);
  assert.equal(day.exportSecondBatteryRevenueEur, 0.18);
  assert.equal(day.exportSecondBatteryCtKwh, 18);
  // Kombinierter Satz: (0,07 + 0,09 + 0,18) € ÷ (1,0 + 0,5 + 1,0) kWh = 13,6 ct.
  assert.equal(day.exportSpotCtKwh, 13.6);
  const combined = week.charts.periodCombinedBars.find((b) => b.label === day.label);
  assert.equal(combined.secondBatteryDirectUseKwh, 0.4);
  assert.equal(combined.secondBatteryToGridKwh, 1);
  const fin = week.charts.periodFinancialBars.find((b) => b.label === day.label);
  assert.equal(fin.exportSecondBatteryRevenueEur, 0.18);
  const energy = week.series.energy.find((e) => e.ts === TS_NIGHT);
  assert.equal(energy.secondBatteryToGridKwh, 1);
  assert.equal(energy.secondBatteryDirectUseKwh, 0.4);

  const dayView = await makeRuntime().getSummary({ view: 'day', date: '2026-03-09' });
  const line = dayView.charts.dayEnergyLines.find((l) => l.ts === TS_PV);
  assert.equal(line.secondSolarToBatteryKwh, 0.5);
  assert.equal(line.secondBatteryChargeKwh, 0.5);
});

test('Akku-Zyklen bleiben beim Hauptakku', async () => {
  const runtime = createHistoryRuntime({
    store: { listAggregatedEnergySlots: () => SLOTS.map((s) => ({ ...s })), listPriceSlots: () => [] },
    getPricingConfig: () => ({}),
    getCurrentDate: () => '2027-04-02',
    getOptimizerConfig: () => ({ batteryCapacityWh: 10000 })
  });
  const summary = await runtime.getSummary({ view: 'week', date: '2026-03-09' });
  const day = summary.rows.find((r) => r.key === '2026-03-09');
  assert.equal(day.cycles, 0.08, '0,8 kWh Entladung Akku 1 ÷ 10 kWh — Akku 2 zaehlt nicht mit');
});

test('CSV: Akku-2-Spalten nur, wenn Werte da sind', async () => {
  const csvFor = async (slots) => {
    const handlers = createHistoryApiHandlers({ historyRuntime: makeRuntime(slots), telemetryEnabled: true });
    const res = await handlers.getExportCsv({ view: 'week', date: '2026-03-09' });
    return res.rawBody.split('\r\n')[0];
  };
  const header = await csvFor(SLOTS);
  for (const col of ['Akku2_PV_zu_Akku_kWh', 'Akku2_Netz_zu_Akku_kWh', 'Akku2_direkt_kWh', 'Akku2_zu_Netz_kWh',
    'Akku2_geladen_kWh', 'Akku2_entladen_kWh', 'Erloes_Akku2_EUR']) {
    assert.ok(header.includes(col), `${col} fehlt`);
  }
  const plain = await csvFor(SLOTS.map(stripSecond));
  assert.ok(!plain.includes('Akku2'), 'ohne zweite Anlage unveraenderte Kopfzeile');
});

// Akku→Akku-Verschiebung (Codex-Gegenpruefung 21.10.2026, P2): was Akku 1 in
// Akku 2 schiebt, ist keine Versorgung des Hauses. Die Verbrauchsanteile
// rechnen mit der Entladung ohne Verschiebung; die Verschiebung wird summiert.
test('Akku→Akku-Verschiebung: summiert, aber keine Hausversorgung', async () => {
  // Haus 2 kWh: 1 kWh Netz + 1 kWh aus Akku 1; Akku 1 gibt 3 kWh ab, 2 davon in Akku 2.
  const slots = [{
    ...EMPTY, ts: TS_PV, importKwh: 1, loadKwh: 2, gridDirectUseKwh: 1,
    batteryDischargeKwh: 3, batteryDirectUseKwh: 1, secondBatteryChargeKwh: 2,
    batteryToSecondBatteryKwh: 2, secondBatteryToBatteryKwh: 0
  }];
  const summary = await makeRuntime(slots).getSummary({ view: 'day', date: '2026-03-09', includeSlots: true });
  const k = summary.kpis;
  assert.equal(k.batteryToSecondBatteryKwh, 2);
  assert.equal(k.secondBatteryToBatteryKwh, 0);
  // Quellen: Netz 1, Akku 1 netto 1 → je 1 kWh (ohne Abzug: 0,5 Netz / 1,5 Akku).
  assert.equal(k.gridShareKwh, 1);
  assert.equal(k.batteryShareKwh, 1);
  const day = summary.series.energy[0];
  assert.equal(day.batteryToSecondBatteryKwh, 2);
});

// Codex Runde 4 (21.10.2026): Akku 2 ist aus dem Hausverbrauch herausgerechnet —
// was er am Ende des Fensters mehr gespeichert hat, ist kein Verlust.
test('Ladestandsaenderung von Akku 2 kommt als eigene KPI (fuer den Gesamtverlust)', async () => {
  const runtime = createHistoryRuntime({
    store: {
      listAggregatedEnergySlots: () => SLOTS.map((s) => ({ ...s })),
      listPriceSlots: () => [],
      getSeriesBoundaryValues: async ({ seriesKey }) => (seriesKey === 'second_battery_soc_pct'
        ? { startValue: 40, endValue: 60 }
        : { startValue: null, endValue: null }),
    },
    getPricingConfig: () => ({}),
    getCurrentDate: () => '2027-04-02',
    getSecondBatteryCapacityKwh: () => 32,
  });
  const s = await runtime.getSummary({ view: 'day', date: '2026-03-09' });
  assert.equal(s.kpis.secondBatteryStoredDeltaKwh, 6.4); // (60−40) % × 32 kWh
  assert.equal(s.kpis.secondBatterySocStartPct, 40);
  assert.equal(s.kpis.secondBatterySocEndPct, 60);
});
