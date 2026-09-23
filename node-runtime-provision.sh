#!/usr/bin/env bash
# node-runtime-provision.sh — Port-Recht und Speicherverwalter fuer den DVhub-Dienst.
#
# Warum (Messung 2026-09-23, Pi-Testbox): der JS-Heap von DVhub ist ~40 MB, der
# Prozess belegt trotzdem 250–500 MB. Den Rest haelt glibc-malloc als bereits
# freigegebenen, aber nicht zurueckgegebenen Speicher. jemalloc gibt ihn zurueck:
# 242 → 127 MB nach dem Start. Das ging bisher nicht, weil node per `setcap`
# das Recht fuer Port 80/443/502 als DATEI-Capability traegt — damit laeuft
# jeder node-Prozess im "secure mode", und glibc verwirft LD_PRELOAD und alle
# MALLOC_*-Variablen.
#
# Deshalb:
#   * Port-Recht ueber systemd (AmbientCapabilities) statt an der node-Datei,
#   * jemalloc per LD_PRELOAD, wenn libjemalloc2 da ist (sonst glibc wie bisher),
#   * Opt-out: $DATA_DIR/.no-jemalloc.
#
# Umstieg in zwei Starts, damit DVhub nie ohne Port-Recht startet: dieses Skript
# laeuft als ExecStartPre, also WAEHREND eines Starts. Ein daemon-reload wirkt
# erst beim naechsten Start. Das Datei-Recht wird darum nur entfernt, wenn systemd
# die Port-Berechtigung schon VOR diesem Lauf geladen hatte; sonst bleibt es fuer
# diesen einen Start noch stehen. install.sh ruft mit NODE_RUNTIME_FRESH=1 auf:
# dort startet der Dienst erst danach, beides wirkt sofort.
#
# Idempotent und nie fatal. Alle Pfade/Kommandos per Umgebung ueberschreibbar
# (Tests: test/node-runtime-provision.test.js).
set -uo pipefail

SERVICE_NAME="${SERVICE_NAME:-dvhub}"
DATA_DIR="${DATA_DIR:-/var/lib/dvhub}"
DROPIN_DIR="${DROPIN_DIR:-/etc/systemd/system/${SERVICE_NAME}.service.d}"
DROPIN="${DROPIN_DIR}/10-node-runtime.conf"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
SETCAP="${SETCAP:-setcap}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
JEMALLOC_CANDIDATES="${JEMALLOC_CANDIDATES:-/usr/lib/*/libjemalloc.so.2 /usr/lib/libjemalloc.so.2 /usr/lib64/libjemalloc.so.2}"
# background_thread: Rueckgabe laeuft in einem eigenen Thread, nicht nur bei
# der naechsten Allokation. dirty_decay 1 s: freie Seiten gehen nach einer
# Sekunde ans System zurueck (Messung: nach Historien-Last 227 → 129 MB in 60 s).
MALLOC_CONF_VALUE="${MALLOC_CONF_VALUE:-background_thread:true,dirty_decay_ms:1000,muzzy_decay_ms:0}"

# Hatte systemd die Port-Berechtigung schon fuer DIESEN Start geladen?
# Muss vor jedem daemon-reload gelesen werden.
LOADED_AMBIENT="$("$SYSTEMCTL" show "$SERVICE_NAME" -p AmbientCapabilities --value 2>/dev/null || true)"

JEMALLOC_LIB=""
if [[ ! -e "$DATA_DIR/.no-jemalloc" ]]; then
  for candidate in $JEMALLOC_CANDIDATES; do
    if [[ -f "$candidate" ]]; then JEMALLOC_LIB="$candidate"; break; fi
  done
fi

WANT="[Service]
# Verwaltet von node-runtime-provision.sh — Aenderungen werden ueberschrieben.
# Port 80/443/502 ueber systemd statt setcap an der node-Datei (sonst ignoriert
# glibc LD_PRELOAD/MALLOC_*).
AmbientCapabilities=CAP_NET_BIND_SERVICE"
if [[ -n "$JEMALLOC_LIB" ]]; then
  WANT="${WANT}
Environment=LD_PRELOAD=${JEMALLOC_LIB}
Environment=MALLOC_CONF=${MALLOC_CONF_VALUE}"
fi

if [[ "$(cat "$DROPIN" 2>/dev/null)" != "$WANT" ]]; then
  mkdir -p "$DROPIN_DIR" && printf '%s\n' "$WANT" > "$DROPIN" && "$SYSTEMCTL" daemon-reload 2>/dev/null
  echo "  node-runtime: Drop-in geschrieben (jemalloc: ${JEMALLOC_LIB:-aus})"
fi

if [[ -z "$NODE_BIN" ]]; then
  echo "  node-runtime: node nicht gefunden, setcap uebersprungen"
elif [[ "${NODE_RUNTIME_FRESH:-0}" == "1" || "$LOADED_AMBIENT" == *cap_net_bind_service* ]]; then
  # Port-Recht kommt von systemd — Datei-Recht weg, sonst bleibt der secure mode.
  "$SETCAP" -r "$NODE_BIN" 2>/dev/null || true
  echo "  node-runtime: Port-Recht ueber systemd, setcap an node entfernt"
else
  # Erster Start nach dem Umstieg: dieser Start laeuft noch ohne systemd-Recht.
  "$SETCAP" cap_net_bind_service=+ep "$NODE_BIN" 2>/dev/null || true
  echo "  node-runtime: setcap bleibt fuer diesen Start (Umstieg ab dem naechsten)"
fi
exit 0
