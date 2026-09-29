#!/bin/sh
# Erststart der DB (läuft nur bei leerem Datenverzeichnis, als postgres):
# App-Rolle + DB + TimescaleDB anlegen — wie install.sh/timescale-provision.sh
# auf der nativen Appliance. dvhub ist bewusst KEIN Superuser (der DB-Restore
# sperrt die App per CONNECTION LIMIT 0 aus; das wirkt nur auf Nicht-Superuser).
set -eu
: "${DVHUB_DB_PASSWORD:?DVHUB_DB_PASSWORD fehlt}"

psql -v ON_ERROR_STOP=1 --username postgres --dbname postgres -v pw="$DVHUB_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE dvhub LOGIN PASSWORD %L', :'pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dvhub') \gexec
SELECT 'CREATE DATABASE dvhub OWNER dvhub'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'dvhub') \gexec
SQL

psql -v ON_ERROR_STOP=1 --username postgres --dbname dvhub <<'SQL'
CREATE EXTENSION IF NOT EXISTS timescaledb;
SQL

echo "[db-init] Rolle dvhub, DB dvhub und TimescaleDB angelegt"
