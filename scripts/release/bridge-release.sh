#!/usr/bin/env bash
# bridge-release.sh — EINMALIGER Übergang zum dev-Schlüssel (24.11.2026,
# docs/release-pakete.md „dev-Schlüssel und Brücke“).
#
#   scripts/release/bridge-release.sh [<ref>] [--dry-run]
#
# Baut das Brücken-Paket aus <ref> (Vorgabe origin/main; der Commit muss den
# neuen Prüfcode und den dev-Schlüssel in release-keys/allowed_signers haben,
# auf origin/main liegen und eine grüne CI haben) und veröffentlicht es mit
# publish-release.sh --bridge:
#
#   - Pakete (arm64, armhf, amd64) mit dem RELEASE-Schlüssel, Namensraum
#     dvhub-release → Release dev-bridge (nie weggeräumt),
#   - channels/index-dev.json NUR mit diesem Paket, Release-Schlüssel — danach
#     eingefroren: Boxen mit älterem Prüfcode finden dort genau die Brücke,
#   - channels/index-dev-v2.json mit dem Paket, dev-Schlüssel (Datei).
#
# Der Release-Schlüssel liegt im 1Password-SSH-Agenten: genau ZWEI Signaturen
# über ihn, direkt hintereinander — ein ssh-keygen-Aufruf für alle drei Pakete
# (mehrere Dateien in einem Aufruf), einer für index-dev.json. 1Password fragt
# je Aufruf höchstens einmal; im selben Terminal meist nur beim ersten.
#
# --dry-run: dasselbe mit einem Wegwerf-Schlüssel statt des Release-Schlüssels
# (kein 1Password) und publish-release --dry-run nach $OUT/bridge-dry.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
REF="origin/main"
DRY=0
KEY="${DVHUB_RELEASE_KEY:-$HOME/.config/dvhub-release/release_ed25519}"
DEV_KEY="${DVHUB_RELEASE_DEV_KEY:-$HOME/.config/dvhub-release/dev_ed25519}"
OUT="${DVHUB_BRIDGE_OUT:-$HOME/Projects/dvhub-release-out/bridge}"
SOCK_1P="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
die() { echo "bridge-release: $*" >&2; exit 1; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    -*) die "unbekannte Option $1" ;;
    *) REF="$1"; shift ;;
  esac
done

git -C "$REPO" fetch -q origin '+refs/heads/main:refs/remotes/origin/main' || die "git fetch origin main fehlgeschlagen"
SHA="$(git -C "$REPO" rev-parse --verify "$REF^{commit}")" || die "Ref $REF unbekannt"
if ! git -C "$REPO" merge-base --is-ancestor "$SHA" refs/remotes/origin/main; then
  [[ "$DRY" -eq 1 ]] || die "${SHA:0:12} liegt nicht auf origin/main"
  echo "bridge-release: Hinweis: ${SHA:0:12} liegt (noch) nicht auf origin/main — nur Trockenlauf" >&2
fi
[[ -f "$DEV_KEY" && -f "$DEV_KEY.pub" ]] || die "dev-Schlüssel $DEV_KEY fehlt"
if [[ "$DRY" -eq 0 ]]; then
  (cd "$REPO" && python3 scripts/ci-check.py "$SHA") || die "CI für ${SHA:0:8} nicht grün — keine Brücke"
  [[ -f "$KEY.pub" ]] || die "$KEY.pub fehlt"
  export SSH_AUTH_SOCK="${SSH_AUTH_SOCK_1P:-$SOCK_1P}"
  PUB="$KEY.pub"
else
  WK="$(mktemp -d "${TMPDIR:-/tmp}/dvhub-bridge-key.XXXXXX")"
  trap 'rm -rf "$WK"' EXIT
  ssh-keygen -q -t ed25519 -N '' -C bridge-dry -f "$WK/release_ed25519"
  KEY="$WK/release_ed25519"; PUB="$KEY.pub"
  unset SSH_AUTH_SOCK
fi

rm -rf "$OUT"; mkdir -p "$OUT"
# 1) Bauen ohne Signatur (der Bau dauert Minuten; signiert wird danach in einem Zug).
bash "$HERE/build-release.sh" "$SHA" --repo "$REPO" --arch arm64,armhf,amd64 --out "$OUT" --no-sign
BUILD="$(ls -1d "$OUT"/*-dev.* | head -1)"
[[ -f "$BUILD/release.json" ]] || die "Bau ohne release.json"

# 2) Release-Schlüssel, Aufruf 1: alle Pakete in einem ssh-keygen-Aufruf.
#    -f auf die .pub-Kopie: signiert nur über den Agenten (keine Passphrase-Abfrage).
SIGNKEY="$KEY"
if [[ "$DRY" -eq 0 ]]; then
  KD="$(mktemp -d "${TMPDIR:-/tmp}/dvhub-bridge-pub.XXXXXX")"
  trap 'rm -rf "$KD"' EXIT
  install -m 0600 "$PUB" "$KD/release_agent" && install -m 0600 "$PUB" "$KD/release_agent.pub"
  SIGNKEY="$KD/release_agent"
fi
echo "Signiere $(ls "$BUILD"/*.tar.gz | wc -l | tr -d ' ') Pakete mit dem Release-Schlüssel (1Password fragt ggf. jetzt) …"
rm -f "$BUILD"/*.tar.gz.sig
ssh-keygen -Y sign -q -f "$SIGNKEY" -n dvhub-release "$BUILD"/*.tar.gz

# 3) Release-Schlüssel, Aufruf 2 (index-dev.json) + dev-Schlüssel (index-dev-v2.json) in publish-release.
ARGS=("$BUILD" --bridge --key "$SIGNKEY" --dev-key "$DEV_KEY" --repo "$REPO")
[[ "$DRY" -eq 1 ]] && ARGS+=(--dry-run --dest "$OUT/bridge-dry")
bash "$HERE/publish-release.sh" "${ARGS[@]}"
echo
echo "Brücke $(basename "$BUILD") $([[ $DRY -eq 1 ]] && echo 'TROCKEN ' )fertig."
[[ "$DRY" -eq 1 ]] || echo "Danach den Worker freigeben: rm \"$HOME/Library/Application Support/dvhub-dev-worker/state/sign-paused\""
