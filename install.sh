#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/chloepriceless/dvhub.git}"
REPO_BRANCH="${REPO_BRANCH:-feature/schedule-mqtt}"
INSTALL_DIR="${INSTALL_DIR:-/opt/dvhub}"
APP_DIR="${APP_DIR:-$INSTALL_DIR/dv-control-webapp}"
SERVICE_USER="${SERVICE_USER:-dvhub}"
SERVICE_NAME="${SERVICE_NAME:-dvhub}"
CONFIG_DIR="${CONFIG_DIR:-/etc/dvhub}"
CONFIG_PATH="${CONFIG_PATH:-$CONFIG_DIR/config.json}"
DATA_DIR="${DATA_DIR:-/var/lib/dvhub}"

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
      APP_DIR="$INSTALL_DIR/dv-control-webapp"
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

if [[ "${EUID}" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    exec sudo --preserve-env=REPO_URL,REPO_BRANCH,INSTALL_DIR,APP_DIR,SERVICE_USER,SERVICE_NAME,CONFIG_DIR,CONFIG_PATH,DATA_DIR bash "$0" "$@"
  fi
  echo "Dieses Skript muss als root ausgeführt werden." >&2
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "Dieses install.sh unterstuetzt aktuell Debian/Ubuntu mit apt-get." >&2
  exit 1
fi

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
if [[ -d "$INSTALL_DIR/.git" ]]; then
  git -C "$INSTALL_DIR" fetch --tags origin
  git -C "$INSTALL_DIR" checkout "$REPO_BRANCH"
  git -C "$INSTALL_DIR" pull --ff-only origin "$REPO_BRANCH"
elif [[ -d "$INSTALL_DIR" && -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]]; then
  echo "Zielverzeichnis $INSTALL_DIR ist nicht leer und kein Git-Repository." >&2
  exit 1
else
  rm -rf "$INSTALL_DIR"
  git clone --branch "$REPO_BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

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
