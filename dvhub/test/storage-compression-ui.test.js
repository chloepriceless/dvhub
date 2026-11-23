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

// ── Karte „Speicher“ (Speicher-Konzept Schritt 4) ────────────────────────────
const ST = {
  ok: true, level: 'wenig', freeMb: 900, totalMb: 12288, freePct: 7.3, daysLeft: 41.2, growthMbPerDay: 21.5, dbMb: 4100,
  mounts: [{ roles: ['db'], totalMb: 12288, freeMb: 900, freePct: 7.3, level: 'wenig' }, { roles: ['data', 'system', 'logs'], totalMb: 32768, freeMb: 20000, freePct: 61, level: 'ok' }],
  profile: { effective: 'mittel', base: 'gross', mode: 'fixed', suggested: 'klein', temporary: true, reason: 'Speicher wenig: eine Stufe härter als „groß“, solange der Platz knapp ist', values: { compressAfter: '1 day', rawKeepDays: null, maxWalMb: 512 } },
  compression: { ok: true, edition: 'timescale', checkedAt: '2026-11-23T20:00:00Z' },
  db: { samplesMb: 1928, compressedChunks: 116, chunks: 120, rawBeforeMb: 41984, rawAfterMb: 1283, tables: { energy_slots_15m: 305, control_events: 804, audit_log: 357, optimizer_run_series: 495 } },
  logMode: 'full', container: true,
};
function loadStorage() {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../public/settings.js'), 'utf8');
  const sandbox = { console, Intl, Date, globalThis: {}, window: { DVhubCommon: { escapeHtml: esc }, addEventListener() {}, setTimeout() {} } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, sandbox, { filename: 'settings.js' });
  return sandbox.DVhubSettingsStorage;
}

test('Karte „Speicher“: Stufe, Reichweite, Platten, Profil mit Vorschlag, DB-Aufteilung, Hinweise', () => {
  const { storageCardView } = loadStorage();
  const v = storageCardView(ST);
  assert.equal(v.hidden, false);
  assert.match(v.bannerHtml, /sa-text-warn.*Speicher wenig: 900 MB frei von 12,0 GB, voll in etwa 41 Tagen \(wächst 22 MB pro Tag\)/);
  assert.match(v.rowsHtml, /<td>Datenbank<\/td><td>12,0 GB<\/td>/);
  assert.match(v.rowsHtml, /DVhub-Ordner, System \(\/\), Protokolle/);
  assert.match(v.profileText, /Speicherprofil: mittel — Speicher wenig/);
  assert.match(v.profileText, /5-s-Rohwerte für immer, Schreibpuffer bis 512 MB/);
  assert.equal(v.showApply, true);
  assert.match(v.applyLabel, /Vorschlag übernehmen: klein/);
  assert.match(v.dbText, /Kompression: an \(timescale\)/);
  assert.match(v.dbText, /Messwerte 1,9 GB \(116 von 120 Blöcken komprimiert, 41,0 GB → 1,3 GB\)/);
  assert.match(v.dbText, /Protokolle 1,1 GB/);
  assert.match(v.hints.join(' '), /„Vollständig“ kostet etwa 15–20 MB pro Tag zusätzlich; Reichweite heute etwa 41 Tage/);
  assert.match(v.hints.join(' '), /docker image prune/);
});

test('Karte „Speicher“: kritisch rot, ohne Kompression benannt, ohne Daten ausgeblendet', () => {
  const { storageCardView } = loadStorage();
  const v = storageCardView({ ...ST, level: 'kritisch', compression: { ok: false, label: 'TimescaleDB läuft in der Apache-Edition, die keine Kompression kann', checkedAt: 'x' }, profile: {}, logMode: 'standard', container: false });
  assert.match(v.bannerHtml, /sa-text-err.*Speicher kritisch/);
  assert.match(v.dbText, /Kompression: aus — TimescaleDB läuft in der Apache-Edition/);
  assert.equal(v.showApply, false);
  assert.deepEqual([...v.hints], []);
  assert.equal(storageCardView({ ok: true, level: 'unbekannt' }).hidden, true);
  assert.match(storageCardView({ ...ST, level: 'ok', daysLeft: null, growthMbPerDay: null }).bannerHtml, /sa-text-ok.*Wachstum wird noch gemessen/);
});

// Codex 246e360a (P2): ein Fehler beim Übernehmen bleibt sichtbar (die Karte lädt vorher neu).
test('„Vorschlag übernehmen“ scheitert → Fehler bleibt nach dem Neuladen der Karte stehen', async () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../public/settings.js'), 'utf8');
  const els = {};
  const el = (id) => (els[id] ||= { id, innerHTML: '', textContent: '', hidden: true, disabled: false, style: {} });
  const calls = [];
  const apiFetch = async (url, opts) => {
    calls.push([url, opts?.method || 'GET']);
    if (url === '/api/storage/profile') return { ok: false, status: 503, json: async () => ({ ok: false, error: 'runtime_worker_unavailable' }) };
    return { ok: true, status: 200, json: async () => ({ ...ST, level: 'ok' }) };
  };
  const sandbox = { console, Intl, Date, Promise, globalThis: {},
    window: { DVhubCommon: { escapeHtml: esc, apiFetch }, addEventListener() {}, setTimeout: (f) => f(), dvConfirm: async () => true } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, sandbox, { filename: 'settings.js' });
  sandbox.document = { getElementById: el };
  await sandbox.DVhubSettingsStorage.applyStorageProfileSuggestion();
  assert.match(els.storageBanner.innerHTML, /Übernehmen fehlgeschlagen: runtime_worker_unavailable/);
  assert.equal(els.storageGroup.hidden, false, 'Karte geladen');
  assert.deepEqual(calls[0], ['/api/storage/profile', 'POST']);
});

// Codex 30313bfc: noch nicht umgesetztes Profil bleibt als „wird übernommen“ sichtbar.
test('Karte „Speicher“: ausstehendes Profil nicht als aktiv zeigen', () => {
  const { storageCardView } = loadStorage();
  const v = storageCardView({ ...ST, profile: { ...ST.profile, pending: true, suggested: null } });
  assert.match(v.profileText, /^Wird übernommen — Speicherprofil/);
  assert.equal(v.showApply, false);
  assert.equal(v.pending, true);
});
