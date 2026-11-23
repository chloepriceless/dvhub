#!/usr/bin/env bash
# storage-limits.sh -- System-Grenzen nach DVhub-Speicherprofil (nativ, root).
#
# Speicher-Konzept 23.11.2026, Entscheidung S8 a (Christin): journald nur auf
# kleinen Platten begrenzen — Profil „klein“ 200 MB, „winzig“ 100 MB, sonst der
# System-Standard (bis 10 % der Platte, höchstens 4 GB). DVhub schreibt das
# Profil nach ${DATA_DIR}/storage-profile.json; gelesen wird NUR das Feld
# "effective" und nur ein bekannter Name, kein Verweis (die Datei gehört dem
# Dienstbenutzer). Eigene Datei: /etc/systemd/journald.conf.d/
# 90-dvhub-speicherprofil.conf mit Kennzeile — eine gleichnamige Datei ohne
# Kennzeile (vom Betreiber) und fremde Drop-ins werden nie angefasst. Idempotent; journald wird nur bei einer
# Änderung neu gestartet. Aufruf aus install.sh und post-update.sh.
set -uo pipefail
# STORAGE_LIMITS_EUID, JOURNALD_CONF_DIR: nur für Tests (test/storage-limits.test.js).
[[ "${STORAGE_LIMITS_EUID:-$EUID}" -eq 0 ]] || { echo "  Speicher-Grenzen: braucht root — übersprungen" >&2; exit 0; }
SP_FILE="${DATA_DIR:-/var/lib/dvhub}/storage-profile.json"
CONF_DIR="${JOURNALD_CONF_DIR:-/etc/systemd/journald.conf.d}"
DROPIN="$CONF_DIR/90-dvhub-speicherprofil.conf"
SP=""
if [[ -f "$SP_FILE" && ! -L "$SP_FILE" ]]; then
  SP="$(grep -o '"effective"[[:space:]]*:[[:space:]]*"[a-z]*"' "$SP_FILE" 2>/dev/null | head -n1 | sed 's/.*"\([a-z]*\)"$/\1/' || true)"
fi
case "$SP" in
  klein)  MAX=200M ;;
  winzig) MAX=100M ;;
  *)      MAX="" ;;
esac
restart_journald() { systemctl restart systemd-journald 2>/dev/null || true; }
# Früherer Dateiname (nur Entwicklungsstand vor 1.0.13): mit Kennzeile entfernen,
# ohne Kennzeile (Betreiber) stehen lassen (Codex 3e530edf).
OLD_DROPIN="$CONF_DIR/dvhub.conf"
if [[ -f "$OLD_DROPIN" && ! -L "$OLD_DROPIN" ]] && grep -q '^# DVhub: Speicherprofil' "$OLD_DROPIN" 2>/dev/null; then
  rm -f "$OLD_DROPIN"
  OLD_REMOVED=1
fi
if [[ -z "$MAX" ]]; then
  # Nur unsere eigene Datei entfernen (Kennzeile), nie eine fremde.
  if [[ -f "$DROPIN" ]] && grep -q '^# DVhub: Speicherprofil' "$DROPIN" 2>/dev/null; then
    rm -f "$DROPIN"
    OLD_REMOVED=1
    echo "  journald: DVhub-Grenze entfernt (Speicherprofil ${SP:-groß})"
  fi
  [[ "${OLD_REMOVED:-0}" -eq 1 ]] && restart_journald
  exit 0
fi
WANT="# DVhub: Speicherprofil $SP (storage-limits.sh). Nicht von Hand ändern — wird bei jedem Update überschrieben.
[Journal]
SystemMaxUse=$MAX
RuntimeMaxUse=$MAX
"
if [[ -f "$DROPIN" ]] && [[ "$(cat "$DROPIN")" == "$(printf '%s' "$WANT")" ]]; then
  [[ "${OLD_REMOVED:-0}" -eq 1 ]] && restart_journald
  echo "  journald: Grenze $MAX aktuell"
  exit 0
fi
# Datei ohne unsere Kennzeile (Betreiber) nie überschreiben (Codex 2739f099).
if [[ -e "$DROPIN" || -L "$DROPIN" ]] && ! grep -q '^# DVhub: Speicherprofil' "$DROPIN" 2>/dev/null; then
  echo "  journald: $DROPIN ohne DVhub-Kennzeile — bleibt unangetastet" >&2
  exit 0
fi
mkdir -p "$CONF_DIR"
tmp="$(mktemp "$CONF_DIR/.dvhub.XXXXXX")"
printf '%s' "$WANT" > "$tmp"
chmod 644 "$tmp"
mv -f "$tmp" "$DROPIN"
restart_journald
echo "  journald: Grenze $MAX gesetzt (Speicherprofil $SP)"
exit 0
