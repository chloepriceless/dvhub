#!/usr/bin/env bash
# scripts/ci/timescale-native-e2e.sh — Nachrüstung der TimescaleDB auf einer
# NATIVEN Box, echt: Ubuntu 26.04, PostgreSQL 18, Ubuntus Apache-Paket
# (postgresql-18-timescaledb) und Timescales Community-Paket von packagecloud.
#
# Anlass 21.10.2026 (Feldbox 9753e9e5): Nach dem Wechsel Apache 2.25.1 →
# Community fehlte die Bibliothek zur Katalog-Version; jede Sitzung scheiterte
# an der ersten Anweisung, spätere Schreibvorgänge landeten unsichtbar in der
# Elterntabelle der Hypertable, und danach fehlte die Kompression.
#
# Läuft als root in einem frischen ubuntu:26.04-Container, das Repo unter
# /opt/dvhub (mit dvhub/node_modules). Szenarien:
#   broken  — Paket schon gewechselt, Erweiterung noch alt (Feldbox-Zustand),
#             dazu Schreibvorgänge im kaputten Zustand
#   apache  — Apache-Box mit der alten, falschen Quelle debian/ resolute:
#             Wechsel und Reparatur in einem Lauf
#   fresh   — PostgreSQL ohne TimescaleDB (Neuinstallation)
#
#   docker run --rm -v "$PWD:/opt/dvhub" ubuntu:26.04 \
#     bash /opt/dvhub/scripts/ci/timescale-native-e2e.sh broken
set -euo pipefail

SCENARIO="${1:?Szenario: broken | apache | fresh}"
INSTALL_DIR=/opt/dvhub
DATA_DIR=/var/lib/dvhub
CONFIG_PATH=/etc/dvhub/config.json
PG_VER=18
FAIL=0

say()  { printf '\n== %s\n' "$*"; }
ok()   { printf '   ok    %s\n' "$*"; }
bad()  { printf '   FEHLER %s\n' "$*"; FAIL=1; }
expect() { # expect <beschreibung> <ist> <soll>
  if [[ "$2" == "$3" ]]; then ok "$1: $2"; else bad "$1: ist '$2', soll '$3'"; fi
}
sql()    { runuser -u postgres -- psql -X -tAq -d dvhub -c "$1" 2>/dev/null | tr -d '[:space:]'; }
# Katalog lesen, ohne dass der Loader die (evtl. fehlende) Bibliothek lädt.
sql_noload() { runuser -u postgres -- psql -X -tAq "dbname=dvhub options='-c timescaledb.disable_load=on'" -c "$1" 2>/dev/null | tr -d '[:space:]'; }

node_dvhub() { # führt ESM-Code mit pg-Pool `pool` (als postgres über den Socket) aus
  runuser -u postgres -- node --input-type=module -e "
    import pg from '${INSTALL_DIR}/dvhub/node_modules/pg/lib/index.js';
    import { ensurePgSchema, runPendingMigrations, createTelemetryStorePg } from '${INSTALL_DIR}/dvhub/telemetry-store-pg.js';
    import { tuneTimescale } from '${INSTALL_DIR}/dvhub/services/db-tuning.js';
    const pool = new pg.Pool({ host: '/var/run/postgresql', database: 'dvhub', user: 'postgres' });
    const cfg = { telemetry: { database: { timescaledb: true } } };
    try { $1 } finally { await pool.end(); }
  " 2> >(grep -v '^\[migration\]' >&2) | grep -v '^\[migration\]'
}

say "Pakete (Ubuntu 26.04, PG ${PG_VER})"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
PKGS="postgresql-${PG_VER} nodejs curl gnupg ca-certificates"
[[ "$SCENARIO" != fresh ]] && PKGS="$PKGS postgresql-${PG_VER}-timescaledb"
apt-get install -y -qq $PKGS >/dev/null
node --version

# Kein systemd im Container: systemctl für postgresql auf pg_ctlcluster abbilden.
cat > /usr/local/bin/systemctl <<EOF
#!/bin/bash
last="\${@: -1}"
case "\$1" in
  restart) [[ "\$last" == postgresql* ]] && exec pg_ctlcluster ${PG_VER} main restart ;;
  enable|start) [[ "\$last" == postgresql* ]] && { pg_ctlcluster ${PG_VER} main start 2>/dev/null || true; exit 0; } ;;
  is-active) exit 3 ;;
esac
exit 0
EOF
chmod 755 /usr/local/bin/systemctl
pg_ctlcluster "$PG_VER" main start
mkdir -p "$DATA_DIR" /etc/dvhub
echo '{"telemetry":{"enabled":true,"database":{"name":"dvhub"}}}' > "$CONFIG_PATH"
id dvhub >/dev/null 2>&1 || useradd -r dvhub
runuser -u postgres -- psql -X -q -c 'CREATE DATABASE dvhub'

if [[ "$SCENARIO" != fresh ]]; then
  say "Ausgangslage: Apache-TimescaleDB mit DVhub-Schema (echte Migrationen)"
  echo "shared_preload_libraries = 'timescaledb'" > "/etc/postgresql/${PG_VER}/main/conf.d/timescaledb.conf"
  pg_ctlcluster "$PG_VER" main restart
  sql "CREATE EXTENSION timescaledb" >/dev/null || true
  expect "Lizenz vorher" "$(sql "SELECT current_setting('timescaledb.license')")" apache
  APACHE_VER="$(sql "SELECT extversion FROM pg_extension WHERE extname='timescaledb'")"
  # Migrationen wie im Betrieb (014 nur Hypertable). Unter Apache darf keine scheitern.
  MIG="$(node_dvhub "await ensurePgSchema(pool); const m = await runPendingMigrations(pool, cfg); console.log(JSON.stringify({ failed: m.failed.map((f) => f.file + ': ' + f.error), missing: m.missing }));
    const end = Math.floor(Date.now() / 3600e3) * 3600e3 - 3600e3; const rows = [];
    for (let t = end - 10 * 86400e3; t <= end; t += 3600e3) rows.push({ seriesKey: 'grid_total_w', source: 'victron', ts: new Date(t), resolutionSeconds: 5, value: 1 });
    await createTelemetryStorePg(pool).writeSamples(rows);")"
  expect "Migrationen unter Apache" "$MIG" '{"failed":[],"missing":[]}'
  SEEDED="$(sql "SELECT count(*) FROM timeseries_samples")"
  echo "   Apache ${APACHE_VER}, ${SEEDED} Messwerte"
fi

if [[ "$SCENARIO" == broken ]]; then
  say "Paketwechsel ohne ALTER EXTENSION (Stand der Feldbox)"
  curl -fsSL https://packagecloud.io/timescale/timescaledb/gpgkey | gpg --dearmor -o /usr/share/keyrings/timescale.gpg
  echo "deb [signed-by=/usr/share/keyrings/timescale.gpg] https://packagecloud.io/timescale/timescaledb/ubuntu/ resolute main" \
    > /etc/apt/sources.list.d/timescaledb.list
  apt-get update -qq >/dev/null
  apt-get remove -y -qq "postgresql-${PG_VER}-timescaledb" >/dev/null
  apt-get install -y -qq "timescaledb-2-loader-postgresql-${PG_VER}" "timescaledb-2-postgresql-${PG_VER}" >/dev/null
  pg_ctlcluster "$PG_VER" main restart
  if runuser -u postgres -- psql -X -tAq -d dvhub -c 'SELECT 1' >/dev/null 2>&1; then
    bad "Voraussetzung: erste Anweisung müsste an der fehlenden Bibliothek scheitern"
  else
    ok "erste Anweisung scheitert (Bibliothek ${APACHE_VER} fehlt)"
  fi
  # Schreiben im kaputten Zustand: nach der gescheiterten ersten Anweisung laufen
  # die folgenden ohne Timescale und landen in der Elterntabelle.
  runuser -u postgres -- psql -X -q -d dvhub >/dev/null 2>&1 <<'SQL' || true
SELECT 1;
INSERT INTO timeseries_samples (series_key, scope, source, quality, ts_utc, resolution_seconds, value_num)
  SELECT 'grid_total_w', 'live', 'victron', 'raw', t, 5, 3
  FROM generate_series(date_trunc('hour', now()) + interval '1 hour', date_trunc('hour', now()) + interval '5 hours', interval '1 hour') t;
SQL
  ROOT="$(sql_noload "SELECT count(*) FROM ONLY timeseries_samples")"
  expect "Zeilen in der Elterntabelle" "$ROOT" 5
  [[ "$(DB_NAME=dvhub bash "$INSTALL_DIR/timescale-provision.sh" --check 2>/dev/null)" != timescale ]] \
    && ok "--check meldet den kaputten Zustand" || bad "--check meldet 'timescale' trotz kaputtem Zustand"
fi

if [[ "$SCENARIO" == apache ]]; then
  say "Alte, falsche Quelle debian/ resolute (früherer Installer)"
  curl -fsSL https://packagecloud.io/timescale/timescaledb/gpgkey | gpg --dearmor -o /usr/share/keyrings/timescale.gpg
  echo "deb [signed-by=/usr/share/keyrings/timescale.gpg] https://packagecloud.io/timescale/timescaledb/debian/ resolute main" \
    > /etc/apt/sources.list.d/timescaledb.list
fi

if [[ "$SCENARIO" == fresh ]]; then
  say "Ausgangslage: PostgreSQL ohne TimescaleDB, DVhub-Schema"
  MIG="$(node_dvhub "await ensurePgSchema(pool); const m = await runPendingMigrations(pool, {}); console.log(JSON.stringify({ failed: m.failed.map((f) => f.file) }));")"
  expect "Migrationen ohne TimescaleDB" "$MIG" '{"failed":[]}'
fi

say "timescale-provision.sh (Nachrüstung)"
set +e
INSTALL_DIR="$INSTALL_DIR" DATA_DIR="$DATA_DIR" CONFIG_PATH="$CONFIG_PATH" DB_NAME=dvhub bash "$INSTALL_DIR/timescale-provision.sh"
RC=$?
set -e
expect "Exit-Code" "$RC" 0

say "Ergebnis"
expect "Lizenz" "$(sql "SELECT current_setting('timescaledb.license')")" timescale
EXT="$(sql "SELECT extversion FROM pg_extension WHERE extname='timescaledb'")"
expect "Erweiterung = installierte Bibliothek" "$EXT" "$(sql "SELECT default_version FROM pg_available_extensions WHERE name='timescaledb'")"
expect "--check" "$(DB_NAME=dvhub bash "$INSTALL_DIR/timescale-provision.sh" --check 2>/dev/null)" timescale
expect "Config timescaledb" "$(node -p "require('$CONFIG_PATH').telemetry.database.timescaledb")" true
if [[ "$SCENARIO" != fresh ]]; then
  expect "Elterntabelle leer" "$(sql_noload "SELECT count(*) FROM ONLY timeseries_samples")" 0
  expect "keine Rettungstabellen" "$(sql "SELECT count(*) FROM pg_class WHERE relname LIKE 'dvhub!_ts!_rescue!_%' ESCAPE '!'")" 0
  WANT="$SEEDED"; [[ "$SCENARIO" == broken ]] && WANT=$((SEEDED + 5))
  expect "Messwerte vollständig" "$(sql "SELECT count(*) FROM timeseries_samples")" "$WANT"
  if [[ "$SCENARIO" == broken ]]; then
    expect "gerettete Zeilen sichtbar" "$(sql "SELECT count(*) FROM timeseries_samples WHERE value_num = 3")" 5
  fi
fi
if [[ -f "$DATA_DIR/timescale-status.json" ]]; then
  expect "Status-Datei: Nachrüstung" "$(node -p "require('$DATA_DIR/timescale-status.json').provision?.result")" ok
fi

say "DVhub-Start danach: Migrationen + tuneTimescale"
START="$(node_dvhub "await ensurePgSchema(pool); const m = await runPendingMigrations(pool, cfg);
  const t1 = await tuneTimescale((q, p) => pool.query(q, p)); const t2 = await tuneTimescale((q, p) => pool.query(q, p));
  const c = await pool.query(\"SELECT compression_enabled AS on FROM timescaledb_information.hypertables WHERE hypertable_name = 'timeseries_samples'\");
  console.log(JSON.stringify({ failed: m.failed.map((f) => f.file), compression: c.rows[0]?.on, t1skip: t1.skipped || null, t1def: t1.deferred || null, t2: t2.changed }));")"
expect "Start nach der Nachrüstung" "$START" '{"failed":[],"compression":true,"t1skip":null,"t1def":null,"t2":[]}'

say "Zweiter Lauf (idempotent)"
set +e
INSTALL_DIR="$INSTALL_DIR" DATA_DIR="$DATA_DIR" CONFIG_PATH="$CONFIG_PATH" DB_NAME=dvhub bash "$INSTALL_DIR/timescale-provision.sh" >/dev/null
RC=$?
set -e
expect "Exit-Code zweiter Lauf" "$RC" 0
expect "--check zweiter Lauf" "$(DB_NAME=dvhub bash "$INSTALL_DIR/timescale-provision.sh" --check 2>/dev/null)" timescale

if [[ "$FAIL" -ne 0 ]]; then
  say "Protokoll ($DATA_DIR/timescale-provision.log, Ende)"
  tail -40 "$DATA_DIR/timescale-provision.log" 2>/dev/null || true
  echo; echo "SZENARIO ${SCENARIO}: FEHLGESCHLAGEN"; exit 1
fi
echo; echo "SZENARIO ${SCENARIO}: bestanden"
