#!/usr/bin/env bash
# publish-release.sh — veröffentlicht gebaute Release-Pakete (build-release.sh)
# als GitHub-Release-Assets und schreibt den signierten Kanal-Index
# (docs/release-pakete.md).
#
#   scripts/release/publish-release.sh <build-dir> [--key PFAD]
#       [--sig-scope release|dev] [--bridge [--dev-key PFAD | --release-key-only] [--force-bridge]]
#       [--gh-repo owner/name] [--repo DIR] [--keep-dev N]
#       [--dry-run --dest DIR]
#
# Kanäle und Schlüssel (seit 24.11.2026, dev-Schlüssel):
#   stable                Release-Schlüssel; Pakete Namensraum dvhub-release,
#                         channels/index-stable.json (dvhub-release-index). Unverändert.
#   dev --sig-scope dev   dev-Schlüssel (~/.config/dvhub-release/dev_ed25519, Datei,
#                         kein Agent); Pakete dvhub-release-dev → Release dev,
#                         channels/index-dev-v2.json (dvhub-release-index-dev).
#   dev --bridge          EINMALIG: das Brücken-Paket (erstes dev-Paket mit dem
#                         Prüfcode für den dev-Schlüssel), mit dem Release-Schlüssel
#                         signiert → Release dev-bridge. Setzt die alte
#                         channels/index-dev.json auf genau dieses Paket (danach
#                         eingefroren: kein anderer Weg schreibt sie mehr) und nimmt
#                         es in index-dev-v2.json auf (mit --dev-key signiert).
#   dev --bridge --release-key-only --force-bridge
#                         Notweg ohne dev-Schlüssel (entzogen/verloren): auch
#                         index-dev-v2.json mit dem Release-Schlüssel im alten
#                         Namensraum dvhub-release-index (die Box nimmt ihn für dev an).
#
# Struktur (wie https://github.com/<repo>/releases/download/…):
#   <tag>/dvhub-<v>-<arch>.tar.gz(.sig, .manifest.json)    stable: Tag vX.Y.Z
#   dev/…                                                  dev: rollierendes Vorab-Release
#   dev-bridge/…                                           Brücken-Paket (nie weggeräumt)
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
KEY=""
DEV_KEY="${DVHUB_RELEASE_DEV_KEY:-$HOME/.config/dvhub-release/dev_ed25519}"
SCOPE="${DVHUB_RELEASE_SIG_SCOPE:-release}"
BRIDGE=0
FORCE_BRIDGE=0
RELEASE_KEY_ONLY=0
GH_REPO="chloepriceless/dvhub"
REPO="$(cd "$HERE/../.." && pwd)"
KEEP_DEV=3
DRY=0
DEST=""

die() { echo "publish-release: $*" >&2; exit 1; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --key) KEY="${2:-}"; shift 2 ;;
    --dev-key) DEV_KEY="${2:-}"; shift 2 ;;
    --sig-scope) SCOPE="${2:-}"; shift 2 ;;
    --bridge) BRIDGE=1; shift ;;
    --force-bridge) FORCE_BRIDGE=1; shift ;;
    --release-key-only) RELEASE_KEY_ONLY=1; shift ;;
    --gh-repo) GH_REPO="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --keep-dev) KEEP_DEV="${2:-}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --dest) DEST="${2:-}"; shift 2 ;;
    -*) die "unbekannte Option $1" ;;
    *) [[ -z "$BUILD" ]] || die "nur ein Build-Ordner"; BUILD="$1"; shift ;;
  esac
done
case "$SCOPE" in
  release) KEY="${KEY:-${DVHUB_RELEASE_KEY:-$HOME/.config/dvhub-release/release_ed25519}}" ;;
  dev) KEY="${KEY:-$DEV_KEY}" ;;
  *) die "--sig-scope release oder dev" ;;
esac
[[ -n "$BUILD" && -f "$BUILD/release.json" ]] || die "Build-Ordner mit release.json angeben"
[[ -f "$KEY" ]] || die "Signaturschlüssel $KEY fehlt (--key)"
if [[ "$DRY" -eq 1 ]]; then
  [[ -n "$DEST" ]] || die "--dry-run braucht --dest DIR"
  mkdir -p "$DEST"
fi

get() { "$NODE" "$CLI" get --file "$BUILD/release.json" --path "$1"; }
VERSION="$(get version)"; CHANNEL="$(get channel)"; SHA="$(get git_sha)"
TAG="$(get tag 2>/dev/null || true)"; [[ "$TAG" == "null" ]] && TAG=""
NS_PKG=dvhub-release
# Je zu schreibendem Index: Name|Schlüssel|Namensraum|Vorgänger-Modus
# (live = bisherigen lebenden Index fortschreiben, fresh = nur dieses Paket).
INDEXES=()
if [[ "$CHANNEL" == stable ]]; then
  [[ -n "$TAG" ]] || die "stable ohne Tag"
  [[ "$SCOPE" == release && "$BRIDGE" -eq 0 && "$RELEASE_KEY_ONLY" -eq 0 ]] || die "stable nur mit dem Release-Schlüssel (kein --sig-scope dev, kein --bridge)"
  RTAG="$TAG"
  INDEXES=("index-stable.json|$KEY|dvhub-release-index|live")
else
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
  if [[ "$BRIDGE" -eq 1 ]]; then
    [[ "$SCOPE" == release ]] || die "--bridge signiert das Paket mit dem Release-Schlüssel (ohne --sig-scope dev)"
    [[ "$RELEASE_KEY_ONLY" -eq 1 || -f "$DEV_KEY" ]] || die "dev-Schlüssel $DEV_KEY fehlt (--dev-key) — er signiert index-dev-v2.json (Notweg: --release-key-only)"
    # Das Brücken-Paket muss den Prüfcode für den dev-Schlüssel mitbringen,
    # sonst hingen alte Boxen nach der Brücke fest.
    # (Inhalt erst in Variablen: grep -q an einer Pipe bricht unter pipefail ab.)
    helper_src="$(git -C "$REPO" show "$SHA:dvhub-release.cjs" 2>/dev/null || true)"
    [[ "$helper_src" == *index-dev-v2.json* && "$helper_src" == *dvhub-release-index-dev* ]] \
      || die "Commit ${SHA:0:12} bringt den neuen Prüfcode (index-dev-v2.json) nicht mit — taugt nicht als Brücke"
    RTAG="dev-bridge"
    if [[ "$RELEASE_KEY_ONLY" -eq 1 ]]; then
      INDEXES=("index-dev.json|$KEY|dvhub-release-index|fresh" "index-dev-v2.json|$KEY|dvhub-release-index|live")
    else
      trust_src="$(git -C "$REPO" show "$SHA:release-keys/allowed_signers" 2>/dev/null || true)"
      dev_pub="$(awk 'NR==1{print $2}' "$DEV_KEY.pub" 2>/dev/null || true)"
      [[ -n "$dev_pub" ]] && printf '%s\n' "$trust_src" | grep -v '^#' | grep -F "$dev_pub" | grep -F 'namespaces="dvhub-release-dev,dvhub-release-index-dev"' >/dev/null \
        || die "release-keys/allowed_signers in ${SHA:0:12} enthält den dev-Schlüssel ($DEV_KEY.pub) nicht mit den dev-Namensräumen"
      INDEXES=("index-dev.json|$KEY|dvhub-release-index|fresh" "index-dev-v2.json|$DEV_KEY|dvhub-release-index-dev|live")
    fi
  elif [[ "$SCOPE" == dev ]]; then
    NS_PKG=dvhub-release-dev
    RTAG="dev"
    INDEXES=("index-dev-v2.json|$KEY|dvhub-release-index-dev|live")
  else
    die "dev-Pakete: --sig-scope dev (dev-Schlüssel) oder einmalig --bridge — index-dev.json ist eingefroren (docs/release-pakete.md)"
  fi
fi
if [[ "$DRY" -ne 1 ]]; then
  command -v gh >/dev/null 2>&1 || die "gh fehlt"
fi
echo "Veröffentliche $VERSION (Kanal $CHANNEL$([[ $BRIDGE -eq 1 ]] && echo ', Brücke')) → Release $RTAG"

# Signieren: der dev-Schlüssel ist eine Datei — nie über einen Agenten (kein
# 1Password-Dialog); der Release-Schlüssel wie bisher (Agent oder Passphrase).
sign_with() {  # <schlüssel> <namensraum> <datei>
  if [[ "$1" == "$DEV_KEY" || "$SCOPE" == dev ]]; then
    env -u SSH_AUTH_SOCK ssh-keygen -Y sign -q -f "$1" -n "$2" "$3" </dev/null
  else
    ssh-keygen -Y sign -q -f "$1" -n "$2" "$3"
  fi
}
pubkey_of() {  # <schlüssel> → "typ base64"
  # Öffentlicher Schlüssel aus KEY.pub, wenn vorhanden: ein Schlüssel mit
  # Passphrase im ssh-agent signiert ohne Rückfrage, `ssh-keygen -y` fragt aber
  # trotzdem nach der Passphrase (Release-Probe 02.11.2026). Passt die .pub nicht
  # zum Signaturschlüssel, scheitert die Prüfung gleich darunter.
  if [[ -f "$1.pub" ]]; then awk 'NR==1{print $1" "$2}' "$1.pub"; else ssh-keygen -y -f "$1"; fi
}

# Jede Paketsignatur vor dem Hochladen gegen den Schlüssel prüfen.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/dvhub-publish.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
printf 'dvhub-release namespaces="%s" %s\n' "$NS_PKG" "$(pubkey_of "$KEY")" > "$WORK/allowed"
for f in "$BUILD"/*.tar.gz; do
  [[ -f "$f.sig" ]] || die "Signatur fehlt: $f.sig"
  ssh-keygen -Y verify -f "$WORK/allowed" -I dvhub-release -n "$NS_PKG" -s "$f.sig" < "$f" >/dev/null \
    || die "Signatur von $f passt nicht zu $KEY (Namensraum $NS_PKG)"
done

# Assets des Vorab-Releases channels (gh api …/releases/tags/channels, JSON).
CHANNELS_JSON="$WORK/channels-release.json"
fetch_channels() { gh api "repos/$GH_REPO/releases/tags/channels" > "$CHANNELS_JSON" 2> "$WORK/gh-channels.err"; }
asset_id() {  # $1 = Asset-Name → ID auf stdout, Exit 1 wenn es ihn nicht gibt
  "$NODE" -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const a=(r.assets||[]).find((x)=>x.name===process.argv[2]);if(!a)process.exit(1);process.stdout.write(String(a.id))' "$CHANNELS_JSON" "$1"
}
valid_index() { "$NODE" -e 'const i=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(!Array.isArray(i.releases))process.exit(1)' "$1" 2>/dev/null; }

# Bisheriger Index je Name. Nur „gibt es nicht“ (kein Release channels, kein
# Index dieses Namens) heißt: ohne Vorgänger bauen. Jeder andere Fehler (Netz,
# Anmeldung, Rate-Limit) bricht ab, bevor etwas hochgeht — sonst enthielte der
# neue Index nur diese Version, und der Rückweg auf die vorige fehlte (Fable R3,
# P3-6). Vom lebenden Stand bleibt eine Kopie samt Signatur für die
# Wiederherstellung (restore/<name>).
CHANNELS_OK=0
if [[ "$DRY" -ne 1 ]]; then
  if fetch_channels; then CHANNELS_OK=1
  elif grep -q 'HTTP 404' "$WORK/gh-channels.err"; then :  # noch kein Release channels: erster Index
  else die "Kanal-Index nicht abrufbar ($(tr '\n' ' ' < "$WORK/gh-channels.err" | cut -c1-300)) — Abbruch, nichts hochgeladen"
  fi
fi
fetch_prev() {  # <name> <ziel> — legt <ziel> an, wenn es einen Vorgänger gibt
  local name="$1" dest="$2" cand
  rm -f "$dest"
  if [[ "$DRY" -eq 1 ]]; then
    [[ -f "$DEST/channels/$name" ]] && cp "$DEST/channels/$name" "$dest"
    if [[ -f "$DEST/channels/$name" && -f "$DEST/channels/$name.sig" ]]; then
      mkdir -p "$WORK/restore"; cp "$DEST/channels/$name" "$DEST/channels/$name.sig" "$WORK/restore/"
    fi
    return 0
  fi
  [[ "$CHANNELS_OK" -eq 1 ]] || return 0
  # Lebender Index; fehlt er nach einer unterbrochenen Umstellung, der
  # Zwischenstand (.new, enthält den Vorgänger) — nie still ohne Vorgänger
  # (Codex 9f40b69c).
  for cand in "$name" "$name.new"; do
    asset_id "$cand" >/dev/null || continue
    rm -f "$dest"
    gh release download channels -R "$GH_REPO" -p "$cand" -O "$dest" \
      || die "bisheriger Kanal-Index $cand nicht ladbar — Abbruch (sonst fehlte der Vorgänger im neuen Index)"
    if valid_index "$dest"; then
      if [[ "$cand" == "$name" ]]; then
        if asset_id "$name.sig" >/dev/null; then
          mkdir -p "$WORK/restore"
          cp "$dest" "$WORK/restore/$name"
          gh release download channels -R "$GH_REPO" -p "$name.sig" -O "$WORK/restore/$name.sig" \
            || die "Signatur des bisherigen Kanal-Index nicht ladbar — Abbruch"
        fi
      else
        echo "publish-release: Hinweis: lebender Index fehlt, Vorgänger aus $cand (unterbrochene Veröffentlichung)" >&2
      fi
      return 0
    fi
    [[ "$cand" == "$name" ]] && die "bisheriger Kanal-Index $cand ist kein gültiger Index — Abbruch"
    rm -f "$dest"
  done
  return 0
}

# index-dev-v2.json gilt auch als vorhanden, wenn nach einer unterbrochenen
# Umstellung nur der Zwischenstand .new liegt — fetch_prev holt ihn (Codex ac5e49a1).
v2_exists() { asset_id index-dev-v2.json >/dev/null || asset_id index-dev-v2.json.new >/dev/null; }
# Brücke nur einmal: steht index-dev-v2.json schon, ist der Übergang erledigt —
# eine zweite Brücke würde die eingefrorene index-dev.json umsetzen.
if [[ "$BRIDGE" -eq 1 && "$FORCE_BRIDGE" -ne 1 ]]; then
  if { [[ "$DRY" -eq 1 && -f "$DEST/channels/index-dev-v2.json" ]]; } \
      || { [[ "$DRY" -ne 1 && "$CHANNELS_OK" -eq 1 ]] && v2_exists; }; then
    die "index-dev-v2.json gibt es schon — die Brücke ist erledigt (erneut nur mit --force-bridge)"
  fi
fi
# dev-Schlüssel erst nach der Brücke: ohne index-dev-v2.json fände kein Paket
# zu alten Boxen, und die eingefrorene index-dev.json bekäme nie die Brücke.
if [[ "$CHANNEL" == dev && "$BRIDGE" -eq 0 ]]; then
  if { [[ "$DRY" -eq 1 && ! -f "$DEST/channels/index-dev-v2.json" ]]; } \
      || { [[ "$DRY" -ne 1 ]] && ! { [[ "$CHANNELS_OK" -eq 1 ]] && v2_exists; }; }; then
    die "index-dev-v2.json fehlt — erst das Brücken-Paket veröffentlichen (--bridge mit dem Release-Schlüssel, docs/release-pakete.md)"
  fi
fi

# Vorgänger je Index holen.
for spec in "${INDEXES[@]}"; do
  IFS='|' read -r name _ _ mode <<< "$spec"
  fetch_prev "$name" "$WORK/prev-$name"
  if [[ "$mode" == fresh && -f "$WORK/prev-$name" ]]; then mv -f "$WORK/prev-$name" "$WORK/old-$name"; fi
done

# Änderungen: stable aus CHANGELOG.md, dev aus den Commit-Betreffs seit dem
# letzten Index-Stand (dev: index-dev-v2.json, sonst die alte index-dev.json).
if [[ "$CHANNEL" == stable ]]; then
  git -C "$REPO" show "$SHA:CHANGELOG.md" > "$WORK/CHANGELOG.md" 2>/dev/null || : > "$WORK/CHANGELOG.md"
  "$NODE" "$CLI" changes --changelog "$WORK/CHANGELOG.md" --version "$VERSION" --out "$WORK/changes.json"
else
  PREV_SHA=""
  for f in "$WORK/prev-index-dev-v2.json" "$WORK/old-index-dev.json"; do
    [[ -f "$f" ]] || continue
    PREV_SHA="$("$NODE" -e 'const i=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write((i.releases||[])[0]?.git_sha||"")' "$f")"
    [[ -n "$PREV_SHA" ]] && break
  done
  if [[ -n "$PREV_SHA" ]] && git -C "$REPO" merge-base --is-ancestor "$PREV_SHA" "$SHA" 2>/dev/null; then
    # -n 30 statt `| head -30`: unter pipefail bricht git log sonst mit SIGPIPE ab (Exit 141),
    # sobald seit dem vorigen Paket mehr als 30 Betreffe anfallen (21.11.2026).
    git -C "$REPO" log -n 30 --format=%s --no-merges "$PREV_SHA..$SHA" > "$WORK/subjects.txt"
  else
    git -C "$REPO" log --format=%s --no-merges -10 "$SHA" > "$WORK/subjects.txt"
  fi
  "$NODE" "$CLI" changes --subjects "$WORK/subjects.txt" --out "$WORK/changes.json"
fi
"$NODE" "$CLI" index-entry --release "$BUILD/release.json" --release-tag "$RTAG" --changes "$WORK/changes.json" --out "$WORK/entry.json"
KEEP=10; [[ "$CHANNEL" == dev ]] && KEEP="$KEEP_DEV"
for spec in "${INDEXES[@]}"; do
  IFS='|' read -r name key ns mode <<< "$spec"
  "$NODE" "$CLI" index --channel "$CHANNEL" --prev "$WORK/prev-$name" --release "$WORK/entry.json" --keep "$KEEP" --out "$WORK/$name"
  sign_with "$key" "$ns" "$WORK/$name"
  # Gegenprobe: die Signatur passt zu genau diesem Schlüssel und Namensraum.
  printf 'dvhub-release namespaces="%s" %s\n' "$ns" "$(pubkey_of "$key")" > "$WORK/allowed-idx"
  ssh-keygen -Y verify -f "$WORK/allowed-idx" -I dvhub-release -n "$ns" -s "$WORK/$name.sig" < "$WORK/$name" >/dev/null \
    || die "Signatur von $name passt nicht zu $key ($ns)"
done

# dev: Assets von Ständen, die nicht mehr im fortgeschriebenen Index stehen,
# aus dem Release dev entfernen (nie aus dev-bridge).
STALE=()
if [[ "$CHANNEL" == dev && -f "$WORK/prev-index-dev-v2.json" ]]; then
  while IFS= read -r v; do [[ -n "$v" ]] && STALE+=("$v"); done < <("$NODE" -e '
    const fs=require("fs");const a=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const b=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
    const keep=new Set(b.releases.map(r=>r.version));for(const r of a.releases||[]) if(!keep.has(r.version)) console.log(r.version);' "$WORK/prev-index-dev-v2.json" "$WORK/index-dev-v2.json")
fi

ASSETS=("$BUILD"/*.tar.gz "$BUILD"/*.tar.gz.sig "$BUILD"/*.manifest.json)
if [[ "$DRY" -eq 1 ]]; then
  mkdir -p "$DEST/$RTAG" "$DEST/channels"
  cp "${ASSETS[@]}" "$DEST/$RTAG/"
  for v in "${STALE[@]+"${STALE[@]}"}"; do rm -f "$DEST/dev/dvhub-$v-"*; done
  for spec in "${INDEXES[@]}"; do
    IFS='|' read -r name _ <<< "$spec"
    cp "$WORK/$name" "$WORK/$name.sig" "$DEST/channels/"
  done
  echo "[dry-run] gh release view $RTAG -R $GH_REPO || gh release create $RTAG -R $GH_REPO $([[ $CHANNEL == dev ]] && echo '--prerelease --target' "$SHA") --title …"
  echo "[dry-run] gh release upload $RTAG -R $GH_REPO --clobber ${ASSETS[*]##*/}"
  for v in "${STALE[@]+"${STALE[@]}"}"; do echo "[dry-run] gh release delete-asset dev dvhub-$v-<arch>.* -R $GH_REPO -y"; done
  echo "[dry-run] gh release view channels -R $GH_REPO || gh release create channels -R $GH_REPO --prerelease --title 'Kanal-Index'"
  for (( i = ${#INDEXES[@]} - 1; i >= 0; i-- )); do   # gleiche Reihenfolge wie unten (Brücke: v2 zuerst)
    IFS='|' read -r name _ <<< "${INDEXES[$i]}"
    echo "[dry-run] gh release upload channels -R $GH_REPO --clobber $name.sig.new $name.new"
    echo "[dry-run] umbenennen (gh api PATCH …/releases/assets/<id>): $name.sig.new → .sig, dann $name.new → $name"
  done
  echo "Dry-Run fertig: $DEST"
  exit 0
fi

if ! gh release view "$RTAG" -R "$GH_REPO" >/dev/null 2>&1; then
  if [[ "$RTAG" == dev ]]; then
    gh release create dev -R "$GH_REPO" --prerelease --target "$SHA" --title "Bleeding Edge (dev)" --notes "Rollierende Pakete aus main. Kanal-Index: channels/index-dev-v2.json"
  elif [[ "$RTAG" == dev-bridge ]]; then
    gh release create dev-bridge -R "$GH_REPO" --prerelease --target "$SHA" --title "Bleeding Edge — Brücke" --notes "Brücken-Paket für Boxen mit älterem Prüfcode (eingefrorene channels/index-dev.json). Nicht löschen."
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
#
# Umstellen (Codex 9f40b69c, 8f94225c): je Datei den lebenden Stand löschen
# und den Zwischenstand umbenennen, erst die Signatur, dann den Index.
# Scheitert ein Schritt — auch einer, dessen Antwort nur verloren ging —,
# lädt das Skript das vorher geholte lebende Paar wieder unter den lebenden
# Namen hoch (--clobber, gleich welcher Zwischenzustand am Release liegt) und
# prüft danach am Release, dass Index und Signatur in alter Größe da sind.
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
restore() {  # $1 = Index-Name, $2 = gescheiterter Schritt
  local IDX="$1" SIG="$1.sig" RESTORE="$WORK/restore"
  if [[ ! -f "$RESTORE/$IDX" || ! -f "$RESTORE/$SIG" ]]; then
    die "Umstellen gescheitert ($2); es gab kein altes Paar zum Wiederherstellen — Zwischenstand prüfen und erneut ausführen"
  fi
  # Dauerhafte Kopie außerhalb von $WORK (der EXIT-Trap löscht $WORK): scheitert
  # auch das Hochladen, bleibt das alte Paar für die Hand-Reparatur (Codex 11f469a2).
  local keep="$BUILD/channels-restore"
  mkdir -p "$keep" && cp "$RESTORE/$IDX" "$RESTORE/$SIG" "$keep/" \
    || echo "publish-release: Warnung: Kopie des alten Paars nach $keep gescheitert" >&2
  gh release upload channels -R "$GH_REPO" --clobber "$RESTORE/$SIG" "$RESTORE/$IDX" \
    || die "Umstellen gescheitert ($2) und Wiederherstellen gescheitert — altes Paar liegt in $keep; von Hand hochladen: gh release upload channels -R $GH_REPO --clobber $keep/$SIG $keep/$IDX (erst danach erneut veröffentlichen, sonst fehlt der Vorgänger)"
  if fetch_channels \
      && [[ "$(asset_size "$IDX" || true)" == "$(wc -c < "$RESTORE/$IDX" | tr -d ' ')" ]] \
      && [[ "$(asset_size "$SIG" || true)" == "$(wc -c < "$RESTORE/$SIG" | tr -d ' ')" ]]; then
    # Bestätigt wiederhergestellt: die Kopie bleibt (Codex 11f469a2), bekommt aber
    # die Marke „bestaetigt“ — nur ohne sie hält der dev-Worker an (Codex 3aa7d678).
    date -u +%FT%TZ > "$keep/bestaetigt" 2>/dev/null || true
    die "Umstellen gescheitert ($2) — alter Index samt Signatur wiederhergestellt; erneut ausführen"
  fi
  die "Umstellen gescheitert ($2); Wiederherstellen nicht bestätigt — am Release channels von Hand prüfen ($IDX, $SIG)"
}
UP="$WORK/up"
mkdir -p "$UP"
# Brücke: zuerst index-dev-v2.json (neue Boxen), zuletzt die alte index-dev.json —
# so zeigt die eingefrorene Datei erst dann auf die Brücke, wenn auch der Weg
# danach (v2) steht.
for (( i = ${#INDEXES[@]} - 1; i >= 0; i-- )); do
  IFS='|' read -r name _ <<< "${INDEXES[$i]}"
  cp "$WORK/$name" "$UP/$name.new"
  cp "$WORK/$name.sig" "$UP/$name.sig.new"
  gh release upload channels -R "$GH_REPO" --clobber "$UP/$name.sig.new" "$UP/$name.new"
  promote "$name.sig" || restore "$name" "$name.sig"
  promote "$name" || restore "$name" "$name"
done
echo "Veröffentlicht: $VERSION ($CHANNEL$([[ $BRIDGE -eq 1 ]] && echo ', Brücke'))"
