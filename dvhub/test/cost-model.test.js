import test from 'node:test';
import assert from 'node:assert/strict';

import { computeSlotCosts, enrichPriceSlotsWithCosts, toEosStrompreisArray } from '../services/optimizer/cost-model.js';

// --- Default tariff/paragraph14a for convenience ---
const defaultTariff = {
  type: 'dynamic',
  fixedCtKwh: 30,
  minCtKwh: 20,
  netzentgeltCtKwh: 9.26,
  kwkCtKwh: 0.446,
  offshoreCtKwh: 0.941,
  stromnevCtKwh: 1.559,
  stromsteuerCtKwh: 2.05,
  konzessionsabgabeCtKwh: 1.66,
  vertriebsaufschlagCtKwh: 0,
  vatPct: 19,
  feedInMode: 'fixed',
  feedInCtKwh: 7.78,
  feedInSpotFactor: 1.0
};

const defaultP14a = {
  enabled: false,
  reductionCtKwh: 0
};

// --- Test 1: Dynamic tariff correct Bezugspreis ---
test('computeSlotCosts: dynamic tariff spotCtKwh=5 returns correct importCtKwh', () => {
  const result = computeSlotCosts(5, defaultTariff, defaultP14a);
  // netto = 5 + 9.26 + 0.446 + 0.941 + 1.559 + 2.05 + 1.66 + 0 = 20.916
  // brutto = 20.916 * 1.19 = 24.89004 -> rounded to 3 decimals = 24.89
  assert.strictEqual(result.importCtKwh, 24.89);
  assert.strictEqual(result.components.spot, 5);
  assert.strictEqual(result.components.netzentgelt, 9.26);
  assert.strictEqual(result.components.vatPct, 19);
});

// --- Test 2: Fixed tariff returns flat rate ---
test('computeSlotCosts: fixed tariff returns fixedCtKwh', () => {
  const fixedTariff = { ...defaultTariff, type: 'fixed', fixedCtKwh: 30, feedInCtKwh: 8.0 };
  const result = computeSlotCosts(5, fixedTariff, defaultP14a);
  assert.strictEqual(result.importCtKwh, 30);
  assert.strictEqual(result.feedInCtKwh, 8.0);
  assert.strictEqual(result.components.type, 'fixed');
});

// --- Test 3: Mixed tariff enforces floor price ---
test('computeSlotCosts: mixed tariff with low spot enforces minCtKwh floor', () => {
  const mixedTariff = { ...defaultTariff, type: 'mixed', minCtKwh: 20 };
  const result = computeSlotCosts(2, mixedTariff, defaultP14a);
  // netto without floor = 2 + 9.26 + 0.446 + 0.941 + 1.559 + 2.05 + 1.66 + 0 = 17.916
  // floor = 20 -> netto = 20
  // brutto = 20 * 1.19 = 23.8
  assert.strictEqual(result.importCtKwh, 23.8);
});

// --- Test 4: 14a reduction enabled ---
test('computeSlotCosts: 14a reduction subtracts from netto base', () => {
  const p14a = { enabled: true, reductionCtKwh: 5 };
  const result = computeSlotCosts(5, defaultTariff, p14a);
  // netto = 5 + 9.26 + 0.446 + 0.941 + 1.559 + 2.05 + 1.66 + 0 - 5 = 15.916
  // brutto = 15.916 * 1.19 = 18.94004 -> 18.94
  assert.strictEqual(result.importCtKwh, 18.94);
  assert.strictEqual(result.components.p14aReduction, 5);
});

// --- Test 5: 14a disabled has no effect ---
test('computeSlotCosts: 14a disabled does not reduce even if reductionCtKwh is set', () => {
  const p14aDisabled = { enabled: false, reductionCtKwh: 5 };
  const result = computeSlotCosts(5, defaultTariff, p14aDisabled);
  // Same as Test 1: no reduction applied
  assert.strictEqual(result.importCtKwh, 24.89);
  assert.strictEqual(result.components.p14aReduction, 0);
});

// --- Test 6: Negative spot price zeroes feed-in (D-30) ---
test('computeSlotCosts: negative spot price sets feedInCtKwh to 0', () => {
  const result = computeSlotCosts(-3, defaultTariff, defaultP14a);
  assert.strictEqual(result.feedInCtKwh, 0);
  assert.strictEqual(result.components.spot, -3);
});

// --- Test 7: Feed-in mode 'spot' ---
test('computeSlotCosts: feedInMode=spot uses spotCtKwh * feedInSpotFactor', () => {
  const spotFeedTariff = { ...defaultTariff, feedInMode: 'spot', feedInSpotFactor: 0.9 };
  const result = computeSlotCosts(10, spotFeedTariff, defaultP14a);
  assert.strictEqual(result.feedInCtKwh, 9); // 10 * 0.9
});

// --- Test 8: Feed-in mode 'fixed' (default) ---
test('computeSlotCosts: feedInMode=fixed uses tariff.feedInCtKwh', () => {
  const result = computeSlotCosts(10, defaultTariff, defaultP14a);
  assert.strictEqual(result.feedInCtKwh, 7.78);
});

// --- Test 9: enrichPriceSlotsWithCosts adds importCtKwh and feedInCtKwh ---
test('enrichPriceSlotsWithCosts: adds importCtKwh and feedInCtKwh to all slots', () => {
  const slots = [
    { ts: 1000, endTs: 2000, ctKwh: 5, confidence: 0.9 },
    { ts: 2000, endTs: 3000, ctKwh: 10, confidence: 0.8 },
    { ts: 3000, endTs: 4000, ctKwh: -2, confidence: 0.7 },
    { ts: 4000, endTs: 5000, ctKwh: 15, confidence: 0.6 }
  ];
  const cfg = {
    optimizer: {
      tariff: { ...defaultTariff },
      paragraph14a: { ...defaultP14a }
    }
  };
  const result = enrichPriceSlotsWithCosts(slots, cfg);
  assert.strictEqual(result.length, 4);
  // All slots have importCtKwh and feedInCtKwh
  for (const slot of result) {
    assert.ok(typeof slot.importCtKwh === 'number');
    assert.ok(typeof slot.feedInCtKwh === 'number');
  }
  // Original fields preserved
  assert.strictEqual(result[0].ts, 1000);
  assert.strictEqual(result[0].ctKwh, 5);
  assert.strictEqual(result[0].confidence, 0.9);
  // Negative spot slot has feedInCtKwh = 0 (D-30)
  assert.strictEqual(result[2].feedInCtKwh, 0);
});

// --- Test 10: toEosStrompreisArray 4 quarter-hour slots same hour -> 1 entry ---
test('toEosStrompreisArray: 4 quarter-hour slots (same hour) produce 1 hourly Euro/Wh value', () => {
  const hourStart = 3600000; // 1 hour in ms
  const enriched = [
    { ts: hourStart, endTs: hourStart + 900000, importCtKwh: 20 },
    { ts: hourStart + 900000, endTs: hourStart + 1800000, importCtKwh: 22 },
    { ts: hourStart + 1800000, endTs: hourStart + 2700000, importCtKwh: 24 },
    { ts: hourStart + 2700000, endTs: hourStart + 3600000, importCtKwh: 26 }
  ];
  const result = toEosStrompreisArray(enriched);
  assert.strictEqual(result.length, 1);
  // avg = (20 + 22 + 24 + 26) / 4 = 23
  // Euro/Wh = 23 / 100000 = 0.00023
  assert.strictEqual(result[0], 0.00023);
});

// --- Test 11: toEosStrompreisArray 8 quarter-hour slots (2 hours) -> 2 entries ---
test('toEosStrompreisArray: 8 quarter-hour slots (2 hours) produce 2 entries sorted by time', () => {
  const h1 = 3600000;
  const h2 = 7200000;
  const enriched = [
    { ts: h1, endTs: h1 + 900000, importCtKwh: 20 },
    { ts: h1 + 900000, endTs: h1 + 1800000, importCtKwh: 20 },
    { ts: h1 + 1800000, endTs: h1 + 2700000, importCtKwh: 20 },
    { ts: h1 + 2700000, endTs: h1 + 3600000, importCtKwh: 20 },
    { ts: h2, endTs: h2 + 900000, importCtKwh: 30 },
    { ts: h2 + 900000, endTs: h2 + 1800000, importCtKwh: 30 },
    { ts: h2 + 1800000, endTs: h2 + 2700000, importCtKwh: 30 },
    { ts: h2 + 2700000, endTs: h2 + 3600000, importCtKwh: 30 }
  ];
  const result = toEosStrompreisArray(enriched);
  assert.strictEqual(result.length, 2);
  // Hour 1: avg 20, Euro/Wh = 0.0002
  assert.strictEqual(result[0], 0.0002);
  // Hour 2: avg 30, Euro/Wh = 0.0003
  assert.strictEqual(result[1], 0.0003);
});

// --- Review 25.10.2026 (P2): Bezugspreis des internen Optimierers aus derselben
// Quelle wie EOS-Bridge und Oberflaeche (resolveUserImportPriceCtKwhForSlot):
// leviesAndFeesCtKwh, Zeitraeume (periods) und §14a-Modul-3-Fenster.
import { resolveUserImportPriceCtKwhForSlot } from '../config-model.js';

const DYNAMIC_UEP = {
  mode: 'dynamic',
  dynamicComponents: { energyMarkupCtKwh: 2, gridChargesCtKwh: 8, leviesAndFeesCtKwh: 3, vatPct: 19 }
};

test('enrichPriceSlotsWithCosts: dynamischer Bezugspreis mit Umlagen aus leviesAndFeesCtKwh', () => {
  const ts = Date.parse('2026-08-10T10:00:00Z'); // 12:00 Berlin
  const [slot] = enrichPriceSlotsWithCosts([{ ts, ctKwh: 10 }], { userEnergyPricing: DYNAMIC_UEP });
  // (10 + 2 + 8 + 3) × 1,19 = 27,37 ct/kWh (vorher fest verdrahtete Umlagen: 31,721)
  assert.equal(slot.importCtKwh, 27.37);
});

test('enrichPriceSlotsWithCosts: Tarif-Zeitraum (periods) gilt fuer seine Tage', () => {
  const uep = {
    ...DYNAMIC_UEP,
    periods: [{ startDate: '2026-07-01', endDate: '2026-12-31', mode: 'fixed', fixedGrossImportCtKwh: 35 }]
  };
  const inPeriod = Date.parse('2026-08-10T10:00:00Z');
  const before = Date.parse('2026-06-10T10:00:00Z');
  const [a, b] = enrichPriceSlotsWithCosts([{ ts: inPeriod, ctKwh: 10 }, { ts: before, ctKwh: 10 }], { userEnergyPricing: uep });
  assert.equal(a.importCtKwh, 35);
  assert.equal(b.importCtKwh, 27.37);
});

test('enrichPriceSlotsWithCosts: §14a-Modul-3-Fenster ersetzt das Netzentgelt', () => {
  const uep = {
    ...DYNAMIC_UEP,
    usesParagraph14aModule3: true,
    module3Windows: { nt: { enabled: true, start: '00:00', end: '06:00', priceCtKwh: 2.5 } }
  };
  const night = Date.parse('2026-08-10T00:00:00Z'); // 02:00 Berlin
  const noon = Date.parse('2026-08-10T10:00:00Z');
  const [n, d] = enrichPriceSlotsWithCosts([{ ts: night, ctKwh: 10 }, { ts: noon, ctKwh: 10 }], { userEnergyPricing: uep });
  // Nacht: (10 + 2 + 3) × 1,19 + 2,5 = 20,35; Mittag ohne Fenster 27,37.
  assert.equal(n.importCtKwh, 20.35);
  assert.equal(d.importCtKwh, 27.37);
});

test('enrichPriceSlotsWithCosts: Bezugspreis = resolveUserImportPriceCtKwhForSlot fuer jeden Slot', () => {
  const uep = {
    ...DYNAMIC_UEP,
    usesParagraph14aModule3: true,
    module3Windows: { nt: { enabled: true, start: '22:00', end: '06:00', priceCtKwh: 3.1 } },
    periods: [{ startDate: '2026-10-26', endDate: '2026-10-31', dynamicComponents: { energyMarkupCtKwh: 4 } }]
  };
  const slots = Array.from({ length: 192 }, (_, i) => ({ ts: Date.parse('2026-10-25T00:00:00Z') + i * 900000, ctKwh: (i % 17) - 4 }));
  const enriched = enrichPriceSlotsWithCosts(slots, { userEnergyPricing: uep });
  for (const slot of enriched) {
    assert.equal(slot.importCtKwh, resolveUserImportPriceCtKwhForSlot({ ts: slot.ts, ct_kwh: slot.ctKwh }, uep, { timeZone: 'Europe/Berlin' }));
  }
});

test('enrichPriceSlotsWithCosts: Festpreis ohne Betrag faellt wie die EOS-Bridge auf den Spotpreis zurueck', () => {
  const [slot] = enrichPriceSlotsWithCosts([{ ts: Date.parse('2026-08-10T10:00:00Z'), ctKwh: 12.5 }], { userEnergyPricing: { mode: 'fixed' } });
  assert.equal(slot.importCtKwh, 12.5);
});

test('enrichPriceSlotsWithCosts: Einspeise-Modus wie EOS-Bridge/Config-Sync (nur optimizer.tariff.feedInMode)', () => {
  const ts = Date.parse('2026-08-10T10:00:00Z');
  // Direktvermarktungs-Hinweise allein machen noch keinen Spot-Modus (Bridge: feedInMode || 'fixed').
  const [dv] = enrichPriceSlotsWithCosts([{ ts, ctKwh: 10 }], {
    userEnergyPricing: { ...DYNAMIC_UEP, marketValueMode: 'monthly', dvCostMonthlyEur: 5 },
    optimizer: { tariff: { feedInCtKwh: 7.1 } }
  });
  assert.equal(dv.feedInCtKwh, 7.1);
  // Gross-/Kleinschreibung wie in der Bridge egal.
  const [spot] = enrichPriceSlotsWithCosts([{ ts, ctKwh: 10 }], {
    userEnergyPricing: DYNAMIC_UEP,
    optimizer: { tariff: { feedInMode: 'SPOT', feedInSpotFactor: 0.9 } }
  });
  assert.equal(spot.feedInCtKwh, 9);
});
