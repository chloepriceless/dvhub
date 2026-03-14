import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeForecastPaths } from '../public/components/dashboard/forecast-compute.js';

describe('computeForecastPaths', () => {
  it('48 PV points + 48 load points -> both paths have 48 coordinates', () => {
    const pvData = Array.from({ length: 48 }, (_, i) => ({
      time: new Date(2026, 2, 14, i).toISOString(),
      power: 1000 + i * 100,
    }));
    const loadData = Array.from({ length: 48 }, (_, i) => ({
      time: new Date(2026, 2, 14, i).toISOString(),
      power: 500 + i * 50,
    }));
    const result = computeForecastPaths(pvData, loadData, 1000, 250);
    assert.equal(result.pvPath.length, 48);
    assert.equal(result.loadPath.length, 48);
  });

  it('All zero PV -> pvPath Y values all at baseline', () => {
    const pvData = Array.from({ length: 10 }, (_, i) => ({
      time: new Date(2026, 2, 14, i).toISOString(),
      power: 0,
    }));
    const result = computeForecastPaths(pvData, [], 1000, 250);
    const baseline = 250 - 30; // chartBottom
    for (const point of result.pvPath) {
      assert.equal(point.y, baseline, 'Zero-power point should be at baseline');
    }
  });

  it('Empty arrays -> empty paths', () => {
    const result = computeForecastPaths([], [], 1000, 250);
    assert.deepEqual(result.pvPath, []);
    assert.deepEqual(result.loadPath, []);
  });
});
