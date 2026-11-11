// Endkundenpreis „LUOX Dynamisch“ (services/tariff-provider/luox-pricing.js)
// aus den Produktbestandteilen des Portals (products/{C…}/{tag}/{tag}).
// Fixture: Struktur live 11.11.2026, Werte anonymisiert/verändert.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { extractLuoxTariff, luoxEndCustomerGrossCtKwh } from '../services/tariff-provider/luox-pricing.js';

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'luox', name), 'utf8'));
const near = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('Bestandteile je kWh: Umlagen/Netzentgelt/Steuern am Börsen-Arbeitspreis + Herkunftsnachweise, 3 % auf den Spot', () => {
  const t = extractLuoxTariff(fixture('products-dynamisch.json'), { date: '2026-11-11' });
  assert.equal(t.displayName, 'LUOX Dynamisch');
  assert.equal(t.complete, true);
  assert.equal(t.percentOfSpot, 3);
  assert.equal(t.vatPct, 19);
  near(t.perKwh.net, 14.586 + 0.3529412);
  near(t.perKwh.gross, 17.35734 + 0.42);
  const names = t.perKwhItems.map((i) => i.name);
  for (const n of ['Herkunftsnachweise', 'Konzessionsabgabe', 'VNB Tariff (Arbeitspreis)', 'stromst']) assert.ok(names.includes(n), n);
  assert.ok(!names.includes('Börsenstrompreis'), 'der Schätzwert im Arbeitspreis (Ø-Spot) zählt nicht — der Spot kommt je Viertelstunde dazu');
  // Monatliche Posten und Ausgleichskosten gehören nicht in den Preis je kWh
  assert.deepEqual(t.monthlyItems.map((i) => i.name).sort(), ['LUOX Energy Gebühr', 'Netzentgelte']);
  assert.ok(t.notes.some((n) => /Ausgleichskosten/.test(n)));
});

test('Endpreis je Viertelstunde: (Spot + 3 % vom Betrag des Spots) × MwSt + feste Bestandteile brutto', () => {
  const t = extractLuoxTariff(fixture('products-dynamisch.json'), { date: '2026-11-11' });
  near(luoxEndCustomerGrossCtKwh(10, t), (10 + 0.3) * 1.19 + 17.77734);
  // Negativer Spot: Gutschrift wird weitergegeben, die 3 % fallen auf den Betrag an
  near(luoxEndCustomerGrossCtKwh(-2, t), (-2 + 0.06) * 1.19 + 17.77734);
  assert.equal(luoxEndCustomerGrossCtKwh(NaN, t), null);
  assert.equal(luoxEndCustomerGrossCtKwh(10, { complete: false }), null);
});

test('Bestandteile außerhalb ihres Gültigkeitszeitraums zählen nicht', () => {
  const json = fixture('products-dynamisch.json');
  const item = json.product_infos[0].periods[0].product_items.find((i) => i.classification === 'spot_working_price');
  item.associated_costs.push({ name: 'alt', unit: 'ct/kWh', valid_from: '2025-01-01', valid_until: '2025-12-31', cost_per_unit_net: 50, cost_per_unit_gross: 59.5, display_name: 'abgelaufen' });
  const t = extractLuoxTariff(json, { date: '2026-11-11' });
  assert.ok(!t.perKwhItems.some((i) => i.name === 'abgelaufen'));
});

test('Ohne Börsen-Arbeitspreis (z. B. Direktvermarktungsvertrag) oder außerhalb des Zeitraums: nicht vollständig', () => {
  const dv = extractLuoxTariff(fixture('products-direktvermarktung.json'), { date: '2026-11-11' });
  assert.equal(dv.complete, false);
  assert.equal(dv.displayName, 'LUOX Direktvermarktung Spot');
  const outside = extractLuoxTariff(fixture('products-dynamisch.json'), { date: '2026-12-24' });
  assert.equal(outside.complete, false);
  assert.equal(extractLuoxTariff(null, { date: '2026-11-11' }).complete, false);
});

test('Unbekannter Prozent-Posten wird nicht still verrechnet, sondern gemeldet', () => {
  const json = fixture('products-dynamisch.json');
  json.product_infos[0].periods[0].variable_costs.push({ cost_type: 'neuer_aufschlag', unit: '1/100', valid_from: '1970-01-01', valid_until: null, name: 'x', value: 5, display_name: 'Neu' });
  const t = extractLuoxTariff(json, { date: '2026-11-11' });
  assert.equal(t.percentOfSpot, 3);
  assert.ok(t.notes.some((n) => /Neu/.test(n)));
});
