#!/usr/bin/env python3
"""
StatsForecast load prediction script.
Reads JSON from stdin, writes JSON to stdout.

Produces hourly kWh load forecast using StatsForecast (Nixtla).
Same output contract as SQL rollups.

Tier 2 (use_mstl=false): AutoARIMA(season_length=24)
Tier 3 (use_mstl=true): MSTL(season_length=[24, 168], trend_forecaster=AutoARIMA())

Input schema:
{
  "history": [{"ts_utc": "2026-04-01T00:00:00Z", "power_w": 1200}],
  "horizon": 72,
  "use_mstl": true,
  "tier": 3
}

Output schema (success):
[{"ts_utc": "2026-04-04T00:00:00Z", "power_w": 1150.3, "confidence": 0.7}]

Output schema (error):
{"ok": false, "error": "description"}
"""

import sys
import json
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from statsforecast import StatsForecast
from statsforecast.models import AutoARIMA, MSTL


def forecast_load(params):
    """Main load forecast entrypoint."""
    history = params.get('history', [])
    horizon = params.get('horizon', 72)
    use_mstl = params.get('use_mstl', True)
    tier = params.get('tier', 3)

    if not history:
        return {'ok': False, 'error': 'No history data provided'}

    if len(history) < 48:
        return {'ok': False, 'error': f'Insufficient history: {len(history)} rows (minimum 48)'}

    # Build DataFrame in StatsForecast format
    df = pd.DataFrame(history)
    df['ds'] = pd.to_datetime(df['ts_utc'], utc=True)
    df['y'] = df['power_w'].astype(float)
    df['unique_id'] = 'load'
    df = df[['unique_id', 'ds', 'y']].sort_values('ds').reset_index(drop=True)

    # Phase 07 FORE-12 Fix (Pitfall SF-1 root cause): 15min → 1h resample BEFORE StatsForecast(freq='h').
    # AutoARIMA with freq='h' on 15-min indexed data degenerates to flat predictions.
    # Source: RESEARCH Pattern 3, Pitfall SF-1 (canonical Nixtla electricity-load-forecasting flow).
    df_hourly = (
        df.set_index('ds')[['y']]
        .resample('1h')
        .mean()
        .dropna()
        .reset_index()
    )
    df_hourly['unique_id'] = 'load'
    df_hourly = df_hourly[['unique_id', 'ds', 'y']]

    # Guard: need ≥48 hourly samples (2 days) post-resample
    if len(df_hourly) < 48:
        return {
            'ok': False,
            'error': f'Insufficient hourly history after resample: {len(df_hourly)}'
        }

    # Phase 07 FORE-12: variance sanity check — flat input → flat output; surface it
    if df_hourly['y'].std() < 1.0:
        return {
            'ok': False,
            'error': 'Input data has near-zero variance (std<1W) — degenerate'
        }

    # Pitfall SF-3: MSTL requires ≥336 hourly samples (2× longest season = 2 × 168h)
    if use_mstl and tier >= 3 and len(df_hourly) < 336:
        use_mstl = False

    # Select model based on tier and use_mstl flag
    if use_mstl and tier >= 3:
        # Tier 3: MSTL with daily (24h) and weekly (168h) seasonality
        models = [
            MSTL(season_length=[24, 168], trend_forecaster=AutoARIMA())
        ]
    else:
        # Tier 2: Simple AutoARIMA with daily seasonality
        models = [
            AutoARIMA(season_length=24)
        ]

    sf = StatsForecast(models=models, freq='h', n_jobs=1)
    forecast_df = sf.forecast(df=df_hourly, h=horizon)

    # Extract forecast column name (varies by model)
    forecast_col = None
    for col in forecast_df.columns:
        if col not in ('unique_id', 'ds'):
            forecast_col = col
            break

    if forecast_col is None:
        return {'ok': False, 'error': 'No forecast column found in output'}

    result = []
    for _, row in forecast_df.iterrows():
        ts = row['ds']
        power = float(row[forecast_col])
        # Clip to >= 0, round to 1 decimal
        power = round(max(0, power), 1)

        # Format timestamp as ISO string
        if hasattr(ts, 'isoformat'):
            ts_str = ts.isoformat()
        else:
            ts_str = str(ts)

        result.append({
            'ts_utc': ts_str,
            'power_w': power,
            'confidence': 0.7,
        })

    return result


if __name__ == '__main__':
    try:
        params = json.load(sys.stdin)
        result = forecast_load(params)
        json.dump(result, sys.stdout)
    except Exception as e:
        json.dump({'ok': False, 'error': str(e)}, sys.stdout)
