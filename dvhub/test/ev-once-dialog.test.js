// test/ev-once-dialog.test.js -- Einmal-Ziel in der E-Auto-Kachel als Knopf +
// Dialog mit Aktiv-Status (Christin 11.11.2026, Prod-Test test-5 in der
// Home-Screen-Webapp): statt dauerhafter Felder „Einmalige Abfahrt planen“,
// solange es gilt ein Chip „Einmal-Ziel aktiv: Fr 20.11. 07:30 · mindestens
// 80 %“ mit „Ändern“/„Beenden“, danach wieder der Knopf.
//
// Reine Logik aus public/ev-once.js (validate, chip, effectLines) per vm, mit
// dem echten Server-Status (ev-departure.js describeEvOnce) als Eingabe; dazu
// Markup/CSS/Einbindung statisch.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describeEvOnce } from '../services/optimizer/ev-departure.js';

const PUB = path.resolve(import.meta.dirname, '..', 'public');
const src = fs.readFileSync(path.join(PUB, 'ev-once.js'), 'utf8');
const tile = fs.readFileSync(path.join(PUB, 'ev-tile.js'), 'utf8');
const css = fs.readFileSync(path.join(PUB, 'ev-once.css'), 'utf8');
const intgHtml = fs.readFileSync(path.join(PUB, 'integrations.html'), 'utf8');
const intgJs = fs.readFileSync(path.join(PUB, 'integrations.js'), 'utf8');

function load() {
  const sandbox = { window: {}, document: { addEventListener() {}, getElementById: () => null }, setTimeout, clearTimeout, Date, Promise };
  vm.runInNewContext(src, sandbox);
  return sandbox.window.DVhubEvOnce;
}
const O = load();
const TZ = 'Europe/Berlin';
const at = (s) => Date.parse(s);
const MIN = 60_000;
// Mo 16.11.2026 20:00 Berlin
const NOW = at('2026-11-16T19:00:00Z');
const C = { nowMs: NOW, leadMinutes: 10, maxSocPct: 80, enabled: true, weeklyHasDepartures: true, plugged: true, nextArrivalAt: null, tz: TZ };
const iso = (ms) => new Date(ms).toISOString();

describe('Dialog: Prüfung (validate)', () => {
  it('Abfahrt in der Vergangenheit bzw. im 10-min-Vorlauf: abgelehnt', () => {
    assert.match(O.validate({ once: iso(NOW - MIN), arrivalOnce: '', minSocPct: '80' }, C).error, /Vergangenheit/);
    assert.match(O.validate({ once: iso(NOW + 5 * MIN), arrivalOnce: '', minSocPct: '80' }, C).error, /mehr als 10 min/);
    assert.equal(O.validate({ once: iso(NOW + 11 * MIN), arrivalOnce: '', minSocPct: '80' }, C).error, null);
  });

  it('halb ausgefüllt, nichts, Prozent außerhalb 0–100, Ziel ohne Abfahrt: abgelehnt', () => {
    assert.match(O.validate({ once: null, arrivalOnce: '' }, C).error, /Datum und Uhrzeit/);
    assert.match(O.validate({ once: '', arrivalOnce: '' }, C).error, /Abfahrt eintragen/);
    assert.match(O.validate({ once: iso(NOW + 86400_000), arrivalOnce: '', minSocPct: '120' }, C).error, /0–100/);
    assert.match(O.validate({ once: iso(NOW + 86400_000), arrivalOnce: '', tripSocPct: '-1' }, C).error, /0–100/);
    assert.match(O.validate({ once: '', arrivalOnce: iso(NOW + HOURS(2)), minSocPct: '70' }, C).error, /gehören zu einer Abfahrt/);
  });

  it('Ankunft: nicht in der Vergangenheit, nicht nach der Abfahrt; allein erlaubt', () => {
    assert.match(O.validate({ once: '', arrivalOnce: iso(NOW - MIN) }, C).error, /Ankunft liegt in der Vergangenheit/);
    assert.match(O.validate({ once: iso(NOW + HOURS(5)), arrivalOnce: iso(NOW + HOURS(6)) }, C).error, /vor der Abfahrt/);
    assert.equal(O.validate({ once: '', arrivalOnce: iso(NOW + HOURS(2)) }, C).error, null);
  });

  it('Codex 5fe74510: gespeicherte, schon vergangene Ankunft blockiert das Ändern nicht', () => {
    const stored = iso(NOW - HOURS(1));
    const d = { once: iso(NOW + HOURS(10)), arrivalOnce: stored, minSocPct: '90' };
    assert.equal(O.validate(d, { ...C, storedArrivalOnce: stored }).error, null);
    assert.match(O.validate(d, C).error, /Ankunft liegt in der Vergangenheit/);
  });

  it('Hinweis: Abfahrt vor der erwarteten Ankunft (Auto unterwegs)', () => {
    const c = { ...C, plugged: false, nextArrivalAt: iso(NOW + HOURS(20)) };
    const v = O.validate({ once: iso(NOW + HOURS(15)), arrivalOnce: '', minSocPct: '' }, c);
    assert.equal(v.error, null);
    assert.ok(v.hints.some((h) => /vor der erwarteten Ankunft/.test(h)), v.hints.join('|'));
    // mit einmaliger Ankunft davor: kein Hinweis
    const w = O.validate({ once: iso(NOW + HOURS(15)), arrivalOnce: iso(NOW + HOURS(10)) }, c);
    assert.ok(!w.hints.some((h) => /erwarteten Ankunft/.test(h)));
    // angesteckt: kein Hinweis
    assert.ok(!O.validate({ once: iso(NOW + HOURS(15)), arrivalOnce: '' }, { ...c, plugged: true }).hints.length);
  });

  it('Hinweis: Mindestens über „Max, wenn günstig“ (das Einmal-Ziel gewinnt, danach gilt wieder Max)', () => {
    const v = O.validate({ once: iso(NOW + 86400_000), arrivalOnce: '', minSocPct: '90' }, C);
    assert.equal(v.error, null);
    assert.ok(v.hints.some((h) => /über „Max, wenn günstig“ \(80 %\).*bis 90 %.*wieder 80 %/.test(h)), v.hints.join('|'));
    assert.ok(!O.validate({ once: iso(NOW + 86400_000), arrivalOnce: '', minSocPct: '90' }, { ...C, maxSocPct: null }).hints.length, 'Max aus: kein Hinweis');
  });

  it('Hinweis: Wochenplan aus — die Abfahrt ist die einzige, der Wochenplan bleibt aus (11.11.2026)', () => {
    const v = O.validate({ once: iso(NOW + 86400_000), arrivalOnce: '' }, { ...C, enabled: false });
    assert.ok(v.hints.some((h) => /Wochenplan ist aus und bleibt aus.*einzige/.test(h)), v.hints.join('|'));
  });
});

// Mo–Fr Ankunft 18:00, Abfahrt 07:00 (Folgetag), 60 %.
const COMMUTE = [1, 2, 3, 4, 5].map((day) => ({ day, arrival: '18:00', departure: '07:00', minSocPct: 60, tripSocPct: 20 }));
const cfg = (extra = {}) => ({ schedule: { timezone: TZ }, optimizer: { evDepartureEnabled: true, evTargetMode: 'percent', evTargetValue: 80, evWeeklyPlan: COMMUTE, ...extra } });

describe('Kachel: Chip aus dem Server-Status (describeEvOnce → chip)', () => {
  it('aktiv: Titel wie gewünscht, ersetzt Mi 07:00, Di bleibt davor, Ende erklärt', () => {
    // einmalig Mi 18.11. 06:30 mit 80 %
    const info = describeEvOnce(cfg({ evDepartureOnce: '2026-11-18T05:30:00.000Z', evDepartureOnceMinSocPct: 80 }), NOW);
    const c = O.chip(info, { tz: TZ });
    assert.equal(c.kind, 'active');
    assert.equal(c.title, 'Einmal-Ziel aktiv: Mi 18.11. 06:30 · mindestens 80\u00a0%');
    const t = c.lines.join('\n');
    assert.match(t, /Statt Wochenplan Mi 18\.11\. 07:00/);
    assert.match(t, /Davor gilt der Wochenplan weiter: nächste Abfahrt Di 17\.11\. 07:00/);
    assert.match(t, /Endet von selbst mit der Abfahrt — oder wenn du das Auto ab 06:00 absteckst/);
  });

  it('ohne eigenes Mindestziel: „(wie Plan)“ mit dem Wert der ersetzten Zeile', () => {
    const c = O.chip(describeEvOnce(cfg({ evDepartureOnce: '2026-11-18T05:30:00.000Z' }), NOW), { tz: TZ });
    assert.equal(c.title, 'Einmal-Ziel aktiv: Mi 18.11. 06:30 · mindestens 60\u00a0% (wie Plan)');
  });

  it('vorbei: kein Chip (Knopf erscheint wieder), auch bevor die Wache abräumt', () => {
    const info = describeEvOnce(cfg({ evDepartureOnce: '2026-11-16T18:00:00.000Z', evDepartureOnceMinSocPct: 80 }), NOW);
    assert.equal(info.departure.state, 'ended');
    assert.equal(O.chip(info, { tz: TZ }), null);
    assert.equal(O.chip(describeEvOnce(cfg(), NOW), { tz: TZ }), null);
  });

  it('Wochenplan aus: Chip aktiv, einzige Abfahrt (wirkt seit 11.11.2026 auch ohne Wochenplan)', () => {
    const c = O.chip(describeEvOnce(cfg({ evDepartureEnabled: false, evDepartureOnce: '2026-11-18T05:30:00.000Z' }), NOW), { tz: TZ });
    assert.equal(c.kind, 'active');
    assert.match(c.lines.join('\n'), /einzige geplante Abfahrt/);
  });

  it('nur einmalige Ankunft: eigener Chip', () => {
    const c = O.chip(describeEvOnce(cfg({ evArrivalOnce: '2026-11-16T21:00:00.000Z' }), NOW), { tz: TZ });
    assert.equal(c.title, 'Einmalige Ankunft: Mo 16.11. 22:00');
  });
});

describe('Datum + Uhrzeit (Ortszeit) ↔ ISO', () => {
  it('Rundweg und halb ausgefüllt', () => {
    const p = O.splitLocal('2026-11-20T06:30:00.000Z');
    assert.equal(O.joinLocal(p.date, p.time), '2026-11-20T06:30:00.000Z');
    assert.equal(O.joinLocal('', ''), '');
    assert.equal(O.joinLocal('2026-11-20', ''), null);
    assert.equal(O.joinLocal('', '07:30'), null);
  });
});

describe('Kachel-Markup, Einbindung, CSP', () => {
  it('keine dauerhaften Einmal-Felder mehr; Knopf, Chip mit Ändern/Beenden aus dem gemeinsamen Baustein', () => {
    assert.doesNotMatch(tile, /datetime-local/);
    assert.doesNotMatch(tile, /id=\\"evDepOnce\\"|id=\\"evOnceMin\\"|id=\\"evArrOnce\\"/);
    assert.match(tile, /id=\\"evOnceSlot\\"/);
    assert.match(tile, /DVhubEvOnce\.attach\(slot,/);
    assert.match(src, /data-evo="plan"[^>]*>\+ Einmalige Abfahrt planen/);
    for (const k of ['chip', 'edit', 'end', 'start']) assert.match(src, new RegExp(`data-evo="${k}"`));
  });

  it('Integrationsseite: keine Dauerfelder mehr, derselbe Baustein (keine zweite Logik)', () => {
    assert.doesNotMatch(intgHtml, /id="evcc-dep-once"|id="evcc-dep-once-min"|id="evcc-dep-once-trip"|id="evcc-dep-arr-once"/);
    assert.match(intgHtml, /id="evcc-once-slot"/);
    assert.match(intgJs, /DVhubEvOnce\.attach\(host,/);
    assert.doesNotMatch(intgJs, /evcc-dep-once|evcc-dep-arr-once|onceMinSocPct|arrivalOnce/);
    const a = intgHtml.match(/<script src="\/ev-once\.js\?v=([\w-]+)"/);
    const b = intgHtml.match(/<script src="\/integrations\.js\?v=([\w-]+)"/);
    const c = intgHtml.match(/href="\/ev-once\.css\?v=([\w-]+)"/);
    assert.ok(a && b && c);
    assert.ok(intgHtml.indexOf(a[0]) < intgHtml.indexOf(b[0]), 'ev-once.js vor integrations.js');
    assert.equal(a[1], c[1]);
  });

  it('Wochenplan-Speichern schickt kein Einmal-Ziel mit (überschreibt es nicht)', () => {
    const fd = tile.match(/function formDeparture\(\) \{[\s\S]*?\n {2}\}/);
    assert.ok(fd, 'formDeparture fehlt');
    assert.doesNotMatch(fd[0], /once|arrivalOnce/i);
  });

  it('Leitstand und Family laden ev-once.js vor ev-tile.js, gleicher neuer Stand', () => {
    for (const f of ['index.html', 'family.html']) {
      const html = fs.readFileSync(path.join(PUB, f), 'utf8');
      const a = html.match(/<script src="\/ev-once\.js\?v=([\w-]+)"/);
      const b = html.match(/<script src="\/ev-tile\.js\?v=([\w-]+)"/);
      const c = html.match(/href="\/ev-tile\.css\?v=([\w-]+)"/);
      const d = html.match(/href="\/ev-once\.css\?v=([\w-]+)"/);
      assert.ok(a && b && c && d, f);
      assert.equal(d[1], b[1]);
      assert.ok(html.indexOf(a[0]) < html.indexOf(b[0]), `${f}: ev-once.js vor ev-tile.js`);
      assert.equal(a[1], b[1]);
      assert.equal(c[1], b[1]);
      assert.notEqual(b[1], '20261111-fable-r5', `${f}: alte Version im Cache`);
    }
  });

  it('CSP: keine Inline-Styles/-Handler im Dialog', () => {
    assert.doesNotMatch(src, /\sstyle\s*=|\.style\.|onclick=|setAttribute\('style'/);
  });

  it('mobil: 16-px-Felder (kein iOS-Zoom), 44-px-Knöpfe, Blatt von unten auf schmalen Schirmen', () => {
    assert.match(css, /\.ev-once-dialog \.input \{[^}]*font-size:16px/);
    assert.match(css, /\.ev-once-actions \.btn \{[^}]*min-height:44px/);
    assert.match(css, /@media \(max-width: 520px\) \{[\s\S]*?\.ev-once-overlay \{[^}]*align-items:flex-end/);
  });
});

function HOURS(n) { return n * 60 * MIN; }
