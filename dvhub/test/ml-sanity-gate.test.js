// ml-sanity-gate.test.js -- Plan 16-05 D-02: pre-promotion sanity-gate integration test.
//
// Proves the magnitude check in promoteIfBetter the MAE-improvement gate alone
// could not catch: over daylight slots (raw PV > 0), mean(corrected)/mean(raw)
// must be in [0.5, 1.5]. A healthy model passes; a v1-style collapsed model
// (predictions ~0) is rejected and is NEVER promoted.
//
// DI-fake harness — no real Python, no real Postgres. The injected pythonBridge
// is the seam: mockBridge.call returns canned ml_eval.py outputs (mae +
// per-row predictions) so the gate's ratio is computed over a controlled set.
// Real on-disk model directories with a valid meta.json are created under a
// tmp dir so validateModel() (a pure fs.readFileSync check) passes — the gate
// itself is what is under test, not the schema guard.

import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMlTraining } from '../services/ml/ml-training.js';
import { RUNTIME_FEATURE_SCHEMA_VERSION } from '../services/ml/ml-schema-guard.js';

describe('promoteIfBetter — D-02 pre-promotion sanity gate', () => {
  let mockBridge, mockStore, mockGetCfg, mockPushLog, mockCorrection, training;
  let tmpDir, activePath, candidatePath;

  // Create a model directory with a schema-valid meta.json so validateModel passes.
  function makeModelDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'meta.json'),
      JSON.stringify({ feature_schema_version: RUNTIME_FEATURE_SCHEMA_VERSION }),
    );
    fs.writeFileSync(path.join(dir, 'model.txt'), 'stub-lightgbm-model');
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-sanity-gate-'));
    activePath = path.join(tmpDir, 'active');
    candidatePath = path.join(tmpDir, 'candidate_v2');
    makeModelDir(activePath);
    makeModelDir(candidatePath);

    mockBridge = { call: mock.fn() };
    mockStore = { query: mock.fn() };
    mockPushLog = mock.fn();
    mockGetCfg = () => ({
      ml: {
        mlEnabled: true,
        mlModelDir: tmpDir,
        mlMinDataDays: 7,
        mlSlidingWindowMonths: 6,
        activeModelPath: activePath,
        candidateModelPath: candidatePath,
      },
      forecast: { pv: { tilt: 30, azimuth: 180, kwp: 10 } },
    });
    mockCorrection = { setModel: mock.fn(), getModelInfo: () => null };
    training = createMlTraining({
      pythonBridge: mockBridge,
      store: mockStore,
      getCfg: mockGetCfg,
      pushLog: mockPushLog,
      mlCorrection: mockCorrection,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Held-out rows carrying the measured PV target (rawPv = ground truth).
  function heldOutRows() {
    return [
      { hour: 2, y_true: 0 },      // night — raw 0, excluded from the daylight filter
      { hour: 10, y_true: 8000 },  // daylight
      { hour: 12, y_true: 12000 }, // daylight peak
      { hour: 15, y_true: 6000 },  // daylight
      { hour: 22, y_true: 0 },     // night — excluded
    ];
  }

  // Stub two consecutive ml_eval.py calls (v1 active, then v2 candidate).
  // Each eval result carries `mae` and a `predictions` array aligned to the
  // held-out rows; `corrected` ratios are driven by the candidate predictions.
  function stubEval({ v1Mae, v2Mae, v2Predictions }) {
    let call = 0;
    mockBridge.call.mock.mockImplementation(async (scriptPath) => {
      if (typeof scriptPath === 'string' && scriptPath.includes('ml_eval.py')) {
        call += 1;
        if (call === 1) {
          return { ok: true, mae: v1Mae, n: 5 }; // active (v1) eval
        }
        return { ok: true, mae: v2Mae, n: 5, predictions: v2Predictions }; // candidate
      }
      return { ok: true };
    });
  }

  it('healthy model PASSES the sanity gate and is promoted', async () => {
    // Candidate predictions track the measured PV closely (ratio ~1.0).
    stubEval({
      v1Mae: 1000,
      v2Mae: 800,
      v2Predictions: [
        { rawPv: 0, correctedPv: 0 },
        { rawPv: 8000, correctedPv: 7800 },
        { rawPv: 12000, correctedPv: 11500 },
        { rawPv: 6000, correctedPv: 6100 },
        { rawPv: 0, correctedPv: 0 },
      ],
    });

    const result = await training.promoteIfBetter({
      candidatePath,
      activePath,
      heldOutRows: heldOutRows(),
    });

    assert.notEqual(result.decision, 'rejected',
      'healthy model must not be rejected by the sanity gate');
    const gateReject = mockPushLog.mock.calls.find(
      c => c.arguments[0] === 'ml_sanity_gate_rejected');
    assert.equal(gateReject, undefined,
      'no ml_sanity_gate_rejected event for a healthy model');
  });

  it('collapsed v1-like model is REJECTED by the sanity gate and NOT promoted', async () => {
    // Candidate predictions collapse to ~0 over daylight slots (ratio ~0.05) —
    // the exact v1 failure mode. MAE may even look "better" on a degenerate
    // slice, so the MAE gate alone would wrongly promote it.
    stubEval({
      v1Mae: 1000,
      v2Mae: 500, // deceptively "better" MAE
      v2Predictions: [
        { rawPv: 0, correctedPv: 0 },
        { rawPv: 8000, correctedPv: 5 },
        { rawPv: 12000, correctedPv: 8 },
        { rawPv: 6000, correctedPv: 3 },
        { rawPv: 0, correctedPv: 0 },
      ],
    });

    const result = await training.promoteIfBetter({
      candidatePath,
      activePath,
      heldOutRows: heldOutRows(),
    });

    assert.equal(result.decision, 'rejected', 'collapsed model must be rejected');
    assert.equal(result.reason, 'sanity_gate',
      'rejection reason must be the sanity gate');
    assert.equal(mockCorrection.setModel.mock.calls.length, 0,
      'a rejected model must never be promoted (setModel not called)');
    const gateReject = mockPushLog.mock.calls.find(
      c => c.arguments[0] === 'ml_sanity_gate_rejected');
    assert.ok(gateReject, 'must fire ml_sanity_gate_rejected');
  });
});
