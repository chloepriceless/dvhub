#!/usr/bin/env bash
# build-release.sh — baut die signierten Release-Pakete einer Ref lokal auf dem
# Mac (docs/release-pakete.md). Nichts wird veröffentlicht; das macht
# publish-release.sh.
#
#   scripts/release/build-release.sh <tag|ref> [--arch arm64,armhf,amd64]
#       [--out DIR] [--key PFAD | --no-sign] [--repo DIR] [--allowlist DATEI]
#       [--no-eebus] [--npm-cache DIR]
#
# Ablauf: git archive (nur die Ref, kein Arbeitsbaum) → Allowlist → npm ci
# --omit=dev --ignore-scripts → Abhängigkeiten prüfen → je Architektur
# EEBUS-Binary (Go quer, Docker) → deterministisches tar.gz + Manifest →
# ssh-keygen -Y sign. Ergebnis: <out>/<version>/ mit release.json.
set -euo pipefail
export LC_ALL=C

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="$HERE/lib/release-cli.mjs"
NODE="${NODE:-node}"
NPM="${NPM:-npm}"

REF=""
ARCHS="arm64,armhf,amd64"
OUT="${DVHUB_RELEASE_OUT:-$HOME/Projects/dvhub-release-out}"
KEY="${DVHUB_RELEASE_KEY:-$HOME/.config/dvhub-release/release_ed25519}"
SIGN=1
REPO="$(cd "$HERE/../.." && pwd)"
ALLOWLIST="$HERE/allowlist.txt"
EEBUS=1
NPM_CACHE="${DVHUB_RELEASE_NPM_CACHE:-$HOME/.cache/dvhub-release-npm}"
GO_CACHE="${DVHUB_RELEASE_GO_CACHE:-$HOME/.cache/dvhub-go}"
EEBUS_CACHE="${DVHUB_RELEASE_EEBUS_CACHE:-$HOME/.cache/dvhub-release-eebus}"

die() { echo "build-release: $*" >&2; exit 1; }
usage() { die "Aufruf: build-release.sh <tag|ref> [--arch a,b] [--out DIR] [--key PFAD|--no-sign] [--repo DIR] [--allowlist DATEI] [--no-eebus]"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch) ARCHS="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    --key) KEY="${2:-}"; shift 2 ;;
    --no-sign) SIGN=0; shift ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --allowlist) ALLOWLIST="${2:-}"; shift 2 ;;
    --no-eebus) EEBUS=0; shift ;;
    --npm-cache) NPM_CACHE="${2:-}"; shift 2 ;;
    -h|--help) usage ;;
    -*) die "unbekannte Option $1" ;;
    *) [[ -z "$REF" ]] || usage; REF="$1"; shift ;;
  esac
done
[[ -n "$REF" ]] || usage
for a in ${ARCHS//,/ }; do
  case "$a" in arm64|armhf|amd64) ;; *) die "Architektur $a unbekannt (arm64, armhf, amd64)" ;; esac
done
if [[ "$SIGN" -eq 1 ]]; then
  [[ -f "$KEY" ]] || die "Signaturschlüssel $KEY fehlt (--key PFAD oder --no-sign)"
  perm="$(stat -f '%Lp' "$KEY" 2>/dev/null || stat -c '%a' "$KEY")"
  [[ "$perm" == 600 || "$perm" == 400 ]] || die "Schlüssel $KEY muss 0600 sein (ist $perm)"
fi

g() { git -C "$REPO" "$@"; }
SHA="$(g rev-parse --verify --quiet "${REF}^{commit}")" || die "Ref $REF nicht gefunden in $REPO"
TAG=""
if [[ "$REF" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] && g rev-parse --verify --quiet "refs/tags/$REF" >/dev/null; then
  TAG="$REF"
fi
COMMIT_TIME="$(g log -1 --format=%ct "$SHA")"

# Zeitordner unter dem Home (Colima teilt nur das Home in die VM — EEBUS-Bau).
WORK_BASE="${DVHUB_RELEASE_WORK:-$HOME/Projects}"
[[ -d "$WORK_BASE" ]] || WORK_BASE="${TMPDIR:-/tmp}"
WORK="$(mktemp -d "${WORK_BASE%/}/.dvhub-release-build.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
SRC="$WORK/src"; PKG="$WORK/pkg"
mkdir -p "$SRC" "$PKG"

echo "[1/6] git archive $REF ($SHA)"
g archive --format=tar "$SHA" | tar -x -C "$SRC"

PKG_VERSION="$("$NODE" -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)' "$SRC/dvhub/package.json")"
VJSON="$("$NODE" "$CLI" version --tag "$TAG" --pkg-version "$PKG_VERSION" --commit-time "$COMMIT_TIME" --sha "$SHA")"
VERSION="$(echo "$VJSON" | "$NODE" -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).version)')"
CHANNEL="$(echo "$VJSON" | "$NODE" -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).channel)')"
echo "    Version $VERSION, Kanal $CHANNEL"

echo "[2/6] Allowlist"
n="$("$NODE" "$CLI" assemble --src "$SRC" --dest "$PKG" --allowlist "$ALLOWLIST")"
echo "    $n Dateien aus dem Repo"

echo "[3/6] npm ci --omit=dev --ignore-scripts"
[[ -f "$PKG/dvhub/package-lock.json" ]] || die "dvhub/package-lock.json fehlt"
mkdir -p "$NPM_CACHE"
(cd "$PKG/dvhub" && "$NPM" ci --omit=dev --ignore-scripts --no-audit --no-fund --no-update-notifier --loglevel=error --cache "$NPM_CACHE" >/dev/null)
"$NODE" "$CLI" check-deps --app "$PKG/dvhub"
echo "    Abhängigkeiten: keine Install-Skripte, keine nativen Module"

NODE_ENGINE="$("$NODE" -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(p.engines?.node||"")' "$PKG/dvhub/package.json")"
NODE_VERSION_FILE="$(tr -d ' \r\n' < "$SRC/.node-version" 2>/dev/null || true)"
EOS_PIN="$(grep -E '^EOS_PIN=' "$SRC/eos-version.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'"'"'\r' || true)"
EOS_REPO="$(grep -E '^EOS_REPO_URL=' "$SRC/eos-version.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'"'"'\r' || true)"
LOCK_SHA="$(shasum -a 256 "$PKG/dvhub/package-lock.json" | awk '{print $1}')"
NODE_V="$("$NODE" --version)"; NPM_V="$("$NPM" --version)"; ZLIB_V="$("$NODE" -p process.versions.zlib)"

# EEBUS-Binary je Architektur, zwischengespeichert nach Quellstand.
eebus_build() {  # <arch> → Pfad des Ordners mit dvhub-eebus(+.version) oder leer
  local arch="$1" goarch goarm="" gov key dir
  [[ "$EEBUS" -eq 1 && -f "$SRC/dvhub/eebus/build-go.sh" && -f "$SRC/dvhub/eebus/go-toolchain.pin" ]] || return 0
  case "$arch" in arm64) goarch=arm64 ;; amd64) goarch=amd64 ;; armhf) goarch=arm goarm=7 ;; esac
  gov="$(grep -E '^GO_VERSION=' "$SRC/dvhub/eebus/go-toolchain.pin" | tail -1 | cut -d= -f2-)"
  key="$( (cd "$SRC/dvhub/eebus" && find go build-go.sh go-toolchain.pin -type f ! -name '*_test.go' ! -path '*/testdata/*' -print0 | sort -z | xargs -0 shasum -a 256) | shasum -a 256 | cut -c1-16)"
  dir="$EEBUS_CACHE/$gov-$key-$arch"
  if [[ ! -x "$dir/dvhub-eebus" ]]; then
    command -v docker >/dev/null 2>&1 || die "EEBUS: docker fehlt (oder --no-eebus)"
    mkdir -p "$dir.tmp" "$GO_CACHE/gopath" "$GO_CACHE/gocache"
    docker run --rm -v "$SRC/dvhub/eebus:/src/eebus:ro" -v "$dir.tmp:/out" -v "$GO_CACHE:/cache" \
      -e GOPATH=/cache/gopath -e GOCACHE=/cache/gocache -e GOFLAGS=-modcacherw -e GOARM="$goarm" -e GOTOOLCHAIN=local \
      -w /src/eebus "golang:${gov}-alpine" sh /src/eebus/build-go.sh --install /out "$goarch" >&2 \
      || die "EEBUS-Bau für $arch fehlgeschlagen"
    rm -rf "$dir"; mv "$dir.tmp" "$dir"
  fi
  echo "$dir"
}

OUTDIR="$OUT/$VERSION"
rm -rf "$OUTDIR"; mkdir -p "$OUTDIR"
ARTIFACTS="{}"
echo "[4/6] Pakete je Architektur"
for arch in ${ARCHS//,/ }; do
  TREE="$WORK/tree-$arch"
  rm -rf "$TREE"; cp -Rp "$PKG" "$TREE"
  EB="$(eebus_build "$arch")"
  EEBUS_V=""
  if [[ -n "$EB" ]]; then
    mkdir -p "$TREE/dvhub/eebus/dist"
    cp "$EB/dvhub-eebus" "$TREE/dvhub/eebus/dist/dvhub-eebus"
    chmod 0755 "$TREE/dvhub/eebus/dist/dvhub-eebus"
    printf '%s\n' "$arch" > "$TREE/dvhub/eebus/dist/ARCH"
    [[ -f "$EB/dvhub-eebus.version" ]] && cp "$EB/dvhub-eebus.version" "$TREE/dvhub/eebus/dist/dvhub-eebus.version"
    EEBUS_V="$(cat "$EB/dvhub-eebus.version" 2>/dev/null || true)"
  fi
  META="$WORK/meta-$arch.json"
  "$NODE" -e '
    const [version, channel, tag, sha, ct, arch, engine, nv, eosPin, eosRepo, lock, nodeV, npmV, zlibV, eebusV] = process.argv.slice(1);
    const m = { name: "dvhub", version, channel, tag: tag || null, git_sha: sha, commit_time: Number(ct), arch,
      node_engine: engine || null, node_version: nv || null, eos: { repo: eosRepo || null, pin: eosPin || null },
      npm_lockfile_sha256: lock, eebus: eebusV || null, build: { node: nodeV, npm: npmV, zlib: zlibV } };
    process.stdout.write(JSON.stringify(m));
  ' "$VERSION" "$CHANNEL" "$TAG" "$SHA" "$COMMIT_TIME" "$arch" "$NODE_ENGINE" "$NODE_VERSION_FILE" "$EOS_PIN" "$EOS_REPO" "$LOCK_SHA" "$NODE_V" "$NPM_V" "$ZLIB_V" "$EEBUS_V" > "$META"
  RES="$("$NODE" "$CLI" pack --root "$TREE" --out-dir "$OUTDIR" --meta "$META")"
  echo "    $arch: $RES"
  ARTIFACTS="$("$NODE" -e 'const a=JSON.parse(process.argv[1]);const r=JSON.parse(process.argv[2]);a[process.argv[3]]={file:r.file,sha256:r.sha256,size:r.size,sig:r.file+".sig",manifest:r.file.replace(/\.tar\.gz$/,".manifest.json")};process.stdout.write(JSON.stringify(a))' "$ARTIFACTS" "$RES" "$arch")"
  rm -rf "$TREE"
done

echo "[5/6] Signieren"
if [[ "$SIGN" -eq 1 ]]; then
  for f in "$OUTDIR"/*.tar.gz; do
    rm -f "$f.sig"
    ssh-keygen -Y sign -q -f "$KEY" -n dvhub-release "$f" || die "Signatur für $f fehlgeschlagen"
  done
  echo "    mit $(ssh-keygen -l -f "$KEY" | awk '{print $2}')"
else
  echo "    übersprungen (--no-sign)"
fi

echo "[6/6] release.json"
"$NODE" -e '
  const [version, channel, tag, sha, ct, engine, artifacts] = process.argv.slice(1);
  const r = { version, channel, tag: tag || null, git_sha: sha, date: new Date(Number(ct) * 1000).toISOString(),
    node_engine: engine || null, artifacts: JSON.parse(artifacts) };
  process.stdout.write(JSON.stringify(r, null, 2) + "\n");
' "$VERSION" "$CHANNEL" "$TAG" "$SHA" "$COMMIT_TIME" "$NODE_ENGINE" "$ARTIFACTS" > "$OUTDIR/release.json"
echo "Fertig: $OUTDIR"
