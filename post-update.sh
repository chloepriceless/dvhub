#!/usr/bin/env bash
# post-update.sh -- Idempotent system-level setup for DVhub.
# Run as root after git pull to ensure all system requirements are met.
# Safe to run multiple times — only applies changes that are missing.
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/dvhub}"
APP_DIR="${APP_DIR:-$INSTALL_DIR/dvhub}"
SERVICE_USER="${SERVICE_USER:-dvhub}"
SERVICE_NAME="${SERVICE_NAME:-dvhub}"
CONFIG_DIR="${CONFIG_DIR:-/etc/dvhub}"
CONFIG_PATH="${CONFIG_PATH:-$CONFIG_DIR/config.json}"
DATA_DIR="${DATA_DIR:-${DV_DATA_DIR:-/var/lib/dvhub}}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Dieses Skript muss als root ausgeführt werden." >&2
  exit 1
fi

echo "DVhub post-update (idempotent)"

# ── 1. Pakete ──
NEEDED_PKGS=""
for pkg in openvpn wireguard-tools strongswan autossh openssh-client; do
  if ! dpkg -s "$pkg" >/dev/null 2>&1; then
    NEEDED_PKGS="$NEEDED_PKGS $pkg"
  fi
done
if [[ -n "$NEEDED_PKGS" ]]; then
  echo "  Installiere fehlende Pakete:$NEEDED_PKGS"
  # T-0077: NON-FATAL. This script runs as ExecStartPre on EVERY service start.
  # apt hits the network; under `set -e` a failed apt (no network at an offline
  # boot) would abort the whole hook. The packages are VPN tools (openvpn/wg/
  # strongswan), not required for the core app to boot — best-effort, retry next run.
  # The `if` condition suppresses `set -e` for these commands.
  if apt-get update -qq && apt-get install -y $NEEDED_PKGS; then
    echo "  Pakete: installiert"
  else
    echo "  WARN: Paket-Installation fehlgeschlagen (non-fatal, Netz?). VPN-Features ggf. bis zum naechsten erfolgreichen Lauf eingeschraenkt." >&2
  fi
else
  echo "  Pakete: OK"
fi

# ── 2. Node capabilities (privileged ports 80, 443, 502) ──
NODE_BIN="$(command -v node)"
if [[ -n "$NODE_BIN" ]]; then
  setcap cap_net_bind_service=+ep "$NODE_BIN" 2>/dev/null || true
  echo "  setcap: OK ($NODE_BIN)"
fi

# ── 3. Verzeichnisse ──
mkdir -p "$CONFIG_DIR/vpn/profiles"
mkdir -p "$CONFIG_DIR/tls"
mkdir -p "$CONFIG_DIR/hersteller"
chmod 700 "$CONFIG_DIR/vpn" 2>/dev/null || true
chmod 700 "$CONFIG_DIR/vpn/profiles" 2>/dev/null || true
echo "  Verzeichnisse: OK"

# ── 4. Self-Signed TLS Zertifikat ──
if [[ ! -f "$CONFIG_DIR/tls/cert.pem" ]]; then
  echo "  Generiere Self-Signed TLS Zertifikat..."
  # Plan 08-05 Task 1: 397 days (≤ 398) keeps the cert browser-compatible
  # (Apple/Chrome/Mozilla hard-limit since Sep 2020). Was 3650 (10y).
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$CONFIG_DIR/tls/key.pem" \
    -out "$CONFIG_DIR/tls/cert.pem" \
    -days 397 -subj "/CN=dvhub/O=DVhub/C=DE" 2>/dev/null
  chmod 600 "$CONFIG_DIR/tls/key.pem"
  chown "$SERVICE_USER:$SERVICE_USER" "$CONFIG_DIR/tls/"* 2>/dev/null || true
else
  echo "  TLS Zertifikat: OK"
fi

# ── 5. Sudoers (vollstaendig, idempotent) ──
OPENVPN_PATH="$(command -v openvpn || echo /usr/sbin/openvpn)"
WG_QUICK_PATH="$(command -v wg-quick || echo /usr/bin/wg-quick)"
WG_PATH="$(command -v wg || echo /usr/bin/wg)"
IPSEC_PATH="$(command -v ipsec || echo /usr/sbin/ipsec)"
IP_PATH="$(command -v ip || echo /usr/sbin/ip)"
PKILL_PATH="$(command -v pkill || echo /usr/bin/pkill)"
SYSTEMCTL_PATH="$(command -v systemctl)"
LN_PATH="$(command -v ln || echo /usr/bin/ln)"
RM_PATH="$(command -v rm || echo /usr/bin/rm)"

SUDOERS_FILE="/etc/sudoers.d/${SERVICE_NAME}-service-actions"
cat >"${SUDOERS_FILE}" <<SUDOERS
# BEGIN DVHUB SUDOERS — keep this block byte-identical with install.sh.
${SERVICE_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL_PATH} restart ${SERVICE_NAME}.service
${SERVICE_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL_PATH} is-active ${SERVICE_NAME}.service
${SERVICE_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL_PATH} show ${SERVICE_NAME}.service *
${SERVICE_USER} ALL=(root) NOPASSWD: ${OPENVPN_PATH} --config *
${SERVICE_USER} ALL=(root) NOPASSWD: ${WG_QUICK_PATH} up *
${SERVICE_USER} ALL=(root) NOPASSWD: ${WG_QUICK_PATH} down *
${SERVICE_USER} ALL=(root) NOPASSWD: ${WG_PATH} show *
${SERVICE_USER} ALL=(root) NOPASSWD: ${IPSEC_PATH} up *
${SERVICE_USER} ALL=(root) NOPASSWD: ${IPSEC_PATH} down *
${SERVICE_USER} ALL=(root) NOPASSWD: ${IPSEC_PATH} status *
${SERVICE_USER} ALL=(root) NOPASSWD: ${IPSEC_PATH} reload
# Narrowed ln/rm rules — only permit operations rooted at dvhub VPN paths.
# profileName regex: [A-Za-z0-9_-]+ (enforced in vpn-manager.js sanitizeProfileName).
# Note: sudoers wildcard * in argument slots matches any string including
# slashes; the anchored path prefix + bounded character class provide
# defence-in-depth behind the application-layer sanitizeProfileName() check.
${SERVICE_USER} ALL=(root) NOPASSWD: ${LN_PATH} -sf /etc/dvhub/vpn/profiles/*/ipsec.conf /etc/ipsec.d/dvhub-*.conf
${SERVICE_USER} ALL=(root) NOPASSWD: ${LN_PATH} -sf /etc/dvhub/vpn/profiles/*/ipsec.secrets /etc/ipsec.d/dvhub-*.secrets
${SERVICE_USER} ALL=(root) NOPASSWD: ${RM_PATH} -f /etc/ipsec.d/dvhub-[A-Za-z0-9_-]*.conf
${SERVICE_USER} ALL=(root) NOPASSWD: ${RM_PATH} -f /etc/ipsec.d/dvhub-[A-Za-z0-9_-]*.secrets
${SERVICE_USER} ALL=(root) NOPASSWD: ${IP_PATH} link show *
${SERVICE_USER} ALL=(root) NOPASSWD: ${IP_PATH} addr show *
# Process control — pkill by exact process name, not generic kill PID.
# OpenVPN daemon (stopTunnel/healthCheck), strongSwan charon/starter.
${SERVICE_USER} ALL=(root) NOPASSWD: ${PKILL_PATH} -0 -x openvpn
${SERVICE_USER} ALL=(root) NOPASSWD: ${PKILL_PATH} -15 -x openvpn
${SERVICE_USER} ALL=(root) NOPASSWD: ${PKILL_PATH} -9 -x openvpn
${SERVICE_USER} ALL=(root) NOPASSWD: ${PKILL_PATH} -15 -x charon
${SERVICE_USER} ALL=(root) NOPASSWD: ${PKILL_PATH} -15 -x starter
${SERVICE_USER} ALL=(root) NOPASSWD: ${PKILL_PATH} -9 -x charon
${SERVICE_USER} ALL=(root) NOPASSWD: ${PKILL_PATH} -9 -x starter
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/bash ${INSTALL_DIR}/post-update.sh
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/apt-get update *
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/apt-get upgrade *
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/apt list *
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/sbin/setcap *
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/sbin/reboot
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/fuser *
# T-DBRESTORE (Christin 2026-07-02): the GUI DB backup/restore runs as the
# postgres SUPERUSER — the non-super app role (dvhub) cannot dump/restore objects
# owned by another role (e.g. the postgres-owned victron_internals hypertable).
# Scoped to the three pg client binaries; run as postgres (a DB superuser but an
# unprivileged OS user), never as root.
${SERVICE_USER} ALL=(postgres) NOPASSWD: /usr/bin/pg_dump
${SERVICE_USER} ALL=(postgres) NOPASSWD: /usr/bin/pg_restore
${SERVICE_USER} ALL=(postgres) NOPASSWD: /usr/bin/psql
# END DVHUB SUDOERS
SUDOERS
chmod 440 "${SUDOERS_FILE}"
echo "  Sudoers: OK"

# ── 6. npm install (Lockfile-Guard + non-fatal) ──
# T-0077: this runs as ExecStartPre on EVERY service start. The old unconditional
# `npm install` hit the npm registry on every boot under `set -e`, so a boot with
# no network (Proxmox stop-mode backup reboot) failed the whole hook -> the service
# refused to start (fleet-brick risk). Now: only when the dependency lockfile changed
# since the last SUCCESSFUL install, and never fatal (the marker is only advanced on
# success, so a failed/offline run simply retries next time).
if [[ -f "$APP_DIR/package.json" ]]; then
  cd "$APP_DIR"
  LOCK_FILE="package-lock.json"
  [[ -f "$APP_DIR/$LOCK_FILE" ]] || LOCK_FILE="package.json"
  NPM_MARKER="$INSTALL_DIR/.npm-install-hash"
  CURRENT_HASH="$(sha256sum "$APP_DIR/$LOCK_FILE" 2>/dev/null | awk '{print $1}')"
  STORED_HASH="$(cat "$NPM_MARKER" 2>/dev/null || echo "")"
  if [[ -d "$APP_DIR/node_modules" && -n "$CURRENT_HASH" && "$CURRENT_HASH" == "$STORED_HASH" ]]; then
    echo "  npm install: uebersprungen (${LOCK_FILE} unveraendert)"
  else
    echo "  npm install (${LOCK_FILE} geaendert oder node_modules fehlt)..."
    # `if` suppresses `set -e`; no pipe so the rc is npm's own (not tail's).
    if npm install --omit=dev; then
      [[ -n "$CURRENT_HASH" ]] && printf '%s\n' "$CURRENT_HASH" >"$NPM_MARKER"
      echo "  npm install: OK"
    else
      echo "  WARN: npm install fehlgeschlagen (non-fatal, Netz?). Marker NICHT aktualisiert -> Retry beim naechsten Lauf." >&2
    fi
  fi
fi

# ── 7. Berechtigungen ──
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR" "$CONFIG_DIR" 2>/dev/null || true
echo "  Berechtigungen: OK"

# ── 8. systemd Service aktuell? ──
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
CURRENT_EXECSTART=$(grep "^ExecStart=" "$SERVICE_FILE" 2>/dev/null | head -1 || echo "")
EXPECTED_EXECSTART="ExecStart=/usr/bin/node ${APP_DIR}/server.js"
SERVICE_CHANGED=0
if [[ "$CURRENT_EXECSTART" != "$EXPECTED_EXECSTART" ]]; then
  echo "  Service-Datei wird aktualisiert..."
  sed -i "s|^ExecStart=.*|${EXPECTED_EXECSTART}|" "$SERVICE_FILE"
  SERVICE_CHANGED=1
fi

# Phase 16 D-09: ensure the ExecStartPre hook is present in the LIVE unit file.
# Existing prod boxes were installed before this hook existed, and a tar|ssh deploy
# never re-runs install.sh — so post-update.sh must add the hook to the unit itself.
# T-0077: the hook MUST be non-fatal ('-+'). A box installed before T-0077 carries
# the old fatal form ('+', no '-'); migrate it in place so a failed/offline
# post-update can never block the service start. Idempotent: insert if absent,
# rewrite only if the present line differs from the expected non-fatal form.
EXPECTED_EXECSTARTPRE="ExecStartPre=-+/usr/bin/bash ${INSTALL_DIR}/post-update.sh"
if [[ -f "$SERVICE_FILE" ]]; then
  CURRENT_EXECSTARTPRE="$(grep -E '^ExecStartPre=.*post-update\.sh' "$SERVICE_FILE" | head -1 || echo "")"
  if [[ -z "$CURRENT_EXECSTARTPRE" ]]; then
    echo "  ExecStartPre-Hook (D-09) wird eingefuegt..."
    # Insert the ExecStartPre line immediately before the ExecStart= line.
    sed -i "\|^ExecStart=|i ${EXPECTED_EXECSTARTPRE}" "$SERVICE_FILE"
    SERVICE_CHANGED=1
  elif [[ "$CURRENT_EXECSTARTPRE" != "$EXPECTED_EXECSTARTPRE" ]]; then
    echo "  ExecStartPre-Hook (T-0077) auf non-fatal (-+) migriert..."
    sed -i "s|^ExecStartPre=.*post-update\.sh.*|${EXPECTED_EXECSTARTPRE}|" "$SERVICE_FILE"
    SERVICE_CHANGED=1
  fi
fi

# T-0077 (P0-3, Hub-refute Auflage): ensure an explicit start timeout bounds a
# WEDGED ExecStartPre (post-update.sh). The '-' prefix ignores a non-zero EXIT but
# NOT a hang; without TimeoutStartSec a wedged start (npm/apt blocking on a
# dead-but-accepting network) hits systemd's 90s default and Restart=always loops.
# Insert once if absent (idempotent); existing boxes never re-run install.sh.
if [[ -f "$SERVICE_FILE" ]] && ! grep -qE '^TimeoutStartSec=' "$SERVICE_FILE"; then
  echo "  TimeoutStartSec=120 (T-0077) wird eingefuegt..."
  sed -i "\|^ExecStart=|a TimeoutStartSec=120" "$SERVICE_FILE"
  SERVICE_CHANGED=1
fi

# A2 (Improvements 2026-07-02): bounded STOP timeout as belt-and-braces to the
# in-app 5s shutdown watchdog. Before the watchdog, 3 of 6 observed stops hung
# the full systemd 90s default and ended in SIGKILL; a clean stop needs ~1-6s.
# TimeoutStopSec=15 keeps a wedged SYNC teardown step (or a wedged node) from
# stretching every restart/update to 90s. Same idempotent insert-once pattern
# as TimeoutStartSec above (existing boxes never re-run install.sh).
if [[ -f "$SERVICE_FILE" ]] && ! grep -qE '^TimeoutStopSec=' "$SERVICE_FILE"; then
  echo "  TimeoutStopSec=15 (A2) wird eingefuegt..."
  sed -i "\|^ExecStart=|a TimeoutStopSec=15" "$SERVICE_FILE"
  SERVICE_CHANGED=1
fi

if [[ "$SERVICE_CHANGED" -eq 1 ]]; then
  systemctl daemon-reload
fi
echo "  systemd Service: OK"

# ── 9. Support-Provisioning (T-0113 Tier 3, idempotent) ──
# Ensure the reverse-SSH support-tunnel prerequisites (appliance-id, relay
# keypair, hostkey pin, relay sidecar) and reconcile the dvhub-support login user
# to the config flag support.localUser.enabled. Shared with install.sh via the
# same support-provision.sh so the two never drift. Runs as root (this hook is
# ExecStartPre with '+'). NON-FATAL — a provisioning hiccup must never block boot.
if [[ -f "$INSTALL_DIR/support-provision.sh" ]]; then
  echo "  Support-Provisioning (T-0113)..."
  if ( SERVICE_USER="$SERVICE_USER" DATA_DIR="$DATA_DIR" CONFIG_PATH="$CONFIG_PATH" \
         bash "$INSTALL_DIR/support-provision.sh" ); then
    echo "  Support-Provisioning: OK"
  else
    echo "  WARN: Support-Provisioning fehlgeschlagen (non-fatal). Fern-Support ggf. bis zum nächsten Lauf eingeschränkt." >&2
  fi
fi

# ── 10. EOS-Provisionierung / Retrofit (idempotent, entkoppelt) ──
# EOS läuft seit v1.0 standardmäßig als DV-Fork. Boxen, die vor dieser Änderung
# ohne EOS installiert wurden, werden hier nachgerüstet (Provisioning-Logik in
# der gemeinsamen eos-provision.sh, geteilt mit install.sh). Das schwere
# clone+pip darf den Service-Start NIE blockieren (ExecStartPre, TimeoutStartSec=
# 120): fehlt EOS, wird die Provisionierung ENTKOPPELT über eine eigene transient
# systemd-Unit gestartet (überlebt dvhub-Restarts). Bereits provisioniertes EOS
# wird nur schnell auf "läuft" geprüft (kein fetch/pip pro Boot). Opt-out via
# $DATA_DIR/.no-eos. NON-FATAL durchgängig.
EOS_DIR="$INSTALL_DIR/eos"
if [[ -f "$INSTALL_DIR/eos-provision.sh" && ! -f "$DATA_DIR/.no-eos" ]]; then
  EOS_RAM_MB=$(free -m 2>/dev/null | awk '/^Mem:/{print $2}' || echo 0)
  if [[ "$EOS_RAM_MB" -lt 1000 ]]; then
    # RAM-Gate gesenkt 3GB->1GB (Christin 2026-06-27): EOS nur unter 1 GB aus.
    echo "  EOS: Uebersprungen (RAM ${EOS_RAM_MB}MB < 1GB)"
  elif [[ -d "$EOS_DIR/.git" && -f /etc/systemd/system/eos.service ]]; then
    # Bereits provisioniert — nur sicherstellen, dass der Dienst läuft (schnell).
    systemctl enable eos.service >/dev/null 2>&1 || true
    systemctl is-active --quiet eos.service || systemctl start eos.service >/dev/null 2>&1 || true
    echo "  EOS: OK (bereits provisioniert)"
  elif systemctl is-active --quiet dvhub-eos-provision.service 2>/dev/null; then
    echo "  EOS: Hintergrund-Provisionierung läuft bereits"
  else
    # Fehlt -> entkoppelt nachrüsten, damit clone+pip den Boot nicht blockiert.
    echo "  EOS: nicht installiert — starte entkoppelte Hintergrund-Provisionierung (DV-Fork)..."
    if command -v systemd-run >/dev/null 2>&1; then
      systemd-run --collect --quiet --unit "dvhub-eos-provision" \
        --description "DVhub EOS provisioning (retrofit)" \
        --setenv=SERVICE_USER="$SERVICE_USER" \
        --setenv=INSTALL_DIR="$INSTALL_DIR" \
        --setenv=DATA_DIR="$DATA_DIR" \
        bash "$INSTALL_DIR/eos-provision.sh" 2>/dev/null \
        || echo "  WARN: EOS-Hintergrund-Provisionierung konnte nicht gestartet werden (non-fatal)." >&2
    else
      SERVICE_USER="$SERVICE_USER" INSTALL_DIR="$INSTALL_DIR" DATA_DIR="$DATA_DIR" \
        setsid bash "$INSTALL_DIR/eos-provision.sh" </dev/null >>"$DATA_DIR/eos-provision.log" 2>&1 &
    fi
  fi
fi

# ── 11. Forecast/ML-venv-Provisionierung / Retrofit (idempotent, entkoppelt) ──
# Das Forecast+ML-Python-venv (/opt/dvhub/forecast-venv, pvlib/lightgbm/scikit-
# learn/… aus python/requirements.lock) wird vom Installer angelegt. Boxen, die
# VOR der Forecast-venv-Einführung installiert wurden — oder deren Lockfile sich
# geändert hat — werden hier nachgerüstet (Provisioning in der gemeinsamen
# forecast-provision.sh, geteilt mit install.sh). Der pip-Lauf ist schwer
# (numpy/scipy/pvlib/lightgbm) und darf den Service-Start NIE blockieren
# (ExecStartPre, TimeoutStartSec=120): fehlt/veraltet das venv, wird die
# Provisionierung ENTKOPPELT über eine eigene transiente systemd-Unit gestartet
# (überlebt dvhub-Restarts). Aktuelles venv = schneller Marker-Check (kein pip pro
# Boot). NON-FATAL durchgängig. Laufzeit-Consumer: services/python-bridge.
FORECAST_VENV="$INSTALL_DIR/forecast-venv"
FC_LOCK="$APP_DIR/python/requirements.lock"
[[ -f "$FC_LOCK" ]] || FC_LOCK="$APP_DIR/python/requirements.txt"
FC_MARKER="$DATA_DIR/.forecast-venv.lockhash"
if [[ -f "$INSTALL_DIR/forecast-provision.sh" && -f "$FC_LOCK" ]]; then
  FC_CUR="$(sha256sum "$FC_LOCK" 2>/dev/null | awk '{print $1}')"
  FC_PREV="$(cat "$FC_MARKER" 2>/dev/null || echo '')"
  if [[ -x "$FORECAST_VENV/bin/python3" && -n "$FC_CUR" && "$FC_CUR" == "$FC_PREV" ]]; then
    echo "  Forecast-venv: OK (requirements unveraendert)"
  elif systemctl is-active --quiet dvhub-forecast-provision.service 2>/dev/null; then
    echo "  Forecast-venv: Hintergrund-Provisionierung laeuft bereits"
  else
    echo "  Forecast-venv: fehlt/veraltet — starte entkoppelte Hintergrund-Provisionierung..."
    if command -v systemd-run >/dev/null 2>&1; then
      systemd-run --collect --quiet --unit "dvhub-forecast-provision" \
        --description "DVhub Forecast/ML venv provisioning (retrofit)" \
        --setenv=SERVICE_USER="$SERVICE_USER" \
        --setenv=INSTALL_DIR="$INSTALL_DIR" \
        --setenv=APP_DIR="$APP_DIR" \
        --setenv=DATA_DIR="$DATA_DIR" \
        bash "$INSTALL_DIR/forecast-provision.sh" 2>/dev/null \
        || echo "  WARN: Forecast-venv-Hintergrund-Provisionierung konnte nicht gestartet werden (non-fatal)." >&2
    else
      SERVICE_USER="$SERVICE_USER" INSTALL_DIR="$INSTALL_DIR" APP_DIR="$APP_DIR" DATA_DIR="$DATA_DIR" \
        setsid bash "$INSTALL_DIR/forecast-provision.sh" </dev/null >>"$DATA_DIR/forecast-provision.log" 2>&1 &
    fi
  fi
fi

# ── 12. TimescaleDB-Provisionierung / Retrofit (idempotent, entkoppelt) ──
# Boxen, die VOR der TimescaleDB-Installer-Provisionierung (Christin 2026-07-02)
# aufgesetzt wurden, laufen auf reinem Postgres — inkonsistent zu prod und ein
# prod-Backup lässt sich nicht restaurieren. Hier nachgerüstet über die geteilte
# timescale-provision.sh (single source of truth mit install.sh). Der Lauf macht
# u.a. `apt install` + einen Postgres-RESTART; das darf den dvhub-Service-Start
# NIE stören → ENTKOPPELT über eine transiente systemd-Unit (überlebt
# dvhub-Restarts, unterbricht den Boot nicht). Schneller Skip nur wenn die
# COMMUNITY-Edition schon aktiv ist (prod = No-op); eine Apache-Box oder eine Box
# ganz ohne Extension triggert die (Re-)Provisionierung, die dann auf Community
# hochzieht (ALTER EXTENSION UPDATE). NON-FATAL durchgängig.
if [[ -f "$INSTALL_DIR/timescale-provision.sh" ]] && command -v psql >/dev/null 2>&1; then
  TS_ACTIVE=0
  [[ "$(su - postgres -c "psql -tAqc \"SELECT current_setting('timescaledb.license')\" dvhub" 2>/dev/null | tr -d '[:space:]')" == "timescale" ]] && TS_ACTIVE=1
  if [[ "$TS_ACTIVE" -eq 1 ]]; then
    echo "  TimescaleDB: OK (Community-Edition aktiv)"
  elif systemctl is-active --quiet dvhub-timescale-provision.service 2>/dev/null; then
    echo "  TimescaleDB: Hintergrund-Provisionierung laeuft bereits"
  else
    echo "  TimescaleDB: nicht aktiv — starte entkoppelte Hintergrund-Provisionierung..."
    if command -v systemd-run >/dev/null 2>&1; then
      systemd-run --collect --quiet --unit "dvhub-timescale-provision" \
        --description "DVhub TimescaleDB provisioning (retrofit)" \
        --setenv=SERVICE_USER="$SERVICE_USER" \
        --setenv=INSTALL_DIR="$INSTALL_DIR" \
        --setenv=DATA_DIR="$DATA_DIR" \
        --setenv=CONFIG_PATH="$CONFIG_PATH" \
        --setenv=DB_NAME=dvhub \
        bash "$INSTALL_DIR/timescale-provision.sh" 2>/dev/null \
        || echo "  WARN: TimescaleDB-Hintergrund-Provisionierung konnte nicht gestartet werden (non-fatal)." >&2
    else
      SERVICE_USER="$SERVICE_USER" INSTALL_DIR="$INSTALL_DIR" DATA_DIR="$DATA_DIR" CONFIG_PATH="$CONFIG_PATH" DB_NAME=dvhub \
        setsid bash "$INSTALL_DIR/timescale-provision.sh" </dev/null >>"$DATA_DIR/timescale-provision.log" 2>&1 &
    fi
  fi
fi

echo ""
echo "Post-Update abgeschlossen. Neustart mit: systemctl restart ${SERVICE_NAME}"
