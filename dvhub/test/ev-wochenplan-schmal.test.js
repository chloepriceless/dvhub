// test/ev-wochenplan-schmal.test.js -- E-Auto-Planung am Handy (mobil zuerst).
//
// Bis T-0427: ein Raster aus 4–5 Feldern je Tag; im schmalen Layout rutschten
// „Mind. %“ und „Fahrt %“ in eine zweite Zeile und lasen sich wie der
// Ladestand bei Ankunft (Christin 11.11.2026), „Fahrt danach 0“ stand in jeder
// Zeile wie ein Pflichtfeld. Seit T-0427 (Christin: „die Felder und die
// Eingabe sind sehr unintuitiv“): schmal eine Liste von Karten in Klartext
// („Di · 08:30 · mind. 80 %“), breit dieselben Karten als Wochenleiste; Werte
// nur im Blatt, der Verbrauch der Fahrt eindeutig beschriftet und unter
// „Erweitert“ (leer statt 0). Gilt in Leitstand-Kachel, Family-Panel und
// Integrationsseite (ein Baustein).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PUB = path.resolve(import.meta.dirname, '..', 'public');
const js = fs.readFileSync(path.join(PUB, 'ev-weekly-editor.js'), 'utf8');
const css = fs.readFileSync(path.join(PUB, 'ev-weekly-editor.css'), 'utf8');

/** Inhalt eines @media- bzw. @container-Blocks (oberste Ebene). */
function block(start) {
  const i = css.indexOf(start);
  assert.ok(i >= 0, `${start} fehlt`);
  let depth = 0;
  for (let j = css.indexOf('{', i); j < css.length; j += 1) {
    if (css[j] === '{') depth += 1;
    if (css[j] === '}') { depth -= 1; if (depth === 0) return css.slice(i, j + 1); }
  }
  throw new Error('Block nicht geschlossen');
}

describe('E-Auto-Planung am Handy: Karten statt Feldraster', () => {
  it('schmal (Grundlayout): Tage untereinander, je Tag eine Karte; breit ab 640 px eine Wochenleiste mit 7 Spalten', () => {
    assert.match(css, /\.evw-week \{ display:flex; flex-direction:column;/);
    const wide = block('@container evw (min-width: 640px)');
    assert.match(wide, /\.evw-week \{ display:grid; grid-template-columns:repeat\(7, minmax\(0, 1fr\)\);/);
    // Ein Tag mit zwei Abfahrten bleibt eine Spalte (Gruppe je Tag).
    assert.match(js, /'<div class="evw-day" role="listitem" data-day="' \+ day \+ '">' \+ cards \+ '<\/div>'/);
  });

  it('Verbrauch der Fahrt: eindeutig beschriftet, mit Hilfe, leer statt 0, nur unter „Erweitert“', () => {
    assert.match(js, /<summary>Erweitert: zuhause ab, Verbrauch der Fahrt<\/summary>/);
    const more = js.slice(js.indexOf('id="evwSheetMore"'), js.indexOf('</details>', js.indexOf('id="evwSheetMore"')));
    assert.match(more, /for="evwSheetTrip">Verbrauch dieser Fahrt ≈<\/label>/);
    assert.match(more, /id="evwSheetTrip"[^>]*placeholder="—"/);
    assert.match(more, /So viel Ladestand kostet die Fahrt ab dieser Abfahrt bis zur Heimkehr\. Leer = 0\. Damit schätzt DVhub den Ladestand bei Ankunft und lädt bei knappen Folgefahrten vorher mehr\./);
    assert.match(more, /id="evwSheetArr" aria-live="polite"/);
    assert.doesNotMatch(js, /Fahrt danach/);
    assert.doesNotMatch(js, /placeholder="0"/);
  });

  it('Blatt: Eingaben 16 px (kein Zoom am iPhone), Knöpfe als Blatt von unten (ev-once.css)', () => {
    const once = fs.readFileSync(path.join(PUB, 'ev-once.css'), 'utf8');
    assert.match(once, /\.ev-once-dialog \.input \{ font-size:16px;/);
    assert.match(js, /overlay\.className = 'ev-once-overlay evw-overlay'/);
    assert.match(js, /'<div class="ev-once-dialog evw-sheet" role="dialog" aria-modal="true"/);
    assert.match(css, /\.evw-std-in input \{[^}]*font-size:16px/);
  });

  it('Cache-Busting: Leitstand, Family und Integrationsseite laden den neuen Stand', () => {
    for (const f of ['index.html', 'family.html', 'integrations.html']) {
      const html = fs.readFileSync(path.join(PUB, f), 'utf8');
      const vers = [...html.matchAll(/ev-(?:weekly-editor|tile|once)\.(?:js|css)\?v=([\w-]+)/g)].map((m) => m[1]);
      assert.ok(vers.length >= 2, f);
      for (const v of vers) assert.equal(v, '20261111-abfahrtstag', f);
    }
  });
});
