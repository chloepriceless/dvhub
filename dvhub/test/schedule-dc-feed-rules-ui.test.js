// test/schedule-dc-feed-rules-ui.test.js — M20 (Feld 19.11.2026): DC-Einspeise-
// Regeln (target feedExcessDcPv) lassen sich in der Oberfläche löschen.
//
// Feld: Eine ausgeschaltete Regel „abregel-sperre“ blieb nach dem Löschen im
// Leitstand stehen. Der Leitstand zeigte sie als Zeile („—“), sammelte beim
// Speichern aber nur Netz-, Lade- und DC-Export-Regeln ein; der Server behielt
// DC-Regeln, wenn keine mitkam. Jetzt trägt die Zeile ihre DC-Regeln mit, der
// Leitstand schickt die vollständige DC-Liste mit replaceDcFeedRules: true —
// eine gelöschte Zeile löscht ihre DC-Regel, Schalter und Zeitfenster der Zeile
// gelten auch für sie. Der JSON-Editor in den Einstellungen zeigt alle Regeln
// und schickt das Kennzeichen ebenso.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const DC_RULE = { id: 'abregel-sperre', enabled: false, target: 'feedExcessDcPv', start: '10:00', end: '16:00', value: 0 };
const GRID_RULE = { id: 'grid_1', enabled: true, target: 'gridSetpointW', start: '06:00', end: '07:00', value: -40 };
const OPT_RULE = {
  id: 'opt-111-0', enabled: true, target: 'gridSetpointW', start: '18:30', end: '18:45',
  slotTs: 111, slotEndTs: 900111, source: 'forecast_optimizer', autoManaged: true, displayTone: 'blue', value: -3000,
};

function loadDashboard(rules) {
  const appPath = fileURLToPath(new URL('../public/app.js', import.meta.url));
  const calls = [];
  const responses = {
    '/api/schedule': { ok: true, body: { rules, config: {} } },
    '/api/schedule/rules': { ok: true, body: { ok: true } },
  };
  const apiFetch = async (url, init = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    const r = responses[url] || { ok: false, body: { ok: false, error: 'test' } };
    return { ok: r.ok, status: r.ok ? 200 : 500, json: async () => JSON.parse(JSON.stringify(r.body)) };
  };
  const sandbox = {
    console, Date, Math, Number, JSON, Intl, Set, Map, Promise,
    window: { DVhubCommon: { apiFetch }, addEventListener() {}, setInterval() {}, clearInterval() {}, confirm: () => true, location: { pathname: '/' } },
    setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {},
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(appPath, 'utf8'), sandbox, { filename: path.basename(appPath) });
  // scheduleRowsState ist ein top-level `let` — im selben Kontext erreichbar.
  const rowsEval = (code) => vm.runInContext(code, sandbox);
  const posted = () => calls.filter((c) => c.url === '/api/schedule/rules').map((c) => c.body);
  return { sandbox, rowsEval, posted };
}

const dcRulesOf = (body) => body.rules.filter((r) => r.target === 'feedExcessDcPv');

test('M20 Leitstand: Speichern ohne Änderung schickt die DC-Regel unverändert mit und ersetzt ausdrücklich', async () => {
  const { sandbox, posted } = loadDashboard([GRID_RULE, DC_RULE, OPT_RULE]);
  await sandbox.loadScheduleDash();
  await sandbox.saveScheduleDash();
  const [body] = posted();
  assert.equal(body.replaceDcFeedRules, true, 'Leitstand verwaltet DC-Regeln: vollständige Liste');
  const dc = dcRulesOf(body);
  assert.equal(dc.length, 1);
  assert.deepEqual(
    { id: dc[0].id, enabled: dc[0].enabled, start: dc[0].start, end: dc[0].end, value: dc[0].value },
    { id: 'abregel-sperre', enabled: false, start: '10:00', end: '16:00', value: 0 },
  );
  assert.ok(body.rules.some((r) => r.target === 'gridSetpointW' && r.start === '06:00'), 'Netz-Regel bleibt');
  assert.ok(!body.rules.some((r) => r.source === 'forecast_optimizer'), 'Optimizer-Regeln bleiben serverseitig');
});

test('M20 Leitstand: gelöschte Zeile löscht ihre DC-Regel (auch die letzte)', async () => {
  const { sandbox, rowsEval, posted } = loadDashboard([GRID_RULE, DC_RULE]);
  await sandbox.loadScheduleDash();
  const removed = rowsEval(`(() => {
    const i = scheduleRowsState.findIndex((s) => s.start === '10:00' && s.end === '16:00');
    return i >= 0 ? scheduleRowsState.splice(i, 1).length : 0;
  })()`);
  assert.equal(removed, 1, 'die DC-Regel hat eine eigene Zeile');
  await sandbox.saveScheduleDash();
  const [body] = posted();
  assert.equal(body.replaceDcFeedRules, true);
  assert.equal(dcRulesOf(body).length, 0, 'keine DC-Regel mehr → Server löscht sie');
});

test('M20 Leitstand: Aktiv-Schalter und Zeitfenster der Zeile gelten für ihre DC-Regel', async () => {
  const { sandbox, rowsEval, posted } = loadDashboard([DC_RULE]);
  await sandbox.loadScheduleDash();
  rowsEval(`(() => {
    const s = scheduleRowsState.find((x) => x.start === '10:00');
    s.enabled = true;
    s.start = '11:00';
  })()`);
  await sandbox.saveScheduleDash();
  const [dc] = dcRulesOf(posted()[0]);
  assert.equal(dc.enabled, true);
  assert.equal(dc.start, '11:00');
  assert.equal(dc.end, '16:00');
  assert.equal(dc.id, 'abregel-sperre');
});

// Codex c49d6e82 P2: teilt eine eingeschaltete DC-Regel ihr Zeitfenster mit einer ausgeschalteten Netz-Regel, zeigt
// der Leitstand die Zeile als „aus“. Ohne Änderung an der Zeile darf das Speichern die DC-Regel nicht ausschalten
// (für eine Regel mit Wert 0 hieße das: Einspeise-Sperre still weg). Erst ein Umschalten der Zeile gilt für alle.
test('M20 Leitstand: gemeinsame Zeile mit ausgeschalteter Netz-Regel schaltet die DC-Regel beim Speichern nicht aus', async () => {
  const dcOn = { ...DC_RULE, enabled: true, start: '06:00', end: '07:00' };
  const gridOff = { ...GRID_RULE, enabled: false };
  const { sandbox, rowsEval, posted } = loadDashboard([gridOff, dcOn]);
  await sandbox.loadScheduleDash();
  await sandbox.saveScheduleDash();
  const [dc] = dcRulesOf(posted()[0]);
  assert.equal(dc.enabled, true, 'unveränderte Zeile: DC-Regel behält ihren Schalter');
  // Operator schaltet die Zeile ein → gilt für alle Regeln der Zeile.
  rowsEval(`scheduleRowsState.find((s) => s.start === '06:00').enabled = true`);
  await sandbox.saveScheduleDash();
  const body = posted()[1];
  assert.equal(dcRulesOf(body)[0].enabled, true);
  assert.equal(body.rules.find((r) => r.target === 'gridSetpointW').enabled, true);
  // Zeile mit beiden Regeln an, Operator schaltet sie aus → auch die DC-Regel aus.
  const second = loadDashboard([GRID_RULE, dcOn]);
  await second.sandbox.loadScheduleDash();
  second.rowsEval(`scheduleRowsState.find((s) => s.start === '06:00').enabled = false`);
  await second.sandbox.saveScheduleDash();
  assert.equal(dcRulesOf(second.posted()[0])[0].enabled, false);
});

test('M20 Leitstand: die DC-Zeile sagt, was sie tut (statt „—“)', async () => {
  const { sandbox, rowsEval } = loadDashboard([DC_RULE, { ...DC_RULE, id: 'dc-an', start: '18:00', end: '19:00', value: 1 }]);
  await sandbox.loadScheduleDash();
  const texts = rowsEval(`scheduleRowsState.map((s) => describeSlotControl(s))`);
  assert.deepEqual([...texts].sort(), ['DC-Einspeisung aus', 'DC-Einspeisung erlaubt']);
});

test('M20 Einstellungen/JSON-Editor: die Liste ist vollständig — DC-Regeln werden mit ersetzt', () => {
  const toolsPath = fileURLToPath(new URL('../public/tools.js', import.meta.url));
  const sandbox = { console, window: { DVhubCommon: {} } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(toolsPath, 'utf8'), sandbox, { filename: path.basename(toolsPath) });
  const { buildScheduleJsonSavePayload } = sandbox.DVhubToolsHistory;
  assert.equal(typeof buildScheduleJsonSavePayload, 'function');
  const body = buildScheduleJsonSavePayload({ rules: [GRID_RULE] });
  assert.equal(body.replaceDcFeedRules, true);
  assert.deepEqual(JSON.parse(JSON.stringify(body.rules)), [GRID_RULE]);
  // Wer im JSON ausdrücklich etwas anderes einträgt, behält es.
  assert.equal(buildScheduleJsonSavePayload({ rules: [], replaceDcFeedRules: false }).replaceDcFeedRules, false);
});
