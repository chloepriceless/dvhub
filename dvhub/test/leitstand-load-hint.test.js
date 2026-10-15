// test/leitstand-load-hint.test.js — Hinweis „Lastprognose lernt noch“ in der
// Kachel „Erwarteter Verbrauch“ (Support-Fall 2026-10-15, Loxone): Der Kunde sah
// nur 200 Wh je Viertelstunde. Der alte Hinweis „Flat 800W“ hing daran, dass
// alle Werte des Tages gleich sind — die Nachtkorrektur ändert aber die
// Nachtwerte, dann verschwand er, obwohl weiter die Konstante galt.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const src = fs.readFileSync(path.resolve(import.meta.dirname, '../public/leitstand-charts.js'), 'utf8');

function loadHelpers() {
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

test('Kaltstart vom Server: Hinweis mit Standardwert und gemessenen Stunden', () => {
  const { loadForecastHint } = loadHelpers();
  const h = loadForecastHint({ loadColdStart: { defaultPowerW: 800, hoursWithData: 2 } }, []);
  assert.equal(h.text, '⚠ Lernt noch – vorläufig konstant 800 W');
  assert.equal(h.detail, '2 von 7 nötigen Stunden mit Hausverbrauch gemessen. Bleibt das länger als einen Tag so, kommt kein Verbrauchswert an – Zuordnung prüfen.');
});

test('Kaltstart, Verbrauch nicht lesbar (hoursWithData null)', () => {
  const { loadForecastHint } = loadHelpers();
  const h = loadForecastHint({ loadColdStart: { defaultPowerW: 650, hoursWithData: null } }, []);
  assert.equal(h.text, '⚠ Lernt noch – vorläufig konstant 650 W');
  assert.equal(h.detail, 'Gemessener Hausverbrauch ist gerade nicht lesbar.');
});

test('Kaltstart wird auch angezeigt, wenn die Nachtwerte abweichen', () => {
  const { loadForecastHint } = loadHelpers();
  const slots = [{ powerW: 800 }, { powerW: 520 }, { powerW: 800 }];
  assert.ok(loadForecastHint({ loadColdStart: { defaultPowerW: 800, hoursWithData: 0 } }, slots));
});

test('ohne Kaltstart, aber alle Werte gleich: Hinweis auf konstante Prognose', () => {
  const { loadForecastHint } = loadHelpers();
  const h = loadForecastHint({ loadColdStart: null }, [{ powerW: 800 }, { powerW: 800 }]);
  assert.equal(h.text, '⚠ Konstant 800 W – keine echte Prognose');
  assert.equal(h.detail, '');
});

test('echte Prognose: kein Hinweis', () => {
  const { loadForecastHint } = loadHelpers();
  assert.equal(loadForecastHint({ loadColdStart: null }, [{ powerW: 300 }, { powerW: 900 }]), null);
});
