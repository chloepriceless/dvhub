#!/bin/sh
set -eu

VPN_IP="IP-Deiner-VLAN-SEITE"
LAN_HOST="DVHUBHosts"
TUN_IF="tunovpnc1"
SRC_PORT="502"
DST_PORT="1502"

LAN_IF="$(ip route get "$LAN_HOST" | awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}')"
[ -n "$LAN_IF" ] || LAN_IF="br0"

# Warten bis VPN-Interface da ist
i=0
while [ $i -lt 60 ]; do
  ip link show "$TUN_IF" >/dev/null 2>&1 && break
  i=$((i+1))
  sleep 1
done
ip link show "$TUN_IF" >/dev/null 2>&1 || exit 0

# Eigene Chains
iptables -t nat -N DV502_DNAT 2>/dev/null || true
iptables -N DV502_FWD 2>/dev/null || true

iptables -t nat -F DV502_DNAT
iptables -F DV502_FWD

# DNAT TCP+UDP von VPN:502 auf LAN:1502
iptables -t nat -A DV502_DNAT -i "$TUN_IF" -d "$VPN_IP" -p tcp --dport "$SRC_PORT" -j DNAT --to-destination "$LAN_HOST":"$DST_PORT"
iptables -t nat -A DV502_DNAT -i "$TUN_IF" -d "$VPN_IP" -p udp --dport "$SRC_PORT" -j DNAT --to-destination "$LAN_HOST":"$DST_PORT"

# FORWARD TCP+UDP
iptables -A DV502_FWD -i "$TUN_IF" -o "$LAN_IF" -p tcp -d "$LAN_HOST" --dport "$DST_PORT" -j ACCEPT
iptables -A DV502_FWD -i "$LAN_IF" -o "$TUN_IF" -p tcp -s "$LAN_HOST" --sport "$DST_PORT" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A DV502_FWD -i "$TUN_IF" -o "$LAN_IF" -p udp -d "$LAN_HOST" --dport "$DST_PORT" -j ACCEPT
iptables -A DV502_FWD -i "$LAN_IF" -o "$TUN_IF" -p udp -s "$LAN_HOST" --sport "$DST_PORT" -j ACCEPT

# Jump-Regeln IMMER an Position 1
while iptables -t nat -C PREROUTING -j DV502_DNAT 2>/dev/null; do iptables -t nat -D PREROUTING -j DV502_DNAT; done
iptables -t nat -I PREROUTING 1 -j DV502_DNAT

while iptables -C FORWARD -j DV502_FWD 2>/dev/null; do iptables -D FORWARD -j DV502_FWD; done
iptables -I FORWARD 1 -j DV502_FWD
