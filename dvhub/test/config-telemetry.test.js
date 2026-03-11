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
  assert.equal(defaults.userEnergyPricing.marketValueMode, 'annual');
  assert.deepEqual(defaults.userEnergyPricing.periods, []);
  assert.deepEqual(defaults.userEnergyPricing.pvPlants, []);
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
  assert.ok(fieldPaths.includes('userEnergyPricing.periods'));
  assert.ok(fieldPaths.includes('userEnergyPricing.marketValueMode'));
  assert.ok(fieldPaths.includes('userEnergyPricing.pvPlants'));
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

test('normalizeConfigInput preserves monthly market value mode', () => {
  const normalized = normalizeConfigInput({
    userEnergyPricing: {
      marketValueMode: 'monthly'
    }
  });

  assert.equal(normalized.rawConfig.userEnergyPricing.marketValueMode, 'monthly');
  assert.equal(normalized.persistedConfig.userEnergyPricing.marketValueMode, 'monthly');
});

test('normalizeConfigInput falls back to annual market value mode for invalid values', () => {
  const normalized = normalizeConfigInput({
    userEnergyPricing: {
      marketValueMode: 'invalid'
    }
  });

  assert.equal(normalized.rawConfig.userEnergyPricing.marketValueMode, undefined);
  assert.equal(normalized.persistedConfig.userEnergyPricing.marketValueMode, 'annual');
});

test('normalizeConfigInput preserves multiple pv plants for premium lookup metadata', () => {
  const normalized = normalizeConfigInput({
    userEnergyPricing: {
      pvPlants: [
        {
          kwp: '9.8',
          commissionedAt: '2021-04-15'
        },
        {
          kwp: '4.2',
          commissionedAt: '2023-09-01'
        }
      ]
    }
  });

  assert.deepEqual(normalized.rawConfig.userEnergyPricing.pvPlants, [
    {
      kwp: 9.8,
      commissionedAt: '2021-04-15'
    },
    {
      kwp: 4.2,
      commissionedAt: '2023-09-01'
    }
  ]);
  assert.deepEqual(normalized.persistedConfig.userEnergyPricing.pvPlants, [
    {
      kwp: 9.8,
      commissionedAt: '2021-04-15'
    },
    {
      kwp: 4.2,
      commissionedAt: '2023-09-01'
    }
  ]);
});

test('dated pricing periods accept non-overlapping date ranges', () => {
  const normalized = normalizeConfigInput({
    userEnergyPricing: {
      periods: [
        {
          id: 'winter-fixed',
          label: 'Winter',
          startDate: '2026-01-01',
          endDate: '2026-03-31',
          mode: 'fixed',
          fixedGrossImportCtKwh: '31.5'
        },
        {
          id: 'summer-dynamic',
          label: 'Sommer',
          startDate: '2026-04-01',
          endDate: '2026-12-31',
          mode: 'dynamic',
          dynamicComponents: {
            energyMarkupCtKwh: '0',
            gridChargesCtKwh: '8.5',
            leviesAndFeesCtKwh: '3',
            vatPct: '19'
          }
        }
      ]
    }
  });

  assert.equal(normalized.warnings.length, 0);
  assert.equal(normalized.persistedConfig.userEnergyPricing.periods.length, 2);
  assert.deepEqual(normalized.persistedConfig.userEnergyPricing.periods.map((period) => period.id), [
    'winter-fixed',
    'summer-dynamic'
  ]);
  assert.equal(normalized.persistedConfig.userEnergyPricing.periods[0].fixedGrossImportCtKwh, 31.5);
  assert.equal(normalized.persistedConfig.userEnergyPricing.periods[1].dynamicComponents.gridChargesCtKwh, 8.5);
});

test('dated pricing periods reject overlapping date ranges', () => {
  const normalized = normalizeConfigInput({
    userEnergyPricing: {
      periods: [
        {
          id: 'winter-fixed',
          startDate: '2026-01-01',
          endDate: '2026-03-31',
          mode: 'fixed',
          fixedGrossImportCtKwh: 31.5
        },
        {
          id: 'overlap-fixed',
          startDate: '2026-03-15',
          endDate: '2026-04-15',
          mode: 'fixed',
          fixedGrossImportCtKwh: 32.1
        }
      ]
    }
  });

  assert.match(normalized.warnings.join('\n'), /overlap/i);
  assert.deepEqual(
    normalized.persistedConfig.userEnergyPricing.periods.map((period) => period.id),
    ['winter-fixed']
  );
});

test('normalizeConfigInput strips legacy schedule rule fields', () => {
  const normalized = normalizeConfigInput({
    schedule: {
      rules: [
        {
          id: 'legacy',
          enabled: true,
          target: 'gridSetpointW',
          start: '08:00',
          end: '09:00',
          value: '-40',
          days: [1, 2, 3],
          oneTime: true
        }
      ]
    }
  });

  assert.deepEqual(normalized.rawConfig.schedule.rules, [
    {
      id: 'legacy',
      enabled: true,
      target: 'gridSetpointW',
      start: '08:00',
      end: '09:00',
      value: -40
    }
  ]);
});
