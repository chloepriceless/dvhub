#!/usr/bin/env bash
# forecast-provision.sh -- Idempotent provisioning of the DVhub Forecast/ML
# Python venv (/opt/dvhub/forecast-venv).
#
# Single source of truth for the Python forecast + ML environment, SHARED by
# install.sh (fresh install, synchronous) and post-update.sh (retrofit on
# existing boxes, decoupled in the background) so the two never drift -- same
# pattern as eos-provision.sh / support-provision.sh. Must be run as root.
#
# Holds the full ML/forecast stack (pvlib, lightgbm, scikit-learn, statsforecast,
# numpy/scipy/pandas, ...), hash-pinned in python/requirements.lock
# (--require-hashes). Runtime consumer: services/python-bridge/index.js
# (VENV_PYTHON = $VENV_DIR/bin/python3).
#
# Idempotent: create the venv if missing; only run the heavy pip install when the
# requirements lockfile changed since the last SUCCESSFUL run (marker
# $DATA_DIR/.forecast-venv.lockhash). Safe to run repeatedly. NON-FATAL contract
# is enforced by the CALLER (install.sh subshell / post-update.sh background unit).
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/dvhub}"
APP_DIR="${APP_DIR:-$INSTALL_DIR/dvhub}"
SERVICE_USER="${SERVICE_USER:-dvhub}"
DATA_DIR="${DATA_DIR:-${DV_DATA_DIR:-/var/lib/dvhub}}"
VENV_DIR="${FORECAST_VENV:-$INSTALL_DIR/forecast-venv}"
ML_MODELS_DIR="$INSTALL_DIR/ml-models"
REQUIREMENTS="$APP_DIR/python/requirements.txt"
REQUIREMENTS_LOCK="$APP_DIR/python/requirements.lock"
MARKER="$DATA_DIR/.forecast-venv.lockhash"

if [[ "${EUID}" -ne 0 ]]; then
  echo "  Forecast: forecast-provision.sh muss als root laufen — uebersprungen" >&2
  exit 1
fi

# No Python3 → the PV forecast runs in the Solcast/HTTP tier (no local venv).
if ! command -v python3 >/dev/null 2>&1; then
  echo "  Forecast: Python3 nicht gefunden — PV-Forecast laeuft im Solcast/HTTP-Tier (kein lokales venv)."
  exit 0
fi

# Prefer the hash-pinned lockfile; fall back to requirements.txt.
SRC_FILE="$REQUIREMENTS_LOCK"
[[ -f "$SRC_FILE" ]] || SRC_FILE="$REQUIREMENTS"
if [[ ! -f "$SRC_FILE" ]]; then
  echo "  Forecast: keine requirements(.lock) in $APP_DIR/python — uebersprungen."
  exit 0
fi

# Idempotency: skip the heavy pip install when the venv already exists AND the
# requirements file is byte-identical to the last successful provision.
CUR_HASH="$(sha256sum "$SRC_FILE" | awk '{print $1}')"
PREV_HASH="$(cat "$MARKER" 2>/dev/null || echo '')"
if [[ -x "$VENV_DIR/bin/python3" && "$CUR_HASH" == "$PREV_HASH" ]]; then
  echo "  Forecast-venv: aktuell (requirements unveraendert) — uebersprungen."
  exit 0
fi

echo "  Forecast: richte Python-venv ein/aktualisiere ($VENV_DIR) ..."

# Ensure python3-venv ACTUALLY works (T-0118 probe): `venv --help` succeeds even
# without ensurepip, so probe with a real throwaway venv creation.
if ! python3 -m venv /tmp/_dvhub_fc_venvtest >/dev/null 2>&1; then
  echo "  Forecast: installiere python3-venv/pip ..."
  apt-get install -y python3-venv python3-pip >/dev/null 2>&1 || true
fi
rm -rf /tmp/_dvhub_fc_venvtest

mkdir -p "$(dirname "$VENV_DIR")"
[[ -d "$VENV_DIR" ]] || python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/pip" install --upgrade pip
if [[ "$SRC_FILE" == "$REQUIREMENTS_LOCK" ]]; then
  # --require-hashes rejects any wheel whose sha256 is not in the lockfile,
  # blocking transitive-dep substitution + upstream PyPI compromise.
  echo "  Forecast: pip install --require-hashes ($REQUIREMENTS_LOCK)"
  "$VENV_DIR/bin/pip" install --require-hashes --no-deps -r "$REQUIREMENTS_LOCK"
else
  echo "  Forecast: pip install ($REQUIREMENTS)"
  "$VENV_DIR/bin/pip" install -r "$REQUIREMENTS"
fi

# ML model directory (was a separate install.sh step; folded in here so the
# update path provisions it too).
mkdir -p "$ML_MODELS_DIR"

# Ownership: the systemd user must be able to execute the venv + write models.
chown -R "$SERVICE_USER:$SERVICE_USER" "$VENV_DIR" "$ML_MODELS_DIR" 2>/dev/null || true

# Mark success so the next boot's post-update.sh can fast-skip (no pip per boot).
mkdir -p "$(dirname "$MARKER")"
echo "$CUR_HASH" > "$MARKER"
chown "$SERVICE_USER:$SERVICE_USER" "$MARKER" 2>/dev/null || true
echo "  Forecast-venv: bereit ($VENV_DIR)"
