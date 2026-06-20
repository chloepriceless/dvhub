// ml-correction.test.js -- Tests for ML correction, training, and health modules.
// Verifies: bypass when no model, bypass when disabled, correct prediction mapping,
// error handling, training rollback, health status aggregation.

import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMlCorrection } from '../services/ml/ml-correction.js';
import { createMlTraining } from '../services/ml/ml-training.js';
import { createMlHealth } from '../services/ml/ml-health.js';

describe('createMlCorrection', () => {
  let mockBridge, mockGetCfg, mockPushLog, correction;

  beforeEach(() => {
    mockBridge = { call: mock.fn() };
    mockPushLog = mock.fn();
    mockGetCfg = () => ({
      ml: { mlEnabled: true, mlModelDir: '/tmp/ml-models' }
    });
    correction = createMlCorrection({
      pythonBridge: mockBridge,
      getCfg: mockGetCfg,
      pushLog: mockPushLog
    });
  });

  it('test 1: bypass when no model is set', async () => {
    const pvSlots = [{ start: '2026-04-09T12:00:00Z', powerW: 1000 }];
    const result = await correction.correct(pvSlots, {});
    assert.equal(result.applied, false);
    assert.deepStrictEqual(result.corrected, pvSlots);
    assert.equal(result.model, null);
  });

  it('test 2: bypass when mlEnabled is false', async () => {
    mockGetCfg = () => ({ ml: { mlEnabled: false, mlModelDir: '/tmp/ml-models' } });
    correction = createMlCorrection({
      pythonBridge: mockBridge,
      getCfg: mockGetCfg,
      pushLog: mockPushLog
    });
    correction.setModel({ model_type: 'linear', version: 1, mae: 50 });

    const pvSlots = [{ start: '2026-04-09T12:00:00Z', powerW: 1000 }];
    const result = await correction.correct(pvSlots, {});
    assert.equal(result.applied, false);
    assert.deepStrictEqual(result.corrected, pvSlots);
  });

  it('test 3: correct returns mapped slots on successful prediction', async () => {
    correction.setModel({ model_type: 'linear', version: 1, mae: 50 });

    mockBridge.call.mock.mockImplementation(async () => ({
      ok: true,
      applied: true,
      model: 'linear_v1',
      corrected: [
        { start: '2026-04-09T12:00:00Z', powerW: 1100, rawPowerW: 1000 }
      ]
    }));

    const pvSlots = [{ start: '2026-04-09T12:00:00Z', powerW: 1000 }];
    const result = await correction.correct(pvSlots, { weather: {} });
    assert.equal(result.applied, true);
    assert.equal(result.model, 'linear_v1');
    assert.equal(result.corrected[0].powerW, 1100);
  });

  it('test 4: handles Python error gracefully (returns bypass)', async () => {
    correction.setModel({ model_type: 'linear', version: 1, mae: 50 });

    mockBridge.call.mock.mockImplementation(async () => {
      throw new Error('Python process crashed');
    });

    const pvSlots = [{ start: '2026-04-09T12:00:00Z', powerW: 1000 }];
    const result = await correction.correct(pvSlots, {});
    assert.equal(result.applied, false);
    assert.deepStrictEqual(result.corrected, pvSlots);
    assert.equal(result.model, null);
    // Verify error was logged. Plan 16-05 D-01 added an `ml_feature_diff`
    // log earlier in correct(), so search for the error event by name rather
    // than assuming it is the first push.
    const errLog = mockPushLog.mock.calls.find(
      c => c.arguments[0] === 'ml_predict_error'
    );
    assert.ok(errLog, 'Should log ml_predict_error');
  });

  it('test 5: handles bridge returning applied:false (no_model on disk)', async () => {
    correction.setModel({ model_type: 'linear', version: 1, mae: 50 });

    mockBridge.call.mock.mockImplementation(async () => ({
      ok: true,
      applied: false,
      reason: 'no_model'
    }));

    const pvSlots = [{ start: '2026-04-09T12:00:00Z', powerW: 1000 }];
    const result = await correction.correct(pvSlots, {});
    assert.equal(result.applied, false);
    assert.deepStrictEqual(result.corrected, pvSlots);
  });

  it('test 6: getModelInfo returns null when no model set', () => {
    assert.equal(correction.getModelInfo(), null);
  });

  it('test 7: setModel updates model info', () => {
    correction.setModel({ model_type: 'lgbm', version: 3, mae: 42 });
    const info = correction.getModelInfo();
    assert.equal(info.model_type, 'lgbm');
    assert.equal(info.version, 3);
    assert.equal(info.mae, 42);
  });

  // === Phase 19 P19-R3 — shadow-mode tests (Plan 19-04) ===
  //
  // shadow:true bypasses the mlEnabled gate but preserves the currentModel===null gate.
  // Mirrors the existing factory + setModel() helpers — no new scaffolding.

  it('test 7a [shadow]: correct({shadow:true}) bypasses mlEnabled=false when model loaded', async () => {
    // mlEnabled=false (legacy gate would short-circuit applied:false)
    mockGetCfg = () => ({ ml: { mlEnabled: false, mlModelDir: '/tmp/ml-models' } });
    correction = createMlCorrection({
      pythonBridge: mockBridge,
      getCfg: mockGetCfg,
      pushLog: mockPushLog,
    });
    correction.setModel({ model_type: 'linear', version: 1, mae: 50 });

    // Python bridge will be called because shadow:true bypasses the mlEnabled gate
    mockBridge.call.mock.mockImplementation(async () => ({
      ok: true,
      applied: true,
      model: 'linear_v1',
      corrected: [{ start: '2026-05-20T10:00:00Z', powerW: 950, rawPowerW: 1000 }],
    }));

    const pvSlots = [{ start: '2026-05-20T10:00:00Z', powerW: 1000 }];
    const result = await correction.correct(pvSlots, { forecastVersion: 1, shadow: true });
    assert.equal(result.applied, true, 'shadow:true with model loaded should bypass mlEnabled=false gate');
    assert.equal(result.model, 'linear_v1');
    assert.equal(result.corrected[0].powerW, 950);
  });

  it('test 7b [shadow]: correct({shadow:false}) preserves legacy mlEnabled=false bypass', async () => {
    mockGetCfg = () => ({ ml: { mlEnabled: false, mlModelDir: '/tmp/ml-models' } });
    correction = createMlCorrection({
      pythonBridge: mockBridge,
      getCfg: mockGetCfg,
      pushLog: mockPushLog,
    });
    correction.setModel({ model_type: 'linear', version: 1, mae: 50 });

    const pvSlots = [{ start: '2026-05-20T10:00:00Z', powerW: 1000 }];
    const result = await correction.correct(pvSlots, { forecastVersion: 1, shadow: false });
    assert.equal(result.applied, false, 'shadow:false legacy path: mlEnabled=false → applied:false');
    assert.deepStrictEqual(result.corrected, pvSlots);
    assert.equal(result.model, null);
    // Bridge must NOT have been called
    assert.equal(mockBridge.call.mock.calls.length, 0, 'mlEnabled=false bypass must short-circuit before bridge call');
  });

  it('test 7c [shadow]: correct({shadow:true}) still returns applied:false reason:no_model when no model loaded', async () => {
    mockGetCfg = () => ({ ml: { mlEnabled: false, mlModelDir: '/tmp/ml-models' } });
    correction = createMlCorrection({
      pythonBridge: mockBridge,
      getCfg: mockGetCfg,
      pushLog: mockPushLog,
    });
    // NO setModel call — currentModel stays null

    const pvSlots = [{ start: '2026-05-20T10:00:00Z', powerW: 1000 }];
    const result = await correction.correct(pvSlots, { forecastVersion: 1, shadow: true });
    assert.equal(result.applied, false);
    assert.equal(result.model, null);
    assert.equal(result.reason, 'no_model', 'currentModel=null gate must be preserved + add reason:no_model');
    assert.equal(mockBridge.call.mock.calls.length, 0, 'no model → no bridge spawn');
  });
});

describe('createMlTraining', () => {
  let mockBridge, mockStore, mockGetCfg, mockPushLog, mockCorrection, training;

  beforeEach(() => {
    mockBridge = { call: mock.fn() };
    mockStore = { query: mock.fn() };
    mockPushLog = mock.fn();
    mockGetCfg = () => ({
      ml: {
        mlEnabled: true,
        mlModelDir: '/tmp/ml-models',
        mlMinDataDays: 7,
        mlSlidingWindowMonths: 6
      },
      forecast: { pv: { tilt: 30, azimuth: 180, kwp: 10 } }
    });
    mockCorrection = { setModel: mock.fn(), getModelInfo: () => null };
    training = createMlTraining({
      pythonBridge: mockBridge,
      store: mockStore,
      getCfg: mockGetCfg,
      pushLog: mockPushLog,
      mlCorrection: mockCorrection
    });
  });

  it('test 8: triggerTraining skips when insufficient data', async () => {
    // Mock store returns insufficient data (only 3 days)
    mockStore.query.mock.mockImplementation(async () => ({
      rows: [{ data_days: 3 }]
    }));

    await training.triggerTraining();
    // Should log skip
    const skipLog = mockPushLog.mock.calls.find(
      c => c.arguments[0] === 'ml_training_skip'
    );
    assert.ok(skipLog, 'Should log ml_training_skip');
    // Should NOT call python bridge
    assert.equal(mockBridge.call.mock.calls.length, 0);
  });

  it('test 9: triggerTraining handles rollback response', async () => {
    // Mock store returns sufficient data
    mockStore.query.mock.mockImplementation(async () => ({
      rows: [{ data_days: 30, training_data: '[]' }]
    }));

    mockBridge.call.mock.mockImplementation(async () => ({
      ok: false,
      reason: 'rollback',
      new_mae: 100,
      previous_mae: 80
    }));

    await training.triggerTraining();
    // Should log rollback
    const rollbackLog = mockPushLog.mock.calls.find(
      c => c.arguments[0] === 'ml_training_rollback'
    );
    assert.ok(rollbackLog, 'Should log ml_training_rollback');
    // Model should NOT be updated
    assert.equal(mockCorrection.setModel.mock.calls.length, 0);
  });

  it('test 10: getTrainingLog returns array', () => {
    const log = training.getTrainingLog();
    assert.ok(Array.isArray(log));
    assert.equal(log.length, 0);
  });
});

describe('createMlHealth', () => {
  let health;

  beforeEach(() => {
    const mockCorrection = {
      getModelInfo: () => ({ model_type: 'lgbm', version: 2, mae: 45 })
    };
    const mockTraining = {
      getTrainingLog: () => [
        { ts: Date.now(), model_type: 'lgbm', version: 2, mae: 45, status: 'ok' }
      ]
    };
    const mockGetCfg = () => ({
      ml: {
        mlEnabled: true,
        mlTrainingHour: 21,
        mlTrainingMinute: 30,
        sfEnabled: true,
        sfUseMstl: false
      }
    });

    health = createMlHealth({
      mlCorrection: mockCorrection,
      mlTraining: mockTraining,
      getCfg: mockGetCfg,
      tier: 2
    });
  });

  it('test 11: getStatus returns complete status object', () => {
    const status = health.getStatus();
    assert.equal(status.tier, 2);
    assert.equal(status.mlEnabled, true);
    assert.equal(status.modelType, 'lgbm');
    assert.equal(status.modelVersion, 2);
    assert.equal(status.mae, 45);
    assert.ok(status.nextTraining);
    assert.ok(Array.isArray(status.trainingLog));
    assert.equal(status.trainingLog.length, 1);
    assert.equal(status.sfEnabled, true);
    assert.ok(Array.isArray(status.tierFeatures));
  });

  it('test 12: getStatus with no model returns nulls', () => {
    const healthNoModel = createMlHealth({
      mlCorrection: { getModelInfo: () => null },
      mlTraining: { getTrainingLog: () => [] },
      getCfg: () => ({
        ml: {
          mlEnabled: false,
          mlTrainingHour: 21,
          mlTrainingMinute: 30,
          sfEnabled: false,
          sfUseMstl: false
        }
      }),
      tier: 1
    });

    const status = healthNoModel.getStatus();
    assert.equal(status.tier, 1);
    assert.equal(status.mlEnabled, false);
    assert.equal(status.modelType, null);
    assert.equal(status.modelVersion, 0);
    assert.equal(status.mae, null);
  });
});
