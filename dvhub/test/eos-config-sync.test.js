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
  buildEosElectricVehicles,
  pickGeneticSizing,
  pickEmsIntervalSec,
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

test('buildEosInverters: max_ac_charge_power_w HARD-DISABLED to 0 when grid-arbitrage NOT licensed (§14a)', () => {
  // T-0080: STD_CFG carries maxChargeW=18000 but no allowGridCharge/mispel, so AC
  // grid→battery charging is §14a-illegal for a vanilla self-consumption operator.
  // buildEosInverters must report 0 (a886317 hard-disable) so EOS' genetic can
  // never pencil in a grid→battery transfer. This was a FALSE-NEGATIVE: the old
  // assertion expected 18000, so a regression that re-enabled illegal grid-charge
  // (dropping the gridChargeAllowed gate) would have passed unnoticed.
  const inv = buildEosInverters(STD_CFG)[0];
  assert.equal(inv.max_ac_charge_power_w, 0);
  assert.equal(inv.battery_id, 'battery1');
});

test('buildEosInverters: max_ac_charge_power_w = maxChargeW when grid-arbitrage IS licensed', () => {
  // Positive case: explicit allowGridCharge + a MisPel mode = the operator is
  // licensed for grid arbitrage → the 18000 W AC-charge cap passes through.
  const cfg = { optimizer: { ...STD_CFG.optimizer, allowGridCharge: true, mispel: { mode: 'pauschal' } } };
  assert.equal(buildEosInverters(cfg)[0].max_ac_charge_power_w, 18000);
});

test('buildEosInverters: max_power_w = inverterMaxPowerW (AC grid-connection cap) when set', () => {
  const cfg = { optimizer: { ...STD_CFG.optimizer, inverterMaxPowerW: 29000, mispel: { pvKwp: 29.7 } } };
  assert.equal(buildEosInverters(cfg)[0].max_power_w, 29000);
});

test('buildEosInverters: max_power_w falls back to pvKwp×1000 when inverterMaxPowerW unset', () => {
  const cfg = { optimizer: { ...STD_CFG.optimizer, mispel: { pvKwp: 29.7 } } };
  assert.equal(buildEosInverters(cfg)[0].max_power_w, 29700);
});

test('buildEosBatteries: max_charge_power_w prefers maxDischargeW (AC discharge cap) over maxChargeW', () => {
  const cfg = { optimizer: { ...STD_CFG.optimizer, maxChargeW: 18000, maxDischargeW: 16000 } };
  // EOS uses one power cap for both directions; the battery→grid export must
  // honour the AC discharge limit, so maxDischargeW wins.
  assert.equal(buildEosBatteries(cfg)[0].max_charge_power_w, 16000);
});

test('pickGeneticSizing: full upstream sizing at all resolutions', () => {
  // Operator preference: full-quality plan + slower EMS-tick beats a degraded
  // plan with a faster tick at sub-hourly slot resolutions. ems.interval
  // scales out so the genetic loop never overlaps with the next tick.
  assert.deepEqual(pickGeneticSizing(3600), { generations: 400, individuals: 300 });
  assert.deepEqual(pickGeneticSizing(1800), { generations: 400, individuals: 300 });
  assert.deepEqual(pickGeneticSizing(900),  { generations: 400, individuals: 300 });
  assert.deepEqual(pickGeneticSizing(7200), { generations: 400, individuals: 300 });
});

test('pickEmsIntervalSec: stretches at finer slot resolutions', () => {
  // hourly: stay at EOS upstream default 300s
  assert.equal(pickEmsIntervalSec(3600), 300);
  // 30-min: 1800s tick
  assert.equal(pickEmsIntervalSec(1800), 1800);
  // 15-min: stretch to 3600s — one high-quality run per hour
  assert.equal(pickEmsIntervalSec(900), 3600);
  // unknown interval: hourly default
  assert.equal(pickEmsIntervalSec(7200), 300);
});

test('buildEosElectricVehicles returns one ev11 with config overrides', () => {
  const def = buildEosElectricVehicles({});
  assert.equal(def.length, 1);
  assert.equal(def[0].device_id, 'ev11');
  assert.equal(def[0].capacity_wh, 50000);
  assert.equal(def[0].min_soc_percentage, 70);
  assert.equal(def[0].charge_rates.length, 11);

  const over = buildEosElectricVehicles({ optimizer: { evCapacityWh: 75000, evMaxChargeW: 11000, evMinSocPct: 50 } });
  assert.equal(over[0].capacity_wh, 75000);
  assert.equal(over[0].max_charge_power_w, 11000);
  assert.equal(over[0].min_soc_percentage, 50);
});
