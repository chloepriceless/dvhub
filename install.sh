#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/chloepriceless/dvhub.git}"
REPO_BRANCH="${REPO_BRANCH:-}"
UPDATE_CHANNEL="${UPDATE_CHANNEL:-}"
INSTALLER_SOURCE_URL="${INSTALLER_SOURCE_URL:-}"
INSTALL_DIR="${INSTALL_DIR:-/opt/dvhub}"
APP_DIR="${APP_DIR:-$INSTALL_DIR/dvhub}"
SERVICE_USER="${SERVICE_USER:-dvhub}"
SERVICE_NAME="${SERVICE_NAME:-dvhub}"
CONFIG_DIR="${CONFIG_DIR:-/etc/dvhub}"
CONFIG_PATH="${CONFIG_PATH:-$CONFIG_DIR/config.json}"
DATA_DIR="${DATA_DIR:-/var/lib/dvhub}"
LEGACY_APP_DIR="${LEGACY_APP_DIR:-$INSTALL_DIR/dv-control-webapp}"
# T-0113 Tier 3: remote-support readiness. Default ON (opt-out) — creates the
# dvhub-support login user + deposits the support pubkey, so the customer CAN
# request remote help. Grants NOTHING on its own: a supporter only reaches the
# box while the customer holds a tunnel open (UI button). Disable with
# --no-support-user (no user, no key, no remote support possible).
SUPPORT_LOCAL_USER="${SUPPORT_LOCAL_USER:-1}"
# Akkudoktor-EOS is installed BY DEFAULT as the DVhub Direktvermarktung fork
# (DV-EOS: 15-min slots, slot-aware battery/inverter math, battery->grid
# arbitrage export) when RAM >= 1GB (Christin 2026-06-27: lowered from 3GB —
# EOS needs ~1.5GB, 2GB is comfortable; only disable below 1GB). It is the
# productive optimizer DVhub ships with — no longer opt-in. Opt out with --no-eos.
# --with-eos is kept as a backwards-compatible no-op (EOS is already the default).
EOS_INSTALL="${EOS_INSTALL:-1}"

function parse_branch_from_installer_url() {
  local url="${1:-}"
  local branch=""

  if [[ -z "$url" ]]; then
    return 1
  fi

  case "$url" in
    https://raw.githubusercontent.com/*/install.sh)
      branch="$(printf '%s' "$url" | sed -E 's#^https://raw\.githubusercontent\.com/[^/]+/[^/]+/(.+)/install\.sh$#\1#')"
      ;;
    https://github.com/*/blob/*/install.sh)
      branch="$(printf '%s' "$url" | sed -E 's#^https://github\.com/[^/]+/[^/]+/blob/(.+)/install\.sh$#\1#')"
      ;;
  esac

  if [[ -z "$branch" || "$branch" == "$url" ]]; then
    return 1
  fi

  printf '%s\n' "$branch"
}

function detect_branch_from_local_checkout() {
  local script_path="${BASH_SOURCE[0]:-$0}"
  local script_dir=""
  local branch=""

  if [[ "$script_path" != /* || ! -f "$script_path" ]]; then
    return 1
  fi

  script_dir="$(cd -- "$(dirname -- "$script_path")" && pwd)"
  if ! git -C "$script_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return 1
  fi

  branch="$(git -C "$script_dir" branch --show-current 2>/dev/null || true)"
  if [[ -z "$branch" || "$branch" == "HEAD" ]]; then
    return 1
  fi

  printf '%s\n' "$branch"
}

function resolve_default_repo_branch() {
  local branch=""

  if [[ -n "$INSTALLER_SOURCE_URL" ]]; then
    branch="$(parse_branch_from_installer_url "$INSTALLER_SOURCE_URL" || true)"
    if [[ -n "$branch" ]]; then
      printf '%s\n' "$branch"
      return 0
    fi
  fi

  branch="$(detect_branch_from_local_checkout || true)"
  if [[ -n "$branch" ]]; then
    printf '%s\n' "$branch"
    return 0
  fi

  return 1
}

function move_dir_contents_if_present() {
  local source_dir="${1:-}"
  local target_dir="${2:-}"
  local entries=()

  if [[ -z "$source_dir" || -z "$target_dir" || ! -d "$source_dir" ]]; then
    return 0
  fi

  mkdir -p "$target_dir"
  shopt -s dotglob nullglob
  entries=("$source_dir"/*)
  shopt -u dotglob nullglob

  if [[ ${#entries[@]} -eq 0 ]]; then
    rmdir "$source_dir" 2>/dev/null || true
    return 0
  fi

  for entry in "${entries[@]}"; do
    local name
    name="$(basename "$entry")"
    if [[ -e "$target_dir/$name" ]]; then
      echo "Ueberspringe bestehendes Ziel $target_dir/$name waehrend der Legacy-Migration." >&2
      continue
    fi
    mv "$entry" "$target_dir/$name"
  done

  rmdir "$source_dir" 2>/dev/null || true
}

function move_file_if_present() {
  local source_path="${1:-}"
  local target_path="${2:-}"

  if [[ -z "$source_path" || -z "$target_path" || ! -e "$source_path" ]]; then
    return 0
  fi

  mkdir -p "$(dirname "$target_path")"
  if [[ -e "$target_path" ]]; then
    echo "Ueberspringe bestehendes Ziel $target_path waehrend der Legacy-Migration." >&2
    return 0
  fi

  mv "$source_path" "$target_path"
}

function assert_supported_layout() {
  if [[ -e "$APP_DIR" && ! -d "$APP_DIR" ]]; then
    echo "App-Pfad $APP_DIR existiert, ist aber kein Verzeichnis." >&2
    exit 1
  fi

  if [[ -e "$LEGACY_APP_DIR" && ! -d "$LEGACY_APP_DIR" ]]; then
    echo "Legacy-App-Pfad $LEGACY_APP_DIR existiert, ist aber kein Verzeichnis." >&2
    exit 1
  fi
}

function migrate_legacy_config_files() {
  local legacy_config_json="$LEGACY_APP_DIR/config.json"
  local entry=""
  local base_name=""

  if [[ ! -d "$LEGACY_APP_DIR" ]]; then
    return 0
  fi

  move_file_if_present "$legacy_config_json" "$CONFIG_PATH"

  shopt -s nullglob
  for entry in "$LEGACY_APP_DIR"/config*.json; do
    base_name="$(basename "$entry")"
    if [[ "$base_name" == "config.example.json" || "$entry" == "$legacy_config_json" ]]; then
      continue
    fi
    move_file_if_present "$entry" "$CONFIG_DIR/$base_name"
  done
  shopt -u nullglob
}

function migrate_legacy_data_files() {
  local entry=""
  local base_name=""

  if [[ ! -d "$LEGACY_APP_DIR" ]]; then
    return 0
  fi

  move_dir_contents_if_present "$LEGACY_APP_DIR/data" "$DATA_DIR"

  shopt -s nullglob
  for entry in \
    "$LEGACY_APP_DIR"/*.sqlite \
    "$LEGACY_APP_DIR"/*.sqlite-* \
    "$LEGACY_APP_DIR"/*.db \
    "$LEGACY_APP_DIR"/*.db-* \
    "$LEGACY_APP_DIR"/energy_state.json; do
    base_name="$(basename "$entry")"
    move_file_if_present "$entry" "$DATA_DIR/$base_name"
  done
  shopt -u nullglob
}

function remove_legacy_app_dir() {
  if [[ -d "$LEGACY_APP_DIR" && "$LEGACY_APP_DIR" != "$APP_DIR" ]]; then
    rm -rf "$LEGACY_APP_DIR"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO_URL="$2"
      shift 2
      ;;
    --branch)
      REPO_BRANCH="$2"
      shift 2
      ;;
    --dir)
      INSTALL_DIR="$2"
      APP_DIR="$INSTALL_DIR/dvhub"
      shift 2
      ;;
    --config)
      CONFIG_PATH="$2"
      CONFIG_DIR="$(dirname "$CONFIG_PATH")"
      shift 2
      ;;
    --data-dir)
      DATA_DIR="$2"
      shift 2
      ;;
    --channel)
      UPDATE_CHANNEL="$2"
      shift 2
      ;;
    --with-eos)
      # Backwards-compatible no-op: EOS is installed by default now.
      EOS_INSTALL=1
      shift
      ;;
    --no-eos)
      # Opt out of the default DV-EOS install (e.g. low-RAM/headless boxes).
      EOS_INSTALL=0
      shift
      ;;
    --no-support-user)
      # T-0113: opt out of the dvhub-support remote-support login user.
      SUPPORT_LOCAL_USER=0
      shift
      ;;
    *)
      echo "Unbekannter Parameter: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -n "$UPDATE_CHANNEL" && "$UPDATE_CHANNEL" != "stable" && "$UPDATE_CHANNEL" != "dev" ]]; then
  echo "Ungueltiger Channel: $UPDATE_CHANNEL (erlaubt: stable, dev)" >&2
  exit 1
fi
if [[ -z "$UPDATE_CHANNEL" ]]; then
  UPDATE_CHANNEL="stable"
fi

if [[ -z "$REPO_BRANCH" ]]; then
  REPO_BRANCH="$(resolve_default_repo_branch || true)"
fi
if [[ -z "$REPO_BRANCH" ]]; then
  REPO_BRANCH="main"
fi

if [[ "${EUID}" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    exec sudo --preserve-env=INSTALLER_SOURCE_URL,REPO_URL,REPO_BRANCH,UPDATE_CHANNEL,INSTALL_DIR,APP_DIR,SERVICE_USER,SERVICE_NAME,CONFIG_DIR,CONFIG_PATH,DATA_DIR,SUPPORT_LOCAL_USER bash "$0" "$@"
  fi
  echo "Dieses Skript muss als root ausgeführt werden." >&2
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "Dieses install.sh unterstuetzt aktuell Debian/Ubuntu mit apt-get." >&2
  exit 1
fi

assert_supported_layout

echo "[1/7] Pakete installieren"
apt-get update
# python3-venv + python3-pip: a fresh Debian/Ubuntu ships the `venv` stdlib stub
# but NOT ensurepip — so `python3 -m venv <dir>` fails until python3-venv is
# present (T-0118: prod only worked because the package happened to be installed).
# Distro-generic name pulls python3.11-venv@Debian12 / python3.12-venv@Ubuntu24.
# autossh + openssh-client: T-0113 reverse-SSH support tunnel (autossh self-heals
# the outbound tunnel; ssh-keygen from openssh-client mints the relay keypair).
apt-get install -y curl ca-certificates git sudo postgresql openvpn wireguard-tools strongswan python3-venv python3-pip autossh openssh-client

if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)'; then
  echo "[2/7] Node.js 22 installieren"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
else
  echo "[2/7] Node.js vorhanden: $(node --version)"
fi

echo "[3/7] Service-User vorbereiten"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

echo "[4/7] Repository bereitstellen"
mkdir -p "$(dirname "$INSTALL_DIR")"
migrate_legacy_config_files
migrate_legacy_data_files
if [[ -d "$INSTALL_DIR/.git" ]]; then
  if ! git config --global --get-all safe.directory 2>/dev/null | grep -Fxq "$INSTALL_DIR"; then
    git config --global --add safe.directory "$INSTALL_DIR"
  fi
  git -C "$INSTALL_DIR" fetch --tags origin
elif [[ -d "$INSTALL_DIR" && -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]]; then
  echo "Zielverzeichnis $INSTALL_DIR ist nicht leer und kein Git-Repository." >&2
  exit 1
else
  rm -rf "$INSTALL_DIR"
  git clone --branch "$REPO_BRANCH" "$REPO_URL" "$INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch --tags origin
fi

# Channel-aware checkout
if [[ "$UPDATE_CHANNEL" == "stable" ]]; then
  # W5.1: semver-filter so a stray non-release tag (CI/build/bare-numeric) can never
  # win; kept in spirit with the JS SEMVER_TAG export in dvhub/routes-api.js. The
  # else-branch below already handles "nothing matched" (falls back to REPO_BRANCH).
  LATEST_TAG="$(git -C "$INSTALL_DIR" tag --sort=-v:refname | grep -E '^v?[0-9]+\.[0-9]+(\.[0-9]+)?$' | head -1)"
  if [[ -n "$LATEST_TAG" ]]; then
    echo "   Channel: stable — checkout $LATEST_TAG"
    git -C "$INSTALL_DIR" checkout "$LATEST_TAG"
  else
    echo "   Keine Release-Tags gefunden, verwende $REPO_BRANCH"
    git -C "$INSTALL_DIR" checkout -B "$REPO_BRANCH" "origin/$REPO_BRANCH"
  fi
else
  echo "   Channel: dev — checkout origin/$REPO_BRANCH"
  git -C "$INSTALL_DIR" checkout -B "$REPO_BRANCH" "origin/$REPO_BRANCH"
fi

remove_legacy_app_dir

if [[ ! -f "$APP_DIR/package.json" ]]; then
  echo "Konnte die Webapp unter $APP_DIR nicht finden." >&2
  exit 1
fi

echo "[5/7] Node-Abhaengigkeiten installieren"
cd "$APP_DIR"
npm install --omit=dev

# Allow node to bind privileged ports (e.g. 502 for Modbus with VPN)
NODE_BIN="$(command -v node)"
if [[ -n "$NODE_BIN" ]]; then
  setcap cap_net_bind_service=+ep "$NODE_BIN" 2>/dev/null || true
fi

# --- Python venv for PV forecast + ML stack (shared forecast-provision.sh) ---
# The provisioning logic lives in the shared forecast-provision.sh (single source
# of truth, mirrors eos-provision.sh / support-provision.sh) so install.sh and
# post-update.sh never drift — boxes installed before the forecast-venv existed
# get it retrofitted on update. Holds the full ML stack (pvlib, lightgbm,
# scikit-learn, statsforecast, …) hash-pinned in python/requirements.lock and the
# ml-models directory. The repo is already cloned to $INSTALL_DIR here, so
# $INSTALL_DIR/forecast-provision.sh exists.
install_forecast() {
  if [ ! -f "$INSTALL_DIR/forecast-provision.sh" ]; then
    echo "  Forecast: forecast-provision.sh nicht gefunden ($INSTALL_DIR) — uebersprungen"
    return 0
  fi
  SERVICE_USER="$SERVICE_USER" INSTALL_DIR="$INSTALL_DIR" APP_DIR="$APP_DIR" DATA_DIR="$DATA_DIR" \
    bash "$INSTALL_DIR/forecast-provision.sh"
}
# Non-fatal (subshell + `|| true`) — a forecast-venv hiccup must never abort the
# essential install tail (config/DB/systemd) that follows.
( install_forecast ) || echo "  Forecast: venv-Setup fehlgeschlagen — uebersprungen, Kern-Install laeuft weiter"

# --- EOS (Akkudoktor) Installation — DEFAULT (DV fork), RAM-gated >=3GB, opt-out via --no-eos ---
# The provisioning logic lives in the shared eos-provision.sh (single source of
# truth, mirrors the support-provision.sh pattern) so install.sh and
# post-update.sh never drift. The repo is already cloned to $INSTALL_DIR here, so
# $INSTALL_DIR/eos-provision.sh exists.
install_eos() {
  if [ ! -f "$INSTALL_DIR/eos-provision.sh" ]; then
    echo "  EOS: eos-provision.sh nicht gefunden ($INSTALL_DIR) — uebersprungen"
    return 0
  fi
  # EOS_REPO_URL/EOS_BRANCH overrides flow through the inherited environment.
  SERVICE_USER="$SERVICE_USER" INSTALL_DIR="$INSTALL_DIR" DATA_DIR="$DATA_DIR" \
    bash "$INSTALL_DIR/eos-provision.sh"
}

if [ "${EOS_INSTALL:-1}" = "1" ]; then
  # Clear any stale opt-out marker so post-update.sh keeps EOS reconciled.
  rm -f "$DATA_DIR/.no-eos" 2>/dev/null || true
  # T-0118: subshell + `|| true` — an EOS install failure must not abort the
  # essential tail (config/DB/systemd) that follows.
  ( install_eos ) || echo "  EOS: Installation fehlgeschlagen — uebersprungen, Kern-Install laeuft weiter"
else
  echo "  EOS: Uebersprungen (--no-eos gesetzt) — Opt-out wird fuer Updates gemerkt"
  # Persist the opt-out so post-update.sh does NOT retrofit EOS on this box.
  mkdir -p "$DATA_DIR" 2>/dev/null || true
  touch "$DATA_DIR/.no-eos" 2>/dev/null || true
fi

echo "[6/7] Config-Pfad und Rechte vorbereiten"
mkdir -p "$CONFIG_DIR"
mkdir -p "$CONFIG_DIR/hersteller"
mkdir -p "$CONFIG_DIR/vpn/profiles"
mkdir -p "$CONFIG_DIR/tls"
mkdir -p "$DATA_DIR"

# Generate self-signed TLS certificate if not present
if [[ ! -f "$CONFIG_DIR/tls/cert.pem" ]]; then
  echo "   Generiere Self-Signed TLS Zertifikat..."
  # Plan 08-05 Task 1: 397 days (≤ 398) keeps the cert browser-compatible
  # (Apple/Chrome/Mozilla hard-limit since Sep 2020). Was 3650 (10y).
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$CONFIG_DIR/tls/key.pem" \
    -out "$CONFIG_DIR/tls/cert.pem" \
    -days 397 -subj "/CN=dvhub/O=DVhub/C=DE" 2>/dev/null
  chmod 600 "$CONFIG_DIR/tls/key.pem"
fi
if [[ ! -f "$CONFIG_PATH" ]]; then
  cp "$APP_DIR/config.example.json" "$CONFIG_PATH"
fi
# Set updateChannel in config if not already present
if command -v node >/dev/null 2>&1 && [[ -f "$CONFIG_PATH" ]]; then
  node -e "
    const fs = require('fs');
    const crypto = require('crypto');
    const p = '$CONFIG_PATH';
    try {
      const c = JSON.parse(fs.readFileSync(p, 'utf8'));
      let changed = false;
      if (!c.updateChannel) { c.updateChannel = '$UPDATE_CHANNEL'; changed = true; }
      // T-0118: the systemd unit sets DV_ENABLE_SERVICE_ACTIONS=1 and the app
      // refuses to start without an apiToken >= 16 chars (crash-loop on a fresh
      // install whose config.example.json has none). Generate a strong random
      // token so the service comes up clean on first boot.
      if (!c.apiToken || String(c.apiToken).length < 16) {
        c.apiToken = crypto.randomBytes(24).toString('hex');
        changed = true;
      }
      // T-0113: persist the support-user opt-out choice so the UI + post-update
      // reconcile consistently. '1' => remote-support ready (default), '0' => off.
      const wantSupportUser = '$SUPPORT_LOCAL_USER' !== '0';
      c.support = c.support || {};
      c.support.localUser = c.support.localUser || {};
      if (c.support.localUser.enabled === undefined) { c.support.localUser.enabled = wantSupportUser; changed = true; }
      if (changed) fs.writeFileSync(p, JSON.stringify(c, null, 2) + '\n');
    } catch {}
  "
fi
if [[ ! -f "$CONFIG_DIR/hersteller/victron.json" ]]; then
  cp "$APP_DIR/hersteller/victron.json" "$CONFIG_DIR/hersteller/victron.json"
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR" "$CONFIG_DIR" "$DATA_DIR"
chmod 750 "$CONFIG_DIR"
chmod 750 "$DATA_DIR"
chmod 700 "$CONFIG_DIR/vpn"
chmod 700 "$CONFIG_DIR/vpn/profiles"

# PostgreSQL: Datenbank und User anlegen falls noch nicht vorhanden
if command -v psql >/dev/null 2>&1; then
  systemctl enable --now postgresql 2>/dev/null || true
  if ! su - postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='dvhub'\"" 2>/dev/null | grep -q 1; then
    su - postgres -c "createuser dvhub" 2>/dev/null || true
  fi
  if ! su - postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='dvhub'\"" 2>/dev/null | grep -q 1; then
    su - postgres -c "createdb -O dvhub dvhub" 2>/dev/null || true
  fi
  # Peer-Auth: dvhub system user kann sich ohne Passwort verbinden
  PG_HBA="$(find /etc/postgresql -name pg_hba.conf 2>/dev/null | head -1)"
  if [[ -n "$PG_HBA" ]]; then
    # Remove old md5/scram entries for dvhub, ensure peer auth
    sed -i '/dvhub.*dvhub.*\(md5\|scram-sha-256\)/d' "$PG_HBA" 2>/dev/null || true
    if ! grep -q "local.*dvhub.*dvhub.*peer" "$PG_HBA" 2>/dev/null; then
      sed -i '1i local   dvhub   dvhub   peer' "$PG_HBA"
    fi
    systemctl reload postgresql 2>/dev/null || true
  fi

  # TimescaleDB: provision the hypertable engine so a fresh box matches prod and
  # a production DB backup can be restored onto it (Christin 2026-07-02 — the
  # installer previously provisioned it on NO platform, leaving fresh installs
  # silently degraded on plain Postgres + backup-restore impossible). Shared
  # timescale-provision.sh (single source of truth with post-update.sh). Installs
  # the COMMUNITY/TSL edition from Timescale's apt repo (compression + continuous
  # aggregates → full prod parity; migration 014 needs them). Falls back to the
  # Debian Apache package if packagecloud has no build for the platform. Non-fatal
  # (subshell + `|| true`): a box that can't get any package stays on plain
  # Postgres (config timescaledb stays false) — never a crash.
  if [[ -f "$INSTALL_DIR/timescale-provision.sh" ]]; then
    ( SERVICE_USER="$SERVICE_USER" DATA_DIR="$DATA_DIR" CONFIG_PATH="$CONFIG_PATH" DB_NAME=dvhub \
        bash "$INSTALL_DIR/timescale-provision.sh" ) \
      || echo "  TimescaleDB: Provisionierung fehlgeschlagen (non-fatal) — Box läuft auf reinem Postgres." >&2
  fi
fi

# T-0113 Tier 3: provision the support-tunnel prerequisites (appliance-id, relay
# keypair, hostkey pin, relay sidecar, optional dvhub-support login user). Shared
# with post-update.sh so they never drift. Non-fatal — a provisioning hiccup must
# never abort the core install.
if [[ -f "$INSTALL_DIR/support-provision.sh" ]]; then
  echo "[6b/7] Support-Provisioning (T-0113)"
  ( SERVICE_USER="$SERVICE_USER" DATA_DIR="$DATA_DIR" CONFIG_PATH="$CONFIG_PATH" SUPPORT_LOCAL_USER="$SUPPORT_LOCAL_USER" \
      bash "$INSTALL_DIR/support-provision.sh" ) \
    || echo "  Support: Provisioning fehlgeschlagen (non-fatal) — Fern-Support ggf. erst nach dem nächsten Neustart bereit." >&2
fi

echo "[7/7] systemd Service einrichten"
SYSTEMCTL_PATH="$(command -v systemctl)"
OPENVPN_PATH="$(command -v openvpn || echo /usr/sbin/openvpn)"
WG_QUICK_PATH="$(command -v wg-quick || echo /usr/bin/wg-quick)"
WG_PATH="$(command -v wg || echo /usr/bin/wg)"
IPSEC_PATH="$(command -v ipsec || echo /usr/sbin/ipsec)"
LN_PATH="$(command -v ln || echo /usr/bin/ln)"
RM_PATH="$(command -v rm || echo /usr/bin/rm)"
IP_PATH="$(command -v ip || echo /usr/sbin/ip)"
PKILL_PATH="$(command -v pkill || echo /usr/bin/pkill)"
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
chmod 440 "${SUDOERS_FILE}"

cat >/etc/systemd/system/${SERVICE_NAME}.service <<SERVICE
[Unit]
Description=DVhub DV Control
# T-0080 P1: order after PostgreSQL so the telemetry store does not boot into
# a half-up DB after a host reboot (Proxmox stop-mode backups reboot the LXC).
# After= is ordering-only — a Postgres-less install (SQLite store) is NOT
# blocked because there is no Requires=/Wants= on postgresql.
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
# Phase 16 D-09: run post-update.sh on every service start so the sudoers block
# stays current regardless of deploy mechanism (tar|ssh never triggers /api/admin/update/apply).
# Prefixes: '+' runs as root despite User=${SERVICE_USER} (post-update.sh requires root);
# T-0077 '-' makes a non-zero exit NON-FATAL — a failed post-update (e.g. an offline
# Proxmox stop-mode backup reboot where apt/npm can't reach the network) must NEVER
# block ExecStart, or the box stays down until manual intervention. post-update.sh is
# itself hardened so its network steps are non-fatal; the '-' is the belt-and-suspenders.
ExecStartPre=-+/usr/bin/bash ${INSTALL_DIR}/post-update.sh
ExecStart=/usr/bin/node ${APP_DIR}/server.js
Environment=NODE_ENV=production
Environment=DV_APP_CONFIG=${CONFIG_PATH}
Environment=DV_ENABLE_SERVICE_ACTIONS=1
Environment=DV_SERVICE_NAME=${SERVICE_NAME}.service
Environment=DV_SERVICE_USE_SUDO=1
Environment=DV_DATA_DIR=${DATA_DIR}
Restart=always
RestartSec=3
# T-0077 (P0-3, Hub-refute Auflage): the '-' prefix on ExecStartPre ignores a
# non-zero EXIT code, but NOT a hang — without an explicit start timeout a
# post-update.sh that wedges on a dead-but-accepting network (e.g. npm/apt
# blocking) would hit systemd's default 90s start timeout and Restart=always
# loops it. A bounded TimeoutStartSec lets a wedged start fail fast and cleanly
# (the next boot's post-update is non-fatal anyway), so the node server still
# comes up. 120s leaves headroom over post-update.sh's own internal timeouts.
TimeoutStartSec=120
# A2 (Improvements 2026-07-02): belt-and-braces to the in-app 5s shutdown
# watchdog (gracefulShutdown races every async teardown step). Should a SYNC
# teardown step or the node process itself ever wedge on SIGTERM, systemd cuts
# over to SIGKILL after 15s instead of the 90s default — the app needs ~1-6s
# for a clean stop, so 15s leaves ample headroom without long outages.
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}.service"
systemctl restart "${SERVICE_NAME}.service"

# TimescaleDB package maintenance timer (Christin 2026-07-02, "Pakete auto"): a
# nightly oneshot keeps the TimescaleDB apt package family current WITHOUT
# restarting Postgres. The disruptive extension bump stays operator-gated behind
# the GUI "Jetzt aktualisieren" button (POST /api/db/timescale/upgrade). The unit
# body is kept in sync with the create-if-missing block in post-update.sh.
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
systemctl daemon-reload
systemctl enable --now dvhub-pkg-maintain.timer >/dev/null 2>&1 || true

PRIMARY_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [[ -z "${PRIMARY_IP}" ]]; then
  PRIMARY_IP="127.0.0.1"
fi

# A-3 (Go-Live-Review 2026-06-10): print the REAL listen port. The server binds
# cfg.httpPort (default 80, see config.example.json) — the old hard-coded :8080
# echo printed a dead URL for every fresh install (deploy-test.sh already flagged
# this: "app httpPort from config.json (NOT 8080)"). Read it back from the config
# we just wrote; fall back to 80.
SETUP_HTTP_PORT="80"
if command -v node >/dev/null 2>&1 && [[ -f "$CONFIG_PATH" ]]; then
  SETUP_HTTP_PORT="$(node -e "try{const c=require('$CONFIG_PATH');process.stdout.write(String(c.httpPort||80))}catch{process.stdout.write('80')}" 2>/dev/null || echo 80)"
fi

echo
echo "DVhub wurde installiert."
echo "Service: systemctl status ${SERVICE_NAME}.service"
echo "Config-Datei: ${CONFIG_PATH}"
echo "Herstellerprofil: ${CONFIG_DIR}/hersteller/victron.json"
echo "Datenverzeichnis: ${DATA_DIR}"
echo "Datenbank: PostgreSQL (dvhub)"
echo "Setup-Oberfläche: http://${PRIMARY_IP}:${SETUP_HTTP_PORT}/"
echo
echo "DVhub nutzt eine externe Betriebs-Config und ein separates Herstellerprofil."
echo "Technische Register und Victron-spezifische Kommunikationswerte liegen in ${CONFIG_DIR}/hersteller/victron.json."
echo "Restart-Button und Health-Check sind über die Einstellungen aktiv."
echo "Die Telemetrie-Daten werden in PostgreSQL gespeichert und ab dem ersten Start automatisch erfasst."
echo
if [[ "$SUPPORT_LOCAL_USER" != "0" ]]; then
  echo "Fern-Support: Bereitschaft AKTIV (Login-User 'dvhub-support', kein sudo) — abschaltbar mit --no-support-user."
  echo "  Der Support kommt NUR rein, wenn DU in den Einstellungen einen Tunnel öffnest (zeitbegrenzt, abbrechbar)."
  echo "  Box-Kennung (appliance-id): $(cat "${DATA_DIR}/appliance-id" 2>/dev/null || echo '<wird beim ersten Start erzeugt>')"
else
  echo "Fern-Support: DEAKTIVIERT (--no-support-user) — kein dvhub-support-User, kein Fern-Zugang. Nachträglich in den Einstellungen aktivierbar."
fi
