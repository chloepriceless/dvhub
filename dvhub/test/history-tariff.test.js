// test/history-tariff.test.js — Rechenkern „dynamischer Tarif in der Historie“
// (history-tariff.js, Christin 23.11.2026). Alle Erwartungen sind von Hand
// nachgerechnet; die Rechnung steht jeweils daneben.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTariffSums,
  addSlotToTariffSums,
  finalizeTariffRow,
  finalizeTariffFits,
  finalizeSelfUse,
  computeTariffFit,
  buildScatterBins,
  buildScatterPoints,
  scatterBinIndex,
  SCATTER_MAX_POINTS
} from '../history-tariff.js';

const close = (actual, expected, msg, eps = 0.0051) => {
  assert.ok(Number.isFinite(actual), `${msg}: ${actual} ist keine Zahl`);
  assert.ok(Math.abs(actual - expected) <= eps, `${msg}: ${actual} statt ${expected}`);
};

const dyn = (over) => ({
  tariffVariable: true, tariffPriced: true, importPriceKnown: true, priceSource: 'tariff',
  tariffGroupKey: 'base|std', tariffKey: 'base', tariffLabel: 'Standard-Tarif', tariffMode: 'dynamic',
  tariffWindowId: null, tariffWindowLabel: null, tariffVatPct: 19, ...over
});

// Vier Viertelstunden im variablen Tarif, eine davon mit geschätztem Anbieterpreis.
//   1: 1 kWh × 20 ct, Börse 5      (01.03.)
//   2: 3 kWh × 10 ct, Börse −3     (01.03.)
//   3: 0 kWh × 40 ct, Börse 30     (02.03.)
//   4: 2 kWh × 25 ct, Börse 8, geschätzt (02.03.)
// Vergleichs-Festpreis 30 ct. Grundgebühr 31 €/Monat (März: 1 €/Tag), Vergleich 15,5 €/Monat (0,50 €/Tag).
function goldenSums() {
  const sums = createTariffSums({ detail: true });
  const fee = { tariffFeeEurDay: 1, tariffCompareDay: true, tariffCompareFeeEurDay: 0.5, tariffCompareCtKwh: 30 };
  addSlotToTariffSums(sums, dyn({ ...fee, tariffDate: '2026-03-01', importKwh: 1, userImportPriceCtKwh: 20, marketPriceCtKwh: 5, gridDirectUseKwh: 1 }));
  addSlotToTariffSums(sums, dyn({ ...fee, tariffDate: '2026-03-01', importKwh: 3, userImportPriceCtKwh: 10, marketPriceCtKwh: -3, gridDirectUseKwh: 1, gridToBatteryKwh: 2 }));
  addSlotToTariffSums(sums, dyn({ ...fee, tariffDate: '2026-03-02', importKwh: 0, userImportPriceCtKwh: 40, marketPriceCtKwh: 30 }));
  addSlotToTariffSums(sums, dyn({ ...fee, tariffDate: '2026-03-02', importKwh: 2, userImportPriceCtKwh: 25, marketPriceCtKwh: 8, priceSource: 'estimate', gridDirectUseKwh: 2 }));
  return sums;
}

test('Ø-Bezugspreis mengengewichtet, Ø je Viertelstunde, Ø Börse, Aufschlag — geschätzte mitgezählt (T3 a)', () => {
  const row = finalizeTariffRow(goldenSums());
  // Bezug 1 + 3 + 0 + 2 = 6 kWh; Kosten 20 + 30 + 0 + 50 = 100 ct → 16,67 ct/kWh.
  assert.equal(row.importKwh, 6);
  assert.equal(row.importCostEur, 1);
  assert.equal(row.avgImportCtKwh, 16.67);
  // (20 + 10 + 40 + 25) / 4 = 23,75 ct.
  assert.equal(row.avgSlotCtKwh, 23.75);
  // Börse mengengewichtet: (1·5 + 3·(−3) + 0 + 2·8) / 6 = 12/6 = 2,00 ct.
  assert.equal(row.avgSpotWeightedCtKwh, 2);
  // Aufschlag: (100 − 12) / 6 = 14,67 ct.
  assert.equal(row.avgMarkupCtKwh, 14.67);
  // Haus: 1 + 1 + 2 = 4 kWh, (20 + 10 + 50) / 4 = 20 ct; Akku: 2 kWh × 10 ct.
  assert.deepEqual(row.house, { importKwh: 4, avgCtKwh: 20 });
  assert.deepEqual(row.battery, { importKwh: 2, avgCtKwh: 10 });
  // Geschätzt: 1 Viertelstunde, 2 kWh von 6 = 33,33 %.
  assert.equal(row.estimatedSlots, 1);
  assert.equal(row.estimatedImportKwh, 2);
  assert.equal(row.estimatedSharePct, 33.33);
  // Festpreis 30 ct auf 6 kWh = 1,80 €, bezahlt 1,00 € → 0,80 € gespart.
  assert.deepEqual(row.fixedCompare, { slots: 4, importKwh: 6, ctKwh: 30, ctKwhWithP14a: 30, actualEur: 1, fixedEur: 1.8, savingsEur: 0.8, withoutP14a: null });
});

test('Schalter „ohne geschätzte Preise“ rechnet Ø und Vergleich ohne sie', () => {
  const row = finalizeTariffRow(goldenSums(), { excludeEstimated: true });
  // 4 kWh, 50 ct → 12,50 ct; (20 + 10 + 40)/3 = 23,33; Börse (5 − 9)/4 = −1; Aufschlag (50 + 4)/4 = 13,50.
  assert.equal(row.importKwh, 4);
  assert.equal(row.avgImportCtKwh, 12.5);
  assert.equal(row.avgSlotCtKwh, 23.33);
  assert.equal(row.avgSpotWeightedCtKwh, -1);
  assert.equal(row.avgMarkupCtKwh, 13.5);
  // Anteil der geschätzten bleibt sichtbar.
  assert.equal(row.estimatedSharePct, 33.33);
  assert.deepEqual(row.fixedCompare, { slots: 3, importKwh: 4, ctKwh: 30, ctKwhWithP14a: 30, actualEur: 0.5, fixedEur: 1.2, savingsEur: 0.7, withoutP14a: null });
});

test('Grundgebühr tageweise, getrennt vom Ø-Arbeitspreis; Vergleich mit Grundgebühr (T5)', () => {
  const row = finalizeTariffRow(goldenSums());
  // Zwei Tage à 1 € (31 €/Monat ÷ 31 Tage).
  assert.deepEqual(row.baseFee, { eur: 2, days: 2, missingDays: 0, variableEur: 2, variableDays: 2, variableMissingDays: 0 });
  // Ø-Arbeitspreis bleibt ohne Gebühr (16,67); Kosten mit Gebühr 1,00 + 2,00 = 3,00 €.
  assert.equal(row.avgImportCtKwh, 16.67);
  assert.equal(row.variableCostWithFeeEur, 3);
  // Festpreis: 1,80 + 2 × 0,50 = 2,80 €; dynamisch 1,00 + 2,00 = 3,00 € → 0,20 € mehr bezahlt.
  assert.deepEqual(row.fixedCompareWithFee, { days: 2, feeFixedEur: 1, feeActualEur: 2, fixedEur: 2.8, actualEur: 3, savingsEur: -0.2, withoutP14a: null });
});

test('Grundgebühr fehlt an einem Tag → kein Betrag mit Gebühr (statt zu niedrig)', () => {
  const sums = createTariffSums();
  addSlotToTariffSums(sums, dyn({ tariffDate: '2026-03-01', tariffFeeEurDay: 1, importKwh: 1, userImportPriceCtKwh: 20, marketPriceCtKwh: 5, tariffCompareDay: true, tariffCompareFeeEurDay: null, tariffCompareCtKwh: 30 }));
  addSlotToTariffSums(sums, dyn({ tariffDate: '2026-03-02', tariffFeeEurDay: null, importKwh: 1, userImportPriceCtKwh: 20, marketPriceCtKwh: 5 }));
  const row = finalizeTariffRow(sums);
  assert.equal(row.baseFee.missingDays, 1);
  assert.equal(row.variableCostWithFeeEur, null);
  assert.equal(row.allCostWithFeeEur, null);
  assert.equal(row.fixedCompareWithFee, null);
  assert.equal(row.compareFeeMissingDays, 1);
});

test('Festtarif und Viertelstunden ohne Preis zählen nicht in den Ø', () => {
  const sums = createTariffSums();
  addSlotToTariffSums(sums, { tariffVariable: false, importPriceKnown: true, importKwh: 5, userImportPriceCtKwh: 30, tariffDate: '2026-01-01', tariffFeeEurDay: 0.4 });
  addSlotToTariffSums(sums, dyn({ tariffPriced: false, importPriceKnown: false, importKwh: 2, userImportPriceCtKwh: 12, marketPriceCtKwh: null, tariffDate: '2026-01-02', tariffFeeEurDay: 0.5 }));
  const row = finalizeTariffRow(sums);
  assert.equal(row.variableSlots, 1);
  assert.equal(row.unpricedSlots, 1);
  assert.equal(row.pricedSlots, 0);
  assert.equal(row.avgImportCtKwh, null);
  assert.equal(row.fixedCompare, null);
  // Alle Tarife: 5 kWh × 30 ct = 1,50 € + Gebühren 0,90 € = 2,40 €.
  assert.equal(row.allImportCostEur, 1.5);
  assert.equal(row.allCostWithFeeEur, 2.4);
});

test('Formel: dynamischer Tarif ergibt b = 1,19 genau, R² = 1, netto Faktor 1 und Aufschlag 15 ct', () => {
  const sums = createTariffSums({ detail: true });
  // p = 1,19 · (s + 15), s = 0 … 19 (ganzzahlig → p exakt auf 2 Stellen).
  for (let s = 0; s < 20; s += 1) addSlotToTariffSums(sums, dyn({ importKwh: 1, userImportPriceCtKwh: Math.round(119 * (s + 15)) / 100, marketPriceCtKwh: s }));
  const { fits, overall, spotP10CtKwh, spotP90CtKwh } = finalizeTariffFits(sums);
  assert.equal(fits.length, 1);
  const f = fits[0];
  assert.equal(f.n, 20);
  // a = 1,19 · 15 = 17,85; b = 1,19; netto: 15 + 1,00·s.
  assert.deepEqual(f.fit.gross, { interceptCtKwh: 17.85, slope: 1.19 });
  assert.deepEqual(f.fit.net, { interceptCtKwh: 15, slope: 1 });
  assert.equal(f.fit.r2, 1);
  assert.equal(f.fit.markupPctGross, 19);
  assert.equal(f.fit.markupPctNet, 0);
  // Aufschlag p − s = 17,85 + 0,19·s: bei s = 0 → 17,85, bei s = 19 → 21,46.
  assert.equal(f.markupMinCtKwh, 17.85);
  assert.equal(f.markupMaxCtKwh, 21.46);
  // P10/P90 der Börse aus den 1-ct-Klassen: 20 Werte → 2. Wert = 1, 18. Wert = 17.
  assert.equal(spotP10CtKwh, 1);
  assert.equal(spotP90CtKwh, 17);
  assert.deepEqual(f.atP10, { spotCtKwh: 1, markupCtKwh: 18.04 });
  assert.deepEqual(f.atP90, { spotCtKwh: 17, markupCtKwh: 21.08 });
  assert.equal(overall.n, 20);
});

test('Formel je §14a-Fenster und nur über Börse ≥ 0; negative Preise getrennt (T10)', () => {
  const sums = createTariffSums({ detail: true });
  for (let s = 0; s < 20; s += 1) {
    addSlotToTariffSums(sums, dyn({ importKwh: 1, userImportPriceCtKwh: Math.round(119 * (s + 15)) / 100, marketPriceCtKwh: s }));
    // NT-Fenster: Netzentgelt 10 ct niedriger → a = 1,19 · 5 = 5,95.
    addSlotToTariffSums(sums, dyn({ tariffGroupKey: 'base|window1', tariffWindowId: 'window1', tariffWindowLabel: 'NT', importKwh: 1, userImportPriceCtKwh: Math.round(119 * (s + 5)) / 100, marketPriceCtKwh: s }));
  }
  // LUOX-Knick: bei s < 0 wirkt der Prozentsatz auf |s| — fünf negative Viertelstunden.
  for (let s = -5; s < 0; s += 1) {
    addSlotToTariffSums(sums, dyn({ importKwh: 2, userImportPriceCtKwh: Math.round(119 * (s + 0.03 * Math.abs(s) + 15)) / 100, marketPriceCtKwh: s }));
  }
  const { fits } = finalizeTariffFits(sums);
  const std = fits.find((f) => f.windowId == null);
  const nt = fits.find((f) => f.windowId === 'window1');
  assert.deepEqual(std.fit.gross, { interceptCtKwh: 17.85, slope: 1.19 });
  assert.equal(std.n, 20, 'negative Börse nicht im Fit');
  assert.deepEqual(nt.fit.gross, { interceptCtKwh: 5.95, slope: 1.19 });
  assert.equal(nt.windowLabel, 'NT');
  assert.equal(std.negative.n, 5);
  assert.equal(std.negative.importKwh, 10);
  // Unter 16 Paaren keine eigene Formel.
  assert.equal(std.negative.fit, null);
  assert.equal(nt.negative, null);
});

test('Formel: Prozent-Aufschlag aus den Daten (LUOX 3 % netto auf die Börse)', () => {
  const sums = createTariffSums({ detail: true });
  for (let s = 0; s < 40; s += 1) {
    addSlotToTariffSums(sums, dyn({ tariffMode: 'provider', priceSource: 'provider', importKwh: 1, userImportPriceCtKwh: Math.round(119 * (1.03 * s + 15)) / 100, marketPriceCtKwh: s }));
  }
  const [f] = finalizeTariffFits(sums).fits;
  close(f.fit.net.slope, 1.03, 'netto Faktor', 0.0005);
  close(f.fit.markupPctNet, 3, 'Prozent netto', 0.05);
  close(f.fit.markupPctGross, 22.57, 'Prozent brutto (1,19 × 1,03 = 1,2257)', 0.05);
  close(f.fit.net.interceptCtKwh, 15, 'fester Anteil netto', 0.01);
  assert.ok(f.fit.r2 > 0.9999);
});

test('computeTariffFit: unter 16 Paaren oder Börse ohne Streuung keine Formel', () => {
  assert.equal(computeTariffFit({ n: 15, sx: 0, sy: 0, sxx: 0, sxy: 0, syy: 0 }), null);
  // 16-mal Börse 5 ct: keine Steigung bestimmbar.
  assert.equal(computeTariffFit({ n: 16, sx: 80, sy: 320, sxx: 400, sxy: 1600, syy: 6400 }), null);
});

test('Streudiagramm: 1-ct-Klassen mit offenen Rändern, Min/Max, geschätzte gezählt', () => {
  assert.equal(scatterBinIndex(-80), -50);
  assert.equal(scatterBinIndex(-0.5), -1);
  assert.equal(scatterBinIndex(3.99), 3);
  assert.equal(scatterBinIndex(250), 100);
  const sums = createTariffSums({ detail: true });
  addSlotToTariffSums(sums, dyn({ importKwh: 1, userImportPriceCtKwh: 20, marketPriceCtKwh: 3.2 }));
  addSlotToTariffSums(sums, dyn({ importKwh: 3, userImportPriceCtKwh: 24, marketPriceCtKwh: 3.8, priceSource: 'estimate' }));
  addSlotToTariffSums(sums, dyn({ importKwh: 1, userImportPriceCtKwh: 140, marketPriceCtKwh: 120 }));
  const bins = buildScatterBins(finalizeTariffFits(sums).binList);
  assert.deepEqual(bins[0], { spotFromCt: 3, spotToCt: 4, n: 2, estimatedN: 1, importKwh: 4, avgSpotCt: 3.5, avgCt: 22, minCt: 20, maxCt: 24 });
  assert.equal(bins[1].spotFromCt, 100);
  assert.equal(bins[1].spotToCt, null);
  // Ohne geschätzte: Klasse 3 nur noch mit dem echten Punkt.
  const real = buildScatterBins(finalizeTariffFits(sums, { excludeEstimated: true }).binList);
  assert.deepEqual(real[0], { spotFromCt: 3, spotToCt: 4, n: 1, estimatedN: 1, importKwh: 1, avgSpotCt: 3.2, avgCt: 20, minCt: 20, maxCt: 20 });
});

test('Streudiagramm-Punkte: nur variable bepreiste Viertelstunden, höchstens 3000', () => {
  const slots = [
    dyn({ importKwh: 0.25, userImportPriceCtKwh: 22.5, marketPriceCtKwh: 4 }),
    dyn({ importKwh: 1, userImportPriceCtKwh: 22.5, marketPriceCtKwh: 4, priceSource: 'estimate' }),
    { tariffVariable: false, tariffPriced: false, importKwh: 1, userImportPriceCtKwh: 30, marketPriceCtKwh: 4 },
    dyn({ importKwh: 1, userImportPriceCtKwh: 22.5, marketPriceCtKwh: null })
  ];
  assert.deepEqual(buildScatterPoints(slots).points, [[4, 22.5, 0.25, 0], [4, 22.5, 1, 1]]);
  assert.deepEqual(buildScatterPoints(slots, { excludeEstimated: true }).points, [[4, 22.5, 0.25, 0]]);
  const many = Array.from({ length: 7000 }, (_, i) => dyn({ importKwh: 1, userImportPriceCtKwh: 20, marketPriceCtKwh: i % 30 }));
  const out = buildScatterPoints(many);
  assert.equal(out.points.length, SCATTER_MAX_POINTS);
  assert.equal(out.thinned, true);
});

// Eigenverbrauch bewertet, X = Börse:
//   Slot A: p 30, s 10 · PV direkt 2, Netz direkt 1, PV→Akku 1,5, PV→Netz 0,5
//   Slot B: p 40, s 20 · Netz direkt 0,5, Akku→Haus 1,2, Akku→Netz 0,1
function selfUseSums() {
  const sums = createTariffSums({ detail: true });
  addSlotToTariffSums(sums, { importPriceKnown: true, userImportPriceCtKwh: 30, marketPriceCtKwh: 10, importKwh: 1, solarDirectUseKwh: 2, gridDirectUseKwh: 1, solarToBatteryKwh: 1.5, solarToGridKwh: 0.5, loadKwh: 3 });
  addSlotToTariffSums(sums, { importPriceKnown: true, userImportPriceCtKwh: 40, marketPriceCtKwh: 20, importKwh: 0.5, gridDirectUseKwh: 0.5, batteryDirectUseKwh: 1.2, batteryToGridKwh: 0.1, loadKwh: 1.7 });
  return sums;
}

test('Eigenverbrauch bewertet: PV direkt, Akku mit Verlusten, p_eff (Golden, T4/T7)', () => {
  const r = finalizeSelfUse(selfUseSums().selfUse);
  // PV direkt: 2 × (30 − 10) = 40 ct.
  assert.equal(r.pvDirectGainEur, 0.4);
  assert.equal(r.pvDirectGainCtKwh, 20);
  // Laden: 1,5 kWh PV × 10 ct = 15 ct. Entladen: 1,2 × 40 + 0,1 × 20 = 50 ct. Ergebnis 35 ct.
  assert.equal(r.battery.chargeCostEur, 0.15);
  assert.equal(r.battery.dischargeValueEur, 0.5);
  assert.equal(r.battery.resultEur, 0.35);
  // Einstand 15 / 1,3 = 11,54 ct; Nutzwert 50 / 1,3 = 38,46 ct; η = 1,3 / 1,5 = 86,67 %.
  assert.equal(r.battery.inCtKwh, 11.54);
  assert.equal(r.battery.outCtKwh, 38.46);
  assert.equal(r.battery.etaPct, 86.67);
  // Last 3 + 1,7 = 4,7 kWh, Σ Last·p = 90 + 68 = 158 ct. Vorteil 75 ct.
  assert.equal(r.loadKwh, 4.7);
  assert.equal(r.advantageEur, 0.75);
  // p_eff = (158 − 75) / 4,7 = 17,66 ct; ohne Opportunität Netzkosten 50 ct / 4,7 = 10,64 ct.
  assert.equal(r.peffCtKwh, 17.66);
  assert.equal(r.peffWithoutOpportunityCtKwh, 10.64);
  assert.equal(r.exportValueBasis, 'spot');
});

test('Eigenverbrauch: Bilanz PV direkt + Akku = Σ Last·p − Σ Bezug·p + Σ Export·s − Σ PV·s', () => {
  const sums = createTariffSums({ detail: true });
  // Pseudozufällige, messfehlerfreie Flüsse über 200 Viertelstunden.
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  let lastSide = 0;
  for (let i = 0; i < 200; i += 1) {
    const p = Math.round(rnd() * 4000) / 100;
    const s = Math.round((rnd() * 30 - 5) * 100) / 100;
    const slot = {
      importPriceKnown: true, userImportPriceCtKwh: p, marketPriceCtKwh: s,
      solarDirectUseKwh: rnd(), gridDirectUseKwh: rnd(), batteryDirectUseKwh: rnd() * 0.5,
      solarToBatteryKwh: rnd() * 0.7, gridToBatteryKwh: rnd() * 0.3, batteryToGridKwh: rnd() * 0.2,
      solarToGridKwh: rnd() * 0.6, secondBatteryDirectUseKwh: rnd() * 0.1, secondGridToBatteryKwh: rnd() * 0.1
    };
    addSlotToTariffSums(sums, slot);
    const load = slot.solarDirectUseKwh + slot.gridDirectUseKwh + slot.batteryDirectUseKwh + slot.secondBatteryDirectUseKwh;
    const bezug = slot.gridDirectUseKwh + slot.gridToBatteryKwh + slot.secondGridToBatteryKwh;
    const exp = slot.solarToGridKwh + slot.batteryToGridKwh;
    const pv = slot.solarDirectUseKwh + slot.solarToBatteryKwh + slot.solarToGridKwh;
    lastSide += load * p - bezug * p + exp * s - pv * s;
  }
  const r = finalizeSelfUse(sums.selfUse);
  close(r.pvDirectGainEur + r.battery.resultEur, lastSide / 100, 'Bilanz auf 1 ct', 0.011);
  close(r.advantageEur, lastSide / 100, 'Vorteil', 0.011);
});

test('Eigenverbrauch: Ladestand am Rand zum Einstandspreis, ohne Flüsse/Preis nicht bewertet', () => {
  // ΔSoC +0,26 kWh × Einstand je geladener kWh (15 ct / 1,5 kWh = 10 ct) = 2,6 ct → 35 + 2,6 = 37,6 ct ≈ 0,38 €;
  // η = 1,3 / (1,5 − 0,26) = 104,84 %.
  const r = finalizeSelfUse(selfUseSums().selfUse, { storedDeltaKwh: 0.26 });
  assert.equal(r.battery.storedValueCtKwh, 10);
  assert.equal(r.battery.socCorrectionEur, 0.03);
  assert.equal(r.battery.resultEur, 0.38);
  assert.equal(r.battery.etaPct, 104.84);
  const sums = createTariffSums({ detail: true });
  addSlotToTariffSums(sums, { importPriceKnown: true, userImportPriceCtKwh: 30, marketPriceCtKwh: 10, loadKwh: 2 });
  addSlotToTariffSums(sums, { importPriceKnown: false, userImportPriceCtKwh: null, marketPriceCtKwh: 10, solarDirectUseKwh: 1, loadKwh: 1 });
  const s = finalizeSelfUse(sums.selfUse);
  assert.equal(s.slots, 0);
  assert.equal(s.skippedNoFlowSlots, 1);
  assert.equal(s.skippedNoPriceSlots, 1);
  assert.equal(s.peffCtKwh, null);
});

test('Summen sind JSON-fest (Ablage) und bleiben nach dem Rundlauf gleich', () => {
  const sums = goldenSums();
  const copy = JSON.parse(JSON.stringify(sums));
  assert.deepEqual(finalizeTariffRow(copy), finalizeTariffRow(sums));
  assert.deepEqual(finalizeTariffFits(copy), finalizeTariffFits(sums));
  const empty = createTariffSums({ detail: true });
  assert.deepEqual(JSON.parse(JSON.stringify(empty)), empty);
});

// Codex 39d05c79 P2: Ladestand am Rand zum Einstandspreis je GELADENER kWh.
// Verlustfrei 10 kWh zu 30 ct geladen, 1 kWh zu 30 ct entladen, ΔSoC +9 kWh → Ergebnis 0.
test('Ladestand-Ausgleich je geladener kWh: kein Scheingewinn, auch ohne Entladung', () => {
  const sums = createTariffSums({ detail: true });
  addSlotToTariffSums(sums, { importPriceKnown: true, userImportPriceCtKwh: 30, marketPriceCtKwh: 10, importKwh: 10, gridToBatteryKwh: 10 });
  addSlotToTariffSums(sums, { importPriceKnown: true, userImportPriceCtKwh: 30, marketPriceCtKwh: 10, importKwh: 0, batteryDirectUseKwh: 1, loadKwh: 1 });
  const r = finalizeSelfUse(sums.selfUse, { storedDeltaKwh: 9 });
  assert.equal(r.battery.storedValueCtKwh, 30);
  assert.equal(r.battery.resultEur, 0);
  // Ohne Entladung: 5 kWh zu 30 ct geladen, ΔSoC +5 → 0 statt −1,50 €.
  const only = createTariffSums({ detail: true });
  addSlotToTariffSums(only, { importPriceKnown: true, userImportPriceCtKwh: 30, marketPriceCtKwh: 10, importKwh: 5, gridToBatteryKwh: 5 });
  assert.equal(finalizeSelfUse(only.selfUse, { storedDeltaKwh: 5 }).battery.resultEur, 0);
});

// Codex 39d05c79 P2: Gewichte aus den ungerundeten Flüssen (tariffFlows).
test('Haus-Ø und Eigenverbrauch rechnen mit ungerundeten Flüssen', () => {
  const sums = createTariffSums({ detail: true });
  const slot = (kwh, p) => dyn({ importKwh: kwh, userImportPriceCtKwh: p, marketPriceCtKwh: 5, gridDirectUseKwh: Math.round(kwh * 100) / 100, tariffFlows: [0, kwh, 0, 0, 0, 0, 0] });
  addSlotToTariffSums(sums, slot(0.014, 20));
  addSlotToTariffSums(sums, slot(0.006, 40));
  const row = finalizeTariffRow(sums);
  // (0,014·20 + 0,006·40) / 0,02 = 26 ct — nicht 30 ct aus 0,01/0,01.
  assert.equal(row.avgImportCtKwh, 26);
  assert.equal(row.house.avgCtKwh, 26);
  assert.equal(finalizeSelfUse(sums.selfUse).peffWithoutOpportunityCtKwh, 26);
});

// Codex 39d05c79 P2: Viertelstunden-Zeilen (Tagesansicht) ohne Tagesgebühr.
test('Summen ohne Grundgebühr (Viertelstunden-Zeilen) melden keine Gebühr', () => {
  const sums = createTariffSums({ withFee: false });
  addSlotToTariffSums(sums, dyn({ tariffDate: '2026-03-01', tariffFeeEurDay: 1, importKwh: 1, userImportPriceCtKwh: 20, marketPriceCtKwh: 5 }));
  const row = finalizeTariffRow(sums);
  assert.equal(row.baseFee, null);
  assert.equal(row.variableCostWithFeeEur, null);
  assert.equal(row.allCostWithFeeEur, null);
  assert.equal(row.avgImportCtKwh, 20);
});

// ── T11 (Christin 23.11.2026): §14a Modul 3 im Festpreis-Vergleich ──────────
// Dynamisch, MwSt 19 %, Netzentgelt 10 ct netto = 11,90 ct brutto; NT-Fenster 3 ct brutto
// → Abweichung δ = 3 − 11,90 = −8,90 ct. Festpreis F = 30 ct.
//   A (Fenster): Börse 5 → p = (5 + 2)·1,19 + 3 = 11,33 ct, 2 kWh
//   B (ohne):    Börse 5 → p = (5 + 10 + 2)·1,19 = 20,23 ct, 1 kWh
function p14aSums() {
  const sums = createTariffSums({ detail: true });
  addSlotToTariffSums(sums, dyn({ importKwh: 2, userImportPriceCtKwh: 11.33, marketPriceCtKwh: 5, tariffCompareCtKwh: 30, tariffM3DeltaCtKwh: -8.9, tariffM3Active: true }));
  addSlotToTariffSums(sums, dyn({ importKwh: 1, userImportPriceCtKwh: 20.23, marketPriceCtKwh: 5, tariffCompareCtKwh: 30 }));
  return sums;
}

test('T11: Festpreis-Vergleich rechnet die §14a-Fenster mit (Festpreis + Abweichung, gleiche Mengen)', () => {
  const row = finalizeTariffRow(p14aSums());
  // Bezahlt 2·11,33 + 20,23 = 42,89 ct; Festpreis mit §14a 2·(30 − 8,90) + 30 = 72,20 ct.
  assert.equal(row.fixedCompare.actualEur, 0.43);
  assert.equal(row.fixedCompare.fixedEur, 0.72);
  assert.equal(row.fixedCompare.savingsEur, 0.29);
  assert.equal(row.fixedCompare.ctKwh, 30);
  assert.equal(row.fixedCompare.ctKwhWithP14a, 24.07);
  // Ohne §14a: dynamisch 42,89 + 17,80 = 60,69 ct, Festpreis 90 ct → 0,29 € gespart.
  assert.deepEqual(row.fixedCompare.withoutP14a, { actualEur: 0.61, fixedEur: 0.9, savingsEur: 0.29 });
  // §14a-Effekt: 2 kWh × 8,90 ct = 17,80 ct, für beide Tarife gleich.
  assert.deepEqual(row.p14a, {
    slots: 1, importKwh: 2, unknownSlots: 0,
    savedDynamicEur: 0.18, savedFixedEur: 0.18,
    avgImportCtKwhWithout: 20.23
  });
  assert.equal(row.avgImportCtKwh, 14.3);
});

test('T11: ohne aktives §14a-Fenster kein §14a-Block, Vergleich wie bisher', () => {
  const sums = createTariffSums();
  addSlotToTariffSums(sums, dyn({ importKwh: 1, userImportPriceCtKwh: 20.23, marketPriceCtKwh: 5, tariffCompareCtKwh: 30 }));
  const row = finalizeTariffRow(sums);
  assert.equal(row.p14a, null);
  assert.equal(row.fixedCompare.withoutP14a, null);
  assert.equal(row.fixedCompare.fixedEur, 0.3);
  assert.equal(row.fixedCompare.ctKwhWithP14a, 30);
});

test('T11: Abweichung unbekannt (kein Netzentgelt hinterlegt) wird gezählt, nicht geraten', () => {
  const sums = createTariffSums();
  addSlotToTariffSums(sums, dyn({ importKwh: 1, userImportPriceCtKwh: 18, marketPriceCtKwh: 5, tariffCompareCtKwh: 30, tariffM3Active: true, tariffM3DeltaCtKwh: null }));
  const row = finalizeTariffRow(sums);
  assert.equal(row.p14a.unknownSlots, 1);
  assert.equal(row.p14a.slots, 0);
  assert.equal(row.fixedCompare.fixedEur, 0.3);
});

test('T11 (Codex 3cbbdef3): „ohne §14a“ auch mit Grundgebühr, gleiche Basis wie der Vergleich', () => {
  const sums = createTariffSums();
  const fee = { tariffDate: '2026-03-01', tariffFeeEurDay: 1, tariffCompareDay: true, tariffCompareFeeEurDay: 0.5 };
  addSlotToTariffSums(sums, dyn({ ...fee, importKwh: 2, userImportPriceCtKwh: 11.33, marketPriceCtKwh: 5, tariffCompareCtKwh: 30, tariffM3DeltaCtKwh: -8.9, tariffM3Active: true }));
  addSlotToTariffSums(sums, dyn({ ...fee, importKwh: 1, userImportPriceCtKwh: 20.23, marketPriceCtKwh: 5, tariffCompareCtKwh: 30 }));
  const row = finalizeTariffRow(sums);
  // Mit Gebühr: Festpreis 0,72 + 0,50 = 1,22 €, dynamisch 0,43 + 1,00 = 1,43 €.
  assert.equal(row.fixedCompareWithFee.fixedEur, 1.22);
  assert.equal(row.fixedCompareWithFee.actualEur, 1.43);
  // Ohne §14a mit Gebühr: Festpreis 0,90 + 0,50 = 1,40 €, dynamisch 0,61 + 1,00 = 1,61 €.
  assert.deepEqual(row.fixedCompareWithFee.withoutP14a, { actualEur: 1.61, fixedEur: 1.4, savingsEur: -0.21 });
});

// ── T12: Akku-Wirkungsgrad (DC) + Systemwirkungsgrad (AC), Christin 23.11.2026 ──
// Karte (Preise), drei Viertelstunden wie polling.js sie liefert (DC am Akku als AC gezählt):
//   1: p 30, s 10 · PV 25 kWh gemessen: PV → Akku 20, PV direkt 5; Last 5
//   2: p 25, s 5  · Bezug 13,111 = 10 ÷ 0,9 (Lader) + 2; Fluss: Netz → Akku 10 (DC),
//                   Netz direkt 3,111 (Ladeverlust steckt hier); Last gemessen 2
//   3: p 40, s 20 · Akku 27 kWh DC: Akku → Netz 3 (gemessene Einspeisung), Akku → Haus 24;
//                   Last gemessen 27 × 0,92 − 3 = 21,84
// Einstand 20·10 + 10·25 = 450 ct ÷ 30 kWh = 15 ct; Netzladung 250 ct ÷ 10 kWh = 25 ct.
// Tagesjob (Mengen): eingesetzt 31,25 kWh → geladen 30 (≥ 100 W) → entladen 27 → AC 24,84;
// alle Proben geladen 30,3 / entladen 27,1, ΔSoC +1 kWh, Lader 0,90.
const IMPORT_2 = 10 / 0.9 + 2;
function systemSums() {
  const sums = createTariffSums({ detail: true });
  addSlotToTariffSums(sums, { importPriceKnown: true, userImportPriceCtKwh: 30, marketPriceCtKwh: 10, solarToBatteryKwh: 20, solarDirectUseKwh: 5, loadKwh: 5, pvKwh: 25 });
  addSlotToTariffSums(sums, { importPriceKnown: true, userImportPriceCtKwh: 25, marketPriceCtKwh: 5, importKwh: IMPORT_2, gridToBatteryKwh: 10, gridDirectUseKwh: IMPORT_2 - 10, loadKwh: 2 });
  addSlotToTariffSums(sums, { importPriceKnown: true, userImportPriceCtKwh: 40, marketPriceCtKwh: 20, batteryDirectUseKwh: 24, batteryToGridKwh: 3, loadKwh: 21.84 });
  return sums;
}
const victronCap = { measurable: true, verified: true, label: 'Victron', reason: null, note: null };
const jobRaw = { chargeKwh: 30, inputKwh: 31.25, dischargeKwh: 27, acOutKwh: 24.84, chargeAllKwh: 30.3, dischargeAllKwh: 27.1, storedDeltaKwh: 1 };
const jobTotals = { status: 'ok', reason: null, days: 30, firstDay: '2026-11-01', lastDay: '2026-11-30', hours: 690.5,
  chargeEta: 30 / 31.25, dischargeEta: 24.84 / 27, dcEta: 27.1 / 29.3, chargerEta: 0.9, converterLossKwh: 80.25, raw: jobRaw };

test('T12: Systemwirkungsgrad = Laden × Akku (DC) × Entladen, Verluste in kWh und € (nachgerechnet)', () => {
  const r = finalizeSelfUse(systemSums().selfUse, { storedDeltaKwh: 1, storage: { capability: victronCap, totals: jobTotals } });
  const sys = r.battery.system;
  // Akku (DC) der Karte wie bisher aus den Flüssen: 27 ÷ (30 − 1) = 93,10 %.
  assert.equal(r.battery.etaPct, 93.1);
  assert.equal(sys.status, 'ok');
  // Speicherweg aus den Rohwerten: Akku DC 27,1 ÷ (30,3 − 1) = 92,49 %.
  assert.equal(sys.dcEtaPct, 92.49);
  assert.equal(sys.chargeEtaPct, 96);
  assert.equal(sys.dischargeEtaPct, 92);
  assert.equal(sys.chargerEtaPct, 90);
  // 0,96 × 0,924915 × 0,92 = 0,816885 → 81,69 %.
  assert.equal(sys.systemEtaPct, 81.69);
  // Einstand mit Wandlung (T13 B): (200 PV + 250 Netz ÷ 0,90) ÷ 30 kWh = 477,78 ÷ 30 = 15,926 ct.
  // Akku (DC) 30,3 − 1 − 27,1 = 2,2 kWh × 15,926 ct = 0,3504 €.
  assert.equal(sys.losses.dcKwh, 2.2);
  assert.equal(sys.losses.dcEur, 0.35);
  // Laden 31,25 − 30 = 1,25 kWh × 25 ct (Netzladung) = 0,3125 €.
  assert.equal(sys.losses.chargeKwh, 1.25);
  assert.equal(sys.losses.chargeEur, 0.31);
  // Entladen 27 − 24,84 = 2,16 kWh × 15,926 ct = 0,3440 €.
  assert.equal(sys.losses.dischargeKwh, 2.16);
  assert.equal(sys.losses.dischargeEur, 0.34);
  // Gesamt 5,61 kWh, 0,3504 + 0,3125 + 0,3440 = 1,0069 € (ungerundet summiert).
  assert.equal(sys.losses.totalKwh, 5.61);
  assert.equal(sys.losses.totalEur, 1.01);
  assert.equal(sys.losses.complete, true, 'ohne Angabe zur Ladestand-Abdeckung gilt sie als ganz');
  // Codex 3be47b54: Ladestand fehlte zeitweise → Summe als unvollständig markiert, nicht hochgerechnet.
  const partial = finalizeSelfUse(systemSums().selfUse, { storage: { capability: victronCap, totals: { ...jobTotals, socComplete: false, socCoveragePct: 60 } } }).battery.system;
  assert.equal(partial.losses.complete, false);
  assert.equal(partial.losses.dcCoveragePct, 60);
  assert.equal(partial.losses.totalKwh, 5.61);
  // Codex 43827b0a: entscheidend ist „fehlt ein Abstand“, nicht eine Prozent-Schwelle.
  const nearly = finalizeSelfUse(systemSums().selfUse, { storage: { capability: victronCap, totals: { ...jobTotals, socComplete: false, socCoveragePct: 99.73 } } }).battery.system;
  assert.equal(nearly.losses.complete, false);
  assert.deepEqual(sys.energy, { inputKwh: 31.25, chargedKwh: 30.3, dischargedKwh: 27.1, acOutKwh: 24.84, storedDeltaKwh: 1 });
  assert.deepEqual(sys.prices, { storedCtKwh: 15.93, chargeCtKwh: 25, chargeBasis: 'grid' });
  assert.deepEqual(sys.basis, { days: 30, firstDay: '2026-11-01', lastDay: '2026-11-30', hours: 690.5 });
  assert.equal(sys.converterLossKwh, 80.25);
  assert.equal(sys.verified, true);
});

test('T13 B: Karte bewertet den Akku mit Wandlung — Entladung × η Entladen, Netzladung ÷ η Lader, Last gemessen', () => {
  const r = finalizeSelfUse(systemSums().selfUse, { storedDeltaKwh: 1, storage: { capability: victronCap, totals: jobTotals } });
  assert.equal(r.valuation, 'ac');
  const b = r.battery;
  // Netzladung AC 10 + 10 × (1/0,9 − 1) = 11,11 kWh; Kosten 450 + 250 × 0,1111 = 477,78 ct.
  assert.equal(b.chargedGridKwh, 11.11);
  assert.equal(b.chargedPvKwh, 20);
  assert.equal(b.chargeCostEur, 4.78);
  // Entladeverlust (1 − 0,92) × 27 = 2,16 kWh fehlt nur dem Haus: 24 → 21,84; Akku → Netz bleibt 3 (gemessen).
  assert.equal(b.dischargedHouseKwh, 21.84);
  assert.equal(b.dischargedGridKwh, 3);
  // Nutzwert 24·40 + 3·20 = 1020 − 0,08 × 27 × 40 = 933,6 ct.
  assert.equal(b.dischargeValueEur, 9.34);
  // Einstand je geladener kWh 477,78 ÷ 30 = 15,93 ct; Ladestand +1 kWh → 0,16 €.
  assert.equal(b.storedValueCtKwh, 15.93);
  assert.equal(b.socCorrectionEur, 0.16);
  // Ergebnis 933,6 − 477,78 + 15,93 = 471,75 ct.
  assert.equal(b.resultEur, 4.72);
  // Je entladener AC-kWh (24,84): 477,78 / 24,84 = 19,23 ct → 933,6 / 24,84 = 37,58 ct.
  assert.equal(b.inCtKwh, 19.23);
  assert.equal(b.outCtKwh, 37.58);
  assert.deepEqual(b.acBasis, { dischargeEtaPct: 92, chargerEtaPct: 90 });
  // Akku-Wirkungsgrad (DC) bleibt aus den Flüssen: 27 ÷ (30 − 1) = 93,10 %.
  assert.equal(b.etaPct, 93.1);
  // Last gemessen 5 + 2 + 21,84 = 28,84 kWh, Σ Last·p = 150 + 50 + 873,6 = 1073,6 ct.
  assert.equal(r.loadKwh, 28.84);
  assert.equal(r.loadCostAtPriceEur, 10.74);
  // Echte Kosten: Netz 13,111 × 25 = 327,78 + PV 25 × 10 = 250 − Akku-Einspeisung 3 × 20 = 60
  // − Ladestand 15,93 = 501,85 ct → p_eff 501,85 ÷ 28,84 = 17,40 ct; Vorteil 1073,6 − 501,85 = 571,75 ct.
  assert.equal(r.peffCtKwh, 17.4);
  assert.equal(r.advantageEur, 5.72);
  // Hier geht alles auf: PV direkt 100 + Akku 471,75 = Vorteil → kein weiterer Wechselrichter-Verbrauch.
  assert.equal(r.otherConversionCostEur, 0);
  // Nur Netzkosten ÷ Last: 327,78 ÷ 28,84 = 11,37 ct.
  assert.equal(r.peffWithoutOpportunityCtKwh, 11.37);
  // Vorher (Flüsse, DC als AC): Last 5 + 3,111 + 24 = 32,11, Ergebnis 1020 − 450 + 15 = 585 ct,
  // Vorteil 685 ct, p_eff (150 + 77,78 + 960 − 685) ÷ 32,11 = 15,66 ct, ohne Opportunität 10,21 ct.
  assert.deepEqual(r.flowsValuation, { loadKwh: 32.11, advantageEur: 6.85, batteryResultEur: 5.85, peffCtKwh: 15.66, peffWithoutOpportunityCtKwh: 10.21 });
});

test('T13 B (Codex a7e86f28): VRM-Flüsse nicht noch einmal wandeln, Leerlauf aus dem Netz zählt im Preis', () => {
  // VRM-Viertelstunde: schon an AC-Werten normiert → bleibt, wie sie ist.
  const vrm = createTariffSums({ detail: true });
  addSlotToTariffSums(vrm, { importPriceKnown: true, userImportPriceCtKwh: 40, marketPriceCtKwh: 20, batteryDirectUseKwh: 18, loadKwh: 18, vrmFlows: true });
  addSlotToTariffSums(vrm, { importPriceKnown: true, userImportPriceCtKwh: 30, marketPriceCtKwh: 10, solarToBatteryKwh: 20, pvKwh: 20, sourceKind: 'vrm_import' });
  const rv = finalizeSelfUse(vrm.selfUse, { storage: { capability: victronCap, totals: jobTotals } });
  assert.equal(rv.valuation, 'ac');
  assert.equal(rv.battery.dischargedHouseKwh, 18);
  assert.equal(rv.battery.dischargeValueEur, 7.2);
  // Nur Netz, Wechselrichter-Leerlauf: Bezug 13,111 kWh zu 30 ct, Hauslast 10 kWh, keine PV, kein Akku.
  // Echte Kosten 393,33 ct ÷ 10 = 39,33 ct — gleich „ohne entgangene Einspeisung“; 3,111 kWh × 30 ct
  // = 0,93 € Wechselrichter-Verbrauch außerhalb des Akku-Wegs.
  const idle = createTariffSums({ detail: true });
  addSlotToTariffSums(idle, { importPriceKnown: true, userImportPriceCtKwh: 30, marketPriceCtKwh: 10, importKwh: IMPORT_2, gridDirectUseKwh: IMPORT_2, loadKwh: 10 });
  const ri = finalizeSelfUse(idle.selfUse, { storage: { capability: victronCap, totals: jobTotals } });
  assert.equal(ri.peffCtKwh, 39.33);
  assert.equal(ri.peffWithoutOpportunityCtKwh, 39.33);
  assert.equal(ri.advantageEur, -0.93);
  assert.equal(ri.otherConversionCostEur, 0.93);
});

test('T13 B (Codex 013298c7): Einspeisung über der AC-Abgabe des Akkus, Akku-Herkunft je Fluss', () => {
  const eta90 = { capability: victronCap, totals: { ...jobTotals, dischargeEta: 0.9 } };
  const one = (slot) => {
    const sums = createTariffSums({ detail: true });
    addSlotToTariffSums(sums, { importPriceKnown: true, ...slot });
    return finalizeSelfUse(sums.selfUse, { storage: eta90 }).battery;
  };
  // PV und Akku speisen gleichzeitig ein: Fluss Akku→Netz 10 = ganze DC-Entladung, Haus 0. Mit η 0,9
  // gibt der Akku nur 9 kWh AC ab → 9 kWh zur Börse 1 ct = 9 ct; die übrige Einspeisung war PV.
  // Vorher (alle Verluste zum Endpreis 30 ct abgezogen): 10 − 0,1 × 10 × 30 = −20 ct.
  const pvAndBattery = one({ userImportPriceCtKwh: 30, marketPriceCtKwh: 1, batteryToGridKwh: 10, solarToGridKwh: 5, pvKwh: 5, exportKwh: 15, loadKwh: 0.001 });
  assert.equal(pvAndBattery.dischargedHouseKwh, 0);
  assert.equal(pvAndBattery.dischargedGridKwh, 9);
  assert.equal(pvAndBattery.dischargeValueEur, 0.09);
  // Ohne PV: 10 kWh DC, gemessene Einspeisung 9, Rest Haus 1. AC-Abgabe 9 = Einspeisung → Haus 0,
  // Wert 9 × 20 ct = 180 ct (nicht 8,1 kWh Einspeisung und 0,9 kWh Haus).
  const exportOnly = one({ userImportPriceCtKwh: 30, marketPriceCtKwh: 20, batteryToGridKwh: 9, batteryDirectUseKwh: 1, exportKwh: 9, loadKwh: 0.001 });
  assert.equal(exportOnly.dischargedHouseKwh, 0);
  assert.equal(exportOnly.dischargedGridKwh, 9);
  assert.equal(exportOnly.dischargeValueEur, 1.8);
  // Nur der Netzbezug kam aus VRM (Slot vrmFlows), die Akku-Flüsse sind eigene → gewandelt:
  // 1 kWh DC × 0,9 = 0,9 kWh, 27 ct (nicht 1 kWh, 30 ct).
  const mixed = one({ userImportPriceCtKwh: 30, marketPriceCtKwh: 10, batteryDirectUseKwh: 1, loadKwh: 0.9, vrmFlows: true, batteryFlowsVrm: false });
  assert.equal(mixed.dischargedHouseKwh, 0.9);
  assert.equal(mixed.dischargeValueEur, 0.27);
  // Akku-Flüsse selbst aus VRM → schon AC, bleiben.
  const vrmBattery = one({ userImportPriceCtKwh: 30, marketPriceCtKwh: 10, batteryDirectUseKwh: 1, loadKwh: 1, batteryFlowsVrm: true });
  assert.equal(vrmBattery.dischargedHouseKwh, 1);
  assert.equal(vrmBattery.dischargeValueEur, 0.3);
});

test('T13 B: ohne gemessenen Speicherweg bleibt die Bewertung aus den Flüssen', () => {
  const sums = systemSums().selfUse;
  const plain = finalizeSelfUse(sums, { storedDeltaKwh: 1 });
  assert.equal(plain.valuation, 'flows');
  assert.equal(plain.battery.resultEur, 5.85);
  assert.equal(plain.loadKwh, 32.11);
  assert.equal(plain.battery.acBasis, null);
  for (const storage of [
    { capability: { measurable: false, reason: 'Fronius' }, totals: null },
    { capability: victronCap, totals: jobTotals, secondBattery: true },
    { capability: victronCap, totals: { ...jobTotals, status: 'insufficient_data' } }
  ]) {
    const r = finalizeSelfUse(sums, { storedDeltaKwh: 1, storage });
    assert.equal(r.valuation, 'flows');
    assert.equal(r.battery.resultEur, 5.85);
  }
  // η Lader fehlt (zu wenig AC-Ladung gemessen): Netzladung unkorrigiert, Entladung trotzdem × η.
  const noCharger = finalizeSelfUse(sums, { storedDeltaKwh: 1, storage: { capability: victronCap, totals: { ...jobTotals, chargerEta: null } } });
  assert.equal(noCharger.valuation, 'ac');
  assert.equal(noCharger.battery.chargedGridKwh, 10);
  assert.equal(plain.otherConversionCostEur, null);
  assert.deepEqual(noCharger.battery.acBasis, { dischargeEtaPct: 92, chargerEtaPct: null });
});

test('T12: ohne Netzladung zählt der Laden-Verlust zur Ø Börse des PV-Stroms', () => {
  // selfUseSums: nur PV lädt, PV gesamt 4 kWh zu 10 ct.
  const r = finalizeSelfUse(selfUseSums().selfUse, { storage: { capability: victronCap, totals: jobTotals } });
  assert.equal(r.battery.system.prices.chargeBasis, 'pv');
  assert.equal(r.battery.system.prices.chargeCtKwh, 10);
  // 1,25 kWh × 10 ct = 0,125 € → 0,13 €.
  assert.equal(r.battery.system.losses.chargeEur, 0.13);
});

test('T12: nicht messbar, zweite GX, zu wenig Daten — Grund statt Zahl; ohne Job kein Block', () => {
  const sums = systemSums().selfUse;
  const fronius = finalizeSelfUse(sums, { storage: { capability: { measurable: false, label: 'Fronius', reason: 'nicht messbar bei Fronius: …' }, totals: null } });
  assert.equal(fronius.battery.system.status, 'not_measurable');
  assert.match(fronius.battery.system.reason, /Fronius/);
  assert.equal(fronius.battery.system.systemEtaPct, undefined);
  const second = finalizeSelfUse(sums, { storage: { capability: victronCap, totals: jobTotals, secondBattery: true } });
  assert.equal(second.battery.system.status, 'not_measurable');
  assert.match(second.battery.system.reason, /zweiten GX/);
  const few = finalizeSelfUse(sums, { storage: { capability: victronCap, totals: { ...jobTotals, status: 'insufficient_data', reason: 'zu wenig', chargeEta: null } } });
  assert.equal(few.battery.system.status, 'insufficient_data');
  assert.equal(few.battery.system.basis.days, 30);
  const none = finalizeSelfUse(sums, { storage: { capability: victronCap, totals: null } });
  assert.equal(none.battery.system.status, 'insufficient_data');
  assert.equal(finalizeSelfUse(sums).battery.system, null);
});
