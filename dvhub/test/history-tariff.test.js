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
  assert.deepEqual(row.fixedCompare, { slots: 4, importKwh: 6, ctKwh: 30, actualEur: 1, fixedEur: 1.8, savingsEur: 0.8 });
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
  assert.deepEqual(row.fixedCompare, { slots: 3, importKwh: 4, ctKwh: 30, actualEur: 0.5, fixedEur: 1.2, savingsEur: 0.7 });
});

test('Grundgebühr tageweise, getrennt vom Ø-Arbeitspreis; Vergleich mit Grundgebühr (T5)', () => {
  const row = finalizeTariffRow(goldenSums());
  // Zwei Tage à 1 € (31 €/Monat ÷ 31 Tage).
  assert.deepEqual(row.baseFee, { eur: 2, days: 2, missingDays: 0, variableEur: 2, variableDays: 2, variableMissingDays: 0 });
  // Ø-Arbeitspreis bleibt ohne Gebühr (16,67); Kosten mit Gebühr 1,00 + 2,00 = 3,00 €.
  assert.equal(row.avgImportCtKwh, 16.67);
  assert.equal(row.variableCostWithFeeEur, 3);
  // Festpreis: 1,80 + 2 × 0,50 = 2,80 €; dynamisch 1,00 + 2,00 = 3,00 € → 0,20 € mehr bezahlt.
  assert.deepEqual(row.fixedCompareWithFee, { days: 2, feeFixedEur: 1, feeActualEur: 2, fixedEur: 2.8, actualEur: 3, savingsEur: -0.2 });
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
