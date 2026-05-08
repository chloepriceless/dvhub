#!/usr/bin/env python3
"""
ML inference script for PV forecast correction.
Reads JSON from stdin, writes JSON to stdout.

Loads a saved model and applies correction to PV forecast slots.

Input schema:
{
  "slots": [{"start": "2026-04-03T10:00:00+02:00", "powerW": 3500, ...}],
  "features": {
    "weather": [{"hour": 10, "visibility_m": 20000, "cloud_cover_pct": 30, "humidity_pct": 60, "temp_c": 15}],
    "plant": {"tilt_deg": 35, "azimuth_deg": 180, "kwp": 10.0},
    "accuracy": {"mae_7d_solcast": 120, "mae_7d_pvlib": 80, "mae_7d_merged": 90}
  },
  "model_dir": "/opt/dvhub/ml-models",
  "model_type": "linear",
  "version": 1
}

Output schema (applied):
{"ok": true, "applied": true, "model": "linear v1", "corrected": [{"start": "...", "powerW": 3200, "rawPowerW": 3500}]}

Output schema (no model):
{"ok": true, "applied": false, "reason": "no_model"}

Output schema (error):
{"ok": false, "error": "description"}
"""

import sys
import json
import os
from datetime import datetime

import numpy as np
import pandas as pd
# Plan 08-06 Task 3: replace direct joblib.load with sha256-verified loader.
# Direct joblib.load is an RCE primitive if /opt/dvhub/models is ever writable
# by a compromised process. safe_load_model refuses unregistered or tampered
# files before joblib touches them.
from model_loader import safe_load_model

# Phase 07 MLAI-08: runtime schema version — must match meta.feature_schema_version
# written by ml_train.py save_model. Mismatch triggers fail-open in predict().
RUNTIME_FEATURE_SCHEMA_VERSION = 2   # Phase 07: must match model's feature_schema_version

# Must match ml_train.py FEATURE_COLS exactly (same names, same order — Pitfall ML-1)
FEATURE_COLS = [
    'visibility_m',
    'cloud_cover_pct',
    'humidity_pct',
    'temp_c',
    'hour',
    'month',
    'weekday',
    'tilt_deg',
    'azimuth_deg',
    'kwp',
    # MAE block — v2 adds pvnode at start, ml at end (5 features total)
    'mae_7d_pvnode',
    'mae_7d_solcast',
    'mae_7d_pvlib',
    'mae_7d_merged',
    'mae_7d_ml',
]


def build_feature_vector(slot, features):
    """Build a 13-feature vector for a single forecast slot."""
    # Parse temporal features from slot start time
    try:
        ts = datetime.fromisoformat(slot['start'])
        hour = ts.hour
        month = ts.month
        weekday = ts.weekday()
    except (KeyError, ValueError):
        hour = 0
        month = 1
        weekday = 0

    # Weather features: match by hour from features.weather array
    weather = {}
    weather_data = features.get('weather', [])
    for w in weather_data:
        if w.get('hour') == hour:
            weather = w
            break
    # If no match found and weather_data exists, use first entry as fallback
    if not weather and weather_data:
        weather = weather_data[0]

    # Plant features
    plant = features.get('plant', {})

    # Accuracy features
    accuracy = features.get('accuracy', {})

    return {
        'visibility_m': weather.get('visibility_m'),
        'cloud_cover_pct': weather.get('cloud_cover_pct'),
        'humidity_pct': weather.get('humidity_pct'),
        'temp_c': weather.get('temp_c'),
        'hour': hour,
        'month': month,
        'weekday': weekday,
        'tilt_deg': plant.get('tilt_deg'),
        'azimuth_deg': plant.get('azimuth_deg'),
        'kwp': plant.get('kwp'),
        # Phase 07 MLAI-08: 5 mae_7d_* features (v2 schema)
        'mae_7d_pvnode': accuracy.get('mae_7d_pvnode'),
        'mae_7d_solcast': accuracy.get('mae_7d_solcast'),
        'mae_7d_pvlib': accuracy.get('mae_7d_pvlib'),
        'mae_7d_merged': accuracy.get('mae_7d_merged'),
        'mae_7d_ml': accuracy.get('mae_7d_ml'),
    }


def predict(params):
    """Main prediction entrypoint."""
    slots = params.get('slots', [])
    features = params.get('features', {})
    model_dir = params.get('model_dir', '/opt/dvhub/ml-models')
    model_type = params.get('model_type', 'linear')
    version = params.get('version', 1)

    # Phase 07 MLAI-08 path handling: callers may pass an already-resolved
    # model_path directly (e.g. ml-schema-guard tests, promoteIfBetter), which
    # avoids the f-string template below. Fall back to the legacy template if
    # no explicit model_path is provided.
    model_path = params.get('model_path')
    if not model_path:
        model_name = f'pv_correction_{model_type}_v{version}'
        model_path = os.path.join(model_dir, model_name)

    # Check if model exists
    if not os.path.isdir(model_path):
        return {'ok': True, 'applied': False, 'reason': 'no_model'}

    # Phase 07 MLAI-08 Pitfall ML-1: fail-open schema-mismatch guard.
    # Compare the model's meta.feature_schema_version against this runtime's
    # RUNTIME_FEATURE_SCHEMA_VERSION. Any mismatch returns applied=false
    # WITHOUT raising — serving continues via raw forecast upstream.
    meta_path = os.path.join(model_path, 'meta.json')
    if os.path.isfile(meta_path):
        try:
            with open(meta_path) as f:
                meta = json.load(f)
            model_schema = meta.get('feature_schema_version', 1)
            if model_schema != RUNTIME_FEATURE_SCHEMA_VERSION:
                return {
                    'ok': True,
                    'applied': False,
                    'reason': 'schema_mismatch',
                    'model_version': model_schema,
                    'runtime_version': RUNTIME_FEATURE_SCHEMA_VERSION,
                }
        except Exception as meta_err:
            # Corrupt meta.json -> treat as schema mismatch (fail-open)
            return {
                'ok': True,
                'applied': False,
                'reason': 'meta_read_error',
                'error': str(meta_err),
                'runtime_version': RUNTIME_FEATURE_SCHEMA_VERSION,
            }

    if model_type == 'linear':
        model_file = os.path.join(model_path, 'model.joblib')
        scaler_file = os.path.join(model_path, 'scaler.joblib')
        if not os.path.isfile(model_file):
            return {'ok': True, 'applied': False, 'reason': 'no_model'}
        model = safe_load_model(model_file)
        scaler = safe_load_model(scaler_file) if os.path.isfile(scaler_file) else None
    else:
        import lightgbm as lgb
        model_file = os.path.join(model_path, 'model.txt')
        if not os.path.isfile(model_file):
            return {'ok': True, 'applied': False, 'reason': 'no_model'}
        model = lgb.Booster(model_file=model_file)
        scaler = None

    corrected = []
    for slot in slots:
        fv = build_feature_vector(slot, features)
        row = pd.DataFrame([fv], columns=FEATURE_COLS)

        if model_type == 'linear':
            # Missing features filled with 0 for linear
            row = row.fillna(0)
            if scaler is not None:
                row_scaled = scaler.transform(row)
            else:
                row_scaled = row.values
            pred = model.predict(row_scaled)[0]
        else:
            # LightGBM handles NaN natively — leave missing as NaN
            pred = model.predict(row.values)[0]

        # Clip to >= 0
        pred = float(max(0, pred))

        corrected.append({
            'start': slot.get('start', ''),
            'powerW': round(pred, 1),
            'rawPowerW': slot.get('powerW', 0),
        })

    return {
        'ok': True,
        'applied': True,
        'model': f'{model_type} v{version}',
        'corrected': corrected,
    }


if __name__ == '__main__':
    try:
        params = json.load(sys.stdin)
        result = predict(params)
        json.dump(result, sys.stdout)
    except Exception as e:
        json.dump({'ok': False, 'error': str(e)}, sys.stdout)
