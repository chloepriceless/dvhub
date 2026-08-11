import test from 'node:test';
import assert from 'node:assert/strict';
import { getPowerLimits, POWER_LIMIT_DEFAULTS } from '../services/power-limits.js';

// A realistic prod-like config: NO system.power block yet (mid-migration), all
// legacy keys set. The resolver MUST return exactly the legacy values each
// consumer reads today (behavior-preserving golden test).
const PROD_LIKE = {
  optimizer: {
    batteryCapacityWh: 43000,
    maxDischargeW: 20000,        // positive (optimizer convention)
    maxChargeW: 18000,
    inverterMaxPowerW: 24000,
    roundTripEfficiency: 0.90,   // fraction (EOS convention)
    hardFloorSocPct: 5,
    maxSocPct: 100,
  },
  schedule: {
    defaultChargeCurrentA: 350,
    smallMarketAutomation: {
      batteryCapacityKwh: 43,    // kWh (SMA convention)
      maxDischargeW: -12000,     // NEGATIVE (SMA convention)
      inverterEfficiencyPct: 85,
    },
  },
};

test('golden: legacy fallback returns each consumer\'s current value', () => {
  const { limits, sources } = getPowerLimits(PROD_LIKE);
  assert.equal(limits.batteryCapacityWh, 43000);
  assert.equal(limits.batteryNominalVoltageV, 55.2);   // default (no legacy source)
  assert.equal(limits.batteryMaxDischargeDcW, 20000);
  assert.equal(limits.batteryMaxChargeW, 18000);
  assert.equal(limits.batteryMaxChargeCurrentA, 350);  // legacy: schedule.defaultChargeCurrentA
  assert.equal(limits.inverterMaxPowerW, 24000);
  assert.equal(limits.roundTripEfficiencyPct, 90);
  assert.equal(limits.roundTripEfficiencyFraction, 0.9);
  assert.equal(limits.inverterEfficiencyPct, 85);
  assert.equal(limits.hardFloorSocPct, 5);
  assert.equal(limits.maxSocPct, 100);
  // derived
  assert.equal(limits.batteryCapacityKwh, 43);
  assert.equal(limits.batteryMaxChargeCurrentImpliedW, Math.round(350 * 55.2)); // 19320
  // sources: legacy except nominal voltage (default), grid cap (no legacy) + ess (none)
  assert.equal(sources.batteryCapacityWh, 'legacy');
  assert.equal(sources.batteryMaxDischargeDcW, 'legacy');
  assert.equal(sources.roundTripEfficiencyPct, 'legacy');
  assert.equal(sources.gridConnectionExportLimitW, 'default');
  assert.equal(sources.essMaxDischargeAcW, 'default');
});

test('sign normalization: SMA negative maxDischargeW -> positive magnitude', () => {
  // optimizer.maxDischargeW absent -> falls back to SMA's NEGATIVE value, abs'd.
  const cfg = { schedule: { smallMarketAutomation: { maxDischargeW: -12000 } } };
  const { limits } = getPowerLimits(cfg);
  assert.equal(limits.batteryMaxDischargeDcW, 12000);
});

test('unit normalization: SMA kWh -> Wh when optimizer Wh absent', () => {
  const cfg = { schedule: { smallMarketAutomation: { batteryCapacityKwh: 43 } } };
  const { limits, sources } = getPowerLimits(cfg);
  assert.equal(limits.batteryCapacityWh, 43000);
  assert.equal(sources.batteryCapacityWh, 'legacy');
});

test('canonical system.power wins over legacy + reports source', () => {
  const cfg = {
    ...PROD_LIKE,
    system: { power: {
      batteryMaxDischargeDcW: 19000,
      gridConnectionExportLimitW: 16000,
      inverterMaxPowerW: 24000,
    } },
  };
  const { limits, sources } = getPowerLimits(cfg);
  assert.equal(limits.batteryMaxDischargeDcW, 19000);
  assert.equal(sources.batteryMaxDischargeDcW, 'canonical');
  assert.equal(limits.gridConnectionExportLimitW, 16000);
  assert.equal(sources.gridConnectionExportLimitW, 'canonical');
  // a field NOT in system.power still falls back to legacy
  assert.equal(limits.batteryCapacityWh, 43000);
  assert.equal(sources.batteryCapacityWh, 'legacy');
});

test('canonical power caps are sign-normalized to positive', () => {
  const cfg = { system: { power: { batteryMaxDischargeDcW: -19000 } } };
  const { limits } = getPowerLimits(cfg);
  assert.equal(limits.batteryMaxDischargeDcW, 19000);
});

test('roundTrip fraction out of (0,1] is rejected, falls to default', () => {
  // 90 is NOT a valid fraction → legacy rejected → default 88
  const cfg = { optimizer: { roundTripEfficiency: 90 } };
  const { limits, sources } = getPowerLimits(cfg);
  assert.equal(limits.roundTripEfficiencyPct, POWER_LIMIT_DEFAULTS.roundTripEfficiencyPct);
  assert.equal(sources.roundTripEfficiencyPct, 'default');
});

test('empty config -> all documented defaults, source=default', () => {
  const { limits, sources } = getPowerLimits({});
  assert.equal(limits.batteryNominalVoltageV, POWER_LIMIT_DEFAULTS.batteryNominalVoltageV);
  assert.equal(limits.batteryCapacityWh, POWER_LIMIT_DEFAULTS.batteryCapacityWh);
  assert.equal(limits.inverterMaxPowerW, POWER_LIMIT_DEFAULTS.inverterMaxPowerW);
  assert.equal(limits.gridConnectionExportLimitW, 0);
  for (const k of Object.keys(POWER_LIMIT_DEFAULTS)) {
    assert.equal(sources[k], 'default', `${k} should be default on empty config`);
  }
});

test('getPowerLimits is pure / does not mutate cfg', () => {
  const cfg = JSON.parse(JSON.stringify(PROD_LIKE));
  const snapshot = JSON.stringify(cfg);
  getPowerLimits(cfg);
  assert.equal(JSON.stringify(cfg), snapshot);
});
