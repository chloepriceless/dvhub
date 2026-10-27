// test/config-empty-number-reset.test.js — ein leer geräumtes Zahlenfeld der
// Einstellungen gilt als „zurück auf den Standard“ (Review 25.10.2026).
//
// Vorher: Die Seite schickte '' und der Server machte mit Number('') === 0
// eine gespeicherte 0 daraus — obwohl der Platzhalter „Standard: X“ versprach
// (z. B. optimizer.hardFloorSocPct 5 → 0, fixedGrossImportCtKwh 30 → 0,
// dcExportMode.priceThresholdCtKwh null → 0). Betraf rund 66 Zahlenfelder.
//
// Jetzt: Server — ''/null/nur Leerzeichen in einem Zahlenfeld → Pfad löschen
// (wie der Zweig „ungültig“, aber ohne Warnung). Seite — schickt für ein
// geleertes Zahlenfeld eine Löschung. Eine eingetippte 0 bleibt 0.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createDefaultConfig, getConfigDefinition, normalizeConfigInput } from '../config-model.js';
import { mergeAgainstBase } from '../services/config-base-merge.js';
import { loadSettingsPage } from './helpers/settings-page.js';

const clone = (v) => JSON.parse(JSON.stringify(v));
const getPath = (obj, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), obj);
const nest = (p, value) => p.split('.').reverse().reduce((acc, k) => ({ [k]: acc }), value);
const hasPath = (obj, p) => {
  const keys = p.split('.');
  const last = keys.pop();
  const parent = keys.reduce((a, k) => (a == null ? undefined : a[k]), obj);
  return parent != null && Object.prototype.hasOwnProperty.call(parent, last);
};

// Zahlenfelder, bei denen „leer“ bewusst etwas anderes heißt, haben ein eigenes
// `empty` (null/delete/blank) — die gelten hier nicht.
const PLAIN_NUMBER_FIELDS = getConfigDefinition().fields.filter((f) => f.type === 'number' && !f.empty);
const SAMPLE = ['optimizer.maxDischargeW', 'optimizer.batteryCapacityWh', 'optimizer.hardFloorSocPct',
  'userEnergyPricing.fixedGrossImportCtKwh', 'dcExportMode.priceThresholdCtKwh'];

describe('Server: leeres Zahlenfeld = Standard', () => {
  it('es gibt die erwarteten Zahlenfelder ohne eigenes empty', () => {
    const paths = PLAIN_NUMBER_FIELDS.map((f) => f.path);
    for (const p of SAMPLE) assert.ok(paths.includes(p), p);
  });

  for (const raw of ['', '   ', null]) {
    it(`${JSON.stringify(raw)} wird nicht als 0 gespeichert, sondern gelöscht (alle Zahlenfelder ohne empty)`, () => {
      const defaults = createDefaultConfig();
      const wrong = [];
      for (const field of PLAIN_NUMBER_FIELDS) {
        const { rawConfig, persistedConfig, warnings } = normalizeConfigInput(nest(field.path, raw));
        // Einige Abschnitte setzen ihre Standards nach dem Feld-Durchlauf selbst
        // wieder ein (httpPort, Modul-3-Fenster) — das ist der Standard, keine 0.
        if (hasPath(rawConfig, field.path)
          && JSON.stringify(getPath(rawConfig, field.path)) !== JSON.stringify(getPath(defaults, field.path))) wrong.push(`${field.path}: gespeichert als ${JSON.stringify(getPath(rawConfig, field.path))}`);
        if (JSON.stringify(getPath(persistedConfig, field.path)) !== JSON.stringify(getPath(defaults, field.path))) {
          wrong.push(`${field.path}: wirksam ${JSON.stringify(getPath(persistedConfig, field.path))} statt Standard ${JSON.stringify(getPath(defaults, field.path))}`);
        }
        if (warnings.some((w) => w.startsWith(`${field.path}:`))) wrong.push(`${field.path}: unnötige Warnung`);
      }
      assert.deepEqual(wrong, []);
    });
  }

  it('Beispiele aus dem Befund: Standard statt 0', () => {
    assert.equal(normalizeConfigInput({ optimizer: { hardFloorSocPct: '' } }).persistedConfig.optimizer.hardFloorSocPct, 5);
    assert.equal(normalizeConfigInput({ userEnergyPricing: { fixedGrossImportCtKwh: '' } }).persistedConfig.userEnergyPricing.fixedGrossImportCtKwh, 30);
    assert.equal(normalizeConfigInput({ dcExportMode: { priceThresholdCtKwh: '' } }).persistedConfig.dcExportMode.priceThresholdCtKwh, null);
    assert.equal(normalizeConfigInput({ optimizer: { maxDischargeW: '' } }).rawConfig.optimizer.maxDischargeW, undefined);
  });

  it('eine 0 (Zahl oder Text) bleibt 0', () => {
    for (const value of [0, '0', ' 0 ']) {
      assert.equal(normalizeConfigInput({ optimizer: { maxDischargeW: value } }).rawConfig.optimizer.maxDischargeW, 0);
      assert.equal(normalizeConfigInput({ dcExportMode: { priceThresholdCtKwh: value } }).rawConfig.dcExportMode.priceThresholdCtKwh, 0);
    }
  });

  it('Felder mit empty: "null" bleiben null', () => {
    assert.equal(normalizeConfigInput({ schedule: { defaultChargeCurrentA: '' } }).rawConfig.schedule.defaultChargeCurrentA, null);
  });

  it('ungültiger Text warnt weiter', () => {
    const { rawConfig, warnings } = normalizeConfigInput({ optimizer: { maxDischargeW: 'abc' } });
    assert.equal(rawConfig.optimizer.maxDischargeW, undefined);
    assert.ok(warnings.some((w) => w.startsWith('optimizer.maxDischargeW: invalid number')));
  });
});

// Die Einstellungsseite: Feld mit gespeichertem Wert zeichnen, leer räumen,
// speichern wie im Browser (collectConfigFromForm) und durch den Dreiwege-
// Abgleich des Servers (config-base-merge) und die Normalisierung schicken.
function saveWithInput(rawConfig, fieldPath, typed) {
  const { context, inputs } = loadSettingsPage();
  const normalized = normalizeConfigInput(clone(rawConfig));
  context.__payload = { config: clone(rawConfig), effectiveConfig: normalized.effectiveConfig, definition: getConfigDefinition(), meta: {} };
  vm.runInContext('loadConfigPayloadState(__payload)', context);
  const field = context.__payload.definition.fields.find((f) => f.path === fieldPath);
  const model = context.buildFieldRenderModel(field);
  const input = context.createConfigInput(field, model.value, model.inherited);
  inputs.set(input.id, input);
  input.value = typed;
  const sent = clone(vm.runInContext('collectConfigFromForm()', context));
  const merged = mergeAgainstBase(sent, clone(rawConfig), clone(rawConfig));
  return { sent, saved: normalizeConfigInput(merged) };
}

describe('Einstellungsseite: Zahlenfeld leeren', () => {
  const cases = [
    { path: 'optimizer.hardFloorSocPct', stored: 20, standard: 5 },
    { path: 'userEnergyPricing.fixedGrossImportCtKwh', stored: 27.5, standard: 30 },
    { path: 'optimizer.maxDischargeW', stored: 6000, standard: undefined },
    { path: 'dcExportMode.priceThresholdCtKwh', stored: 8, standard: null },
  ];
  for (const { path: p, stored, standard } of cases) {
    it(`${p}: geleert → Standard (${JSON.stringify(standard)}), nicht 0`, () => {
      const { sent, saved } = saveWithInput(nest(p, stored), p, '');
      assert.equal(hasPath(sent, p), false, `die Seite schickt keinen Wert für ${p} (Löschung), sondern ${JSON.stringify(getPath(sent, p))}`);
      assert.equal(hasPath(saved.rawConfig, p), false);
      assert.equal(getPath(saved.persistedConfig, p), standard);
    });
    it(`${p}: eingetippte 0 bleibt 0`, () => {
      const { sent, saved } = saveWithInput(nest(p, stored), p, '0');
      assert.equal(getPath(sent, p), 0);
      assert.equal(getPath(saved.rawConfig, p), 0);
    });
  }
});
