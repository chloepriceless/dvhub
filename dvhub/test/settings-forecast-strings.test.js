// test/settings-forecast-strings.test.js — Editor der PV-Strings
// (Einstellungen → Prognose, Stufe „detailed“), 2026-10-14.
//
// Vorher: ein leeres oder ungültiges Feld wurde still zu 0 (Neigung 0 = flach,
// Richtung 0 = NORDEN, 0 kWp), Kommastellen bei Neigung/Richtung fielen weg,
// Werte außerhalb des Bereichs gingen durch, und ein leerer Editor legte einen
// Beispiel-String „String 1, 5 kWp“ an, der beim Speichern in der Config landete.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { getConfigDefinition, normalizeConfigInput } from '../config-model.js';
import { loadSettingsPage } from './helpers/settings-page.js';

const clone = (v) => JSON.parse(JSON.stringify(v));

function pageWith(rawConfig) {
  const page = loadSettingsPage();
  page.context.__payload = { config: clone(rawConfig), effectiveConfig: normalizeConfigInput(clone(rawConfig)).effectiveConfig, definition: getConfigDefinition(), meta: {} };
  vm.runInContext('loadConfigPayloadState(__payload)', page.context);
  return page;
}
const draft = (ctx) => JSON.parse(JSON.stringify(vm.runInContext('forecastStringsDraft', ctx)));

describe('PV-Strings-Editor', () => {
  it('Prüfung: fehlende/ungültige Werte werden gemeldet, Kommastellen sind erlaubt', () => {
    const { context } = pageWith({});
    const check = (strings) => JSON.parse(JSON.stringify(context.validateForecastStrings(strings)));
    assert.equal(check([{ label: 'Süd', kwp: 9.5, tiltDeg: 22.5, azimuthDeg: 157.5 }]).valid, true);
    const bad = check([
      { label: 'A', kwp: 5, tiltDeg: null, azimuthDeg: 180 },
      { label: 'B', kwp: 0, tiltDeg: 30, azimuthDeg: 400 },
    ]);
    assert.equal(bad.valid, false);
    assert.deepEqual(bad.messages, [
      'String „A“: Neigung fehlt oder liegt nicht zwischen 0 und 90°.',
      'String „B“: kWp fehlt oder ist nicht größer als 0.',
      'String „B“: Richtung fehlt oder liegt nicht zwischen 0 und 360°.',
    ]);
  });

  it('leeres Feld wird zu „fehlt“ (null), nicht zu 0; Kommastellen bleiben', () => {
    const { context } = pageWith({ forecast: { pv: { configLevel: 'detailed', strings: [{ label: 'Süd', kwp: 9, tiltDeg: 35, azimuthDeg: 180 }] } } });
    context.renderForecastStringEditor();
    const row = context.renderStringRow(0);
    const [, kwp, tilt, az] = row.children;
    az.value = ''; az.fire('input');
    tilt.value = '22.5'; tilt.fire('input');
    kwp.value = '9.75'; kwp.fire('input');
    assert.deepEqual(draft(context), [{ label: 'Süd', kwp: 9.75, tiltDeg: 22.5, azimuthDeg: null }]);
  });

  // #25: welche Zahl welche Himmelsrichtung ist, stand nur im Tooltip.
  it('Richtung°: Himmelsrichtung zum Wert, leer → Zuordnung als Hinweis', () => {
    const { context } = pageWith({});
    const dir = (v) => context.azimuthDirectionText(v);
    assert.equal(dir(180), '180° = Süd');
    assert.equal(dir(90), '90° = Ost');
    assert.equal(dir(135), '135° = Südost');
    assert.equal(dir(0), '0° = Nord');
    assert.equal(dir(360), '360° = Nord');
    assert.equal(dir(270), '270° = West');
    assert.equal(dir(315), '315° = Nordwest');
    assert.equal(dir(200), '200° = Süd');
    for (const empty of [null, undefined, -10, 400]) {
      assert.equal(dir(empty), '0 = Nord, 90 = Ost, 180 = Süd, 270 = West');
    }
  });

  it('Richtung°: Anzeige neben dem Feld folgt der Eingabe', () => {
    const { context } = pageWith({ forecast: { pv: { configLevel: 'detailed', strings: [{ label: 'Süd', kwp: 9, tiltDeg: 35, azimuthDeg: 180 }] } } });
    context.renderForecastStringEditor();
    const row = context.renderStringRow(0);
    const az = row.children[3];
    const hint = row.children.at(-1);
    assert.equal(hint.textContent, 'Richtung: 180° = Süd');
    az.value = '90'; az.fire('input');
    assert.equal(hint.textContent, 'Richtung: 90° = Ost');
    az.value = ''; az.fire('input');
    assert.equal(hint.textContent, 'Richtung: 0 = Nord, 90 = Ost, 180 = Süd, 270 = West');
  });

  it('leerer Editor legt keinen Beispiel-String an', () => {
    const { context } = pageWith({ forecast: { pv: { configLevel: 'detailed' } } });
    context.renderForecastStringEditor();
    assert.deepEqual(draft(context), []);
    const saved = JSON.parse(JSON.stringify(vm.runInContext('collectConfigFromForm()', context)));
    assert.equal(saved.forecast?.pv?.strings, undefined);
  });
});
