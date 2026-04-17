#!/usr/bin/env python3
"""
ML training script for PV forecast correction.
Reads JSON from stdin, writes JSON to stdout.

Two-stage approach:
  Stage 1 (data_days < 90): Linear Regression with StandardScaler
  Stage 2 (data_days >= 90): LightGBM gradient boosting

Input schema:
{
  "training_data": [{ ... 13 feature columns + theoretical_power_w target ... }],
  "data_days": 60,
  "version": 1,
  "previous_mae": null,
  "model_dir": "/opt/dvhub/ml-models"
}

Output schema (success):
{"ok": true, "model_type": "linear"|"lightgbm", "mae": 123.4, "version": 1, "model_path": "..."}

Output schema (rollback):
{"ok": false, "reason": "rollback", "new_mae": 150.0, "previous_mae": 120.0}

Output schema (error):
{"ok": false, "error": "description"}
"""

import sys
import json
import os
import datetime

import numpy as np
import pandas as pd
import joblib
from sklearn.linear_model import LinearRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import mean_absolute_error

# Phase 07 MLAI-08: feature-schema version + held-out slice reserve.
# v1 (pre-Phase-07) = 13 features, 3 constant-zero MAE columns.
# v2 (Phase 07)     = 15 features, 5 real mae_7d_* from accuracy_tracker.
FEATURE_SCHEMA_VERSION = 2   # Phase 07 MLAI-08: v1=3 constant-zero MAE; v2=5 real mae_7d_*
HELD_OUT_DAYS = 3            # Pattern 5: reserve last days for promotion evaluation

# 15 feature columns per D-C2 (Phase 07):
# Weather: visibility_m, cloud_cover_pct, humidity_pct, temp_c
# Temporal: hour, month, weekday
# Plant: tilt_deg, azimuth_deg, kwp
# Accuracy (5 real MAE): mae_7d_pvnode, mae_7d_solcast, mae_7d_pvlib, mae_7d_merged, mae_7d_ml
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

TARGET_COL = 'theoretical_power_w'

# Rollback threshold: 10% by default (overridable via input)
DEFAULT_ROLLBACK_THRESHOLD = 1.10


def validate_data(df):
    """Validate training data has required columns and shape (T-05-01 mitigation)."""
    missing = [c for c in FEATURE_COLS if c not in df.columns]
    if missing:
        raise ValueError(f'Missing feature columns: {missing}')
    if TARGET_COL not in df.columns:
        raise ValueError(f'Missing target column: {TARGET_COL}')
    if len(df) < 24:
        raise ValueError(f'Insufficient training data: {len(df)} rows (minimum 24)')
    # Phase 07 MLAI-08: FEATURE_COLS v2 = 15 features (was 13 in v1)
    if len(FEATURE_COLS) != 15:
        raise ValueError(f'Expected 15 feature columns (schema v2), got {len(FEATURE_COLS)}')


def train_linear(X_train, y_train, X_val, y_val):
    """Train Stage 1: Linear Regression with StandardScaler."""
    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train)
    X_val_scaled = scaler.transform(X_val)

    model = LinearRegression()
    model.fit(X_train_scaled, y_train)

    y_pred = model.predict(X_val_scaled)
    y_pred = np.clip(y_pred, 0, None)
    mae = float(mean_absolute_error(y_val, y_pred))

    return model, scaler, mae


def train_lightgbm(X_train, y_train, X_val, y_val):
    """Train Stage 2: LightGBM gradient boosting."""
    import lightgbm as lgb

    train_data = lgb.Dataset(X_train, label=y_train)
    val_data = lgb.Dataset(X_val, label=y_val, reference=train_data)

    params = {
        'objective': 'regression',
        'metric': 'mae',
        'num_leaves': 31,
        'learning_rate': 0.05,
        'feature_fraction': 0.8,
        'verbose': -1,
    }

    callbacks = [lgb.early_stopping(50, verbose=False)]

    model = lgb.train(
        params,
        train_data,
        num_boost_round=500,
        valid_sets=[val_data],
        callbacks=callbacks,
    )

    y_pred = model.predict(X_val.values if hasattr(X_val, 'values') else X_val)
    y_pred = np.clip(y_pred, 0, None)
    mae = float(mean_absolute_error(y_val, y_pred))

    return model, mae


def save_model(model, scaler, model_type, version, mae, model_dir, n_samples, feature_cols):
    """Save model, scaler, and metadata to model_dir."""
    model_name = f'pv_correction_{model_type}_v{version}'
    model_path = os.path.join(model_dir, model_name)
    os.makedirs(model_path, exist_ok=True)

    if model_type == 'linear':
        joblib.dump(model, os.path.join(model_path, 'model.joblib'))
        joblib.dump(scaler, os.path.join(model_path, 'scaler.joblib'))
    else:
        model.save_model(os.path.join(model_path, 'model.txt'))

    meta = {
        'model_type': model_type,
        'version': version,
        'feature_schema_version': FEATURE_SCHEMA_VERSION,   # Phase 07 MLAI-08
        'mae': mae,
        'features': list(feature_cols),
        'n_samples': n_samples,
        'trained_at': datetime.datetime.utcnow().isoformat() + 'Z',
    }
    with open(os.path.join(model_path, 'meta.json'), 'w') as f:
        json.dump(meta, f, indent=2)

    return model_path


def train(params):
    """Main training entrypoint."""
    training_data = params.get('training_data', [])
    data_days = params.get('data_days', 0)
    version = params.get('version', 1)
    previous_mae = params.get('previous_mae')
    model_dir = params.get('model_dir', '/opt/dvhub/ml-models')
    rollback_threshold = params.get('rollback_threshold', DEFAULT_ROLLBACK_THRESHOLD)

    if not training_data:
        return {'ok': False, 'error': 'No training data provided'}

    df = pd.DataFrame(training_data)
    validate_data(df)

    # Fill missing features with 0
    df[FEATURE_COLS] = df[FEATURE_COLS].fillna(0)

    # Sliding window: only use last 365 days of data (D-05)
    max_rows = 365 * 24
    if len(df) > max_rows:
        df = df.iloc[-max_rows:]

    # Phase 07 MLAI-08 Pattern 5: reserve last HELD_OUT_DAYS of training window
    # as a held-out slice for Node-side promoteIfBetter evaluation. The slice is
    # dumped to held_out_slice.parquet (CSV fallback) so ml_load_heldout.py can
    # consume it later.
    held_out_df = pd.DataFrame()
    if 'ts_utc' in df.columns:
        # Timestamp-aware split — honours the real calendar cutoff.
        df = df.sort_values('ts_utc')
        ts_series = pd.to_datetime(df['ts_utc'], utc=True, errors='coerce')
        if ts_series.notna().any():
            cutoff = ts_series.max() - pd.Timedelta(days=HELD_OUT_DAYS)
            mask_train = ts_series < cutoff
            held_out_df = df[~mask_train].copy()
            df = df[mask_train].copy()
    else:
        # Row-count fallback — approximate HELD_OUT_DAYS worth of hourly rows.
        held_out_rows = min(HELD_OUT_DAYS * 24, max(0, len(df) - 24))
        if held_out_rows > 0:
            held_out_df = df.iloc[-held_out_rows:].copy()
            df = df.iloc[:-held_out_rows].copy()

    X = df[FEATURE_COLS]
    y = df[TARGET_COL]

    # Train/validation split: 80/20, shuffle=False (time series)
    split_idx = int(len(df) * 0.8)
    X_train, X_val = X.iloc[:split_idx], X.iloc[split_idx:]
    y_train, y_val = y.iloc[:split_idx], y.iloc[split_idx:]

    n_samples = len(df)

    if data_days >= 90:
        # Stage 2: LightGBM
        model, mae = train_lightgbm(X_train, y_train, X_val, y_val)
        model_type = 'lightgbm'
        scaler = None
    else:
        # Stage 1: Linear Regression
        model, scaler, mae = train_linear(X_train, y_train, X_val, y_val)
        model_type = 'linear'

    # Rollback check (D-07): reject if new MAE > previous_mae * threshold
    if previous_mae is not None and mae > previous_mae * rollback_threshold:
        return {
            'ok': False,
            'reason': 'rollback',
            'new_mae': mae,
            'previous_mae': previous_mae,
        }

    model_path = save_model(model, scaler, model_type, version, mae, model_dir, n_samples, FEATURE_COLS)

    # Phase 07 MLAI-08 REVIEWS H12: dump held-out slice alongside model for
    # promoteIfBetter consumption via ml_load_heldout.py.
    held_out_slice_path = None
    if len(held_out_df) > 0:
        # Project held-out to the same feature + target shape.
        held_out_cols = [c for c in FEATURE_COLS if c in held_out_df.columns]
        held_out_cols = held_out_cols + [TARGET_COL] if TARGET_COL in held_out_df.columns else held_out_cols
        ts_cols = [c for c in ('ts_utc',) if c in held_out_df.columns]
        held_out_out = held_out_df[ts_cols + held_out_cols].copy()
        # Provide y_true alias for ml_eval.py (prefers y_true over target col name).
        if TARGET_COL in held_out_out.columns:
            held_out_out['y_true'] = held_out_out[TARGET_COL]
        held_out_slice_path = os.path.join(model_path, 'held_out_slice.parquet')
        try:
            held_out_out.to_parquet(held_out_slice_path, index=False)
        except Exception:
            held_out_slice_path = held_out_slice_path.replace('.parquet', '.csv')
            held_out_out.to_csv(held_out_slice_path, index=False)

    return {
        'ok': True,
        'model_type': model_type,
        'mae': mae,
        'version': version,
        'model_path': model_path,
        'feature_schema_version': FEATURE_SCHEMA_VERSION,
        'held_out_slice_path': held_out_slice_path,
        'n_samples': n_samples,
    }


if __name__ == '__main__':
    try:
        params = json.load(sys.stdin)
        result = train(params)
        json.dump(result, sys.stdout)
    except Exception as e:
        json.dump({'ok': False, 'error': str(e)}, sys.stdout)
