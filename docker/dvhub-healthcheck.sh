#!/bin/sh
# Docker-Healthcheck: billiger Abruf von /healthz mit busybox-wget.
# Vorher startete der Check alle 30 s eine komplette Node-Laufzeit und baute
# /api/status (auf dem eHive ~0,6 s CPU + ~30 MB je Prüfung).
# Port aus der Config (eine mitgebrachte Config bringt ihren httpPort mit),
# sonst DVHUB_HTTP_PORT, sonst 8080.
p="${DVHUB_HTTP_PORT:-8080}"
c="${DV_APP_CONFIG:-/etc/dvhub/config.json}"
if [ -r "$c" ]; then
  q=$(sed -n 's/^[[:space:]]*"httpPort":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$c" | head -n 1)
  [ -n "$q" ] && p="$q"
fi
exec wget -q -T 8 -O /dev/null "http://127.0.0.1:$p/healthz"
