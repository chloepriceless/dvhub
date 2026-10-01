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
# Idempotent; alles per Reload wirksam (kein Neustart). Aufruf aus install.sh
# und post-update.sh, als root. Abschalten: DVHUB_PG_WRITE_TUNING=0.
set -euo pipefail
[[ "${DVHUB_PG_WRITE_TUNING:-1}" == "0" ]] && { echo "  PostgreSQL: Schreib-Tuning abgeschaltet"; exit 0; }
[[ "${EUID}" -eq 0 ]] || { echo "  PostgreSQL: pg-write-tuning.sh braucht root — übersprungen" >&2; exit 0; }
CONF_DIR="$(find /etc/postgresql -mindepth 3 -maxdepth 3 -type d -name conf.d 2>/dev/null | sort -V | tail -1)"
[[ -n "$CONF_DIR" ]] || { echo "  PostgreSQL: kein conf.d gefunden — übersprungen"; exit 0; }
DROPIN="$CONF_DIR/dvhub-writes.conf"
WANT="# DVhub: schreibarm (pg-write-tuning.sh). Nicht von Hand ändern — wird überschrieben.
synchronous_commit = off
wal_writer_delay = 1s
checkpoint_timeout = 15min
wal_compression = on
"
if [[ -f "$DROPIN" ]] && [[ "$(cat "$DROPIN")" == "$(printf '%s' "$WANT")" ]]; then
  echo "  PostgreSQL: Schreib-Tuning aktuell"
  exit 0
fi
printf '%s' "$WANT" > "$DROPIN"
chmod 644 "$DROPIN"
systemctl reload postgresql 2>/dev/null || systemctl reload 'postgresql@*' 2>/dev/null || true
echo "  PostgreSQL: Schreib-Tuning gesetzt ($DROPIN)"
