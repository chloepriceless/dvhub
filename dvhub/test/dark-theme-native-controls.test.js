// test/dark-theme-native-controls.test.js -- Ausklapplisten im Dark Theme lesbar.
// Issue #23 (19.10.2026): In Integrationen → Victron Wechselrichter war die
// Liste der Auswahlfelder weiss auf weiss. Die Seite setzte kein color-scheme,
// der Browser zeichnete die Liste hell; die Eintraege erbten die helle
// Schrift und einen durchsichtigen Hintergrund. Gemessen im Browser vor dem Fix:
// color-scheme normal, option rgba(0,0,0,0) auf rgb(234,242,255).
// dvhub-app.css gilt fuer alle App-Seiten, deshalb hier.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'dvhub-app.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

function block(selectorRe) {
  const m = css.match(new RegExp(`(?:^|})\\s*${selectorRe}\\s*\\{([^}]*)\\}`));
  return m ? m[1] : null;
}

test('Dark Theme (Standard) meldet dem Browser ein dunkles Farbschema', () => {
  assert.match(block(':root') || '', /color-scheme\s*:\s*dark\b/);
});

test('Light Theme schaltet das Farbschema zurueck', () => {
  assert.match(block('\\[data-theme="light"\\]') || '', /color-scheme\s*:\s*light\b/);
});

test('Eintraege der Ausklappliste haben einen deckenden Hintergrund aus den Theme-Farben', () => {
  const opt = block('select option,\\s*select optgroup');
  assert.ok(opt, 'Regel fuer select option / optgroup fehlt');
  assert.match(opt, /background-color\s*:\s*var\(--bg-1\)/);
  assert.match(opt, /color\s*:\s*var\(--text\)/);
});
