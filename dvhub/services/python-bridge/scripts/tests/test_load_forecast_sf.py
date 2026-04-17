"""Test load_forecast_sf.py resample + variance + MSTL fallback (Phase 07 FORE-12)."""
import datetime
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

# Import the forecast_load function
from load_forecast_sf import forecast_load  # noqa: E402


def make_history(hours, value_fn, start=None):
    """Generate 15-min slots across N hours. value_fn(hour_index) returns W."""
    start = start or datetime.datetime(2026, 3, 1, 0, 0, 0, tzinfo=datetime.timezone.utc)
    rows = []
    total_slots = hours * 4
    for i in range(total_slots):
        t = start + datetime.timedelta(minutes=15 * i)
        # value_fn takes floating hour index so we can model intra-hour variance
        hour_idx = i / 4.0
        rows.append({
            'ts_utc': t.isoformat(),
            'power_w': float(value_fn(hour_idx))
        })
    return rows


class TestLoadForecastFix(unittest.TestCase):

    def test_variance_guard_rejects_flat_input(self):
        """Near-constant input (std < 1W) must return ok:False per Pitfall SF-1."""
        history = make_history(hours=100, value_fn=lambda h: 800.0)  # constant 800W
        result = forecast_load({'history': history, 'horizon': 24, 'tier': 2, 'use_mstl': False})
        self.assertIsInstance(result, dict)
        self.assertFalse(result.get('ok', True))
        self.assertIn('variance', result.get('error', '').lower())

    def test_resample_produces_hourly_count(self):
        """72 hours × 4 slots = 288 input rows → 72 hourly rows post-resample."""
        # Realistic daily pattern: 200W baseline + 1500W * |sin(hour/24 * 2π)|
        history = make_history(
            hours=72,
            value_fn=lambda h: 200.0 + 1500.0 * abs(math.sin(h * math.pi / 12))
        )
        result = forecast_load({'history': history, 'horizon': 24, 'tier': 2, 'use_mstl': False})
        # With variance OK and len>=48 hourly rows, forecast_load should return a list of slots
        self.assertIsInstance(result, list, f"Expected list, got: {result}")
        self.assertEqual(len(result), 24)
        # REVIEWS low-cost: assert non-flat output on non-flat fixture
        values = [s.get('power_w', 0) for s in result]
        unique_values = set(round(v, 1) for v in values)
        self.assertGreater(
            len(unique_values), 1,
            f"Expected non-flat forecast output, got {len(unique_values)} unique values"
        )

    def test_insufficient_history_after_resample(self):
        """<48 hourly rows must return ok:False."""
        # 40 hours of data → 40 hourly rows post-resample (below 48 threshold)
        history = make_history(
            hours=40,
            value_fn=lambda h: 200.0 + 500.0 * abs(math.sin(h * math.pi / 12))
        )
        result = forecast_load({'history': history, 'horizon': 24, 'tier': 2, 'use_mstl': False})
        self.assertIsInstance(result, dict)
        self.assertFalse(result.get('ok', True))
        self.assertIn('insufficient', result.get('error', '').lower())


if __name__ == '__main__':
    unittest.main()
