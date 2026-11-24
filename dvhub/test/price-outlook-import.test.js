// test/price-outlook-import.test.js — Bezugspreis-Prognose (Christin
// 19.11.2026): Auf die Börsenpreis-Prognose (Residuallast, dvhub.online) setzt
// DVhub den Bezugspreis auf — was der Strom aus dem Netz dann kostet.
//
// GET /api/price/outlook liefert dafür `importSlots` je Viertelstunde (Modul-3-
// Fenster und Zeitraumgrenzen liegen nicht auf vollen Stunden) aus P50/P10/P90
// der Börse, gerechnet mit derselben Quelle wie EOS (eos-forecast-bridge.js:
// cfg.userEnergyPricing, Zeitzone cfg.optimizer.timezone,
// resolveUserImportPriceCtKwhForSlot).
//
// Fixture: echte Antwort vom 12.11.2026 (120 Stunden ab 2026-11-12T23:00Z =
// 13.11. 00:00 Ortszeit). Erste Stunde P10/P50/P90 104,7/135,5/174,4 €/MWh.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseOutlook, buildPriceOutlookPayload, fillPriceSlotsFromOutlook } from '../services/optimizer/price-outlook.js';
import { resolveUserImportPriceCtKwhForSlot } from '../config-model.js';
import { putProviderSlots, clearProviderPrices, setProviderEstimate } from '../services/tariff-provider/price-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/residual-load-outlook-2026-11-12.json'), 'utf8'));
const H = 3_600_000;
const Q = 15 * 60_000;
const FIRST = Date.parse('2026-11-12T23:00:00Z');
const NOW = Date.parse('2026-11-12T09:07:00Z');
const COMPONENTS = { energyMarkupCtKwh: 2, gridChargesCtKwh: 10, leviesAndFeesCtKwh: 3, vatPct: 19 };


/** Echte 15-min-Preise bis zum Beginn der Prognose (12.11. 23:00Z). */
function realData() {
  const data = [];
  for (let ms = Date.parse('2026-11-11T23:00:00Z'); ms < FIRST; ms += Q) data.push({ ts: ms, ct_kwh: 20 });
  return data;
}

function payload(userEnergyPricing, { outlook = parseOutlook(FIXTURE).outlook, timezone = 'Europe/Berlin', nowMs = NOW, data = realData(), cfgExtra = {} } = {}) {
  const svc = { current: () => ({ status: 'live', reason: null, outlook, issuedAt: outlook.issuedAt, fetchedAt: outlook.issuedAt, unavailableSince: null }) };
  const cfg = {
    epex: { enabled: true, bzn: 'DE-LU', priceSource: 'dvhub' },
    optimizer: { timezone },
    userEnergyPricing,
    ...cfgExtra,
  };
  return buildPriceOutlookPayload({ state: { epex: { data } }, cfg, priceOutlook: svc, nowMs });
}

const slotAt = (p, ms) => p.importSlots.find((s) => s.ts === ms);

test.beforeEach(() => clearProviderPrices());
test.after(() => clearProviderPrices());

test('Bezugspreis-Prognose: je Viertelstunde hinter den echten Preisen, so weit die Börsen-Prognose reicht', () => {
  const p = payload({ mode: 'dynamic', dynamicComponents: COMPONENTS });
  assert.ok(Array.isArray(p.importSlots), 'importSlots');
  assert.equal(p.importSlots.length, p.hours.length * 4);
  assert.equal(p.importSlots[0].ts, FIRST);
  assert.equal(p.importSlots[1].ts, FIRST + Q);
  assert.equal(p.importSlots.at(-1).ts, p.hours.at(-1).ts + H - Q);
  for (let i = 1; i < p.importSlots.length; i += 1) assert.equal(p.importSlots[i].ts - p.importSlots[i - 1].ts, Q);
});

test('Dynamisch: Börse + Aufschlag, Netzentgelt, Umlagen, MwSt — Band aus P10/P90 der Börse', () => {
  const p = payload({ mode: 'dynamic', dynamicComponents: COMPONENTS });
  // (13,55 + 2 + 10 + 3) × 1,19 = 33,97; P10 (10,47 + 15) × 1,19 = 30,31; P90 (17,44 + 15) × 1,19 = 38,6
  for (let k = 0; k < 4; k += 1) {
    assert.deepEqual(slotAt(p, FIRST + k * Q), { ts: FIRST + k * Q, p50: 33.97, p10: 30.31, p90: 38.6 });
  }
  // Börsen-Stunden bleiben unverändert (ct/kWh Börse).
  assert.equal(p.hours[0].p50, 13.55);
  assert.ok(p.importSlots.every((s) => s.p10 <= s.p50 && s.p50 <= s.p90));
});

test('Fest: Bezugspreis hängt nicht von der Börse ab — Band fällt auf den Preis zusammen, nichts erfunden', () => {
  const o = parseOutlook(FIXTURE).outlook;
  o.hours[1] = { ...o.hours[1], p10: null, p90: null }; // Stunde ohne Börsen-Band
  const p = payload({ mode: 'fixed', fixedGrossImportCtKwh: 26.9 }, { outlook: o });
  assert.deepEqual(slotAt(p, FIRST), { ts: FIRST, p50: 26.9, p10: 26.9, p90: 26.9 });
  // Ohne Börsen-Band kein Bezugs-Band.
  assert.deepEqual(slotAt(p, FIRST + H), { ts: FIRST + H, p50: 26.9, p10: null, p90: null });
});

test('§14a Modul 3: Fenster ab 01:15 Ortszeit ersetzt das Netzentgelt — innerhalb der Stunde ändert sich der Preis', () => {
  const pricing = {
    mode: 'dynamic',
    dynamicComponents: COMPONENTS,
    usesParagraph14aModule3: true,
    module3Windows: { window1: { enabled: true, label: 'Niedriglast', start: '01:15', end: '02:00', priceCtKwh: 2 } },
  };
  const p = payload(pricing);
  const h1 = FIRST + H; // 13.11. 00:00Z = 01:00 Ortszeit, Börse P50 11,15 ct
  // 01:00: (11,15 + 15) × 1,19 = 31,12; ab 01:15: (11,15 + 2 + 3) × 1,19 + 2 = 21,22
  assert.equal(slotAt(p, h1).p50, 31.12);
  assert.equal(slotAt(p, h1 + Q).p50, 21.22);
  assert.equal(slotAt(p, h1 + 3 * Q).p50, 21.22);
  assert.equal(slotAt(p, h1 + H).p50, resolveUserImportPriceCtKwhForSlot({ ts: h1 + H, ct_kwh: 10.64 }, pricing, { timeZone: 'Europe/Berlin' }));
  // Band im Fenster: P10/P90 der Börse mit demselben Fenster.
  assert.equal(slotAt(p, h1 + Q).p10, resolveUserImportPriceCtKwhForSlot({ ts: h1 + Q, ct_kwh: 8.07 }, pricing, { timeZone: 'Europe/Berlin' }));
  assert.equal(slotAt(p, h1 + Q).p90, resolveUserImportPriceCtKwhForSlot({ ts: h1 + Q, ct_kwh: 15.05 }, pricing, { timeZone: 'Europe/Berlin' }));
});

test('Zeitzone wie EOS (optimizer.timezone): dasselbe Fenster liegt bei UTC eine Stunde später', () => {
  const pricing = {
    mode: 'dynamic',
    dynamicComponents: COMPONENTS,
    usesParagraph14aModule3: true,
    module3Windows: { window1: { enabled: true, start: '01:15', end: '02:00', priceCtKwh: 2 } },
  };
  const p = payload(pricing, { timezone: 'UTC', cfgExtra: { schedule: { timezone: 'Europe/Berlin' } } });
  const h1 = FIRST + H; // 00:00Z
  assert.equal(slotAt(p, h1 + Q).p50, 31.12, '00:15Z liegt in UTC nicht im Fenster');
  assert.equal(slotAt(p, FIRST + 2 * H + Q).p50, 20.61, '01:15Z liegt in UTC im Fenster: (10,64 + 5) × 1,19 + 2');
});

test('Zeitraumgrenze: ab 14.11. (Ortszeit) gilt der neue Preis — Wechsel um 23:00Z, nicht zur vollen UTC-Stunde des Tages', () => {
  const pricing = {
    mode: 'fixed',
    fixedGrossImportCtKwh: 26.9,
    periods: [{ id: 'neu', startDate: '2026-11-14', endDate: '2027-12-31', mode: 'fixed', fixedGrossImportCtKwh: 31.5 }],
  };
  const p = payload(pricing);
  const boundary = Date.parse('2026-11-13T23:00:00Z'); // 14.11. 00:00 Ortszeit
  assert.equal(slotAt(p, boundary - Q).p50, 26.9);
  assert.equal(slotAt(p, boundary).p50, 31.5);
  assert.equal(slotAt(p, boundary).p90, 31.5);
});

test('Anbieter: fehlende Slots aus der angelernten Geraden, gespeicherte Anbieterpreise gelten fest', () => {
  setProviderEstimate({ slope: 1.2, intercept: 15, n: 96 });
  putProviderSlots('tibber', [{ ts: FIRST + Q, ctKwh: 29.5, durationMs: Q }]);
  const p = payload({ mode: 'provider', provider: { priceBasis: 'gross_total' }, dynamicComponents: COMPONENTS });
  // 1,2 × 13,55 + 15 = 31,26; P10 1,2 × 10,47 + 15 = 27,56; P90 1,2 × 17,44 + 15 = 35,93
  assert.deepEqual(slotAt(p, FIRST), { ts: FIRST, p50: 31.26, p10: 27.56, p90: 35.93 });
  // Bekannter Anbieterpreis: unabhängig von der Börse.
  assert.deepEqual(slotAt(p, FIRST + Q), { ts: FIRST + Q, p50: 29.5, p10: 29.5, p90: 29.5 });
});

test('Anbieter mit fallender Geraden: Band bleibt unten ≤ Mitte ≤ oben', () => {
  setProviderEstimate({ slope: -0.5, intercept: 40, n: 96 });
  const p = payload({ mode: 'provider', provider: { priceBasis: 'gross_total' } });
  const s = slotAt(p, FIRST);
  assert.equal(s.p50, 33.23); // 40 − 0,5 × 13,55
  assert.equal(s.p10, 31.28); // aus P90 der Börse
  assert.equal(s.p90, 34.77); // aus P10 der Börse
});

test('Kein Bezugspreis einstellbar (fest ohne Betrag): null — nie der Börsenpreis als Bezug', () => {
  const p = payload({ mode: 'fixed' });
  assert.equal(p.importSlots.length, p.hours.length * 4);
  assert.ok(p.importSlots.every((s) => s.p50 === null && s.p10 === null && s.p90 === null));
  assert.ok(p.hours.length > 0, 'Börsen-Prognose bleibt');
});

test('Bezugs-P50 ist genau der Bezugspreis, den EOS für den Prognose-Schwanz bekommt', () => {
  const pricing = {
    mode: 'dynamic',
    dynamicComponents: COMPONENTS,
    usesParagraph14aModule3: true,
    module3Windows: { window1: { enabled: true, start: '01:15', end: '06:30', priceCtKwh: 0.59 } },
  };
  const p = payload(pricing);
  const real = realData().map((r) => ({ start: new Date(r.ts).toISOString(), ctKwh: r.ct_kwh }));
  const tail = fillPriceSlotsFromOutlook(real, { outlook: parseOutlook(FIXTURE).outlook, untilMs: NOW + 72 * H, nowMs: NOW });
  const added = tail.slots.slice(real.length);
  assert.ok(added.length > 100);
  for (const s of added) {
    // wie importCtOf in eos-forecast-bridge.js
    const eos = resolveUserImportPriceCtKwhForSlot({ ts: s.start, ct_kwh: s.ctKwh }, pricing, { timeZone: 'Europe/Berlin' });
    assert.equal(slotAt(p, Date.parse(s.start)).p50, eos, s.start);
  }
});

test('Ohne echte Preise: nur Viertelstunden ab jetzt; ohne Prognose keine Bezugs-Slots', () => {
  const now = FIRST + 20 * 60_000; // 23:20Z
  const p = payload({ mode: 'fixed', fixedGrossImportCtKwh: 26.9 }, { nowMs: now, data: [] });
  assert.equal(p.hours[0].ts, FIRST);
  assert.equal(p.importSlots[0].ts, FIRST + Q, 'Viertelstunde 23:00–23:15 ist vorbei');
  const none = buildPriceOutlookPayload({ state: {}, cfg: { userEnergyPricing: { mode: 'fixed', fixedGrossImportCtKwh: 26.9 } }, priceOutlook: null, nowMs: now });
  assert.deepEqual(none.importSlots, []);
});

test('Kaputte Preis-Einstellungen lassen die Börsen-Prognose stehen', () => {
  const broken = { get mode() { throw new Error('kaputt'); } };
  const p = payload(broken);
  assert.ok(p.hours.length > 0);
  assert.deepEqual(p.importSlots, []);
  assert.equal(p.status, 'live');
});

// Der Leitstand fragt /api/price/outlook alle 3 s; 480 Viertelstunden × 3
// Bezugspreise kosten auf kleinen Boards spürbar Rechenzeit. Zwischenspeicher
// höchstens 60 s — Änderungen an Tarif, Zeitzone, Anbieterpreisen oder der
// Prognose gelten sofort bzw. spätestens nach einer Minute.
test('Zwischenspeicher: gleiche Lage → keine Neuberechnung; geänderter Tarif, Zeitzone, neue Gerade oder 60 s → neu', () => {
  const outlook = parseOutlook(FIXTURE).outlook;
  const pricing = { mode: 'fixed', fixedGrossImportCtKwh: 26.9 };
  const a = payload(pricing, { outlook });
  const b = payload(pricing, { outlook, nowMs: NOW + 5_000 });
  assert.equal(b.importSlots, a.importSlots, 'Treffer innerhalb von 60 s');
  // Gespeicherte Einstellungen: neues Objekt (server.js ersetzt cfg beim Speichern).
  const c = payload({ ...pricing, fixedGrossImportCtKwh: 30 }, { outlook, nowMs: NOW + 6_000 });
  assert.equal(slotAt(c, FIRST).p50, 30);
  assert.equal(payload({ ...pricing, fixedGrossImportCtKwh: 30 }, { outlook, nowMs: NOW + 7_000 }).importSlots, c.importSlots, 'gleicher Inhalt → Treffer');
  const d = payload({ ...pricing, fixedGrossImportCtKwh: 30 }, { outlook, nowMs: NOW + 7_000, timezone: 'UTC' });
  assert.notEqual(d.importSlots, c.importSlots, 'andere Zeitzone');
  // Höchstens 60 s (alles in derselben Viertelstunde 09:00–09:15Z).
  const g1 = payload(pricing, { outlook, nowMs: NOW + 100_000 });
  assert.equal(payload(pricing, { outlook, nowMs: NOW + 159_000 }).importSlots, g1.importSlots, '59 s: Treffer');
  assert.notEqual(payload(pricing, { outlook, nowMs: NOW + 161_000 }).importSlots, g1.importSlots, '61 s: neu');
  const prov = { mode: 'provider', provider: { priceBasis: 'gross_total' } };
  setProviderEstimate({ slope: 1, intercept: 10, n: 96 });
  assert.equal(slotAt(payload(prov, { outlook, nowMs: NOW + 71_000 }), FIRST).p50, 23.55);
  setProviderEstimate({ slope: 1, intercept: 20, n: 96 });
  assert.equal(slotAt(payload(prov, { outlook, nowMs: NOW + 72_000 }), FIRST).p50, 33.55, 'neue Gerade gilt sofort');
  // Neue Prognose (anderes Objekt) → neu.
  const f = payload(pricing, { nowMs: NOW + 72_000 });
  assert.notEqual(f.importSlots, payload(pricing, { nowMs: NOW + 72_000 }).importSlots);
});
