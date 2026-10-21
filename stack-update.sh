#!/usr/bin/env bash
# stack-update.sh -- bei einem DVhub-Versions-Update den ganzen Stack einer
# NATIVEN Installation auf den neuesten Stand bringen (2026-10-15).
#
# Christin: „Am liebsten wäre es, wenn die Kunden ein Update auf die neue
# DVhub-Version ausführen und dann alle Pakete usw. auf dem neuesten Stand
# sind.“ npm-Pakete (Lockfile), das Prognose-Python (requirements.lock) und EOS
# (eos-version.env) zieht post-update.sh schon versionsgesteuert nach. Hier der
# Rest:
#   1. TimescaleDB-Pakete (pkg-maintain.sh, wie der nächtliche Timer)
#   2. die System-Pakete des DVhub-Stacks innerhalb ihrer Hauptversion
#      (apt --only-upgrade: Node.js, PostgreSQL, VPN-Werkzeuge, …) — nie neu
#      installieren, nie das ganze Betriebssystem (dafür bleibt „System-Updates“)
#   3. die TimescaleDB-Erweiterung IN der Datenbank (ALTER EXTENSION … UPDATE,
#      derselbe Ablauf wie „Jetzt aktualisieren“: Postgres neu, ALTER als erster
#      Befehl, Postgres neu). Ersetzt für das Versions-Update die Entscheidung
#      vom 02.07. („Erweiterung per Klick“) — der nächtliche Timer hebt weiter
#      nur die Pakete.
#   4. DVhub neu starten, wenn Node.js oder Postgres neu sind (Pool, Binary)
#   5. Status nach $DATA_DIR/stack-update.json (+ Log)
#
# post-update.sh startet das ENTKOPPELT (systemd-run) und nur, wenn sich die
# DVhub-Version geändert hat — der Marker steht dann schon, ein Neustart von
# DVhub aus Schritt 4 löst es nicht erneut aus. Als root. NON-FATAL: jeder
# Schritt ist best-effort, das Skript bricht nie die Box.
#
# Test: STACK_UPDATE_ALLOW_NONROOT=1 mit Ersatzprogrammen im PATH
# (test/stack-update.test.js).
set -uo pipefail   # bewusst kein -e

INSTALL_DIR="${INSTALL_DIR:-/opt/dvhub}"
DATA_DIR="${DATA_DIR:-${DV_DATA_DIR:-/var/lib/dvhub}}"
SERVICE_NAME="${SERVICE_NAME:-dvhub}"
DB_NAME="${DB_NAME:-dvhub}"
STATUS_FILE="${DATA_DIR}/stack-update.json"
WANT="${STACK_UPDATE_VERSION:-unbekannt}"

if [[ "${EUID}" -ne 0 && "${STACK_UPDATE_ALLOW_NONROOT:-}" != "1" ]]; then
  echo "  stack-update: muss als root laufen — uebersprungen" >&2
  exit 0
fi

log() { echo "  stack-update: $*"; }
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
CHANGED_PKGS=""
EXT_FROM=""
EXT_TO=""
EXT_RESULT="skipped"
RESTARTED_DVHUB=0
ERRORS=""
add_error() { ERRORS="${ERRORS}${ERRORS:+; }$*"; }

# PostgreSQL-Hauptversion (wie pkg-maintain.sh / timescale-provision.sh)
PG_VER=""
if command -v pg_lsclusters >/dev/null 2>&1; then
  PG_VER="$(pg_lsclusters -h 2>/dev/null | awk 'NR==1{print $1}')"
fi

# post-update.sh startet timescale-provision.sh (Paketwechsel Apache->Community,
# ALTER, Postgres-Neustarts) im selben Start entkoppelt. Beide gleichzeitig
# streiten um die apt-Sperre (Feldfall 21.10.2026: "errors":"apt-update") und
# starten Postgres durcheinander neu → erst warten, bis die Nachruestung fertig ist.
if command -v systemctl >/dev/null 2>&1; then
  for _ in $(seq 1 "${STACK_UPDATE_PROVISION_WAIT:-600}"); do
    systemctl is-active --quiet dvhub-timescale-provision.service 2>/dev/null || break
    sleep 1
  done
fi

# --- 1. TimescaleDB-Pakete ----------------------------------------------------
if [[ -f "$INSTALL_DIR/pkg-maintain.sh" ]]; then
  INSTALL_DIR="$INSTALL_DIR" DATA_DIR="$DATA_DIR" DB_NAME="$DB_NAME" bash "$INSTALL_DIR/pkg-maintain.sh" || add_error "pkg-maintain"
fi

# --- 2. Stack-Pakete innerhalb der Hauptversion -------------------------------
NODE_CHANGED=0
PG_CHANGED=0
if command -v apt-get >/dev/null 2>&1 && command -v dpkg-query >/dev/null 2>&1; then
  CANDIDATES="nodejs openvpn strongswan autossh openssh-client libjemalloc2 wireguard-tools"
  [[ -n "$PG_VER" ]] && CANDIDATES="$CANDIDATES postgresql-$PG_VER postgresql-client-$PG_VER"
  INSTALLED=""
  for p in $CANDIDATES; do
    if dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q "install ok installed"; then
      INSTALLED="$INSTALLED $p"
    fi
  done
  if [[ -n "$INSTALLED" ]]; then
    BEFORE="$(dpkg-query -W -f='${Package}=${Version}\n' $INSTALLED 2>/dev/null)"
    if apt-get update -qq >/dev/null 2>&1; then
      DEBIAN_FRONTEND=noninteractive apt-get install -y --only-upgrade \
        -o Dpkg::Options::=--force-confold $INSTALLED >/dev/null 2>&1 || add_error "apt-upgrade"
    else
      add_error "apt-update"
    fi
    AFTER="$(dpkg-query -W -f='${Package}=${Version}\n' $INSTALLED 2>/dev/null)"
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      if ! grep -qxF "$line" <<<"$BEFORE"; then
        CHANGED_PKGS="${CHANGED_PKGS}${CHANGED_PKGS:+ }${line}"
        case "${line%%=*}" in
          nodejs) NODE_CHANGED=1 ;;
          postgresql-"$PG_VER") PG_CHANGED=1 ;;
        esac
      fi
    done <<<"$AFTER"
    log "Pakete: ${CHANGED_PKGS:-alle aktuell}"
  fi
fi

# --- 3. TimescaleDB-Erweiterung in der Datenbank --------------------------------
pg_sql() { su postgres -c "psql -X -tAqc \"$1\" ${DB_NAME}" 2>/dev/null | tr -d '[:space:]'; }
pg_wait() {
  local i
  for i in $(seq 1 60); do
    su postgres -c "psql -X -tAqc 'SELECT 1' ${DB_NAME}" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}
if command -v psql >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1; then
  EXT_FROM="$(pg_sql "SELECT extversion FROM pg_extension WHERE extname='timescaledb'")"
  EXT_TO="$(pg_sql "SELECT default_version FROM pg_available_extensions WHERE name='timescaledb'")"
  if [[ -n "$EXT_FROM" && -n "$EXT_TO" && "$EXT_FROM" != "$EXT_TO" ]]; then
    log "TimescaleDB-Erweiterung ${EXT_FROM} -> ${EXT_TO}"
    if systemctl restart postgresql.service && pg_wait \
      && su postgres -c "psql -X -v ON_ERROR_STOP=1 -qc 'ALTER EXTENSION timescaledb UPDATE' ${DB_NAME}" >/dev/null 2>&1; then
      su postgres -c "psql -X -qc \"UPDATE _timescaledb_catalog.metadata m SET value = e.extversion FROM pg_extension e WHERE e.extname = 'timescaledb' AND m.key = 'timescaledb_version' AND m.value <> e.extversion\" ${DB_NAME}" >/dev/null 2>&1 || true
      systemctl restart postgresql.service && pg_wait || add_error "pg-restart-post"
      EXT_RESULT="updated"
      PG_CHANGED=1
    else
      EXT_RESULT="failed"
      add_error "alter-extension"
      systemctl is-active --quiet postgresql.service || systemctl restart postgresql.service || true
    fi
  elif [[ -n "$EXT_FROM" ]]; then
    EXT_RESULT="current"
  fi
fi

# --- 4. DVhub neu starten, wenn Laufzeit oder Datenbank neu sind ---------------
if [[ "$NODE_CHANGED" -eq 1 || "$PG_CHANGED" -eq 1 ]] && command -v systemctl >/dev/null 2>&1; then
  if systemctl restart "${SERVICE_NAME}.service"; then
    RESTARTED_DVHUB=1
    log "DVhub neu gestartet (neue Laufzeit/Datenbank)"
  else
    add_error "dvhub-restart"
  fi
fi

# --- 5. Status ------------------------------------------------------------------
mkdir -p "$DATA_DIR" 2>/dev/null || true
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
printf '{"version":"%s","startedAt":"%s","finishedAt":"%s","changedPackages":"%s","timescale":{"from":"%s","to":"%s","result":"%s"},"restartedDvhub":%s,"errors":"%s"}\n' \
  "$(esc "$WANT")" "$STARTED" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(esc "$CHANGED_PKGS")" \
  "$(esc "$EXT_FROM")" "$(esc "$EXT_TO")" "$EXT_RESULT" "$RESTARTED_DVHUB" "$(esc "$ERRORS")" \
  > "${STATUS_FILE}.tmp" 2>/dev/null && mv -f "${STATUS_FILE}.tmp" "$STATUS_FILE"
log "fertig (Fehler: ${ERRORS:-keine})"
exit 0
