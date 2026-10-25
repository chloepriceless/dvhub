// test/dashboard-empty-number-inputs.test.js — leere Zahlenfelder im Leitstand
// (Review 25.10.2026).
//
// Number('') ist 0 und besteht Number.isFinite. Ein leer geräumtes (oder vom
// Browser als ungültig verworfenes, dann value === '') Feld ging so als 0 an
// den Wechselrichter: Laden aus, Max-Entladung 0 = Halten, Netz-Sollwert 0.
// Leer muss abgelehnt werden — mit einer klaren Meldung, nicht still.

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

// app.js in einer VM laden; danach ein Ersatz-DOM mit den Feldern setzen
// (erst nach dem Laden, sonst liefe initDashboard).
function loadDashboard({ fields = {}, response = { ok: true, body: { ok: true } } } = {}) {
  const appPath = fileURLToPath(new URL('../public/app.js', import.meta.url));
  const calls = [];
  const apiFetch = async (url, init = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    return { ok: response.ok, status: response.ok ? 200 : 500, json: async () => response.body };
  };
  const sandbox = {
    console, Date, Math, Number, JSON, Intl, Set, Map, Promise,
    window: { DVhubCommon: { apiFetch }, addEventListener() {}, setInterval() {}, clearInterval() {}, confirm: () => true, location: { pathname: '/' } },
    setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(appPath, 'utf8'), sandbox, { filename: path.basename(appPath) });
  const els = { controlMsg: makeEl() };
  for (const [id, value] of Object.entries(fields)) els[id] = makeEl(value);
  sandbox.document = {
    getElementById: (id) => els[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  return { sandbox, calls, els, controlWrites: () => calls.filter((c) => c.url === '/api/control/write') };
}

const MANUAL = [
  { fn: 'manualWriteGrid', id: 'manualGridValue', label: 'Grid Setpoint' },
  { fn: 'manualWriteCharge', id: 'manualChargeValue', label: 'Charge Current' },
  { fn: 'manualWriteMaxDischarge', id: 'manualMaxDischargeValue', label: 'Max Discharge' },
];

for (const { fn, id, label } of MANUAL) {
  for (const raw of ['', '   ']) {
    test(`${fn}: leeres Feld (${JSON.stringify(raw)}) schreibt nichts und sagt „Bitte einen Wert eingeben“`, async () => {
      const { sandbox, els, controlWrites } = loadDashboard({ fields: { [id]: raw } });
      await sandbox[fn]();
      assert.equal(controlWrites().length, 0, 'kein Schreibbefehl an den Wechselrichter');
      assert.equal(els.controlMsg.textContent, `${label}: Bitte einen Wert eingeben`);
    });
  }

  test(`${fn}: eine eingetippte 0 wird weiter geschrieben`, async () => {
    // Antwort „nicht ok“ → kein Dashboard-Refresh im Test, der Schreibbefehl ist trotzdem raus.
    const { sandbox, controlWrites } = loadDashboard({ fields: { [id]: '0' }, response: { ok: false, body: { ok: false, error: 'x' } } });
    await sandbox[fn]();
    assert.equal(controlWrites().length, 1);
    assert.equal(controlWrites()[0].body.value, 0);
  });
}

test('Max-Entladung-Editor: leeres Feld wird abgelehnt, mit Meldung', async () => {
  const { sandbox, controlWrites } = loadDashboard();
  for (const raw of ['', '  ', undefined, null]) {
    const outcome = await sandbox.submitMaxDischargeUpdate({ rawValue: raw, apiFetchImpl: sandbox.window.DVhubCommon.apiFetch });
    assert.equal(outcome.ok, false, `rawValue ${JSON.stringify(raw)}`);
    assert.equal(outcome.error, 'Max Entladung: Bitte einen Wert eingeben');
  }
  assert.equal(controlWrites().length, 0);
});

test('Max-Entladung-Editor: 0 (Halten) und -1 (unbegrenzt) bleiben gültig', async () => {
  const { sandbox, controlWrites } = loadDashboard();
  for (const raw of ['0', '-1']) {
    const outcome = await sandbox.submitMaxDischargeUpdate({ rawValue: raw, apiFetchImpl: sandbox.window.DVhubCommon.apiFetch });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.value, Number(raw));
  }
  assert.deepEqual(controlWrites().map((c) => c.body.value), [0, -1]);
});

test('Max-Entladung-Editor: die Meldung landet in der Statuszeile', async () => {
  const { sandbox, els, controlWrites } = loadDashboard({ fields: { maxDischargeInput: '' } });
  await sandbox.handleMaxDischargeSubmit();
  assert.equal(controlWrites().length, 0);
  assert.equal(els.controlMsg.textContent, 'Max Entladung: Bitte einen Wert eingeben');
});

test('Min-SOC: fehlender Reglerwert wird abgelehnt statt 0 % zu schreiben', async () => {
  const { sandbox, controlWrites } = loadDashboard();
  const outcome = await sandbox.submitMinSocUpdate({ sliderValue: '', currentReadback: 20, apiFetchImpl: sandbox.window.DVhubCommon.apiFetch });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, 'Min SOC: Bitte einen Wert eingeben');
  assert.equal(controlWrites().length, 0);
});
