#!/usr/bin/env bash
# pg-write-tuning.sh -- PostgreSQL schreibarm einstellen (SD-Karten, eMMC).
#
# Christin 2026-10-01: auf prod schrieb PostgreSQL ~5,7 MB/min (≈ 8 GB/Tag),
# fast nur WAL: jeder Commit ein fsync, alle 5 min ein Checkpoint mit
# Full-Page-Writes. DVhub-Daten sind Messwerte und Protokolle — geht beim
# Stromausfall die letzte Sekunde verloren, ist das verschmerzbar; die
# Datenbank selbst bleibt konsistent (synchronous_commit=off verliert nur
# die jüngsten Commits, nie die Integrität).
#
#   synchronous_commit = off      Commit wartet nicht auf fsync; WAL-Writer
#                                 schreibt gesammelt alle wal_writer_delay
#   wal_writer_delay = 1s
#   checkpoint_timeout = 15min    seltener Checkpoints → weniger Full-Page-Writes
#   wal_compression = on          Full-Page-Writes komprimiert
#
# Dazu ein KLEINER Speicher-Footprint für jede Box (Christin 2026-10-01: auch
# große Boxen nicht hochskalieren) — gleiche Werte wie services/db-tuning.js:
#   „klein“  shared_buffers 64MB, work_mem 2MB, maintenance_work_mem 16MB, …
#   „winzig“ (DB-Budget = 25 % RAM < 192 MB, also Boards unter ~768 MB RAM)
#            shared_buffers 32MB, 1 Autovacuum-Worker, …
# shared_buffers & Worker-Zahlen wirken erst nach einem PostgreSQL-Neustart —
# der passiert hier genau einmal, wenn sich einer dieser Werte ändert.
#
# Idempotent; alles per Reload wirksam (kein Neustart). Aufruf aus install.sh
# und post-update.sh, als root. Abschalten: DVHUB_PG_WRITE_TUNING=0.
set -euo pipefail
[[ "${DVHUB_PG_WRITE_TUNING:-1}" == "0" ]] && { echo "  PostgreSQL: Schreib-Tuning abgeschaltet"; exit 0; }
[[ "${EUID}" -eq 0 ]] || { echo "  PostgreSQL: pg-write-tuning.sh braucht root — übersprungen" >&2; exit 0; }
CONF_DIR="$(find /etc/postgresql -mindepth 3 -maxdepth 3 -type d -name conf.d 2>/dev/null | sort -V | tail -1)"
[[ -n "$CONF_DIR" ]] || { echo "  PostgreSQL: kein conf.d gefunden — übersprungen"; exit 0; }
DROPIN="$CONF_DIR/dvhub-writes.conf"
MEM_KB="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
BUDGET_MB=$(( MEM_KB / 1024 / 4 ))
if (( BUDGET_MB > 0 && BUDGET_MB < 192 )); then
  PROFILE="winzig"; SB=32MB; WM=1MB; ECS=64MB; MC=15; MWP=6; AVW=1; TSW=2
else
  PROFILE="klein";  SB=64MB; WM=2MB; ECS=128MB; MC=20; MWP=8; AVW=2; TSW=4
fi
WANT="# DVhub: schreibarm + kleiner Speicher-Footprint (pg-write-tuning.sh, Profil $PROFILE).
# Nicht von Hand ändern — wird bei jedem Update überschrieben.
synchronous_commit = off
wal_writer_delay = 1s
checkpoint_timeout = 15min
wal_compression = on
shared_buffers = $SB
work_mem = $WM
maintenance_work_mem = 16MB
effective_cache_size = $ECS
max_connections = $MC
max_worker_processes = $MWP
autovacuum_max_workers = $AVW
max_parallel_workers_per_gather = 0
max_parallel_maintenance_workers = 0
timescaledb.max_background_workers = $TSW
"
if [[ -f "$DROPIN" ]] && [[ "$(cat "$DROPIN")" == "$(printf '%s' "$WANT")" ]]; then
  echo "  PostgreSQL: Schreib-Tuning aktuell"
  exit 0
fi
restart_keys='^(shared_buffers|max_connections|max_worker_processes|autovacuum_max_workers|timescaledb.max_background_workers) '
old_restart="$(grep -E "$restart_keys" "$DROPIN" 2>/dev/null || true)"
printf '%s' "$WANT" > "$DROPIN"
chmod 644 "$DROPIN"
new_restart="$(grep -E "$restart_keys" "$DROPIN")"
# timescaledb.* ist ohne geladene Extension ein unbekannter Schlüssel — dann weglassen.
if ! grep -rqs "timescaledb" "$CONF_DIR"/timescaledb.conf 2>/dev/null; then
  sed -i '/^timescaledb\./d' "$DROPIN"
fi
if [[ "$old_restart" != "$new_restart" ]]; then
  systemctl restart postgresql 2>/dev/null || true
  echo "  PostgreSQL: Profil $PROFILE gesetzt, neu gestartet ($DROPIN)"
else
  systemctl reload postgresql 2>/dev/null || systemctl reload 'postgresql@*' 2>/dev/null || true
  echo "  PostgreSQL: Profil $PROFILE gesetzt ($DROPIN)"
fi
