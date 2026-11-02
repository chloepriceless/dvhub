// Einstellungen → Strompreis → „Vom Stromanbieter“: kleine Auswertung
// Anbieterpreis ↔ Day-Ahead (Christin 01.11.2026). Nur der Text, ohne DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function loadHelpers() {
  const source = fs.readFileSync(fileURLToPath(new URL('../public/settings.js', import.meta.url)), 'utf8');
  const sandbox = { console, window: { DVhubCommon: {}, addEventListener() {}, setTimeout() {} } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'settings.js' });
  return sandbox.DVhubSettingsPricingPeriods;
}

const { tariffProviderStatsText } = loadHelpers();

test('Auswertung: Mittelwerte, Formel netto ≈ a + b × Börse, Abweichung', () => {
  const text = tariffProviderStatsText({
    ok: true, provider: 'lichtblick', providerLabel: 'LichtBlick', days: 30, pairs: 2880, priceBasis: 'gross_total', vatPct: 19,
    meanProviderCtKwh: 48.123, meanMarketCtKwh: 9.8, meanSpreadCtKwh: 38.323,
    formula: { gross: { interceptCtKwh: 35.843, slope: 1.2495 }, net: { interceptCtKwh: 30.12, slope: 1.05 }, r2: 0.9712, meanAbsDeviationCtKwh: 0.42, maxAbsDeviationCtKwh: 1.8 }
  });
  assert.match(text, /Letzte 30 Tage/);
  assert.match(text, /2\.880 Viertelstunden/);
  assert.match(text, /LichtBlick Ø 48,12 ct\/kWh brutto/);
  assert.match(text, /Day-Ahead Ø 9,80 ct\/kWh/);
  assert.match(text, /netto ≈ 30,12 ct \+ 1,050 × Börsenpreis/);
  assert.match(text, /Ø 0,42 ct, höchstens 1,80 ct/);
  assert.match(text, /R² 0,97/);
});

test('Auswertung: zu wenige Daten, keine Daten, Fehler', () => {
  assert.match(tariffProviderStatsText({ ok: true, days: 7, pairs: 5, meanProviderCtKwh: 40, meanMarketCtKwh: 8, meanSpreadCtKwh: 32, formula: null }), /zu wenige Viertelstunden/);
  assert.match(tariffProviderStatsText({ ok: true, days: 7, pairs: 0, formula: null }), /Noch keine Viertelstunde/);
  assert.match(tariffProviderStatsText({ ok: false, error: 'Keine Datenbank — Auswertung nicht möglich.' }), /Keine Datenbank/);
  assert.match(tariffProviderStatsText(null), /nicht abrufbar/);
});

test('Auswertung: Lesart „nur Energiepreis netto“ ohne MwSt-Umrechnung', () => {
  const text = tariffProviderStatsText({
    ok: true, providerLabel: 'Tibber', days: 7, pairs: 600, priceBasis: 'net_energy',
    meanProviderCtKwh: 12, meanMarketCtKwh: 9, meanSpreadCtKwh: 3,
    formula: { gross: { interceptCtKwh: 3, slope: 1 }, net: { interceptCtKwh: 3, slope: 1 }, r2: 1, meanAbsDeviationCtKwh: 0, maxAbsDeviationCtKwh: 0 }
  });
  assert.match(text, /Tibber Ø 12,00 ct\/kWh netto/);
  assert.doesNotMatch(text, /brutto:/);
});
