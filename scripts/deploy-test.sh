#!/usr/bin/env bash
#
# deploy-test.sh — Fresh-deploy smoke test for DVhub.
#
# Verifies that the software deploys cleanly onto a FRESH Debian/Ubuntu box
# (LXC or VM): runs install.sh, then checks every component install.sh is
# supposed to create and that the service actually comes up healthy.
#
# Run this ON the fresh target, as root, with the repo checked out (the same
# tree that contains install.sh — i.e. the repo ROOT, not the dvhub/ app dir).
#
#   sudo bash scripts/deploy-test.sh                 # base tier (no EOS)
#   sudo bash scripts/deploy-test.sh --with-eos      # Tier 3 (also tests EOS)
#   sudo bash scripts/deploy-test.sh --verify-only   # skip install.sh, just verify
#
# Repo source: by default the CURRENT tree this script lives in is deployed —
# install.sh is git-clone based, so the tree is snapshotted into a local git repo
# and install.sh is pointed at it via --repo (no PAT, no public mirror). To
# instead test the public release, pass through install.sh's flags:
#   sudo bash scripts/deploy-test.sh --repo https://github.com/chloepriceless/dvhub.git --branch main
#
# Exit code 0 = all checks passed, non-zero = at least one FAIL.
#
# DRAFT (T-0118 follow-up, 2026-06-06) — coordinate target OS / location / CI
# conventions with Schraubi (Dev+Ops-Infra, T-0116) before wiring into CI.
set -uo pipefail

# --- Defaults mirror install.sh (override via env to match a custom install) ---
INSTALL_DIR="${INSTALL_DIR:-/opt/dvhub}"
APP_DIR="${APP_DIR:-$INSTALL_DIR/dvhub}"
SERVICE_USER="${SERVICE_USER:-dvhub}"
SERVICE_NAME="${SERVICE_NAME:-dvhub}"
DATA_DIR="${DATA_DIR:-/var/lib/dvhub}"
CONFIG_DIR="${CONFIG_DIR:-/etc/dvhub}"
CONFIG_PATH="${CONFIG_PATH:-$CONFIG_DIR/config.json}"
SETUP_PORT="${SETUP_PORT:-80}"     # app httpPort from config.json (NOT 8080 — T-0118)
HTTPS_PORT="${HTTPS_PORT:-443}"    # app httpsPort from config.json
EOS_PORT="${EOS_PORT:-8503}"
HEALTH_RETRIES="${HEALTH_RETRIES:-30}"   # seconds to wait for the service to answer
SNAPSHOT_BRANCH="${SNAPSHOT_BRANCH:-dvhub-deploytest}"  # local branch for the tree snapshot

WITH_EOS=0
VERIFY_ONLY=0
INSTALL_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --with-eos)     WITH_EOS=1; INSTALL_ARGS+=(--with-eos) ;;
    --verify-only)  VERIFY_ONLY=1 ;;
    *)              INSTALL_ARGS+=("$arg") ;;
  esac
done

# --- Locate install.sh (repo root = parent of this script's scripts/ dir) ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_SH="$REPO_ROOT/install.sh"

# --- Reporting helpers ---
PASS=0; FAIL=0; SKIP=0
results=()
green=$'\033[32m'; red=$'\033[31m'; yellow=$'\033[33m'; dim=$'\033[2m'; rst=$'\033[0m'
ok()   { PASS=$((PASS+1)); results+=("${green}PASS${rst} $1"); printf '%s[PASS]%s %s\n' "$green" "$rst" "$1"; }
bad()  { FAIL=$((FAIL+1)); results+=("${red}FAIL${rst} $1"); printf '%s[FAIL]%s %s\n' "$red" "$rst" "$1"; }
skip() { SKIP=$((SKIP+1)); results+=("${yellow}SKIP${rst} $1"); printf '%s[SKIP]%s %s\n' "$yellow" "$rst" "$1"; }
# check "label" command...  -> PASS if command exits 0, else FAIL
check() { local label="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$label"; else bad "$label"; fi; }

section() { printf '\n%s== %s ==%s\n' "$dim" "$1" "$rst"; }

# ============================================================================
section "Pre-flight"
# ============================================================================
if [[ $EUID -ne 0 ]]; then
  echo "Muss als root laufen (install.sh provisioniert System-Pakete)." >&2
  exit 2
fi
if ! command -v apt-get >/dev/null 2>&1; then
  bad "OS ist Debian/Ubuntu (apt-get vorhanden)"
  echo "Abbruch: install.sh unterstuetzt nur Debian/Ubuntu." >&2
  exit 2
fi
ok "OS ist Debian/Ubuntu (apt-get vorhanden)"
. /etc/os-release 2>/dev/null || true
echo "  Distro: ${PRETTY_NAME:-unbekannt}"
echo "  Kernel: $(uname -r)  Arch: $(uname -m)"

if [[ ! -f "$INSTALL_SH" ]]; then
  bad "install.sh gefunden ($INSTALL_SH)"
  echo "Abbruch: Test muss aus dem Repo-Root laufen." >&2
  exit 2
fi
ok "install.sh gefunden ($INSTALL_SH)"

# ============================================================================
section "Deploy (install.sh)"
# ============================================================================
if [[ $VERIFY_ONLY -eq 1 ]]; then
  skip "install.sh ausgefuehrt (--verify-only)"
else
  # install.sh ist git-clone-basiert (klont origin/$REPO_BRANCH nach INSTALL_DIR).
  # Damit der HIER vorliegende Tree (= die aktuelle Software, z.B. aus dem
  # --repo-tarball) deployt wird statt des public GitHub-Defaults, snapshotten wir
  # ihn in ein lokales Git-Repo und zeigen install.sh per --repo darauf.
  # Hat der Aufrufer bereits --repo gesetzt (z.B. public main als Mode 2),
  # respektieren wir das und überspringen den Snapshot.
  caller_repo=0
  for a in "${INSTALL_ARGS[@]:-}"; do [[ "$a" == "--repo" ]] && caller_repo=1; done
  if [[ $caller_repo -eq 0 ]]; then
    # T-0224: the local-tree snapshot needs git BEFORE install.sh apt-installs it.
    # On minimal Debian/Ubuntu templates git is absent — without it deploy-test
    # would otherwise SILENTLY fall back to install.sh's public-main default and
    # test the WRONG code (false green). Ensure git up front (we run as root and
    # install.sh pulls it in anyway); fail loudly below if it cannot be obtained.
    if ! command -v git >/dev/null 2>&1; then
      echo "  git fehlt — installiere es vorab für den Tree-Snapshot…"
      apt-get update -qq >/dev/null 2>&1 || true
      apt-get install -y -qq git >/dev/null 2>&1 || true
    fi
    if command -v git >/dev/null 2>&1; then
      echo "  Snapshot: lokales Git-Repo aus $REPO_ROOT (aktuelle Software) für install.sh"
      # Der entpackte Tree gehoert ggf. einem fremden Owner (uid 1000 aus dem
      # Tarball) → git als root meldet "dubious ownership". Wir laufen als root,
      # also einfach root-owned machen + safe.directory — deckt unsere git-Ops
      # UND install.sh's `git clone <lokaler Pfad>` ab.
      chown -R root:root "$REPO_ROOT" 2>/dev/null || true
      git config --global --add safe.directory "$REPO_ROOT" 2>/dev/null || true
      if [[ ! -d "$REPO_ROOT/.git" ]]; then
        git -C "$REPO_ROOT" init -q
        git -C "$REPO_ROOT" config user.email "deploy-test@dvhub.local"
        git -C "$REPO_ROOT" config user.name "deploy-test"
        git -C "$REPO_ROOT" add -A
        git -C "$REPO_ROOT" commit -q -m "deploy-test snapshot" || true
      fi
      git -C "$REPO_ROOT" checkout -q -B "$SNAPSHOT_BRANCH" 2>/dev/null || true
      # install.sh-Flags sind --repo/--branch (NICHT --repo). --channel dev
      # erzwingt den direkten Branch-Checkout (kein Tag-Resolve auf dem Snapshot).
      INSTALL_ARGS+=(--repo "$REPO_ROOT" --branch "$SNAPSHOT_BRANCH" --channel dev)
    else
      # git could not be obtained → ABORT. Silently running install.sh against
      # its public-main default would test the WRONG code and report a false green.
      bad "git nicht verfügbar — kann den lokalen Tree nicht snapshotten. ABBRUCH statt stillem Test gegen public main. Fix: 'apt-get install -y git' auf der Box, dann erneut. (Oder explizit --repo <url> --branch <ref> übergeben, um bewusst ein Remote zu testen.)"
      exit 2
    fi
  else
    echo "  Repo-Quelle: vom Aufrufer via --repo vorgegeben (kein Tree-Snapshot)"
  fi
  echo "  Starte: bash $INSTALL_SH ${INSTALL_ARGS[*]:-}"
  log="$(mktemp)"
  if bash "$INSTALL_SH" "${INSTALL_ARGS[@]}" >"$log" 2>&1; then
    ok "install.sh lief ohne Fehler durch (exit 0)"
  else
    rc=$?
    bad "install.sh lief ohne Fehler durch (exit $rc)"
    echo "  ${dim}--- letzte 25 Zeilen install.sh-Log ---${rst}"
    tail -n 25 "$log" | sed 's/^/  /'
  fi
  echo "  Volllog: $log"
fi

# ============================================================================
section "System-Voraussetzungen"
# ============================================================================
check "Node.js vorhanden" command -v node
if command -v node >/dev/null 2>&1; then
  if node -e 'process.exit(Number(process.versions.node.split(".")[0])>=18?0:1)'; then
    ok "Node.js >= 18 ($(node --version))"
  else
    bad "Node.js >= 18 ($(node --version))"
  fi
fi
for pkg in curl git psql openvpn; do
  check "Abhaengigkeit installiert: $pkg" command -v "$pkg"
done

# ============================================================================
section "Service-User & Verzeichnisse"
# ============================================================================
check "Service-User '$SERVICE_USER' existiert" id "$SERVICE_USER"
check "App-Verzeichnis vorhanden ($APP_DIR)" test -d "$APP_DIR"
check "server.js vorhanden ($APP_DIR/server.js)" test -f "$APP_DIR/server.js"
check "npm-Deps installiert (node_modules)" test -d "$APP_DIR/node_modules"
check "Config-Dir ($CONFIG_DIR)" test -d "$CONFIG_DIR"
check "Hersteller-Dir ($CONFIG_DIR/hersteller)" test -d "$CONFIG_DIR/hersteller"
check "Daten-Dir ($DATA_DIR)" test -d "$DATA_DIR"
check "config.json vorhanden ($CONFIG_PATH)" test -f "$CONFIG_PATH"
if [[ -f "$CONFIG_PATH" ]]; then
  if node -e "JSON.parse(require('fs').readFileSync('$CONFIG_PATH','utf8'))" 2>/dev/null; then
    ok "config.json ist gueltiges JSON"
  else
    bad "config.json ist gueltiges JSON"
  fi
fi
# TLS cert (self-signed, generated by install.sh)
if ls "$CONFIG_DIR"/tls/*.pem "$CONFIG_DIR"/tls/*.crt >/dev/null 2>&1; then
  ok "TLS-Zertifikat generiert ($CONFIG_DIR/tls)"
else
  skip "TLS-Zertifikat generiert (kein .pem/.crt in $CONFIG_DIR/tls)"
fi

# ============================================================================
section "PostgreSQL"
# ============================================================================
check "PostgreSQL-Dienst aktiv" systemctl is-active --quiet postgresql
if su - postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='dvhub'\"" 2>/dev/null | grep -q 1; then
  ok "DB-Rolle 'dvhub' existiert"
else
  bad "DB-Rolle 'dvhub' existiert"
fi
if su - postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='dvhub'\"" 2>/dev/null | grep -q 1; then
  ok "Datenbank 'dvhub' existiert"
else
  bad "Datenbank 'dvhub' existiert"
fi

# ============================================================================
section "systemd-Service"
# ============================================================================
check "Unit-Datei vorhanden (/etc/systemd/system/${SERVICE_NAME}.service)" \
  test -f "/etc/systemd/system/${SERVICE_NAME}.service"
check "Service enabled" systemctl is-enabled --quiet "${SERVICE_NAME}.service"
# Service kann nach Start ein paar Sekunden brauchen (post-update.sh + bind).
active=0
for _ in $(seq 1 10); do
  if systemctl is-active --quiet "${SERVICE_NAME}.service"; then active=1; break; fi
  sleep 1
done
[[ $active -eq 1 ]] && ok "Service ${SERVICE_NAME} ist active" || bad "Service ${SERVICE_NAME} ist active"

# ============================================================================
section "Liveness (HTTP + Schema-Bootstrap)"
# ============================================================================
# Web-UI: die App serviert httpPort (Default 80) / httpsPort (443) aus
# config.json — NICHT 8080. Echte Ports aus der deployten config lesen.
http_port="$SETUP_PORT"; https_port="$HTTPS_PORT"
if [[ -f "$CONFIG_PATH" ]] && command -v node >/dev/null 2>&1; then
  http_port="$(node -e "try{process.stdout.write(String(JSON.parse(require('fs').readFileSync('$CONFIG_PATH','utf8')).httpPort||$SETUP_PORT))}catch{process.stdout.write('$SETUP_PORT')}" 2>/dev/null || echo "$SETUP_PORT")"
  https_port="$(node -e "try{process.stdout.write(String(JSON.parse(require('fs').readFileSync('$CONFIG_PATH','utf8')).httpsPort||$HTTPS_PORT))}catch{process.stdout.write('$HTTPS_PORT')}" 2>/dev/null || echo "$HTTPS_PORT")"
fi
http_ok=0
for _ in $(seq 1 "$HEALTH_RETRIES"); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${http_port}/" 2>/dev/null || echo 000)"
  if [[ "$code" =~ ^(200|301|302|401|403)$ ]]; then http_ok=1; break; fi
  sleep 1
done
[[ $http_ok -eq 1 ]] && ok "HTTP-UI antwortet auf :${http_port} (HTTP $code)" \
                      || bad "HTTP-UI antwortet auf :${http_port} (letzter Code: ${code:-000})"
# HTTPS (Self-Signed → -k)
hcode="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 3 "https://127.0.0.1:${https_port}/" 2>/dev/null || echo 000)"
[[ "$hcode" =~ ^(200|301|302|401|403)$ ]] && ok "HTTPS-UI antwortet auf :${https_port} (HTTP $hcode)" \
                                          || skip "HTTPS-UI :${https_port} (Code ${hcode:-000})"

# Telemetry/Schema MIT RETRY (T-0118): die App populiert die Migrationen ASYNC
# nach service-active — ein single-shot Check rast auf der kalten ersten Zelle
# vor der Tabellen-Erzeugung (LXC-base-FAIL im Tier-3-Lauf). Dieselbe Retry-
# Schleife wie der HTTP-Check → deterministisch. PostgreSQL (App-Default wenn
# konfiguriert) ODER SQLite (Fallback) zählt.
schema_ok=0; schema_detail=""
for _ in $(seq 1 "$HEALTH_RETRIES"); do
  # PostgreSQL zuerst (auf diesen Hosts der aktive Store: 12 Tabellen)
  tbls="$(su - postgres -c "psql -d dvhub -tAc \"SELECT count(*) FROM information_schema.tables WHERE table_schema='public'\"" 2>/dev/null | tr -d '[:space:]')"
  if [[ "${tbls:-0}" =~ ^[0-9]+$ ]] && (( tbls > 0 )); then schema_ok=1; schema_detail="PostgreSQL dvhub (${tbls} Tabellen)"; break; fi
  # SQLite-Fallback (wenn die App keinen PG-Store nutzt)
  sqlite_db="$(find "$DATA_DIR" "$INSTALL_DIR" -maxdepth 4 -type f \( -name '*.sqlite' -o -name '*.sqlite3' -o -name '*.db' \) -size +0c 2>/dev/null | head -1)"
  if [[ -n "$sqlite_db" ]]; then
    if command -v sqlite3 >/dev/null 2>&1; then
      n="$(sqlite3 "$sqlite_db" "SELECT count(*) FROM sqlite_master WHERE type='table'" 2>/dev/null)"
      if [[ "${n:-0}" =~ ^[0-9]+$ ]] && (( n > 0 )); then schema_ok=1; schema_detail="SQLite ${sqlite_db} (${n} Tabellen)"; break; fi
    else
      schema_ok=1; schema_detail="SQLite ${sqlite_db} (vorhanden; sqlite3 fuer Count fehlt)"; break
    fi
  fi
  sleep 1
done
[[ $schema_ok -eq 1 ]] && ok "Schema/Migrationen angewendet: ${schema_detail}" \
                       || bad "Schema/Migrationen: keine populierte DB nach ${HEALTH_RETRIES}s (PG dvhub / SQLite unter $DATA_DIR/$INSTALL_DIR)"

# T-23-04: ECHTE Migrations-Versionsprüfung gegen schema_migrations.
# Der count(*)-Check oben ist NUR eine Liveness-Probe — er ist FALSCH-GRÜN, wenn
# der Migrations-Runner crasht: ensurePgSchema() (server.js:509) legt die
# Basistabellen VOR dem Runner (server.js:514) an, also ist
# count(information_schema.tables)>0 auch bei halb-migrierter, dunkler DB grün.
# Der maßgebliche Schema-Beweis ist daher die Versionsprüfung. 015-020 sind HART
# gefordert (fehlt eine → ROT). 014 (TimescaleDB) ist BEDINGT: eine korrekte
# timescaledb-LOSE Box überspringt 014 legitim → 14 fehlt dort erwartbar in
# schema_migrations und darf den Test NIE rot machen (nur optionale Info).
expected="15 16 17 18 19 20"
missing=""
for v in $expected; do
  has="$(su - postgres -c "psql -d dvhub -tAc \"SELECT 1 FROM schema_migrations WHERE version=$v\"" 2>/dev/null | tr -d '[:space:]')"
  [[ "$has" == "1" ]] || missing="$missing $v"
done
if [[ -z "$missing" ]]; then
  ok "schema_migrations vollständig (Versionen:$expected angewendet)"
else
  bad "schema_migrations UNVOLLSTÄNDIG — fehlende Versionen:$missing (Migration crashte? halb-migrierte/dunkle DB)"
fi
# 014 (TimescaleDB) BEDINGT — reine Info, NIE über bad erzwingen (Pitfall 3):
ts14="$(su - postgres -c "psql -d dvhub -tAc \"SELECT 1 FROM schema_migrations WHERE version=14\"" 2>/dev/null | tr -d '[:space:]')"
[[ "$ts14" == "1" ]] && ok "schema_migrations: 014 (TimescaleDB) angewendet (optional)" \
                     || skip "schema_migrations: 014 (TimescaleDB) übersprungen — auf timescaledb-loser Box erwartbar (optional)"

# ============================================================================
section "EOS (optional, --with-eos)"
# ============================================================================
if [[ $WITH_EOS -eq 1 ]]; then
  check "EOS-Service aktiv" systemctl is-active --quiet eos.service
  eos_ok=0
  for _ in $(seq 1 "$HEALTH_RETRIES"); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${EOS_PORT}/v1/health" 2>/dev/null || echo 000)"
    [[ "$code" == "200" ]] && { eos_ok=1; break; }
    sleep 1
  done
  [[ $eos_ok -eq 1 ]] && ok "EOS /v1/health antwortet (:$EOS_PORT)" \
                      || bad "EOS /v1/health antwortet (:$EOS_PORT, letzter Code: ${code:-000})"
else
  skip "EOS-Checks (ohne --with-eos)"
fi

# ============================================================================
section "Ergebnis"
# ============================================================================
echo "  PASS=$PASS  FAIL=$FAIL  SKIP=$SKIP"
if (( FAIL > 0 )); then
  echo "${red}DEPLOY-TEST FEHLGESCHLAGEN — $FAIL Check(s) fehlerhaft.${rst}"
  exit 1
fi
echo "${green}DEPLOY-TEST BESTANDEN — die Software deployt sauber auf diesem frischen System.${rst}"
exit 0
