import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeMAE,
  computeRMSE,
  computeConfidenceFromMAE,
  matchForecastToActuals,
  createAccuracyTracker
} from '../services/forecast/accuracy-tracker.js';

// --- computeMAE ---

test('computeMAE([100, 200, 300], [110, 190, 310]) returns 10', () => {
  assert.equal(computeMAE([100, 200, 300], [110, 190, 310]), 10);
});

test('computeMAE([], []) returns null', () => {
  assert.equal(computeMAE([], []), null);
});

test('computeMAE with mismatched lengths returns null', () => {
  assert.equal(computeMAE([100, 200], [110]), null);
});

test('computeMAE with identical arrays returns 0', () => {
  assert.equal(computeMAE([100, 200, 300], [100, 200, 300]), 0);
});

// --- computeRMSE ---

test('computeRMSE([100, 200, 300], [110, 190, 310]) returns correct value', () => {
  // errors: 10, -10, 10 -> squared: 100, 100, 100 -> mean: 100 -> sqrt: 10
  assert.equal(computeRMSE([100, 200, 300], [110, 190, 310]), 10);
});

test('computeRMSE([], []) returns null', () => {
  assert.equal(computeRMSE([], []), null);
});

test('computeRMSE with mismatched lengths returns null', () => {
  assert.equal(computeRMSE([100], [110, 120]), null);
});

test('computeRMSE with identical arrays returns 0', () => {
  assert.equal(computeRMSE([100, 200], [100, 200]), 0);
});

// --- computeConfidenceFromMAE ---

test('computeConfidenceFromMAE returns 0.9 when MAE is very low relative to mean', () => {
  // MAE=10, mean=100 -> ratio=0.1 -> raw=0.9 -> clamped=0.9
  const result = computeConfidenceFromMAE(10, 100);
  assert.equal(result, 0.9);
});

test('computeConfidenceFromMAE returns 0.3 when MAE equals or exceeds mean (per D-05)', () => {
  // MAE=100, mean=100 -> ratio=1.0 -> raw=0.0 -> clamped=0.3
  assert.equal(computeConfidenceFromMAE(100, 100), 0.3);
  // MAE=200, mean=100 -> ratio=2.0 -> raw=-1.0 -> clamped=0.3
  assert.equal(computeConfidenceFromMAE(200, 100), 0.3);
});

test('computeConfidenceFromMAE clamps between 0.3 and 1.0', () => {
  // Very low MAE -> high confidence, but capped at 1.0
  const result = computeConfidenceFromMAE(0, 100);
  assert.ok(result >= 0.3, `confidence ${result} should be >= 0.3`);
  assert.ok(result <= 1.0, `confidence ${result} should be <= 1.0`);

  // Very high MAE -> low confidence, but floored at 0.3
  const lowResult = computeConfidenceFromMAE(500, 100);
  assert.equal(lowResult, 0.3);
});

test('computeConfidenceFromMAE returns 0.3 for edge cases', () => {
  assert.equal(computeConfidenceFromMAE(NaN, 100), 0.3);
  assert.equal(computeConfidenceFromMAE(10, NaN), 0.3);
  assert.equal(computeConfidenceFromMAE(10, 0), 0.3);
  assert.equal(computeConfidenceFromMAE(Infinity, 100), 0.3);
});

// --- matchForecastToActuals ---

test('matchForecastToActuals pairs forecast slots with actual telemetry by timestamp', () => {
  const forecast = [
    { ts_utc: '2026-04-02T10:00:00.000Z', power_w: 500 },
    { ts_utc: '2026-04-02T11:00:00.000Z', power_w: 600 },
    { ts_utc: '2026-04-02T12:00:00.000Z', power_w: 700 }
  ];
  const actuals = [
    { ts_utc: '2026-04-02T10:00:00.000Z', value_num: 510 },
    { ts_utc: '2026-04-02T11:00:00.000Z', value_num: 580 },
    // no match for 12:00
  ];
  const matched = matchForecastToActuals(forecast, actuals);
  assert.equal(matched.length, 2, 'should match 2 pairs');
  assert.equal(matched[0].forecasted, 500);
  assert.equal(matched[0].actual, 510);
  assert.equal(matched[1].forecasted, 600);
  assert.equal(matched[1].actual, 580);
});

test('matchForecastToActuals returns empty array when no matches', () => {
  const forecast = [
    { ts_utc: '2026-04-02T10:00:00.000Z', power_w: 500 }
  ];
  const actuals = [
    { ts_utc: '2026-04-02T14:00:00.000Z', value_num: 510 }
  ];
  const matched = matchForecastToActuals(forecast, actuals);
  assert.equal(matched.length, 0);
});

// --- createAccuracyTracker ---

test('createAccuracyTracker returns object with start, close, evaluateAccuracy', () => {
  const mockCtx = {
    state: { forecast: { pv: { confidence: 0.3 }, load: { confidence: 0.3 } } },
    getCfg: () => ({}),
    pushLog: () => {},
    db: null
  };
  const mockStore = {
    insertAccuracy: async () => {},
    getLatestPvForecast: async () => [],
    getLatestLoadForecast: async () => []
  };
  const tracker = createAccuracyTracker(mockCtx, { store: mockStore });
  assert.equal(typeof tracker.start, 'function');
  assert.equal(typeof tracker.close, 'function');
  assert.equal(typeof tracker.evaluateAccuracy, 'function');
});
