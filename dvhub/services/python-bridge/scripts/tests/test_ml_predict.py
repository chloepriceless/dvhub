"""Test ml_predict.py schema-version guard (Phase 07 MLAI-08).

Verifies fail-open behaviour when the on-disk model's feature_schema_version
does not match the runtime version. Uses a synthetic model directory so no
real joblib/lightgbm model files are needed.
"""
import json
import os
import sys
import tempfile
import unittest

# Ensure scripts/ is on sys.path so `from ml_predict import predict` resolves.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from ml_predict import predict, RUNTIME_FEATURE_SCHEMA_VERSION  # noqa: E402


class TestSchemaGuard(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def _write_meta(self, version):
        with open(os.path.join(self.tmpdir, 'meta.json'), 'w') as f:
            json.dump({
                'feature_schema_version': version,
                'model_type': 'lightgbm',
                'features': []
            }, f)

    def test_schema_mismatch_returns_fail_open(self):
        """Old v1 model + v2 runtime must return applied=false without raising."""
        self._write_meta(1)
        result = predict({'model_path': self.tmpdir, 'slots': [], 'features': {}})
        self.assertTrue(result.get('ok'))
        self.assertFalse(result.get('applied'))
        self.assertEqual(result.get('reason'), 'schema_mismatch')
        self.assertEqual(result.get('model_version'), 1)
        self.assertEqual(result.get('runtime_version'), RUNTIME_FEATURE_SCHEMA_VERSION)

    def test_schema_match_does_not_shortcircuit(self):
        """Matching version must NOT return schema_mismatch (reason is either no_model or absent)."""
        self._write_meta(2)
        result = predict({'model_path': self.tmpdir, 'slots': [], 'features': {}})
        # No model artifact exists in tmpdir, so the expected outcome is
        # no_model (applied=false) — but critically NOT schema_mismatch.
        self.assertNotEqual(result.get('reason'), 'schema_mismatch')

    def test_meta_missing_does_not_trigger_guard(self):
        """If meta.json is absent entirely, predict must fall through to the
        existing no_model path (backward-compat with pre-v2 models)."""
        result = predict({'model_path': self.tmpdir, 'slots': [], 'features': {}})
        self.assertNotEqual(result.get('reason'), 'schema_mismatch')

    def test_corrupt_meta_json_fails_open(self):
        """Malformed meta.json must return applied=false with reason=meta_read_error."""
        with open(os.path.join(self.tmpdir, 'meta.json'), 'w') as f:
            f.write('{ this is not valid json')
        result = predict({'model_path': self.tmpdir, 'slots': [], 'features': {}})
        self.assertTrue(result.get('ok'))
        self.assertFalse(result.get('applied'))
        self.assertEqual(result.get('reason'), 'meta_read_error')


if __name__ == '__main__':
    unittest.main()
