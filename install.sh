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

  # Ensure python3-venv ACTUALLY works (T-0118): `venv --help` succeeds even
  # without ensurepip, so it must NOT be the probe. Test a real throwaway venv
  # creation; only that exposes a missing python3-venv/ensurepip.
  if ! python3 -m venv /tmp/_dvhub_venvtest &>/dev/null; then
    echo "Installing python3-venv..."
    sudo apt-get install -y python3-venv python3-pip 2>/dev/null || true
  fi
  rm -rf /tmp/_dvhub_venvtest

  if [ -f "$REQUIREMENTS" ]; then
    echo "Creating forecast venv at $VENV_DIR..."
    sudo mkdir -p "$(dirname "$VENV_DIR")"
    sudo python3 -m venv "$VENV_DIR"
    sudo "$VENV_DIR/bin/pip" install --upgrade pip
    # Plan 08-05 Task 3 (REPOLENS security/dependency-cves/002):
    # Prefer the hash-pinned lockfile (requirements.lock) when available.
    # --require-hashes rejects any wheel whose sha256 is not in the lockfile,
    # blocking transitive-dep substitution + upstream pypi compromise.
    REQUIREMENTS_LOCK="$APP_DIR/python/requirements.lock"
    if [ -f "$REQUIREMENTS_LOCK" ]; then
      echo "Installing from lockfile with --require-hashes ($REQUIREMENTS_LOCK)"
      sudo "$VENV_DIR/bin/pip" install --require-hashes --no-deps -r "$REQUIREMENTS_LOCK"
    else
      sudo "$VENV_DIR/bin/pip" install -r "$REQUIREMENTS"
    fi
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
      # Plan 08-05 Task 3 (REPOLENS security/dependency-cves/001):
      # curl | sh lets the upstream (or any MITM) run arbitrary root code.
      # Pin to a known version and verify sha256 before installing.
      OLLAMA_VERSION="0.1.48"
      OLLAMA_UNAME_M="$(uname -m)"
      case "$OLLAMA_UNAME_M" in
        x86_64|amd64)
          OLLAMA_ARCH="amd64"
          OLLAMA_SHA256="7641b21e9d0822ba44e494f5ed3d3796d9e9fcdf4dbb66064f8c34c865bbec0b"
          ;;
        aarch64|arm64)
          OLLAMA_ARCH="arm64"
          OLLAMA_SHA256="8ccaea237c3ef2a34d0cc00d8a89ffb1179d5c49211b6cbdf80d8d88e3f0add6"
          ;;
        *)
          echo "  LLM: Unbekannte Architektur ${OLLAMA_UNAME_M} — Ollama wird uebersprungen."
          OLLAMA_ARCH=""
          ;;
      esac
      if [ -n "$OLLAMA_ARCH" ]; then
        OLLAMA_URL="https://github.com/ollama/ollama/releases/download/v${OLLAMA_VERSION}/ollama-linux-${OLLAMA_ARCH}"
        OLLAMA_TMP="$(mktemp)"
        echo "  LLM: Lade Ollama v${OLLAMA_VERSION} (${OLLAMA_ARCH}) herunter..."
        if curl -fsSL -o "$OLLAMA_TMP" "$OLLAMA_URL"; then
          echo "${OLLAMA_SHA256}  ${OLLAMA_TMP}" | sha256sum -c - >/dev/null 2>&1 || {
            echo "  LLM: sha256 checksum mismatch — Installation abgebrochen."
            rm -f "$OLLAMA_TMP"
            exit 1
          }
          sudo install -m 0755 "$OLLAMA_TMP" /usr/local/bin/ollama
          rm -f "$OLLAMA_TMP"
          echo "  LLM: Ollama installiert (sha256 verifiziert)."

          # A-2 (Go-Live-Review 2026-06-10): the official `curl|sh` installer
          # creates the systemd unit + the `ollama` service user; our pinned
          # binary download does NOT. Without a unit, the `systemctl enable
          # --now ollama` below fails on every fresh host and the TinyLlama pull
          # runs against a dead daemon. Create a minimal unit ourselves, bound to
          # 127.0.0.1 (the security posture the post-install sed at the bottom of
          # this block also enforces — kept idempotent). Best-effort: a unit-write
          # hiccup must not abort the optional LLM tier.
          if ! id ollama >/dev/null 2>&1; then
            sudo useradd --system --create-home --home-dir /usr/share/ollama --shell /usr/sbin/nologin ollama 2>/dev/null || true
          fi
          if [ ! -f /etc/systemd/system/ollama.service ]; then
            cat <<OLLAMA_UNIT | sudo tee /etc/systemd/system/ollama.service >/dev/null
[Unit]
Description=Ollama Service (DVhub LLM tile)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/ollama serve
User=ollama
Group=ollama
Restart=on-failure
RestartSec=3
Environment=OLLAMA_HOST=127.0.0.1
# Persist pulled models across restarts under the service user's home.
Environment=HOME=/usr/share/ollama

[Install]
WantedBy=multi-user.target
OLLAMA_UNIT
            sudo systemctl daemon-reload
            echo "  LLM: ollama.service angelegt (127.0.0.1, User ollama)."
          fi
        else
          echo "  LLM: Download von ${OLLAMA_URL} fehlgeschlagen — Ollama wird uebersprungen."
          rm -f "$OLLAMA_TMP"
        fi
      fi
    else
      echo "  LLM: Ollama bereits installiert."
    fi

    # T-0118: start the Ollama daemon BEFORE pulling (the pull needs a running
    # server, else "could not connect to ollama app") and call ollama by an
    # explicit path — /usr/local/bin is frequently off a non-login-shell PATH on
    # a fresh host. The pull is best-effort: the LLM tile is optional.
    sudo systemctl enable --now ollama 2>/dev/null || true
    OLLAMA_BIN="$(command -v ollama || echo /usr/local/bin/ollama)"
    echo "  LLM: Ollama Service aktiviert."

    # Pull the CONFIGURED LLM model (Go-Live-Review 2026-06-10). Was hard-coded to
    # TinyLlama, which produces poor German; the default is now qwen3.5:2b (clearly
    # better German for the status messages). The operator can pick another model
    # in Settings (llm.llmModel) — we read it back from the config so install/
    # update pulls whatever is actually selected. The 8 GB+ Tier-3 gate above has
    # ample room for a 2B (~2.7 GB) model. Best-effort: the LLM tile is optional.
    LLM_MODEL="qwen3.5:2b"
    if command -v node >/dev/null 2>&1 && [[ -f "$CONFIG_PATH" ]]; then
      LLM_MODEL="$(node -e "try{const c=require('$CONFIG_PATH');process.stdout.write(String((c.llm&&c.llm.llmModel)||'qwen3.5:2b'))}catch{process.stdout.write('qwen3.5:2b')}" 2>/dev/null || echo qwen3.5:2b)"
    fi
    if "$OLLAMA_BIN" list 2>/dev/null | grep -qF "$LLM_MODEL"; then
      echo "  LLM: Modell $LLM_MODEL bereits vorhanden."
    else
      echo "  LLM: Lade Modell $LLM_MODEL herunter..."
      "$OLLAMA_BIN" pull "$LLM_MODEL" \
        && echo "  LLM: Modell $LLM_MODEL geladen." \
        || echo "  LLM: Pull von $LLM_MODEL fehlgeschlagen — uebersprungen (optional)."
    fi

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

# Install ML dependencies after Python venv is ready.
# T-0118: run in a subshell + `|| true` so an OPTIONAL Tier-2/3 step (ML pip,
# Ollama download/pull) can never abort the script (subshell contains any inner
# `exit`/set -e failure) — the essential tail (config/DB/systemd) must always run.
( install_ml_deps ) || echo "  ML/LLM: optionaler Tier-2/3-Schritt fehlgeschlagen — uebersprungen, Kern-Install laeuft weiter"

# --- EOS (Akkudoktor) Installation (Tier 3 only, --with-eos flag) ---
install_eos() {
  local RAM_MB
  RAM_MB=$(free -m 2>/dev/null | awk '/^Mem:/{print $2}' || echo 0)
  if [ "$RAM_MB" -lt 3000 ]; then
    echo "  EOS: Uebersprungen (RAM ${RAM_MB}MB < 3GB, Tier < 3)"
    return 0
  fi

  local EOS_DIR="/opt/dvhub/eos"
  local EOS_VENV="/opt/dvhub/eos-venv"
  # T-0121: install the DVhub DV-EOS *fork* (15-min slots, slot-aware
  # battery/inverter math, battery->grid arbitrage export, EnergyCharts spot
  # feed-in, pydantic /v1/prediction/import fix) directly from the public fork
  # branch. The branch already carries every patch on top of upstream v0.3.0, so
  # the legacy eos-patches/apply.sh step is no longer needed. Cloning vanilla
  # upstream here (the pre-T-0121 behaviour) shipped an EOS that clamps to hourly
  # slots and never exports the battery -> i.e. no arbitrage. EOS_DIR is now
  # /opt/dvhub/eos to match the path prod + eos-adapter.js expect (was the
  # divergent /opt/dvhub/eos-src). Override repo/branch via env for testing.
  local EOS_REPO_URL="${EOS_REPO_URL:-https://github.com/chloepriceless/DV-EOS.git}"
  local EOS_BRANCH="${EOS_BRANCH:-dvhub-fork}"

  echo "  EOS: Installiere DV-EOS Fork (${EOS_BRANCH}) bare-metal venv..."

  # Idempotent clone / fetch of the fork branch
  if [ ! -d "$EOS_DIR/.git" ]; then
    sudo rm -rf "$EOS_DIR"
    sudo git clone --branch "$EOS_BRANCH" --depth 1 \
      "$EOS_REPO_URL" "$EOS_DIR" \
      || { echo "  EOS: git clone ${EOS_REPO_URL}@${EOS_BRANCH} fehlgeschlagen"; return 1; }
  else
    sudo git -C "$EOS_DIR" fetch --depth 1 origin "$EOS_BRANCH"
    sudo git -C "$EOS_DIR" checkout -B "$EOS_BRANCH" "origin/$EOS_BRANCH"
  fi

  # Python venv (Python 3.11+ required by EOS v0.3.0)
  if [ ! -d "$EOS_VENV" ]; then
    sudo python3 -m venv "$EOS_VENV"
  fi
  sudo "$EOS_VENV/bin/pip" install --upgrade pip
  # T-0118: akkudoktor-EOS v0.3.0 ships pyproject.toml, NOT requirements.txt —
  # only honour a requirements.txt if it actually exists; the editable install
  # below resolves the project's dependencies from pyproject.toml regardless.
  if [ -f "$EOS_DIR/requirements.txt" ]; then
    sudo "$EOS_VENV/bin/pip" install -r "$EOS_DIR/requirements.txt"
  fi
  sudo "$EOS_VENV/bin/pip" install -e "$EOS_DIR"

  # Phase 18-03: starlette 1.x dropped the `on_startup` kwarg in favour of
  # `lifespan`, but fasthtml 0.12.x (pinned by monsterui 1.0.44, which the EOS
  # v0.3.0 requirements pull in) still calls Starlette.__init__(on_startup=…).
  # Result on Debian 13 / Python 3.13 with pip default-resolving starlette to
  # the latest 1.x: EOSdash subprocess crashes on every restart with
  #   TypeError: Starlette.__init__() got an unexpected keyword argument 'on_startup'
  # while the EOS HTTP API itself stays up. Pin starlette to the 0.x line until
  # EOS upstream upgrades fasthtml; verified working on prod 2026-05-20 at
  # starlette 0.52.1. Idempotent — pip re-resolves the constraint on every run.
  sudo "$EOS_VENV/bin/pip" install --upgrade "starlette<1.0"

  # Ownership: systemd user `dvhub` must execute the venv
  sudo chown -R "$SERVICE_USER:$SERVICE_USER" "$EOS_VENV" "$EOS_DIR"

  # systemd unit — bind 127.0.0.1:8503 only (no external access)
  cat <<UNIT | sudo tee /etc/systemd/system/eos.service >/dev/null
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

  sudo systemctl daemon-reload
  sudo systemctl enable eos.service
  sudo systemctl restart eos.service
  echo "  EOS: systemd eos.service gestartet (127.0.0.1:8503)"
}

if [ "${EOS_INSTALL:-0}" = "1" ]; then
  # T-0118: subshell + `|| true` — an EOS install failure must not abort the
  # essential tail (config/DB/systemd) that follows.
  ( install_eos ) || echo "  EOS: Installation fehlgeschlagen — uebersprungen, Kern-Install laeuft weiter"
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
# END DVHUB SUDOERS
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
