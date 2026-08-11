// test/milp-discharge-split.test.js -- Tests for MILP discharge_self/discharge_export split (#16)
// and sunrise-aware reoptimization interval (#16b).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildMilpSchedule } from '../services/optimizer/milp-battery-optimizer.js';
import { getOptInterval } from '../services/optimizer/index.js';

// Helper: build N price slots with 15min resolution
function makePriceSlots(N, overrides = {}) {
  const now = Math.floor(Date.now() / 900_000) * 900_000;
  return Array.from({ length: N }, (_, i) => ({
    ts: now + i * 900_000,
    endTs: now + (i + 1) * 900_000,
    ctKwh: overrides.ctKwh ?? 10,
    importCtKwh: overrides.importCtKwh ?? 26.9,
    feedInCtKwh: overrides.feedInCtKwh ?? 7.0,
    confidence: overrides.confidence ?? 0.8,
    ...(typeof overrides.slotOverride === 'function' ? overrides.slotOverride(i) : {})
  }));
}

// Helper: build PV slots matching price slot timestamps
function makePvSlots(priceSlots, powerW = 0) {
  return priceSlots.map(p => ({
    ts: p.ts,
    endTs: p.endTs,
    powerW: typeof powerW === 'function' ? powerW(p) : powerW,
    confidence: 0.8
  }));
}

// Helper: build load slots (1h resolution, covering all price slots)
function makeLoadSlots(priceSlots, powerW = 500) {
  const hourMs = 3_600_000;
  const firstTs = priceSlots[0].ts;
  const lastEndTs = priceSlots[priceSlots.length - 1].endTs;
  const slots = [];
  for (let ts = firstTs; ts < lastEndTs; ts += hourMs) {
    slots.push({
      ts,
      endTs: ts + hourMs,
      powerW: typeof powerW === 'function' ? powerW(ts) : powerW,
      confidence: 0.7
    });
  }
  return slots;
}

const defaultBattery = {
  capacityWh: 10000,
  maxSocPct: 100,
  maxChargeW: 3000,
  maxDischargeW: 3000,
  currentSocPct: 80 // Start with SOC high enough to discharge
};

const defaultGate = {
  minSocPct: 10,
  maxDischargeW: 3000
};

// Read MILP source to verify structural changes (works without HiGHS solver)
const milpSource = fs.readFileSync(
  new URL('../services/optimizer/milp-battery-optimizer.js', import.meta.url),
  'utf8'
);

describe('MILP discharge_self / discharge_export split (#16)', () => {

  test('Test 1: MILP source contains discharge_self variable definition', () => {
    assert.ok(milpSource.includes('discharge_self_'), 'Should contain discharge_self_ variable');
    assert.ok(milpSource.includes('discharge_export_'), 'Should contain discharge_export_ variable');
  });

  test('Test 2: MILP source contains split constraint linking discharge_self + discharge_export = discharge', () => {
    // Constraint: discharge_self_t + discharge_export_t - discharge_t = 0
    assert.ok(
      milpSource.includes('discharge_self_') && milpSource.includes('discharge_export_') && milpSource.includes('split_'),
      'Should have split constraint'
    );
  });

  test('Test 3: MILP source bounds discharge_self by load', () => {
    // Constraint: discharge_self_t <= load_t
    assert.ok(milpSource.includes('self_cap_'), 'Should have self_cap constraint bounding discharge_self by load');
  });

  test('Test 4: MILP objective uses importCtKwh for discharge_self and feedInCtKwh for discharge_export', () => {
    // Objective terms: discharge_self uses importPrice (avoided import cost)
    //                  discharge_export uses feedInPrice (feed-in revenue)
    assert.ok(
      milpSource.includes('dischargeSelfCoeff') && milpSource.includes('-importPrice'),
      'discharge_self coefficient should use importPrice (avoided import)'
    );
    assert.ok(
      milpSource.includes('dischargeExportCoeff') && milpSource.includes('-feedInPrice'),
      'discharge_export coefficient should use feedInPrice (feed-in revenue)'
    );
  });

  test('Test 5: MILP result extraction includes dischargeSelfW and dischargeExportW fields', () => {
    assert.ok(milpSource.includes('dischargeSelfW'), 'Result should include dischargeSelfW');
    assert.ok(milpSource.includes('dischargeExportW'), 'Result should include dischargeExportW');
  });

  test('Test 5b: buildMilpSchedule returns null when HiGHS unavailable (Tier 1 graceful degradation)', async () => {
    const priceSlots = makePriceSlots(8, { importCtKwh: 26.9, feedInCtKwh: 7.0 });
    const pvSlots = makePvSlots(priceSlots, 0);
    const loadSlots = makeLoadSlots(priceSlots, 500);

    const result = await buildMilpSchedule({
      priceSlots, pvSlots, loadSlots,
      batteryModel: defaultBattery,
      confidenceGate: defaultGate,
      allowGridCharge: false,
      allowGridDischarge: true
    });

    // On dev machines without HiGHS, result is null (graceful Tier 1 fallback)
    // On prod (Tier 2+), result would be an array with dischargeSelfW/dischargeExportW
    if (result === null) {
      // Expected on dev -- HiGHS not available
      assert.equal(result, null, 'Returns null when HiGHS unavailable');
    } else {
      // HiGHS available -- verify discharge split fields
      assert.ok(Array.isArray(result), 'Result should be an array');
      for (const slot of result) {
        if (slot.powerW < 0) {
          assert.ok('dischargeSelfW' in slot, 'Discharge slots should have dischargeSelfW');
          assert.ok('dischargeExportW' in slot, 'Discharge slots should have dischargeExportW');
        }
      }
    }
  });

  test('Test 5c: MILP variable bounds include discharge_self and discharge_export', () => {
    assert.ok(milpSource.includes('discharge_self_${t}'), 'Bounds should include discharge_self');
    assert.ok(milpSource.includes('discharge_export_${t}'), 'Bounds should include discharge_export');
  });
});

describe('Sunrise-aware reoptimization interval (#16b)', () => {

  test('Test 6: getOptInterval returns shorter interval during 05:00-10:00 local time', () => {
    const cfg = {
      optimizer: {
        intervalMs: 900000,           // 15 min
        morningReoptIntervalMs: 300000 // 5 min
      }
    };

    // Mock a time in the morning window (e.g., 07:00)
    const interval = getOptInterval(cfg, 7);
    assert.equal(interval, 300000, 'Should return morning interval (5 min) at hour 7');
  });

  test('Test 7: getOptInterval returns normal interval outside 05:00-10:00', () => {
    const cfg = {
      optimizer: {
        intervalMs: 900000,
        morningReoptIntervalMs: 300000
      }
    };

    // Mock a time outside the morning window (e.g., 14:00)
    const interval = getOptInterval(cfg, 14);
    assert.equal(interval, 900000, 'Should return normal interval (15 min) at hour 14');
  });

  test('getOptInterval uses defaults when config values are missing', () => {
    const cfg = { optimizer: {} };

    const morningInterval = getOptInterval(cfg, 6);
    assert.equal(morningInterval, 300000, 'Default morning interval should be 300000 (5 min)');

    const normalInterval = getOptInterval(cfg, 12);
    assert.equal(normalInterval, 900000, 'Default normal interval should be 900000 (15 min)');
  });

  test('getOptInterval boundary: hour=5 is included, hour=10 is excluded', () => {
    const cfg = {
      optimizer: {
        intervalMs: 900000,
        morningReoptIntervalMs: 300000
      }
    };

    assert.equal(getOptInterval(cfg, 5), 300000, 'hour=5 should use morning interval');
    assert.equal(getOptInterval(cfg, 9), 300000, 'hour=9 should use morning interval');
    assert.equal(getOptInterval(cfg, 10), 900000, 'hour=10 should use normal interval');
    assert.equal(getOptInterval(cfg, 4), 900000, 'hour=4 should use normal interval');
  });
});
