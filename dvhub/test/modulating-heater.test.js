// test/modulating-heater.test.js -- PV-Überschuss-Regelung modulierender Heizstäbe
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeHeaterPowerW, expectedHeaterEnergyWh } from '../services/devices/modulating-heater.js';

describe('computeHeaterPowerW', () => {
  it('follows surplus, clamped to maxPowerW', () => {
    assert.equal(computeHeaterPowerW({ maxPowerW: 3000, surplusW: 1200 }).powerW, 1200);
    assert.equal(computeHeaterPowerW({ maxPowerW: 3000, surplusW: 5000 }).powerW, 3000);
    assert.equal(computeHeaterPowerW({ maxPowerW: 3000, surplusW: 0 }).powerW, 0);
  });

  it('does not dribble below minPowerW without a deadline', () => {
    const r = computeHeaterPowerW({ maxPowerW: 3000, minPowerW: 500, surplusW: 200 });
    assert.equal(r.powerW, 0);
    assert.equal(r.reason, 'below_min');
  });

  it('stops when target reached', () => {
    const r = computeHeaterPowerW({ maxPowerW: 3000, surplusW: 2000, socPct: 85, targetPct: 80 });
    assert.equal(r.powerW, 0);
    assert.equal(r.reason, 'target_reached');
  });

  it('deadline boost forces grid-assisted power when surplus insufficient', () => {
    const now = Date.parse('2026-09-26T18:00:00Z');
    const deadline = now + 2 * 3600_000; // 2h left
    // need (80-30)% of 8000Wh = 4000Wh in 2h → 2000W required; surplus only 500W
    const r = computeHeaterPowerW({ maxPowerW: 3000, surplusW: 500, socPct: 30, targetPct: 80, capacityWh: 8000, deadlineMs: deadline, nowMs: now });
    assert.equal(r.reason, 'deadline_boost');
    assert.equal(r.powerW, 2000);
  });

  it('deadline boost is capped at maxPowerW', () => {
    const now = Date.parse('2026-09-26T19:30:00Z');
    const deadline = now + 0.5 * 3600_000; // 30min left, huge need
    const r = computeHeaterPowerW({ maxPowerW: 3000, surplusW: 0, socPct: 10, targetPct: 100, capacityWh: 10000, deadlineMs: deadline, nowMs: now });
    assert.equal(r.powerW, 3000);
  });

  it('no boost when surplus already exceeds requirement', () => {
    const now = Date.parse('2026-09-26T12:00:00Z');
    const deadline = now + 6 * 3600_000;
    const r = computeHeaterPowerW({ maxPowerW: 3000, surplusW: 2500, socPct: 50, targetPct: 80, capacityWh: 8000, deadlineMs: deadline, nowMs: now });
    assert.equal(r.reason, 'surplus_follow');
    assert.equal(r.powerW, 2500);
  });

  it('disabled when maxPowerW is 0', () => {
    assert.equal(computeHeaterPowerW({ maxPowerW: 0, surplusW: 1000 }).powerW, 0);
  });
});

describe('expectedHeaterEnergyWh', () => {
  it('computes remaining energy to target', () => {
    assert.equal(expectedHeaterEnergyWh({ socPct: 30, targetPct: 80, capacityWh: 8000 }), 4000);
  });
  it('zero when already at/over target or unknown', () => {
    assert.equal(expectedHeaterEnergyWh({ socPct: 90, targetPct: 80, capacityWh: 8000 }), 0);
    assert.equal(expectedHeaterEnergyWh({ socPct: null, targetPct: 80, capacityWh: 8000 }), 0);
  });
});
