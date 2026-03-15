import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSelectionIndices,
  inferSlotMs,
  getSlotEndTimestamp,
  buildSelectionRange,
  buildScheduleWindows,
  computeImportOverlayPoints,
  resolveComparisonForSlot,
  buildRulesFromWindows,
} from '../public/components/dashboard/price-chart-compute.js';

describe('normalizeSelectionIndices', () => {
  it('clamps, deduplicates, sorts ascending', () => {
    const result = normalizeSelectionIndices(10, [2, 5, 2, -1, 15]);
    assert.deepEqual(result, [0, 2, 5, 9]);
  });

  it('returns [] for zero-length data', () => {
    assert.deepEqual(normalizeSelectionIndices(0, [1]), []);
  });

  it('returns [] for empty indices', () => {
    assert.deepEqual(normalizeSelectionIndices(5, []), []);
  });

  it('returns [] for null indices', () => {
    assert.deepEqual(normalizeSelectionIndices(5, null), []);
  });
});

describe('inferSlotMs', () => {
  it('infers 15-min slots from timestamps', () => {
    const data = [{ ts: 0 }, { ts: 900000 }, { ts: 1800000 }];
    assert.equal(inferSlotMs(data), 900000);
  });

  it('defaults to 900000 for single entry', () => {
    assert.equal(inferSlotMs([{ ts: 0 }]), 900000);
  });

  it('defaults to 900000 for empty array', () => {
    assert.equal(inferSlotMs([]), 900000);
  });

  it('handles ISO string time fields', () => {
    const data = [
      { time: '2026-03-14T00:00:00Z' },
      { time: '2026-03-14T01:00:00Z' },
    ];
    assert.equal(inferSlotMs(data), 3600000);
  });
});

describe('getSlotEndTimestamp', () => {
  it('returns slotTs + slotMs', () => {
    assert.equal(getSlotEndTimestamp(1000, 900000), 901000);
  });
});

describe('buildSelectionRange', () => {
  it('builds range ascending', () => {
    assert.deepEqual(buildSelectionRange(3, 7), [3, 4, 5, 6, 7]);
  });

  it('handles reverse order', () => {
    assert.deepEqual(buildSelectionRange(7, 3), [3, 4, 5, 6, 7]);
  });

  it('handles single index', () => {
    assert.deepEqual(buildSelectionRange(5, 5), [5]);
  });
});

describe('buildScheduleWindows', () => {
  const baseData = [
    { ts: 0 },
    { ts: 900000 },
    { ts: 1800000 },
    { ts: 2700000 },
    { ts: 3600000 },
  ];

  it('splits at gap into 2 windows', () => {
    const windows = buildScheduleWindows(baseData, [0, 1, 3, 4]);
    assert.equal(windows.length, 2);
  });

  it('contiguous indices produce single window', () => {
    const windows = buildScheduleWindows(baseData, [1, 2, 3]);
    assert.equal(windows.length, 1);
  });

  it('each window has start and end as HH:MM', () => {
    const windows = buildScheduleWindows(baseData, [0, 1]);
    assert.ok(windows[0].start, 'window should have start');
    assert.ok(windows[0].end, 'window should have end');
    assert.match(windows[0].start, /^\d{2}:\d{2}$/);
    assert.match(windows[0].end, /^\d{2}:\d{2}$/);
  });

  it('returns [] for empty indices', () => {
    assert.deepEqual(buildScheduleWindows(baseData, []), []);
  });
});

describe('computeImportOverlayPoints', () => {
  it('returns points for bars with matching comparison data', () => {
    const bars = [
      { x: 0, w: 10, _ts: 1000 },
      { x: 20, w: 10, _ts: 2000 },
      { x: 40, w: 10, _ts: 3000 },
    ];
    const comparisonByTs = new Map([
      [1000, { importPriceCtKwh: 5 }],
      [3000, { importPriceCtKwh: 8 }],
    ]);
    const yScale = (v) => 100 - v * 10;
    const points = computeImportOverlayPoints(bars, comparisonByTs, yScale);
    assert.equal(points.length, 2);
    assert.equal(points[0].x, 5); // 0 + 10/2
    assert.equal(points[0].y, 50); // 100 - 5*10
    assert.equal(points[1].x, 45); // 40 + 10/2
    assert.equal(points[1].y, 20); // 100 - 8*10
  });

  it('skips bars without comparison match', () => {
    const bars = [{ x: 0, w: 10, _ts: 999 }];
    const comparisonByTs = new Map([[1000, { importPriceCtKwh: 5 }]]);
    const yScale = (v) => v;
    assert.deepEqual(computeImportOverlayPoints(bars, comparisonByTs, yScale), []);
  });

  it('skips non-finite importPriceCtKwh', () => {
    const bars = [{ x: 0, w: 10, _ts: 1000 }];
    const comparisonByTs = new Map([[1000, { importPriceCtKwh: NaN }]]);
    const yScale = (v) => v;
    assert.deepEqual(computeImportOverlayPoints(bars, comparisonByTs, yScale), []);
  });

  it('returns [] for empty bars', () => {
    assert.deepEqual(computeImportOverlayPoints([], new Map(), (v) => v), []);
  });
});

describe('resolveComparisonForSlot', () => {
  it('returns comparison object for matching ts', () => {
    const map = new Map([[1000, { importPriceCtKwh: 5 }]]);
    const result = resolveComparisonForSlot(1000, map);
    assert.deepEqual(result, { importPriceCtKwh: 5 });
  });

  it('returns null for no match', () => {
    const map = new Map([[1000, { importPriceCtKwh: 5 }]]);
    assert.equal(resolveComparisonForSlot(999, map), null);
  });

  it('returns null for null ts', () => {
    assert.equal(resolveComparisonForSlot(null, new Map()), null);
  });

  it('coerces string ts to number', () => {
    const map = new Map([[1000, { importPriceCtKwh: 5 }]]);
    assert.deepEqual(resolveComparisonForSlot('1000', map), { importPriceCtKwh: 5 });
  });
});

describe('buildRulesFromWindows', () => {
  it('creates rule objects from windows', () => {
    const windows = [
      { start: '00:00', end: '00:30' },
      { start: '01:00', end: '01:30' },
    ];
    const defaults = { defaultGridSetpointW: 5000 };
    const rules = buildRulesFromWindows(windows, defaults);
    assert.equal(rules.length, 2);
    assert.equal(rules[0].target, 'gridSetpointW');
    assert.equal(rules[0].value, 5000);
    assert.equal(rules[0].enabled, true);
    assert.equal(rules[0].start, '00:00');
    assert.equal(rules[0].end, '00:30');
  });

  it('uses 0 as default value when defaults missing', () => {
    const rules = buildRulesFromWindows([{ start: '00:00', end: '01:00' }], null);
    assert.equal(rules[0].value, 0);
  });

  it('returns [] for non-array input', () => {
    assert.deepEqual(buildRulesFromWindows(null, {}), []);
  });
});
