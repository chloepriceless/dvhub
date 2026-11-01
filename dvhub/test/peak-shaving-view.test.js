// test/peak-shaving-view.test.js — Leitstand-Kachel „Peak Shaving“ (GitHub #28).
// Reine Anzeige-Logik aus public/peak-shaving-view.js, geladen wie im Browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function load() {
  const file = fileURLToPath(new URL('../public/peak-shaving-view.js', import.meta.url));
  const sandbox = { window: {}, document: undefined };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: 'peak-shaving-view.js' });
  return sandbox.window.DVhubPeakShaving;
}

const base = {
  enabled: true, active: true, supported: true, reason: null, message: 'Bezugsgrenze 10000 W aktiv (Regelziel 9700 W).',
  limitW: 10000, targetW: 9700, importW: 6400, acting: false, clamp: null, lift: null,
  peaks: { month: { slotStart: '2026-10-14T10:15:00.000Z', powerW: 12000 }, year: { slotStart: '2026-09-10T08:00:00.000Z', powerW: 16000 }, error: null }
};

test('aus oder ohne Daten: Kachel versteckt', () => {
  const { view } = load();
  assert.equal(view(null).hidden, true);
  assert.equal(view({ enabled: false }).hidden, true);
});

test('bereit: Grenze, Bezug, Spitzen mit Zeitpunkt (Ortszeit)', () => {
  const v = load().view(base);
  assert.equal(v.hidden, false);
  assert.equal(v.limit, '10,0 kW');
  assert.equal(v.importNow, '6,4 kW');
  assert.equal(v.monthPeak, '12,0 kW');
  assert.equal(v.monthPeakAt, '14.10. 12:15');
  assert.equal(v.yearPeak, '16,0 kW');
  assert.equal(v.yearPeakAt, '10.09. 10:00');
  assert.deepEqual([v.state, v.tone], ['Bereit', 'ok']);
  assert.equal(v.monthOverLimit, true, 'Monatsspitze über der Grenze wird hervorgehoben');
});

test('greift: Deckel oder Akku-Freigabe', () => {
  const { view } = load();
  const a = view({ ...base, acting: true, clamp: { requestedW: 14700, valueW: 9700, mode: 'target', source: 'eos_grid_hold' } });
  assert.deepEqual([a.state, a.tone], ['Greift', 'warn']);
  assert.match(a.detail, /14,7 kW → 9,7 kW/);
  const b = view({ ...base, acting: true, lift: { liftedW: 4300, since: Date.now() } });
  assert.deepEqual([b.state, b.tone], ['Greift', 'warn']);
  assert.match(b.detail, /Akku freigegeben: 4,3 kW/);
});

test('kann nicht greifen: Messwerte fehlen', () => {
  const v = load().view({ ...base, clamp: { requestedW: 12000, valueW: 12000, mode: 'held', reason: 'soc_unknown' } });
  assert.deepEqual([v.state, v.tone], ['Messwerte fehlen', 'danger']);
});

test('nur Anzeige / Grenze fehlt: Grund als Zustand', () => {
  const { view } = load();
  const a = view({ ...base, active: false, supported: false, reason: 'manufacturer_unsupported' });
  assert.deepEqual([a.state, a.tone], ['Nur Anzeige', 'info']);
  const b = view({ ...base, active: false, reason: 'limit_missing', limitW: null });
  assert.deepEqual([b.state, b.tone], ['Grenze fehlt', 'warn']);
  assert.equal(b.limit, '–');
});

test('Spitzen unbekannt: Strich, Fehler als Hinweis', () => {
  const v = load().view({ ...base, importW: null, peaks: { month: null, year: null, error: 'no_database' } });
  assert.equal(v.importNow, '–');
  assert.equal(v.monthPeak, '–');
  assert.equal(v.yearPeak, '–');
  assert.match(v.peakNote, /Datenbank/);
});

test('render: alle Element-IDs stehen im Leitstand (index.html), Skript ist eingebunden', () => {
  const html = fs.readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');
  const src = fs.readFileSync(fileURLToPath(new URL('../public/peak-shaving-view.js', import.meta.url)), 'utf8');
  const ids = [...src.matchAll(/(?:set|getElementById)\('([A-Za-z]+)'/g)].map((m) => m[1]);
  assert.ok(ids.length >= 7);
  for (const id of new Set(ids)) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /<script src="\/peak-shaving-view\.js\?v=\d+"><\/script>/);
  const app = fs.readFileSync(fileURLToPath(new URL('../public/app.js', import.meta.url)), 'utf8');
  assert.match(app, /DVhubPeakShaving\?\.render\(status\.peakShaving\)/);
});

test('render: setzt Texte, Ton und Hervorhebung in einer Attrappe', () => {
  const { render } = load();
  const els = {};
  const el = () => ({ textContent: '', hidden: true, classList: { set: new Set(), add(c) { this.set.add(c); }, remove(...c) { c.forEach((x) => this.set.delete(x)); }, toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); } } });
  const doc = { getElementById: (id) => (els[id] ??= el()) };
  render({ ...base, acting: true, clamp: { requestedW: 14700, valueW: 9700, mode: 'target' } }, doc);
  assert.equal(els.peakShavingCard.hidden, false);
  assert.equal(els.peakShavingState.textContent, 'Greift');
  assert.equal(els.peakShavingChip.classList.set.has('warn'), true);
  assert.equal(els.peakShavingMonth.textContent, '12,0 kW · 14.10. 12:15');
  assert.equal(els.peakShavingMonth.classList.set.has('warn'), true);
  render(null, doc);
  assert.equal(els.peakShavingCard.hidden, true);
});

test('[Gegenprüfung bb80db31 P2] Akku am Boden ist kein Messfehler', () => {
  const { view } = load();
  const floor = view({ ...base, clamp: { requestedW: 12000, valueW: 12000, mode: 'held', reason: 'soc_floor' } });
  assert.deepEqual([floor.state, floor.tone], ['Akku am Boden', 'warn']);
  assert.match(floor.detail, /Mindest-Ladestand/);
  for (const reason of ['soc_unknown', 'telemetry_frozen', 'source_mismatch', 'telemetry_unknown']) {
    const v = view({ ...base, clamp: { requestedW: 12000, valueW: 12000, mode: 'held', reason } });
    assert.deepEqual([v.state, v.tone], ['Messwerte fehlen', 'danger'], reason);
  }
  // Teil-Deckel bis zur Netto-Last wegen leerem Akku: greift, Detail nennt den Grund
  const part = view({ ...base, acting: true, clamp: { requestedW: 15000, valueW: 12000, mode: 'net_load', reason: 'soc_floor' } });
  assert.deepEqual([part.state, part.tone], ['Greift', 'warn']);
  assert.match(part.detail, /15,0 kW → 12,0 kW.*Akku am Mindest-Ladestand/);
});

test('Freigabe wartet auf Rücklesung: Hinweis im Detail', () => {
  const v = load().view({ ...base, acting: true, lift: { liftedW: 4300, since: Date.now(), waiting: 'readback' } });
  assert.match(v.detail, /sobald 2704 lesbar ist/);
});
