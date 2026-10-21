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
#
# PKG_MAINTAIN_STATUS_ONLY=1: nur den Status schreiben, kein apt (Aufruf aus
# timescale-provision.sh, mit PROVISION_RESULT/PROVISION_ERROR fuer das Feld
# "provision" — ohne diese Angaben bleibt ein frueheres "provision" stehen).
set -uo pipefail   # NB: no `-e` — every step is best-effort; we never abort the box.

INSTALL_DIR="${INSTALL_DIR:-/opt/dvhub}"
SERVICE_USER="${SERVICE_USER:-dvhub}"
DATA_DIR="${DATA_DIR:-${DV_DATA_DIR:-/var/lib/dvhub}}"
DB_NAME="${DB_NAME:-dvhub}"
STATUS_FILE="${DATA_DIR}/timescale-status.json"

# PKG_MAINTAIN_EUID: nur fuer Tests.
if [[ "${PKG_MAINTAIN_EUID:-$EUID}" -ne 0 ]]; then
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
# Versionen aus dem Katalog mit abgeschaltetem Loader: fehlt die Bibliothek zur
# Katalog-Version (Feldfall 21.10.2026), scheitert sonst schon die erste Anweisung
# jeder Sitzung, und die Datei meldete leere Versionen bzw. "aktuell".
ext_ver()  { su postgres -c "PGOPTIONS='-c timescaledb.disable_load=on' psql -X -tAqc \"SELECT extversion FROM pg_extension WHERE extname='timescaledb'\" ${DB_NAME}" 2>/dev/null | tr -d '[:space:]'; }
bin_ver()  { su postgres -c "PGOPTIONS='-c timescaledb.disable_load=on' psql -X -tAqc \"SELECT default_version FROM pg_available_extensions WHERE name='timescaledb'\" ${DB_NAME}" 2>/dev/null | tr -d '[:space:]'; }
# Geparkte Zeilen aus timescale-provision.sh Schritt 6b, die noch nicht zurueck sind.
rescue_cnt() { su postgres -c "PGOPTIONS='-c timescaledb.disable_load=on' psql -X -tAqc \"SELECT count(*) FROM pg_class WHERE relname LIKE 'dvhub!_ts!_rescue!_%' ESCAPE '!'\" ${DB_NAME}" 2>/dev/null | tr -d '[:space:]'; }
# Mit Loader: die Lizenz gibt es nur, wenn die Bibliothek wirklich laedt.
# stderr kommt mit, damit ein Ladefehler in der Datei landet.
license_or_error() { su postgres -c "psql -X -tAqc \"SELECT current_setting('timescaledb.license')\" ${DB_NAME}" 2>&1; }

LAST_PKG_UPGRADE=""

# --- Keep the package family current (NO restart, NO ALTER EXTENSION) -----------
# Only touch the TimescaleDB packages; OS-wide upgrades are out of scope here
# (they are handled separately by /api/admin/system/updates). --only-upgrade means
# we never *newly* install anything — a box without TimescaleDB stays untouched.
if [[ -n "$PG_VER" && "${PKG_MAINTAIN_STATUS_ONLY:-}" != "1" ]] && command -v apt-get >/dev/null 2>&1; then
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
LICENSE=""
LOAD_ERROR=""
if [[ -n "$EXT_VERSION" ]]; then
  if LIC_OUT="$(license_or_error)"; then
    LICENSE="$(printf '%s' "$LIC_OUT" | tr -d '[:space:]')"
  else
    LOAD_ERROR="$(printf '%s\n' "$LIC_OUT" | grep -m1 -E 'ERROR|FATAL' || printf '%s\n' "$LIC_OUT" | head -1)"
    LOAD_ERROR="${LOAD_ERROR#*ERROR:  }"
  fi
fi
RESCUE_PENDING="$(rescue_cnt)"
UPDATE_PENDING="false"
if [[ -n "$EXT_VERSION" && -n "$BIN_VERSION" && "$EXT_VERSION" != "$BIN_VERSION" ]]; then
  UPDATE_PENDING="true"
fi
NOW_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Preserve a prior lastPkgUpgrade if we didn't upgrade this run.
if [[ -z "$LAST_PKG_UPGRADE" && -f "$STATUS_FILE" ]] && command -v node >/dev/null 2>&1; then
  LAST_PKG_UPGRADE="$(node -e "try{const c=require('$STATUS_FILE');process.stdout.write(String(c.lastPkgUpgrade||''))}catch{}" 2>/dev/null || true)"
fi
PROVISION_AT=""
[[ -n "${PROVISION_RESULT:-}" ]] && PROVISION_AT="$NOW_UTC"

mkdir -p "$DATA_DIR" 2>/dev/null || true
# Write JSON via node for correct escaping (node is always present on a DVhub box).
if command -v node >/dev/null 2>&1; then
  EXT_VERSION="$EXT_VERSION" BIN_VERSION="$BIN_VERSION" LICENSE="$LICENSE" \
  UPDATE_PENDING="$UPDATE_PENDING" PG_VER="$PG_VER" NOW_UTC="$NOW_UTC" LAST_PKG_UPGRADE="$LAST_PKG_UPGRADE" \
  LOAD_ERROR="$LOAD_ERROR" PROVISION_AT="$PROVISION_AT" STATUS_FILE="$STATUS_FILE" RESCUE_PENDING="${RESCUE_PENDING:-0}" \
  node -e "
    const fs=require('fs');const e=process.env;
    let prev=null;try{prev=JSON.parse(fs.readFileSync(e.STATUS_FILE,'utf8')).provision||null}catch{}
    const rescue=Number(e.RESCUE_PENDING)||0;
    // Ein frueherer Fehlschlag gilt als erledigt, sobald die Bibliothek laedt und
    // nichts mehr geparkt ist (sonst stuende er bis zur naechsten Nachruestung).
    if(prev&&prev.result==='failed'&&e.EXT_VERSION&&!e.LOAD_ERROR&&!rescue)prev=null;
    const o={
      extVersion: e.EXT_VERSION||null,
      binaryVersion: e.BIN_VERSION||null,
      updatePending: e.UPDATE_PENDING==='true',
      edition: e.LICENSE||null,
      pgMajor: e.PG_VER||null,
      lastChecked: e.NOW_UTC||null,
      lastPkgUpgrade: e.LAST_PKG_UPGRADE||null,
      loadError: e.LOAD_ERROR||null,
      rescuePending: rescue,
      provision: e.PROVISION_RESULT
        ? { at: e.PROVISION_AT||null, result: e.PROVISION_RESULT, error: e.PROVISION_ERROR||null }
        : prev
    };
    fs.writeFileSync(e.STATUS_FILE+'.tmp', JSON.stringify(o,null,2)+'\n');
    fs.renameSync(e.STATUS_FILE+'.tmp', e.STATUS_FILE);
  " 2>/dev/null || true
  chown "$SERVICE_USER:$SERVICE_USER" "$STATUS_FILE" 2>/dev/null || true
fi

echo "  pkg-maintain: Status ext=${EXT_VERSION:-?} bin=${BIN_VERSION:-?} pending=${UPDATE_PENDING}${LOAD_ERROR:+ ladefehler=${LOAD_ERROR}} -> ${STATUS_FILE}"
exit 0
