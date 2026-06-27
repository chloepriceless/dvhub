#!/usr/bin/env bash
# eos-provision.sh -- Idempotent provisioning of the DVhub DV-EOS fork.
#
# Single source of truth for the EOS install, SHARED by install.sh (fresh
# install) and post-update.sh (retrofit on existing boxes) so the two never
# drift -- same pattern as support-provision.sh. Must be run as root.
#
# Honours the operator opt-out marker $DATA_DIR/.no-eos and the >=3GB RAM gate.
# Idempotent: clone-or-fetch the fork branch, venv-if-missing, pip re-resolve,
# rewrite the systemd unit, (re)start eos.service. Safe to run repeatedly.
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/dvhub}"
SERVICE_USER="${SERVICE_USER:-dvhub}"
DATA_DIR="${DATA_DIR:-${DV_DATA_DIR:-/var/lib/dvhub}}"
EOS_DIR="${EOS_DIR:-$INSTALL_DIR/eos}"
EOS_VENV="${EOS_VENV:-$INSTALL_DIR/eos-venv}"
# T-0121: install the DVhub DV-EOS *fork* (15-min slots, slot-aware
# battery/inverter math, battery->grid arbitrage export, EnergyCharts spot
# feed-in, pydantic /v1/prediction/import fix) directly from the fork branch.
# The branch carries every patch on top of upstream v0.3.0, so the legacy
# eos-patches/apply.sh step is no longer needed. Override repo/branch via env.
EOS_REPO_URL="${EOS_REPO_URL:-https://github.com/chloepriceless/DV-EOS.git}"
EOS_BRANCH="${EOS_BRANCH:-dvhub-fork}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "  EOS: eos-provision.sh muss als root laufen — uebersprungen" >&2
  exit 1
fi

# Operator opt-out (set by install.sh --no-eos). Persistent across updates.
if [[ -f "$DATA_DIR/.no-eos" ]]; then
  echo "  EOS: Uebersprungen (.no-eos Opt-out-Marker in $DATA_DIR)"
  exit 0
fi

# RAM gate (Christin 2026-06-27): EOS braucht max. ~1,5 GB, 2 GB sind komfortabel.
# Nur UNTER 1 GB deaktivieren — darunter würden EOS + venv die Box ins Swappen
# treiben. (Vorher >=3GB; auf 1 GB gesenkt, damit 2-GB-Boxen EOS bekommen.)
RAM_MB=$(free -m 2>/dev/null | awk '/^Mem:/{print $2}' || echo 0)
if [[ "$RAM_MB" -lt 1000 ]]; then
  echo "  EOS: Uebersprungen (RAM ${RAM_MB}MB < 1GB)"
  exit 0
fi

echo "  EOS: Installiere/aktualisiere DV-EOS Fork (${EOS_BRANCH}) bare-metal venv..."

# Idempotent clone / fetch of the fork branch.
if [[ ! -d "$EOS_DIR/.git" ]]; then
  rm -rf "$EOS_DIR"
  git clone --branch "$EOS_BRANCH" --depth 1 "$EOS_REPO_URL" "$EOS_DIR" \
    || { echo "  EOS: git clone ${EOS_REPO_URL}@${EOS_BRANCH} fehlgeschlagen" >&2; exit 1; }
else
  git -C "$EOS_DIR" fetch --depth 1 origin "$EOS_BRANCH"
  git -C "$EOS_DIR" checkout -B "$EOS_BRANCH" "origin/$EOS_BRANCH"
fi

# Python venv (Python 3.11+ required by EOS v0.3.0).
[[ -d "$EOS_VENV" ]] || python3 -m venv "$EOS_VENV"
"$EOS_VENV/bin/pip" install --upgrade pip
# T-0118: EOS v0.3.0 ships pyproject.toml, NOT requirements.txt — only honour a
# requirements.txt if present; the editable install resolves deps regardless.
if [[ -f "$EOS_DIR/requirements.txt" ]]; then
  "$EOS_VENV/bin/pip" install -r "$EOS_DIR/requirements.txt"
fi
"$EOS_VENV/bin/pip" install -e "$EOS_DIR"
# Phase 18-03: pin starlette to the 0.x line. fasthtml 0.12.x (via monsterui,
# pulled in by EOS v0.3.0) still calls Starlette.__init__(on_startup=…), which
# starlette 1.x dropped — without the pin EOSdash crashes on every restart while
# the EOS HTTP API stays up. Verified on prod 2026-05-20 at starlette 0.52.1.
# Idempotent — pip re-resolves the constraint on every run.
"$EOS_VENV/bin/pip" install --upgrade "starlette<1.0"

# Ownership: the systemd user must be able to execute the venv.
chown -R "$SERVICE_USER:$SERVICE_USER" "$EOS_VENV" "$EOS_DIR"

# systemd unit — bind 127.0.0.1:8503 only (no external access).
cat <<UNIT >/etc/systemd/system/eos.service
[Unit]
Description=Akkudoktor EOS (Energy Optimization System)
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$EOS_DIR
ExecStart=$EOS_VENV/bin/python -m akkudoktoreos.server.eos
Environment=EOS_SERVER__HOST=127.0.0.1
Environment=EOS_SERVER__PORT=8503
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable eos.service
systemctl restart eos.service
echo "  EOS: systemd eos.service bereit (127.0.0.1:8503)"
