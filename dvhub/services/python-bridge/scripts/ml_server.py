#!/usr/bin/env python3
"""
Persistent Python JSON-RPC server for Tier 3.
Reads JSON-RPC 2.0 requests from stdin (newline-delimited), writes responses to stdout.

Methods:
  - predict: calls ml_predict logic
  - train: calls ml_train logic
  - load_forecast: calls load_forecast_sf logic
  - health: returns {"ok": true, "models_loaded": [...]}
  - shutdown: exits gracefully

Response format:
  {"jsonrpc": "2.0", "id": N, "result": {...}}
  {"jsonrpc": "2.0", "id": N, "error": {"code": -32000, "message": "..."}}

Unknown method: error code -32601
Parse errors: skip malformed lines silently
"""

import sys
import json
import os

# Import sibling modules from same directory
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import ml_train
import ml_predict
import load_forecast_sf

# Cache for loaded models (Tier 3 keeps models in memory)
loaded_models = {}


def handle_predict(params):
    """Handle predict JSON-RPC method."""
    return ml_predict.predict(params)


def handle_train(params):
    """Handle train JSON-RPC method."""
    return ml_train.train(params)


def handle_load_forecast(params):
    """Handle load_forecast JSON-RPC method."""
    return load_forecast_sf.forecast_load(params)


def handle_health(params):
    """Handle health JSON-RPC method."""
    return {
        'ok': True,
        'models_loaded': list(loaded_models.keys()),
    }


def handle_shutdown(params):
    """Handle shutdown JSON-RPC method -- exits gracefully."""
    return {'ok': True, 'message': 'shutting down'}


# Method dispatch table
METHODS = {
    'predict': handle_predict,
    'train': handle_train,
    'load_forecast': handle_load_forecast,
    'health': handle_health,
    'shutdown': handle_shutdown,
}


def make_response(req_id, result):
    """Create a JSON-RPC 2.0 success response."""
    return {
        'jsonrpc': '2.0',
        'id': req_id,
        'result': result,
    }


def make_error(req_id, code, message):
    """Create a JSON-RPC 2.0 error response."""
    return {
        'jsonrpc': '2.0',
        'id': req_id,
        'error': {
            'code': code,
            'message': message,
        },
    }


def process_request(line):
    """Process a single JSON-RPC request line. Returns response dict or None."""
    try:
        request = json.loads(line)
    except (json.JSONDecodeError, ValueError):
        # Parse error: skip malformed lines silently
        return None

    if not isinstance(request, dict):
        return None

    req_id = request.get('id')
    method = request.get('method', '')
    params = request.get('params', {})

    if method not in METHODS:
        return make_error(req_id, -32601, f'Method not found: {method}')

    try:
        result = METHODS[method](params)
        return make_response(req_id, result)
    except Exception as e:
        return make_error(req_id, -32000, str(e))


def main():
    """Main server loop: read JSON-RPC requests from stdin, write responses to stdout."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        response = process_request(line)
        if response is None:
            continue

        # Write response as single line followed by newline
        sys.stdout.write(json.dumps(response) + '\n')
        sys.stdout.flush()

        # Check if shutdown was requested
        try:
            request = json.loads(line)
            if isinstance(request, dict) and request.get('method') == 'shutdown':
                break
        except (json.JSONDecodeError, ValueError):
            pass


if __name__ == '__main__':
    main()
