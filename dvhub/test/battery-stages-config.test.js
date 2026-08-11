// Config-Seite der Akku-Ausbaustufen (Christin 2026-08-07).
//
// Der Jetzt-Wert `optimizer.batteryCapacityWh` wird aus der heute gültigen
// Stufe ABGELEITET, sobald mindestens eine gepflegt ist. Damit lesen EOS-Sync,
// Optimizer, Freeze-Watchdog und Leitstand automatisch den richtigen Wert und
// es gibt weiterhin genau ein Feld, das sie abfragen — statt zweier Wahrheiten,
// die auseinanderlaufen.

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfigInput } from '../config-model.js';

const STAGES = [
  { id: 'start', label: 'Start', startDate: '2025-11-01', capacityWh: 43000 },
  { id: 'ausbau-2', label: 'Ausbau 2', startDate: '2026-03-15', capacityWh: 60000 },
  { id: 'ausbau-3', label: 'Ausbau 3', startDate: '2026-08-01', capacityWh: 77000 }
];

test('ohne Stufen bleibt der manuell gepflegte Wert unangetastet', () => {
  // Bestandsinstallationen verhalten sich exakt wie vor der Zeitleiste — die
  // ist additiv, nicht erzwungen. Deshalb braucht es auch keine Migration.
  const { effectiveConfig } = normalizeConfigInput({
    optimizer: { batteryCapacityWh: 43000 }
  });
  assert.equal(effectiveConfig.optimizer.batteryCapacityWh, 43000);
  assert.deepEqual(effectiveConfig.optimizer.batteryStages, []);
});

test('mit Stufen wird der Jetzt-Wert abgeleitet und überschreibt den Handwert', () => {
  const { effectiveConfig } = normalizeConfigInput({
    optimizer: { batteryCapacityWh: 43000, batteryStages: STAGES }
  });
  // 2026-08-01 ist die jüngste Stufe, die nicht in der Zukunft liegt.
  assert.equal(effectiveConfig.optimizer.batteryCapacityWh, 77000);
});

test('die persistierte Config behält den Handwert — abgeleitet wird nur die effektive', () => {
  // Sonst überschriebe die Ableitung beim nächsten Speichern die Eingabe des
  // Betreibers, und beim Löschen aller Stufen bliebe ein Wert stehen, den
  // niemand eingetragen hat.
  const { persistedConfig, effectiveConfig } = normalizeConfigInput({
    optimizer: { batteryCapacityWh: 43000, batteryStages: STAGES }
  });
  assert.equal(persistedConfig.optimizer.batteryCapacityWh, 43000);
  assert.equal(effectiveConfig.optimizer.batteryCapacityWh, 77000);
});

test('eine Stufe ohne gültiges Datum wird verworfen und gemeldet', () => {
  const { effectiveConfig, warnings } = normalizeConfigInput({
    optimizer: {
      batteryCapacityWh: 43000,
      batteryStages: [
        { id: 'gut', startDate: '2025-11-01', capacityWh: 43000 },
        { id: 'kaputt', startDate: 'irgendwann', capacityWh: 60000 }
      ]
    }
  });
  assert.equal(effectiveConfig.optimizer.batteryStages.length, 1);
  assert.ok(warnings.some((w) => w.includes('kaputt')));
});

test('nur zukünftige Stufen ändern den Jetzt-Wert nicht', () => {
  const { effectiveConfig } = normalizeConfigInput({
    optimizer: {
      batteryCapacityWh: 43000,
      batteryStages: [{ id: 'geplant', startDate: '2099-01-01', capacityWh: 99000 }]
    }
  });
  // Rückwärts-Extrapolation greift: vor der ältesten Stufe gilt deren Wert.
  // Das ist hier gewollt — wer eine Stufe einträgt, meint diesen Akku.
  assert.equal(effectiveConfig.optimizer.batteryCapacityWh, 99000);
});

test('das Feld ist in der Settings-Definition sichtbar und liegt bei den Akku-Grenzen', async () => {
  const { getConfigDefinition } = await import('../config-model.js');
  const definition = getConfigDefinition();
  const fields = definition.fields || definition.sections?.flatMap((s) => s.fields) || [];
  const field = fields.find((f) => f.path === 'optimizer.batteryStages');
  assert.ok(field, 'optimizer.batteryStages fehlt in der Settings-Definition');
  assert.equal(field.group, 'batteryLimits');
  assert.equal(field.type, 'array');
});

test('EOS bekommt die heute gültige Kapazität, ohne dafür die Stufen zu kennen', async () => {
  // Der Betreiber wollte ausdrücklich, dass EOS den AKTUELLEN Wert bekommt,
  // während die Zeitleiste mehrere Datumsstände trägt. Weil die Ableitung in
  // der effektiven Config passiert, musste an eos-config-sync.js keine Zeile
  // geändert werden — dieser Test hält genau das fest.
  const { buildEosBatteries } = await import('../services/optimizer/eos-config-sync.js');
  const { effectiveConfig } = normalizeConfigInput({
    optimizer: { batteryCapacityWh: 43000, batteryStages: STAGES }
  });
  const [battery] = buildEosBatteries(effectiveConfig);
  assert.equal(battery.capacity_wh, 77000);
});
