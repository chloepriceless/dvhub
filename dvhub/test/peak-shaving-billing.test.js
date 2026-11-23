// test/peak-shaving-billing.test.js — Peak Shaving P4 (Christin 24.11.2026): Leistungsentgelt in €.
//
// Nachgerechnet mit dem Preisblatt Netz Leipzig 2026 (netto, Niederspannung RLM):
//   < 2.500 h:  LP 19,17 €/kW·a, AP 5,96 ct/kWh
//   ≥ 2.500 h:  LP 82,02 €/kW·a, AP 3,44 ct/kWh
//   Monatsleistungspreis NS 13,67 €/kW·Monat + AP 3,44 ct/kWh
// und dem Beispiel NEW Netz 2026 (MS): 500 kW, 2.250.000 kWh → T = 4.500 h; 500 × 118,34 € + 2.250.000 × 0,57 ct
// = 71.995 €/a = 3,20 ct/kWh effektiv. (Merkel „RLM-Netzentgelte …“, 23.11.2026)

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveTariff, yearCharge, computeYearBilling, tierFor, USAGE_HOURS_THRESHOLD } from '../services/peak-shaving/billing.js';

const LEIPZIG = { peakShaving: { tariff: {
  model: 'year', lpLowEurPerKwYear: 19.17, apLowCtPerKwh: 5.96, lpHighEurPerKwYear: 82.02, apHighCtPerKwh: 3.44,
  lpMonthEurPerKwMonth: 13.67, apMonthCtPerKwh: 3.44
} } };
const T_LEIPZIG = resolveTariff(LEIPZIG);
const Y2025 = { startMs: Date.parse('2024-12-31T23:00:00Z'), endMs: Date.parse('2025-12-31T23:00:00Z') };
const AFTER = Date.parse('2026-06-01T00:00:00Z');

test('Stufe: ab 2.500 h die hohe Stufe', () => {
  assert.equal(USAGE_HOURS_THRESHOLD, 2500);
  assert.equal(tierFor(2499.9), 'low');
  assert.equal(tierFor(2500), 'high');
  assert.equal(tierFor(null), 'low');
});

test('Preise: leer = unbekannt, keine geratenen Werte; was fehlt, steht dabei', () => {
  const t = resolveTariff({});
  assert.equal(t.model, 'year');
  assert.equal(t.complete, false);
  assert.deepEqual(t.missing, ['lpLowEurPerKwYear', 'apLowCtPerKwh', 'lpHighEurPerKwYear', 'apHighCtPerKwh']);
  const m = resolveTariff({ peakShaving: { tariff: { model: 'month', lpHighEurPerKwYear: 82.02 } } });
  assert.deepEqual(m.missing, ['lpMonthEurPerKwMonth', 'apMonthCtPerKwh'], 'kein Ableiten aus dem Jahrespreis');
  assert.equal(T_LEIPZIG.complete, true);
});

test('NEW Netz 2026 (MS): 500 kW, 2.250.000 kWh → T 4.500 h, 71.995 €, 3,20 ct/kWh', () => {
  const tariff = resolveTariff({ peakShaving: { tariff: { lpLowEurPerKwYear: 1, apLowCtPerKwh: 1, lpHighEurPerKwYear: 118.34, apHighCtPerKwh: 0.57 } } });
  const c = yearCharge({ energyKwh: 2_250_000, peakW: 500_000, tariff });
  assert.equal(c.tier, 'high');
  assert.equal(c.usageHours, 4500);
  assert.equal(Math.round(c.demandChargeEur * 100) / 100, 59170);
  assert.equal(Math.round(c.energyChargeEur * 100) / 100, 12825);
  assert.equal(Math.round(c.totalEur * 100) / 100, 71995);
  assert.equal(Math.round(c.effectiveCtPerKwh * 100) / 100, 3.2);
});

test('Leipzig NS, ≥ 2.500 h: 50 kW, 150.000 kWh → T 3.000 h, 4.101 € + 5.160 € = 9.261 €, 6,17 ct/kWh', () => {
  // AP + LP/T = 3,44 + 8 202 ct / 3 000 h = 3,44 + 2,734 = 6,174 ct/kWh; 9 261 € / 150 000 kWh = 6,174 ct ✓
  const c = yearCharge({ energyKwh: 150_000, peakW: 50_000, tariff: T_LEIPZIG });
  assert.equal(c.tier, 'high');
  assert.equal(c.demandChargeEur, 4101);
  assert.equal(Math.round(c.energyChargeEur * 100) / 100, 5160);
  assert.equal(Math.round(c.totalEur * 100) / 100, 9261);
  assert.equal(Math.round(c.effectiveCtPerKwh * 1000) / 1000, 6.174);
});

test('Leipzig NS, < 2.500 h: 70 kW, 150.000 kWh → T 2.142,9 h, 1.341,90 € + 8.940 € = 10.281,90 €', () => {
  const c = yearCharge({ energyKwh: 150_000, peakW: 70_000, tariff: T_LEIPZIG });
  assert.equal(c.tier, 'low');
  assert.equal(Math.round(c.usageHours * 10) / 10, 2142.9);
  assert.equal(Math.round(c.demandChargeEur * 100) / 100, 1341.9);
  assert.equal(Math.round(c.energyChargeEur * 100) / 100, 8940);
  assert.equal(Math.round(c.totalEur * 100) / 100, 10281.9);
});

test('Jahr (abgeschlossen): vermiedene € gegenüber der Spitze ohne Akku-Beitrag, gleiche Arbeit, Stufe neu', () => {
  // gemessen 50 kW (≥ 2.500 h: 9.261 €), ohne Akku 60 kW → T = 2.500 h → hohe Stufe: 60 × 82,02 + 5.160 = 10.081,20 €
  // → vermieden 820,20 €. Ohne Akku 70 kW → niedrige Stufe 10.281,90 € → vermieden 1.020,90 €.
  const months = [
    { ym: '2025-01', energyKwh: 75_000, peakW: 50_000, peakSlot: '2025-01-15T10:00:00.000Z', uncappedPeakW: 60_000, batterySlots: 2900 },
    { ym: '2025-07', energyKwh: 75_000, peakW: 42_000, uncappedPeakW: 55_000, batterySlots: 2900 }
  ];
  const y = computeYearBilling({ months, tariff: T_LEIPZIG, period: Y2025, nowMs: AFTER });
  assert.equal(y.running, false);
  assert.equal(y.energyKwh, 150000);
  assert.equal(y.peakW, 50000);
  assert.equal(y.peakSlot, '2025-01-15T10:00:00.000Z');
  assert.equal(y.usageHours, 3000);
  assert.equal(y.tier, 'high');
  assert.equal(y.totalEur, 9261);
  assert.equal(y.effectiveCtPerKwh, 6.17);
  assert.equal(y.uncappedPeakW, 60000);
  assert.equal(y.uncappedTotalEur, 10081.2);
  assert.equal(y.avoidedEur, 820.2);
  const y70 = computeYearBilling({ months: [{ ...months[0], uncappedPeakW: 70_000 }, months[1]], tariff: T_LEIPZIG, period: Y2025, nowMs: AFTER });
  assert.equal(y70.uncappedTier, 'low');
  assert.equal(y70.avoidedEur, 1020.9);
  // Monatszeilen: Arbeitsentgelt in der Stufe des Jahres (75.000 × 3,44 ct = 2.580 €)
  assert.equal(y.months[0].energyChargeEur, 2580);
});

test('ohne Akku-Messwerte keine vermiedenen € (nicht ermittelbar)', () => {
  const y = computeYearBilling({ months: [{ ym: '2025-01', energyKwh: 150_000, peakW: 50_000, uncappedPeakW: 60_000, batterySlots: 0 }], tariff: T_LEIPZIG, period: Y2025, nowMs: AFTER });
  assert.equal(y.uncappedPeakW, null);
  assert.equal(y.avoidedEur, null);
  assert.equal(y.totalEur, 9261);
});

test('laufendes Jahr: Benutzungsdauer aufs Jahr hochgerechnet, Stufe danach', () => {
  // Halbes Jahr (2026-01-01 … 2026-07-02 12:00 MESZ ≈ 4 380 h von 8 760 h): 75.000 kWh, 50 kW → T bisher 1.500 h,
  // hochgerechnet 3.000 h → hohe Stufe. effektiv = 3,44 + 8.202 / 3.000 = 6,17 ct/kWh.
  const Y2026 = { startMs: Date.parse('2025-12-31T23:00:00Z'), endMs: Date.parse('2026-12-31T23:00:00Z') };
  const half = Y2026.startMs + (Y2026.endMs - Y2026.startMs) / 2;
  const y = computeYearBilling({ months: [{ ym: '2026-01', energyKwh: 75_000, peakW: 50_000 }], tariff: T_LEIPZIG, period: Y2026, nowMs: half });
  assert.equal(y.running, true);
  assert.equal(y.usageHours, 1500);
  assert.equal(y.usageHoursProjected, 3000);
  assert.equal(y.tier, 'high');
  assert.equal(y.demandChargeEur, 4101, 'Leistungspreis fällt fürs ganze Jahr auf die Spitze an');
  assert.equal(y.energyChargeEur, 2580, 'Arbeitsentgelt bisher');
  assert.equal(y.effectiveCtPerKwh, 6.17);
});

test('Monatsleistungspreis (Leipzig 13,67 €/kW·Monat + 3,44 ct): je Monat Spitze × Preis + Arbeit', () => {
  // Jan: 50 kW × 13,67 = 683,50 € + 12.500 kWh × 3,44 ct = 430 € → 1.113,50 €; ohne Akku 60 kW → 136,70 € vermieden
  // Feb: 40 kW × 13,67 = 546,80 € + 10.000 kWh × 3,44 ct = 344 € → 890,80 €
  const tariff = resolveTariff({ peakShaving: { tariff: { ...LEIPZIG.peakShaving.tariff, model: 'month' } } });
  const y = computeYearBilling({
    months: [
      { ym: '2025-01', energyKwh: 12_500, peakW: 50_000, uncappedPeakW: 60_000, batterySlots: 100 },
      { ym: '2025-02', energyKwh: 10_000, peakW: 40_000, uncappedPeakW: 40_000, batterySlots: 100 }
    ],
    tariff, period: Y2025, nowMs: AFTER
  });
  assert.equal(y.model, 'month');
  assert.equal(y.months[0].totalEur, 1113.5);
  assert.equal(y.months[0].avoidedEur, 136.7);
  assert.equal(y.months[1].totalEur, 890.8);
  assert.equal(y.totalEur, 2004.3);
  assert.equal(y.avoidedEur, 136.7);
  assert.equal(y.effectiveCtPerKwh, Math.round((2004.3 / 22_500) * 10000) / 100);
});

test('Preise fehlen: Kennzahlen (Spitze, Arbeit, Benutzungsdauer) trotzdem, € unbekannt', () => {
  const y = computeYearBilling({ months: [{ ym: '2025-01', energyKwh: 150_000, peakW: 50_000 }], tariff: resolveTariff({}), period: Y2025, nowMs: AFTER });
  assert.equal(y.usageHours, 3000);
  assert.equal(y.totalEur, null);
  assert.equal(y.tariffComplete, false);
});
