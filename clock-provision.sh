#!/usr/bin/env bash
# clock-provision.sh — Box-Uhr: systemd-timesyncd (NTP) aktivieren bzw. prüfen und melden.
#
# Warum: DVhub hängt an der Uhr — EOS-Läufe starten zur vollen Viertelstunde der Börse,
# Zeitpläne und 15-min-Slots ebenso. Feld 15.11.: eine Box lief mit „System clock
# synchronized: no, NTP inactive" und 18 s Abweichung; damit greifen die Slots daneben.
# Ein Container kann die Uhr NICHT stellen (alle Container teilen die Host-Uhr, Stellen
# bräuchte CAP_SYS_TIME) — der Abgleich ist Sache des Betriebssystems der Box.
#
# Dieses Skript STELLT die Zeit nicht selbst; es schaltet nur den OS-Zeitabgleich ein
# (timedatectl set-ntp true → systemd-timesyncd) und meldet den Zustand. Idempotent,
# best-effort: ein Fehler darf Installation/Boot NIE abbrechen. Geteilt von install.sh
# und post-update.sh — dasselbe Muster wie support-/eos-provision.sh.
#
# Opt-out: $DATA_DIR/.no-ntp (dann nur prüfen/melden, nicht aktivieren).
# --check: nur den aktuellen Zustand ausgeben (read-only), nichts ändern.
#
# Kein `set -e` (best-effort, jeder Schritt einzeln abgesichert).
set -uo pipefail

DATA_DIR="${DATA_DIR:-${DV_DATA_DIR:-/var/lib/dvhub}}"
CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

# In einem Container ist die Uhr nicht stellbar — still überspringen (kein Fehler).
in_container() {
  [[ -f /.dockerenv || -f /run/.containerenv ]] && return 0
  if command -v systemd-detect-virt >/dev/null 2>&1; then
    local v; v="$(systemd-detect-virt --container 2>/dev/null || true)"
    [[ -n "$v" && "$v" != "none" ]] && return 0
  fi
  return 1
}

# NTP-Zustand lesen: „yes"/„no" bzw. leer, wenn nicht ermittelbar.
ntp_enabled() { timedatectl show -p NTP --value 2>/dev/null; }
ntp_synced()  { timedatectl show -p NTPSynchronized --value 2>/dev/null; }

report() {
  local en sy
  en="$(ntp_enabled)"; sy="$(ntp_synced)"
  echo "  Uhr: NTP-Dienst ${en:-unbekannt}, Systemuhr synchronisiert ${sy:-unbekannt}."
}

if ! command -v timedatectl >/dev/null 2>&1; then
  echo "  Uhr: timedatectl nicht vorhanden (kein systemd) — Zeitabgleich bitte am Betriebssystem prüfen."
  exit 0
fi

if in_container; then
  echo "  Uhr: im Container — die Host-Uhr zählt; Zeitabgleich am Host prüfen (übersprungen)."
  report
  exit 0
fi

if [[ "$CHECK_ONLY" == "1" ]]; then
  report
  exit 0
fi

enabled="$(ntp_enabled)"
if [[ "$enabled" == "yes" ]]; then
  echo "  Uhr: NTP ist bereits aktiv."
elif [[ -f "$DATA_DIR/.no-ntp" ]]; then
  echo "  Uhr: NTP inaktiv, aber per $DATA_DIR/.no-ntp abgeschaltet — nur gemeldet, nicht aktiviert." >&2
else
  echo "  Uhr: NTP inaktiv — aktiviere den Zeitabgleich (timedatectl set-ntp true)."
  if timedatectl set-ntp true 2>/dev/null; then
    # Manche Images liefern systemd-timesyncd maskiert/aus — nachziehen, falls die Unit existiert.
    if command -v systemctl >/dev/null 2>&1 \
       && systemctl list-unit-files systemd-timesyncd.service >/dev/null 2>&1; then
      systemctl unmask systemd-timesyncd.service >/dev/null 2>&1 || true
      systemctl enable --now systemd-timesyncd.service >/dev/null 2>&1 || true
    fi
    # Merker (wie .eos-provisioned): zuletzt aktiviert — ohne das Verzeichnis zu erzwingen.
    [[ -d "$DATA_DIR" ]] && date -u +%FT%TZ > "$DATA_DIR/.ntp-provisioned" 2>/dev/null || true
  else
    echo "  Uhr: Aktivieren fehlgeschlagen (timedatectl set-ntp true) — bitte am Betriebssystem prüfen." >&2
  fi
fi

report
exit 0
