#!/usr/bin/env bash
# eebus-provision.sh -- baut dvhub-eebus (EEBUS-Knoten, openeebus von NIBE) auf
# nativen Installationen (Debian/Raspberry Pi OS). Idempotent, als root.
#
# Wird von post-update.sh ENTKOPPELT gestartet (systemd-run), sobald EEBUS in
# der Konfiguration aktiviert ist oder dvhub-eebus schon installiert war und
# sich der gewünschte Stand geändert hat. Gewünschter Stand = openeebus-Commit
# (dvhub/eebus/openeebus.pin) + Prüfsumme der eigenen Quellen; der zuletzt
# gebaute Stand liegt in $DATA_DIR/.eebus-provisioned.
#
# Opt-out: $DATA_DIR/.no-eebus
set -euo pipefail
INSTALL_DIR="${INSTALL_DIR:-/opt/dvhub}"
DATA_DIR="${DATA_DIR:-${DV_DATA_DIR:-/var/lib/dvhub}}"
SRC="$INSTALL_DIR/dvhub/eebus"
BIN_DIR="$INSTALL_DIR/bin"
MARKER="$DATA_DIR/.eebus-provisioned"

[[ -f "$DATA_DIR/.no-eebus" ]] && { echo "  EEBUS: abgewählt (.no-eebus)"; exit 0; }
[[ -f "$SRC/build.sh" ]] || { echo "  EEBUS: Quellen fehlen ($SRC)"; exit 0; }

eebus_want() {
  local commit sum
  commit="$(grep -E '^OPENEEBUS_COMMIT=' "$SRC/openeebus.pin" | cut -d= -f2)"
  sum="$(cd "$SRC" && find bridge patches build.sh openeebus.pin -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16)"
  echo "${commit}+${sum}"
}

WANT="$(eebus_want)"
HAVE="$(cat "$MARKER" 2>/dev/null || true)"
if [[ "$HAVE" == "$WANT" && -x "$BIN_DIR/dvhub-eebus" && "${1:-}" != "--force" ]]; then
  echo "  EEBUS: OK (aktuell: $WANT)"
  exit 0
fi

echo "  EEBUS: baue dvhub-eebus ($WANT)"
if command -v apt-get >/dev/null 2>&1; then
  # Laufzeit: libwebsockets, cJSON, OpenSSL, Avahi (mDNS). Bauen: Toolchain.
  PKGS=(build-essential cmake ninja-build pkg-config curl patch
        libssl-dev libwebsockets-dev libcjson-dev libavahi-client-dev avahi-daemon)
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

BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT
EEBUS_BUILD_DIR="$BUILD_DIR" bash "$SRC/build.sh" "$BIN_DIR"
"$BIN_DIR/dvhub-eebus" --gen-cert "$BUILD_DIR/t.crt" "$BUILD_DIR/t.key" selftest >/dev/null \
  || { echo "  EEBUS: Selbsttest fehlgeschlagen" >&2; exit 1; }
echo "$WANT" > "$MARKER"
echo "  EEBUS: fertig ($BIN_DIR/dvhub-eebus)"
