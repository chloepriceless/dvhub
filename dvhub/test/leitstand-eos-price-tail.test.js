// test/leitstand-eos-price-tail.test.js — Zeile unter dem EOS-Fahrplan (1.0.11):
// wie weit EOS vorausschaut, woher die Preise im Schwanz kommen, und ohne
// Preisprognose seit wann sie fehlt.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const src = fs.readFileSync(path.resolve(import.meta.dirname, '../public/leitstand-charts.js'), 'utf8');

function helpers() {
  const sandbox = {
    console, Date, Math, Number, JSON, Intl, Set, Map,
    document: { readyState: 'loading', addEventListener() {}, getElementById: () => null },
    window: {},
    setInterval() {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, sandbox, { filename: 'leitstand-charts.js' });
  return sandbox.window.DVhubLeitstand;
}

test('Schwanz aus der Prognose: Vorausschau, begrenzt durch, Quelle mit Stand', () => {
  const { eosPriceTailText } = helpers();
  const r = eosPriceTailText({
    used: true, status: 'live', from: '2026-11-12T23:00:00Z', issuedAt: '2026-11-11T22:52:48Z',
    lookahead: { until: '2026-11-15T09:00:00Z', limitedBy: 'pv' },
  });
  assert.match(r.text, /^EOS schaut voraus bis .* \(begrenzt durch PV-Prognose\) · Preise ab .*: Prognose dvhub\.online, Stand /);
  assert.equal(r.warn, false);
  const cached = eosPriceTailText({ used: true, status: 'cached', from: 'x', issuedAt: 'y' });
  assert.match(cached.text, /gespeichert, neue nicht abrufbar/);
  assert.equal(cached.warn, true);
});

test('Ohne Prognose: „nicht verfügbar seit …“ als Warnung; andere Zone als Hinweis', () => {
  const { eosPriceTailText } = helpers();
  const r = eosPriceTailText({ used: false, status: 'unavailable', unavailableSince: '2026-11-13T22:52:48Z', realUntil: '2026-11-13T23:00:00Z' });
  assert.match(r.text, /^Preisprognose nicht verfügbar seit .* — EOS plant nur bis zum Ende der festen Börsenpreise/);
  assert.equal(r.warn, true);
  assert.match(eosPriceTailText({ used: false, status: 'off', reason: 'zone' }).text, /nur für die Preiszone DE-LU/);
  assert.equal(eosPriceTailText(null).text, '');
});

// Codex 27983aca: Steuerzeitraum bis 120 h = 480 Zeilen — der Leitstand fragt
// genug Zeilen an (Standard der API: 300).
test('EOS-Fahrplan: Leitstand holt bis 8 Tage (768 Zeilen)', () => {
  assert.match(src, /apiFetch\('\/api\/eos\/plan\?rows=768'\)/);
});

// Codex 27983aca (P3): Mehrtägiger Plan ab 10:15 — Marken an jeder
// Ortsmitternacht (dort steht das Datum), nicht 11:00/23:00.
test('EOS-Fahrplan-Achse: mehrtägig Marken ab Ortsmitternacht, kurz alle 3 h ab voller Stunde', () => {
  const { eosPlanTicks } = helpers();
  const min = new Date(2026, 10, 12, 10, 15).getTime();
  const long = eosPlanTicks(min, min + 120 * 3600000).map((t) => new Date(t.value));
  assert.ok(long.every((d) => d.getHours() % 12 === 0 && d.getMinutes() === 0), 'alle 12 h ab Mitternacht');
  assert.ok(long.filter((d) => d.getHours() === 0).length >= 4, 'jede Mitternacht eine Marke');
  assert.ok(long[0].getTime() >= min);
  const short = eosPlanTicks(min, min + 30 * 3600000).map((t) => new Date(t.value));
  assert.equal(short[0].getHours(), 11);
  assert.equal(short[1].getTime() - short[0].getTime(), 3 * 3600000);
});
