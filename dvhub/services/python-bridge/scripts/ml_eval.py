#!/usr/bin/env python3
"""Phase 07 MLAI-08 REVIEWS H12: model evaluation helper.

Evaluates a trained LightGBM/Linear model on a pre-loaded held-out slice and
returns the MAE. Used by ml-training.js promoteIfBetter to decide whether the
v2 candidate is worth promoting over the currently active model.

Input schema:
{
  "model_path": "/opt/dvhub/ml-models/pv_correction_lightgbm_v3",
  "held_out":   [{ feature1: ..., feature2: ..., y_true: 2340.0 }, ...]
}

Output schema (success):
{"ok": true, "mae": 123.4, "n": 72,
 "predictions": [{"rawPv": 2340.0, "correctedPv": 2280.1}, ...]}

`predictions` (Plan 16-05 D-02) is aligned to the held-out rows: `rawPv` is the
measured PV ground truth (`y_true`), `correctedPv` is the model's prediction.
ml-training.js promoteIfBetter consumes it for the pre-promotion sanity gate.

Output schema (schema mismatch — fail-open):
{"ok": false, "error": "schema_mismatch", "model_version": 1, "runtime_version": 2}

Output schema (error):
{"ok": false, "error": "..."}
"""
import json
import os
import sys
import traceback

# Import the same FEATURE_COLS + schema guard used by ml_predict to keep
# behaviour identical between inference and evaluation.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ml_predict import FEATURE_COLS, RUNTIME_FEATURE_SCHEMA_VERSION


def eval_model(params):
    """Load the model at params['model_path'] and compute MAE over params['held_out']."""
    model_path = params.get('model_path')
    held_out = params.get('held_out', [])
    if not model_path or not os.path.isdir(model_path):
        return {'ok': False, 'error': f'model_path not found: {model_path}'}
    if not isinstance(held_out, list) or len(held_out) == 0:
        return {'ok': False, 'error': 'held_out must be a non-empty list'}

    # Phase 07 MLAI-08 schema guard — matches ml_predict.py fail-open semantics.
    # When mismatch is detected, return ok=false so the caller knows the model
    # cannot be evaluated with the current runtime.
    meta_path = os.path.join(model_path, 'meta.json')
    if os.path.isfile(meta_path):
        try:
            with open(meta_path) as f:
                meta = json.load(f)
            model_schema = meta.get('feature_schema_version', 1)
            if model_schema != RUNTIME_FEATURE_SCHEMA_VERSION:
                return {
                    'ok': False,
                    'error': 'schema_mismatch',
                    'model_version': model_schema,
                    'runtime_version': RUNTIME_FEATURE_SCHEMA_VERSION,
                }
        except Exception as meta_err:
            return {'ok': False, 'error': f'meta_read_error: {meta_err}'}

    # Determine model type by probing the model directory (same convention as ml_predict.py).
    model_type = None
    if os.path.isfile(os.path.join(model_path, 'model.txt')):
        model_type = 'lightgbm'
    elif os.path.isfile(os.path.join(model_path, 'model.joblib')):
        model_type = 'linear'
    else:
        return {'ok': False, 'error': f'no model artifact (model.txt or model.joblib) in {model_path}'}

    # Lazy-import to keep import-time side effects small for tests.
    import numpy as np

    if model_type == 'lightgbm':
        import lightgbm as lgb
        booster = lgb.Booster(model_file=os.path.join(model_path, 'model.txt'))
        X = np.array([[float(row.get(col, 0.0) or 0.0) for col in FEATURE_COLS] for row in held_out])
        y_pred = booster.predict(X)
    else:
        # Plan 08-06 Task 3: sha256-verified loader replaces joblib.load.
        from model_loader import safe_load_model
        model = safe_load_model(os.path.join(model_path, 'model.joblib'))
        scaler_file = os.path.join(model_path, 'scaler.joblib')
        scaler = safe_load_model(scaler_file) if os.path.isfile(scaler_file) else None
        X = np.array([[float(row.get(col, 0.0) or 0.0) for col in FEATURE_COLS] for row in held_out])
        if scaler is not None:
            X = scaler.transform(X)
        y_pred = model.predict(X)

    y_pred = np.clip(y_pred, 0, None)
    y_true = np.array([float(row.get('y_true', 0.0) or 0.0) for row in held_out])
    mae = float(np.mean(np.abs(y_true - y_pred)))

    # Plan 16-05 D-02: per-row predictions for the pre-promotion sanity gate.
    # rawPv = measured ground truth (y_true), correctedPv = model prediction.
    predictions = [
        {'rawPv': float(yt), 'correctedPv': float(yp)}
        for yt, yp in zip(y_true, y_pred)
    ]

    return {
        'ok': True,
        'mae': mae,
        'n': len(held_out),
        'model_type': model_type,
        'predictions': predictions,
    }


if __name__ == '__main__':
    try:
        params = json.loads(sys.stdin.read())
        result = eval_model(params)
    except Exception as err:
        result = {'ok': False, 'error': str(err), 'traceback': traceback.format_exc()}
    sys.stdout.write(json.dumps(result))
