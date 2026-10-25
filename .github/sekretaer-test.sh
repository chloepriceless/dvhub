#!/usr/bin/env bash
# Führt DVhub-Tests für den Issue-Sekretär abgeschottet aus: in einem Container ohne
# Netz, als normaler Benutzer, ohne die Tokens des Runners. Vom Agenten geschriebener
# Code (Tests, package.json) läuft nur hier, nie direkt auf dem Runner — sonst könnte
# er Schreib-Tokens oder den Actions-Cache erreichen.
#   .github/sekretaer-test.sh npm test
#   .github/sekretaer-test.sh node --test test/<datei>.test.js
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
IMG=node:22-bookworm
docker image inspect "$IMG" >/dev/null 2>&1 || docker pull -q "$IMG" >/dev/null
# Abhängigkeiten nur herunterladen, keine Install-Skripte auf dem Runner ausführen.
if [ ! -d dvhub/node_modules ]; then
  (cd dvhub && npm ci --ignore-scripts --no-audit --no-fund >/dev/null)
fi
exec docker run --rm --network=none --user "$(id -u):$(id -g)" \
  -e HOME=/tmp -e CI=1 -e DVHUB_TEST_OFFLINE=1 -v "$PWD:/w" -w /w/dvhub "$IMG" "$@"
