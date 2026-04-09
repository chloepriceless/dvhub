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
import joblib

# Must match ml_train.py
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
    'mae_7d_solcast',
    'mae_7d_pvlib',
    'mae_7d_merged',
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
        'mae_7d_solcast': accuracy.get('mae_7d_solcast'),
        'mae_7d_pvlib': accuracy.get('mae_7d_pvlib'),
        'mae_7d_merged': accuracy.get('mae_7d_merged'),
    }


def predict(params):
    """Main prediction entrypoint."""
    slots = params.get('slots', [])
    features = params.get('features', {})
    model_dir = params.get('model_dir', '/opt/dvhub/ml-models')
    model_type = params.get('model_type', 'linear')
    version = params.get('version', 1)

    model_name = f'pv_correction_{model_type}_v{version}'
    model_path = os.path.join(model_dir, model_name)

    # Check if model exists
    if not os.path.isdir(model_path):
        return {'ok': True, 'applied': False, 'reason': 'no_model'}

    if model_type == 'linear':
        model_file = os.path.join(model_path, 'model.joblib')
        scaler_file = os.path.join(model_path, 'scaler.joblib')
        if not os.path.isfile(model_file):
            return {'ok': True, 'applied': False, 'reason': 'no_model'}
        model = joblib.load(model_file)
        scaler = joblib.load(scaler_file) if os.path.isfile(scaler_file) else None
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
