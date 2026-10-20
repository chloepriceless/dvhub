#!/bin/sh
# Baut dvhub-eebus (Go, enbility eebus-go) — statisch, ohne CGO, gestrippt.
#
#   dvhub/eebus/build-go.sh <ausgabe-dir> [arch ...]
#       → <ausgabe-dir>/dvhub-eebus-linux-<arch>   (Vorgabe: arm64 amd64)
#   dvhub/eebus/build-go.sh --install <bin-dir> <arch>
#       → <bin-dir>/dvhub-eebus und dvhub-eebus.version (Dockerfile)
#
# Ohne Go im PATH läuft der Bau im Container golang:$GO_VERSION-alpine (Docker
# bzw. Colima; Pfade müssen dann einbindbar sein, z. B. unter /Users statt
# /private/tmp). Abhängigkeiten sind über go.mod/go.sum fest gepinnt.
set -eu

GO_VERSION="${GO_VERSION:-1.27.2}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/go"

usage() {
  echo "usage: build-go.sh <out-dir> [arch ...] | build-go.sh --install <bin-dir> <arch>" >&2
  exit 2
}

[ $# -ge 1 ] || usage
MODE=multi
if [ "$1" = "--install" ]; then
  [ $# -eq 3 ] || usage
  MODE=install
  shift
fi
OUT="$1"
shift
ARCHS="${*:-arm64 amd64}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

if ! command -v go >/dev/null 2>&1; then
  command -v docker >/dev/null 2>&1 || { echo "eebus: weder go noch docker gefunden" >&2; exit 1; }
  CACHE="${EEBUS_GO_CACHE:-$HOME/.cache/dvhub-go}"
  mkdir -p "$CACHE/gopath" "$CACHE/gocache"
  echo "eebus: kein Go im PATH — baue im Container golang:$GO_VERSION-alpine"
  if [ "$MODE" = install ]; then set -- --install /out $ARCHS; else set -- /out $ARCHS; fi
  exec docker run --rm \
    -v "$HERE:/src/eebus:ro" -v "$OUT:/out" -v "$CACHE:/cache" \
    -e GOPATH=/cache/gopath -e GOCACHE=/cache/gocache -e GOFLAGS=-modcacherw \
    -w /src/eebus "golang:$GO_VERSION-alpine" sh /src/eebus/build-go.sh "$@"
fi

EEBUS_GO_VERSION="$(cd "$SRC" && go list -m -f '{{.Version}}' github.com/enbility/eebus-go)"
for arch in $ARCHS; do
  case "$arch" in
    arm64|amd64|arm) ;;
    *) echo "eebus: Architektur $arch nicht unterstützt" >&2; exit 2 ;;
  esac
  if [ "$MODE" = install ]; then target="$OUT/dvhub-eebus"; else target="$OUT/dvhub-eebus-linux-$arch"; fi
  echo "eebus: baue linux/$arch (eebus-go $EEBUS_GO_VERSION)"
  (cd "$SRC" && CGO_ENABLED=0 GOOS=linux GOARCH="$arch" \
    go build -mod=readonly -trimpath -ldflags "-s -w -buildid=" -o "$target.new" .)
  mv -f "$target.new" "$target"
  chmod 0755 "$target"
  echo "eebus: $target ($(wc -c < "$target" | tr -d ' ') Bytes)"
done
if [ "$MODE" = install ]; then
  echo "go+eebus-go@$EEBUS_GO_VERSION" > "$OUT/dvhub-eebus.version"
fi
