/**
 * Tariff Engine Service Tests
 *
 * Tests multi-mode tariff price resolution including fixed, dynamic,
 * period overrides, and Paragraph 14a Module 3 time-variable network charges.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTariffEngine } from '../modules/optimizer/services/tariff-engine.js';

// Base config matching config.example.json userEnergyPricing
const baseConfig = {
  mode: 'fixed',
  fixedGrossImportCtKwh: 31.5,
  periods: [
    {
      id: 'winter-2026',
      label: 'Fixpreis Winter',
      startDate: '2026-01-01',
      endDate: '2026-04-30',
      mode: 'fixed',
      fixedGrossImportCtKwh: 29.5,
    },
    {
      id: 'summer-2026',
      label: 'Dynamisch Sommer',
      startDate: '2026-05-01',
      endDate: '2026-12-31',
      mode: 'dynamic',
      dynamicComponents: {
        energyMarkupCtKwh: 0,
        gridChargesCtKwh: 8.5,
        leviesAndFeesCtKwh: 3,
        vatPct: 19,
      },
    },
  ],
  dynamicComponents: {
    energyMarkupCtKwh: 2.5,
    gridChargesCtKwh: 8.5,
    leviesAndFeesCtKwh: 3,
    vatPct: 19,
  },
  usesParagraph14aModule3: false,
  module3Windows: {
    window1: { enabled: false, label: '', start: '', end: '', priceCtKwh: null },
    window2: { enabled: false, label: '', start: '', end: '', priceCtKwh: null },
    window3: { enabled: false, label: '', start: '', end: '', priceCtKwh: null },
  },
};

// Config with Module 3 enabled
const module3Config = {
  ...baseConfig,
  usesParagraph14aModule3: true,
  module3Windows: {
    window1: { enabled: true, label: 'HT', start: '08:00', end: '20:00', priceCtKwh: 9.5 },
    window2: { enabled: true, label: 'NT', start: '20:00', end: '23:00', priceCtKwh: 6.0 },
    window3: { enabled: true, label: 'ST', start: '23:00', end: '08:00', priceCtKwh: 3.5 },
  },
};

// Dynamic-only config
const dynamicConfig = {
  mode: 'dynamic',
  fixedGrossImportCtKwh: null,
  periods: [],
  dynamicComponents: {
    energyMarkupCtKwh: 2.5,
    gridChargesCtKwh: 8.5,
    leviesAndFeesCtKwh: 3,
    vatPct: 19,
  },
  usesParagraph14aModule3: false,
  module3Windows: {},
};

describe('Tariff Engine Service', () => {
  it('Test 1: createTariffEngine returns object with resolvePrice, resolveNetworkCharge, computeTotalImportCost', () => {
    const engine = createTariffEngine({ config: baseConfig });
    assert.equal(typeof engine.resolvePrice, 'function');
    assert.equal(typeof engine.resolveNetworkCharge, 'function');
    assert.equal(typeof engine.computeTotalImportCost, 'function');
  });

  it('Test 2: resolvePrice in fixed mode returns grossCtKwh from config.fixedGrossImportCtKwh', () => {
    // Timestamp outside any period (e.g., Dec 2025 -- before winter-2026 starts)
    const engine = createTariffEngine({ config: baseConfig });
    const result = engine.resolvePrice(new Date('2025-12-15T12:00:00+01:00'));
    assert.equal(result.grossCtKwh, 31.5);
    assert.equal(result.needsSpotPrice, undefined);
  });

  it('Test 3: resolvePrice with active period override returns period fixedGrossImportCtKwh', () => {
    const engine = createTariffEngine({ config: baseConfig });
    // Jan 15, 2026 falls within winter-2026 period
    const result = engine.resolvePrice(new Date('2026-01-15T10:00:00+01:00'));
    assert.equal(result.grossCtKwh, 29.5);
  });

  it('Test 4: resolvePrice in dynamic mode returns components and needsSpotPrice: true', () => {
    const engine = createTariffEngine({ config: dynamicConfig });
    const result = engine.resolvePrice(new Date('2026-06-15T12:00:00+02:00'));
    assert.equal(result.needsSpotPrice, true);
    assert.ok(result.components);
    assert.equal(result.components.energyMarkupCtKwh, 2.5);
  });

  it('Test 5: resolveNetworkCharge without Module 3 returns gridChargesCtKwh', () => {
    const engine = createTariffEngine({ config: baseConfig });
    const result = engine.resolveNetworkCharge(new Date('2026-01-15T10:00:00+01:00'));
    assert.equal(result.networkChargeCtKwh, 8.5);
  });

  it('Test 6: resolveNetworkCharge with Module 3 resolves HT window (10:00)', () => {
    const engine = createTariffEngine({ config: module3Config });
    // 10:00 Berlin time -> HT window (08:00-20:00)
    const result = engine.resolveNetworkCharge(new Date('2026-01-15T10:00:00+01:00'));
    assert.equal(result.networkChargeCtKwh, 9.5);
    assert.equal(result.windowLabel, 'HT');
  });

  it('Test 7: resolveNetworkCharge with Module 3 resolves NT window (21:00)', () => {
    const engine = createTariffEngine({ config: module3Config });
    // 21:00 Berlin time -> NT window (20:00-23:00)
    const result = engine.resolveNetworkCharge(new Date('2026-01-15T21:00:00+01:00'));
    assert.equal(result.networkChargeCtKwh, 6.0);
    assert.equal(result.windowLabel, 'NT');
  });

  it('Test 8: resolveNetworkCharge with Module 3 resolves ST window (02:00)', () => {
    const engine = createTariffEngine({ config: module3Config });
    // 02:00 Berlin time -> ST window (23:00-08:00, overnight)
    const result = engine.resolveNetworkCharge(new Date('2026-01-15T02:00:00+01:00'));
    assert.equal(result.networkChargeCtKwh, 3.5);
    assert.equal(result.windowLabel, 'ST');
  });

  it('Test 9: computeTotalImportCost calculates (spot + markup + gridCharge + levies) * (1 + VAT/100)', () => {
    const engine = createTariffEngine({ config: baseConfig });
    const result = engine.computeTotalImportCost({
      spotPriceCtKwh: 5.0,
      components: {
        energyMarkupCtKwh: 2.5,
        gridChargesCtKwh: 8.5,
        leviesAndFeesCtKwh: 3,
        vatPct: 19,
      },
    });
    // net = 5.0 + 2.5 + 8.5 + 3.0 = 19.0
    // gross = 19.0 * 1.19 = 22.61
    assert.equal(result.netCtKwh, 19.0);
    assert.ok(Math.abs(result.grossCtKwh - 22.61) < 0.001, `Expected ~22.61, got ${result.grossCtKwh}`);
  });

  it('Test 10: findActivePeriod returns null when no period matches the timestamp', () => {
    const engine = createTariffEngine({ config: baseConfig });
    // Dec 2025 is before any period
    const result = engine.resolvePrice(new Date('2025-12-15T12:00:00+01:00'));
    // Falls back to base fixedGrossImportCtKwh (31.5), not any period price
    assert.equal(result.grossCtKwh, 31.5);
  });

  it('Test 11: findActiveModule3Window matches by HH:MM in Europe/Berlin timezone', () => {
    const engine = createTariffEngine({ config: module3Config });
    // Use a summer timestamp where UTC and Berlin differ by 2h
    // 2026-07-15T08:30:00+02:00 = 06:30 UTC = 08:30 Berlin -> HT (08:00-20:00)
    const result = engine.resolveNetworkCharge(new Date('2026-07-15T08:30:00+02:00'));
    assert.equal(result.networkChargeCtKwh, 9.5);
    assert.equal(result.windowLabel, 'HT');

    // 2026-07-15T07:30:00+02:00 = 05:30 UTC = 07:30 Berlin -> ST (23:00-08:00)
    const result2 = engine.resolveNetworkCharge(new Date('2026-07-15T07:30:00+02:00'));
    assert.equal(result2.networkChargeCtKwh, 3.5);
    assert.equal(result2.windowLabel, 'ST');
  });
});
