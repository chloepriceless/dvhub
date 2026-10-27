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
#      An installed Apache package (same .so) is swapped only after the
#      Community packages AND the Apache package are downloaded into DVhub's own
#      package folder; installs read from that folder (no network needed), and
#      if the Community install fails, the fallback reinstalls Apache from it.
#   5. shared_preload_libraries drop-in (conf.d) + postgres restart
#   6. Erweiterung anlegen (CREATE) bzw. auf die installierte Version heben
#      (ALTER EXTENSION ... UPDATE als erste Anweisung einer frischen Sitzung),
#      danach Postgres-Neustart
#   6b. Zeilen, die im kaputten Zwischenzustand in der Elterntabelle einer
#      Hypertable gelandet sind, zurueck in die Chunks
#   6c. pruefen, dass die Bibliothek laedt; timescale-status.json neu schreiben
#   7. flip cfg.telemetry.database.timescaledb = true so migration 014 runs
#
# NON-FATAL contract enforced by the CALLER (install.sh subshell / post-update.sh
# background unit). A box where the package/extension can't be provisioned stays
# on plain Postgres (config left false) -- graceful degradation, never a crash.
# Ausgaben von apt und psql stehen in $DATA_DIR/timescale-provision.log, ein
# Fehlschlag ab Schritt 6 zusaetzlich in timescale-status.json (GUI-Karte
# „Datenbank-Engine“).
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/dvhub}"
SERVICE_USER="${SERVICE_USER:-dvhub}"
DATA_DIR="${DATA_DIR:-${DV_DATA_DIR:-/var/lib/dvhub}}"
CONFIG_PATH="${CONFIG_PATH:-/etc/dvhub/config.json}"
DB_NAME="${DB_NAME:-dvhub}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# TS_PROVISION_EUID, OS_RELEASE, REPO_LIST, KEYRING, PG_ETC: nur fuer Tests
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

# Fertig ist die Box erst, wenn
#   - die Community-Bibliothek laedt (Lizenz „timescale“; die Einstellung gibt es
#     nur bei geladener Bibliothek — fehlt sie zur Katalog-Version, scheitert die
#     Abfrage ganz),
#   - keine Parktabelle aus Schritt 6b mehr wartet und
#   - keine Hypertable Zeilen in ihrer Elterntabelle hat. Die sieht man nur mit
#     abgeschaltetem Loader; query_to_xml statt PL/pgSQL, damit es eine einfache
#     Abfrage bleibt. Faengt auch eine Box, die jemand von Hand per ALTER
#     repariert hat: die Zeilen aus der kaputten Zeit waeren sonst fuer immer
#     unsichtbar.
# Ausgabe „timescale“ = fertig. post-update.sh fragt das mit --check ab.
ts_ready() {
  local lic roots
  lic="$(su postgres -c "psql -X -tAqc \"SELECT current_setting('timescaledb.license') || (SELECT CASE WHEN count(*) > 0 THEN '+rescue' ELSE '' END FROM pg_class WHERE relname LIKE 'dvhub!_ts!_rescue!_%' ESCAPE '!')\" ${DB_NAME}" 2>/dev/null | tr -d '[:space:]')" || true
  [[ "$lic" == "timescale" ]] || { echo "${lic:-unbekannt}"; return 0; }
  roots="$(su postgres -c "PGOPTIONS='-c timescaledb.disable_load=on' psql -X -tAqc \"SELECT count(*) FROM _timescaledb_catalog.hypertable h WHERE (xpath('/row/n/text()', query_to_xml(format('SELECT EXISTS (SELECT 1 FROM ONLY %I.%I) AS n', h.schema_name, h.table_name), false, true, '')))[1]::text = 'true'\" ${DB_NAME}" 2>/dev/null | tr -d '[:space:]')" || true
  if [[ -n "$roots" && "$roots" != "0" ]]; then echo "${lic}+elterntabelle"; else echo "$lic"; fi
}
if [[ "${1:-}" == "--check" ]]; then
  ts_ready
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

# Protokoll (Feldfall 21.10.2026): alles ging nach /dev/null, unter systemd-run
# war nicht nachvollziehbar, woran die Nachruestung scheiterte. Bei einem
# Dauerfehler laeuft das Skript bei jedem DVhub-Start → Datei klein halten.
LOG_FILE="${DATA_DIR}/timescale-provision.log"
mkdir -p "$DATA_DIR" 2>/dev/null || true
if [[ "$(stat -c %s "$LOG_FILE" 2>/dev/null || echo 0)" -gt 1048576 ]]; then
  tail -c 262144 "$LOG_FILE" > "$LOG_FILE.tmp" 2>/dev/null && mv -f "$LOG_FILE.tmp" "$LOG_FILE" || true
fi
log_line() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG_FILE" 2>/dev/null || true; }
log_line "timescale-provision: Start (PG ${PG_VER})"

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
  su postgres -c "psql -X -tAqc \"SELECT current_setting('timescaledb.license')\" ${DB_NAME}" 2>/dev/null | tr -d '[:space:]'
}

# Katalog lesen, ohne dass der Loader die versionierte Bibliothek laedt. Fehlt
# die Bibliothek zur Katalog-Version, scheitert sonst schon die erste Anweisung
# jeder Sitzung, auch ein SELECT auf pg_extension (am echten Fall geprueft).
psql_noload() {
  su postgres -c "PGOPTIONS='-c timescaledb.disable_load=on' psql -X -tAq -d ${DB_NAME} -c \"$1\"" 2>>"$LOG_FILE" | tr -d '[:space:]'
}

# timescale-status.json neu schreiben (derselbe Block wie der naechtliche Timer,
# ohne apt). $1 = ok|failed, $2 = Fehlertext.
write_status() {
  [[ -f "$SCRIPT_DIR/pkg-maintain.sh" ]] || return 0
  PKG_MAINTAIN_STATUS_ONLY=1 PROVISION_RESULT="$1" PROVISION_ERROR="${2:-}" \
    SERVICE_USER="$SERVICE_USER" DATA_DIR="$DATA_DIR" DB_NAME="$DB_NAME" \
    bash "$SCRIPT_DIR/pkg-maintain.sh" >>"$LOG_FILE" 2>&1 || true
}

# Ab Schritt 6 ist ein Fehlschlag kein „bleibt halt reines Postgres“ mehr: die
# Daten liegen schon in einer Hypertable. Sichtbar machen statt still exit 0.
fail_visible() {
  echo "  FEHLER: TimescaleDB: $1 — Details in ${LOG_FILE}" >&2
  log_line "FEHLER: $1"
  write_status failed "$1"
  exit 1
}

# --- 2. Fast-skip if the Community extension is already active (prod) ---------
# prod already runs the Community build out-of-band → this makes the script a
# true no-op there; the config flip below still runs to keep state consistent.
if [[ "$(ts_ready)" == "timescale" ]]; then
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
  # LC_ALL=C: apt meldet sonst in der Sprache der Box („Fehl:“, „Depot“).
  APT_OUT="$(LC_ALL=C apt-get update 2>&1 || true)"
  printf '%s\n' "$APT_OUT" >>"$LOG_FILE" 2>/dev/null || true
  # Hat packagecloud fuer diese Distribution nichts (kein Release), bliebe die
  # Quelle sonst stehen und jedes `apt update` der Box meldete den Fehler → wieder
  # entfernen, unten greift der Apache-Fallback. Nur bei genau diesem Befund:
  # DNS-Ausfall oder 503 sind voruebergehend, die Quelle ist dann trotzdem richtig.
  # grep ohne -q: liest alles, kein SIGPIPE unter pipefail (siehe apt-cache).
  if printf '%s\n' "$APT_OUT" | grep -E "^(E|Error): The repository '[^']*packagecloud\.io/timescale/[^']*' does not have a Release file" >/dev/null; then
    echo "  WARN: packagecloud hat keine TimescaleDB-Pakete fuer ${DISTRO} ${CODENAME} — apt-Quelle wieder entfernt." >&2
    rm -f "$REPO_LIST"
    apt-get update >>"$LOG_FILE" 2>&1 || true
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

# Eigener Download-Ordner (Gegenpruefung 25.10.2026): ein dpkg-Hook wie
# docker-clean (Debian/Ubuntu-Container-Abbilder) leert nach JEDEM dpkg-Lauf
# /var/cache/apt/archives — nach dem Entfernen von Apache waeren die eben
# geladenen Pakete weg. Bewusst nicht /tmp (Debian 13: RAM-Dateisystem).
DEB_DIR="${TS_DEB_CACHE:-/var/cache/dvhub-timescale}"
# Gegenpruefung 7c1761b8: Download UND Installation lesen denselben Ordner —
# apt legt beim Download alles ab, was es aufloest (auch Abhaengigkeiten wie
# timescaledb-tools), und findet es bei der Installation dort wieder; ohne Netz
# geht die Installation so trotzdem. Installiert wird per Paketname (apt nimmt
# aus dem Ordner nur die Kandidaten-Version, aeltere Reste stoeren nicht), nie
# per geratenem Dateinamen. Der Ordner wird erst nach Erfolg geleert: ein
# abgebrochener Lauf (Apache schon entfernt) findet das Apache-Paket dort beim
# naechsten Mal auch ohne Netz (Gegenpruefung d867a370).
apt_dl() { mkdir -p "$DEB_DIR/partial" && DEBIAN_FRONTEND=noninteractive apt-get install -y --download-only -o Dir::Cache::archives="$DEB_DIR" "$@" >>"$LOG_FILE" 2>&1; }
apt_inst() { mkdir -p "$DEB_DIR/partial" && DEBIAN_FRONTEND=noninteractive apt-get install -y -o Dir::Cache::archives="$DEB_DIR" "$@" >>"$LOG_FILE" 2>&1; }
APACHE_REMOVED=0

if [[ "$USE_TSL" -eq 1 ]]; then
  # The Debian Apache package ships the same `timescaledb` .so and conflicts with
  # the Community package (retrofit Apache→Community). Review 25.10.2026: früher
  # wurde Apache entfernt, bevor feststand, dass die Community-Installation
  # gelingt — ohne Netz stand die Box danach ohne Bibliothek zur Katalog-Version.
  # Jetzt liegen VOR dem Entfernen die Community-Pakete UND das installierte
  # Apache-Paket im eigenen Download-Ordner. Scheitert danach die Installation,
  # holt der Fallback unten Apache ohne Netz zurück. Bewusst kein Tausch in
  # einem einzigen apt-Lauf: der hinge an Conflicts/Replaces der Fremdpakete.
  if dpkg -s "$TSL_PKG" >/dev/null 2>&1; then
    echo "  TimescaleDB: Community-Paket ${TSL_PKG} bereits installiert."
  elif ! apt_dl "$TSL_LOADER" "$TSL_PKG"; then
    echo "  WARN: Community-Paket nicht herunterladbar — Fallback auf Apache-Paket." >&2
    USE_TSL=0
  else
    APACHE_READY=1
    if dpkg -s "$APACHE_PKG" >/dev/null 2>&1; then
      if apt_dl --reinstall "$APACHE_PKG"; then
        echo "  TimescaleDB: entferne Apache-Paket ${APACHE_PKG} (wird durch Community ersetzt) ..."
        DEBIAN_FRONTEND=noninteractive apt-get remove -y "$APACHE_PKG" >>"$LOG_FILE" 2>&1 || true
        APACHE_REMOVED=1
        PKG_CHANGED=1
      else
        echo "  WARN: Apache-Paket nicht sicherbar — Tausch auf Community verschoben." >&2
        APACHE_READY=0
        USE_TSL=0
      fi
    fi
    if [[ "$APACHE_READY" -eq 1 ]]; then
      if apt_inst "$TSL_LOADER" "$TSL_PKG"; then
        echo "  TimescaleDB: Community-Paket ${TSL_PKG} installiert."
        PKG_CHANGED=1
      else
        echo "  WARN: Community-Paket nicht installierbar — Fallback auf Apache-Paket." >&2
        USE_TSL=0
        # Halb installierte Community-Pakete (z. B. nur der Loader) teilen sich
        # die .so mit Apache und stuenden der Rueckkehr im Weg.
        for _p in "$TSL_PKG" "$TSL_LOADER"; do
          if dpkg -s "$_p" >/dev/null 2>&1; then
            DEBIAN_FRONTEND=noninteractive apt-get remove -y "$_p" >>"$LOG_FILE" 2>&1 || true
          fi
        done
      fi
    fi
  fi
fi

if [[ "$USE_TSL" -eq 0 ]]; then
  # Fallback: Debian Apache build. The hypertable still works; migration 014's
  # license guard skips compression + continuous aggregates on this build. Keeps
  # a box functional where packagecloud has no build for the platform/codename.
  if ! dpkg -s "$APACHE_PKG" >/dev/null 2>&1; then
    if apt_inst "$APACHE_PKG"; then
      echo "  TimescaleDB: ${APACHE_PKG} (Apache-Fallback) installiert."
      PKG_CHANGED=1
    elif [[ "$APACHE_REMOVED" -eq 1 ]]; then
      # Diese Box HATTE TimescaleDB (Katalog, Preload-Eintrag). Ohne Bibliothek
      # startet PostgreSQL mit shared_preload_libraries='timescaledb' nicht
      # mehr — den Eintrag darum entfernen und den Zustand melden, nicht still
      # weiterlaufen (Gegenpruefung 25.10.2026). Der naechste Lauf versucht es neu.
      rm -f "${PG_ETC:-/etc/postgresql}/${PG_VER}/main/conf.d/timescaledb.conf"
      fail_visible "Paketwechsel Apache→Community gescheitert, ${APACHE_PKG} nicht wieder installierbar — TimescaleDB-Bibliothek fehlt (Preload-Eintrag entfernt, damit PostgreSQL startet)"
    else
      echo "  WARN: ${APACHE_PKG} nicht installierbar (Netz/Repo?) — Box bleibt auf reinem Postgres." >&2
      exit 0
    fi
  else
    echo "  TimescaleDB: ${APACHE_PKG} (Apache) bereits installiert."
  fi
fi
rm -rf "$DEB_DIR"

# Neustart + warten, bis Postgres antwortet. Die Probe laeuft in der Datenbank
# postgres: dort ist TimescaleDB nicht angelegt, sie geht also auch, wenn die
# Bibliothek zur Katalog-Version in ${DB_NAME} fehlt.
restart_pg() {
  systemctl restart postgresql >>"$LOG_FILE" 2>&1 || return 1
  local _
  for _ in $(seq 1 30); do
    su postgres -c "psql -X -tAqc 'SELECT 1' postgres" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

# --- 5. shared_preload_libraries drop-in + restart ---------------------------
# TimescaleDB is a preloaded extension — CREATE EXTENSION fails until the library
# is in shared_preload_libraries and postgres has restarted. Debian's
# postgresql.conf ships `include_dir = 'conf.d'`, so a drop-in is honoured.
CONF_DIR="${PG_ETC:-/etc/postgresql}/${PG_VER}/main/conf.d"
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
  restart_pg || { echo "  WARN: Postgres-Restart fehlgeschlagen." >&2; exit 0; }
fi

# --- 6. Erweiterung anlegen bzw. auf die installierte Version heben ----------
# Feldfall 21.10.2026 (Ubuntu 26.04, Apache 2.25.1 -> Community 2.31.0): Die
# Community-Pakete bringen versionierte Bibliotheken erst ab 2.27.0 mit. Der
# Loader laedt pro Sitzung die Bibliothek zur Version im Katalog; fehlt sie,
# scheitert die ERSTE Anweisung jeder Sitzung („could not access file
# "timescaledb-2.25.1"“) — auch CREATE EXTENSION IF NOT EXISTS, an dem das
# Skript frueher haengen blieb, bevor das ALTER kam. Darum den Katalog ohne
# Loader lesen und ALTER EXTENSION … UPDATE als erste Anweisung einer frischen
# Sitzung schicken (-X: keine psqlrc davor); dann laedt der Loader die
# Ziel-Bibliothek. Danach Postgres neu starten: Sitzungen, die ohne Bibliothek
# weiterlaufen (auch die von DVhub), schreiben sonst weiter an den Chunks vorbei.
EXT_HAVE="$(psql_noload "SELECT extversion FROM pg_extension WHERE extname='timescaledb'")"
EXT_WANT="$(psql_noload "SELECT default_version FROM pg_available_extensions WHERE name='timescaledb'")"
log_line "Erweiterung in ${DB_NAME}: ${EXT_HAVE:-keine}, Paket bietet ${EXT_WANT:-?}"
if [[ -z "$EXT_HAVE" ]]; then
  if ! su postgres -c "psql -X -v ON_ERROR_STOP=1 -q -d ${DB_NAME} -c 'CREATE EXTENSION IF NOT EXISTS timescaledb'" >>"$LOG_FILE" 2>&1; then
    # Noch keine Hypertable → reines Postgres bleibt ein gueltiger Zustand.
    echo "  WARN: CREATE EXTENSION timescaledb in '${DB_NAME}' fehlgeschlagen — Box bleibt auf reinem Postgres (Details in ${LOG_FILE})." >&2
    log_line "WARN: CREATE EXTENSION fehlgeschlagen"
    write_status failed "CREATE EXTENSION timescaledb fehlgeschlagen"
    exit 0
  fi
elif [[ "$EXT_HAVE" != "$EXT_WANT" ]]; then
  echo "  TimescaleDB: Erweiterung ${EXT_HAVE} -> ${EXT_WANT:-?} ..."
  su postgres -c "psql -X -v ON_ERROR_STOP=1 -q -d ${DB_NAME} -c 'ALTER EXTENSION timescaledb UPDATE'" >>"$LOG_FILE" 2>&1 \
    || fail_visible "ALTER EXTENSION timescaledb UPDATE (${EXT_HAVE} -> ${EXT_WANT:-?}) fehlgeschlagen"
  # Katalog-Marker angleichen (wie runTimescaleExtUpgrade und der Restore).
  su postgres -c "psql -X -q -d ${DB_NAME} -c \"UPDATE _timescaledb_catalog.metadata m SET value = e.extversion FROM pg_extension e WHERE e.extname = 'timescaledb' AND m.key = 'timescaledb_version' AND m.value <> e.extversion\"" >>"$LOG_FILE" 2>&1 || true
  echo "  TimescaleDB: Postgres-Neustart (Sitzungen auf die neue Bibliothek) ..."
  restart_pg || fail_visible "Postgres-Neustart nach dem Erweiterungs-Update fehlgeschlagen"
fi

# --- 6b. Zeilen aus der Elterntabelle zurueck in die Chunks ----------------------
# Im kaputten Zwischenzustand laufen nach der ersten (gescheiterten) Anweisung
# alle weiteren ohne TimescaleDB: INSERTs landen in der Elterntabelle der
# Hypertable statt in einem Chunk. Mit geladener Bibliothek sind diese Zeilen
# unsichtbar, auch fuer SELECT … FROM ONLY. Darum in drei Sitzungen:
#   1. mit Loader: je Hypertable eine leere Parktabelle public.dvhub_ts_rescue_<id>
#   2. OHNE Loader, nur DML: Zeilen per DELETE … RETURNING dorthin verschieben.
#      Kein DDL in dieser Sitzung — der DDL-Ereignis-Trigger von TimescaleDB laedt
#      die Bibliothek nach, danach ist die Elterntabelle wieder leer (am echten
#      Fall gesehen: 0 Zeilen verschoben).
#   3. mit Loader: zurueck in die Hypertable (Chunks) und Parktabelle loeschen;
#      ein Upsert dieser Zeit (gleicher Schluessel wie eine Chunk-Zeile) ist der
#      neuere Wert und gewinnt.
# Bricht ein Lauf dazwischen ab, bleibt die Parktabelle stehen; ts_ready() meldet
# das, der naechste DVhub-Start holt es nach.
su postgres -c "psql -X -v ON_ERROR_STOP=1 -q -d ${DB_NAME}" >>"$LOG_FILE" 2>&1 <<'SQL' \
  || fail_visible "Parktabellen fuer die Hypertable-Elterntabellen liessen sich nicht anlegen"
DO $rescue$
DECLARE h record;
BEGIN
  FOR h IN SELECT id, schema_name, table_name FROM _timescaledb_catalog.hypertable ORDER BY id LOOP
    EXECUTE format('CREATE TABLE IF NOT EXISTS public.dvhub_ts_rescue_%s (LIKE %I.%I)', h.id, h.schema_name, h.table_name);
  END LOOP;
END
$rescue$;
SQL
su postgres -c "PGOPTIONS='-c timescaledb.disable_load=on' psql -X -v ON_ERROR_STOP=1 -q -d ${DB_NAME}" >>"$LOG_FILE" 2>&1 <<'SQL' \
  || fail_visible "Zeilen aus der Hypertable-Elterntabelle liessen sich nicht parken"
DO $rescue$
DECLARE h record; n bigint;
BEGIN
  FOR h IN SELECT id, schema_name, table_name FROM _timescaledb_catalog.hypertable ORDER BY id LOOP
    CONTINUE WHEN to_regclass(format('public.dvhub_ts_rescue_%s', h.id)) IS NULL;
    EXECUTE format('WITH moved AS (DELETE FROM ONLY %2$I.%3$I RETURNING *) INSERT INTO public.dvhub_ts_rescue_%1$s SELECT * FROM moved',
      h.id, h.schema_name, h.table_name);
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN RAISE NOTICE 'dvhub-rescue: % Zeilen aus %.% geparkt', n, h.schema_name, h.table_name; END IF;
  END LOOP;
END
$rescue$;
SQL
su postgres -c "psql -X -v ON_ERROR_STOP=1 -q -d ${DB_NAME}" >>"$LOG_FILE" 2>&1 <<'SQL' \
  || fail_visible "geparkte Zeilen liessen sich nicht in die Hypertable zurueckschreiben (bleiben in public.dvhub_ts_rescue_*)"
DO $rescue$
DECLARE r record; ht regclass; rt regclass; keys text[]; cols text; sets text; n bigint;
BEGIN
  IF to_regclass('_timescaledb_catalog.hypertable') IS NULL THEN RETURN; END IF;
  FOR r IN SELECT h.id, h.schema_name, h.table_name FROM _timescaledb_catalog.hypertable h
           WHERE to_regclass(format('public.dvhub_ts_rescue_%s', h.id)) IS NOT NULL ORDER BY h.id LOOP
    ht := format('%I.%I', r.schema_name, r.table_name)::regclass;
    rt := format('public.dvhub_ts_rescue_%s', r.id)::regclass;
    SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO cols
      FROM pg_attribute WHERE attrelid = rt AND attnum > 0 AND NOT attisdropped;
    -- eindeutiger Schluessel der Hypertable (Primaerschluessel zuerst), ohne Ausdrucks-/Teilindex
    SELECT array_agg(a.attname ORDER BY k.ord) INTO keys
      FROM (SELECT indkey FROM pg_index WHERE indrelid = ht AND indisunique AND indexprs IS NULL AND indpred IS NULL
            ORDER BY indisprimary DESC, indexrelid LIMIT 1) i
      CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = ht AND a.attnum = k.attnum;
    IF keys IS NULL THEN
      EXECUTE format('INSERT INTO %s (%s) SELECT %s FROM %s', ht, cols, cols, rt);
    ELSE
      SELECT string_agg(format('%1$I = EXCLUDED.%1$I', attname), ', ' ORDER BY attnum) INTO sets
        FROM pg_attribute WHERE attrelid = rt AND attnum > 0 AND NOT attisdropped AND attname <> ALL (keys);
      EXECUTE format('INSERT INTO %s (%s) SELECT %s FROM %s ON CONFLICT (%s) DO %s', ht, cols, cols, rt,
        (SELECT string_agg(quote_ident(k), ', ') FROM unnest(keys) k),
        CASE WHEN sets IS NULL THEN 'NOTHING' ELSE 'UPDATE SET ' || sets END);
    END IF;
    GET DIAGNOSTICS n = ROW_COUNT;
    EXECUTE format('DROP TABLE %s', rt);
    IF n > 0 THEN RAISE NOTICE 'dvhub-rescue: % Zeilen nach % zurueckgeschrieben', n, ht; END IF;
  END LOOP;
END
$rescue$;
SQL

# --- 6c. Laedt die Bibliothek? Dann Status neu schreiben ------------------------
# Frische Sitzung, Loader an: geht nur, wenn die Bibliothek zur Katalog-Version
# da ist. Sonst bliebe bis zur naechsten Nacht „aktuell“ in timescale-status.json.
EXTVER="$(su postgres -c "psql -X -v ON_ERROR_STOP=1 -tAq -d ${DB_NAME} -c \"SELECT extversion FROM pg_extension WHERE extname='timescaledb'\"" 2>>"$LOG_FILE" | tr -d '[:space:]')" \
  || fail_visible "TimescaleDB-Bibliothek laedt nicht (Erweiterung ${EXT_WANT:-?})"
[[ -n "$EXTVER" ]] || fail_visible "TimescaleDB-Erweiterung fehlt nach der Provisionierung in '${DB_NAME}'"
LICENSE="$(ext_license)"
echo "  TimescaleDB: Extension in DB '${DB_NAME}' aktiv (v${EXTVER}, Lizenz ${LICENSE:-?})."
log_line "OK: v${EXTVER}, Lizenz ${LICENSE:-?}"
write_status ok ""

# --- 7. Flip the config so migration 014 runs on next start ------------------
flip_config_true
echo "  TimescaleDB: bereit (PG ${PG_VER}, DB ${DB_NAME})."
