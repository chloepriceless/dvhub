import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeTimelineLayout } from '../public/components/dashboard/energy-timeline-compute.js';

describe('computeTimelineLayout', () => {
  function makeEnergyData(count) {
    return Array.from({ length: count }, (_, i) => ({
      time: new Date(2026, 2, 14, Math.floor(i / 4), (i % 4) * 15).toISOString(),
      pvWh: 100 + i * 10,
      gridImportWh: 50 + i * 5,
      batteryDischargeWh: 20 + i * 2,
    }));
  }

  function makePriceData(count) {
    return Array.from({ length: count }, (_, i) => ({
      time: new Date(2026, 2, 14, Math.floor(i / 4), (i % 4) * 15).toISOString(),
      price: 5 + Math.sin(i / 10) * 10,
    }));
  }

  it('96 energy slots + 96 prices -> bars count = 96, priceLine has 96 points', () => {
    const result = computeTimelineLayout(makeEnergyData(96), makePriceData(96), 1000, 350);
    assert.equal(result.bars.length, 96);
    assert.equal(result.priceLine.length, 96);
  });

  it('All zero energy -> all bar segments empty', () => {
    const zeroEnergy = Array.from({ length: 10 }, (_, i) => ({
      time: new Date(2026, 2, 14, i).toISOString(),
      pvWh: 0,
      gridImportWh: 0,
      batteryDischargeWh: 0,
    }));
    const result = computeTimelineLayout(zeroEnergy, [], 1000, 350);
    assert.equal(result.bars.length, 10);
    for (const bar of result.bars) {
      // All segments should have h=0 or no segments
      for (const seg of bar.segments) {
        assert.equal(seg.h, 0, 'Segment height should be 0 for zero energy');
      }
    }
  });

  it('Price line Y coordinates inversely proportional to price', () => {
    const prices = [
      { time: '2026-03-14T00:00:00Z', price: 10 },
      { time: '2026-03-14T00:15:00Z', price: 20 },
    ];
    const result = computeTimelineLayout(
      [{ time: '2026-03-14T00:00:00Z', pvWh: 100, gridImportWh: 0, batteryDischargeWh: 0 }],
      prices,
      1000, 350
    );
    // Higher price should have lower Y
    assert.ok(result.priceLine[1].y < result.priceLine[0].y,
      'Higher price should have lower Y coordinate');
  });

  it('Empty data -> empty bars and priceLine arrays', () => {
    const result = computeTimelineLayout([], [], 1000, 350);
    assert.deepEqual(result.bars, []);
    assert.deepEqual(result.priceLine, []);
  });
});
