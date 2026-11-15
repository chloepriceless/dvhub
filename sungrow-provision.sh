#!/usr/bin/env bash
# sungrow-provision.sh — Absicherung C2/C4 für den Sungrow-Dauer-Forced-Split auf der PAKET-Box einhängen.
#
# Warum: Forced mode (13050=2) hat KEINEN geräteeigenen Rückfall. Beendet der DVhub-Dienst unsauber
# (Crash/SIGKILL/hängender Shutdown) oder hängt der Prozess, muss der Modus trotzdem sicher zurückgenommen werden:
#   • C2  — ExecStopPost=scripts/sungrow-forced-release.mjs: läuft NACH dem Dienst-Stop, nimmt beide WR zurück
#            (Master Modus 0, beide 0xCC), wenn der Merker noch steht (Prozess hat nicht selbst freigegeben).
#   • C4  — dvhub-sungrow-watchdog.timer (~alle 60 s): unabhängiger Box-Watchdog, greift auch wenn DVhub HÄNGT.
# Feld 16.11.: `systemctl cat dvhub` auf der Paket-Box zeigte nach dem Update NUR ExecStartPre+ExecStart — kein
# ExecStopPost, kein Drop-in, kein Sungrow-Timer → C2/C4 waren NICHT aktiv. Dieses Skript hängt beides als Drop-in
# bzw. eigene Unit ein — dasselbe Muster wie clock-/support-/eos-provision.sh, geteilt von install.sh und
# post-update.sh. Idempotent, best-effort: ein Fehler darf Installation/Boot NIE abbrechen.
#
# Nur für Sungrow-Installationen (config.manufacturer == "sungrow"). Auf anderen Boxen wird ein etwaiges früheres
# Drop-in/Timer wieder ENTFERNT (idempotentes Aufräumen). Opt-out: $DATA_DIR/.no-sungrow-watchdog.
# --check: nur den aktuellen Zustand ausgeben (read-only), nichts ändern.
#
# Kein `set -e` (best-effort, jeder Schritt einzeln abgesichert).
set -uo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/dvhub}"
APP_DIR="${APP_DIR:-${INSTALL_DIR}/dvhub}"
SERVICE_NAME="${SERVICE_NAME:-dvhub}"
DATA_DIR="${DATA_DIR:-${DV_DATA_DIR:-/var/lib/dvhub}}"
CONFIG_PATH="${DV_APP_CONFIG:-${CONFIG_PATH:-${APP_DIR}/config.json}}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"

# SYSTEMD_DIR ist überschreibbar (Tests); in der Produktion /etc/systemd/system.
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
DROPIN_DIR="${SYSTEMD_DIR}/${SERVICE_NAME}.service.d"
DROPIN_FILE="${DROPIN_DIR}/sungrow-forced-release.conf"
WATCHDOG_SERVICE="${SYSTEMD_DIR}/dvhub-sungrow-watchdog.service"
WATCHDOG_TIMER="${SYSTEMD_DIR}/dvhub-sungrow-watchdog.timer"

CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

in_container() {
  [[ -f /.dockerenv || -f /run/.containerenv ]] && return 0
  if command -v systemd-detect-virt >/dev/null 2>&1; then
    local v; v="$(systemd-detect-virt --container 2>/dev/null || true)"
    [[ -n "$v" && "$v" != "none" ]] && return 0
  fi
  return 1
}

# Sungrow-Installation? (config.manufacturer == "sungrow"). Robust gegen Whitespace-Varianten.
is_sungrow() {
  [[ -f "$CONFIG_PATH" ]] || return 1
  grep -Eq '"manufacturer"[[:space:]]*:[[:space:]]*"sungrow"' "$CONFIG_PATH"
}

report() {
  local dropin="fehlt" timer="aus"
  [[ -f "$DROPIN_FILE" ]] && dropin="aktiv"
  if command -v systemctl >/dev/null 2>&1 && systemctl is-enabled --quiet dvhub-sungrow-watchdog.timer 2>/dev/null; then timer="aktiv"; fi
  echo "  Sungrow-Absicherung: ExecStopPost-Rückgabe ${dropin}, Watchdog-Timer ${timer}."
}

if ! command -v systemctl >/dev/null 2>&1; then
  echo "  Sungrow-Absicherung: systemctl nicht vorhanden (kein systemd) — übersprungen."
  exit 0
fi

if [[ "$CHECK_ONLY" == "1" ]]; then
  report
  exit 0
fi

if in_container; then
  # Im Container hängt die Absicherung am HOST-systemd des Dienstes; hier nichts einhängen.
  echo "  Sungrow-Absicherung: im Container — die Host-Unit zählt (übersprungen)."
  exit 0
fi

CHANGED=0

# (C2) ExecStopPost-Drop-in IMMER einhängen (M3a, Feld 16.11.: der Drop-in fehlte auf der Paket-Box, nur der
# Watchdog-Timer lief). Der Drop-in hängt NICHT an der Sungrow-Erkennung: das Rückgabe-Skript ist ein sicherer
# No-op, wenn keine Sungrow-Anlage läuft (kein Forced-Merker → nichts zu tun). So greift die Rückgabe auf ALLEN
# Stop-Pfaden (sauberer Stop, Crash/SIGKILL, Neustart), unabhängig davon, ob die Konfiguration gerade als Sungrow
# erkannt wird. DATA_DIR explizit (die Haupt-Unit setzt DV_DATA_DIR, die Skripte lesen aber DATA_DIR) — sonst fände
# das Skript den Merker im falschen Verzeichnis.
mkdir -p "$DROPIN_DIR"
NEW_DROPIN="$(cat <<DROPIN
# Von sungrow-provision.sh verwaltet (Absicherung C2) — nicht von Hand ändern.
[Service]
Environment=DATA_DIR=${DATA_DIR}
ExecStopPost=${NODE_BIN} ${APP_DIR}/scripts/sungrow-forced-release.mjs
DROPIN
)"
if [[ ! -f "$DROPIN_FILE" ]] || [[ "$(cat "$DROPIN_FILE" 2>/dev/null)" != "$NEW_DROPIN" ]]; then
  printf '%s\n' "$NEW_DROPIN" >"$DROPIN_FILE" && CHANGED=1
  echo "  Sungrow-Absicherung: ExecStopPost-Drop-in angelegt ($DROPIN_FILE)."
fi

# (C4) Unabhängiger Watchdog-Timer (~alle 60 s) NUR für Sungrow-Anlagen (periodischer Node-Start). Keine Sungrow-
# Anlage oder Opt-out → einen etwaigen früheren Timer entfernen (den ExecStopPost-Drop-in NICHT anfassen).
if ! is_sungrow || [[ -f "$DATA_DIR/.no-sungrow-watchdog" ]]; then
  if [[ -f "$WATCHDOG_TIMER" || -f "$WATCHDOG_SERVICE" ]]; then
    systemctl disable --now dvhub-sungrow-watchdog.timer >/dev/null 2>&1 || true
    rm -f "$WATCHDOG_TIMER" "$WATCHDOG_SERVICE"
    CHANGED=1
  fi
  if [[ "$CHANGED" == "1" ]]; then systemctl daemon-reload || true; fi
  echo "  Sungrow-Absicherung: ExecStopPost aktiv; kein Watchdog-Timer (keine Sungrow-Anlage)."
  report
  exit 0
fi

NEW_WD_SVC="$(cat <<WDSVC
# Von sungrow-provision.sh verwaltet (Absicherung C4) — nicht von Hand ändern.
[Unit]
Description=DVhub Sungrow Forced-Mode Watchdog (Absicherung C4)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=DV_APP_CONFIG=${CONFIG_PATH}
Environment=DATA_DIR=${DATA_DIR}
ExecStart=${NODE_BIN} ${APP_DIR}/scripts/sungrow-forced-watchdog.mjs
WDSVC
)"
if [[ ! -f "$WATCHDOG_SERVICE" ]] || [[ "$(cat "$WATCHDOG_SERVICE" 2>/dev/null)" != "$NEW_WD_SVC" ]]; then
  printf '%s\n' "$NEW_WD_SVC" >"$WATCHDOG_SERVICE" && CHANGED=1
fi

NEW_WD_TIMER="$(cat <<WDTIMER
# Von sungrow-provision.sh verwaltet (Absicherung C4) — nicht von Hand ändern.
[Unit]
Description=DVhub Sungrow Forced-Mode Watchdog (alle 60 s)

[Timer]
OnBootSec=90s
OnUnitActiveSec=60s
AccuracySec=10s

[Install]
WantedBy=timers.target
WDTIMER
)"
if [[ ! -f "$WATCHDOG_TIMER" ]] || [[ "$(cat "$WATCHDOG_TIMER" 2>/dev/null)" != "$NEW_WD_TIMER" ]]; then
  printf '%s\n' "$NEW_WD_TIMER" >"$WATCHDOG_TIMER" && CHANGED=1
fi

if [[ "$CHANGED" == "1" ]]; then
  systemctl daemon-reload || true
fi
# Timer immer sicherstellen (enable ist idempotent).
systemctl enable --now dvhub-sungrow-watchdog.timer >/dev/null 2>&1 || true

report
exit 0
