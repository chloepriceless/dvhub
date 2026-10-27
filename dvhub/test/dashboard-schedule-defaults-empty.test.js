// test/dashboard-schedule-defaults-empty.test.js — Zeitplan-Standards und
// Börsenautomatik im Leitstand (Review 25.10.2026).
//
// 1. Ein leeres Standard-Feld (Grid/Charge/DC) speicherte 0 als Dauer-Standard
//    (Number('') === 0): Ladestrom 0 A, Netz 0 W, DC-Einspeisung aus. Leer heißt
//    wie im Slot-Editor „nicht ändern“.
// 2. `Number(v) || -12000` / `|| 85` ersetzte eine eingetippte 0 durch den
//    Ersatzwert. Nur ein leeres Feld fällt zurück (wie readAutomationMinSocPct).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function makeEl(value = '') {
  return {
    value,
    textContent: '',
    disabled: false,
    checked: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  };
}

// Antworten je URL; Standard „nicht ok“, damit nach dem Schreibbefehl kein
// Neuladen des Dashboards im Test läuft.
function loadDashboard({ fields = {}, responses = {} } = {}) {
  const appPath = fileURLToPath(new URL('../public/app.js', import.meta.url));
  const calls = [];
  const apiFetch = async (url, init = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    const r = responses[url] || { ok: false, body: { ok: false, error: 'test' } };
    return { ok: r.ok, status: r.ok ? 200 : 500, json: async () => r.body };
  };
  const sandbox = {
    console, Date, Math, Number, JSON, Intl, Set, Map, Promise,
    window: { DVhubCommon: { apiFetch }, addEventListener() {}, setInterval() {}, clearInterval() {}, confirm: () => true, location: { pathname: '/' } },
    setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(appPath, 'utf8'), sandbox, { filename: path.basename(appPath) });
  const els = { controlMsg: makeEl() };
  // Alle Meldungen merken: loadScheduleDash überschreibt die Statuszeile danach.
  const messages = [];
  let text = '';
  Object.defineProperty(els.controlMsg, 'textContent', { get: () => text, set(v) { text = v; messages.push(v); } });
  for (const [id, value] of Object.entries(fields)) els[id] = makeEl(value);
  sandbox.document = {
    getElementById: (id) => els[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  return { sandbox, calls, els, messages, posted: (url) => calls.filter((c) => c.url === url).map((c) => c.body) };
}

const RULES_OK = { '/api/schedule/rules': { ok: true, body: { ok: true } } };

test('Zeitplan speichern: leere Standard-Felder bleiben unverändert (kein 0 als Standard)', async () => {
  const { sandbox, posted } = loadDashboard({
    fields: { defaultGridSetpointInput: '', defaultChargeCurrentInput: '  ', defaultFeedExcessDcPvInput: '' },
    responses: RULES_OK,
  });
  await sandbox.saveScheduleDash();
  assert.deepEqual(posted('/api/schedule/config'), [], 'nichts zu ändern → kein Standard-Aufruf');
});

test('Zeitplan speichern: nur das ausgefüllte Standard-Feld geht mit, eine 0 ist gültig', async () => {
  const { sandbox, posted } = loadDashboard({
    fields: { defaultGridSetpointInput: '0', defaultChargeCurrentInput: '', defaultFeedExcessDcPvInput: '0' },
    responses: RULES_OK,
  });
  await sandbox.saveScheduleDash();
  assert.deepEqual(JSON.parse(JSON.stringify(posted('/api/schedule/config'))), [{ defaultGridSetpointW: 0, defaultFeedExcessDcPv: 0 }]);
});

test('Knopf „Defaults speichern“: leere Felder bleiben unverändert, mit Meldung', async () => {
  const { sandbox, posted, els } = loadDashboard({
    fields: { defaultGridSetpointInput: '', defaultChargeCurrentInput: '' },
  });
  await sandbox.saveScheduleDefaults();
  assert.deepEqual(posted('/api/schedule/config'), []);
  assert.equal(els.controlMsg.textContent, 'Keine Werte zum Speichern.');
});

test('Knopf „Defaults speichern“: nur Grid gesetzt → Charge bleibt, Meldung sagt es', async () => {
  const { sandbox, posted, messages } = loadDashboard({
    fields: { defaultGridSetpointInput: '-40', defaultChargeCurrentInput: '' },
    responses: { '/api/schedule/config': { ok: true, body: { ok: true } } },
  });
  // loadScheduleDash danach: Antwort „nicht ok“ (Standard) → bricht ohne Fehler ab.
  await sandbox.saveScheduleDefaults();
  assert.deepEqual(JSON.parse(JSON.stringify(posted('/api/schedule/config'))), [{ defaultGridSetpointW: -40 }]);
  assert.equal(messages[0], 'Defaults gespeichert: Grid -40 W, Charge unverändert');
});

test('Börsenautomatik: eine eingetippte 0 bei Max-Entladung bleibt 0', async () => {
  const { sandbox, posted } = loadDashboard({
    fields: { automationMaxDischargeW: '0', automationInverterEfficiency: '0', automationMinSocPct: '30', automationSafetyMargin: '1.5' },
  });
  await sandbox.saveAutomationConfig();
  const [body] = posted('/api/schedule/automation/config');
  assert.equal(body.maxDischargeW, 0);
  assert.equal(body.inverterEfficiencyPct, 0, 'eingetippter Wert geht an den Server (der klemmt auf 1–100)');
});

test('Börsenautomatik: leere Felder fallen auf -12000 W und 85 % zurück', async () => {
  const { sandbox, posted } = loadDashboard({
    fields: { automationMaxDischargeW: '', automationInverterEfficiency: '' },
  });
  await sandbox.saveAutomationConfig();
  const [body] = posted('/api/schedule/automation/config');
  assert.equal(body.maxDischargeW, -12000);
  assert.equal(body.inverterEfficiencyPct, 85);
});
