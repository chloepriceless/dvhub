#!/usr/bin/env bash
# timescale-provision.sh -- Idempotent provisioning of TimescaleDB (COMMUNITY /
# TSL edition) for DVhub's PostgreSQL telemetry store.
#
# Single source of truth for the TimescaleDB engine, SHARED by install.sh (fresh
# install) and post-update.sh (retrofit on existing boxes, decoupled) so the two
# never drift -- same pattern as eos-provision.sh / forecast-provision.sh. Must
# run as root.
#
# WHY the Community edition (2026-07-02, Christin): DVhub's schema (migration 014)
# uses a TimescaleDB hypertable on timeseries_samples PLUS compression + 15m/1h
# continuous aggregates. Debian's own package `postgresql-<ver>-timescaledb` is
# the APACHE build (`SHOW timescaledb.license` = 'apache') and supports the
# hypertable but NOT compression/continuous aggregates -- those raise 0A000
# "functionality not supported under the current apache license". Because
# runPendingMigrations applies 014 as ONE transaction, that error used to roll
# back the whole migration. prod runs the Community/TSL build (from Timescale's
# own apt repo), so to give every box full prod parity -- and to make a FULL
# prod backup restorable (it references CAggs/compressed chunks) -- we install
# the Community edition here from packagecloud.io/timescale/timescaledb.
#
# Steps (all idempotent):
#   1. detect the installed PostgreSQL major version + distro codename
#   2. fast-skip if the Community extension is already active (prod)
#   3. add Timescale's apt repo + GPG key
#   4. install timescaledb-2-postgresql-<ver> (Community). If packagecloud has no
#      build for the platform, fall back to the Debian Apache package so the box
#      still gets a working hypertable (014's license guard skips the TSL parts).
#      An already-installed Apache package is removed first (same .so, conflicts).
#   5. shared_preload_libraries drop-in (conf.d) + postgres restart
#   6. CREATE EXTENSION + ALTER EXTENSION ... UPDATE (retrofit Apache->Community
#      or a version bump; no-op when already current)
#   7. flip cfg.telemetry.database.timescaledb = true so migration 014 runs
#
# NON-FATAL contract enforced by the CALLER (install.sh subshell / post-update.sh
# background unit). A box where the package/extension can't be provisioned stays
# on plain Postgres (config left false) -- graceful degradation, never a crash.
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/dvhub}"
SERVICE_USER="${SERVICE_USER:-dvhub}"
DATA_DIR="${DATA_DIR:-${DV_DATA_DIR:-/var/lib/dvhub}}"
CONFIG_PATH="${CONFIG_PATH:-/etc/dvhub/config.json}"
DB_NAME="${DB_NAME:-dvhub}"

# TS_PROVISION_EUID, OS_RELEASE, REPO_LIST, KEYRING: nur fuer Tests
# (test/timescale-provision.test.js), im Betrieb nie gesetzt.
if [[ "${TS_PROVISION_EUID:-$EUID}" -ne 0 ]]; then
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

# --- 1. Detect the installed PostgreSQL major version + distro codename -------
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

# packagecloud fuehrt Debian und Ubuntu unter getrennten Pfaden (…/debian/<name>,
# …/ubuntu/<name>). Ubuntu 26.04 „resolute“ gibt es nur unter ubuntu/ (Issue #24).
# Ableger wie Mint melden ID_LIKE=ubuntu und den Ubuntu-Namen in UBUNTU_CODENAME;
# Raspberry Pi OS meldet ID_LIKE=debian.
OS_RELEASE="${OS_RELEASE:-/etc/os-release}"
os_field() { ( . "$OS_RELEASE" 2>/dev/null && eval "echo \"\${$1:-}\"" ) || true; }
DISTRO="debian"
CODENAME="$(os_field VERSION_CODENAME)"
if [[ "$(os_field ID)" == ubuntu || " $(os_field ID_LIKE) " == *" ubuntu "* ]]; then
  DISTRO="ubuntu"
  UBUNTU_NAME="$(os_field UBUNTU_CODENAME)"
  [[ -n "$UBUNTU_NAME" ]] && CODENAME="$UBUNTU_NAME"
fi
[[ -z "$CODENAME" ]] && CODENAME="$(lsb_release -cs 2>/dev/null || true)"

APACHE_PKG="postgresql-${PG_VER}-timescaledb"
TSL_PKG="timescaledb-2-postgresql-${PG_VER}"
TSL_LOADER="timescaledb-2-loader-postgresql-${PG_VER}"
REPO_LIST="${REPO_LIST:-/etc/apt/sources.list.d/timescaledb.list}"
KEYRING="${KEYRING:-/usr/share/keyrings/timescale.gpg}"

flip_config_true() {
  # Set cfg.telemetry.database.timescaledb = true so migration 014 (hypertable +
  # compression + continuous aggregates) runs on the next dvhub start. Only
  # touches this one key. No-op if node/config are absent.
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

ext_license() {
  su postgres -c "psql -tAqc \"SELECT current_setting('timescaledb.license')\" ${DB_NAME}" 2>/dev/null | tr -d '[:space:]'
}

# --- 2. Fast-skip if the Community extension is already active (prod) ---------
# prod already runs the Community build out-of-band → this makes the script a
# true no-op there; the config flip below still runs to keep state consistent.
if [[ "$(ext_license)" == "timescale" ]]; then
  echo "  TimescaleDB: Community-Edition bereits aktiv (PG ${PG_VER}) — nur Config abgleichen."
  flip_config_true
  exit 0
fi

echo "  TimescaleDB: provisioniere Community-Edition (PG ${PG_VER}, ${DISTRO} ${CODENAME:-?}) ..."

# --- 3. Add Timescale's apt repo + GPG key (idempotent) ----------------------
# Defensive: a minimal box may lack gnupg/curl.
apt-get install -y gnupg curl ca-certificates >/dev/null 2>&1 || true
NEED_APT_UPDATE=0
if [[ ! -s "$KEYRING" ]]; then
  if curl -fsSL https://packagecloud.io/timescale/timescaledb/gpgkey | gpg --dearmor -o "$KEYRING" 2>/dev/null && [[ -s "$KEYRING" ]]; then
    chmod 644 "$KEYRING"; NEED_APT_UPDATE=1
    echo "  TimescaleDB: Timescale-GPG-Key hinterlegt."
  else
    echo "  WARN: Timescale-GPG-Key nicht abrufbar (Netz?) — versuche Apache-Fallback." >&2
    rm -f "$KEYRING" 2>/dev/null || true
  fi
fi
# Eine Quelle fuer die falsche Distribution (aeltere Versionen trugen auch auf
# Ubuntu debian/ ein) wird ersetzt; eine passende in anderem Format bleibt.
REPO_PATH="packagecloud.io/timescale/timescaledb/${DISTRO}/ ${CODENAME} "
if [[ -s "$KEYRING" && -n "$CODENAME" ]] && [[ "$(cat "$REPO_LIST" 2>/dev/null) " != *"$REPO_PATH"* ]]; then
  echo "deb [signed-by=${KEYRING}] https://${REPO_PATH}main" > "$REPO_LIST"
  NEED_APT_UPDATE=1
  echo "  TimescaleDB: apt-Quelle (${DISTRO} ${CODENAME}) eingetragen."
fi
if [[ "$NEED_APT_UPDATE" -eq 1 ]]; then
  APT_OUT="$(apt-get update 2>&1 || true)"
  # Hat packagecloud fuer diese Distribution nichts (404, kein Release), bliebe die
  # Quelle sonst stehen und jedes `apt update` der Box meldete den Fehler → wieder
  # entfernen, unten greift der Apache-Fallback. grep ohne -q: liest alles, kein
  # SIGPIPE unter pipefail (siehe Hinweis bei apt-cache).
  if printf '%s\n' "$APT_OUT" | grep -E '^(Err:[0-9]*|E:|Error:) .*packagecloud\.io/timescale' >/dev/null; then
    echo "  WARN: packagecloud hat keine TimescaleDB-Pakete fuer ${DISTRO} ${CODENAME} — apt-Quelle wieder entfernt." >&2
    rm -f "$REPO_LIST"
    apt-get update >/dev/null 2>&1 || true
  fi
fi

# --- 4. Install the Community package (Apache fallback if unavailable) --------
PKG_CHANGED=0
USE_TSL=0
# NB: capture apt-cache output then match with a bash regex — do NOT pipe into
# `grep -q`. Under `set -o pipefail`, grep -q closes the pipe on first match and
# apt-cache dies with SIGPIPE (141), which pipefail reports as a failed pipeline
# → USE_TSL would wrongly stay 0 and the box would fall back to Apache.
TSL_POLICY="$(apt-cache policy "$TSL_PKG" 2>/dev/null || true)"
if [[ -s "$KEYRING" && -f "$REPO_LIST" && "$TSL_POLICY" =~ Candidate:\ [0-9] ]]; then
  USE_TSL=1
fi

if [[ "$USE_TSL" -eq 1 ]]; then
  # The Debian Apache package ships the same `timescaledb` .so and conflicts with
  # the Community package — remove it first (retrofit Apache→Community).
  if dpkg -s "$APACHE_PKG" >/dev/null 2>&1; then
    echo "  TimescaleDB: entferne Apache-Paket ${APACHE_PKG} (wird durch Community ersetzt) ..."
    DEBIAN_FRONTEND=noninteractive apt-get remove -y "$APACHE_PKG" >/dev/null 2>&1 || true
    PKG_CHANGED=1
  fi
  if dpkg -s "$TSL_PKG" >/dev/null 2>&1; then
    echo "  TimescaleDB: Community-Paket ${TSL_PKG} bereits installiert."
  elif DEBIAN_FRONTEND=noninteractive apt-get install -y "$TSL_LOADER" "$TSL_PKG" >/dev/null 2>&1; then
    echo "  TimescaleDB: Community-Paket ${TSL_PKG} installiert."
    PKG_CHANGED=1
  else
    echo "  WARN: Community-Paket nicht installierbar — Fallback auf Apache-Paket." >&2
    USE_TSL=0
  fi
fi

if [[ "$USE_TSL" -eq 0 ]]; then
  # Fallback: Debian Apache build. The hypertable still works; migration 014's
  # license guard skips compression + continuous aggregates on this build. Keeps
  # a box functional where packagecloud has no build for the platform/codename.
  if ! dpkg -s "$APACHE_PKG" >/dev/null 2>&1; then
    if DEBIAN_FRONTEND=noninteractive apt-get install -y "$APACHE_PKG" >/dev/null 2>&1; then
      echo "  TimescaleDB: ${APACHE_PKG} (Apache-Fallback) installiert."
      PKG_CHANGED=1
    else
      echo "  WARN: ${APACHE_PKG} nicht installierbar (Netz/Repo?) — Box bleibt auf reinem Postgres." >&2
      exit 0
    fi
  else
    echo "  TimescaleDB: ${APACHE_PKG} (Apache) bereits installiert."
  fi
fi

# --- 5. shared_preload_libraries drop-in + restart ---------------------------
# TimescaleDB is a preloaded extension — CREATE EXTENSION fails until the library
# is in shared_preload_libraries and postgres has restarted. Debian's
# postgresql.conf ships `include_dir = 'conf.d'`, so a drop-in is honoured.
CONF_DIR="/etc/postgresql/${PG_VER}/main/conf.d"
DROPIN="${CONF_DIR}/timescaledb.conf"
NEED_RESTART="$PKG_CHANGED"   # a package swap needs a restart to load the new .so
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
  echo "  TimescaleDB: Postgres-Neustart (neue Bibliothek/Preload) ..."
  systemctl restart postgresql || { echo "  WARN: Postgres-Restart fehlgeschlagen." >&2; exit 0; }
  # brief readiness wait
  for _ in $(seq 1 10); do su postgres -c "psql -tAqc 'SELECT 1'" >/dev/null 2>&1 && break; sleep 1; done
fi

# --- 6. CREATE EXTENSION + ALTER UPDATE in the DVhub DB (superuser) -----------
if su postgres -c "psql -d ${DB_NAME} -c 'CREATE EXTENSION IF NOT EXISTS timescaledb'" >/dev/null 2>&1; then
  # Retrofit / version bump: move the extension to the installed binary's version
  # (e.g. Apache 2.19 → Community 2.28). No-op when already current.
  su postgres -c "psql -d ${DB_NAME} -c 'ALTER EXTENSION timescaledb UPDATE'" >/dev/null 2>&1 || true
  EXTVER="$(su postgres -c "psql -tAqc \"SELECT extversion FROM pg_extension WHERE extname='timescaledb'\" ${DB_NAME}" 2>/dev/null)"
  echo "  TimescaleDB: Extension in DB '${DB_NAME}' aktiv (v${EXTVER}, Lizenz $(ext_license))."
else
  echo "  WARN: CREATE EXTENSION timescaledb in '${DB_NAME}' fehlgeschlagen — Box bleibt auf reinem Postgres." >&2
  exit 0
fi

# --- 7. Flip the config so migration 014 runs on next start ------------------
flip_config_true
echo "  TimescaleDB: bereit (PG ${PG_VER}, DB ${DB_NAME})."
