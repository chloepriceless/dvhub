// test/grid-connection-view.test.js — Leitstand-Kachel „Netzanschluss“:
// Grenze, Bezug, aktive Begrenzung im Klartext, Fail-safe. Reine Anzeige-Logik
// aus public/grid-connection-view.js, geladen wie im Browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function load() {
  const file = fileURLToPath(new URL('../public/grid-connection-view.js', import.meta.url));
  const sandbox = { window: {}, document: undefined };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: 'grid-connection-view.js' });
  return sandbox.window.DVhubGridConnection;
}

const base = {
  enabled: true, active: true, reason: null, limitW: 29000, targetW: 28000, marginW: 1000,
  phaseLimitA: null, importW: 12400, phasesW: [4100, 4200, 4100], failsafe: false, exhausted: false,
  clamp: null, caps: [], acting: false, text: null
};

test('ohne Grenze: Kachel versteckt', () => {
  const { view } = load();
  assert.equal(view(null).hidden, true);
  assert.equal(view({ enabled: false }).hidden, true);
});

test('bereit: Bezug, Grenze und Auslastung', () => {
  const v = load().view(base);
  assert.equal(v.hidden, false);
  assert.equal(v.importNow, '12,4 kW');
  assert.equal(v.limit, '29,0 kW (Ziel 28,0 kW)');
  assert.equal(v.state, 'Bereit');
  assert.equal(v.tone, 'ok');
});

test('greift: Klartext aus dem Wächter („begrenzt Akku-Ladung auf …“)', () => {
  const v = load().view({ ...base, acting: true, clamp: { requestedW: 34400, valueW: 28000 },
    caps: [{ id: 'wallbox', kind: 'wallbox', name: 'Wallbox', capW: 10000 }],
    text: 'Netzanschluss: begrenzt Akku-Ladung auf 28,0 kW · begrenzt Wallbox auf 10,0 kW' });
  assert.equal(v.state, 'Begrenzt');
  assert.equal(v.tone, 'warn');
  assert.match(v.detail, /begrenzt Akku-Ladung auf 28,0 kW/);
});

test('Fail-safe und erschöpft: Gefahr', () => {
  assert.equal(load().view({ ...base, failsafe: true, acting: true, importW: null, text: 'Netzanschluss: Zähler gestört' }).state, 'Zähler gestört');
  assert.equal(load().view({ ...base, failsafe: true }).tone, 'danger');
  assert.equal(load().view({ ...base, exhausted: true, acting: true }).state, 'Nichts mehr steuerbar');
});

test('ungültige Grenze: Hinweis statt Regelung', () => {
  const v = load().view({ ...base, active: false, reason: 'limit_invalid', limitW: null, targetW: null });
  assert.equal(v.state, 'Grenze ungültig');
});

test('index.html: Kachel und Skript eingebunden, app.js rendert sie', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="gridConnectionCard"/);
  assert.match(html, /<script src="\/grid-connection-view\.js\?v=\d+/);
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /DVhubGridConnection\?\.render\(status\.gridConnection\)/);
});

test('Not-Halt: Kachel sagt, dass DVhub nicht eingreift', () => {
  const v = load().view({ ...base, paused: true, text: 'Netzanschluss: Not-Halt aktiv — DVhub greift nicht ein.' });
  assert.equal(v.state, 'Not-Halt');
  assert.match(v.detail, /Not-Halt/);
});

test('Punkt 7: Kachel zeigt die Quelle der Grenze', () => {
  const v = load().view({ ...base, limitText: 'von Victron: 40 A je Phase ≈ 27,6 kW (DVhub-Einstellung 29,0 kW)' });
  assert.match(v.source, /Victron: 40 A/);
  const v2 = load().view({ ...base, limitText: 'DVhub-Einstellung: 29,0 kW', victronReadError: true });
  assert.match(v2.source, /nicht lesbar/);
});

test('Akku zuerst: Kachel zeigt den Akku-Hebel und die aktuelle Akku-Hilfe', () => {
  const native = { kind: 'native', setpoint: true, discharge: true, text: 'Akku zuerst über Netz-Sollwert und Entladegrenze' };
  const v = load().view({ ...base, battery: native, acting: true,
    assist: { valueW: 3200, baseW: 0, helpW: 3100, since: 1 },
    text: 'Netzanschluss: Akku hilft mit 3,1 kW (Entladegrenze 3,2 kW statt 0,0 kW)' });
  assert.equal(v.battery, 'Akku zuerst über Netz-Sollwert und Entladegrenze');
  assert.equal(v.assist, '3,1 kW (Entladegrenze 3,2 kW statt 0,0 kW)');
  assert.equal(v.state, 'Akku hilft');
  assert.equal(v.tone, 'info');
  // Akku hilft UND eine Wallbox ist gedrosselt: das ist eine Begrenzung.
  const v2 = load().view({ ...base, battery: native, acting: true, assist: { valueW: 10000, baseW: 0, helpW: 10000 },
    caps: [{ id: 'wallbox', kind: 'wallbox', capW: 6000 }] });
  assert.equal(v2.state, 'Begrenzt');
  // Ohne Hilfe: Strich; früher gestartete Entladegrenze „unbegrenzt“ lesbar.
  assert.equal(load().view({ ...base, battery: native }).assist, '–');
  assert.equal(load().view({ ...base, battery: native, assist: { valueW: 4000, baseW: -1, helpW: 0 } }).assist, '0,0 kW (Entladegrenze 4,0 kW statt unbegrenzt)');
});

test('Akku nicht steuerbar (Fronius, Deye): klar angezeigt', () => {
  const v = load().view({ ...base, battery: { kind: 'none', setpoint: false, discharge: false, text: 'Akku nicht steuerbar — DVhub drosselt direkt die Lasten' } });
  assert.match(v.battery, /Akku nicht steuerbar/);
  assert.equal(v.assist, '–');
  // Alter Status ohne battery-Feld: kein Absturz.
  assert.equal(load().view(base).battery, '–');
});

test('index.html: Zeilen für Akku-Hebel und Akku-Hilfe, Skript-Version erneuert', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="gridConnectionBattery"/);
  assert.match(html, /id="gridConnectionAssist"/);
  const m = html.match(/<script src="\/grid-connection-view\.js\?v=(\d+)/);
  assert.ok(m && Number(m[1]) >= 20261110, `Cache-Busting erneuert: ${m && m[1]}`);
});

test('nur §14a fordert Akku-Hilfe an (keine Netzanschluss-Grenze): Kachel ohne „Grenze ungültig“', () => {
  const s = { enabled: true, active: false, reason: 'not_set', assistOnly: true, limitW: null, targetW: null,
    importW: 5800, phasesW: null, failsafe: false, exhausted: false, caps: [], clamp: null, acting: true,
    battery: { kind: 'native', text: 'Akku zuerst über Netz-Sollwert und Entladegrenze' },
    assist: { valueW: 4400, baseW: 0, helpW: 4200 }, assistSources: ['p14a'],
    text: '§14a: Akku hilft mit 4,2 kW (Entladegrenze 4,4 kW statt 0,0 kW)' };
  const v = load().view(s);
  assert.equal(v.hidden, false);
  assert.equal(v.state, 'Akku hilft');
  assert.equal(v.limit, 'keine eingetragen');
  assert.equal(v.assist, '4,2 kW (Entladegrenze 4,4 kW statt 0,0 kW) · für §14a');
  assert.match(v.detail, /§14a/);
  // Victron: Hilfe über den Netz-Sollwert (keine Entladegrenze).
  const v2 = load().view({ ...s, battery: { kind: 'victron', text: 'Akku zuerst — der Victron regelt selbst' }, assist: { valueW: null, baseW: null, helpW: 3000 } });
  assert.equal(v2.assist, '3,0 kW (über den Netz-Sollwert) · für §14a');
  assert.equal(load().view({ ...s, assist: null, acting: false }).state, 'Bereit');
});
