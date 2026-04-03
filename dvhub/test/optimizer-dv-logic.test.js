// test/optimizer-dv-logic.test.js -- Unit tests for DV sell-vs-self-consume logic
// and estimateNetCost 'best' selector.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDvForecastLogic, estimateNetCost } from '../services/optimizer/index.js';

describe('DV Forecast Logic (sell-vs-self-consume)', () => {
  const now = Date.now();
  const QUARTER = 15 * 60_000;
  const HOUR = 3_600_000;

  function makeNormalized({ pvPower = 1000, loadPower = 300, slots = 16 } = {}) {
    const pvSlots = [];
    const loadSlots = [];
    for (let i = 0; i < slots; i++) {
      pvSlots.push({
        ts: now + i * QUARTER,
        endTs: now + (i + 1) * QUARTER,
        powerW: pvPower,
        confidence: 0.8
      });
    }
    // Load at 1h resolution
    for (let i = 0; i < Math.ceil(slots / 4); i++) {
      loadSlots.push({
        ts: now + i * HOUR,
        endTs: now + (i + 1) * HOUR,
        powerW: loadPower,
        confidence: 0.7
      });
    }
    return {
      price: { resolution: '15min', slots: pvSlots.map(s => ({ ...s, ctKwh: 10 })) },
      pv: { resolution: '15min', slots: pvSlots },
      load: { resolution: '1h', slots: loadSlots }
    };
  }

  test('with high PV forecast for next 4h, DV logic produces self-consume rules (no sell)', () => {
    // PV 1000W > Load 300W -- surplus expected
    const normalized = makeNormalized({ pvPower: 1000, loadPower: 300 });
    const state = { victron: { soc: 50 } };
    const getCfg = () => ({ optimizer: { enabled: true } });
    const rules = applyDvForecastLogic(normalized, state, getCfg);
    assert.ok(rules.length > 0, 'Should produce self-consume rules');
    // Self-consume rules have powerW = 0 (grid setpoint 0)
    for (const r of rules) {
      assert.equal(r.powerW, 0, 'Self-consume rule should have powerW=0');
    }
  });

  test('with low PV forecast for next 4h, DV logic allows sell (no additional rules)', () => {
    // PV 100W < Load 500W -- deficit expected
    const normalized = makeNormalized({ pvPower: 100, loadPower: 500 });
    const state = { victron: { soc: 50 } };
    const getCfg = () => ({ optimizer: { enabled: true } });
    const rules = applyDvForecastLogic(normalized, state, getCfg);
    assert.equal(rules.length, 0, 'No additional rules when PV deficit');
  });

  test('with no forecast data, DV logic returns empty rules (safe default)', () => {
    const empty = { price: { slots: [] }, pv: { slots: [] }, load: { slots: [] } };
    const state = { victron: { soc: 50 } };
    const getCfg = () => ({ optimizer: { enabled: true } });
    const rules = applyDvForecastLogic(empty, state, getCfg);
    assert.equal(rules.length, 0, 'Empty forecast should return empty rules');
  });

  test('with null/undefined input, DV logic returns empty rules', () => {
    const state = { victron: { soc: 50 } };
    const getCfg = () => ({ optimizer: { enabled: true } });
    assert.deepEqual(applyDvForecastLogic(null, state, getCfg), []);
    assert.deepEqual(applyDvForecastLogic(undefined, state, getCfg), []);
  });
});

describe('estimateNetCost (best selector)', () => {
  const now = Date.now();
  const QUARTER = 15 * 60_000;

  test('cheaper schedule wins -- lower cost is better', () => {
    const priceSlots = [
      { ts: now, endTs: now + QUARTER, ctKwh: 10 },
      { ts: now + QUARTER, endTs: now + 2 * QUARTER, ctKwh: 30 }
    ];
    const pvSlots = [
      { ts: now, endTs: now + QUARTER, powerW: 0 },
      { ts: now + QUARTER, endTs: now + 2 * QUARTER, powerW: 0 }
    ];
    const loadSlots = [
      { ts: now, endTs: now + QUARTER, powerW: 500 },
      { ts: now + QUARTER, endTs: now + 2 * QUARTER, powerW: 500 }
    ];

    // Schedule A: charge in cheap slot, discharge in expensive slot
    const scheduleA = [
      { ts: now, endTs: now + QUARTER, powerW: 1000 }, // charge at 10 ct
      { ts: now + QUARTER, endTs: now + 2 * QUARTER, powerW: -1000 } // discharge at 30 ct
    ];

    // Schedule B: charge in expensive slot, discharge in cheap slot (bad)
    const scheduleB = [
      { ts: now, endTs: now + QUARTER, powerW: -1000 }, // discharge at 10 ct
      { ts: now + QUARTER, endTs: now + 2 * QUARTER, powerW: 1000 } // charge at 30 ct
    ];

    const costA = estimateNetCost(scheduleA, priceSlots, pvSlots, loadSlots);
    const costB = estimateNetCost(scheduleB, priceSlots, pvSlots, loadSlots);

    assert.ok(costA < costB, `Schedule A (${costA.toFixed(2)}) should be cheaper than B (${costB.toFixed(2)})`);
  });

  test('empty schedule returns 0 cost', () => {
    const cost = estimateNetCost([], [], [], []);
    assert.equal(cost, 0);
  });
});
