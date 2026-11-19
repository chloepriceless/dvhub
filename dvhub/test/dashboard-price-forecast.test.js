// test/dashboard-price-forecast.test.js — Preisprognose in der Leitstand-
// Preiskurve (1.0.11): gestrichelt hinter den festen Börsenpreisen, mit Band,
// nicht auswählbar, Zeile „Preisprognose bis … / nicht verfügbar seit …“.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function loadDashboardHelpers() {
  const appPath = fileURLToPath(new URL('../public/app.js', import.meta.url));
  const source = fs.readFileSync(appPath, 'utf8');
  const sandbox = {
    console, Date, Math, Number, JSON, Intl, Set, Map,
    window: { DVhubCommon: { apiFetch: async () => ({ ok: true, json: async () => ({}) }) }, addEventListener() {}, setInterval() {}, clearInterval() {} },
    setInterval() {}, clearInterval() {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: path.basename(appPath) });
  return sandbox.DVhubDashboard || sandbox.window.DVhubDashboard;
}

const H = 3_600_000;
const Q = 900_000;

test('Prognose-Zeilen: beginnen am Ende der festen Preise, im 15-min-Raster, höchstens bis jetzt + 36 h, enden an einer Lücke', () => {
  const { buildPriceForecastRows } = loadDashboardHelpers();
  const now = Date.parse('2026-11-12T09:07:00Z');
  const real = [];
  for (let t = Date.parse('2026-11-11T23:00:00Z'); t < Date.parse('2026-11-12T23:00:00Z'); t += Q) real.push({ ts: t, ct_kwh: 20 });
  const hours = [];
  for (let t = Date.parse('2026-11-12T23:00:00Z'); t < Date.parse('2026-11-17T23:00:00Z'); t += H) hours.push({ ts: t, p50: 13.55, p10: 10.47, p90: 17.44 });
  const rows = buildPriceForecastRows(real, { hours }, now);
  assert.equal(rows[0].ts, Date.parse('2026-11-12T23:00:00Z'));
  assert.equal(rows[1].ts - rows[0].ts, Q);
  assert.ok(rows.at(-1).ts < now + 36 * H);
  assert.ok(rows.at(-1).ts >= now + 36 * H - Q);
  assert.ok(rows.every((r) => r.forecast === true && r.ct_kwh === null && r.p50 === 13.55 && r.p10 === 10.47));
  // Lücke nach 3 Stunden → endet dort.
  const holey = hours.filter((h) => h.ts !== Date.parse('2026-11-13T02:00:00Z'));
  assert.equal(buildPriceForecastRows(real, { hours: holey }, now).length, 3 * 4);
  // Ohne Prognose / ohne feste Preise: nichts.
  assert.equal(buildPriceForecastRows(real, null, now).length, 0);
  assert.equal(buildPriceForecastRows([], { hours }, now).length, 0);
});

test('Zeile unter der Preiskurve: Prognose bis/Stand, gespeichert, nicht verfügbar seit', () => {
  const { priceChartMetaText } = loadDashboardHelpers();
  const status = { epex: { data: [{ day: '2026-11-12' }], updatedAt: Date.now() } };
  const live = priceChartMetaText(status, { status: 'live', issuedAt: '2026-11-11T22:52:48Z', hours: [{ ts: Date.parse('2026-11-17T22:00:00Z'), p50: 13 }] });
  assert.match(live, /Preisprognose \(gestrichelt\) liegt vor bis .*Stand/);
  assert.doesNotMatch(live, /gespeichert/);
  const cached = priceChartMetaText(status, { status: 'cached', issuedAt: '2026-11-11T22:52:48Z', hours: [{ ts: Date.parse('2026-11-17T22:00:00Z'), p50: 13 }] });
  assert.match(cached, /gespeichert, neue nicht abrufbar/);
  const gone = priceChartMetaText(status, { status: 'unavailable', unavailableSince: '2026-11-13T22:52:48Z', hours: [] });
  assert.match(gone, /Preisprognose nicht verfügbar seit/);
  assert.doesNotMatch(priceChartMetaText(status, { status: 'off', reason: 'zone', hours: [] }), /Preisprognose/);
});

// Bezugspreis-Prognose (Christin 19.11.2026): Die Bezugspreis-Linie setzt sich
// im Prognosebereich fort — Werte aus /api/price/outlook `importSlots` (je
// Viertelstunde, Tarif wie EOS), Tooltip „Bezug (Prognose)“ neben der Börse.

function outlookWithImport() {
  const hours = [];
  for (let t = Date.parse('2026-11-12T23:00:00Z'); t < Date.parse('2026-11-14T23:00:00Z'); t += H) hours.push({ ts: t, p50: 13.55, p10: 10.47, p90: 17.44 });
  const importSlots = [];
  for (const h of hours) {
    for (let k = 0; k < 4; k += 1) {
      // §14a-Fenster ab der zweiten Viertelstunde jeder Stunde: Preis ändert sich innerhalb der Stunde.
      importSlots.push(k === 0 ? { ts: h.ts, p50: 33.97, p10: 30.31, p90: 38.6 } : { ts: h.ts + k * Q, p50: 21.22, p10: 18.5, p90: 26.1 });
    }
  }
  return { hours, importSlots };
}

function realRows() {
  const real = [];
  for (let t = Date.parse('2026-11-11T23:00:00Z'); t < Date.parse('2026-11-12T23:00:00Z'); t += Q) real.push({ ts: t, ct_kwh: 20 });
  return real;
}

test('Prognose-Zeilen tragen den Bezugspreis je Viertelstunde (P50/P10/P90), fehlend → null', () => {
  const { buildPriceForecastRows } = loadDashboardHelpers();
  const now = Date.parse('2026-11-12T09:07:00Z');
  const rows = buildPriceForecastRows(realRows(), outlookWithImport(), now);
  assert.equal(rows[0].importP50, 33.97);
  assert.equal(rows[0].importP10, 30.31);
  assert.equal(rows[0].importP90, 38.6);
  assert.equal(rows[1].importP50, 21.22, 'Viertelstunde, nicht Stundenwert');
  assert.equal(rows[1].importP10, 18.5);
  // Ohne importSlots (älterer Server) oder ohne Bezugspreis: null.
  const old = buildPriceForecastRows(realRows(), { hours: outlookWithImport().hours }, now);
  assert.ok(old.length > 0 && old.every((r) => r.importP50 === null && r.importP10 === null && r.importP90 === null));
  const unresolved = { ...outlookWithImport(), importSlots: outlookWithImport().importSlots.map((s) => ({ ts: s.ts, p50: null, p10: null, p90: null })) };
  assert.ok(buildPriceForecastRows(realRows(), unresolved, now).every((r) => r.importP50 === null));
  // Stundenraster der festen Preise: Wert der Viertelstunde am Zeilenbeginn.
  const hourly = [];
  for (let t = Date.parse('2026-11-11T23:00:00Z'); t < Date.parse('2026-11-12T23:00:00Z'); t += H) hourly.push({ ts: t, ct_kwh: 20 });
  const hRows = buildPriceForecastRows(hourly, outlookWithImport(), now);
  assert.equal(hRows[1].ts - hRows[0].ts, H);
  assert.equal(hRows[1].importP50, 33.97);
});

test('Bezugspreis-Reihe der Preiskurve: feste Slots aus dem Preisvergleich, Prognose-Slots aus der Bezugspreis-Prognose', () => {
  const { priceChartImportSeries } = loadDashboardHelpers();
  const data = [
    { ts: 1000, ct_kwh: 20 },
    { ts: 2000, ct_kwh: 21 },
    { ts: 3000, ct_kwh: null, forecast: true, p50: 13, importP50: 31.5 },
    { ts: 4000, ct_kwh: null, forecast: true, p50: 13, importP50: null },
  ];
  const comparisons = [{ ts: 1000, importPriceCtKwh: 30.1 }, { ts: 2000, importPriceCtKwh: null }];
  assert.deepEqual(Array.from(priceChartImportSeries(data, comparisons)), [30.1, null, 31.5, null]);
  // Ein Vergleichswert für einen Prognose-Zeitpunkt gilt nicht (die Prognose-Zeile hat Vorrang).
  assert.deepEqual(Array.from(priceChartImportSeries(data, [{ ts: 3000, importPriceCtKwh: 99 }])), [null, null, 31.5, null]);
});

test('Tooltip im Prognosebereich: Börse (Prognose) und Bezug (Prognose) mit Spanne; fester Preis genau, ohne erfundene Spanne', () => {
  const { priceForecastTooltipLines } = loadDashboardHelpers();
  const dyn = Array.from(priceForecastTooltipLines({ forecast: true, p50: 13.55, p10: 10.47, p90: 17.44, importP50: 33.97, importP10: 30.31, importP90: 38.6 }));
  assert.deepEqual(dyn, [
    'Börse (Prognose): ≈ 14 ct/kWh',
    'Spanne: 10–17 ct/kWh',
    'Bezug (Prognose): ≈ 34 ct/kWh (30–39)',
    'Börsenpreis noch nicht fest',
  ]);
  const fixed = Array.from(priceForecastTooltipLines({ forecast: true, p50: 13.55, p10: 10.47, p90: 17.44, importP50: 26.9, importP10: 26.9, importP90: 26.9 }));
  assert.ok(fixed.includes('Bezug (Prognose): 26,9 ct/kWh (unabhängig von der Börse)'), fixed.join(' | '));
  const noBand = Array.from(priceForecastTooltipLines({ forecast: true, p50: 13.55, p10: null, p90: null, importP50: 33.97, importP10: null, importP90: null }));
  assert.ok(noBand.includes('Bezug (Prognose): ≈ 34 ct/kWh'), noBand.join(' | '));
  assert.ok(!noBand.some((l) => l.startsWith('Spanne')));
  const none = Array.from(priceForecastTooltipLines({ forecast: true, p50: 13.55, p10: 10.47, p90: 17.44, importP50: null, importP10: null, importP90: null }));
  assert.ok(!none.some((l) => l.startsWith('Bezug')), 'ohne Bezugspreis keine Bezugszeile');
});

test('Zeile unter der Preiskurve nennt die Bezugspreis-Prognose, wenn es sie gibt', () => {
  const { priceChartMetaText } = loadDashboardHelpers();
  const status = { epex: { data: [{ day: '2026-11-12' }], updatedAt: Date.now() } };
  const base = { status: 'live', issuedAt: '2026-11-11T22:52:48Z', hours: [{ ts: Date.parse('2026-11-17T22:00:00Z'), p50: 13 }] };
  const withImport = priceChartMetaText(status, { ...base, importSlots: [{ ts: Date.parse('2026-11-17T22:00:00Z'), p50: 31, p10: 28, p90: 35 }] });
  assert.match(withImport, /Preisprognose \(gestrichelt\) liegt vor bis .*Stand .*Bezugspreis-Prognose nach deinem Tarif/);
  assert.doesNotMatch(priceChartMetaText(status, base), /Bezugspreis/);
  assert.doesNotMatch(priceChartMetaText(status, { ...base, importSlots: [{ ts: 1, p50: null, p10: null, p90: null }] }), /Bezugspreis/);
});

// Codex ff257d67 (P2): Fehlt mitten in der Prognose der Bezugspreis (z. B.
// fester Tarif ohne Betrag, nur §14a-Fenster), darf die Linie die Lücke nicht
// überbrücken — sonst zeigt sie einen erfundenen Preis. Prüfung am echten
// drawPriceChart mit einem Chart-Stub (Datensatz-Konfiguration und Segment-Stil).
function renderPriceChart(args) {
  const appPath = fileURLToPath(new URL('../public/app.js', import.meta.url));
  const source = fs.readFileSync(appPath, 'utf8');
  const sandbox = {
    console, Date, Math, Number, JSON, Intl, Set, Map,
    window: { DVhubCommon: { apiFetch: async () => ({ ok: true, json: async () => ({}) }) }, addEventListener() {}, setInterval() {}, clearInterval() {} },
    setInterval() {}, clearInterval() {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: path.basename(appPath) });
  // Erst nach dem Laden: sonst startet app.js den ganzen Leitstand.
  const el = () => ({ style: {}, addEventListener() {}, parentElement: null, appendChild() {} });
  const nodes = { priceChartCanvas: el(), priceChartContainer: el(), tooltip: el() };
  const body = el();
  nodes.tooltip.parentElement = body;
  sandbox.document = { getElementById: (id) => nodes[id] || null, body, documentElement: {}, createElement: () => el() };
  sandbox.getComputedStyle = () => ({ getPropertyValue: () => '' });
  let config = null;
  sandbox.Chart = class { constructor(_c, cfg) { config = cfg; this.data = cfg.data; } destroy() {} getDatasetMeta() { return {}; } update() {} };
  sandbox.drawPriceChart(...args);
  return config;
}

test('Preiskurve: Bezugspreis-Linie überbrückt keine Prognose-Lücke ohne Bezugspreis, schließt aber an die festen Preise an', () => {
  const now = Date.parse('2026-11-12T09:07:00Z');
  const real = realRows();
  const comparisons = real.map((r) => ({ ts: r.ts, importPriceCtKwh: 30 }));
  const hours = [];
  for (let t = Date.parse('2026-11-12T23:00:00Z'); t < Date.parse('2026-11-14T23:00:00Z'); t += H) hours.push({ ts: t, p50: 13.55, p10: 10.47, p90: 17.44 });
  const first = Date.parse('2026-11-12T23:00:00Z');
  // Fester Tarif ohne Betrag, Modul-3-Fenster 00:00–00:30 und ab 02:00 Ortszeit: dazwischen kein Bezugspreis.
  const importSlots = [];
  for (let t = first; t < Date.parse('2026-11-14T23:00:00Z'); t += Q) {
    const known = t < first + 2 * Q || t >= first + 8 * Q;
    importSlots.push(known ? { ts: t, p50: 24.6, p10: 24.6, p90: 24.6 } : { ts: t, p50: null, p10: null, p90: null });
  }
  const cfg = renderPriceChart([real, now, comparisons, [], null, [], [], null, [], { hours, importSlots }]);
  const ds = cfg.data.datasets.find((d) => d.label === 'Bezugspreis');
  assert.ok(ds, 'Bezugspreis-Linie');
  const f = ds.data.indexOf(24.6); // erste Prognose-Zeile
  assert.ok(f > 0);
  assert.equal(ds.data[f - 1], 30);
  assert.equal(ds.data[f + 2], null);
  assert.equal(ds.data[f + 8], 24.6);
  const seg = (p0, p1) => ({ type: 'segment', p0DataIndex: p0, p1DataIndex: p1 });
  const color = (p0, p1) => ds.segment?.borderColor?.(seg(p0, p1));
  // Über die Lücke (f+1 → f+8) wird nichts gezeichnet.
  assert.ok(ds.spanGaps === false || color(f + 1, f + 8) === 'transparent', 'Lücke im Prognosebereich bleibt leer');
  // Anschluss an die festen Preise und Prognose-Abschnitte: gezeichnet, feiner gestrichelt.
  assert.notEqual(color(f - 1, f), 'transparent');
  assert.deepEqual(Array.from(ds.segment.borderDash(seg(f - 1, f))), [3, 4]);
  assert.deepEqual(Array.from(ds.segment.borderDash(seg(f + 8, f + 9))), [3, 4]);
  // Feste Preise: Stil der Linie unverändert.
  assert.equal(ds.segment.borderDash(seg(f - 3, f - 2)), undefined);
  assert.equal(color(f - 3, f - 2), undefined);
});
