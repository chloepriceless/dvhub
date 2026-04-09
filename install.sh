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
      EOS_INSTALL=1
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
    exec sudo --preserve-env=INSTALLER_SOURCE_URL,REPO_URL,REPO_BRANCH,UPDATE_CHANNEL,INSTALL_DIR,APP_DIR,SERVICE_USER,SERVICE_NAME,CONFIG_DIR,CONFIG_PATH,DATA_DIR bash "$0" "$@"
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
apt-get install -y curl ca-certificates git sudo postgresql openvpn wireguard-tools strongswan

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
  LATEST_TAG="$(git -C "$INSTALL_DIR" tag --sort=-v:refname | head -1)"
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

# --- Python venv for PV forecast (optional, Tier 2+) ---
echo "Setting up Python forecast environment..."
VENV_DIR="/opt/dvhub/forecast-venv"
REQUIREMENTS="$APP_DIR/python/requirements.txt"

if command -v python3 &>/dev/null; then
  PYTHON_VERSION=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
  echo "Found Python $PYTHON_VERSION"

  # Ensure python3-venv is available
  if ! python3 -m venv --help &>/dev/null 2>&1; then
    echo "Installing python3-venv..."
    sudo apt-get install -y python3-venv 2>/dev/null || true
  fi

  if [ -f "$REQUIREMENTS" ]; then
    echo "Creating forecast venv at $VENV_DIR..."
    sudo mkdir -p "$(dirname "$VENV_DIR")"
    sudo python3 -m venv "$VENV_DIR"
    sudo "$VENV_DIR/bin/pip" install --upgrade pip
    sudo "$VENV_DIR/bin/pip" install -r "$REQUIREMENTS"
    echo "Forecast venv created successfully."
  else
    echo "No requirements.txt found, skipping Python forecast setup."
  fi
else
  echo "Python3 not found. PV forecast will use Solcast API only (Tier 1 mode)."
fi

# --- ML Dependencies (Tier 2+) ---
install_ml_deps() {
  local RAM_MB
  RAM_MB=$(free -m 2>/dev/null | awk '/^Mem:/{print $2}' || echo 0)

  if [ "$RAM_MB" -ge 2000 ]; then
    echo "  ML: Tier 2+ erkannt (${RAM_MB}MB RAM) — installiere ML-Pakete..."
    sudo "$VENV_DIR/bin/pip" install --quiet \
      'scikit-learn>=1.5,<2.0' \
      'lightgbm>=4.5,<5.0' \
      'statsforecast>=2.0,<3.0' \
      'joblib>=1.3,<2.0' 2>&1 | tail -5
    echo "  ML: Pakete installiert."

    # Create model directory
    sudo mkdir -p /opt/dvhub/ml-models
    sudo chown "$(whoami)" /opt/dvhub/ml-models 2>/dev/null || true
    echo "  ML: Modell-Verzeichnis /opt/dvhub/ml-models erstellt."
  else
    echo "  ML: Uebersprungen (RAM ${RAM_MB}MB < 2GB, Tier 1)"
  fi

  # --- Ollama + TinyLlama (Tier 3 only, 8GB+) ---
  if [ "$RAM_MB" -ge 7500 ]; then
    echo "  LLM: Tier 3 erkannt (${RAM_MB}MB RAM) — installiere Ollama + TinyLlama..."
    if ! command -v ollama &>/dev/null; then
      curl -fsSL https://ollama.com/install.sh | sh
      echo "  LLM: Ollama installiert."
    else
      echo "  LLM: Ollama bereits installiert."
    fi

    # Pull TinyLlama model (if not already present)
    if ollama list 2>/dev/null | grep -q "tinyllama"; then
      echo "  LLM: TinyLlama Modell bereits vorhanden."
    else
      echo "  LLM: Lade TinyLlama Modell herunter (~637MB)..."
      ollama pull tinyllama
      echo "  LLM: TinyLlama Modell geladen."
    fi

    # Ensure Ollama service is enabled
    sudo systemctl enable ollama 2>/dev/null || true
    sudo systemctl start ollama 2>/dev/null || true
    echo "  LLM: Ollama Service aktiviert."

    # Ensure Ollama only listens on localhost (security)
    if [ -f /etc/systemd/system/ollama.service ]; then
      if ! grep -q "OLLAMA_HOST=127.0.0.1" /etc/systemd/system/ollama.service; then
        sudo sed -i '/\[Service\]/a Environment="OLLAMA_HOST=127.0.0.1"' /etc/systemd/system/ollama.service
        sudo systemctl daemon-reload
        sudo systemctl restart ollama 2>/dev/null || true
        echo "  LLM: Ollama auf 127.0.0.1 beschraenkt (Sicherheit)."
      fi
    fi
  else
    echo "  LLM: Uebersprungen (RAM ${RAM_MB}MB < 8GB, nicht Tier 3)"
  fi
}

# Install ML dependencies after Python venv is ready
install_ml_deps

# --- EOS (Akkudoktor) Installation (Tier 2+ only, optional) ---
install_eos() {
  local RAM_MB
  RAM_MB=$(free -m 2>/dev/null | awk '/^Mem:/{print $2}' || echo 0)
  if [ "$RAM_MB" -lt 3000 ]; then
    echo "  EOS: Uebersprungen (RAM ${RAM_MB}MB < 3GB, Tier 1)"
    return 0
  fi

  echo "  EOS: Pruefe Installation..."

  # Check if Docker is available
  if command -v docker &>/dev/null; then
    echo "  EOS: Docker gefunden, verwende Docker Image"
    local EOS_VERSION="v0.3.0"
    local EOS_IMAGE="akkudoktor/eos:${EOS_VERSION}"

    # Pull image if not present (idempotent)
    if ! docker image inspect "$EOS_IMAGE" &>/dev/null; then
      echo "  EOS: Lade Docker Image ${EOS_IMAGE}..."
      docker pull "$EOS_IMAGE" || { echo "  EOS: Docker Pull fehlgeschlagen"; return 1; }
    fi

    # Create systemd service for EOS Docker container
    # SECURITY: Bind to 127.0.0.1 ONLY (not 0.0.0.0) -- EOS is co-hosted, no external access
    cat > /etc/systemd/system/dvhub-eos.service << 'EOSUNIT'
[Unit]
Description=DVhub EOS Optimizer (Akkudoktor)
After=docker.service
Requires=docker.service

[Service]
Type=simple
Restart=on-failure
RestartSec=10
ExecStartPre=-/usr/bin/docker rm -f dvhub-eos
ExecStart=/usr/bin/docker run --name dvhub-eos --rm -p 127.0.0.1:8503:8503 akkudoktor/eos:v0.3.0
ExecStop=/usr/bin/docker stop dvhub-eos

[Install]
WantedBy=multi-user.target
EOSUNIT

    systemctl daemon-reload
    echo "  EOS: systemd Service dvhub-eos.service erstellt"
    echo "  EOS: Starte mit: systemctl enable --now dvhub-eos"

  else
    echo "  EOS: Docker nicht gefunden. Installiere Docker oder verwende pip:"
    echo "  EOS:   pip install akkudoktor-eos==0.3.0"
    echo "  EOS:   Dann manuell als systemd Service einrichten."
  fi
}

if [ "${EOS_INSTALL:-0}" = "1" ]; then
  install_eos
else
  echo "  EOS: Uebersprungen (--with-eos Flag nicht gesetzt)"
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
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$CONFIG_DIR/tls/key.pem" \
    -out "$CONFIG_DIR/tls/cert.pem" \
    -days 3650 -subj "/CN=dvhub/O=DVhub/C=DE" 2>/dev/null
  chmod 600 "$CONFIG_DIR/tls/key.pem"
fi
if [[ ! -f "$CONFIG_PATH" ]]; then
  cp "$APP_DIR/config.example.json" "$CONFIG_PATH"
fi
# Set updateChannel in config if not already present
if command -v node >/dev/null 2>&1 && [[ -f "$CONFIG_PATH" ]]; then
  node -e "
    const fs = require('fs');
    const p = '$CONFIG_PATH';
    try {
      const c = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!c.updateChannel) {
        c.updateChannel = '$UPDATE_CHANNEL';
        fs.writeFileSync(p, JSON.stringify(c, null, 2) + '\n');
      }
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
KILL_PATH="$(which kill 2>/dev/null || echo /usr/bin/kill)"
SUDOERS_FILE="/etc/sudoers.d/${SERVICE_NAME}-service-actions"

cat >"${SUDOERS_FILE}" <<SUDOERS
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
${SERVICE_USER} ALL=(root) NOPASSWD: ${LN_PATH} -sf *
${SERVICE_USER} ALL=(root) NOPASSWD: ${RM_PATH} -f /etc/ipsec.d/dvhub-*
${SERVICE_USER} ALL=(root) NOPASSWD: ${IP_PATH} link show *
${SERVICE_USER} ALL=(root) NOPASSWD: ${IP_PATH} addr show *
${SERVICE_USER} ALL=(root) NOPASSWD: ${KILL_PATH} -0 *
${SERVICE_USER} ALL=(root) NOPASSWD: ${KILL_PATH} -15 *
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/bash ${INSTALL_DIR}/post-update.sh
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/apt-get update *
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/apt-get upgrade *
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/apt list *
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/sbin/setcap *
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/sbin/reboot
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/fuser *
SUDOERS
chmod 440 "${SUDOERS_FILE}"

cat >/etc/systemd/system/${SERVICE_NAME}.service <<SERVICE
[Unit]
Description=DVhub DV Control
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node ${APP_DIR}/server.js
Environment=NODE_ENV=production
Environment=DV_APP_CONFIG=${CONFIG_PATH}
Environment=DV_ENABLE_SERVICE_ACTIONS=1
Environment=DV_SERVICE_NAME=${SERVICE_NAME}.service
Environment=DV_SERVICE_USE_SUDO=1
Environment=DV_DATA_DIR=${DATA_DIR}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}.service"
systemctl restart "${SERVICE_NAME}.service"

PRIMARY_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [[ -z "${PRIMARY_IP}" ]]; then
  PRIMARY_IP="127.0.0.1"
fi

echo
echo "DVhub wurde installiert."
echo "Service: systemctl status ${SERVICE_NAME}.service"
echo "Config-Datei: ${CONFIG_PATH}"
echo "Herstellerprofil: ${CONFIG_DIR}/hersteller/victron.json"
echo "Datenverzeichnis: ${DATA_DIR}"
echo "Datenbank: PostgreSQL (dvhub)"
echo "Setup-Oberfläche: http://${PRIMARY_IP}:8080/"
echo
echo "DVhub nutzt eine externe Betriebs-Config und ein separates Herstellerprofil."
echo "Technische Register und Victron-spezifische Kommunikationswerte liegen in ${CONFIG_DIR}/hersteller/victron.json."
echo "Restart-Button und Health-Check sind über die Einstellungen aktiv."
echo "Die Telemetrie-Daten werden in PostgreSQL gespeichert und ab dem ersten Start automatisch erfasst."
