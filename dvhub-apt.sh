#!/usr/bin/env bash
# dvhub-apt.sh — root-eigener Einstieg für die Paketpflege aus der Oberfläche
# (/api/admin/system/updates/check|apply, routes/admin-routes.js).
#
# Warum (Gegenprüfung 25.10.2026, P2): die sudoers-Regeln erlaubten
# `apt-get update *`, `apt-get upgrade *`, `apt list *` und `fuser *` mit
# beliebigen Argumenten. apt nimmt über -o jede Einstellung an, auch
# APT::Update::Pre-Invoke oder DPkg::Pre-Invoke — Befehle, die apt als root
# ausführt. Damit war der Dienstbenutzer root.
#
# Dieses Skript kennt nur die festen Aufrufe, die die Oberfläche braucht;
# Optionen von außen reicht es nie durch.
#
# install.sh/post-update.sh kopieren es nach /usr/local/libexec/dvhub-apt
# (root:root 0755). Die sudoers-Regeln zeigen nur auf diese Kopie, je Aktion
# eine Regel ohne Platzhalter.
#
# Nutzung (als root, über sudo -n):
#   dvhub-apt refresh           # apt-get update -qq
#   dvhub-apt list-upgradable   # apt list --upgradable
#   dvhub-apt upgrade-all       # apt-get upgrade -y, geänderte Konfigdateien bleiben
#   dvhub-apt upgrade-security  # dasselbe nur aus /etc/apt/security.sources.list.d
#   dvhub-apt lock-held         # Exit 0, solange dpkg gesperrt ist (fuser)
set -euo pipefail
# Englische Ausgabe: routes/admin-routes.js liest "[upgradable from: …]" und
# "Setting up …" aus dem Text.
export LC_ALL=C

INSTALLED="@INSTALLED@"
EFFECTIVE_UID="$EUID"
if [[ "$INSTALLED" == "@INSTALLED@" ]]; then
  # Nicht installierte Kopie: nur für Tests (test/dvhub-apt-setcap-helper.test.js).
  EFFECTIVE_UID="${DVHUB_HELPER_TEST_EUID:-$EUID}"
else
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
fi

die() { echo "dvhub-apt: $1" >&2; exit "${2:-1}"; }
usage() { die "Aufruf: dvhub-apt refresh|list-upgradable|upgrade-all|upgrade-security|lock-held" 2; }

[[ $# -eq 1 ]] || usage
[[ "$EFFECTIVE_UID" -eq 0 ]] || die "muss als root laufen"

# Wie bisher in routes/admin-routes.js: Konfigdateien, die der Betreiber
# geändert hat, bleiben (confold), sonst gilt die Vorgabe des Pakets (confdef).
KEEP_CONF=(-o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)

case "$1" in
  refresh)
    exec apt-get update -qq
    ;;
  list-upgradable)
    exec apt list --upgradable
    ;;
  upgrade-all)
    exec apt-get upgrade -y "${KEEP_CONF[@]}"
    ;;
  upgrade-security)
    # Nur die Sicherheitsquellen (Plan 08-01): eigene Quellliste, sonst nichts.
    exec apt-get -y \
      -o Dir::Etc::SourceList=/etc/apt/sources.list \
      -o Dir::Etc::SourceParts=/etc/apt/security.sources.list.d \
      "${KEEP_CONF[@]}" \
      upgrade
    ;;
  lock-held)
    # fuser: Exit 0, wenn ein Prozess die Sperre hält.
    exec fuser /var/lib/dpkg/lock-frontend
    ;;
  *)
    usage
    ;;
esac
