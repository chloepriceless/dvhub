// test/ev-wochenplan-schmal.test.js -- Wochenplan-Editor im schmalen Layout
// (Christin 11.11.2026, Prod-Webapp/schmale Kachel): „Meine Prozentwerte im
// Wochenplan stehen jetzt an der Stelle, die bei Ankunft erwartet wird.“ Im
// schmalen Layout rutschten „Mind. %“ unter „Ankunft“ und „Fahrt %“ unter
// „Abfahrt“, die Kopfzeile dafür brach um — das las sich wie „Ladestand bei
// Ankunft“. Jetzt: Mind. % unter der Abfahrt, Fahrt links daneben, beide mit
// sichtbarer Kurz-Beschriftung; der Kopf zeigt schmal nur Tag/Ankunft/Abfahrt.
// Gilt in Leitstand-Kachel, Family-Panel und Integrationsseite (ein Editor).
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

describe('Wochenplan schmal: Prozente eindeutig der Abfahrt zugeordnet', () => {
  it('Zeile: Mind. % und Fahrt % je in eigener Beschriftung („mind. bei Abfahrt … %“, „Fahrt danach … %“)', () => {
    assert.match(js, /<label class="evw-f evw-f-min"><span class="evw-fl" aria-hidden="true">mind\. bei Abfahrt<\/span>'\s*\+ '<input type="number" class="input mono evw-min"/);
    assert.match(js, /<label class="evw-f evw-f-trip"><span class="evw-fl" aria-hidden="true">Fahrt danach<\/span>'\s*\+ '<input type="number" class="input mono evw-trip"/);
    // Reihenfolge wie die breite Kopfzeile: Mind. vor Fahrt.
    assert.ok(js.indexOf('evw-f evw-f-min') < js.indexOf('evw-f evw-f-trip'));
    assert.match(js, /class="evw-head-min"[^>]*>Mind\. %/);
    assert.match(js, /class="evw-head-trip"[^>]*>Fahrt %/);
  });

  it('breit: Beschriftung an den Feldern aus (die Kopfzeile beschriftet)', () => {
    assert.match(css, /\.evw-f \.evw-fl, \.evw-f \.evw-fu \{ display:none; \}/);
  });

  for (const start of ['@media (max-width: 560px)', '@container evw (max-width: 460px)']) {
    it(`${start}: Mind. unter Abfahrt (Spalte 3), Fahrt Spalte 2, Beschriftung sichtbar, Kopf ohne Mind./Fahrt`, () => {
      const b = block(start);
      assert.match(b, /\.evw-row \.evw-f-min \{ grid-column:3; grid-row:2; \}/);
      assert.match(b, /\.evw-row \.evw-f-trip \{ grid-column:2; grid-row:2; \}/);
      assert.match(b, /\.evw-f \.evw-fl \{ display:block;/);
      assert.match(b, /\.evw-head \.evw-head-min, [^{]*\.evw-head \.evw-head-trip[^{]*\{ display:none; \}/);
      // Nie mehr ein Prozentfeld unter „Ankunft“ (Spalte 2) ohne Beschriftung.
      assert.doesNotMatch(b, /\.evw-min \{ grid-column:2/);
      assert.doesNotMatch(b, /span:nth-child\(4\)/);
    });
  }

  it('Cache-Busting: Leitstand, Family und Integrationsseite laden den neuen Editor-Stand', () => {
    for (const f of ['index.html', 'family.html', 'integrations.html']) {
      const html = fs.readFileSync(path.join(PUB, f), 'utf8');
      for (const m of html.matchAll(/ev-weekly-editor\.(?:js|css)\?v=([\w-]+)/g)) assert.equal(m[1], '20261111-wochenplan-schmal', f);
    }
  });
});
