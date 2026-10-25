// test/history-viz-local-today.test.js — Ersatz-„heute“ der Historien-Karten
// nach ÖRTLICHEM Datum (Review 25.10.2026).
//
// applyView fiel bei leerem #historyDate auf new Date().toISOString().slice(0,10)
// zurück — das UTC-Datum. Erreichbar: das Datumsfeld ist sichtbar und lässt
// sich leeren (Entf/Rücktaste); sein change-Ereignis ruft applyView(view, '').
// Zwischen 00:00 und 02:00 (Sommerzeit) luden die Karten dann den Vortag,
// während history.js (currentDateValue, örtlich) den heutigen Tag zeigte.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function withTz(tz, fn) {
  const before = process.env.TZ;
  process.env.TZ = tz;
  return Promise.resolve().then(fn).finally(() => {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  });
}

function loadHistoryViz(nowIso) {
  const file = fileURLToPath(new URL('../public/history-viz.js', import.meta.url));
  const NOW = Date.parse(nowIso);
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW; }
  }
  const listeners = {};
  const domReady = [];
  const section = { dataset: { showView: 'day', vizCard: 'probe' }, classList: { toggle() {}, add() {}, remove() {} } };
  const dateInp = { value: '', addEventListener(type, fn) { (listeners[type] ||= []).push(fn); } };
  const viewSel = { value: 'day', addEventListener() {} };
  const sandbox = {
    console, Math, Number, JSON, Intl, Set, Map, Promise, Date: FixedDate,
    setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {},
    window: { addEventListener() {}, DVhubCommon: { apiFetch: async () => ({ ok: false, json: async () => ({}) }) } },
    document: {
      readyState: 'loading', // init erst, wenn der Test DOMContentLoaded auslöst
      addEventListener(type, fn) { if (type === 'DOMContentLoaded') domReady.push(fn); },
      getElementById: (id) => (id === 'historyDate' ? dateInp : id === 'historyView' ? viewSel : null),
      querySelector: (sel) => (sel === '[data-viz-card="probe"]' ? section : null),
      querySelectorAll: (sel) => (sel === '[data-show-view]' ? [section] : []),
      documentElement: {},
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: path.basename(file) });
  const viz = sandbox.window.historyViz;
  const dates = [];
  viz._internals.buildDispatch.probe = async (_view, date) => { dates.push(date); };
  const fire = (type) => { for (const fn of listeners[type] || []) fn({ target: dateInp }); };
  return { viz, dates, dateInp, fire, init: () => domReady.forEach((fn) => fn()) };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('leeres Datumsfeld: Karten laden den örtlichen heutigen Tag (Berlin 00:30 Sommerzeit)', () => withTz('Europe/Berlin', async () => {
  // 2026-10-24T22:30Z = 25.10.2026 00:30 in Berlin
  const { viz, dates } = loadHistoryViz('2026-10-24T22:30:00Z');
  viz.applyView('day', '');
  await tick();
  assert.deepEqual(dates, ['2026-10-25']);
}));

test('leeres Datumsfeld: Winterzeit 00:15 Ortszeit (23:15 UTC) ist schon der neue Tag', () => withTz('Europe/Berlin', async () => {
  const { viz, dates } = loadHistoryViz('2026-12-01T23:15:00Z');
  viz.applyView('day', '');
  await tick();
  assert.deepEqual(dates, ['2026-12-02']);
}));

test('ein gesetztes Datum gilt unverändert', () => withTz('Europe/Berlin', async () => {
  const { viz, dates } = loadHistoryViz('2026-10-24T22:30:00Z');
  viz.applyView('day', '2026-03-01');
  await tick();
  assert.deepEqual(dates, ['2026-03-01']);
}));

test('Seitenstart mit leerem Datumsfeld und späteres Leeren des Felds: örtlicher Tag', () => withTz('Europe/Berlin', async () => {
  const { dates, dateInp, fire, init } = loadHistoryViz('2026-10-24T22:30:00Z');
  init();                     // erster Aufbau: #historyDate noch leer
  await tick();
  dateInp.value = '2026-10-20';
  fire('change');
  await tick();
  dateInp.value = '';         // Nutzer leert das Datumsfeld (Entf/Rücktaste)
  fire('change');
  await tick();
  assert.deepEqual(dates, ['2026-10-25', '2026-10-20', '2026-10-25']);
}));
