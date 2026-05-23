// test/eos-config-sync.test.js — Phase 22 (2026-05-24).
//
// Verifies the DVhub→EOS config-builder functions for grid-arbitrage gating,
// dynamic-pricing pass-through, and slot-resolution selection. These three
// concerns are the new surface area that Phase 22 added on top of the
// hardware-spec sync introduced in Phase 21.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  buildEosBatteries,
  buildEosInverters,
  buildEosElecprice,
  buildEosOptimization,
} from '../services/optimizer/eos-config-sync.js';

const STD_CFG = {
  optimizer: {
    batteryCapacityWh: 43000,
    maxChargeW: 18000,
    roundTripEfficiency: 0.92,
    minSocPct: 5,
    maxSocPct: 100,
  },
};

test('buildEosBatteries: charge_rates = [1.0] when allowGridCharge=false (default)', () => {
  const bat = buildEosBatteries(STD_CFG)[0];
  assert.deepEqual(bat.charge_rates, [1.0]);
  assert.equal(bat.capacity_wh, 43000);
  assert.equal(bat.max_charge_power_w, 18000);
});

test('buildEosBatteries: charge_rates = [1.0] when allowGridCharge=true but no MisPel', () => {
  const cfg = { ...STD_CFG, optimizer: { ...STD_CFG.optimizer, allowGridCharge: true } };
  const bat = buildEosBatteries(cfg)[0];
  // Without MisPel pauschal/abgrenzung, grid arbitrage is §14a-illegal — gate blocks.
  assert.deepEqual(bat.charge_rates, [1.0]);
});

test('buildEosBatteries: full 11-step charge_rates when allowGridCharge=true AND mispel.mode=pauschal', () => {
  const cfg = {
    ...STD_CFG,
    optimizer: {
      ...STD_CFG.optimizer,
      allowGridCharge: true,
      mispel: { mode: 'pauschal' },
    },
  };
  const bat = buildEosBatteries(cfg)[0];
  assert.equal(bat.charge_rates.length, 11);
  assert.deepEqual(bat.charge_rates, [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]);
});

test('buildEosBatteries: full charge_rates also for mispel.mode=abgrenzung', () => {
  const cfg = {
    ...STD_CFG,
    optimizer: {
      ...STD_CFG.optimizer,
      allowGridCharge: true,
      mispel: { mode: 'abgrenzung' },
    },
  };
  const bat = buildEosBatteries(cfg)[0];
  assert.equal(bat.charge_rates.length, 11);
});

test('buildEosElecprice: null when pricing.mode is not "dynamic"', () => {
  assert.equal(buildEosElecprice({}), null);
  assert.equal(buildEosElecprice({ userEnergyPricing: { mode: 'fixed' } }), null);
});

test('buildEosElecprice: null when dynamic but all components are 0/missing', () => {
  const cfg = { userEnergyPricing: { mode: 'dynamic', dynamicComponents: {} } };
  assert.equal(buildEosElecprice(cfg), null);
});

test('buildEosElecprice: sums energy markup + grid charges + levies into charges_kwh (€/kWh)', () => {
  const cfg = {
    userEnergyPricing: {
      mode: 'dynamic',
      dynamicComponents: {
        energyMarkupCtKwh: 2.5,
        gridChargesCtKwh: 8.2,
        leviesAndFeesCtKwh: 4.3,
        vatPct: 19,
      },
    },
  };
  const result = buildEosElecprice(cfg);
  // (2.5 + 8.2 + 4.3) ct = 15.0 ct → 0.15 €/kWh
  assert.equal(result.charges_kwh, 0.15);
  assert.equal(result.vat_rate, 1.19);
});

test('buildEosElecprice: defaults vat_rate to 1.19 when vatPct is missing', () => {
  const cfg = {
    userEnergyPricing: {
      mode: 'dynamic',
      dynamicComponents: { gridChargesCtKwh: 10 },
    },
  };
  assert.equal(buildEosElecprice(cfg).vat_rate, 1.19);
});

test('buildEosOptimization: defaults to interval=3600 when unset', () => {
  assert.deepEqual(buildEosOptimization({}), { interval: 3600 });
});

test('buildEosOptimization: accepts 900 / 1800 / 3600 as valid intervals', () => {
  for (const i of [900, 1800, 3600]) {
    const cfg = { optimizer: { eosOptimizationIntervalSec: i } };
    assert.equal(buildEosOptimization(cfg).interval, i, `interval ${i} should pass through`);
  }
});

test('buildEosOptimization: rejects invalid intervals and falls back to 3600', () => {
  for (const bad of [60, 300, 7200, null, 'fifteen']) {
    const cfg = { optimizer: { eosOptimizationIntervalSec: bad } };
    assert.equal(buildEosOptimization(cfg).interval, 3600, `interval ${bad} should clamp to 3600`);
  }
});

test('buildEosInverters: passes max_ac_charge_power_w from optimizer.maxChargeW', () => {
  const inv = buildEosInverters(STD_CFG)[0];
  assert.equal(inv.max_ac_charge_power_w, 18000);
  assert.equal(inv.battery_id, 'battery1');
});
