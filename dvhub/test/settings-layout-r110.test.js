// Darstellung der Einstellungen nach dem Zusammenführen von 1.0.10
// (Screenshots .planning/screenshots/r110, 05.11.2026):
// - Die Auswahl „EOS Generationen“ (Zahlenfeld mit Vorgaben, settings.js
//   withNumberPresets) war auf 280 px gekappt und rechtsbündig, während alle
//   anderen Auswahlfelder der Karte die volle Breite nutzen. Grund: die Regel
//   `.settings-aurora .config-select { max-width: 280px }` greift, die Aufhebung
//   für Felder in einer Zeile (`.config-row:has(> .config-select) > …`) aber
//   nicht, weil Auswahl und Zahlenfeld in `.config-preset` stecken.
// - Lizenz-Bereich auf 390 px: „Jetzt prüfen“, „An diese Box binden“,
//   „Lizenz entfernen“ und der Bestell-Link standen in einer Zeile ohne
//   Umbruch — „An diese Box binden“ brach in vier Zeilen, der Link in eine
//   schmale Spalte.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = (f) => fs.readFileSync(path.join(pub, f), 'utf8');

function rulesFor(css, selectorPart) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    if (m[1].includes(selectorPart)) out.push({ selector: m[1].trim(), body: m[2] });
  }
  return out;
}

test('EOS-Generationen: Auswahl und Zahlenfeld mit Vorgaben nutzen die volle Breite', () => {
  const css = read('settings-redesign.css');
  const rules = rulesFor(css, '.config-preset >');
  const sel = rules.find((r) => /\.settings-aurora\s+\.config-preset\s*>\s*\.config-select/.test(r.selector));
  assert.ok(sel, 'Regel `.settings-aurora .config-preset > .config-select` fehlt');
  assert.match(sel.body, /max-width:\s*none/);
  assert.match(sel.body, /width:\s*100%/);
  assert.match(sel.selector, /\.settings-aurora\s+\.config-preset\s*>\s*\.config-input/,
    'das Zahlenfeld („Eigener Wert …“) braucht dieselbe Breite');
  assert.match(sel.body, /text-align:\s*left/);
});

test('Lizenz-Bereich: Knöpfe und Bestell-Link dürfen umbrechen (390 px)', () => {
  const css = read('settings.css');
  const rules = rulesFor(css, '.license-actions');
  assert.ok(rules.some((r) => /flex-wrap:\s*wrap/.test(r.body)), '`.license-actions` ohne flex-wrap: wrap');
});

test('geänderte Stylesheets tragen einen neuen Cache-Schlüssel', () => {
  const html = read('settings.html');
  assert.match(html, /\/settings\.css\?v=20261105-[a-z0-9-]+"/);
  assert.match(html, /\/settings-redesign\.css\?v=20261105-[a-z0-9-]+"/);
});
