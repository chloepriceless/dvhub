// test/inverter-power-field.test.js — GUI-Feld „Wechselrichter-Nennleistung“
// (Support-Fall 2026-10-15, GoodWe 29,9 kW): EOS bekam 10 kW, weil es für
// optimizer.inverterMaxPowerW kein Eingabefeld gab. Eine Änderung direkt in
// EOS überschrieb der nächste Abgleich wieder.
import test from 'node:test';
import assert from 'node:assert/strict';

import { getConfigDefinition, normalizeConfigInput } from '../config-model.js';
import { buildEosInverters } from '../services/optimizer/eos-config-sync.js';

function field(path) {
  const definition = getConfigDefinition();
  const fields = definition.fields || definition.sections?.flatMap((s) => s.fields) || [];
  return fields.find((f) => f.path === path);
}

test('Feld steht unter „Akku-Grenzen“, Zahl in W, leer = null, Platzhalter 10000', () => {
  const f = field('optimizer.inverterMaxPowerW');
  assert.ok(f, 'optimizer.inverterMaxPowerW fehlt in der Settings-Definition');
  assert.equal(f.group, 'batteryLimits');
  assert.equal(f.type, 'number');
  assert.equal(f.empty, 'null');
  assert.equal(f.default, 10000);
  assert.match(f.label, /Wechselrichter-Nennleistung \(W\)/);
});

test('eingetragener Wert übersteht die Normalisierung und kommt in EOS an', () => {
  const { effectiveConfig } = normalizeConfigInput({ optimizer: { inverterMaxPowerW: 29900 } });
  assert.equal(effectiveConfig.optimizer.inverterMaxPowerW, 29900);
  assert.equal(buildEosInverters(effectiveConfig)[0].max_power_w, 29900);
});

test('geleertes Feld (null) → EOS plant mit 10000 W', () => {
  const { effectiveConfig } = normalizeConfigInput({ optimizer: { inverterMaxPowerW: null } });
  assert.equal(buildEosInverters(effectiveConfig)[0].max_power_w, 10000);
});
