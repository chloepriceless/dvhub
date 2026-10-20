#!/usr/bin/env bash
# eebus-provision.sh -- baut dvhub-eebus (EEBUS-Knoten) auf nativen
# Installationen (Debian/Raspberry Pi OS). Idempotent, als root.
#
# Seit 20.10.2026 die Go-Fassung (dvhub/eebus/go, enbility eebus-go) wie im
# Container: offizielle Go-Werkzeugkette von go.dev mit fest eingetragener
# Prüfsumme (dvhub/eebus/go-toolchain.pin), statischer Bau mit build-go.sh,
# Selbsttest, erst dann ersetzen. Werkzeugkette und Bau-Zwischenstände liegen
# nur während des Baus unter /var/tmp (nicht /tmp: unter Debian 13 ist das ein
# RAM-Dateisystem). Vorhandene Zertifikate und Kopplungen gelten weiter.
# C-Fassung (openeebus von NIBE, dvhub/eebus/bridge): Rückweg mit
# $DATA_DIR/.eebus-impl-c, und für Architekturen ohne Go-Paket.
#
# Wird von post-update.sh ENTKOPPELT gestartet (systemd-run), sobald EEBUS in
# der Konfiguration aktiviert ist oder dvhub-eebus schon installiert war und
# sich der gewünschte Stand geändert hat. Der zuletzt gebaute Stand liegt in
# $DATA_DIR/.eebus-provisioned; schlägt ein Bau fehl, bleibt das vorhandene
# Binary und der nächste Start versucht es erneut.
#
# Opt-out: $DATA_DIR/.no-eebus
set -euo pipefail
INSTALL_DIR="${INSTALL_DIR:-/opt/dvhub}"
DATA_DIR="${DATA_DIR:-${DV_DATA_DIR:-/var/lib/dvhub}}"
SRC="$INSTALL_DIR/dvhub/eebus"
BIN_DIR="$INSTALL_DIR/bin"
MARKER="$DATA_DIR/.eebus-provisioned"
BUILD_ROOT="${EEBUS_BUILD_ROOT:-/var/tmp}"

[[ -f "$DATA_DIR/.no-eebus" ]] && { echo "  EEBUS: abgewählt (.no-eebus)"; exit 0; }

# Go-Paket und GOARM je Architektur; leer = kein Go-Paket → C-Fassung.
GO_ARCH="" GO_PKG="" GO_ARM=""
case "$(uname -m)" in
  aarch64|arm64) GO_ARCH=arm64 GO_PKG=arm64 ;;
  x86_64|amd64)  GO_ARCH=amd64 GO_PKG=amd64 ;;
  armv7l|armv8l) GO_ARCH=arm GO_PKG=armv6l GO_ARM=7 ;;
  armv6l)        GO_ARCH=arm GO_PKG=armv6l GO_ARM=6 ;;
esac
IMPL=go
if [[ -f "$DATA_DIR/.eebus-impl-c" ]]; then
  IMPL=c
elif [[ -z "$GO_ARCH" || ! -f "$SRC/build-go.sh" || ! -f "$SRC/go-toolchain.pin" ]]; then
  echo "  EEBUS: keine Go-Fassung für $(uname -m) — baue die C-Fassung"
  IMPL=c
fi
if [[ "$IMPL" == c && ! -f "$SRC/build.sh" ]]; then
  echo "  EEBUS: Quellen fehlen ($SRC)"; exit 0
fi

pin() { grep -E "^$1=" "$SRC/$2" | tail -1 | cut -d= -f2-; }
src_sum() { (cd "$SRC" && find "$@" -type f ! -name '*_test.go' ! -name '*.md' ! -path '*/testdata/*' -print0 \
  | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16); }

if [[ "$IMPL" == go ]]; then
  GO_VERSION="$(pin GO_VERSION go-toolchain.pin)"
  GO_SHA256="$(pin "GO_SHA256_$GO_PKG" go-toolchain.pin)"
  WANT="go+${GO_VERSION}+$(src_sum go build-go.sh go-toolchain.pin)"
else
  WANT="$(pin OPENEEBUS_COMMIT openeebus.pin)+$(src_sum bridge patches build.sh openeebus.pin)"
fi
HAVE="$(cat "$MARKER" 2>/dev/null || true)"
if [[ "$HAVE" == "$WANT" && -x "$BIN_DIR/dvhub-eebus" && "${1:-}" != "--force" ]]; then
  echo "  EEBUS: OK (aktuell: $WANT)"
  exit 0
fi

echo "  EEBUS: baue dvhub-eebus ($WANT)"
if command -v apt-get >/dev/null 2>&1; then
  if [[ "$IMPL" == go ]]; then
    # Go-Fassung: statisch, braucht zur Laufzeit nur Avahi (mDNS über D-Bus).
    PKGS=(curl ca-certificates tar avahi-daemon)
  else
    # C-Fassung: libwebsockets, cJSON, OpenSSL, Avahi; zum Bauen die Toolchain.
    PKGS=(build-essential cmake ninja-build pkg-config curl patch
          libssl-dev libwebsockets-dev libcjson-dev libavahi-client-dev avahi-daemon)
  fi
  MISSING=()
  for p in "${PKGS[@]}"; do dpkg -s "$p" >/dev/null 2>&1 || MISSING+=("$p"); done
  if (( ${#MISSING[@]} )); then
    echo "  EEBUS: installiere ${MISSING[*]}"
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${MISSING[@]}" >/dev/null
  fi
fi
# mDNS: Steuerbox und Geräte finden DVhub über Avahi.
systemctl enable --now avahi-daemon >/dev/null 2>&1 || true

mkdir -p "$BUILD_ROOT"
BUILD_DIR="$(mktemp -d "$BUILD_ROOT/dvhub-eebus.XXXXXX")"
trap 'rm -rf "$BUILD_DIR"' EXIT

if [[ "$IMPL" == go ]]; then
  TARBALL="go${GO_VERSION}.linux-${GO_PKG}.tar.gz"
  echo "  EEBUS: lade Go $GO_VERSION ($GO_PKG) von go.dev"
  curl -fsSL --retry 3 -o "$BUILD_DIR/$TARBALL" "https://go.dev/dl/$TARBALL"
  if ! echo "$GO_SHA256  $BUILD_DIR/$TARBALL" | sha256sum -c - >/dev/null 2>&1; then
    echo "  EEBUS: Prüfsumme von $TARBALL stimmt nicht — Abbruch" >&2
    exit 1
  fi
  tar -xzf "$BUILD_DIR/$TARBALL" -C "$BUILD_DIR"
  rm -f "$BUILD_DIR/$TARBALL"
  # Wenig Arbeitsspeicher (< 1,5 GB): ein Paket nach dem anderen übersetzen.
  GOFLAGS_EXTRA=""
  mem_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  (( mem_kb > 0 && mem_kb < 1500000 )) && GOFLAGS_EXTRA=" -p=1"
  # Auch die Zwischenstände des Compilers (GOTMPDIR) nicht nach /tmp.
  mkdir -p "$BUILD_DIR/gotmp"
  PATH="$BUILD_DIR/go/bin:$PATH" GOTOOLCHAIN=local GOARM="$GO_ARM" GOTMPDIR="$BUILD_DIR/gotmp" \
    GOPATH="$BUILD_DIR/gopath" GOCACHE="$BUILD_DIR/gocache" GOFLAGS="-modcacherw$GOFLAGS_EXTRA" \
    sh "$SRC/build-go.sh" --install "$BUILD_DIR/out" "$GO_ARCH"
else
  EEBUS_BUILD_DIR="$BUILD_DIR" bash "$SRC/build.sh" "$BUILD_DIR/out"
fi

"$BUILD_DIR/out/dvhub-eebus" --gen-cert "$BUILD_DIR/t.crt" "$BUILD_DIR/t.key" selftest >/dev/null \
  || { echo "  EEBUS: Selbsttest fehlgeschlagen — vorhandenes Binary bleibt" >&2; exit 1; }
mkdir -p "$BIN_DIR"
install -m 0755 "$BUILD_DIR/out/dvhub-eebus" "$BIN_DIR/dvhub-eebus.new"
mv -f "$BIN_DIR/dvhub-eebus.new" "$BIN_DIR/dvhub-eebus"
cp -f "$BUILD_DIR/out/dvhub-eebus.version" "$BIN_DIR/dvhub-eebus.version" 2>/dev/null || true
echo "$WANT" > "$MARKER"
# Läuft noch der alte Stand, beenden: DVhub startet dvhub-eebus nach 5 s mit dem
# neuen Binary neu (services/eebus/index.js, RESTART_DELAYS_MS).
if pgrep -x dvhub-eebus >/dev/null 2>&1; then
  pkill -TERM -x dvhub-eebus 2>/dev/null && echo "  EEBUS: alter Stand beendet, DVhub startet den neuen"
fi
echo "  EEBUS: fertig ($BIN_DIR/dvhub-eebus, $(cat "$BIN_DIR/dvhub-eebus.version" 2>/dev/null || echo '?'))"
