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
  assert.equal(defaults.userEnergyPricing.mode, 'fixed');
  assert.equal(defaults.userEnergyPricing.fixedGrossImportCtKwh, null);
  assert.equal(defaults.userEnergyPricing.dynamicComponents.vatPct, 19);
  assert.equal(defaults.userEnergyPricing.usesParagraph14aModule3, false);
  assert.equal(defaults.userEnergyPricing.module3Windows.window1.enabled, false);
  assert.equal(defaults.userEnergyPricing.module3Windows.window1.priceCtKwh, null);
  assert.equal(defaults.userEnergyPricing.costs.pvCtKwh, null);
  assert.equal(defaults.userEnergyPricing.costs.batteryBaseCtKwh, null);
  assert.equal(defaults.userEnergyPricing.costs.batteryLossMarkupPct, 20);
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
  assert.ok(fieldPaths.includes('userEnergyPricing.mode'));
  assert.ok(fieldPaths.includes('userEnergyPricing.fixedGrossImportCtKwh'));
  assert.ok(fieldPaths.includes('userEnergyPricing.dynamicComponents.gridChargesCtKwh'));
  assert.ok(fieldPaths.includes('userEnergyPricing.module3Windows.window1.priceCtKwh'));
  assert.ok(fieldPaths.includes('userEnergyPricing.costs.pvCtKwh'));
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

test('normalizeConfigInput coerces user energy pricing booleans and numbers', () => {
  const normalized = normalizeConfigInput({
    userEnergyPricing: {
      mode: 'dynamic',
      fixedGrossImportCtKwh: '31.2',
      usesParagraph14aModule3: 'true',
      dynamicComponents: {
        energyMarkupCtKwh: '2.5',
        gridChargesCtKwh: '8.75',
        leviesAndFeesCtKwh: '3.3',
        vatPct: '19'
      },
      module3Windows: {
        window1: {
          enabled: 'true',
          start: '14:00',
          end: '16:00',
          priceCtKwh: '21.9'
        }
      },
      costs: {
        pvCtKwh: '7.1',
        batteryBaseCtKwh: '2.2',
        batteryLossMarkupPct: '20'
      }
    }
  });

  assert.equal(normalized.rawConfig.userEnergyPricing.mode, 'dynamic');
  assert.equal(normalized.rawConfig.userEnergyPricing.fixedGrossImportCtKwh, 31.2);
  assert.equal(normalized.rawConfig.userEnergyPricing.usesParagraph14aModule3, true);
  assert.equal(normalized.rawConfig.userEnergyPricing.dynamicComponents.energyMarkupCtKwh, 2.5);
  assert.equal(normalized.rawConfig.userEnergyPricing.dynamicComponents.gridChargesCtKwh, 8.75);
  assert.equal(normalized.rawConfig.userEnergyPricing.dynamicComponents.leviesAndFeesCtKwh, 3.3);
  assert.equal(normalized.rawConfig.userEnergyPricing.dynamicComponents.vatPct, 19);
  assert.equal(normalized.rawConfig.userEnergyPricing.module3Windows.window1.enabled, true);
  assert.equal(normalized.rawConfig.userEnergyPricing.module3Windows.window1.priceCtKwh, 21.9);
  assert.equal(normalized.rawConfig.userEnergyPricing.costs.pvCtKwh, 7.1);
  assert.equal(normalized.rawConfig.userEnergyPricing.costs.batteryBaseCtKwh, 2.2);
  assert.equal(normalized.rawConfig.userEnergyPricing.costs.batteryLossMarkupPct, 20);
});
