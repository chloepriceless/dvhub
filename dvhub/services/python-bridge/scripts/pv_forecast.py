#!/usr/bin/env python3
"""
PV forecast calculation using pvlib.
Reads JSON from stdin, writes JSON to stdout.

Input schema:
{
  "lat": 48.15, "lon": 9.48,
  "start": "2026-04-03T00:00:00",
  "periods": 288,
  "tilt": 35, "azimuth": 180, "kwp": 10.0,
  "strings": [],
  "weather": [{ "timestamp": "...", "ghi": 500, "dni": 400, "dhi": 100, "temperature": 15, "wind_speed": 3 }]
}

Output schema:
[{ "ts": "2026-04-03T00:15:00+02:00", "power_w": 3500.0 }]

Supports multi-string configuration (D-11 detailed mode):
If strings[] is non-empty, computes per-string and sums power.
"""

import sys
import json
import pvlib
import pandas as pd


def compute_pv_forecast(params):
    """Compute PV forecast for a single string/system configuration."""
    location = pvlib.location.Location(params['lat'], params['lon'])
    times = pd.date_range(
        params['start'], periods=params.get('periods', 288),
        freq='15min', tz='Europe/Berlin'
    )
    system = pvlib.pvsystem.PVSystem(
        surface_tilt=params.get('tilt', 35),
        surface_azimuth=params.get('azimuth', 180),
        module_parameters={'pdc0': params['kwp'] * 1000, 'gamma_pdc': -0.004},
        inverter_parameters={'pdc0': params['kwp'] * 1000},
        temperature_model_parameters=pvlib.temperature.TEMPERATURE_MODEL_PARAMETERS['sapm']['open_rack_glass_glass']
    )
    # PVWatts DC/AC models are inferred from the pdc0/gamma_pdc parameters, but
    # pvlib >= 0.10 can no longer INFER the AOI/spectral loss models from a
    # PVWatts-only module_parameters dict — they must be set explicitly or
    # ModelChain.__init__ raises ("could not infer AOI model"). 'no_loss'
    # disables the optical-loss correction (negligible for a yield forecast).
    mc = pvlib.modelchain.ModelChain(
        system, location,
        aoi_model='no_loss',
        spectral_model='no_loss'
    )

    if params.get('weather'):
        weather_df = pd.DataFrame(params['weather'])
        weather_df.index = pd.DatetimeIndex(weather_df['timestamp'], tz='UTC')
        weather_df = weather_df.rename(columns={
            'ghi': 'ghi', 'dni': 'dni', 'dhi': 'dhi',
            'temperature': 'temp_air', 'wind_speed': 'wind_speed'
        })
        mc.run_model(weather_df)
    else:
        cs = location.get_clearsky(times)
        mc.run_model(cs)

    result = mc.results.ac.fillna(0).clip(lower=0)
    return [{'ts': str(t), 'power_w': round(float(v), 1)} for t, v in result.items()]


def compute_multi_string(params):
    """Compute PV forecast for multiple strings and sum power."""
    total = []
    for s in params['strings']:
        s_params = {
            **params,
            'kwp': s['kwp'],
            'tilt': s.get('tiltDeg', 35),
            'azimuth': s.get('azimuthDeg', 180)
        }
        total.append(compute_pv_forecast(s_params))

    # Merge by timestamp: sum power_w across strings
    merged = {}
    for string_result in total:
        for entry in string_result:
            ts = entry['ts']
            merged[ts] = merged.get(ts, 0) + entry['power_w']

    return [{'ts': ts, 'power_w': round(pw, 1)} for ts, pw in sorted(merged.items())]


if __name__ == '__main__':
    params = json.load(sys.stdin)
    if params.get('strings') and len(params['strings']) > 0:
        result = compute_multi_string(params)
    else:
        result = compute_pv_forecast(params)
    json.dump(result, sys.stdout)
