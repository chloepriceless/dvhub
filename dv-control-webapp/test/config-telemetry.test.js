import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultConfig, getConfigDefinition, normalizeConfigInput } from '../config-model.js';

test('default config enables internal telemetry persistence with rollups', () => {
  const defaults = createDefaultConfig();

  assert.equal(defaults.telemetry.enabled, true);
  assert.equal(defaults.telemetry.dbPath, '');
  assert.equal(defaults.telemetry.rawRetentionDays, 45);
  assert.deepEqual(Array.from(defaults.telemetry.rollupIntervals), [300, 900, 3600]);
  assert.equal(defaults.telemetry.historyImport.enabled, false);
  assert.equal(defaults.telemetry.historyImport.provider, 'vrm');
  assert.equal(defaults.telemetry.historyImport.vrmPortalId, '');
  assert.equal(defaults.telemetry.historyImport.vrmToken, '');
});

test('config definition exposes telemetry section and fields', () => {
  const definition = getConfigDefinition();
  const sectionIds = definition.sections.map((section) => section.id);
  const fieldPaths = definition.fields.map((field) => field.path).filter(Boolean);

  assert.ok(sectionIds.includes('telemetry'));
  assert.ok(fieldPaths.includes('telemetry.enabled'));
  assert.ok(fieldPaths.includes('telemetry.dbPath'));
  assert.ok(fieldPaths.includes('telemetry.rawRetentionDays'));
  assert.ok(fieldPaths.includes('telemetry.historyImport.enabled'));
  assert.ok(fieldPaths.includes('telemetry.historyImport.provider'));
  assert.ok(!fieldPaths.includes('telemetry.historyImport.gxPath'));
});

test('normalizeConfigInput coerces telemetry booleans and numbers', () => {
  const normalized = normalizeConfigInput({
    telemetry: {
      enabled: 'false',
      rawRetentionDays: '90',
      historyImport: {
      enabled: 'true',
      provider: 'gx'
      }
    }
  });

  assert.equal(normalized.rawConfig.telemetry.enabled, false);
  assert.equal(normalized.rawConfig.telemetry.rawRetentionDays, 90);
  assert.equal(normalized.rawConfig.telemetry.historyImport.enabled, true);
  assert.equal(normalized.persistedConfig.telemetry.historyImport.provider, 'vrm');
});
