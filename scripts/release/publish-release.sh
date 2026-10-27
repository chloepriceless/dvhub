#!/usr/bin/env bash
# publish-release.sh — veröffentlicht gebaute Release-Pakete (build-release.sh)
# als GitHub-Release-Assets und schreibt den signierten Kanal-Index
# (docs/release-pakete.md).
#
#   scripts/release/publish-release.sh <build-dir> [--key PFAD]
#       [--gh-repo owner/name] [--repo DIR] [--keep-dev N]
#       [--dry-run --dest DIR]
#
# Struktur (wie https://github.com/<repo>/releases/download/…):
#   <tag>/dvhub-<v>-<arch>.tar.gz(.sig, .manifest.json)    stable: Tag vX.Y.Z
#   dev/…                                                  dev: rollierendes Vorab-Release
#   channels/index-<kanal>.json(.sig)                      Kanal-Index (Vorab-Release)
#
# --dry-run legt genau diese Struktur unter --dest an (z. B. für einen lokalen
# HTTP-Server) und zeigt die gh-Befehle, statt sie auszuführen.
set -euo pipefail
export LC_ALL=C

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="$HERE/lib/release-cli.mjs"
NODE="${NODE:-node}"
BUILD=""
KEY="${DVHUB_RELEASE_KEY:-$HOME/.config/dvhub-release/release_ed25519}"
GH_REPO="chloepriceless/dvhub"
REPO="$(cd "$HERE/../.." && pwd)"
KEEP_DEV=3
DRY=0
DEST=""

die() { echo "publish-release: $*" >&2; exit 1; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --key) KEY="${2:-}"; shift 2 ;;
    --gh-repo) GH_REPO="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --keep-dev) KEEP_DEV="${2:-}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --dest) DEST="${2:-}"; shift 2 ;;
    -*) die "unbekannte Option $1" ;;
    *) [[ -z "$BUILD" ]] || die "nur ein Build-Ordner"; BUILD="$1"; shift ;;
  esac
done
[[ -n "$BUILD" && -f "$BUILD/release.json" ]] || die "Build-Ordner mit release.json angeben"
[[ -f "$KEY" ]] || die "Signaturschlüssel $KEY fehlt (--key)"
if [[ "$DRY" -eq 1 ]]; then
  [[ -n "$DEST" ]] || die "--dry-run braucht --dest DIR"
  mkdir -p "$DEST"
else
  command -v gh >/dev/null 2>&1 || die "gh fehlt"
fi

get() { "$NODE" "$CLI" get --file "$BUILD/release.json" --path "$1"; }
VERSION="$(get version)"; CHANNEL="$(get channel)"; SHA="$(get git_sha)"
TAG="$(get tag 2>/dev/null || true)"; [[ "$TAG" == "null" ]] && TAG=""
if [[ "$CHANNEL" == stable ]]; then
  [[ -n "$TAG" ]] || die "stable ohne Tag"
  RTAG="$TAG"
else
  RTAG="dev"
fi
echo "Veröffentliche $VERSION (Kanal $CHANNEL) → Release $RTAG"

# Jede Paketsignatur vor dem Hochladen gegen den Schlüssel prüfen.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/dvhub-publish.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
PUB="$(ssh-keygen -y -f "$KEY")"
printf 'dvhub-release namespaces="dvhub-release,dvhub-release-index" %s\n' "$PUB" > "$WORK/allowed"
for f in "$BUILD"/*.tar.gz; do
  [[ -f "$f.sig" ]] || die "Signatur fehlt: $f.sig"
  ssh-keygen -Y verify -f "$WORK/allowed" -I dvhub-release -n dvhub-release -s "$f.sig" < "$f" >/dev/null \
    || die "Signatur von $f passt nicht zu $KEY"
done

# Bisheriger Index des Kanals.
PREV="$WORK/prev.json"
if [[ "$DRY" -eq 1 ]]; then
  [[ -f "$DEST/channels/index-$CHANNEL.json" ]] && cp "$DEST/channels/index-$CHANNEL.json" "$PREV"
else
  gh release download channels -R "$GH_REPO" -p "index-$CHANNEL.json" -O "$PREV" 2>/dev/null || rm -f "$PREV"
fi

# Änderungen: stable aus CHANGELOG.md, dev aus den Commit-Betreffs seit dem
# letzten Index-Stand.
if [[ "$CHANNEL" == stable ]]; then
  git -C "$REPO" show "$SHA:CHANGELOG.md" > "$WORK/CHANGELOG.md" 2>/dev/null || : > "$WORK/CHANGELOG.md"
  "$NODE" "$CLI" changes --changelog "$WORK/CHANGELOG.md" --version "$VERSION" --out "$WORK/changes.json"
else
  PREV_SHA=""
  [[ -f "$PREV" ]] && PREV_SHA="$("$NODE" -e 'const i=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write((i.releases||[])[0]?.git_sha||"")' "$PREV")"
  if [[ -n "$PREV_SHA" ]] && git -C "$REPO" merge-base --is-ancestor "$PREV_SHA" "$SHA" 2>/dev/null; then
    git -C "$REPO" log --format=%s --no-merges "$PREV_SHA..$SHA" | head -30 > "$WORK/subjects.txt"
  else
    git -C "$REPO" log --format=%s --no-merges -10 "$SHA" > "$WORK/subjects.txt"
  fi
  "$NODE" "$CLI" changes --subjects "$WORK/subjects.txt" --out "$WORK/changes.json"
fi
"$NODE" "$CLI" index-entry --release "$BUILD/release.json" --release-tag "$RTAG" --changes "$WORK/changes.json" --out "$WORK/entry.json"
KEEP=10; [[ "$CHANNEL" == dev ]] && KEEP="$KEEP_DEV"
"$NODE" "$CLI" index --channel "$CHANNEL" --prev "$PREV" --release "$WORK/entry.json" --keep "$KEEP" --out "$WORK/index-$CHANNEL.json"
ssh-keygen -Y sign -q -f "$KEY" -n dvhub-release-index "$WORK/index-$CHANNEL.json"

# dev: Assets von Ständen, die nicht mehr im Index stehen, entfernen.
STALE=()
if [[ "$CHANNEL" == dev && -f "$PREV" ]]; then
  while IFS= read -r v; do [[ -n "$v" ]] && STALE+=("$v"); done < <("$NODE" -e '
    const fs=require("fs");const a=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const b=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
    const keep=new Set(b.releases.map(r=>r.version));for(const r of a.releases||[]) if(!keep.has(r.version)) console.log(r.version);' "$PREV" "$WORK/index-$CHANNEL.json")
fi

ASSETS=("$BUILD"/*.tar.gz "$BUILD"/*.tar.gz.sig "$BUILD"/*.manifest.json)
if [[ "$DRY" -eq 1 ]]; then
  mkdir -p "$DEST/$RTAG" "$DEST/channels"
  cp "${ASSETS[@]}" "$DEST/$RTAG/"
  for v in "${STALE[@]+"${STALE[@]}"}"; do rm -f "$DEST/$RTAG/dvhub-$v-"*; done
  cp "$WORK/index-$CHANNEL.json" "$WORK/index-$CHANNEL.json.sig" "$DEST/channels/"
  echo "[dry-run] gh release view $RTAG -R $GH_REPO || gh release create $RTAG -R $GH_REPO $([[ $CHANNEL == dev ]] && echo '--prerelease --target' "$SHA") --title …"
  echo "[dry-run] gh release upload $RTAG -R $GH_REPO --clobber ${ASSETS[*]##*/}"
  for v in "${STALE[@]+"${STALE[@]}"}"; do echo "[dry-run] gh release delete-asset $RTAG dvhub-$v-<arch>.* -R $GH_REPO -y"; done
  echo "[dry-run] gh release view channels -R $GH_REPO || gh release create channels -R $GH_REPO --prerelease --title 'Kanal-Index'"
  echo "[dry-run] gh release upload channels -R $GH_REPO --clobber index-$CHANNEL.json index-$CHANNEL.json.sig"
  echo "Dry-Run fertig: $DEST"
  exit 0
fi

if ! gh release view "$RTAG" -R "$GH_REPO" >/dev/null 2>&1; then
  if [[ "$CHANNEL" == dev ]]; then
    gh release create dev -R "$GH_REPO" --prerelease --target "$SHA" --title "Bleeding Edge (dev)" --notes "Rollierende Pakete aus main. Kanal-Index: channels/index-dev.json"
  else
    gh release create "$RTAG" -R "$GH_REPO" --verify-tag --title "$RTAG" --notes-file <(sed -n "/^## \[$VERSION\]/,/^## \[/p" "$WORK/CHANGELOG.md" | sed '$d')
  fi
fi
gh release upload "$RTAG" -R "$GH_REPO" --clobber "${ASSETS[@]}"
for v in "${STALE[@]+"${STALE[@]}"}"; do
  for a in $(gh release view dev -R "$GH_REPO" --json assets -q ".assets[].name" | grep -F "dvhub-$v-" || true); do
    gh release delete-asset dev "$a" -R "$GH_REPO" -y
  done
done
if ! gh release view channels -R "$GH_REPO" >/dev/null 2>&1; then
  gh release create channels -R "$GH_REPO" --prerelease --title "Kanal-Index" --notes "Signierte Kanal-Indizes der Release-Pakete (docs/release-pakete.md)."
fi
# Index zuletzt: erst wenn alle Pakete oben liegen, zeigt er auf sie.
gh release upload channels -R "$GH_REPO" --clobber "$WORK/index-$CHANNEL.json" "$WORK/index-$CHANNEL.json.sig"
echo "Veröffentlicht: $VERSION ($CHANNEL)"
