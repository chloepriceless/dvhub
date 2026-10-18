#!/usr/bin/env bash
# dvhub-modbus-redirect.sh — Ersatzweg für den Modbus-Port des Direktvermarkters.
#
# Der Direktvermarkter fragt DVhub über den VPN-Tunnel auf Port 502 ab. Kann DVhub
# den Port nicht öffnen (belegt durch ein anderes Programm auf dem Gerät, oder
# kein Recht für Ports < 1024), lauscht er auf einem Ersatzport und lässt den
# Kernel NUR am eigenen Tunnel-Interface umleiten: iif <tunnel> tcp dport 502
# → <ersatzport>. Die Umleitung greift vor der Zuordnung zu einem Programm —
# wer 502 sonst auf dem Gerät belegt, spielt keine Rolle (2026-10-18).
#
# Root-eigene Kopie: nativ /usr/local/libexec/dvhub-modbus-redirect (install.sh,
# post-update.sh), im Container dieselbe Stelle (Dockerfile). Die sudoers-Regel
# zeigt nur auf diese Kopie; das Skript prüft seine Argumente selbst.
#
# Nutzung (als root, über sudo aus vpn-manager.js):
#   dvhub-modbus-redirect add <interface> <port> <zielport>
#   dvhub-modbus-redirect del
set -euo pipefail

TABLE=dvhub_modbus      # nft: table ip dvhub_modbus
CHAIN=DVHUB_MODBUS      # iptables: eigene Kette in -t nat

die() { echo "dvhub-modbus-redirect: $1" >&2; exit "${2:-1}"; }
port_ok() { [[ $1 =~ ^[0-9]{1,5}$ ]] && (( 10#$1 >= 1 && 10#$1 <= 65535 )); }

use_nft() { command -v nft >/dev/null 2>&1; }
use_ipt() { command -v iptables >/dev/null 2>&1; }

del_rules() {
  if use_nft; then nft delete table ip "$TABLE" 2>/dev/null || true; fi
  if use_ipt; then
    while iptables -t nat -D PREROUTING -j "$CHAIN" 2>/dev/null; do :; done
    iptables -t nat -F "$CHAIN" 2>/dev/null || true
    iptables -t nat -X "$CHAIN" 2>/dev/null || true
  fi
}

case ${1:-} in
  add)
    [[ $# -eq 4 ]] || die "Aufruf: dvhub-modbus-redirect add <interface> <port> <zielport>" 2
    iface=$2 from=$3 to=$4
    # Interface-Namen sind höchstens 15 Zeichen; nie lo oder ein Platzhalter.
    [[ $iface =~ ^[A-Za-z0-9_.-]{1,15}$ && $iface != lo ]] || die "ungültiges Interface" 2
    port_ok "$from" && port_ok "$to" || die "ungültiger Port" 2
    from=$((10#$from)) to=$((10#$to))
    [[ $from != "$to" ]] || die "Port und Zielport sind gleich" 2
    if use_nft; then
      # In einem Zug ersetzen: anlegen (falls fehlt), löschen, neu anlegen.
      nft -f - <<EOF
table ip $TABLE
delete table ip $TABLE
table ip $TABLE {
  chain prerouting {
    type nat hook prerouting priority dstnat; policy accept;
    iifname "$iface" tcp dport $from redirect to :$to
  }
}
EOF
    elif use_ipt; then
      iptables -t nat -N "$CHAIN" 2>/dev/null || true
      iptables -t nat -F "$CHAIN"
      iptables -t nat -A "$CHAIN" -i "$iface" -p tcp --dport "$from" -j REDIRECT --to-ports "$to"
      iptables -t nat -C PREROUTING -j "$CHAIN" 2>/dev/null || iptables -t nat -I PREROUTING 1 -j "$CHAIN"
    else
      die "weder nft noch iptables vorhanden"
    fi
    ;;
  del)
    [[ $# -eq 1 ]] || die "Aufruf: dvhub-modbus-redirect del" 2
    del_rules
    ;;
  *)
    die "Aufruf: dvhub-modbus-redirect add <interface> <port> <zielport> | del" 2
    ;;
esac
