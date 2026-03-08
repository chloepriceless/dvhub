import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

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
  sections: [
    { id: 'system', label: 'System', description: 'Basisoptionen' },
    { id: 'victron', label: 'Victron', description: 'Verbindung' },
    { id: 'unused', label: 'Leer', description: 'Soll nicht erscheinen' }
  ],
  fields: [
    { section: 'system', path: 'httpPort' },
    { section: 'system', path: 'modbusListenPort', group: 'network' },
    { section: 'victron', path: 'victron.transport' }
  ]
};

test('buildSettingsDestinations starts with overview and only includes sections with fields', () => {
  const destinations = buildSettingsDestinations(sampleDefinition);

  assert.equal(destinations[0].id, SETTINGS_OVERVIEW_ID);
  assert.deepEqual(
    Array.from(destinations, (destination) => destination.id),
    [SETTINGS_OVERVIEW_ID, 'system', 'victron']
  );
  assert.equal(destinations[1].fieldCount, 2);
  assert.equal(destinations[1].groupCount, 2);
});

test('createSettingsShellState defaults fresh entry to overview', () => {
  const state = createSettingsShellState(sampleDefinition);

  assert.equal(state.activeSectionId, SETTINGS_OVERVIEW_ID);
  assert.equal(state.destinations.length, 3);
});

test('setActiveSettingsSection accepts known sections and falls back to overview for unknown ids', () => {
  const initialState = createSettingsShellState(sampleDefinition);
  const activeState = setActiveSettingsSection(initialState, 'victron');
  const fallbackState = setActiveSettingsSection(activeState, 'missing');

  assert.equal(activeState.activeSectionId, 'victron');
  assert.equal(fallbackState.activeSectionId, SETTINGS_OVERVIEW_ID);
});
