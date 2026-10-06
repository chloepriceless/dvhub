#!/usr/bin/env bash
# forecast-provision.sh -- Idempotent provisioning of the DVhub forecast
# Python venv (/opt/dvhub/forecast-venv).
#
# Single source of truth for the Python forecast environment, SHARED by
# install.sh (fresh install, synchronous) and post-update.sh (retrofit on
# existing boxes, decoupled in the background) so the two never drift -- same
# pattern as eos-provision.sh / support-provision.sh. Must be run as root.
#
# Holds the forecast stack (pvlib, statsforecast, numpy/scipy/pandas, ...),
# hash-pinned in python/requirements.lock
# (--require-hashes). Runtime consumer: services/python-bridge/index.js
# (VENV_PYTHON = $VENV_DIR/bin/python3).
#
# Idempotent: create the venv if missing; only run the heavy pip install when the
# requirements lockfile changed since the last SUCCESSFUL run (marker
# $DATA_DIR/.forecast-venv.lockhash). Safe to run repeatedly. NON-FATAL contract
# is enforced by the CALLER (install.sh subshell / post-update.sh background unit).
#
# Fehlschlag sichtbar und begrenzt (Kundenfall deye1, 2026-10-06 — dort blieb ein
# venv OHNE Pakete zurück, unbemerkt, und jeder Dienststart versuchte es erneut):
#   - Python-Version wird VOR dem venv geprüft (das Lockfile braucht >= MIN_PYTHON).
#   - Der Grund eines Fehlschlags steht in $DATA_DIR/forecast-venv-status.json;
#     DVhub liest die Datei und meldet sie im Protokoll (python_env_incomplete).
#   - Derselbe Fehlschlag (gleiches Lockfile, gleiche Python-Version) wird
#     frühestens nach RETRY_AFTER_S erneut versucht. --force übergeht das.
#
# Usage: sudo bash forecast-provision.sh [--force]
set -euo pipefail

FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

INSTALL_DIR="${INSTALL_DIR:-/opt/dvhub}"
APP_DIR="${APP_DIR:-$INSTALL_DIR/dvhub}"
SERVICE_USER="${SERVICE_USER:-dvhub}"
DATA_DIR="${DATA_DIR:-${DV_DATA_DIR:-/var/lib/dvhub}}"
VENV_DIR="${FORECAST_VENV:-$INSTALL_DIR/forecast-venv}"
# Verzeichnis der 2026-10 entfernten ML-Korrektur — wird nicht mehr angelegt,
# nur noch aufgeräumt (siehe unten).
LEGACY_ML_MODELS_DIR="$INSTALL_DIR/ml-models"
REQUIREMENTS="$APP_DIR/python/requirements.txt"
REQUIREMENTS_LOCK="$APP_DIR/python/requirements.lock"
MARKER="$DATA_DIR/.forecast-venv.lockhash"
FAILED_MARKER="$DATA_DIR/.forecast-venv.failed"      # "<lock-hash> <python-version> <epoch>"
STATUS_FILE="$DATA_DIR/forecast-venv-status.json"
# Mindest-Python des Lockfiles: numpy 2.4.x gibt es erst ab 3.11 (Ubuntu 22.04
# hat 3.10). Beim Anheben der Pins im Lockfile mitziehen.
MIN_PYTHON="3.11"
RETRY_AFTER_S=86400

# Ergebnis für DVhub festhalten (JSON, eine Zeile). detail wird entschärft.
write_status() {  # ok(true|false) reason detail
  local detail
  detail="$(printf '%s' "${3:-}" | tr -d '"\\' | tr '\n\r\t' '   ' | cut -c1-300)"
  mkdir -p "$DATA_DIR"
  printf '{"ok":%s,"reason":"%s","detail":"%s","python":"%s","ts":"%s"}\n' \
    "$1" "$2" "$detail" "${PY_VERSION:-}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATUS_FILE"
  chown "$SERVICE_USER:$SERVICE_USER" "$STATUS_FILE" 2>/dev/null || true
  chmod 644 "$STATUS_FILE" 2>/dev/null || true
}
fail() {  # reason detail
  echo "  Forecast: FEHLGESCHLAGEN ($1) — $2" >&2
  write_status false "$1" "$2"
  mkdir -p "$DATA_DIR"
  echo "${CUR_HASH:-} ${PY_VERSION:-} $(date +%s)" > "$FAILED_MARKER"
  exit 1
}

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

PY_VERSION="$(python3 -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])' 2>/dev/null || echo '')"

# Derselbe Fehlschlag nicht bei jedem Dienststart erneut (pip-Lauf + Netz):
# gleiches Lockfile, gleiche Python-Version, juenger als RETRY_AFTER_S → warten.
if [[ "$FORCE" -eq 0 && -f "$FAILED_MARKER" ]]; then
  read -r F_HASH F_PY F_TS < "$FAILED_MARKER" || true
  if [[ "${F_HASH:-}" == "$CUR_HASH" && "${F_PY:-}" == "$PY_VERSION" && "${F_TS:-0}" =~ ^[0-9]+$ ]] \
     && (( $(date +%s) - F_TS < RETRY_AFTER_S )); then
    echo "  Forecast: letzter Versuch fehlgeschlagen (siehe $STATUS_FILE) — naechster Versuch fruehestens in $(( (RETRY_AFTER_S - ($(date +%s) - F_TS)) / 3600 )) h, sofort mit --force."
    exit 0
  fi
fi

# Python zu alt fuer das Lockfile: gar nicht erst ein leeres venv anlegen.
if ! python3 -c "import sys; sys.exit(0 if sys.version_info[:2] >= tuple(int(x) for x in '$MIN_PYTHON'.split('.')) else 1)" 2>/dev/null; then
  fail python_too_old "Python ${PY_VERSION:-unbekannt} gefunden, das Prognose-Paket braucht >= $MIN_PYTHON. DVhub nutzt ohne es die SQL-Lastprognose und die PV-Prognose-Anbieter."
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
if [[ ! -d "$VENV_DIR" ]]; then
  python3 -m venv "$VENV_DIR" || fail venv_failed "python3 -m venv $VENV_DIR schlug fehl (python3-venv installiert?)"
fi
PIP_LOG="$(mktemp)"
# pip-Aktualisierung ist Komfort, kein Abbruchgrund.
"$VENV_DIR/bin/pip" install --upgrade pip >/dev/null 2>&1 || true
if [[ "$SRC_FILE" == "$REQUIREMENTS_LOCK" ]]; then
  # --require-hashes rejects any wheel whose sha256 is not in the lockfile,
  # blocking transitive-dep substitution + upstream PyPI compromise.
  echo "  Forecast: pip install --require-hashes ($REQUIREMENTS_LOCK)"
  PIP_ARGS=(install --require-hashes --no-deps -r "$REQUIREMENTS_LOCK")
else
  echo "  Forecast: pip install ($REQUIREMENTS)"
  PIP_ARGS=(install -r "$REQUIREMENTS")
fi
if ! "$VENV_DIR/bin/pip" "${PIP_ARGS[@]}" 2>&1 | tee "$PIP_LOG"; then
  PIP_ERR="$(grep -E '^ERROR' "$PIP_LOG" | tail -1 || true)"
  rm -f "$PIP_LOG"
  fail pip_failed "${PIP_ERR:-pip install schlug fehl (Netz/PyPI erreichbar? Plattenplatz?)}"
fi
rm -f "$PIP_LOG"

# Beweis statt Annahme: die Module muessen sich wirklich laden lassen.
if ! IMPORT_ERR="$("$VENV_DIR/bin/python3" -c 'import numpy, pandas, pvlib, statsforecast' 2>&1)"; then
  fail import_failed "$(echo "$IMPORT_ERR" | tail -1)"
fi

# Aufräumen nach einem Update: Pakete, die ein früheres Lockfile installiert hat
# und die das aktuelle nicht mehr enthält (z. B. lightgbm/scikit-learn/joblib der
# entfernten ML-Korrektur), wieder deinstallieren — pip install entfernt nie etwas.
# Das venv gehört allein DVhub (einziger Nutzer: services/python-bridge; EOS hat
# sein eigenes), und das Lockfile ist vollständig (--no-deps): was nicht drinsteht,
# braucht keines der verbleibenden Pakete. Nur im Lockfile-Pfad — bei
# requirements.txt löst pip die Abhängigkeiten selbst auf. NON-FATAL.
if [[ "$SRC_FILE" == "$REQUIREMENTS_LOCK" ]]; then
  norm_names() { tr '[:upper:]' '[:lower:]' | sed -E 's/[-_.]+/-/g' | sort -u; }
  WANTED="$(grep -oE '^[A-Za-z0-9_.-]+==' "$REQUIREMENTS_LOCK" | sed 's/==$//' | norm_names || true)"
  INSTALLED="$("$VENV_DIR/bin/pip" list --format=freeze 2>/dev/null | sed -E 's/[ =@].*//' | norm_names || true)"
  STALE="$(comm -23 <(echo "$INSTALLED") <(echo "$WANTED") | grep -vxE 'pip|setuptools|wheel' | grep -v '^$' || true)"
  if [[ -n "$WANTED" && -n "$STALE" ]]; then
    echo "  Forecast: entferne nicht mehr benoetigte Pakete: $(echo $STALE)"
    # shellcheck disable=SC2086
    "$VENV_DIR/bin/pip" uninstall -y $STALE >/dev/null 2>&1 \
      || echo "  WARN: Deinstallation alter Pakete fehlgeschlagen (non-fatal)." >&2
  fi
fi
# Modellverzeichnis der entfernten ML-Korrektur: nur ein LEERES wird entfernt —
# trainierte Modelle löscht ein Update nicht ungefragt.
rmdir "$LEGACY_ML_MODELS_DIR" 2>/dev/null || true

# Ownership: the systemd user must be able to execute the venv.
chown -R "$SERVICE_USER:$SERVICE_USER" "$VENV_DIR" 2>/dev/null || true

# Mark success so the next boot's post-update.sh can fast-skip (no pip per boot).
mkdir -p "$(dirname "$MARKER")"
echo "$CUR_HASH" > "$MARKER"
rm -f "$FAILED_MARKER"
write_status true ok ""
chown "$SERVICE_USER:$SERVICE_USER" "$MARKER" 2>/dev/null || true
echo "  Forecast-venv: bereit ($VENV_DIR)"
