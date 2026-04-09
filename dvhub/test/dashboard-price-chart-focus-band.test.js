import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const publicDir = path.join(repoRoot, 'public');
const appPath = path.join(publicDir, 'app.js');
const stylesPath = path.join(publicDir, 'styles.css');

function loadDashboardHelpers() {
  const source = fs.readFileSync(appPath, 'utf8');
  const sandbox = {
    console,
    Date,
    Math,
    Number,
    JSON,
    Intl,
    Set,
    Map,
    globalThis: {},
    window: {
      DVhubCommon: {
        apiFetch: async () => ({
          ok: true,
          json: async () => ({ rules: [], config: {} })
        })
      },
      addEventListener() {},
      setInterval() {},
      clearInterval() {}
    },
    setInterval() {},
    clearInterval() {}
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: path.basename(appPath) });
  return sandbox.DVhubDashboard || sandbox.window.DVhubDashboard;
}

test('formatChartCentValue renders cent labels with two decimal places', () => {
  const helpers = loadDashboardHelpers();

  assert.equal(typeof helpers.formatChartCentValue, 'function');
  assert.equal(helpers.formatChartCentValue(0.08123), '8 Cent');
});

test('getChartHighlightSets returns the four highest and eight lowest slot indices', () => {
  const helpers = loadDashboardHelpers();

  assert.equal(typeof helpers.getChartHighlightSets, 'function');
  const result = helpers.getChartHighlightSets([2, 7, -1, -3, 5, 1, -2, 8, -5, 4, -4, 6]);

  assert.deepEqual([...result.high].sort((left, right) => left - right), [1, 4, 7, 11]);
  assert.deepEqual([...result.low].sort((left, right) => left - right), [2, 3, 6, 8, 10]);
});

test('createPriceChartScale keeps the near-zero band as a narrow strip', () => {
  const helpers = loadDashboardHelpers();

  assert.equal(typeof helpers.createPriceChartScale, 'function');
  const scale = helpers.createPriceChartScale({
    min: -0.08,
    max: 0.12,
    top: 16,
    bottom: 260,
    enableFocusBand: true,
    focusBandCeiling: 0.01,
    focusBandFloor: -0.01
  });

  const upperSmallGap = Math.abs(scale.y(0.01) - scale.y(0));
  const lowerSmallGap = Math.abs(scale.y(0) - scale.y(-0.01));
  const nearZeroBandHeight = Math.abs(scale.y(0.01) - scale.y(-0.01));
  const fullChartHeight = Math.abs(scale.y(0.12) - scale.y(-0.08));

  assert.ok(upperSmallGap > 0);
  assert.ok(lowerSmallGap > 0);
  assert.ok(nearZeroBandHeight < fullChartHeight / 4);
  assert.ok(nearZeroBandHeight > fullChartHeight / 12);
});

test('dashboard chart styles expose highlight signal colors', () => {
  const css = fs.readFileSync(stylesPath, 'utf8');

  assert.match(css, /--chart-positive-highlight:/);
  assert.match(css, /--chart-negative-highlight:/);
});

test('dashboard source uses cent chart labels and highlight fills', () => {
  const app = fs.readFileSync(appPath, 'utf8');

  assert.match(app, /formatChartCentValue\(vv\)/);
  assert.match(app, /getChartHighlightSets\(vals,/);
  assert.match(app, /enableFocusBand:\s*vals\.some\(\(value\)\s*=>\s*Number\.isFinite\(value\)\s*&&\s*value\s*>=\s*-0\.01\s*&&\s*value\s*<=\s*0\.01\)/);
  assert.match(app, /chartPositiveHighlight/);
  assert.match(app, /chartNegativeHighlight/);
  assert.match(app, /createPriceChartScale\(/);
});

test('getChartHighlightSets highlights per day when timestamps are provided', () => {
  const helpers = loadDashboardHelpers();

  // Two days of data: day 1 has 4 values, day 2 has 4 values
  const day1Base = Date.parse('2026-03-14T00:00:00Z');
  const day2Base = Date.parse('2026-03-15T00:00:00Z');
  const hour = 3600000;

  const values = [
    10, 5, 3, 1,    // day 1: indices 0-3
    20, 15, 8, 2    // day 2: indices 4-7
  ];
  const timestamps = [
    day1Base, day1Base + hour, day1Base + 2 * hour, day1Base + 3 * hour,
    day2Base, day2Base + hour, day2Base + 2 * hour, day2Base + 3 * hour
  ];

  const result = helpers.getChartHighlightSets(values, {
    highCount: 2,
    lowCount: 8,
    timestamps
  });

  // Day 1 top 2: indices 0 (10) and 1 (5)
  // Day 2 top 2: indices 4 (20) and 5 (15)
  // Total: 4 highlights, not just global top 2 (which would be indices 4, 5)
  const highIndices = [...result.high].sort((a, b) => a - b);
  assert.deepEqual(highIndices, [0, 1, 4, 5], 'should highlight top 2 per day, not globally');
});

test('getChartHighlightSets highlights negative values per day', () => {
  const helpers = loadDashboardHelpers();

  const day1Base = Date.parse('2026-03-14T00:00:00Z');
  const day2Base = Date.parse('2026-03-15T00:00:00Z');
  const hour = 3600000;

  const values = [
    5, -1, -3, 2,    // day 1: negatives at indices 1, 2
    8, -5, -2, 3     // day 2: negatives at indices 5, 6
  ];
  const timestamps = [
    day1Base, day1Base + hour, day1Base + 2 * hour, day1Base + 3 * hour,
    day2Base, day2Base + hour, day2Base + 2 * hour, day2Base + 3 * hour
  ];

  const result = helpers.getChartHighlightSets(values, {
    highCount: 4,
    lowCount: 2,
    timestamps
  });

  const lowIndices = [...result.low].sort((a, b) => a - b);
  // Day 1 bottom 2 negative: indices 1 (-1) and 2 (-3)
  // Day 2 bottom 2 negative: indices 5 (-5) and 6 (-2)
  assert.deepEqual(lowIndices, [1, 2, 5, 6], 'should highlight lowest negatives per day');
});

test('getChartHighlightSets falls back to global when no timestamps provided', () => {
  const helpers = loadDashboardHelpers();

  // Same test as the existing one — backward compatibility
  const result = helpers.getChartHighlightSets([2, 7, -1, -3, 5, 1, -2, 8, -5, 4, -4, 6]);
  assert.deepEqual([...result.high].sort((left, right) => left - right), [1, 4, 7, 11]);
  assert.deepEqual([...result.low].sort((left, right) => left - right), [2, 3, 6, 8, 10]);
});

test('dashboard source formats tooltip market prices with two cent decimals', () => {
  const app = fs.readFileSync(appPath, 'utf8');

  assert.match(app, /fmtCt\(row\.ct_kwh,\s*2\)/);
});

test('dashboard markup labels the price chart as ct per kwh', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');

  assert.match(html, /Day-Ahead-Preise \(ct\/kWh\)/);
  assert.doesNotMatch(html, /EUR\/kWh/);
});
