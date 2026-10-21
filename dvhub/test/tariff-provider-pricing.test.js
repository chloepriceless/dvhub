// Bezugspreis im Modus „Vom Stromanbieter“: Rechner, Zeiträume, Einstellungen,
// Geheimnisse (services/tariff-provider, config-model.js).
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveUserImportPriceCtKwhForSlot, normalizeConfigInput } from '../config-model.js';
import { resolveImportPriceCtKwhForSlot } from '../user-energy-pricing.js';
import { enrichPriceSlotsWithCosts } from '../services/optimizer/cost-model.js';
import { redactConfig, restoreRedacted, REDACTED } from '../config-redaction.js';
import {
  putProviderSlots, clearProviderPrices, setProviderEstimate, fitProviderEstimate, providerSlotAt
} from '../services/tariff-provider/price-store.js';
import { providerModeInUse } from '../services/tariff-provider/provider-pricing.js';

const TS = Date.parse('2026-11-01T11:00:00Z'); // 12:00 Berlin
const components = { energyMarkupCtKwh: 2, gridChargesCtKwh: 10, leviesAndFeesCtKwh: 3, vatPct: 19 };

function pricing(extra = {}) {
  return { mode: 'provider', provider: { priceBasis: 'gross_total' }, dynamicComponents: components, ...extra };
}

test.beforeEach(() => clearProviderPrices());

test('Endpreis: gespeicherter Anbieterpreis gilt unverändert, auch im 15-min-Slot mittendrin', () => {
  putProviderSlots('lichtblick', [{ ts: TS, ctKwh: 27.345, durationMs: 900_000 }]);
  assert.equal(resolveUserImportPriceCtKwhForSlot({ ts: TS, ct_kwh: 8 }, pricing()), 27.35);
  assert.equal(resolveUserImportPriceCtKwhForSlot({ ts: TS + 14 * 60_000, ct_kwh: 8 }, pricing()), 27.35);
  assert.equal(providerSlotAt(TS + 15 * 60_000), null);
});

test('Stundenpreise eines Anbieters gelten für alle vier Viertelstunden', () => {
  putProviderSlots('tibber', [{ ts: TS, ctKwh: 30, durationMs: 3_600_000 }]);
  assert.equal(resolveUserImportPriceCtKwhForSlot({ ts: TS + 45 * 60_000, ct_kwh: 8 }, pricing()), 30);
});

test('Endpreis: §14a Modul 3 wird nicht noch einmal eingerechnet', () => {
  putProviderSlots('tibber', [{ ts: TS, ctKwh: 31, durationMs: 900_000 }]);
  const withM3 = pricing({
    usesParagraph14aModule3: true,
    module3Windows: { window1: { enabled: true, start: '11:00', end: '14:00', priceCtKwh: 2 } }
  });
  assert.equal(resolveUserImportPriceCtKwhForSlot({ ts: TS, ct_kwh: 8 }, withM3), 31);
});

test('Nur Energiepreis: wie dynamisch, mit Anbieterpreis statt Börsenpreis (und Modul 3)', () => {
  putProviderSlots('lichtblick', [{ ts: TS, ctKwh: 10, durationMs: 900_000 }]);
  const net = pricing({ provider: { priceBasis: 'net_energy' } });
  // (10 + 2 + 10 + 3) × 1,19 = 29,75
  assert.equal(resolveUserImportPriceCtKwhForSlot({ ts: TS, ct_kwh: 8 }, net), 29.75);
  const netM3 = { ...net, usesParagraph14aModule3: true, module3Windows: { window1: { enabled: true, start: '11:00', end: '14:00', priceCtKwh: 2 } } };
  // (10 + 2 + 3) × 1,19 + 2 = 19,85
  assert.equal(resolveUserImportPriceCtKwhForSlot({ ts: TS, ct_kwh: 8 }, netM3), 19.85);
});

test('Fehlender Slot: Schätzung aus der Ausgleichsgeraden, sonst dynamische Formel, ohne Börsenpreis null', () => {
  // ohne Gerade: (8 + 2 + 10 + 3) × 1,19 = 27,37
  assert.equal(resolveUserImportPriceCtKwhForSlot({ ts: TS, ct_kwh: 8 }, pricing()), 27.37);
  setProviderEstimate({ slope: 1.2, intercept: 15, n: 96 });
  assert.equal(resolveUserImportPriceCtKwhForSlot({ ts: TS, ct_kwh: 8 }, pricing()), 24.6);
  assert.equal(resolveUserImportPriceCtKwhForSlot({ ts: TS, ct_kwh: null }, pricing()), null);
});

test('fitProviderEstimate: MwSt-Steigung und Aufschlag werden erkannt, Ausreißer-Steigung fällt auf Median', () => {
  const pairs = Array.from({ length: 48 }, (_, i) => {
    const market = -2 + i * 0.5;
    return { market, provider: (market + 15) * 1.19 };
  });
  const fit = fitProviderEstimate(pairs);
  assert.equal(fit.slope, 1.19);
  assert.equal(fit.intercept, 17.85);
  assert.equal(fit.n, 48);
  assert.equal(fitProviderEstimate(pairs.slice(0, 10)), null, 'zu wenige Paare');
  const flat = fitProviderEstimate(Array.from({ length: 20 }, (_, i) => ({ market: i % 2 ? 5 : 5.0001, provider: 30 })));
  assert.equal(flat.slope, 1);
  assert.equal(Math.round(flat.intercept), 25);
});

test('Zeiträume: Anbieter ab 1.11., davor der alte Festpreis', () => {
  putProviderSlots('lichtblick', [{ ts: TS, ctKwh: 25, durationMs: 900_000 }]);
  const before = Date.parse('2026-10-31T11:00:00Z');
  const p = {
    mode: 'fixed', fixedGrossImportCtKwh: 26.9, dynamicComponents: components,
    provider: { priceBasis: 'gross_total' },
    periods: [{ id: 'lb', startDate: '2026-11-01', endDate: '2027-12-31', mode: 'provider' }]
  };
  assert.equal(resolveUserImportPriceCtKwhForSlot({ ts: before, ct_kwh: 8 }, p), 26.9);
  assert.equal(resolveUserImportPriceCtKwhForSlot({ ts: TS, ct_kwh: 8 }, p), 25);
  assert.equal(providerModeInUse(p, '2026-10-22'), true, 'künftiger Zeitraum zählt');
  assert.equal(providerModeInUse(p, '2028-01-01'), false, 'abgelaufener Zeitraum nicht');
  assert.equal(providerModeInUse({ mode: 'dynamic' }), false);
});

test('Zwilling für den Preisvergleich (user-energy-pricing.js) rechnet gleich', () => {
  putProviderSlots('tibber', [{ ts: TS, ctKwh: 33.3, durationMs: 900_000 }]);
  assert.equal(resolveImportPriceCtKwhForSlot({ ts: TS, ct_kwh: 8 }, pricing()), 33.3);
  assert.equal(resolveImportPriceCtKwhForSlot({ ts: TS + 900_000, ct_kwh: 8 }, pricing()), 27.37);
});

test('interner Optimierer (cost-model) nimmt im Anbieter-Modus den Anbieterpreis', () => {
  putProviderSlots('tibber', [{ ts: TS, ctKwh: 33.3, durationMs: 900_000 }]);
  const out = enrichPriceSlotsWithCosts([{ ts: TS, endTs: TS + 900_000, ctKwh: 8, confidence: 1 }], { userEnergyPricing: pricing() });
  assert.equal(out[0].importCtKwh, 33.3);
});

test('Einstellungen: Anbieter-Modus in Zeiträumen bleibt, Anbieter-Block wird bereinigt', () => {
  const { effectiveConfig, warnings } = normalizeConfigInput({
    userEnergyPricing: {
      mode: 'provider',
      provider: { name: 'lichtblick', priceBasis: 'quatsch', lichtblick: { email: ' a@b.de ', password: ' pw ', contractId: '4711' } },
      periods: [
        { id: 'lb', startDate: '2026-11-01', endDate: '2027-10-31', mode: 'provider' },
        { id: 'x', startDate: '2028-01-01', endDate: '2028-02-01', mode: 'irgendwas' }
      ]
    }
  });
  const uep = effectiveConfig.userEnergyPricing;
  assert.equal(uep.mode, 'provider');
  assert.deepEqual(uep.periods.map((p) => [p.id, p.mode]), [['lb', 'provider']]);
  assert.ok(warnings.some((w) => /periods\.x: mode must be fixed, dynamic or provider/.test(w)));
  assert.equal(uep.provider.name, 'lichtblick');
  assert.equal(uep.provider.priceBasis, 'gross_total');
  assert.equal(uep.provider.lichtblick.email, 'a@b.de');
  assert.equal(uep.provider.lichtblick.password, ' pw ', 'Passwort wird nicht getrimmt');
  assert.equal(uep.provider.lichtblick.contractId, 4711);
  const unknown = normalizeConfigInput({ userEnergyPricing: { provider: { name: 'octopus' } } }).effectiveConfig.userEnergyPricing.provider;
  assert.equal(unknown.name, '');
});

test('Zugangsdaten gehen nie zurück und bleiben beim Speichern erhalten', () => {
  const stored = { userEnergyPricing: { provider: {
    name: 'lichtblick', priceBasis: 'gross_total',
    tibber: { token: 'tibber-geheim', homeId: 'h1' },
    lichtblick: { email: 'a@b.de', password: 'pw', contractId: null }
  } } };
  const shown = redactConfig(stored);
  assert.equal(shown.userEnergyPricing.provider.tibber.token, REDACTED);
  assert.equal(shown.userEnergyPricing.provider.lichtblick.email, REDACTED);
  assert.equal(shown.userEnergyPricing.provider.lichtblick.password, REDACTED);
  assert.equal(shown.userEnergyPricing.provider.tibber.homeId, 'h1');
  assert.equal(JSON.stringify(shown).includes('tibber-geheim'), false);
  const saved = restoreRedacted(shown, stored);
  assert.deepEqual(saved, stored);
});

test('interner Optimierer: Anbieter nur in einem Zeitraum → dort Anbieterpreis, davor Grundtarif (Codex 22.10.)', () => {
  putProviderSlots('lichtblick', [{ ts: TS, ctKwh: 45, durationMs: 900_000 }]);
  const before = Date.parse('2026-10-31T11:00:00Z');
  const uep = {
    mode: 'fixed', fixedGrossImportCtKwh: 26.9, dynamicComponents: components, provider: { priceBasis: 'gross_total' },
    periods: [{ id: 'lb', startDate: '2026-11-01', endDate: '2027-10-31', mode: 'provider' }]
  };
  const out = enrichPriceSlotsWithCosts([
    { ts: before, endTs: before + 900_000, ctKwh: 8, confidence: 1 },
    { ts: TS, endTs: TS + 900_000, ctKwh: 8, confidence: 1 }
  ], { userEnergyPricing: uep });
  assert.deepEqual(out.map((s) => s.importCtKwh), [26.9, 45]);
});
