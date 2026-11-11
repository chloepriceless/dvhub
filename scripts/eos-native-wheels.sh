#!/usr/bin/env bash
# scripts/eos-native-wheels.sh — Rust-Kern des DVhub-EOS (akkudoktoreos-native):
# gepinnte Wheels auflisten, holen und gegen die Prüfsumme prüfen.
#
# DVhub liefert DVhub-EOS immer mit aktivem Rust-Kern aus (Christin 11.11.2026).
# Die Wheels baut der Fork chloepriceless/EOS zu jedem Tag dvhub-eos-* und legt
# sie als Release-Assets an genau diesen Tag (Workflow dvhub-eos-release.yml aus
# tools/dvhub-eos/overlay). eos-version.env pinnt Adresse, Dateinamen und
# sha256 je Architektur — eine Datei, die nicht passt, wird nie installiert.
# Genutzt von eos-provision.sh (native Installation) und der CI (Docker-Images,
# .github/workflows/container*.yml).
#
#   eos-native-wheels.sh list [pin-datei]
#       je gepinntem Wheel eine Zeile "<ARCH> <datei> <sha256>"
#       (ARCH = X86_64 | AARCH64 | ARMV7L); nichts, wenn keine Wheels gepinnt sind
#   eos-native-wheels.sh fetch <ziel> <ARCH|datei>... [--pin-file F]
#       holt die Wheels nach <ziel> und prüft sha256; Abbruch (Exit 1), wenn eine
#       Datei fehlt oder nicht passt (die halbe Datei wird gelöscht)
#   eos-native-wheels.sh update-pins <SHA256SUMS> [pin-datei]
#       trägt Dateinamen und sha256 der glibc-Wheels (manylinux) aus einer
#       SHA256SUMS des Releases in die pin-datei ein (nach einem neuen Fork-Tag)
#
# pin-datei: Vorgabe eos-version.env neben diesem Skript (../eos-version.env),
# überschreibbar mit EOS_PIN_FILE. Die Datei wird nie gesourct.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARCHS=(X86_64 AARCH64 ARMV7L)

die() { echo "eos-native-wheels: $*" >&2; exit 1; }

pin_file_default() { echo "${EOS_PIN_FILE:-$HERE/../eos-version.env}"; }

# Wert eines Schlüssels (letzte Zeile gewinnt, Anführungszeichen/CR weg).
val() {
  { grep -E "^$1=" "$2" 2>/dev/null || true; } | tail -n 1 | cut -d= -f2- | tr -d '"'"'"'\r'
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

cmd_list() {
  local pf="${1:-$(pin_file_default)}" a f s
  [[ -f "$pf" ]] || die "Pin-Datei $pf fehlt"
  for a in "${ARCHS[@]}"; do
    f="$(val "EOS_NATIVE_$a" "$pf")"; s="$(val "EOS_NATIVE_${a}_SHA256" "$pf")"
    [[ -n "$f" ]] || continue
    [[ "$s" =~ ^[0-9a-f]{64}$ ]] || die "EOS_NATIVE_${a}_SHA256 fehlt oder ist kein sha256 ($pf)"
    printf '%s %s %s\n' "$a" "$f" "$s"
  done
}

cmd_fetch() {
  local dest="" pf; pf="$(pin_file_default)"
  local want=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --pin-file) pf="$2"; shift 2 ;;
      *) if [[ -z "$dest" ]]; then dest="$1"; else want+=("$1"); fi; shift ;;
    esac
  done
  [[ -n "$dest" && ${#want[@]} -gt 0 ]] || die "Aufruf: fetch <ziel> <ARCH|datei>... [--pin-file F]"
  local url; url="$(val EOS_NATIVE_URL "$pf")"
  [[ -n "$url" ]] || die "EOS_NATIVE_URL fehlt ($pf)"
  local listing; listing="$(cmd_list "$pf")"
  mkdir -p "$dest"
  local w line a f s got
  for w in "${want[@]}"; do
    line="$(printf '%s\n' "$listing" | awk -v w="$w" '$1 == w || $2 == w' | head -n 1)"
    [[ -n "$line" ]] || die "kein Wheel für $w gepinnt ($pf)"
    read -r a f s <<<"$line"
    rm -f "$dest/$f.part"
    # --retry: kurze Netzaussetzer; -f: 404 ist ein Fehler, keine HTML-Seite.
    curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 300 \
      -o "$dest/$f.part" "$url/$f" || { rm -f "$dest/$f.part"; die "Download $url/$f fehlgeschlagen"; }
    got="$(sha256_of "$dest/$f.part")"
    if [[ "$got" != "$s" ]]; then
      rm -f "$dest/$f.part"
      die "Prüfsumme von $f passt nicht (erwartet $s, erhalten $got)"
    fi
    mv "$dest/$f.part" "$dest/$f"
    echo "$a $dest/$f"
  done
}

cmd_update_pins() {
  local sums="${1:-}" pf="${2:-$(pin_file_default)}"
  [[ -f "$sums" ]] || die "Aufruf: update-pins <SHA256SUMS> [pin-datei]"
  [[ -f "$pf" ]] || die "Pin-Datei $pf fehlt"
  local a tag f s tmp
  tmp="$(mktemp "$pf.XXXXXX")"
  cp -p "$pf" "$tmp"
  for a in "${ARCHS[@]}"; do
    case "$a" in X86_64) tag=x86_64 ;; AARCH64) tag=aarch64 ;; ARMV7L) tag=armv7l ;; esac
    # Nur glibc (manylinux): native Boxen sind Debian/Raspberry Pi OS/Armbian.
    # SHA256SUMS: "<sha256>  <datei>" (sha256sum; "*" vor dem Namen im Binärmodus).
    read -r s f < <(awk -v t="$tag" '{ sub(/^\*/, "", $2) }
      $2 ~ /manylinux/ && substr($2, length($2) - length(t) - 4) == "_" t ".whl" { print $1, $2; exit }' "$sums") || true
    [[ -n "${f:-}" ]] || { rm -f "$tmp"; die "kein manylinux-Wheel für $tag in $sums"; }
    [[ "$s" =~ ^[0-9a-f]{64}$ ]] || { rm -f "$tmp"; die "ungültige Prüfsumme für $f"; }
    grep -q "^EOS_NATIVE_$a=" "$tmp" || { rm -f "$tmp"; die "EOS_NATIVE_$a fehlt in $pf (Zeile zuerst anlegen)"; }
    sed -i.bak -e "s|^EOS_NATIVE_$a=.*|EOS_NATIVE_$a=$f|" -e "s|^EOS_NATIVE_${a}_SHA256=.*|EOS_NATIVE_${a}_SHA256=$s|" "$tmp"
    rm -f "$tmp.bak"
    f=""; s=""
  done
  mv "$tmp" "$pf"
  cmd_list "$pf"
}

case "${1:-}" in
  list) shift; cmd_list "$@" ;;
  fetch) shift; cmd_fetch "$@" ;;
  update-pins) shift; cmd_update_pins "$@" ;;
  *) sed -n '2,24p' "$0"; exit 64 ;;
esac
