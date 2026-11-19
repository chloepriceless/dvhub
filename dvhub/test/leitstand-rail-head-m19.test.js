// test/leitstand-rail-head-m19.test.js — M19 (Feld 19.11.2026): im Leitstand ragte
// das Badge „Bereit“ der Kachel „Netzanschluss · Bezugsgrenze“ 23 px über den
// Kachelrand (1600 × 1000: Kopf 270 px, Titel 244 px mit white-space:nowrap und
// min-width:auto, Badge 74 px).
//
// Regel jetzt für JEDEN Kachelkopf (.rail-card-head): der Titel darf schrumpfen
// und umbrechen (min-width:0, white-space:normal), das Badge schrumpft nie und
// bricht nicht um — es bleibt immer in der Kachel. Gemessen im Browser (Bericht),
// hier gegen Rückfall als CSS-Regel abgesichert.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const css = fs.readFileSync(path.join(publicDir, 'index.css'), 'utf8');
const evCss = fs.readFileSync(path.join(publicDir, 'ev-tile.css'), 'utf8');

/** Alle Deklarationen eines Selektors (alle Blöcke, in Reihenfolge; spätere gewinnen). */
function decls(source, selector) {
  const out = {};
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(source))) {
    const sels = m[1].replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((s) => s.trim());
    if (!sels.includes(selector)) continue;
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim();
    }
  }
  return out;
}

test('M19: Kachel-Titel darf schrumpfen und umbrechen', () => {
  const ttl = decls(css, '.rail-card-head .ttl');
  assert.equal(ttl['min-width'], '0', 'ohne min-width:0 schrumpft der Titel nie (min-width:auto)');
  assert.notEqual(ttl['white-space'], 'nowrap', 'nowrap drückte das Badge aus der Kachel');
  const head = decls(css, '.rail-card-head');
  assert.ok(head.gap, 'Abstand zwischen Titel und Badge');
});

test('M19: Badge im Kachelkopf schrumpft nie und bricht nicht um', () => {
  const chip = decls(css, '.rail-card-head > .chip');
  assert.match(chip.flex || '', /^0 0 auto$/);
  assert.equal(chip['white-space'], 'nowrap');
  const dot = decls(css, '.rail-card-head .ttl .dot');
  assert.match(dot.flex || '', /^0 0 auto$/, 'der Punkt vor dem Titel wird beim Umbruch nicht zerdrückt');
});

test('M19: E-Auto-Kachel (eigene Kopf-Regel) folgt derselben Regel', () => {
  const ttl = decls(evCss, '.ev-tile .rail-card-head .ttl');
  assert.equal(ttl['min-width'], '0');
  assert.notEqual(ttl['white-space'], 'nowrap');
});
