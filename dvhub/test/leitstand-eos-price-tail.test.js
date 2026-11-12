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
