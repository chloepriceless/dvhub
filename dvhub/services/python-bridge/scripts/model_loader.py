"""Plan 08-06 Task 3: safe model loader with sha256 manifest verification.

joblib.load (and pickle.load) are arbitrary-code-execution capable. Any code path
that loads a .joblib / .pkl file is an RCE primitive if an attacker can write to
the model file (compromised git pull, supply-chain swap of an artefact, write
access to /opt/dvhub/models, etc).

This module wraps joblib.load with a sha256 check against a pinned manifest. The
manifest is plain JSON: { "<basename>": "<sha256-hex>" }. Loading a model whose
sha256 does not match its manifest entry — or whose basename has no entry at all
— raises ValueError before joblib touches the file.

Manifest path is configurable via DVHUB_MODEL_MANIFEST env var; default is
/opt/dvhub/models/manifest.json (matches the install.sh model layout).

Usage:
    from model_loader import safe_load_model
    model = safe_load_model('/opt/dvhub/models/pv/model.joblib')

Utility (CLI): print sha256 for a file so the operator can paste it into the
manifest:
    python model_loader.py /opt/dvhub/models/pv/model.joblib
"""

import hashlib
import json
import os
import sys

DEFAULT_MANIFEST_PATH = '/opt/dvhub/models/manifest.json'


def _manifest_path():
    return os.environ.get('DVHUB_MODEL_MANIFEST', DEFAULT_MANIFEST_PATH)


def _load_manifest():
    path = _manifest_path()
    if not os.path.isfile(path):
        return {}
    with open(path, 'r', encoding='utf-8') as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise ValueError(f'manifest at {path} is not a JSON object')
    return data


def sha256_of(path):
    """Return hex sha256 of a file. Used both at load time and for the CLI helper."""
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for chunk in iter(lambda: fh.read(65536), b''):
            h.update(chunk)
    return h.hexdigest()


def safe_load_model(path):
    """Verify sha256 against the manifest, then joblib.load.

    Raises:
        IOError: file does not exist.
        ValueError: file's basename is not in the manifest, or sha256 mismatch.
    """
    if not os.path.isfile(path):
        raise IOError(f'model not found: {path}')

    manifest = _load_manifest()
    key = os.path.basename(path)
    expected = manifest.get(key)
    if not expected:
        raise ValueError(
            f'refusing to load unregistered model {path}; '
            f'add sha256 entry for "{key}" to {_manifest_path()}'
        )

    actual = sha256_of(path)
    if actual != expected:
        raise ValueError(
            f'sha256 mismatch for {path}: '
            f'manifest expected {expected}, file has {actual}'
        )

    # Defer the joblib import so callers that only need sha256_of() (e.g. test
    # rigs, the CLI helper below) don't pay the joblib import cost.
    import joblib  # noqa: WPS433
    return joblib.load(path)


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print('usage: python model_loader.py <model.joblib>', file=sys.stderr)
        sys.exit(2)
    print(sha256_of(sys.argv[1]))
