// Settings-UI der Akku-Ausbaustufen (Christin 2026-08-07).
//
// Die Oberfläche arbeitet in kWh (so denkt der Betreiber über Akkublöcke), die
// Config in Wh (so lesen es EOS und Optimizer). Diese Umrechnung ist die
// Stelle, an der so etwas erfahrungsgemäß kippt — deshalb wird hier der volle
// Rundlauf geprüft, nicht nur eine Richtung.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function loadBatteryStageHelpers() {
  const settingsPath = fileURLToPath(new URL('../public/settings.js', import.meta.url));
  const source = fs.readFileSync(settingsPath, 'utf8');
  const sandbox = {
    console,
    globalThis: {},
    window: {
      DVhubCommon: {
        escapeHtml: (v) => String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
      },
      addEventListener() {},
      setTimeout() {}
    }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: path.basename(settingsPath) });
  return sandbox.DVhubSettingsBatteryStages;
}

const {
  addBatteryStage,
  buildBatteryStagesEditorMarkup,
  createEmptyBatteryStage,
  currentBatteryStage,
  deserializeBatteryStages,
  removeBatteryStage,
  serializeBatteryStages,
  validateBatteryStages
} = loadBatteryStageHelpers();

// Die Helfer laufen in einem eigenen VM-Realm, ihre Objekte tragen also ein
// anderes Object.prototype. deepStrictEqual vergleicht Prototypen mit und
// scheitert an strukturgleichen Werten — deshalb über JSON in diesen Realm
// zurückholen (gleiches Vorgehen wie in settings-pv-plants.test.js).
const intoThisRealm = (value) => JSON.parse(JSON.stringify(value));

test('kWh aus der Eingabe werden zu Wh in der Config', () => {
  const [stage] = serializeBatteryStages([
    { id: 's1', label: 'Ausbau', startDate: '2026-08-01', capacityKwh: 77 }
  ]);
  assert.equal(stage.capacityWh, 77000);
  assert.equal(stage.startDate, '2026-08-01');
});

test('der Rundlauf Config → UI → Config verändert den Wert nicht', () => {
  // Ein Rundungsfehler hier würde die Kapazität bei jedem Öffnen und Speichern
  // der Einstellungen ein Stück verschieben.
  const original = [
    { id: 's1', label: 'Start', startDate: '2025-11-01', capacityWh: 43000 },
    { id: 's2', label: 'Ausbau 2', startDate: '2026-03-15', capacityWh: 60500 },
    { id: 's3', label: 'Ausbau 3', startDate: '2026-08-01', capacityWh: 77250 }
  ];
  assert.deepEqual(intoThisRealm(serializeBatteryStages(deserializeBatteryStages(original))), original);
});

test('eine leere Kapazität wird zu null, nicht zu 0', () => {
  // 0 wäre eine Aussage ("Akku ist leer"), null ist "noch nichts eingetragen".
  // Der Server-Sanitizer verwirft null; 0 würde er ebenfalls verwerfen, aber
  // die Validierung unten fängt den Fall vorher ab und sagt es dem Betreiber.
  const [stage] = serializeBatteryStages([
    { id: 's1', label: '', startDate: '2026-08-01', capacityKwh: '' }
  ]);
  assert.equal(stage.capacityWh, null);
});

test('Validierung blockiert eine Stufe ohne Datum', () => {
  const result = validateBatteryStages([
    { id: 's1', label: 'Ausbau', startDate: '', capacityKwh: 77 }
  ]);
  assert.equal(result.valid, false);
  assert.ok(result.messages[0].includes('Datum'));
});

test('Validierung blockiert eine Stufe ohne Kapazität', () => {
  const result = validateBatteryStages([
    { id: 's1', label: '', startDate: '2026-08-01', capacityKwh: '' }
  ]);
  assert.equal(result.valid, false);
  assert.ok(result.messages[0].includes('Kapazität'));
});

test('Validierung meldet zwei Stufen am selben Tag', () => {
  const result = validateBatteryStages([
    { id: 's1', label: 'A', startDate: '2026-08-01', capacityKwh: 60 },
    { id: 's2', label: 'B', startDate: '2026-08-01', capacityKwh: 77 }
  ]);
  assert.equal(result.valid, false);
  assert.ok(result.messages.some((m) => m.includes('2026-08-01')));
});

test('eine vollständige Stufenliste ist gültig, auch bei Rückbau', () => {
  const result = validateBatteryStages([
    { id: 's1', label: 'Start', startDate: '2025-11-01', capacityKwh: 60 },
    { id: 's2', label: 'Block raus', startDate: '2026-08-01', capacityKwh: 43 }
  ]);
  assert.equal(result.valid, true);
  assert.deepEqual(intoThisRealm(result.messages), []);
});

test('die UI-Vorschau der aktuell gültigen Stufe folgt derselben Regel wie der Server', () => {
  const stages = [
    { id: 's1', startDate: '2025-11-01', capacityKwh: 43 },
    { id: 's2', startDate: '2026-03-15', capacityKwh: 60 },
    { id: 's3', startDate: '2026-08-01', capacityKwh: 77 }
  ];
  assert.equal(currentBatteryStage(stages, '2026-03-14').capacityKwh, 43);
  assert.equal(currentBatteryStage(stages, '2026-03-15').capacityKwh, 60);
  assert.equal(currentBatteryStage(stages, '2026-08-07').capacityKwh, 77);
  // Vor der ältesten Stufe gilt deren Wert rückwärts — wie im Server-Resolver.
  assert.equal(currentBatteryStage(stages, '2025-01-01').capacityKwh, 43);
  assert.equal(currentBatteryStage([], '2026-08-07'), null);
});

test('Hinzufügen vergibt eindeutige Kennungen, Entfernen trifft nur die gemeinte Stufe', () => {
  let stages = addBatteryStage(addBatteryStage([]));
  assert.equal(new Set(stages.map((s) => s.id)).size, 2);
  stages = removeBatteryStage(stages, stages[0].id);
  assert.equal(stages.length, 1);
});

test('die leere Stufe startet ohne vorbelegtes Datum', () => {
  // Ein vorbelegtes "heute" wäre geraten und würde als echte Angabe
  // durchgehen — bei einer Kapazitätsgrenze ist das teuer.
  const stage = createEmptyBatteryStage(0);
  assert.equal(stage.startDate, '');
  assert.equal(stage.capacityKwh, '');
});

test('das Markup zeigt die aktuell gültige Stufe und entwertet Eingaben', () => {
  const html = buildBatteryStagesEditorMarkup({
    stages: [{ id: 's1', label: '<script>x</script>', startDate: '2026-08-01', capacityKwh: 77 }],
    today: '2026-08-07'
  });
  assert.ok(html.includes('77 kWh (seit 2026-08-01)'));
  assert.ok(!html.includes('<script>'));
});

test('ohne Stufen sagt das Markup, dass der Einzelwert gilt', () => {
  const html = buildBatteryStagesEditorMarkup({ stages: [], today: '2026-08-07' });
  assert.ok(html.includes('keine Stufen'));
});
