#!/usr/bin/env bash
# dvhub-support-tunnel.sh — STANDALONE Notfall-Support-Tunnel.
#
# Fallback für den Fall, dass die DVhub-App selbst nicht mehr startet (dann ist
# die Web-UI/API zum Öffnen des Support-Tunnels nicht verfügbar), die Linux-Box
# aber noch erreichbar ist (LAN-SSH oder lokale Konsole). Baut denselben
# Reverse-SSH-Support-Tunnel auf, den die App aufbauen würde — NUR aus Dateien
# auf Platte (relay.json + Relay-Key), OHNE die DVhub-Node-App, die Datenbank
# oder Python.
#
# Vertrauensmodell unverändert: kundeninitiiert, zeitbegrenzt (Auto-Close),
# jederzeit beendbar. Der hinterlegte Relay-Key allein gibt dem Support nichts —
# erreichbar ist die Box nur, solange DIESER Tunnel offen ist, und nur DU öffnest ihn.
#
# Nutzung (als root):
#   sudo bash /opt/dvhub/dvhub-support-tunnel.sh            # öffnen (Auto-Close 60 Min)
#   sudo bash /opt/dvhub/dvhub-support-tunnel.sh --ttl 30   # öffnen, Auto-Close nach 30 Min
#   sudo bash /opt/dvhub/dvhub-support-tunnel.sh --ttl 0    # öffnen bis Strg-C
#   sudo bash /opt/dvhub/dvhub-support-tunnel.sh --print    # nur anzeigen, NICHT verbinden
#   sudo bash /opt/dvhub/dvhub-support-tunnel.sh --close    # laufenden Tunnel beenden
#
# --service: nur für die Unit dvhub-support-tunnel.service (läuft als dvhub).
#   DVhub schreibt den Auftrag nach support/tunnel.json ({"expiresAt": <ms>})
#   und startet die Unit; das Skript hält den Tunnel bis zum Ablauf und
#   meldet seinen Zustand in support/tunnel-state.json. So überlebt der Tunnel
#   einen Neustart von DVhub. Schließen: systemctl stop (DVhub per sudo-Regel).
set -euo pipefail

DATA_DIR="${DV_DATA_DIR:-/var/lib/dvhub}"
SUP_DIR="$DATA_DIR/support"
RELAY_JSON="$SUP_DIR/relay.json"
KEY="$SUP_DIR/relay_id_ed25519"
KNOWN_HOSTS="$SUP_DIR/known_hosts"
APPLIANCE_ID_FILE="$DATA_DIR/appliance-id"
TTL_MIN=60
MODE="open"

usage() {
  echo "DVhub Notfall-Support-Tunnel"
  echo "  sudo bash $0            # öffnen (Auto-Close 60 Min)"
  echo "  sudo bash $0 --ttl 30   # öffnen, Auto-Close nach 30 Min (0 = bis Strg-C)"
  echo "  sudo bash $0 --print    # nur anzeigen, was liefe (nicht verbinden)"
  echo "  sudo bash $0 --close    # laufenden Tunnel beenden"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --ttl) TTL_MIN="${2:-60}"; shift 2;;
    --print) MODE="print"; shift;;
    --close) MODE="close"; shift;;
    --service) MODE="service"; shift;;
    -h|--help) usage; exit 0;;
    *) echo "Unbekannte Option: $1" >&2; usage; exit 2;;
  esac
done

# --- Flache-JSON-Extraktion ohne jq/python (Fallback muss robust sein) ---
# Im Dienst-Modus gehen die Werte aus dem Auftrag (tunnel.json, von DVhub mit den
# wirksamen Einstellungen geschrieben) vor relay.json.
REQ_JSON="$SUP_DIR/tunnel.json"
json_num_in() { grep -oE "\"$1\"[[:space:]]*:[[:space:]]*[0-9]+" "$2" 2>/dev/null | head -1 | grep -oE '[0-9]+$' || true; }
json_str_in() { grep -oE "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$2" 2>/dev/null | head -1 | grep -oE '"[^"]*"$' | tr -d '"' || true; }
json_num() {
  local v=""
  [ "$MODE" = "service" ] && v="$(json_num_in "$1" "$REQ_JSON")"
  [ -n "$v" ] && [ "$v" != "0" ] && { echo "$v"; return; }
  json_num_in "$1" "$RELAY_JSON"
}
json_str() {
  local v=""
  [ "$MODE" = "service" ] && v="$(json_str_in "$1" "$REQ_JSON")"
  [ -n "$v" ] && { echo "$v"; return; }
  json_str_in "$1" "$RELAY_JSON"
}

# --- Beenden ---
if [ "$MODE" = "close" ]; then
  if pgrep -f "$KEY" >/dev/null 2>&1; then
    pkill -f "$KEY" 2>/dev/null || true
    sleep 1
    echo "Support-Tunnel beendet."
  else
    echo "Kein laufender Support-Tunnel gefunden."
  fi
  exit 0
fi

# --- Voraussetzungen ---
if [ ! -f "$RELAY_JSON" ] || [ ! -f "$KEY" ]; then
  echo "FEHLER: Support nicht eingerichtet — $RELAY_JSON oder Relay-Key fehlt." >&2
  echo "        (Der Support-User/Schlüssel wird bei der Installation angelegt; ggf. ist --no-support-user gesetzt.)" >&2
  exit 1
fi
if [ ! -r "$KEY" ]; then
  echo "FEHLER: Relay-Key $KEY nicht lesbar — bitte mit 'sudo' ausführen." >&2
  exit 1
fi
AUTOSSH_BIN="$(command -v autossh || true)"
MONITOR_ARGS=(-M 0)
if [ -z "$AUTOSSH_BIN" ] && [ "$MODE" = "service" ]; then
  # Wie die DVhub-App: ohne autossh das normale ssh (kennt kein -M 0).
  AUTOSSH_BIN="$(command -v ssh || true)"
  MONITOR_ARGS=()
fi
if [ -z "$AUTOSSH_BIN" ]; then
  echo "FEHLER: 'autossh' nicht gefunden. Installieren: sudo apt-get install -y autossh" >&2
  exit 1
fi

# --- Relay-Parameter (relay.json; Defaults für Host/Port/User) ---
HOST="$(json_str host)";       HOST="${HOST:-support.dvhub.de}"
PORT="$(json_num port)";       PORT="${PORT:-47821}"
RUSER="$(json_str user)";      RUSER="${RUSER:-dvhub-support}"
SHELLP="$(json_num shellPort)"
WEBP="$(json_num webPort)"
# Ziele auf der Box: sshd und Weboberfläche. DVhub schreibt sie in den Auftrag
# (httpPort aus der Config); ohne Angabe wie bisher 22 und 80.
LOCAL_SHELL=""; LOCAL_WEB=""
if [ "$MODE" = "service" ]; then
  LOCAL_SHELL="$(json_num_in localShellPort "$REQ_JSON")"
  LOCAL_WEB="$(json_num_in localWebPort "$REQ_JSON")"
fi
LOCAL_SHELL="${LOCAL_SHELL:-22}"; LOCAL_WEB="${LOCAL_WEB:-80}"
APPLIANCE_ID="$(cat "$APPLIANCE_ID_FILE" 2>/dev/null || echo 'n/a')"

if [ -z "$SHELLP" ] || [ -z "$WEBP" ]; then
  echo "FEHLER: shellPort/webPort fehlen in $RELAY_JSON — die Box ist beim Relay noch nicht registriert (nicht provisioniert)." >&2
  exit 1
fi

# --- autossh-Argumente (identisch zur DVhub-App) ---
ARGS=(
  ${MONITOR_ARGS[@]+"${MONITOR_ARGS[@]}"} -N -T
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3
  -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=yes
  -o BatchMode=yes -o IdentitiesOnly=yes
  -o "UserKnownHostsFile=$KNOWN_HOSTS"
  -R "127.0.0.1:${SHELLP}:127.0.0.1:${LOCAL_SHELL}"
  -R "127.0.0.1:${WEBP}:127.0.0.1:${LOCAL_WEB}"
  -p "$PORT" -i "$KEY" "${RUSER}@${HOST}"
)

echo "==================== DVhub Notfall-Support-Tunnel ===================="
echo " Diese Angaben dem Support durchgeben:"
echo "   Appliance-ID : $APPLIANCE_ID"
echo "   RELAY        : ${RUSER}@${HOST}:${PORT}  (Ports ${SHELLP}/${WEBP})"
echo "====================================================================="

if [ "$MODE" = "print" ]; then
  echo "Befehl (würde ausgeführt):"
  echo "  $AUTOSSH_BIN ${ARGS[*]}"
  exit 0
fi

# --- Dienst-Modus (Unit dvhub-support-tunnel.service) ---
if [ "$MODE" = "service" ]; then
  # Fehlermeldungen (Relay lehnt ab, Schlüssel falsch) zeigt DVhub aus dieser Datei an.
  exec 2>>"$SUP_DIR/tunnel.log"
  REQ="$REQ_JSON"
  STATE="$SUP_DIR/tunnel-state.json"
  EXP_MS="$(grep -oE '"expiresAt"[[:space:]]*:[[:space:]]*[0-9]+' "$REQ" 2>/dev/null | head -1 | grep -oE '[0-9]+$' || true)"
  if [ -z "$EXP_MS" ]; then echo "FEHLER: kein gültiger Auftrag in $REQ" >&2; exit 1; fi
  NOW_S="$(date +%s)"
  REMAIN=$(( EXP_MS / 1000 - NOW_S ))
  # Nie länger als 4 h (wie TTL_MIN_CEIL in DVhub), nie ohne Ende.
  [ "$REMAIN" -gt 14400 ] && REMAIN=14400
  if [ "$REMAIN" -le 0 ]; then rm -f "$REQ"; echo "Auftrag abgelaufen." >&2; exit 0; fi
  service_cleanup() { rm -f "$STATE"; }
  trap service_cleanup EXIT
  printf '{"pid":%d,"startedAt":%d,"expiresAt":%d}\n' "$$" "$(( NOW_S * 1000 ))" "$EXP_MS" > "$STATE.tmp"
  mv -f "$STATE.tmp" "$STATE"
  echo "Tunnel: Relay ${RUSER}@${HOST}:${PORT}, Ports ${SHELLP}/${WEBP}, ${REMAIN} s" >&2
  set +e
  timeout "$REMAIN" "$AUTOSSH_BIN" "${ARGS[@]}"
  RC=$?
  set -e
  # 124 = timeout hat beendet; zur Sicherheit auch „Zeit ist um“ als normales Ende werten.
  if [ "$RC" -eq 124 ] || [ "$(date +%s)" -ge $(( EXP_MS / 1000 - 1 )) ]; then
    rm -f "$REQ"; echo "Tunnel nach Ablauf geschlossen." >&2; exit 0
  fi
  echo "Tunnel beendet (Code $RC) — Relay nicht erreichbar, Schlüssel abgelehnt oder Ports belegt." >&2
  exit 1
fi

# --- Konflikt-Schutz: läuft schon ein Tunnel (z. B. aus der App)? ---
if pgrep -f "$KEY" >/dev/null 2>&1; then
  echo "HINWEIS: Es läuft bereits ein Support-Tunnel (vermutlich aus der DVhub-App)." >&2
  echo "         Erst beenden mit:  sudo bash $0 --close" >&2
  exit 1
fi

# --- Öffnen (Vordergrund); Auto-Close via TTL; sauberes Aufräumen ---
cleanup() {
  trap - EXIT INT TERM
  kill "${AUTOSSH_PID:-}" 2>/dev/null || true
  pkill -f "$KEY" 2>/dev/null || true   # auch den ssh-Kindprozess (autossh-Supervisor stirbt sonst getrennt)
  echo ""
  echo "Support-Tunnel geschlossen."
}
trap cleanup EXIT INT TERM

"$AUTOSSH_BIN" "${ARGS[@]}" &
AUTOSSH_PID=$!
sleep 2

if ! kill -0 "$AUTOSSH_PID" 2>/dev/null; then
  echo "FEHLER: Tunnel konnte nicht aufgebaut werden (Relay nicht erreichbar / Key abgelehnt / Ports belegt)." >&2
  exit 1
fi

echo "Tunnel OFFEN. Der Support kann sich jetzt verbinden."
if [ "${TTL_MIN}" -gt 0 ] 2>/dev/null; then
  echo "Auto-Close in ${TTL_MIN} Min. Sofort beenden: Strg-C (oder in einem anderen Terminal: sudo bash $0 --close)."
  sleep "$(( TTL_MIN * 60 ))" || true
else
  echo "Kein Auto-Close (--ttl 0). Beenden mit Strg-C."
  wait "$AUTOSSH_PID" || true
fi
