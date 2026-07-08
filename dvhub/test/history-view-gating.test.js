// test/history-view-gating.test.js — Christin 2026-07-07.
//
// Frontend-Lock der Historie-Zeiträume: nur die Tagesansicht ist frei; Woche/
// Monat/Jahr/Alle werden ohne aktive Pro-Lizenz im #historyView-Dropdown mit
// 🔒 markiert (und per change-Listener abgefangen — hier getestet ist die
// sichtbare 🔒-Markierung via applyHistoryViewGating). Die harte Schranke sitzt
// serverseitig und ist in test/license-routes.test.js abgedeckt.
//
// Constraint (PROJECT.md): node:test + node:assert/strict ONLY.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const publicDir = path.join(path.resolve(fileURLToPath(new URL('..', import.meta.url))), 'public');

// Minimaler <select>-Stub mit echtem options-Array (value + textContent).
function makeViewSelect() {
  const opt = (value, textContent) => ({ value, textContent });
  return {
    value: 'day',
    options: [
      opt('day', 'Tag'),
      opt('week', 'Woche'),
      opt('month', 'Monat'),
      opt('year', 'Jahr'),
      opt('all', 'Alle'),
    ],
  };
}

function loadHelpers(viewSelect) {
  const source = fs.readFileSync(path.join(publicDir, 'history.js'), 'utf8');
  const elements = new Map([['historyView', viewSelect]]);
  const sandbox = {
    console,
    URL,
    globalThis: {},
    window: { __DVHUB_HISTORY_TEST__: true, DVhubCommon: {} },
    document: {
      getElementById(id) { return elements.get(id) || null; },
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'history.js' });
  return sandbox.DVhubHistoryPage;
}

test('applyHistoryViewGating(true) markiert nur Woche/Monat/Jahr/Alle mit 🔒, Tag bleibt frei', () => {
  const sel = makeViewSelect();
  const helpers = loadHelpers(sel);
  assert.equal(typeof helpers.applyHistoryViewGating, 'function');

  helpers.applyHistoryViewGating(true);

  const byValue = Object.fromEntries(sel.options.map((o) => [o.value, o.textContent]));
  assert.equal(byValue.day, 'Tag', 'Tagesansicht darf KEIN Schloss tragen (frei für alle)');
  assert.equal(byValue.week, 'Woche \u{1F512}');
  assert.equal(byValue.month, 'Monat \u{1F512}');
  assert.equal(byValue.year, 'Jahr \u{1F512}');
  assert.equal(byValue.all, 'Alle \u{1F512}');
});

test('applyHistoryViewGating(false) entfernt alle Schlösser wieder (Pro aktiv)', () => {
  const sel = makeViewSelect();
  const helpers = loadHelpers(sel);

  helpers.applyHistoryViewGating(true);   // erst sperren
  helpers.applyHistoryViewGating(false);  // dann freigeben

  for (const o of sel.options) {
    assert.doesNotMatch(o.textContent, /\u{1F512}/u, `${o.value} darf kein Schloss mehr tragen`);
  }
  const byValue = Object.fromEntries(sel.options.map((o) => [o.value, o.textContent]));
  assert.equal(byValue.week, 'Woche');
  assert.equal(byValue.all, 'Alle');
});

test('history.html enthält alle vier Premium-Ansichten + Tag im #historyView-Dropdown', () => {
  const html = fs.readFileSync(path.join(publicDir, 'history.html'), 'utf8');
  for (const [val, label] of [['day', 'Tag'], ['week', 'Woche'], ['month', 'Monat'], ['year', 'Jahr'], ['all', 'Alle']]) {
    assert.match(html, new RegExp(`<option value="${val}">${label}</option>`));
  }
  // pro-modal.js muss eingebunden sein, damit openProRequired verfügbar ist.
  assert.match(html, /pro-modal\.js/);
});
