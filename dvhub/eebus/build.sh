#!/usr/bin/env bash
# Build dvhub-eebus (EEBUS node of DVhub) against the pinned openeebus commit.
#
#   dvhub/eebus/build.sh <install-dir>        e.g. /opt/dvhub/bin
#
# Needs: a C toolchain, cmake, pkg-config, curl or wget, patch, and the
# development packages of openssl, libwebsockets, cjson and avahi-client
# (Debian: see eebus-provision.sh; Alpine: see the Dockerfile). The build
# works in a temporary directory and only installs the finished binary.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:?usage: build.sh <install-dir>}"
# shellcheck source=openeebus.pin
. "$HERE/openeebus.pin"
WORK="${EEBUS_BUILD_DIR:-$(mktemp -d)}"
KEEP_WORK="${EEBUS_BUILD_DIR:+1}"
cleanup() { [ -n "$KEEP_WORK" ] || rm -rf "$WORK"; }
trap cleanup EXIT
mkdir -p "$WORK"

SRC="$WORK/openeebus-$OPENEEBUS_COMMIT"
if [ ! -d "$SRC" ]; then
  url="https://codeload.github.com/NIBEGroup/openeebus/tar.gz/$OPENEEBUS_COMMIT"
  echo "eebus: lade openeebus $OPENEEBUS_COMMIT"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$WORK/openeebus.tgz"
  else
    wget -q "$url" -O "$WORK/openeebus.tgz"
  fi
  echo "$OPENEEBUS_SHA256  $WORK/openeebus.tgz" | sha256sum -c - >/dev/null \
    || { echo "eebus: Prüfsumme von openeebus stimmt nicht" >&2; exit 1; }
  tar -xzf "$WORK/openeebus.tgz" -C "$WORK"
  for p in "$HERE"/patches/*.patch; do
    [ -e "$p" ] || continue
    patch -d "$SRC" -p1 --forward --silent < "$p"
  done
fi

# Our bridge as an additional subproject, like openeebus' own examples.
rm -rf "$SRC/examples/dvhub_eebus"
cp -r "$HERE/bridge" "$SRC/examples/dvhub_eebus"
grep -q 'examples/dvhub_eebus' "$SRC/CMakeLists.txt" \
  || echo 'add_subdirectory(examples/dvhub_eebus)' >> "$SRC/CMakeLists.txt"

GEN=()
command -v ninja >/dev/null 2>&1 && GEN=(-G Ninja)
cmake -S "$SRC" -B "$SRC/build" "${GEN[@]}" \
  -DCMAKE_BUILD_TYPE=Release \
  -DOPTION_MDNS_USE_AVAHI_CLIENT=ON \
  -DCMAKE_C_FLAGS="-Wno-error=maybe-uninitialized" >/dev/null
cmake --build "$SRC/build" --target dvhub-eebus -j"$(nproc 2>/dev/null || echo 2)"

install -d "$OUT"
BIN="$(find "$SRC/build" -maxdepth 3 -type f -name dvhub-eebus -perm -u+x | head -1)"
[ -n "$BIN" ] || { echo "eebus: Binary nicht gefunden" >&2; exit 1; }
install -m 0755 "$BIN" "$OUT/dvhub-eebus.new"
strip "$OUT/dvhub-eebus.new" 2>/dev/null || true
mv -f "$OUT/dvhub-eebus.new" "$OUT/dvhub-eebus"
echo "$OPENEEBUS_COMMIT" > "$OUT/dvhub-eebus.version"
echo "eebus: $OUT/dvhub-eebus gebaut (openeebus $OPENEEBUS_COMMIT)"
