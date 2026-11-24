// Preset-Tabellen nur mit eigenen Schlüsseln (Christin 21.11.2026, A8): §14a-Vorrang und Netzanschluss-Reihenfolge.
//
// `PRESETS[eingabe]` liest über den Prototyp: „constructor“, „__proto__“, „toString“, „hasOwnProperty“ … ergeben eine
// Funktion bzw. Object.prototype statt eines Presets. Bis 8f0f1346 wurde das als gültiges Preset genommen — die
// Vorrangliste bzw. Reihenfolge war dann keine Liste (später TypeError: indexOf fehlt, nicht iterierbar). Ein Array wie
// ["heater_first"] traf über die Umwandlung in Text das Preset, der Schlüssel blieb aber ein Array (Rust-Abweichung
// P5-10). Jetzt: nur eigene Schlüssel, nur echte Texte; sonst die Vorgabe wie heute (heat_first bzw. wallbox_first).
// Weitere Fundstellen derselben Art: nachschlage-tabellen-eigene-schluessel.test.js.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveParagraph14aConfig, PRIORITY_PRESETS } from '../services/paragraph14a/index.js';
import { DEFAULT_PRIORITY, allocateBudget } from '../services/paragraph14a/rules.js';
import { resolveGridConnection, ORDER_PRESETS } from '../services/grid-connection/index.js';

// Schlüssel, die jede gewöhnliche Tabelle über Object.prototype „kennt“.
const PROTO_KEYS = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', 'toLocaleString'];
// Nicht-Texte, die über die Umwandlung in Text einen Eintrag träfen oder sonst Unsinn wären.
const NON_STRINGS = (valid) => [[valid], { toString: () => valid }, 42, true, null, undefined, {}];

describe('§14a: Vorrang-Preset (PRIORITY_PRESETS)', () => {
  it('Prototyp-Schlüssel und Nicht-Texte → Vorgabe heat_first, Zuteilung ohne TypeError', () => {
    for (const bad of [...PROTO_KEYS, ...NON_STRINGS('ev_first')]) {
      const c = resolveParagraph14aConfig({ paragraph14a: { priorityPreset: bad } });
      assert.equal(c.priorityPreset, 'heat_first', `priorityPreset ${String(bad)}`);
      assert.deepEqual(c.priority, [...DEFAULT_PRIORITY], `Vorrangliste bei ${String(bad)}`);
      assert.ok(Array.isArray(c.priority));
      const out = allocateBudget(4200, [
        { id: 'wp', kind: 'waermepumpe', maxW: 4200 }, { id: 'wb', kind: 'ladepunkt', maxW: 11000 },
      ], { mode: 'priority', priority: c.priority });
      assert.deepEqual(out, { wp: 4200, wb: 0 }, `Zuteilung bei ${String(bad)}`);
    }
  });

  it('aus JSON gelesenes „__proto__“ als Wert → Vorgabe', () => {
    const cfg = JSON.parse('{"paragraph14a":{"priorityPreset":"__proto__"}}');
    assert.equal(resolveParagraph14aConfig(cfg).priorityPreset, 'heat_first');
  });

  it('gültige Presets unverändert', () => {
    for (const key of Object.keys(PRIORITY_PRESETS)) {
      const c = resolveParagraph14aConfig({ paragraph14a: { priorityPreset: key } });
      assert.equal(c.priorityPreset, key);
      assert.deepEqual(c.priority, PRIORITY_PRESETS[key]);
    }
    assert.equal(resolveParagraph14aConfig({}).priorityPreset, 'heat_first');
  });
});

describe('Netzanschluss: Reihenfolge (ORDER_PRESETS)', () => {
  it('Prototyp-Schlüssel und Nicht-Texte (auch ["heater_first"]) → Standard wallbox_first, Schlüssel ist Text', () => {
    for (const bad of [...PROTO_KEYS, ...NON_STRINGS('heater_first')]) {
      const r = resolveGridConnection({ gridConnection: { limitKw: 30, order: bad } });
      assert.equal(r.orderKey, 'wallbox_first', `order ${JSON.stringify(bad)}`);
      assert.equal(typeof r.orderKey, 'string');
      assert.deepEqual([...r.order], ['wallbox', 'heater', 'eebus'], `Reihenfolge bei ${String(bad)}`);
      assert.ok(Array.isArray(r.order), 'iterierbare Liste');
    }
  });

  it('gültige Reihenfolgen unverändert', () => {
    for (const key of Object.keys(ORDER_PRESETS)) {
      const r = resolveGridConnection({ gridConnection: { limitKw: 30, order: key } });
      assert.equal(r.orderKey, key);
      assert.deepEqual(r.order, ORDER_PRESETS[key]);
    }
  });
});

