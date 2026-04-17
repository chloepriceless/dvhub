#!/usr/bin/env python3
"""Phase 07 MLAI-08 REVIEWS H12: held-out slice loader.

Reads the parquet (or CSV fallback) dumped by ml_train.py into an in-memory
JSON list of rows that ml-training.js can forward to ml_eval.py.

Input schema:
{ "path": "/opt/dvhub/ml-models/pv_correction_lightgbm_v3/held_out_slice.parquet" }

Output schema (success):
{"ok": true, "rows": [ {features..., y_true: 2340.0 }, ... ]}

Output schema (error):
{"ok": false, "error": "..."}
"""
import json
import os
import sys
import traceback


def load_heldout(params):
    """Load the held-out slice at params['path'] and return rows-as-dicts."""
    path = params.get('path')
    if not path or not os.path.isfile(path):
        return {'ok': False, 'error': f'file not found: {path}'}

    import pandas as pd

    # Try parquet first, fall back to csv — matches the two-format write path
    # in ml_train.py (parquet preferred, CSV fallback when pyarrow/fastparquet
    # is unavailable).
    df = None
    if path.endswith('.parquet'):
        try:
            df = pd.read_parquet(path)
        except Exception as parquet_err:
            # Last-ditch attempt to read as CSV with the same name pattern.
            csv_path = path.replace('.parquet', '.csv')
            if os.path.isfile(csv_path):
                df = pd.read_csv(csv_path)
            else:
                return {'ok': False, 'error': f'parquet read failed: {parquet_err}'}
    elif path.endswith('.csv'):
        df = pd.read_csv(path)
    else:
        # Unknown extension — try parquet first, csv second.
        try:
            df = pd.read_parquet(path)
        except Exception:
            df = pd.read_csv(path)

    rows = df.to_dict(orient='records')
    return {'ok': True, 'rows': rows, 'n': len(rows)}


if __name__ == '__main__':
    try:
        params = json.loads(sys.stdin.read())
        result = load_heldout(params)
    except Exception as err:
        result = {'ok': False, 'error': str(err), 'traceback': traceback.format_exc()}
    sys.stdout.write(json.dumps(result))
