#!/usr/bin/env bash
# dvhub-ipsec-link.sh — legt die IPsec-Verweise eines DVhub-VPN-Profils in
# /etc/ipsec.d an oder entfernt sie.
#
# Warum ein Hilfsskript (2026-10-18, Feldfall BIGGE, Ubuntu 26.04 mit sudo-rs):
# Die alten sudoers-Regeln erlaubten `ln -sf …/profiles/*/ipsec.conf …` und
# `rm -f …/dvhub-[A-Za-z0-9_-]*.conf` direkt. sudo-rs lehnt `*`/`?` in
# Argumenten ab („wildcards are not allowed in command arguments“) — erlaubt
# ist nur ein alleinstehendes `*` am Ende — und überspringt solche Regeln.
# Damit war IPsec auf diesen Boxen kaputt. Die Namensprüfung, die vorher die
# Platzhalter leisten sollten, macht jetzt dieses Skript.
#
# post-update.sh (root, bei jedem Dienststart) kopiert es nach
# /usr/local/libexec/dvhub-ipsec-link (root:root 0755). Die sudoers-Regel zeigt
# auf diese Kopie, nie auf den Ordner der App (der gehört dem Dienstbenutzer).
#
# Nutzung (als root, über sudo aus vpn-manager.js):
#   dvhub-ipsec-link link   <profil> [<quelle>]  # conf (+ secrets) verlinken; <quelle> = Profilordner,
#                                                # aus dem die Dateien kommen (vpn.configPath), Standard <profil>
#   dvhub-ipsec-link unlink <profil>             # beide Verweise entfernen
set -euo pipefail

PROFILES_DIR=/etc/dvhub/vpn/profiles
IPSEC_D=/etc/ipsec.d

die() { echo "dvhub-ipsec-link: $1" >&2; exit "${2:-1}"; }

[[ $# -eq 2 || ( $# -eq 3 && $1 == link ) ]] || die "Aufruf: dvhub-ipsec-link link <profil> [<quelle>] | unlink <profil>" 2
action=$1
name=$2
source=${3:-$2}
# Gleiche Zeichenklasse wie sanitizeProfileName() in vpn-manager.js.
[[ $name =~ ^[A-Za-z0-9_-]{1,64}$ ]] || die "ungültiger Profilname" 2
[[ $source =~ ^[A-Za-z0-9_-]{1,64}$ ]] || die "ungültiger Profilname" 2

conf_link="$IPSEC_D/dvhub-$name.conf"
secrets_link="$IPSEC_D/dvhub-$name.secrets"

case $action in
  link)
    dir="$PROFILES_DIR/$source"
    # Das Profil gehört dem Dienstbenutzer: keine Verweise in Verweise
    # (sonst ließe sich ein beliebiger Pfad als root in strongSwan einhängen).
    [[ -d $dir && ! -L $dir ]] || die "Profilordner fehlt: $dir"
    [[ -f $dir/ipsec.conf && ! -L $dir/ipsec.conf ]] || die "ipsec.conf fehlt im Profil $source"
    # Zweite Linie hinter validateIPSecConfig(): Skripte, die strongSwan als
    # root ausführt, und include kommen nicht nach /etc/ipsec.d.
    if grep -Eiq '^[[:space:]]*((left|right)updown[[:space:]]*=|include[[:space:]])' "$dir/ipsec.conf"; then
      die "ipsec.conf enthält leftupdown/rightupdown/include — abgelehnt"
    fi
    [[ -d $IPSEC_D ]] || die "$IPSEC_D fehlt (strongSwan installiert?)"
    ln -sfn "$dir/ipsec.conf" "$conf_link"
    if [[ -f $dir/ipsec.secrets && ! -L $dir/ipsec.secrets ]]; then
      ln -sfn "$dir/ipsec.secrets" "$secrets_link"
    else
      # Kein secrets (PSK inline oder Zertifikat): alten Verweis nicht stehen lassen.
      rm -f "$secrets_link"
    fi
    ;;
  unlink)
    rm -f "$conf_link" "$secrets_link"
    ;;
  *)
    die "unbekannte Aktion: $action (link|unlink)" 2
    ;;
esac
