import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { getConfigDefinition } from '../config-model.js';

function loadShellHelpers() {
  const source = fs.readFileSync(path.resolve('dv-control-webapp/public/settings.js'), 'utf8');
  const sandbox = {
    console,
    globalThis: {},
    window: {
      PlexLiteCommon: {},
      addEventListener() {},
      setTimeout() {}
    }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'settings.js' });
  return sandbox.PlexLiteSettingsShell;
}

const {
  SETTINGS_OVERVIEW_ID,
  buildSettingsDestinations,
  createSettingsShellState,
  setActiveSettingsSection
} = loadShellHelpers();

const sampleDefinition = {
  destinations: [
    { id: 'basics', label: 'Grundsystem', description: 'Basis fuer PlexLite', intro: 'Grundlagen zuerst.' },
    { id: 'connection', label: 'Verbindung zur Anlage', description: 'GX und Zaehler anbinden', intro: 'Verbindungen konfigurieren.' }
  ],
  sections: [
    { id: 'system', label: 'System', description: 'Basisoptionen', destination: 'basics' },
    { id: 'victron', label: 'Victron Verbindung', description: 'GX-Verbindung', destination: 'connection' },
    { id: 'meter', label: 'Netzzaehler', description: 'Messwerte', destination: 'connection' },
    { id: 'unused', label: 'Leer', description: 'Soll nicht erscheinen', destination: 'basics' }
  ],
  fields: [
    { section: 'system', path: 'httpPort' },
    { section: 'system', path: 'modbusListenPort', group: 'network' },
    { section: 'victron', path: 'victron.transport' },
    { section: 'meter', path: 'meter.host', group: 'meter' }
  ]
};

test('buildSettingsDestinations groups legacy sections under destination metadata', () => {
  const destinations = buildSettingsDestinations(sampleDefinition);

  assert.equal(destinations[0].id, SETTINGS_OVERVIEW_ID);
  assert.deepEqual(
    Array.from(destinations, (destination) => destination.id),
    [SETTINGS_OVERVIEW_ID, 'basics', 'connection']
  );
  assert.equal(destinations[1].label, 'Grundsystem');
  assert.equal(destinations[2].label, 'Verbindung zur Anlage');
  assert.deepEqual(Array.from(destinations[2].sectionIds), ['victron', 'meter']);
  assert.equal(destinations[2].fieldCount, 2);
  assert.equal(destinations[1].label, sampleDefinition.destinations[0].label);
  assert.notEqual(destinations[2].label, sampleDefinition.sections[1].label);
});

test('createSettingsShellState defaults fresh entry to overview', () => {
  const state = createSettingsShellState(sampleDefinition);

  assert.equal(state.activeSectionId, SETTINGS_OVERVIEW_ID);
  assert.equal(state.destinations.length, 3);
});

test('setActiveSettingsSection accepts known destinations and falls back to overview for unknown ids', () => {
  const initialState = createSettingsShellState(sampleDefinition);
  const activeState = setActiveSettingsSection(initialState, 'connection');
  const fallbackState = setActiveSettingsSection(activeState, 'missing');

  assert.equal(activeState.activeSectionId, 'connection');
  assert.equal(fallbackState.activeSectionId, SETTINGS_OVERVIEW_ID);
});

test('real config definition keeps navigation compact and maps every section with fields', () => {
  const definition = getConfigDefinition();
  const destinations = buildSettingsDestinations(definition);
  const visibleDestinations = destinations.filter((destination) => destination.kind !== 'overview');
  const coveredSectionIds = new Set(visibleDestinations.flatMap((destination) => destination.sectionIds || []));
  const sectionIdsWithFields = Array.from(new Set(definition.fields.map((field) => field.section))).sort();

  assert.ok(visibleDestinations.length >= 5 && visibleDestinations.length <= 6);
  assert.deepEqual(Array.from(coveredSectionIds).sort(), sectionIdsWithFields);
});

test('real config definition exposes friendly grouped labels instead of the raw technical taxonomy', () => {
  const definition = getConfigDefinition();
  const visibleLabels = buildSettingsDestinations(definition)
    .filter((destination) => destination.kind !== 'overview')
    .map((destination) => destination.label);

  assert.ok(visibleLabels.includes('Verbindung zur Anlage'));
  assert.ok(visibleLabels.includes('Erweitert'));
  assert.ok(!visibleLabels.includes('Victron Verbindung'));
  assert.ok(!visibleLabels.includes('Netzzaehler'));
});
