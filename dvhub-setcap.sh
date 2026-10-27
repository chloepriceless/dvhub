#!/usr/bin/env bash
# dvhub-setcap.sh — gibt der node-Datei, mit der DVhub läuft, das Recht auf
# Ports unter 1024 zurück (nach einem node-Update aus der Oberfläche,
# routes/admin-routes.js; nur Boxen ohne AmbientCapabilities in der Unit).
#
# Warum (Gegenprüfung 25.10.2026, P2): die sudoers-Regel `setcap *` erlaubte
# jede Capability auf jeder Datei — z. B. cap_dac_override auf eine Kopie von
# cp im Datenordner, danach ließ sich jede Datei überschreiben.
#
# Dieses Skript hat genau eine Aktion: cap_net_bind_service=+ep auf die
# aufgelöste echte node-Datei (/usr/bin/node, wie ExecStart der Unit), und nur,
# wenn sie root gehört und für niemanden sonst beschreibbar ist.
#
# install.sh/post-update.sh kopieren es nach /usr/local/libexec/dvhub-setcap
# (root:root 0755). Die sudoers-Regel zeigt nur auf `dvhub-setcap node`.
#
# Nutzung (als root, über sudo -n):
#   dvhub-setcap node
set -euo pipefail
export LC_ALL=C

INSTALLED="@INSTALLED@"
EFFECTIVE_UID="$EUID"
NODE_LINK=/usr/bin/node
OWNER_UID=0
if [[ "$INSTALLED" == "@INSTALLED@" ]]; then
  # Nicht installierte Kopie: nur für Tests (test/dvhub-apt-setcap-helper.test.js).
  EFFECTIVE_UID="${DVHUB_HELPER_TEST_EUID:-$EUID}"
  NODE_LINK="${DVHUB_HELPER_TEST_NODE:-$NODE_LINK}"
  OWNER_UID="${DVHUB_HELPER_TEST_OWNER_UID:-0}"
else
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
fi

die() { echo "dvhub-setcap: $1" >&2; exit "${2:-1}"; }

[[ $# -eq 1 && "$1" == node ]] || die "Aufruf: dvhub-setcap node" 2
[[ "$EFFECTIVE_UID" -eq 0 ]] || die "muss als root laufen"

# Die Unit startet /usr/bin/node; fehlt es, das node im festen PATH.
[[ -e "$NODE_LINK" ]] || NODE_LINK="$(command -v node || true)"
[[ -n "$NODE_LINK" ]] || die "node nicht gefunden"
node_bin="$(readlink -f -- "$NODE_LINK")" || die "node nicht auflösbar: $NODE_LINK"
# Eine reguläre Datei, root-eigen, für Gruppe und andere nicht beschreibbar.
[[ -n "$(find "$node_bin" -maxdepth 0 -type f -user "$OWNER_UID" ! -perm -0020 ! -perm -0002 2>/dev/null)" ]] \
  || die "$node_bin ist keine root-eigene, nur für root beschreibbare Datei — abgelehnt" 3
case "$(basename "$node_bin")" in
  node|nodejs|node[0-9]*) ;;
  *) die "$node_bin ist keine node-Datei — abgelehnt" 3 ;;
esac
exec setcap cap_net_bind_service=+ep "$node_bin"
