#!/usr/bin/env bash
# timescale-provision.sh -- Idempotent provisioning of TimescaleDB for DVhub's
# PostgreSQL telemetry store.
#
# Single source of truth for the TimescaleDB engine, SHARED by install.sh (fresh
# install) and post-update.sh (retrofit on existing boxes, decoupled) so the two
# never drift -- same pattern as eos-provision.sh / forecast-provision.sh. Must
# run as root.
#
# WHY: DVhub's schema uses a TimescaleDB hypertable (timeseries_samples) +
# continuous aggregates when cfg.telemetry.database.timescaledb === true
# (migration 014). Without the extension the app runs DEGRADED on plain tables
# AND a production DB backup (which references the extension + hypertables)
# cannot be pg_restore'd onto the box. Debian trixie ships
# `postgresql-<ver>-timescaledb` in its STANDARD repos, so no third-party apt
# source is needed — a plain `apt install` provisions it.
#
# Steps (all idempotent):
#   1. detect the installed PostgreSQL major version
#   2. fast-skip if the extension is already created in the target DB
#   3. apt install postgresql-<ver>-timescaledb
#   4. shared_preload_libraries drop-in (conf.d) + postgres restart (preload)
#   5. CREATE EXTENSION IF NOT EXISTS timescaledb (superuser) in the DVhub DB
#   6. flip cfg.telemetry.database.timescaledb = true so migration 014 runs
#
# NON-FATAL contract enforced by the CALLER (install.sh subshell / post-update.sh
# background unit). A box where the package/extension can't be provisioned stays
# on plain Postgres (config left false) — graceful degradation, never a crash.
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/dvhub}"
SERVICE_USER="${SERVICE_USER:-dvhub}"
DATA_DIR="${DATA_DIR:-${DV_DATA_DIR:-/var/lib/dvhub}}"
CONFIG_PATH="${CONFIG_PATH:-/etc/dvhub/config.json}"
DB_NAME="${DB_NAME:-dvhub}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "  TimescaleDB: timescale-provision.sh muss als root laufen — uebersprungen" >&2
  exit 1
fi

# No PostgreSQL client → nothing to provision (SQLite store or DB-less box).
if ! command -v psql >/dev/null 2>&1; then
  echo "  TimescaleDB: kein psql — uebersprungen (kein PostgreSQL-Store)."
  exit 0
fi

# Ensure the server is up so the SQL probes below work (install.sh enables it;
# on a retrofit it is normally already running).
systemctl enable --now postgresql >/dev/null 2>&1 || true

# --- 1. Detect the installed PostgreSQL major version ------------------------
PG_VER=""
if command -v pg_lsclusters >/dev/null 2>&1; then
  PG_VER="$(pg_lsclusters -h 2>/dev/null | awk 'NR==1{print $1}')"
fi
if [[ -z "$PG_VER" ]]; then
  # Fallback: highest numbered dir under /usr/lib/postgresql (e.g. 17).
  PG_VER="$(ls -1d /usr/lib/postgresql/*/ 2>/dev/null | sed -E 's#.*/([0-9]+)/#\1#' | sort -n | tail -1)"
fi
if [[ -z "$PG_VER" ]]; then
  echo "  TimescaleDB: PostgreSQL-Version nicht erkennbar — uebersprungen."
  exit 0
fi

# --- 2. Fast-skip if the extension is already created in the target DB --------
# (prod already has TimescaleDB installed out-of-band → this makes the script a
# true no-op there; the config flip below still runs to keep state consistent.)
already_created() {
  su - postgres -c "psql -tAqc \"SELECT 1 FROM pg_extension WHERE extname='timescaledb'\" ${DB_NAME}" 2>/dev/null | grep -q 1
}

flip_config_true() {
  # Set cfg.telemetry.database.timescaledb = true so migration 014 (hypertable +
  # continuous aggregates) runs on the next dvhub start. Only touches this one
  # key. No-op if node/config are absent.
  if command -v node >/dev/null 2>&1 && [[ -f "$CONFIG_PATH" ]]; then
    node -e "
      const fs=require('fs');const p='$CONFIG_PATH';
      try{const c=JSON.parse(fs.readFileSync(p,'utf8'));
        c.telemetry=c.telemetry||{};c.telemetry.database=c.telemetry.database||{};
        if(c.telemetry.database.timescaledb!==true){c.telemetry.database.timescaledb=true;
          fs.writeFileSync(p,JSON.stringify(c,null,2)+'\n');}
      }catch{}
    " 2>/dev/null || true
    chown "$SERVICE_USER:$SERVICE_USER" "$CONFIG_PATH" 2>/dev/null || true
  fi
}

if already_created; then
  echo "  TimescaleDB: Extension bereits aktiv (PG ${PG_VER}) — nur Config abgleichen."
  flip_config_true
  exit 0
fi

echo "  TimescaleDB: provisioniere (PG ${PG_VER}) ..."

# --- 3. Install the Debian-packaged extension --------------------------------
PKG="postgresql-${PG_VER}-timescaledb"
if ! dpkg -s "$PKG" >/dev/null 2>&1; then
  # `if` suppresses set -e; a failed/offline apt must leave the box on plain
  # Postgres (config stays false), never abort.
  if apt-get install -y "$PKG" >/dev/null 2>&1; then
    echo "  TimescaleDB: ${PKG} installiert."
  else
    echo "  WARN: ${PKG} nicht installierbar (Netz/Repo?) — Box bleibt auf reinem Postgres." >&2
    exit 0
  fi
else
  echo "  TimescaleDB: ${PKG} bereits installiert."
fi

# --- 4. shared_preload_libraries drop-in + restart ---------------------------
# TimescaleDB is a preloaded extension — CREATE EXTENSION fails until the library
# is in shared_preload_libraries and postgres has restarted. Debian's
# postgresql.conf ships `include_dir = 'conf.d'`, so a drop-in is honoured.
CONF_DIR="/etc/postgresql/${PG_VER}/main/conf.d"
DROPIN="${CONF_DIR}/timescaledb.conf"
NEED_RESTART=0
if [[ -d "$CONF_DIR" ]]; then
  if [[ ! -f "$DROPIN" ]] || ! grep -q "timescaledb" "$DROPIN" 2>/dev/null; then
    echo "shared_preload_libraries = 'timescaledb'" > "$DROPIN"
    chown postgres:postgres "$DROPIN" 2>/dev/null || true
    chmod 644 "$DROPIN"
    NEED_RESTART=1
  fi
else
  echo "  WARN: ${CONF_DIR} fehlt — kann shared_preload_libraries nicht setzen." >&2
  exit 0
fi
if [[ "$NEED_RESTART" -eq 1 ]]; then
  echo "  TimescaleDB: shared_preload_libraries gesetzt — Postgres-Neustart ..."
  systemctl restart postgresql || { echo "  WARN: Postgres-Restart fehlgeschlagen." >&2; exit 0; }
  # brief readiness wait
  for _ in $(seq 1 10); do su - postgres -c "psql -tAqc 'SELECT 1'" >/dev/null 2>&1 && break; sleep 1; done
fi

# --- 5. CREATE EXTENSION in the DVhub DB (superuser) -------------------------
if su - postgres -c "psql -d ${DB_NAME} -c 'CREATE EXTENSION IF NOT EXISTS timescaledb'" >/dev/null 2>&1; then
  echo "  TimescaleDB: Extension in DB '${DB_NAME}' aktiv."
else
  echo "  WARN: CREATE EXTENSION timescaledb in '${DB_NAME}' fehlgeschlagen — Box bleibt auf reinem Postgres." >&2
  exit 0
fi

# --- 6. Flip the config so migration 014 (hypertable) runs on next start -----
flip_config_true
echo "  TimescaleDB: bereit (PG ${PG_VER}, DB ${DB_NAME})."
