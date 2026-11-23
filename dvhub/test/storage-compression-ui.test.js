// test/storage-compression-ui.test.js — „Datenbank ohne Kompression“ sichtbar
// machen (Kundenfall 23.11.2026): Die Karte „Datenbank-Engine“ zeigte auf einer
// Apache-Box grün „aktuell“, der Leitstand-Hinweis war nur gelb.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');

function loadSettings() {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../public/settings.js'), 'utf8');
  const sandbox = { console, Intl, Date, globalThis: {}, window: { DVhubCommon: { escapeHtml: esc }, addEventListener() {}, setTimeout() {} } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, sandbox, { filename: 'settings.js' });
  return sandbox.DVhubSettingsDbEngine;
}

function loadDashboard() {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../public/app.js'), 'utf8');
  const sandbox = {
    console, Date, Math, Number, JSON, Intl, Set, Map, globalThis: {},
    window: { DVhubCommon: { apiFetch: async () => ({ ok: true, json: async () => ({}) }) }, addEventListener() {}, setInterval() {}, clearInterval() {} },
    setInterval() {}, clearInterval() {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, sandbox, { filename: 'app.js' });
  return sandbox.DVhubDashboard;
}

const TS = { ok: true, available: true, extVersion: '2.30.2', binaryVersion: '2.30.2', updatePending: false, probeOk: true, loadOk: true };
const COMP_OK = { ok: true, reason: null, label: null, edition: 'timescale', checkedAt: '2026-11-23T20:00:00Z' };
const COMP_APACHE = { ok: false, reason: 'apache', label: 'TimescaleDB läuft in der Apache-Edition, die keine Kompression kann', edition: 'apache', checkedAt: '2026-11-23T20:00:00Z' };

test('Karte: Apache-Edition ist nicht grün „aktuell“, sondern rot mit Edition und „Kompression: aus“', () => {
  const { dbEngineCardView } = loadSettings();
  const v = dbEngineCardView({ ...TS, edition: 'apache' }, COMP_APACHE);
  assert.equal(v.hidden, false);
  assert.doesNotMatch(v.html, /sa-text-ok|aktuell/);
  assert.match(v.html, /sa-text-err/);
  assert.match(v.html, /Apache-Edition/);
  assert.match(v.html, /nicht komprimiert/);
  assert.match(v.html, /110–230 MB pro Tag/);
  assert.match(v.meta, /Edition: apache/);
  assert.match(v.meta, /Kompression: aus/);
});

test('Karte: Apache laut Statusdatei reicht, auch ohne Prüfung der Wache', () => {
  const { dbEngineCardView } = loadSettings();
  const v = dbEngineCardView({ ...TS, edition: 'apache', provision: { result: 'apache', at: '2026-11-22T01:00:00Z', error: 'kein Community-Paket für forky' } }, null);
  assert.match(v.html, /sa-text-err/);
  assert.match(v.html, /kein Community-Paket für forky/);
  assert.match(v.meta, /Kompression: unbekannt/);
});

test('Karte: Community, Kompression aus (z. B. Job scheitert) → rot', () => {
  const { dbEngineCardView } = loadSettings();
  const v = dbEngineCardView({ ...TS, edition: 'timescale' }, { ...COMP_OK, ok: false, reason: 'job_failing', label: 'die automatische Kompression scheitert seit mehreren Tagen' });
  assert.match(v.html, /sa-text-err/);
  assert.match(v.html, /scheitert seit mehreren Tagen/);
  assert.match(v.meta, /Kompression: aus/);
});

test('Karte: Community mit Kompression bleibt grün und nennt „Kompression an“', () => {
  const { dbEngineCardView } = loadSettings();
  const v = dbEngineCardView({ ...TS, edition: 'timescale' }, COMP_OK);
  assert.match(v.html, /sa-text-ok/);
  assert.match(v.html, /aktuell, Kompression an/);
  assert.match(v.meta, /Edition: timescale · Kompression: an/);
  assert.equal(v.showUpgrade, false);
});

test('Karte: Update verfügbar bleibt wie bisher (Taste sichtbar)', () => {
  const { dbEngineCardView } = loadSettings();
  const v = dbEngineCardView({ ...TS, edition: 'timescale', binaryVersion: '2.31.0', updatePending: true }, COMP_OK);
  assert.equal(v.showUpgrade, true);
  assert.equal(v.upgradeLabel, 'Auf 2.31.0 aktualisieren');
});

test('Karte: ohne TimescaleDB ausgeblendet — außer die Wache meldet fehlende Kompression', () => {
  const { dbEngineCardView } = loadSettings();
  assert.equal(dbEngineCardView({ ok: true, available: false }, null).hidden, true);
  assert.equal(dbEngineCardView({}, COMP_OK).hidden, true);
  const v = dbEngineCardView({}, { ok: false, reason: 'no_timescaledb', label: 'TimescaleDB ist nicht installiert', checkedAt: '2026-11-23T20:00:00Z' });
  assert.equal(v.hidden, false);
  assert.match(v.html, /sa-text-err.*nicht komprimiert \(TimescaleDB ist nicht installiert\)/);
});

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.className = ''; this.textContent = ''; this.id = ''; }
  replaceChildren(...c) { this.children = c; }
  remove() { this.removed = true; }
}
function fakeDoc() {
  const byId = {};
  return {
    byId,
    getElementById: (id) => byId[id] || null,
    createElement: (t) => new El(t),
    body: { prepend: (el) => { byId[el.id] = el; } },
  };
}

test('Leitstand: Hinweis mit severity error macht die Leiste rot und steht zuerst', () => {
  const { renderSystemWarnings } = loadDashboard();
  const doc = fakeDoc();
  renderSystemWarnings([
    { id: 'storage', message: 'Speicher knapp' },
    { id: 'db_compression', message: 'Datenbank ohne Kompression: …', severity: 'error' },
  ], doc);
  const b = doc.byId.systemWarningsBanner;
  assert.equal(b.className, 'victron-alarm-banner alarm');
  assert.match(b.children[0].textContent, /^\u{1F534} Datenbank ohne Kompression/u);
  assert.match(b.children[1].textContent, /^⚠️ Speicher knapp/);
});

test('Leitstand: nur gelbe Hinweise bleiben gelb', () => {
  const { renderSystemWarnings } = loadDashboard();
  const doc = fakeDoc();
  renderSystemWarnings([{ id: 'storage', message: 'Speicher knapp' }], doc);
  assert.equal(doc.byId.systemWarningsBanner.className, 'victron-alarm-banner warn');
});
