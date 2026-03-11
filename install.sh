#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/chloepriceless/dvhub.git}"
REPO_BRANCH="${REPO_BRANCH:-}"
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
    *)
      echo "Unbekannter Parameter: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$REPO_BRANCH" ]]; then
  REPO_BRANCH="$(resolve_default_repo_branch || true)"
fi
if [[ -z "$REPO_BRANCH" ]]; then
  REPO_BRANCH="main"
fi

if [[ "${EUID}" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    exec sudo --preserve-env=INSTALLER_SOURCE_URL,REPO_URL,REPO_BRANCH,INSTALL_DIR,APP_DIR,SERVICE_USER,SERVICE_NAME,CONFIG_DIR,CONFIG_PATH,DATA_DIR bash "$0" "$@"
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
apt-get install -y curl ca-certificates git sudo

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
  git -C "$INSTALL_DIR" checkout -B "$REPO_BRANCH" "origin/$REPO_BRANCH"
elif [[ -d "$INSTALL_DIR" && -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]]; then
  echo "Zielverzeichnis $INSTALL_DIR ist nicht leer und kein Git-Repository." >&2
  exit 1
else
  rm -rf "$INSTALL_DIR"
  git clone --branch "$REPO_BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

remove_legacy_app_dir

if [[ ! -f "$APP_DIR/package.json" ]]; then
  echo "Konnte die Webapp unter $APP_DIR nicht finden." >&2
  exit 1
fi

echo "[5/7] Node-Abhaengigkeiten installieren"
cd "$APP_DIR"
npm install --omit=dev

echo "[6/7] Config-Pfad und Rechte vorbereiten"
mkdir -p "$CONFIG_DIR"
mkdir -p "$DATA_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR" "$CONFIG_DIR" "$DATA_DIR"
chmod 750 "$CONFIG_DIR"
chmod 750 "$DATA_DIR"

echo "[7/7] systemd Service einrichten"
SYSTEMCTL_PATH="$(command -v systemctl)"
SUDOERS_FILE="/etc/sudoers.d/${SERVICE_NAME}-service-actions"

cat >"${SUDOERS_FILE}" <<SUDOERS
${SERVICE_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL_PATH} restart ${SERVICE_NAME}.service
${SERVICE_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL_PATH} is-active ${SERVICE_NAME}.service
${SERVICE_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL_PATH} show ${SERVICE_NAME}.service *
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
ExecStart=/usr/bin/node --experimental-sqlite ${APP_DIR}/server.js
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
echo "Datenverzeichnis: ${DATA_DIR}"
echo "Interne Historie: ${DATA_DIR}/telemetry.sqlite"
echo "Setup-Oberfläche: http://${PRIMARY_IP}:8080/"
echo
echo "Da der Service eine externe Config-Datei nutzt, erscheint beim ersten Aufruf automatisch der Setup-Assistent,"
echo "solange ${CONFIG_PATH} noch nicht angelegt wurde."
echo "Restart-Button und Health-Check sind über die Einstellungen aktiv."
echo "Die interne Telemetrie-Datenbank wird automatisch aufgebaut und schreibt ab dem ersten Start alle relevanten Daten mit."
