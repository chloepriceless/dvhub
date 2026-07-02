#!/usr/bin/env bash
# pkg-maintain.sh -- nightly TimescaleDB PACKAGE maintenance (the "Pakete auto"
# half of Christin's "Pakete auto, Extension per Klick" decision, 2026-07-02).
#
# Run by the dvhub-pkg-maintain.timer as ROOT. Keeps the TimescaleDB apt package
# family current and records the engine state to a status file the app reads
# (GET /api/db/timescale/status → GUI "Datenbank-Engine" card).
#
# DELIBERATELY does NOT restart Postgres and does NOT run `ALTER EXTENSION
# timescaledb UPDATE`. Installing a newer .so is harmless: Postgres keeps loading
# the .so that matches the CURRENTLY-created extension version (Timescale ships
# every historical .so), so the running DB is untouched. The actual version bump
# — which needs two Postgres restarts — happens only when the operator clicks
# "Jetzt aktualisieren" in the GUI (POST /api/db/timescale/upgrade). This keeps
# the risk-free part automatic and the disruptive part operator-gated.
#
# Idempotent + NON-FATAL throughout: a box that can't reach the apt repo just
# keeps its current package and writes whatever state it can probe. Never crashes.
set -uo pipefail   # NB: no `-e` — every step is best-effort; we never abort the box.

INSTALL_DIR="${INSTALL_DIR:-/opt/dvhub}"
SERVICE_USER="${SERVICE_USER:-dvhub}"
DATA_DIR="${DATA_DIR:-${DV_DATA_DIR:-/var/lib/dvhub}}"
DB_NAME="${DB_NAME:-dvhub}"
STATUS_FILE="${DATA_DIR}/timescale-status.json"

if [[ "${EUID}" -ne 0 ]]; then
  echo "  pkg-maintain: muss als root laufen — uebersprungen" >&2
  exit 0
fi

# No psql → no PostgreSQL store on this box → nothing to maintain.
if ! command -v psql >/dev/null 2>&1; then
  echo "  pkg-maintain: kein psql — uebersprungen (kein PostgreSQL-Store)."
  exit 0
fi

# --- Detect the installed PostgreSQL major version (mirror timescale-provision.sh) ---
PG_VER=""
if command -v pg_lsclusters >/dev/null 2>&1; then
  PG_VER="$(pg_lsclusters -h 2>/dev/null | awk 'NR==1{print $1}')"
fi
if [[ -z "$PG_VER" ]]; then
  PG_VER="$(ls -1d /usr/lib/postgresql/*/ 2>/dev/null | sed -E 's#.*/([0-9]+)/#\1#' | sort -n | tail -1)"
fi

# --- Probe versions BEFORE (extension currently active + binary's default) ------
# NB: `su postgres` (NON-login), not `su - postgres`. A login shell sources the
# postgres user's MOTD (some images — e.g. community-scripts Proxmox LXCs, which is
# prod's platform — print a multi-line banner) which gets prepended to the psql
# output and corrupts the parsed version/license strings. Non-login su has no MOTD.
ext_ver()  { su postgres -c "psql -tAqc \"SELECT extversion FROM pg_extension WHERE extname='timescaledb'\" ${DB_NAME}" 2>/dev/null | tr -d '[:space:]'; }
bin_ver()  { su postgres -c "psql -tAqc \"SELECT default_version FROM pg_available_extensions WHERE name='timescaledb'\" ${DB_NAME}" 2>/dev/null | tr -d '[:space:]'; }
license()  { su postgres -c "psql -tAqc \"SELECT current_setting('timescaledb.license')\" ${DB_NAME}" 2>/dev/null | tr -d '[:space:]'; }

LAST_PKG_UPGRADE=""

# --- Keep the package family current (NO restart, NO ALTER EXTENSION) -----------
# Only touch the TimescaleDB packages; OS-wide upgrades are out of scope here
# (they are handled separately by /api/admin/system/updates). --only-upgrade means
# we never *newly* install anything — a box without TimescaleDB stays untouched.
if [[ -n "$PG_VER" ]] && command -v apt-get >/dev/null 2>&1; then
  TSL_PKG="timescaledb-2-postgresql-${PG_VER}"
  TSL_LOADER="timescaledb-2-loader-postgresql-${PG_VER}"
  TSL_TOOLKIT="timescaledb-toolkit-postgresql-${PG_VER}"
  # Refresh only the Timescale apt source when present (fast; falls back to a full
  # update if the per-source option isn't honoured).
  if [[ -f /etc/apt/sources.list.d/timescaledb.list ]]; then
    apt-get update \
      -o Dir::Etc::sourcelist="sources.list.d/timescaledb.list" \
      -o Dir::Etc::sourceparts="-" \
      -o APT::Get::List-Cleanup="0" >/dev/null 2>&1 || apt-get update >/dev/null 2>&1 || true
  else
    apt-get update >/dev/null 2>&1 || true
  fi
  # Snapshot installed versions to detect whether apt actually upgraded anything.
  PKG_BEFORE="$(dpkg-query -W -f='${Version}' "$TSL_PKG" 2>/dev/null || true)"
  DEBIAN_FRONTEND=noninteractive apt-get install -y --only-upgrade \
    "$TSL_LOADER" "$TSL_PKG" "$TSL_TOOLKIT" >/dev/null 2>&1 || true
  PKG_AFTER="$(dpkg-query -W -f='${Version}' "$TSL_PKG" 2>/dev/null || true)"
  if [[ -n "$PKG_AFTER" && "$PKG_BEFORE" != "$PKG_AFTER" ]]; then
    LAST_PKG_UPGRADE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "  pkg-maintain: ${TSL_PKG} ${PKG_BEFORE:-<none>} -> ${PKG_AFTER}"
  else
    echo "  pkg-maintain: ${TSL_PKG} aktuell (${PKG_AFTER:-nicht installiert})."
  fi
fi

# --- Probe the resulting state + write the status file --------------------------
EXT_VERSION="$(ext_ver)"
BIN_VERSION="$(bin_ver)"
LICENSE="$(license)"
UPDATE_PENDING="false"
if [[ -n "$EXT_VERSION" && -n "$BIN_VERSION" && "$EXT_VERSION" != "$BIN_VERSION" ]]; then
  UPDATE_PENDING="true"
fi
NOW_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Preserve a prior lastPkgUpgrade if we didn't upgrade this run.
if [[ -z "$LAST_PKG_UPGRADE" && -f "$STATUS_FILE" ]] && command -v node >/dev/null 2>&1; then
  LAST_PKG_UPGRADE="$(node -e "try{const c=require('$STATUS_FILE');process.stdout.write(String(c.lastPkgUpgrade||''))}catch{}" 2>/dev/null || true)"
fi

mkdir -p "$DATA_DIR" 2>/dev/null || true
# Write JSON via node for correct escaping (node is always present on a DVhub box).
if command -v node >/dev/null 2>&1; then
  EXT_VERSION="$EXT_VERSION" BIN_VERSION="$BIN_VERSION" LICENSE="$LICENSE" \
  UPDATE_PENDING="$UPDATE_PENDING" PG_VER="$PG_VER" NOW_UTC="$NOW_UTC" LAST_PKG_UPGRADE="$LAST_PKG_UPGRADE" \
  node -e "
    const fs=require('fs');const e=process.env;
    const o={
      extVersion: e.EXT_VERSION||null,
      binaryVersion: e.BIN_VERSION||null,
      updatePending: e.UPDATE_PENDING==='true',
      edition: e.LICENSE||null,
      pgMajor: e.PG_VER||null,
      lastChecked: e.NOW_UTC||null,
      lastPkgUpgrade: e.LAST_PKG_UPGRADE||null
    };
    fs.writeFileSync('$STATUS_FILE', JSON.stringify(o,null,2)+'\n');
  " 2>/dev/null || true
  chown "$SERVICE_USER:$SERVICE_USER" "$STATUS_FILE" 2>/dev/null || true
fi

echo "  pkg-maintain: Status ext=${EXT_VERSION:-?} bin=${BIN_VERSION:-?} pending=${UPDATE_PENDING} -> ${STATUS_FILE}"
exit 0
