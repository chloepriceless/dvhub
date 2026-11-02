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
    --ttl) [ $# -ge 2 ] || { echo "FEHLER: --ttl braucht einen Wert (0 oder 5 bis 240 Minuten)" >&2; exit 2; }
           TTL_MIN="$2"; shift 2;;
    --print) MODE="print"; shift;;
    --close) MODE="close"; shift;;
    --service) MODE="service"; shift;;
    -h|--help) usage; exit 0;;
    *) echo "Unbekannte Option: $1" >&2; usage; exit 2;;
  esac
done

# --ttl: nur 0 (bis Strg-C) oder 5–240 Minuten (Strix T-0002). Vorher liefen
# Tippfehler wie -1, abc oder 1e3 still ohne Auto-Close, 43200 einen Monat.
if [[ ! "$TTL_MIN" =~ ^[0-9]{1,4}$ ]] || { (( 10#$TTL_MIN != 0 )) && (( 10#$TTL_MIN < 5 || 10#$TTL_MIN > 240 )); }; then
  echo "FEHLER: --ttl erwartet 0 (bis Strg-C) oder 5 bis 240 Minuten, nicht: '$TTL_MIN'" >&2
  exit 2
fi
TTL_MIN=$(( 10#$TTL_MIN ))

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

# --- Laufende Tunnel finden (Strix T-0004) ---
# Nur über PIDs, die die Tunnel selbst aufschreiben — nicht per `pgrep -f
# <Schlüsselpfad>`: das traf jeden Prozess mit dem Pfad in der Befehlszeile
# (z. B. `less …/relay_id_ed25519`), blockierte das Öffnen und ließ --close
# als root fremde Prozesse beenden.
# "<skript-pid> <autossh-pid>" des Vordergrund-Tunnels. Als root in /run —
# support/ gehört dem Dienstbenutzer, root schriebe dort sonst durch einen
# Verweis; ohne root (Aufruf als dvhub) im eigenen support/-Ordner.
MANUAL_PID_ROOT="${DVHUB_TUNNEL_PID_FILE:-/run/dvhub-support-tunnel.pid}"
MANUAL_PID_USER="$SUP_DIR/tunnel-manual.pid"
if [ "$(id -u)" -eq 0 ]; then MANUAL_PID_FILE="$MANUAL_PID_ROOT"; else MANUAL_PID_FILE="$MANUAL_PID_USER"; fi
SERVICE_STATE="$SUP_DIR/tunnel-state.json"     # vom Dienst-Modus (--service)
PROCESS_STATE="$SUP_DIR/tunnel-process.json"   # App ohne Tunnel-Unit (startet autossh selbst)
pid_args() { ps -o args= -p "$1" 2>/dev/null || true; }
pid_uid() { ps -o uid= -p "$1" 2>/dev/null | tr -d ' ' || true; }
pid_ppid() { ps -o ppid= -p "$1" 2>/dev/null | tr -d ' ' || true; }
# Dienstbenutzer (Eigentümer des Schlüssels). `|| KEY_UID=""`: fehlt der
# Schlüssel oder ist support/ nicht lesbar, beendete pipefail sonst still das
# Skript, bevor es die Fehlermeldung zeigen konnte (Gegenprüfung 98bfcb68).
KEY_UID="$(ls -ln "$KEY" 2>/dev/null | awk '{print $3}')" || KEY_UID=""
# <pid> <muster>: lebt der Prozess und trägt er das Muster in der Befehlszeile?
pid_is() { [[ "$1" =~ ^[0-9]+$ ]] && (( $1 > 1 )) && kill -0 "$1" 2>/dev/null && [[ "$(pid_args "$1")" == *"$2"* ]]; }
# Dateien aus support/ gehören dem Dienstbenutzer: nur reguläre Dateien lesen
# (kein Verweis, keine FIFO — die ließe --close hängen), höchstens 200 Byte.
read_small() {
  [ -f "$1" ] && [ ! -L "$1" ] || return 1
  if command -v timeout >/dev/null 2>&1; then timeout 2 head -c 200 -- "$1" 2>/dev/null; else head -c 200 -- "$1" 2>/dev/null; fi
}
# Ein Prozess aus einer dvhub-eigenen Datei zählt für root nur, wenn er dem
# Dienstbenutzer gehört — sonst könnte die Datei root fremde Prozesse beenden lassen.
owned_by_service() {
  [ "$(id -u)" -ne 0 ] && return 0
  [ -n "$KEY_UID" ] && [ "$(pid_uid "$1")" = "$KEY_UID" ]
}
json_pid() { grep -oE '"pid"[[:space:]]*:[[:space:]]*[0-9]+' | head -1 | grep -oE '[0-9]+$' || true; }
manual_pids() {  # gibt "<skript> <autossh>" aus, wenn ein Vordergrund-Tunnel läuft
  local f line sp ap
  for f in "$MANUAL_PID_ROOT" "$MANUAL_PID_USER"; do
    line="$(read_small "$f")" || continue
    sp=""; ap=""
    read -r sp ap <<< "$line" || true
    pid_is "$sp" dvhub-support-tunnel || continue
    if [ "$f" = "$MANUAL_PID_USER" ] && [ "$(id -u)" -eq 0 ]; then
      owned_by_service "$sp" || continue
      [ -n "$ap" ] && [ "$(pid_ppid "$ap")" != "$sp" ] && ap=""
    fi
    echo "$sp ${ap:-}"
    return 0
  done
  return 1
}
service_pid() {  # PID des Dienst-Tunnels aus tunnel-state.json
  local pid
  pid="$(read_small "$SERVICE_STATE" | json_pid)"
  pid_is "$pid" dvhub-support-tunnel && owned_by_service "$pid" && echo "$pid"
}
process_pid() {  # autossh/ssh, das die App ohne Tunnel-Unit selbst gestartet hat
  local pid
  pid="$(read_small "$PROCESS_STATE" | json_pid)"
  pid_is "$pid" "$KEY" && owned_by_service "$pid" && echo "$pid"
}

# --- Beenden ---
if [ "$MODE" = "close" ]; then
  FOUND=0
  if read -r SPID APID < <(manual_pids); then
    FOUND=1
    if pid_is "${APID:-}" "$KEY"; then pkill -TERM -P "$APID" 2>/dev/null || true; kill "$APID" 2>/dev/null || true; fi
    kill "$SPID" 2>/dev/null || true
  fi
  if APP_PID="$(process_pid)"; then
    FOUND=1
    pkill -TERM -P "$APP_PID" 2>/dev/null || true
    kill "$APP_PID" 2>/dev/null || true
  fi
  if SVC_PID="$(service_pid)"; then
    FOUND=1
    if command -v systemctl >/dev/null 2>&1; then
      systemctl stop dvhub-support-tunnel.service 2>/dev/null || kill "$SVC_PID" 2>/dev/null || true
    else
      kill "$SVC_PID" 2>/dev/null || true
    fi
  fi
  if [ "$FOUND" -eq 1 ]; then
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
# Ziele auf der Box: sshd und Weboberfläche. DVhub schreibt sie in den Auftrag;
# ohne Angabe 22 und der eigene Support-Listener der App (Strix T-0001: nicht
# der normale Port — dort gälte der Support als „die Box selbst“).
LOCAL_SHELL=""; LOCAL_WEB=""
if [ "$MODE" = "service" ]; then
  LOCAL_SHELL="$(json_num_in localShellPort "$REQ_JSON")"
  LOCAL_WEB="$(json_num_in localWebPort "$REQ_JSON")"
fi
LOCAL_SHELL="${LOCAL_SHELL:-22}"
LOCAL_WEB="${LOCAL_WEB:-${DVHUB_SUPPORT_WEB_PORT:-47822}}"
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
if manual_pids >/dev/null || service_pid >/dev/null || process_pid >/dev/null; then
  echo "HINWEIS: Es läuft bereits ein Support-Tunnel (vermutlich aus der DVhub-App)." >&2
  echo "         Erst beenden mit:  sudo bash $0 --close" >&2
  exit 1
fi

# --- Öffnen (Vordergrund); Auto-Close via TTL; sauberes Aufräumen ---
cleanup() {
  trap - EXIT INT TERM
  if [ -n "${AUTOSSH_PID:-}" ]; then
    # Erst den ssh-Kindprozess, dann autossh (der Supervisor stirbt sonst getrennt).
    pkill -TERM -P "$AUTOSSH_PID" 2>/dev/null || true
    kill "$AUTOSSH_PID" 2>/dev/null || true
  fi
  # `if` statt `&&`: unter set -e beendete ein schon abgelaufenes sleep (kill
  # scheitert) sonst das Aufräumen mit Exit 1 — PID-Datei blieb liegen.
  if [ -n "${SLEEP_PID:-}" ]; then kill "$SLEEP_PID" 2>/dev/null || true; fi
  rm -f "$MANUAL_PID_FILE"
  echo ""
  echo "Support-Tunnel geschlossen."
}
trap cleanup EXIT INT TERM

"$AUTOSSH_BIN" "${ARGS[@]}" &
AUTOSSH_PID=$!
if ! { printf '%d %d\n' "$$" "$AUTOSSH_PID" > "$MANUAL_PID_FILE.tmp" && mv -f "$MANUAL_PID_FILE.tmp" "$MANUAL_PID_FILE"; }; then
  echo "WARN: $MANUAL_PID_FILE nicht geschrieben — --close findet diesen Tunnel nicht; Strg-C beendet ihn." >&2
fi
sleep 2

if ! kill -0 "$AUTOSSH_PID" 2>/dev/null; then
  echo "FEHLER: Tunnel konnte nicht aufgebaut werden (Relay nicht erreichbar / Key abgelehnt / Ports belegt)." >&2
  exit 1
fi

echo "Tunnel OFFEN. Der Support kann sich jetzt verbinden."
if [ "${TTL_MIN}" -gt 0 ] 2>/dev/null; then
  echo "Auto-Close in ${TTL_MIN} Min. Sofort beenden: Strg-C (oder in einem anderen Terminal: sudo bash $0 --close)."
  # Im Hintergrund + wait: so greift --close (TERM) sofort, nicht erst nach Ablauf.
  TTL_SECONDS=$(( TTL_MIN * 60 ))
  # Nur für Tests (kürzere Laufzeit); sudo leert die Umgebung ohnehin.
  [[ "${DVHUB_TUNNEL_TEST_TTL_S:-}" =~ ^[0-9]{1,3}$ ]] && TTL_SECONDS="$DVHUB_TUNNEL_TEST_TTL_S"
  sleep "$TTL_SECONDS" & SLEEP_PID=$!
  wait "$SLEEP_PID" || true
else
  echo "Kein Auto-Close (--ttl 0). Beenden mit Strg-C."
  wait "$AUTOSSH_PID" || true
fi
