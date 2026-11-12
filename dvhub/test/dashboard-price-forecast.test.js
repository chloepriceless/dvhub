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
