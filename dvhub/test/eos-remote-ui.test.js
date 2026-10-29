// test/eos-remote-ui.test.js — Abschnitt „EOS-Rechendienst“ im EOS-Fahrplan.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const js = fs.readFileSync(new URL('../public/leitstand-charts.js', import.meta.url), 'utf8');

test('Abschnitt sitzt in der EOS-Fahrplan-Karte und ist zunächst verborgen', () => {
  const card = html.slice(html.indexOf('id="eosPlanCard"'), html.indexOf('id="optimizerPlanCard"'));
  assert.match(card, /id="eosRemoteInfo" hidden/);
  assert.match(card, /EOS-Rechendienst/);
  for (const id of ['eosRemoteStatus', 'eosRemoteRun', 'eosRemoteWarnings']) assert.match(card, new RegExp(`id="${id}"`));
});

test('Renderer: aus eos.remote, nur textContent (Texte kommen vom Dienst)', () => {
  const fn = js.slice(js.indexOf('function renderEosRemoteInfo'), js.indexOf('function renderEosPlanChart'));
  assert.ok(fn.length > 100);
  assert.doesNotMatch(fn, /innerHTML/);
  assert.match(fn, /letzter Plan bleibt aktiv/);
  assert.match(js, /renderEosRemoteInfo\(eos && eos\.remote \? eos\.remote : null\)/);
});
