// test/tariff-valid-from.test.js — Tarif „gilt ab“, Grundgebühren und die
// Tarif-Beschreibung je Viertelstunde (Christin 23.11.2026, T1/T5/T10).
//
// T1: Ein Tarif zählt erst ab dem eingestellten Zeitpunkt. Auch der
// Standard-Tarif bekommt „gilt ab“ (userEnergyPricing.validFrom); davor gilt
// nie rückwirkend der dynamische Tarif, sondern der feste Bruttopreis des
// Standard-Tarifs. Ohne Datum leitet die Historie es aus den Daten ab
// (resolveBaseTariffValidFrom).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeConfigInput,
  resolveUserImportPriceCtKwhForSlot,
  resolveUserImportTariffModeForTimestamp,
  resolveActiveUserEnergyPricingForTimestamp,
  describeUserImportTariffForSlot,
  resolveBaseTariffValidFrom,
  resolveComparisonBaseFeeForDate
} from '../config-model.js';

const DYN = { energyMarkupCtKwh: 2, gridChargesCtKwh: 10, leviesAndFeesCtKwh: 3, vatPct: 0 };

// 12:00 Berlin = 11:00 UTC im Winter.
const noonUtc = (date) => `${date}T11:00:00.000Z`;

test('validFrom: Standard-Tarif dynamisch gilt erst ab dem Datum, davor der feste Bruttopreis', () => {
  const pricing = { mode: 'dynamic', validFrom: '2026-03-15', fixedGrossImportCtKwh: 30, dynamicComponents: DYN, periods: [] };
  // Vorher: Festpreis 30 ct, nicht Börse (5 ct) + 15 ct.
  assert.equal(resolveUserImportPriceCtKwhForSlot({ ts: noonUtc('2026-03-14'), ct_kwh: 5 }, pricing), 30);
  assert.equal(resolveUserImportTariffModeForTimestamp(noonUtc('2026-03-14'), pricing), 'fixed');
  // Ab dem Tag: dynamisch 5 + 2 + 10 + 3 = 20 ct.
  assert.equal(resolveUserImportPriceCtKwhForSlot({ ts: noonUtc('2026-03-15'), ct_kwh: 5 }, pricing), 20);
  assert.equal(resolveUserImportTariffModeForTimestamp(noonUtc('2026-03-15'), pricing), 'dynamic');
});

test('validFrom: lokaler Tag zählt (Mitternacht Berlin, nicht UTC)', () => {
  const pricing = { mode: 'dynamic', validFrom: '2026-03-15', fixedGrossImportCtKwh: 30, dynamicComponents: DYN };
  // 2026-03-14 23:30 UTC = 2026-03-15 00:30 Berlin → schon dynamisch.
  assert.equal(resolveUserImportTariffModeForTimestamp('2026-03-14T23:30:00.000Z', pricing), 'dynamic');
  // 2026-03-14 22:45 UTC = 23:45 Berlin → noch Festpreis.
  assert.equal(resolveUserImportTariffModeForTimestamp('2026-03-14T22:45:00.000Z', pricing), 'fixed');
});

test('validFrom: vor dem Datum keine Modul-3-Fenster (Fensterpreis ist beim dynamischen Tarif nur das Netzentgelt)', () => {
  const pricing = {
    mode: 'dynamic', validFrom: '2026-03-15', fixedGrossImportCtKwh: 30, dynamicComponents: DYN,
    usesParagraph14aModule3: true,
    module3Windows: { window1: { enabled: true, label: 'NT', start: '00:00', end: '23:59', priceCtKwh: 3 } }
  };
  assert.equal(resolveUserImportPriceCtKwhForSlot({ ts: noonUtc('2026-03-01'), ct_kwh: 5 }, pricing), 30);
  // Ab dem Datum: Fenster ersetzt das Netzentgelt: 5 + 2 + 3 + 3 (Fenster) = 13.
  assert.equal(resolveUserImportPriceCtKwhForSlot({ ts: noonUtc('2026-03-20'), ct_kwh: 5 }, pricing), 13);
});

test('validFrom: ein Zeitraum geht immer vor, auch vor dem Datum', () => {
  const pricing = {
    mode: 'dynamic', validFrom: '2026-06-01', fixedGrossImportCtKwh: 30, dynamicComponents: DYN,
    periods: [{ id: 'p', label: 'Alt dyn', startDate: '2026-01-01', endDate: '2026-01-31', mode: 'dynamic', dynamicComponents: DYN }]
  };
  assert.equal(resolveUserImportTariffModeForTimestamp(noonUtc('2026-01-10'), pricing), 'dynamic');
  assert.equal(resolveUserImportTariffModeForTimestamp(noonUtc('2026-02-10'), pricing), 'fixed');
  const active = resolveActiveUserEnergyPricingForTimestamp(noonUtc('2026-02-10'), pricing);
  assert.equal(active?.mode, 'fixed');
  assert.equal(resolveActiveUserEnergyPricingForTimestamp(noonUtc('2026-07-10'), pricing), null);
});

test('validFrom: bei festem Standard-Tarif ohne Wirkung', () => {
  const pricing = { mode: 'fixed', validFrom: '2026-03-15', fixedGrossImportCtKwh: 31 };
  assert.equal(resolveUserImportPriceCtKwhForSlot({ ts: noonUtc('2026-03-01'), ct_kwh: 5 }, pricing), 31);
  assert.equal(resolveActiveUserEnergyPricingForTimestamp(noonUtc('2026-03-01'), pricing), null);
});

test('Sanitizer: validFrom, Grundgebühren und Zeitraum-Grundgebühr', () => {
  const { persistedConfig, warnings } = normalizeConfigInput({
    userEnergyPricing: {
      mode: 'dynamic', validFrom: '2026-03-15', baseFeeEurMonth: '12.5', comparisonFixedBaseFeeEurMonth: 9,
      dynamicComponents: DYN,
      periods: [{ id: 'f', startDate: '2025-01-01', endDate: '2025-12-31', mode: 'fixed', fixedGrossImportCtKwh: 28, baseFeeEurMonth: '10' }]
    }
  });
  const uep = persistedConfig.userEnergyPricing;
  assert.equal(uep.validFrom, '2026-03-15');
  assert.equal(uep.baseFeeEurMonth, 12.5);
  assert.equal(uep.comparisonFixedBaseFeeEurMonth, 9);
  assert.equal(uep.periods[0].baseFeeEurMonth, 10);
  assert.deepEqual(warnings.filter((w) => /validFrom|baseFee/.test(w)), []);

  const bad = normalizeConfigInput({
    userEnergyPricing: { mode: 'dynamic', validFrom: '15.03.2026', baseFeeEurMonth: -1, comparisonFixedBaseFeeEurMonth: 'x', dynamicComponents: DYN }
  });
  assert.equal(bad.persistedConfig.userEnergyPricing.validFrom, null);
  assert.equal(bad.persistedConfig.userEnergyPricing.baseFeeEurMonth, null);
  assert.equal(bad.persistedConfig.userEnergyPricing.comparisonFixedBaseFeeEurMonth, null);
  assert.ok(bad.warnings.some((w) => w.includes('validFrom')));

  // Leer = null (kein Datum, keine Gebühr) — Standard ohne Angabe.
  const empty = normalizeConfigInput({ userEnergyPricing: { mode: 'fixed', validFrom: '', baseFeeEurMonth: '' } });
  assert.equal(empty.persistedConfig.userEnergyPricing.validFrom, null);
  assert.equal(empty.persistedConfig.userEnergyPricing.baseFeeEurMonth, null);
  assert.equal(normalizeConfigInput({}).persistedConfig.userEnergyPricing.validFrom, null);
});

test('describeUserImportTariffForSlot: Tarif, Zeitraum, Modul-3-Fenster, MwSt, Grundgebühr', () => {
  const pricing = {
    mode: 'provider', validFrom: '2026-11-01', fixedGrossImportCtKwh: 30, baseFeeEurMonth: 14,
    dynamicComponents: { ...DYN, vatPct: 19 },
    usesParagraph14aModule3: true,
    module3Windows: { window1: { enabled: true, label: 'Niedrig', start: '00:00', end: '06:00', priceCtKwh: 2 } },
    periods: [{ id: 'dyn', label: 'Tibber', startDate: '2026-03-01', endDate: '2026-10-31', mode: 'dynamic', dynamicComponents: { ...DYN, vatPct: 7 }, baseFeeEurMonth: 6 }]
  };
  // Zeitraum, Fenster (01:00 Berlin = 00:00 UTC im Winter… März: UTC+1).
  const inPeriodWindow = describeUserImportTariffForSlot('2026-03-10T00:15:00.000Z', pricing);
  assert.deepEqual(inPeriodWindow, {
    mode: 'dynamic', tariffKey: 'period:dyn', tariffLabel: 'Tibber', vatPct: 7, baseFeeEurMonth: 6,
    windowId: 'window1', windowLabel: 'Niedrig', module3Active: true,
    // T11: Fenster 2 ct − Netzentgelt 10 ct × 1,07 = −8,70 ct.
    module3DeltaCtKwh: -8.7, beforeValidFrom: false
  });
  const base = describeUserImportTariffForSlot(noonUtc('2026-11-10'), pricing);
  assert.equal(base.tariffKey, 'base');
  assert.equal(base.mode, 'provider');
  assert.equal(base.vatPct, 19);
  assert.equal(base.baseFeeEurMonth, 14);
  assert.equal(base.windowId, null);
  const before = describeUserImportTariffForSlot(noonUtc('2026-02-10'), pricing);
  assert.equal(before.tariffKey, 'base:before');
  assert.equal(before.mode, 'fixed');
  assert.equal(before.beforeValidFrom, true);
  // Vor „gilt ab“ ist die Grundgebühr des heutigen Tarifs unbekannt.
  assert.equal(before.baseFeeEurMonth, null);
  // Zeitraum ohne eigene Grundgebühr erbt sie nicht.
  const noFee = describeUserImportTariffForSlot(noonUtc('2026-03-10'), { ...pricing, periods: [{ ...pricing.periods[0], baseFeeEurMonth: undefined }] });
  assert.equal(noFee.baseFeeEurMonth, null);
});

test('resolveBaseTariffValidFrom: eingetragen, aus Festpreis-Zeitraum, aus erstem Anbieterpreis, sonst keins', () => {
  assert.deepEqual(resolveBaseTariffValidFrom({ mode: 'fixed', validFrom: '2026-01-01' }), { date: null, source: null });
  assert.deepEqual(resolveBaseTariffValidFrom({ mode: 'dynamic', validFrom: '2026-01-01' }), { date: '2026-01-01', source: 'configured' });
  const periods = [
    { id: 'a', startDate: '2024-01-01', endDate: '2024-12-31', mode: 'fixed', fixedGrossImportCtKwh: 25 },
    { id: 'b', startDate: '2025-01-01', endDate: '2026-03-14', mode: 'fixed', fixedGrossImportCtKwh: 30 },
    { id: 'c', startDate: '2030-01-01', endDate: '2030-12-31', mode: 'fixed', fixedGrossImportCtKwh: 40 }
  ];
  assert.deepEqual(resolveBaseTariffValidFrom({ mode: 'dynamic', periods }, { today: '2026-11-23' }),
    { date: '2026-03-15', source: 'fixed_period' });
  // Anbieter: erster gespeicherter Anbieterpreis, der spätere Kandidat gewinnt.
  assert.deepEqual(resolveBaseTariffValidFrom({ mode: 'provider', periods }, { today: '2026-11-23', firstProviderPriceDate: '2026-11-01' }),
    { date: '2026-11-01', source: 'provider_data' });
  assert.deepEqual(resolveBaseTariffValidFrom({ mode: 'provider', periods: [] }, { today: '2026-11-23', firstProviderPriceDate: '2026-11-01' }),
    { date: '2026-11-01', source: 'provider_data' });
  // Dynamisch ohne Hinweis in den Daten: wie bisher die ganze Historie.
  assert.deepEqual(resolveBaseTariffValidFrom({ mode: 'dynamic', periods: [] }, { today: '2026-11-23' }), { date: null, source: 'none' });
  // Ein Monatswechsel beim Zeitraumende (31.12. → 01.01.).
  assert.deepEqual(resolveBaseTariffValidFrom({ mode: 'dynamic', periods: [periods[0]] }, { today: '2026-11-23' }),
    { date: '2025-01-01', source: 'fixed_period' });
});

test('resolveComparisonBaseFeeForDate: eigenes Feld, sonst Gebühr des Vergleichs-Zeitraums, sonst keine', () => {
  const periods = [{ id: 'b', label: 'Stadtwerke', startDate: '2025-01-01', endDate: '2026-03-14', mode: 'fixed', fixedGrossImportCtKwh: 30, baseFeeEurMonth: 11 }];
  assert.deepEqual(resolveComparisonBaseFeeForDate('2026-05-01', { periods, comparisonFixedBaseFeeEurMonth: 9.5 }), { eurMonth: 9.5, source: 'configured' });
  assert.deepEqual(resolveComparisonBaseFeeForDate('2026-05-01', { periods }), { eurMonth: 11, source: 'period' });
  // Eigener Vergleichs-Festpreis ohne eigene Gebühr: kein Zeitraum maßgeblich.
  assert.equal(resolveComparisonBaseFeeForDate('2026-05-01', { periods, comparisonFixedCtKwh: 28 }), null);
  assert.equal(resolveComparisonBaseFeeForDate('2026-05-01', { periods: [] , fixedGrossImportCtKwh: 30 }), null);
});

test('T11: describeUserImportTariffForSlot liefert die Netzentgelt-Abweichung des §14a-Fensters', () => {
  const pricing = {
    mode: 'dynamic', validFrom: '2026-01-01', fixedGrossImportCtKwh: 30,
    dynamicComponents: { energyMarkupCtKwh: 0, gridChargesCtKwh: 10, leviesAndFeesCtKwh: 2, vatPct: 19 },
    usesParagraph14aModule3: true,
    module3Windows: { window1: { enabled: true, label: 'NT', start: '00:00', end: '06:00', priceCtKwh: 3 } },
    periods: [{ id: 'ohne', startDate: '2026-02-01', endDate: '2026-02-28', mode: 'dynamic', usesParagraph14aModule3: false,
      dynamicComponents: { energyMarkupCtKwh: 0, gridChargesCtKwh: 10, leviesAndFeesCtKwh: 2, vatPct: 19 } }]
  };
  // 01:00 Berlin im Januar = 00:00 UTC: im Fenster, δ = 3 − 10·1,19 = −8,90.
  const inWindow = describeUserImportTariffForSlot('2026-01-10T00:00:00.000Z', pricing);
  assert.equal(inWindow.module3Active, true);
  assert.equal(Math.round(inWindow.module3DeltaCtKwh * 100) / 100, -8.9);
  const outside = describeUserImportTariffForSlot('2026-01-10T11:00:00.000Z', pricing);
  assert.equal(outside.module3Active, false);
  assert.equal(outside.module3DeltaCtKwh, null);
  // Zeitraum ohne §14a: kein Fenster, keine Abweichung.
  const period = describeUserImportTariffForSlot('2026-02-10T00:00:00.000Z', pricing);
  assert.equal(period.module3Active, false);
  // Vor „gilt ab“ nie.
  assert.equal(describeUserImportTariffForSlot('2025-12-10T00:00:00.000Z', pricing).module3Active, false);
  // Anbieter ohne Netzentgelt: Fenster aktiv, Abweichung unbekannt.
  const provider = describeUserImportTariffForSlot('2026-01-10T00:00:00.000Z', { ...pricing, mode: 'provider', dynamicComponents: { vatPct: 19 } });
  assert.equal(provider.module3Active, true);
  assert.equal(provider.module3DeltaCtKwh, null);
});
