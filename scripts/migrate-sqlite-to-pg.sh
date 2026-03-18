#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# DVhub SQLite → PostgreSQL + TimescaleDB Migration
#
# Usage:
#   bash scripts/migrate-sqlite-to-pg.sh [options]
#
# Options:
#   --sqlite-path PATH    Path to telemetry.sqlite (default: /var/lib/dvhub/telemetry.sqlite)
#   --pg-database NAME    PostgreSQL database name (default: dvhub)
#   --pg-user USER        PostgreSQL user (default: dvhub)
#   --pg-host HOST        PostgreSQL host (default: localhost)
#   --pg-port PORT        PostgreSQL port (default: 5432)
#   --skip-backup         Skip SQLite backup step
#   --migrations-only     Only run PostgreSQL migrations, skip data transfer
#   --help                Show this help
# ============================================================

SQLITE_PATH="/var/lib/dvhub/telemetry.sqlite"
PG_DATABASE="dvhub"
PG_USER="dvhub"
PG_HOST="localhost"
PG_PORT="5432"
SKIP_BACKUP=false
MIGRATIONS_ONLY=false
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
MIGRATIONS_DIR="$REPO_DIR/db/postgres/migrations"

while [[ $# -gt 0 ]]; do
  case $1 in
    --sqlite-path) SQLITE_PATH="$2"; shift 2 ;;
    --pg-database) PG_DATABASE="$2"; shift 2 ;;
    --pg-user) PG_USER="$2"; shift 2 ;;
    --pg-host) PG_HOST="$2"; shift 2 ;;
    --pg-port) PG_PORT="$2"; shift 2 ;;
    --skip-backup) SKIP_BACKUP=true; shift ;;
    --migrations-only) MIGRATIONS_ONLY=true; shift ;;
    --help) head -20 "$0" | tail -15; exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

PG_CONN="postgresql://${PG_USER}@${PG_HOST}:${PG_PORT}/${PG_DATABASE}"
BACKUP_SUFFIX="backup-$(date +%Y%m%d-%H%M%S)"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

log() { echo "[$(date +%H:%M:%S)] $*"; }
err() { echo "[$(date +%H:%M:%S)] ERROR: $*" >&2; }

# -----------------------------------------------------------
# Step 1: Pre-flight checks
# -----------------------------------------------------------
log "=== DVhub SQLite → PostgreSQL Migration ==="
log ""

# Check PostgreSQL
if ! command -v psql &>/dev/null; then
  err "psql not found. Please install PostgreSQL first."
  echo ""
  echo "  Debian/Ubuntu:  sudo apt install postgresql postgresql-client"
  echo "  macOS (brew):   brew install postgresql@16"
  echo "  RHEL/Rocky:     sudo dnf install postgresql-server postgresql"
  echo ""
  echo "  TimescaleDB:    https://docs.timescale.com/self-hosted/latest/install/"
  exit 1
fi
log "PostgreSQL client found: $(psql --version | head -1)"

# Check SQLite
if ! command -v sqlite3 &>/dev/null; then
  err "sqlite3 not found. Please install sqlite3."
  exit 1
fi

# Check source database
if [[ ! -f "$SQLITE_PATH" ]]; then
  log "SQLite database not found at: $SQLITE_PATH"
  if $MIGRATIONS_ONLY; then
    log "Proceeding with --migrations-only (no data to transfer)"
  else
    err "Cannot migrate without source database. Use --sqlite-path or --migrations-only"
    exit 1
  fi
else
  SQLITE_SIZE=$(du -h "$SQLITE_PATH" | cut -f1)
  log "SQLite source: $SQLITE_PATH ($SQLITE_SIZE)"
fi

# -----------------------------------------------------------
# Step 2: Backup SQLite
# -----------------------------------------------------------
if [[ -f "$SQLITE_PATH" ]] && ! $SKIP_BACKUP; then
  BACKUP_PATH="${SQLITE_PATH}.${BACKUP_SUFFIX}"
  log "Creating backup: $BACKUP_PATH"
  cp "$SQLITE_PATH" "$BACKUP_PATH"
  log "Backup created successfully ($(du -h "$BACKUP_PATH" | cut -f1))"
  echo ""
  echo "  To restore:  cp '$BACKUP_PATH' '$SQLITE_PATH'"
  echo ""
else
  log "Skipping backup (--skip-backup or no source file)"
fi

# -----------------------------------------------------------
# Step 3: Check/create PostgreSQL database
# -----------------------------------------------------------
log "Checking PostgreSQL connection..."

if ! psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE" -c "SELECT 1" &>/dev/null 2>&1; then
  log "Database '$PG_DATABASE' not accessible. Attempting to create..."

  if psql -h "$PG_HOST" -p "$PG_PORT" -U postgres -c "SELECT 1" &>/dev/null 2>&1; then
    # Create user if needed
    psql -h "$PG_HOST" -p "$PG_PORT" -U postgres -tc "SELECT 1 FROM pg_roles WHERE rolname='$PG_USER'" | grep -q 1 || \
      psql -h "$PG_HOST" -p "$PG_PORT" -U postgres -c "CREATE USER $PG_USER WITH PASSWORD '$PG_USER';"
    # Create database
    psql -h "$PG_HOST" -p "$PG_PORT" -U postgres -tc "SELECT 1 FROM pg_database WHERE datname='$PG_DATABASE'" | grep -q 1 || \
      psql -h "$PG_HOST" -p "$PG_PORT" -U postgres -c "CREATE DATABASE $PG_DATABASE OWNER $PG_USER;"
    psql -h "$PG_HOST" -p "$PG_PORT" -U postgres -d "$PG_DATABASE" -c "GRANT ALL ON DATABASE $PG_DATABASE TO $PG_USER;"
    log "Database '$PG_DATABASE' created with user '$PG_USER'"
  else
    err "Cannot connect as postgres superuser. Please create the database manually:"
    echo ""
    echo "  sudo -u postgres createuser $PG_USER"
    echo "  sudo -u postgres createdb -O $PG_USER $PG_DATABASE"
    echo ""
    exit 1
  fi
fi

log "PostgreSQL connection OK: $PG_HOST:$PG_PORT/$PG_DATABASE"

# Check TimescaleDB
if ! psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE" -tc "SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb'" | grep -q 1; then
  err "TimescaleDB extension not available. Please install TimescaleDB first."
  echo ""
  echo "  Installation:  https://docs.timescale.com/self-hosted/latest/install/"
  echo ""
  echo "  After installing, add to postgresql.conf:"
  echo "    shared_preload_libraries = 'timescaledb'"
  echo "  Then restart PostgreSQL."
  exit 1
fi
log "TimescaleDB extension available"

# -----------------------------------------------------------
# Step 4: Run PostgreSQL migrations
# -----------------------------------------------------------
log "Running migrations..."

for migration in "$MIGRATIONS_DIR"/0*.sql; do
  migration_name=$(basename "$migration")
  log "  Applying: $migration_name"
  psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE" \
    -v ON_ERROR_STOP=1 -f "$migration" 2>&1 | grep -v "^$" | sed 's/^/    /'
done

log "All migrations applied"

# -----------------------------------------------------------
# Step 5: Export SQLite data and import into PostgreSQL
# -----------------------------------------------------------
if [[ -f "$SQLITE_PATH" ]] && ! $MIGRATIONS_ONLY; then
  log "Exporting data from SQLite..."

  TABLES=(
    "timeseries_samples"
    "energy_slots_15m"
    "control_events"
    "schedule_snapshots"
    "optimizer_runs"
    "optimizer_run_series"
    "import_jobs"
    "data_gaps"
    "solar_market_values"
    "solar_market_value_year_attempts"
  )

  for table in "${TABLES[@]}"; do
    ROW_COUNT=$(sqlite3 "$SQLITE_PATH" "SELECT COUNT(*) FROM $table;" 2>/dev/null || echo "0")

    if [[ "$ROW_COUNT" == "0" ]]; then
      log "  $table: 0 rows (skipping)"
      continue
    fi

    log "  $table: exporting $ROW_COUNT rows..."
    CSV_FILE="$TMP_DIR/${table}.csv"

    # Export with headers
    sqlite3 -header -csv "$SQLITE_PATH" "SELECT * FROM $table;" > "$CSV_FILE"

    # Import into PostgreSQL (skip id column — let PG generate it)
    COLUMNS=$(head -1 "$CSV_FILE" | sed 's/^id,//' | sed 's/^id$//')

    if [[ -n "$COLUMNS" ]]; then
      # Remove id column from data too
      tail -n +2 "$CSV_FILE" | cut -d',' -f2- > "$TMP_DIR/${table}_data.csv"

      psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE" \
        -c "\COPY $table($COLUMNS) FROM '$TMP_DIR/${table}_data.csv' CSV" 2>&1 | sed 's/^/    /'
    fi

    PG_COUNT=$(psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE" \
      -t -c "SELECT COUNT(*) FROM $table;" | tr -d ' ')
    log "  $table: $PG_COUNT rows in PostgreSQL (was $ROW_COUNT in SQLite)"
  done
fi

# -----------------------------------------------------------
# Step 6: Summary
# -----------------------------------------------------------
echo ""
log "=== Migration Complete ==="
echo ""
echo "  PostgreSQL: $PG_HOST:$PG_PORT/$PG_DATABASE"
if [[ -f "$SQLITE_PATH" ]] && ! $SKIP_BACKUP; then
  echo "  Backup:     ${SQLITE_PATH}.${BACKUP_SUFFIX}"
fi
echo ""
echo "  Next steps:"
echo "    1. Update DVhub config.json with database connection:"
echo "       \"telemetry\": {"
echo "         \"enabled\": true,"
echo "         \"database\": {"
echo "           \"host\": \"$PG_HOST\","
echo "           \"port\": $PG_PORT,"
echo "           \"name\": \"$PG_DATABASE\","
echo "           \"user\": \"$PG_USER\","
echo "           \"password\": \"YOUR_PASSWORD\""
echo "         }"
echo "       }"
echo ""
echo "    2. Restart DVhub:"
echo "       sudo systemctl restart dvhub"
echo ""
echo "    3. Verify data in PostgreSQL:"
echo "       psql -U $PG_USER -d $PG_DATABASE -c 'SELECT COUNT(*) FROM timeseries_samples;'"
echo ""
