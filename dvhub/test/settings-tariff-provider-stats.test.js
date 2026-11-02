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

// Gegenprüfung 24884430 (P3): Zwischenspeicher gilt nur für denselben Anbieter
// und Zeitraum und höchstens eine Minute.
test('Zwischenspeicher: Anbieter und Zeitraum gehören zum Schlüssel', () => {
  const { tariffProviderStatsCacheHit } = loadHelpers();
  const cache = { provider: 'tibber', days: '30', at: 1_000_000, data: {} };
  assert.equal(tariffProviderStatsCacheHit(cache, 'tibber', '30', 1_030_000), true);
  assert.equal(tariffProviderStatsCacheHit(cache, 'lichtblick', '30', 1_030_000), false, 'Anbieter gewechselt');
  assert.equal(tariffProviderStatsCacheHit(cache, 'tibber', '7', 1_030_000), false);
  assert.equal(tariffProviderStatsCacheHit(cache, 'tibber', '30', 1_061_000), false, 'nach einer Minute');
  assert.equal(tariffProviderStatsCacheHit(null, 'tibber', '30', 1_030_000), false);
});

// Gegenprüfung c7263d78 (P3): eine Antwort für einen anderen Anbieter als den
// angezeigten (ungespeicherter Entwurf) wird nicht zwischengespeichert.
test('Zwischenspeicher: nur gültige Antworten des angezeigten Anbieters', () => {
  const { tariffProviderStatsCacheable } = loadHelpers();
  assert.equal(tariffProviderStatsCacheable({ ok: true, provider: 'tibber' }, 'tibber'), true);
  assert.equal(tariffProviderStatsCacheable({ ok: true, provider: 'tibber' }, 'lichtblick'), false);
  assert.equal(tariffProviderStatsCacheable({ ok: false, code: 'no_store' }, 'tibber'), false);
  assert.equal(tariffProviderStatsCacheable(null, 'tibber'), false);
});

// Gegenprüfung 6a817dcb (P3): Neuzeichnen während „Jetzt abrufen“ darf den
// sichtbaren Block nicht auf „wird geladen“ hängen lassen.
test('Neuzeichnen während „Jetzt abrufen“: der sichtbare Block zeigt am Ende die Auswertung', async () => {
  const pending = [];
  const sandbox = {
    console,
    window: {
      DVhubCommon: {
        escapeHtml: (s) => String(s),
        apiFetch: (url, opts) => new Promise((resolve) => pending.push({ url, method: opts?.method || 'GET', resolve }))
      },
      addEventListener() {}, setTimeout() {}
    }
  };
  sandbox.globalThis = sandbox;
  const source = fs.readFileSync(fileURLToPath(new URL('../public/settings.js', import.meta.url)), 'utf8');
  vm.runInNewContext(source, sandbox, { filename: 'settings.js' });
  const { bindTariffProviderBlock } = sandbox.DVhubSettingsPricingPeriods;

  const flush = () => new Promise((r) => setImmediate(r));
  const answer = (match, body) => {
    const i = pending.findIndex((p) => match(p));
    assert.ok(i >= 0, 'Anfrage erwartet');
    const [p] = pending.splice(i, 1);
    p.resolve({ json: async () => body });
  };
  const isStats = (p) => p.url.startsWith('/api/tariff-provider/stats');
  function block() {
    const handlers = {};
    const el = {
      status: { textContent: '', style: {}, isConnected: true },
      stats: { textContent: '', style: {}, isConnected: true },
      days: { value: '30', addEventListener() {} },
      refresh: { dataset: { tariffProviderAction: 'refresh' }, addEventListener: (ev, fn) => { handlers.click = fn; } }
    };
    el.section = {
      querySelector: (sel) => ({ '[data-tariff-provider-status]': el.status, '[data-tariff-provider-stats]': el.stats, '[data-tariff-provider-stats-days]': el.days }[sel] || null),
      querySelectorAll: () => [el.refresh]
    };
    el.click = () => handlers.click();
    return el;
  }
  const uep = { provider: { name: 'lichtblick' } };
  const ok = (pairs) => ({ ok: true, provider: 'lichtblick', days: 30, pairs, meanProviderCtKwh: 40, meanMarketCtKwh: 8, meanSpreadCtKwh: 32, formula: null });

  // Wie im Betrieb: Der Block hängt beim Binden noch nicht im Dokument.
  const a = block();
  a.stats.isConnected = false; a.status.isConnected = false;
  bindTariffProviderBlock(a.section, uep);
  a.stats.isConnected = true; a.status.isConnected = true;
  assert.ok(pending.some(isStats), 'Auswertung wird beim Zeichnen abgefragt (Gegenprüfung b83f668a, P1)');
  answer((p) => p.url === '/api/tariff-provider', { ok: true, state: null });
  answer(isStats, { ok: false, code: 'error', error: 'kurz weg' });   // nicht zwischengespeichert
  await flush();
  const clicking = a.click();                                          // POST hängt noch
  a.stats.isConnected = false; a.status.isConnected = false;           // neu gezeichnet
  const b = block();
  b.stats.isConnected = false; b.status.isConnected = false;
  bindTariffProviderBlock(b.section, uep);
  b.stats.isConnected = true; b.status.isConnected = true;
  answer((p) => p.url === '/api/tariff-provider', { ok: true, state: null });
  answer((p) => p.method === 'POST', { ok: true, state: null });
  await clicking;
  await flush();
  while (pending.some(isStats)) { answer(isStats, ok(96)); await flush(); }
  assert.match(b.stats.textContent, /96 Viertelstunden/, `sichtbarer Block: ${b.stats.textContent}`);
});
