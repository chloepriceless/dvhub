// test/history-mispel-card.test.js — MiSpeL-Karte der Historie (Codex 2026-10-18):
// eine ältere Antwort darf die Karte des neueren Jahres nicht überschreiben, und
// ohne gewählte Option bleibt die Karte verborgen.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function loadPage(apiFetch) {
  const source = fs.readFileSync(fileURLToPath(new URL('../public/history.js', import.meta.url)), 'utf8');
  const elements = new Map();
  const el = () => ({
    value: '', hidden: true, innerHTML: '', textContent: '', style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [], appendChild() {},
  });
  const sandbox = {
    console, URL, setTimeout, clearTimeout, setInterval: () => 0,
    window: { __DVHUB_HISTORY_TEST__: true, DVhubCommon: { apiFetch } },
    document: {
      readyState: 'complete', documentElement: { style: { setProperty() {} } },
      getElementById(id) { if (!elements.has(id)) elements.set(id, el()); return elements.get(id); },
      addEventListener() {}, querySelectorAll: () => [], querySelector: () => null,
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  try { vm.runInContext(source, sandbox, { filename: 'history.js' }); } catch { /* Bootstrap braucht einen Browser */ }
  return { sandbox, byId: (id) => sandbox.document.getElementById(id) };
}

const overview = (year) => ({
  ok: true, mode: 'pauschal', year, festlegung: 'BNetzA', hinweise: [],
  perioden: [{ von: `${year}-01-01`, bis: `${year}-12-31`, rumpf: false, grenzen: { P1: 4000, P4: 4320 }, werte: { P7: 1, P9: 2, P10: 0, P11: 2, P15: 1 }, ohnePreis: 0 }],
});

test('Schneller Jahreswechsel: die spätere Anfrage gewinnt, auch wenn die frühere zuletzt antwortet', async () => {
  const pending = new Map();
  const apiFetch = (url) => new Promise((resolve) => {
    const year = Number(/year=(\d+)/.exec(url)[1]);
    pending.set(year, () => resolve({ ok: true, json: async () => overview(year) }));
  });
  const { sandbox, byId } = loadPage(apiFetch);
  byId('historyDate').value = '2026-06-01';
  const first = sandbox.loadMispelOverview();
  byId('historyDate').value = '2027-06-01';
  const second = sandbox.loadMispelOverview();
  pending.get(2027)(); await second;
  pending.get(2026)(); await first;
  assert.equal(byId('historyMispelCard').hidden, false);
  assert.match(byId('historyMispelSub').textContent, /Pauschaloption 2027/);
});

test('Ohne Option verborgen; derselbe Jahr lädt nur mit force neu (nach „Preise nachladen“)', async () => {
  let calls = 0;
  let mode = 'none';
  const apiFetch = async () => { calls++; return { ok: true, json: async () => (mode === 'none' ? { ok: true, mode: 'none', perioden: [] } : overview(2026)) }; };
  const { sandbox, byId } = loadPage(apiFetch);
  byId('historyDate').value = '2026-06-01';
  await sandbox.loadMispelOverview();
  assert.equal(byId('historyMispelCard').hidden, true);
  mode = 'pauschal';
  await sandbox.loadMispelOverview();
  assert.equal(calls, 1, 'gleiches Jahr ohne force: kein neuer Abruf');
  vm.runInContext('mispelLoadedYear = null;', sandbox);   // wie triggerBackfill()
  await sandbox.loadMispelOverview();
  assert.equal(calls, 2);
  assert.equal(byId('historyMispelCard').hidden, false);
  const src = fs.readFileSync(fileURLToPath(new URL('../public/history.js', import.meta.url)), 'utf8');
  const backfill = src.slice(src.indexOf('async function triggerBackfill'), src.indexOf('async function triggerCsvExport'));
  assert.match(backfill, /mispelLoadedYear = null;\s*\n\s*await loadHistorySummary\(\);/);
});
