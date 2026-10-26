// test/price-hours-view.test.js -- Preis-Stunden im Leitstand (Issue #27, Wunsch
// eines Customers 26.10.2026): Wie viele Stunden liegt der Börsenpreis heute und
// morgen über der Verkaufs- bzw. unter der Einkaufsschwelle, und mit welcher
// Leistung müsste man dafür fahren? Reine Rechen- und Anzeigelogik aus
// public/price-hours-view.js, geladen wie im Browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function load() {
  const file = fileURLToPath(new URL('../public/price-hours-view.js', import.meta.url));
  const sandbox = { window: {}, document: undefined };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: 'price-hours-view.js' });
  return sandbox.window.DVhubPriceHours;
}

const Q = 15 * 60 * 1000;
// Tag mit 96 Viertelstunden ab t0; prices[i] = ct/kWh des i-ten Slots.
function day(dayStr, t0, prices) {
  return prices.map((ct, i) => ({ ts: t0 + i * Q, day: dayStr, ct_kwh: ct }));
}
const T0 = Date.UTC(2026, 9, 26, 23, 0); // 27.10. 00:00 Berlin (Winterzeit)

test('zählt Viertelstunden über/unter der Schwelle als Stunden', () => {
  const { compute } = load();
  // heute: 15 Slots ≥ 25 ct (= 3,75 h), 24 Slots ≤ 10 ct (= 6 h), Rest 15 ct
  const today = Array(96).fill(15);
  for (let i = 40; i < 55; i += 1) today[i] = 30;
  for (let i = 0; i < 24; i += 1) today[i] = 8;
  // morgen: 20 Slots genau 25 ct (= 5 h, Schwelle zählt mit)
  const tomorrow = Array(96).fill(12);
  for (let i = 60; i < 80; i += 1) tomorrow[i] = 25;
  const rows = [...day('2026-10-27', T0, today), ...day('2026-10-28', T0 + 96 * Q, tomorrow)];
  const r = compute(rows, { today: '2026-10-27', tomorrow: '2026-10-28', sellCt: 25, buyCt: 10 });
  assert.equal(r.today.sellHours, 3.75);
  assert.equal(r.today.buyHours, 6);
  assert.equal(r.tomorrow.sellHours, 5);
  assert.equal(r.tomorrow.buyHours, 0);
  assert.equal(r.tomorrow.available, true);
});

test('Stundenpreise (60-min-Raster) zählen je Slot eine Stunde', () => {
  const { compute } = load();
  const H = 3600 * 1000;
  const rows = Array.from({ length: 24 }, (_, i) => ({ ts: T0 + i * H, day: '2026-10-27', ct_kwh: i < 3 ? 40 : 5 }));
  const r = compute(rows, { today: '2026-10-27', tomorrow: '2026-10-28', sellCt: 25, buyCt: 10 });
  assert.equal(r.today.sellHours, 3);
  assert.equal(r.today.buyHours, 21);
  assert.equal(r.tomorrow.available, false);
});

test('ohne Schwelle keine Zählung; Komma als Dezimaltrenner', () => {
  const { compute, parseCt } = load();
  const rows = day('2026-10-27', T0, Array(96).fill(30));
  const r = compute(rows, { today: '2026-10-27', tomorrow: '2026-10-28', sellCt: null, buyCt: null });
  assert.equal(r.today.sellHours, null);
  assert.equal(r.today.buyHours, null);
  assert.equal(parseCt('25,5'), 25.5);
  assert.equal(parseCt(' '), null);
  assert.equal(parseCt('abc'), null);
});

test('Anzeige: Stunden deutsch formatiert, Leistung aus Menge ÷ Stunden', () => {
  const { view } = load();
  const v = view({
    today: { available: true, sellHours: 3.75, buyHours: 6 },
    tomorrow: { available: true, sellHours: 5, buyHours: 0 },
  }, { sellCt: 25, buyCt: 10, energyKwh: 15 });
  assert.equal(v.sell, 'Verkauf ≥ 25 ct: heute 3,75 h (≈ 4 kW) · morgen 5 h (≈ 3 kW)');
  assert.equal(v.buy, 'Einkauf ≤ 10 ct: heute 6 h (≈ 2,5 kW) · morgen 0 h');
});

test('Anzeige: morgen noch ohne Preise, Schwelle leer', () => {
  const { view } = load();
  const v = view({
    today: { available: true, sellHours: 0, buyHours: null },
    tomorrow: { available: false, sellHours: null, buyHours: null },
  }, { sellCt: 25, buyCt: null, energyKwh: null });
  assert.equal(v.sell, 'Verkauf ≥ 25 ct: heute 0 h · morgen ab ~13 Uhr');
  assert.equal(v.buy, 'Einkauf: Schwelle eintragen');
});

// Codex-Gegenprüfung 6576bc79 (2× P2): Lücken sind keine längeren Slots, fehlende
// Preise sind kein 0-ct-Preis.
test('Lücken im Tag gelten nicht als Slot-Länge', () => {
  const { compute } = load();
  // nur zwei Viertelstunden, zwei Stunden auseinander → 0,5 h, nicht 4 h
  const rows = [
    { ts: T0, day: '2026-10-27', ct_kwh: 30 },
    { ts: T0 + 8 * Q, day: '2026-10-27', ct_kwh: 30 },
  ];
  const r = compute(rows, { today: '2026-10-27', tomorrow: '2026-10-28', sellCt: 25, buyCt: null });
  assert.equal(r.today.sellHours, 0.5);
});

test('fehlende Preise (null) zählen nicht als 0 ct', () => {
  const { compute } = load();
  const rows = day('2026-10-27', T0, Array(96).fill(null));
  rows[0].ct_kwh = 5;
  const r = compute(rows, { today: '2026-10-27', tomorrow: '2026-10-28', sellCt: null, buyCt: 10 });
  assert.equal(r.today.buyHours, 0.25);
  const leer = compute(day('2026-10-28', T0, Array(96).fill(null)), { today: '2026-10-28', tomorrow: null, sellCt: 25, buyCt: 10 });
  assert.equal(leer.today.available, false);
});
