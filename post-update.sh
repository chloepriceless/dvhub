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
# wireguard-tools wird GETRENNT und OHNE Recommends installiert (T-UPDATE-SHARPEN
# 2026-07-03): sein Recommends `wireguard-modules` ist virtuell und wird nur von
# linux-image-* bereitgestellt — in einem LXC (kein Kernel-Paket) löst apt das
# durch ein KOMPLETTES Kernel-Image auf (~0,5 GB nutzlos; live beobachtet:
# linux-image-rt-amd64). Das Modul kommt im Container vom HOST-Kernel.
# Die übrigen Pakete behalten ihre Recommends — die sind FUNKTIONAL NÖTIG
# (strongswan-starter → strongswan-charon = der IKE-Daemon selbst; libstrongswan
# → libstrongswan-standard-plugins = Crypto-Plugins). NIE pauschal
# --no-install-recommends auf die ganze Liste!
NEEDED_PKGS=""
for pkg in openvpn strongswan autossh openssh-client libjemalloc2; do
  if ! dpkg -s "$pkg" >/dev/null 2>&1; then
    NEEDED_PKGS="$NEEDED_PKGS $pkg"
  fi
done
NEED_WG=""
if ! dpkg -s wireguard-tools >/dev/null 2>&1; then
  NEED_WG="wireguard-tools"
fi
if [[ -n "$NEEDED_PKGS" || -n "$NEED_WG" ]]; then
  echo "  Installiere fehlende Pakete:$NEEDED_PKGS ${NEED_WG}"
  # T-0077: NON-FATAL. This script runs as ExecStartPre on EVERY service start.
  # apt hits the network; under `set -e` a failed apt (no network at an offline
  # boot) would abort the whole hook. The packages are VPN tools (openvpn/wg/
  # strongswan), not required for the core app to boot — best-effort, retry next run.
  # The `if` condition suppresses `set -e` for these commands.
  APT_OK=1
  apt-get update -qq || APT_OK=0
  if [[ "$APT_OK" -eq 1 && -n "$NEEDED_PKGS" ]]; then
    apt-get install -y $NEEDED_PKGS || APT_OK=0
  fi
  if [[ "$APT_OK" -eq 1 && -n "$NEED_WG" ]]; then
    apt-get install -y --no-install-recommends "$NEED_WG" || APT_OK=0
  fi
  if [[ "$APT_OK" -eq 1 ]]; then
    echo "  Pakete: installiert"
  else
    echo "  WARN: Paket-Installation fehlgeschlagen (non-fatal, Netz?). VPN-Features ggf. bis zum naechsten erfolgreichen Lauf eingeschraenkt." >&2
  fi
else
  echo "  Pakete: OK"
fi

# ── 2. Port-Recht (80, 443, 502) + Speicherverwalter ──
# Frueher setcap an der node-Datei; jetzt AmbientCapabilities + jemalloc per
# Drop-in, Umstieg ueber zwei Starts (Begruendung in node-runtime-provision.sh).
# Fehlt das Skript (Teil-Deploy), bleibt es beim alten setcap.
NODE_BIN="$(command -v node)"
if [[ -f "$INSTALL_DIR/node-runtime-provision.sh" ]]; then
  SERVICE_NAME="$SERVICE_NAME" DATA_DIR="$DATA_DIR" NODE_BIN="$NODE_BIN" \
    bash "$INSTALL_DIR/node-runtime-provision.sh" || true
elif [[ -n "$NODE_BIN" ]]; then
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

# ── 3b. Herstellerprofile abgleichen (T-MANAGED-VENDOR-PROFILES) ──
# Fehlende Profile anlegen UND ausgelieferte Bugfixes an Bestandsboxen bringen,
# ohne Operator-Edits zu zerstören: ein UNVERÄNDERTES Profil (Hash in der
# ausgelieferten Historie hersteller/.shipped-hashes.json) wird mit der neuen
# Version überschrieben; ein GEÄNDERTES Profil (z. B. victron.json auf
# transport=mqtt umgestellt) bleibt stehen — die neue Version landet als
# <name>.dist daneben. Node-Helper (unit-getestet), non-fatal.
if [[ -d "$APP_DIR/hersteller" ]]; then
  node "$INSTALL_DIR/scripts/reconcile-vendor-profiles.mjs" "$CONFIG_DIR" "$APP_DIR" \
    || echo "  (Herstellerprofil-Abgleich übersprungen — Node-Helper nicht ausführbar)"
  chown -R "$SERVICE_USER:$SERVICE_USER" "$CONFIG_DIR/hersteller" 2>/dev/null || true
fi

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
# IPsec-Hilfsskript (2026-10-18): root-eigene Kopie außerhalb des App-Ordners
# (der gehört dem Dienstbenutzer); die sudoers-Regel zeigt nur auf diese Kopie.
IPSEC_LINK_PATH="/usr/local/libexec/dvhub-ipsec-link"
if [[ -f "$INSTALL_DIR/dvhub-ipsec-link.sh" ]]; then
  install -d -o root -g root -m 0755 "$(dirname "$IPSEC_LINK_PATH")"
  install -o root -g root -m 0755 "$INSTALL_DIR/dvhub-ipsec-link.sh" "$IPSEC_LINK_PATH"
fi
# Ersatzweg Modbus-Port (2026-10-18): Umleitung 502 → Ersatzport nur am
# Tunnel-Interface, über eine root-eigene Kopie wie beim IPsec-Hilfsskript.
MODBUS_REDIRECT_PATH="/usr/local/libexec/dvhub-modbus-redirect"
if [[ -f "$INSTALL_DIR/dvhub-modbus-redirect.sh" ]]; then
  install -d -o root -g root -m 0755 "$(dirname "$MODBUS_REDIRECT_PATH")"
  install -o root -g root -m 0755 "$INSTALL_DIR/dvhub-modbus-redirect.sh" "$MODBUS_REDIRECT_PATH"
fi

SUDOERS_FILE="/etc/sudoers.d/${SERVICE_NAME}-service-actions"
# Erst in eine Nebendatei schreiben und mit visudo -c prüfen (2026-10-18):
# eine ungültige Datei in /etc/sudoers.d legt bei klassischem sudo ALLE
# sudo-Aufrufe lahm, sudo-rs überspringt ungültige Regeln still.
SUDOERS_NEW="$(mktemp /etc/dvhub-sudoers.XXXXXX)"
cat >"${SUDOERS_NEW}" <<SUDOERS
# BEGIN DVHUB SUDOERS — keep this block byte-identical with install.sh.
${SERVICE_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL_PATH} restart ${SERVICE_NAME}.service
${SERVICE_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL_PATH} is-active ${SERVICE_NAME}.service
${SERVICE_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL_PATH} show ${SERVICE_NAME}.service *
# Fern-Support-Tunnel als eigener Dienst (2026-10-14): überlebt einen Neustart
# von DVhub. Nur Start/Stopp genau dieser Unit; sie läuft selbst als ${SERVICE_USER}.
${SERVICE_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL_PATH} start dvhub-support-tunnel.service
${SERVICE_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL_PATH} stop dvhub-support-tunnel.service
# EOS neu starten (2026-10-16): Knopf in der Oberfläche und Wache für hängende
# Läufe. Nur restart genau dieser Unit.
${SERVICE_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL_PATH} restart eos.service
${SERVICE_USER} ALL=(root) NOPASSWD: ${OPENVPN_PATH} --config *
${SERVICE_USER} ALL=(root) NOPASSWD: ${WG_QUICK_PATH} up *
${SERVICE_USER} ALL=(root) NOPASSWD: ${WG_QUICK_PATH} down *
${SERVICE_USER} ALL=(root) NOPASSWD: ${WG_PATH} show *
${SERVICE_USER} ALL=(root) NOPASSWD: ${IPSEC_PATH} up *
${SERVICE_USER} ALL=(root) NOPASSWD: ${IPSEC_PATH} down *
${SERVICE_USER} ALL=(root) NOPASSWD: ${IPSEC_PATH} status *
${SERVICE_USER} ALL=(root) NOPASSWD: ${IPSEC_PATH} reload
# IPsec-Verweise in /etc/ipsec.d (2026-10-18): nur über das root-eigene
# Hilfsskript (Kopie von dvhub-ipsec-link.sh, prüft den Profilnamen selbst).
# sudo-rs (Ubuntu 26.04) überspringt Regeln mit * oder ? mitten im Argument;
# erlaubt ist nur ein alleinstehendes * am Ende (test/sudoers-sudo-rs.test.js).
${SERVICE_USER} ALL=(root) NOPASSWD: ${IPSEC_LINK_PATH} link *
${SERVICE_USER} ALL=(root) NOPASSWD: ${IPSEC_LINK_PATH} unlink *
# Ersatzweg Modbus-Port (2026-10-18): Umleitung am Tunnel-Interface nur über
# das root-eigene Hilfsskript (prüft Interface und Ports selbst).
${SERVICE_USER} ALL=(root) NOPASSWD: ${MODBUS_REDIRECT_PATH} add *
${SERVICE_USER} ALL=(root) NOPASSWD: ${MODBUS_REDIRECT_PATH} del
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
# T-PKGUPDATE (Christin 2026-07-02): the GUI TimescaleDB extension upgrade
# ("Jetzt aktualisieren") bounces PostgreSQL twice around ALTER EXTENSION … UPDATE
# — a fresh backend must load the new .so. Scoped to a restart of the postgresql
# meta-unit only; the dvhub app restart afterwards reuses the ${SERVICE_NAME} rule above.
${SERVICE_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL_PATH} restart postgresql.service
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
chmod 440 "${SUDOERS_NEW}"
if command -v visudo >/dev/null 2>&1 && ! VISUDO_OUT="$(visudo -cf "${SUDOERS_NEW}" 2>&1)"; then
  echo "  Sudoers: Prüfung fehlgeschlagen — bisherige Regeln bleiben aktiv:" >&2
  echo "${VISUDO_OUT}" | sed 's/^/    /' >&2
  rm -f "${SUDOERS_NEW}"
else
  mv -f "${SUDOERS_NEW}" "${SUDOERS_FILE}"
  echo "  Sudoers: OK"
fi

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
    # Als Dienstbenutzer, nicht als root (2026-10-15): root mit HOME=~dvhub legte
    # root-eigene Einträge in dessen npm-Cache an, danach scheiterte das Update
    # über die Oberfläche (als dvhub) mit EACCES. Alte Reste reparieren.
    SVC_HOME="$(getent passwd "$SERVICE_USER" 2>/dev/null | cut -d: -f6)"
    for d in "${SVC_HOME:-/nonexistent}/.npm" "${SVC_HOME:-/nonexistent}/.cache/dvhub-npm" "$APP_DIR/node_modules"; do
      [[ -e "$d" ]] && chown -R "$SERVICE_USER:$SERVICE_USER" "$d" 2>/dev/null || true
    done
    NPM_AS=(npm)
    if [[ "$(id -u)" -eq 0 ]] && id "$SERVICE_USER" >/dev/null 2>&1 && command -v runuser >/dev/null 2>&1; then
      chown "$SERVICE_USER:$SERVICE_USER" "$APP_DIR" "$APP_DIR/package-lock.json" 2>/dev/null || true
      NPM_AS=(runuser -u "$SERVICE_USER" -- env HOME="${SVC_HOME:-$HOME}" npm)
    fi
    # `if` suppresses `set -e`; no pipe so the rc is npm's own (not tail's).
    if "${NPM_AS[@]}" install --omit=dev; then
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

# ── 9b. EEBUS (dvhub-eebus) bauen/aktualisieren (entkoppelt, idempotent) ──
# Nur wenn EEBUS aktiviert ist oder dvhub-eebus schon installiert war: dann
# baut eebus-provision.sh den Hilfsprozess im Hintergrund (Go-Fassung: Go von
# go.dev + eebus-go) — der Boot wird nie blockiert. NON-FATAL.
if [[ -f "$INSTALL_DIR/eebus-provision.sh" && ! -f "$DATA_DIR/.no-eebus" ]]; then
  EEBUS_ON=0
  if command -v node >/dev/null 2>&1 && [[ -f "$CONFIG_PATH" ]]; then
    node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(c?.eebus?.enabled===true?0:1)' "$CONFIG_PATH" 2>/dev/null && EEBUS_ON=1
  fi
  if [[ "$EEBUS_ON" -eq 1 || -x "$INSTALL_DIR/bin/dvhub-eebus" ]]; then
    if systemctl is-active --quiet dvhub-eebus-provision.service 2>/dev/null; then
      echo "  EEBUS: Bau läuft bereits"
    elif command -v systemd-run >/dev/null 2>&1; then
      systemd-run --collect --quiet --unit "dvhub-eebus-provision" \
        --description "DVhub EEBUS provisioning" \
        --setenv=INSTALL_DIR="$INSTALL_DIR" --setenv=DATA_DIR="$DATA_DIR" \
        bash "$INSTALL_DIR/eebus-provision.sh" 2>/dev/null \
        && echo "  EEBUS: Prüfung/Bau im Hintergrund gestartet" \
        || echo "  EEBUS: Hintergrund-Start fehlgeschlagen (non-fatal)"
    fi
  fi
fi

# ── 10. EOS-Provisionierung / Retrofit (idempotent, entkoppelt) ──
# EOS läuft seit v1.0 standardmäßig als DV-Fork. Boxen, die vor dieser Änderung
# ohne EOS installiert wurden, werden hier nachgerüstet (Provisioning-Logik in
# der gemeinsamen eos-provision.sh, geteilt mit install.sh). Das schwere
# clone+pip darf den Service-Start NIE blockieren (ExecStartPre, TimeoutStartSec=
# 120): fehlt EOS oder ist es veraltet, wird die Provisionierung ENTKOPPELT über
# eine eigene transient systemd-Unit gestartet (überlebt dvhub-Restarts). Ein
# bereits aktueller Stand wird nur schnell auf "läuft" geprüft (kein fetch/pip
# pro Boot) — "aktuell" heisst: der Marker $DATA_DIR/.eos-provisioned stimmt mit
# eos-version.env überein. KEIN RAM-Gate mehr (Christin 2026-09-20): EOS kommt
# immer mit. Opt-out weiterhin via $DATA_DIR/.no-eos. NON-FATAL durchgängig.
EOS_DIR="$INSTALL_DIR/eos"
if [[ -f "$INSTALL_DIR/eos-provision.sh" && ! -f "$DATA_DIR/.no-eos" ]]; then
  # Gewuenschter EOS-Stand aus eos-version.env gegen den zuletzt installierten
  # (Marker $DATA_DIR/.eos-provisioned) — reiner Dateivergleich, KEIN Netzzugriff,
  # also weiterhin billig genug fuer jeden Boot.
  EOS_WANT=""
  if [[ -f "$INSTALL_DIR/eos-version.env" ]]; then
    _pr="$(grep -E '^EOS_REPO_URL=' "$INSTALL_DIR/eos-version.env" | tail -1 | cut -d= -f2- | tr -d '"'"'"'\r')"
    _pp="$(grep -E '^EOS_PIN=' "$INSTALL_DIR/eos-version.env" | tail -1 | cut -d= -f2- | tr -d '"'"'"'\r')"
    [[ -n "$_pr" && -n "$_pp" ]] && EOS_WANT="${_pr}@${_pp}"
  fi
  EOS_HAVE="$(cat "$DATA_DIR/.eos-provisioned" 2>/dev/null || true)"
  # Bestandsboxen haben noch keinen Marker. Die laufen hier einmalig durch die
  # (entkoppelte) Provisionierung — idempotent, und danach ist die Flotte auf
  # einem nachweisbaren Stand statt auf "irgendwas von damals".
  EOS_CURRENT=0
  [[ -n "$EOS_WANT" && "$EOS_HAVE" == "$EOS_WANT" ]] && EOS_CURRENT=1
  if [[ -d "$EOS_DIR/.git" && -f /etc/systemd/system/eos.service && "$EOS_CURRENT" -eq 1 ]]; then
    # Aktuell — nur sicherstellen, dass der Dienst läuft (schnell).
    systemctl enable eos.service >/dev/null 2>&1 || true
    systemctl is-active --quiet eos.service || systemctl start eos.service >/dev/null 2>&1 || true
    echo "  EOS: OK (aktuell: ${EOS_HAVE})"
  elif systemctl is-active --quiet dvhub-eos-provision.service 2>/dev/null; then
    echo "  EOS: Hintergrund-Provisionierung läuft bereits"
  else
    # Fehlt ODER veraltet -> entkoppelt nachziehen, damit clone+pip den Boot nie
    # blockiert. Genau hier landet auch das EOS-Upgrade: eine neue Version in
    # eos-version.env macht den Marker ungleich, und der naechste Service-Start
    # stoesst die Neu-Provisionierung an.
    if [[ -d "$EOS_DIR/.git" && -n "$EOS_HAVE" ]]; then
      echo "  EOS: neue Version angefordert (${EOS_HAVE:-unbekannt} -> ${EOS_WANT}) — starte entkoppelte Aktualisierung..."
    else
      echo "  EOS: nicht installiert oder Stand unbekannt — starte entkoppelte Hintergrund-Provisionierung..."
    fi
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

# ── 11. Forecast-venv-Provisionierung / Retrofit (idempotent, entkoppelt) ──
# Das Forecast-Python-venv (/opt/dvhub/forecast-venv, pvlib/statsforecast/…
# aus python/requirements.lock) wird vom Installer angelegt. Boxen, die
# VOR der Forecast-venv-Einführung installiert wurden — oder deren Lockfile sich
# geändert hat — werden hier nachgerüstet (Provisioning in der gemeinsamen
# forecast-provision.sh, geteilt mit install.sh). Der pip-Lauf ist schwer
# (numpy/scipy/pvlib/statsforecast) und darf den Service-Start NIE blockieren
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
        --description "DVhub forecast venv provisioning (retrofit)" \
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
# PostgreSQL schreibarm (2026-10-01, SD-Karte): idempotent, nur Reload.
if [[ -f "$INSTALL_DIR/pg-write-tuning.sh" ]] && command -v psql >/dev/null 2>&1; then
  bash "$INSTALL_DIR/pg-write-tuning.sh" || true
fi
if [[ -f "$INSTALL_DIR/timescale-provision.sh" ]] && command -v psql >/dev/null 2>&1; then
  TS_ACTIVE=0
  # `su postgres` (NON-login): a login shell would prepend the postgres user's MOTD
  # banner (community-scripts Proxmox LXCs — prod's platform) to the psql output,
  # so the == "timescale" check would wrongly fail and re-launch provisioning on
  # every restart.
  # Seit 21.10.2026 entscheidet timescale-provision.sh --check: fertig erst, wenn
  # die Bibliothek laedt, keine Parktabelle wartet und keine Hypertable Zeilen in
  # ihrer Elterntabelle hat (Begruendung dort). Scheitert die Abfrage, weil die
  # Bibliothek zur Katalog-Version fehlt, startet die Nachruestung und repariert.
  [[ "$(DB_NAME=dvhub bash "$INSTALL_DIR/timescale-provision.sh" --check 2>/dev/null)" == "timescale" ]] && TS_ACTIVE=1
  if [[ "$TS_ACTIVE" -eq 1 ]]; then
    echo "  TimescaleDB: OK (Community-Edition aktiv)"
  elif systemctl is-active --quiet dvhub-timescale-provision.service 2>/dev/null; then
    echo "  TimescaleDB: Hintergrund-Provisionierung laeuft bereits"
  else
    echo "  TimescaleDB: nicht aktiv — starte entkoppelte Hintergrund-Provisionierung..."
    if command -v systemd-run >/dev/null 2>&1; then
      # Ausgabe in dieselbe Datei wie beim setsid-Weg unten (das Journal ist fuer
      # den Support-Zugang nicht lesbar).
      systemd-run --collect --quiet --unit "dvhub-timescale-provision" \
        --description "DVhub TimescaleDB provisioning (retrofit)" \
        --property=StandardOutput="append:$DATA_DIR/timescale-provision.log" \
        --property=StandardError="append:$DATA_DIR/timescale-provision.log" \
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

# TimescaleDB package-maintenance timer (Christin 2026-07-02, "Pakete auto"):
# ensure the nightly apt-only maintenance unit exists on boxes provisioned before
# this feature. Create-if-missing (idempotent) — the units just call
# ${INSTALL_DIR}/pkg-maintain.sh, so no rewrite is needed once present. The unit
# body is kept in sync with install.sh. NON-FATAL.
if [[ -f "$INSTALL_DIR/pkg-maintain.sh" ]] && [[ ! -f /etc/systemd/system/dvhub-pkg-maintain.timer ]]; then
  echo "  pkg-maintain: richte naechtlichen Paket-Wartungs-Timer ein..."
  cat >/etc/systemd/system/dvhub-pkg-maintain.service <<PKGSVC
[Unit]
Description=DVhub TimescaleDB package maintenance (apt only, no restart)
After=postgresql.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=INSTALL_DIR=${INSTALL_DIR}
Environment=SERVICE_USER=${SERVICE_USER}
Environment=DATA_DIR=${DATA_DIR}
Environment=DB_NAME=dvhub
ExecStart=/usr/bin/bash ${INSTALL_DIR}/pkg-maintain.sh
PKGSVC
  cat >/etc/systemd/system/dvhub-pkg-maintain.timer <<PKGTIMER
[Unit]
Description=DVhub TimescaleDB package maintenance (nightly)

[Timer]
OnCalendar=*-*-* 03:17:00
RandomizedDelaySec=1200
Persistent=true

[Install]
WantedBy=timers.target
PKGTIMER
  systemctl daemon-reload 2>/dev/null || true
  systemctl enable --now dvhub-pkg-maintain.timer >/dev/null 2>&1 || true
fi

# ── 13. Stack-Update bei Versionswechsel (entkoppelt, 2026-10-15) ──
# Christin: ein Update auf eine neue DVhub-Version soll alles auf den neuesten
# Stand bringen. npm (Schritt 6), Python (11) und EOS (10) laufen schon
# versionsgesteuert; stack-update.sh hebt zusätzlich TimescaleDB-Pakete, die
# System-Pakete des Stacks (innerhalb ihrer Hauptversion) und die
# TimescaleDB-Erweiterung in der Datenbank an und startet DVhub bei Bedarf neu.
# Nur einmal je Version: der Marker wird VOR dem Start geschrieben — ein
# DVhub-Neustart aus stack-update.sh löst es nicht erneut aus. NON-FATAL.
if [[ -f "$INSTALL_DIR/stack-update.sh" ]]; then
  STACK_VER="$(grep -m1 '"version"' "$APP_DIR/package.json" 2>/dev/null | sed -E 's/.*"version" *: *"([^"]+)".*/\1/')"
  STACK_REV="$(git -C "$INSTALL_DIR" rev-parse --short HEAD 2>/dev/null || echo nogit)"
  STACK_WANT="${STACK_VER:-unbekannt}@${STACK_REV}"
  STACK_MARKER="$DATA_DIR/.stack-updated-version"
  if [[ "$(cat "$STACK_MARKER" 2>/dev/null)" == "$STACK_WANT" ]]; then
    echo "  Stack-Update: OK (${STACK_WANT})"
  elif systemctl is-active --quiet dvhub-stack-update.service 2>/dev/null; then
    echo "  Stack-Update: laeuft bereits"
  else
    echo "$STACK_WANT" > "$STACK_MARKER" 2>/dev/null || true
    echo "  Stack-Update: neue Version ${STACK_WANT} — starte entkoppelt (Pakete, TimescaleDB)"
    if command -v systemd-run >/dev/null 2>&1; then
      systemd-run --collect --quiet --unit "dvhub-stack-update" \
        --description "DVhub Stack-Update (Pakete, TimescaleDB) nach Versions-Update" \
        --setenv=INSTALL_DIR="$INSTALL_DIR" --setenv=DATA_DIR="$DATA_DIR" \
        --setenv=SERVICE_NAME="$SERVICE_NAME" --setenv=DB_NAME=dvhub \
        --setenv=STACK_UPDATE_VERSION="$STACK_WANT" \
        bash "$INSTALL_DIR/stack-update.sh" 2>/dev/null \
        || echo "  WARN: Stack-Update konnte nicht gestartet werden (non-fatal)." >&2
    else
      INSTALL_DIR="$INSTALL_DIR" DATA_DIR="$DATA_DIR" SERVICE_NAME="$SERVICE_NAME" DB_NAME=dvhub STACK_UPDATE_VERSION="$STACK_WANT" \
        setsid bash "$INSTALL_DIR/stack-update.sh" </dev/null >>"$DATA_DIR/stack-update.log" 2>&1 &
    fi
  fi
fi

echo ""
echo "Post-Update abgeschlossen. Neustart mit: systemctl restart ${SERVICE_NAME}"
