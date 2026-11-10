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
fi

get() { "$NODE" "$CLI" get --file "$BUILD/release.json" --path "$1"; }
VERSION="$(get version)"; CHANNEL="$(get channel)"; SHA="$(get git_sha)"
TAG="$(get tag 2>/dev/null || true)"; [[ "$TAG" == "null" ]] && TAG=""
if [[ "$CHANNEL" == stable ]]; then
  [[ -n "$TAG" ]] || die "stable ohne Tag"
  RTAG="$TAG"
else
  RTAG="dev"
  # dev-Pakete nur aus veröffentlichtem Code (Christin 05.11.2026: von Hand
  # aus main gebaut): der Commit muss auf origin/main liegen. Sonst ginge ein
  # lokaler, ungepushter Stand — etwa ein privater Sicherheits-Zweig — als
  # signiertes Paket an alle Boxen auf Bleeding Edge. Stand von origin/main
  # vorher mit `git fetch` holen. Im Dry-Run nur ein Hinweis.
  if ! git -C "$REPO" rev-parse --verify --quiet refs/remotes/origin/main >/dev/null \
      || ! git -C "$REPO" merge-base --is-ancestor "$SHA" refs/remotes/origin/main 2>/dev/null; then
    msg="Commit ${SHA:0:12} liegt nicht auf origin/main (erst pushen bzw. git fetch) — dev-Pakete nur aus veröffentlichtem main"
    if [[ "$DRY" -eq 1 ]]; then echo "publish-release: Hinweis: $msg" >&2; else die "$msg"; fi
  fi
fi
if [[ "$DRY" -ne 1 ]]; then
  command -v gh >/dev/null 2>&1 || die "gh fehlt"
fi
echo "Veröffentliche $VERSION (Kanal $CHANNEL) → Release $RTAG"

# Jede Paketsignatur vor dem Hochladen gegen den Schlüssel prüfen.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/dvhub-publish.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
# Öffentlicher Schlüssel aus KEY.pub, wenn vorhanden: ein Schlüssel mit
# Passphrase im ssh-agent signiert ohne Rückfrage, `ssh-keygen -y` fragt aber
# trotzdem nach der Passphrase (Release-Probe 02.11.2026). Passt die .pub nicht
# zum Signaturschlüssel, scheitert die Prüfung gleich darunter.
if [[ -f "$KEY.pub" ]]; then PUB="$(awk 'NR==1{print $1" "$2}' "$KEY.pub")"; else PUB="$(ssh-keygen -y -f "$KEY")"; fi
printf 'dvhub-release namespaces="dvhub-release,dvhub-release-index" %s\n' "$PUB" > "$WORK/allowed"
for f in "$BUILD"/*.tar.gz; do
  [[ -f "$f.sig" ]] || die "Signatur fehlt: $f.sig"
  ssh-keygen -Y verify -f "$WORK/allowed" -I dvhub-release -n dvhub-release -s "$f.sig" < "$f" >/dev/null \
    || die "Signatur von $f passt nicht zu $KEY"
done

# Assets des Vorab-Releases channels (gh api …/releases/tags/channels, JSON).
CHANNELS_JSON="$WORK/channels-release.json"
fetch_channels() { gh api "repos/$GH_REPO/releases/tags/channels" > "$CHANNELS_JSON" 2> "$WORK/gh-channels.err"; }
asset_id() {  # $1 = Asset-Name → ID auf stdout, Exit 1 wenn es ihn nicht gibt
  "$NODE" -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const a=(r.assets||[]).find((x)=>x.name===process.argv[2]);if(!a)process.exit(1);process.stdout.write(String(a.id))' "$CHANNELS_JSON" "$1"
}

# Bisheriger Index des Kanals. Nur „gibt es nicht“ (kein Release channels, kein
# Index dieses Kanals) heißt: ohne Vorgänger bauen. Jeder andere Fehler (Netz,
# Anmeldung, Rate-Limit) bricht ab, bevor etwas hochgeht — sonst enthielte der
# neue Index nur diese Version, und der Rückweg auf die vorige fehlte (Fable R3,
# P3-6).
PREV="$WORK/prev.json"
# Kopie des lebenden Paars (Index + Signatur) für die Wiederherstellung.
RESTORE="$WORK/restore"
valid_index() { "$NODE" -e 'const i=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(!Array.isArray(i.releases))process.exit(1)' "$1" 2>/dev/null; }
if [[ "$DRY" -eq 1 ]]; then
  [[ -f "$DEST/channels/index-$CHANNEL.json" ]] && cp "$DEST/channels/index-$CHANNEL.json" "$PREV"
else
  if fetch_channels; then
    # Lebender Index; fehlt er nach einer unterbrochenen Umstellung, der
    # Zwischenstand (.new, enthält den Vorgänger) — nie still ohne Vorgänger
    # (Codex 9f40b69c). Vom lebenden Stand bleibt eine Kopie samt Signatur für
    # die Wiederherstellung unten (RESTORE).
    for cand in "index-$CHANNEL.json" "index-$CHANNEL.json.new"; do
      asset_id "$cand" >/dev/null || continue
      rm -f "$PREV"
      gh release download channels -R "$GH_REPO" -p "$cand" -O "$PREV" \
        || die "bisheriger Kanal-Index $cand nicht ladbar — Abbruch (sonst fehlte der Vorgänger im neuen Index)"
      if valid_index "$PREV"; then
        if [[ "$cand" == "index-$CHANNEL.json" ]]; then
          if asset_id "index-$CHANNEL.json.sig" >/dev/null; then
            mkdir -p "$RESTORE"
            cp "$PREV" "$RESTORE/index-$CHANNEL.json"
            gh release download channels -R "$GH_REPO" -p "index-$CHANNEL.json.sig" -O "$RESTORE/index-$CHANNEL.json.sig" \
              || die "Signatur des bisherigen Kanal-Index nicht ladbar — Abbruch"
          fi
        else
          echo "publish-release: Hinweis: lebender Index fehlt, Vorgänger aus $cand (unterbrochene Veröffentlichung)" >&2
        fi
        break
      fi
      [[ "$cand" == "index-$CHANNEL.json" ]] && die "bisheriger Kanal-Index $cand ist kein gültiger Index — Abbruch"
      rm -f "$PREV"
    done
  elif grep -q 'HTTP 404' "$WORK/gh-channels.err"; then
    :  # noch kein Release channels: erster Index
  else
    die "Kanal-Index nicht abrufbar ($(tr '\n' ' ' < "$WORK/gh-channels.err" | cut -c1-300)) — Abbruch, nichts hochgeladen"
  fi
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
  echo "[dry-run] gh release upload channels -R $GH_REPO --clobber index-$CHANNEL.json.sig.new index-$CHANNEL.json.new"
  echo "[dry-run] umbenennen (gh api PATCH …/releases/assets/<id>): index-$CHANNEL.json.sig.new → .sig, dann index-$CHANNEL.json.new → index-$CHANNEL.json"
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
# Möglichst atomar (Fable R3, P3-6): beide Dateien erst unter Zwischennamen
# hochladen — scheitert das, bleiben alter Index und alte Signatur gültig —,
# dann umbenennen, erst die Signatur, dann den Index. Während des Umstellens
# (kurze API-Aufrufe) sieht eine prüfende Box für einen Augenblick keinen Index
# oder Index und Signatur aus verschiedenen Ständen; ihre Prüfung schlägt dann
# einmal fehl und gelingt beim nächsten Prüfen (nichts wird installiert).
UP="$WORK/up"
mkdir -p "$UP"
cp "$WORK/index-$CHANNEL.json" "$UP/index-$CHANNEL.json.new"
cp "$WORK/index-$CHANNEL.json.sig" "$UP/index-$CHANNEL.json.sig.new"
gh release upload channels -R "$GH_REPO" --clobber "$UP/index-$CHANNEL.json.sig.new" "$UP/index-$CHANNEL.json.new"
# Umstellen (Codex 9f40b69c, 8f94225c): je Datei den lebenden Stand löschen
# und den Zwischenstand umbenennen, erst die Signatur, dann den Index.
# Scheitert ein Schritt — auch einer, dessen Antwort nur verloren ging —,
# lädt das Skript das vorher geholte lebende Paar wieder unter den lebenden
# Namen hoch (--clobber, gleich welcher Zwischenzustand am Release liegt) und
# prüft danach am Release, dass Index und Signatur in alter Größe da sind.
IDX="index-$CHANNEL.json"
SIG="index-$CHANNEL.json.sig"
gh_rename() { gh api -X PATCH "repos/$GH_REPO/releases/assets/$1" -f "name=$2" >/dev/null; }
gh_delete() { gh api -X DELETE "repos/$GH_REPO/releases/assets/$1" >/dev/null; }
asset_size() {  # $1 = Asset-Name → Größe auf stdout, Exit 1 wenn es ihn nicht gibt
  "$NODE" -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const a=(r.assets||[]).find((x)=>x.name===process.argv[2]);if(!a)process.exit(1);process.stdout.write(String(a.size))' "$CHANNELS_JSON" "$1"
}
promote() {  # $1 = lebender Name; $1.new liegt oben
  local new_id live_id
  fetch_channels || return 1
  new_id="$(asset_id "$1.new")" || return 1
  if live_id="$(asset_id "$1")"; then gh_delete "$live_id" || return 1; fi
  gh_rename "$new_id" "$1"
}
restore() {
  if [[ ! -f "$RESTORE/$IDX" || ! -f "$RESTORE/$SIG" ]]; then
    die "Umstellen gescheitert ($1); es gab kein altes Paar zum Wiederherstellen — Zwischenstand prüfen und erneut ausführen"
  fi
  gh release upload channels -R "$GH_REPO" --clobber "$RESTORE/$SIG" "$RESTORE/$IDX" \
    || die "Umstellen gescheitert ($1) und Wiederherstellen gescheitert — am Release channels von Hand prüfen ($IDX, $SIG); ein erneuter Lauf nimmt den Vorgänger aus dem lebenden Index bzw. $IDX.new"
  if fetch_channels \
      && [[ "$(asset_size "$IDX" || true)" == "$(wc -c < "$RESTORE/$IDX" | tr -d ' ')" ]] \
      && [[ "$(asset_size "$SIG" || true)" == "$(wc -c < "$RESTORE/$SIG" | tr -d ' ')" ]]; then
    die "Umstellen gescheitert ($1) — alter Index samt Signatur wiederhergestellt; erneut ausführen"
  fi
  die "Umstellen gescheitert ($1); Wiederherstellen nicht bestätigt — am Release channels von Hand prüfen ($IDX, $SIG)"
}
promote "$SIG" || restore "$SIG"
promote "$IDX" || restore "$IDX"
echo "Veröffentlicht: $VERSION ($CHANNEL)"
