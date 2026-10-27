#!/usr/bin/env bash
# dvhub-vpn.sh — root-eigener Einstieg für OpenVPN und WireGuard aus der
# Oberfläche (vpn-manager.js).
#
# Warum (Gegenprüfung 25.10.2026, P2): die sudoers-Regeln erlaubten
# `openvpn --config *` und `wg-quick up|down *`. Mit beliebigen Argumenten
# führt openvpn als root jedes Skript aus (--script-security 2 --up …), und
# wg-quick führt PreUp/PostUp eines beliebigen Pfads aus. Damit war der
# Dienstbenutzer root.
#
# Dieses Skript nimmt nur einen PROFILNAMEN (wie dvhub-ipsec-link) und sucht
# die Datei selbst im Profilordner. Es liest das Profil und jede darin genannte
# Datei ALS DIENSTBENUTZER (setpriv) in einen root-eigenen Ordner unter /run,
# prüft diese Kopie und startet nur sie:
#  - OpenVPN: nur Direktiven aus einer festen Liste (die, die Profile von
#    Direktvermarktern brauchen), Dateien nur aus dem Profilordner (Zertifikate,
#    Schlüssel), danach erzwungen --script-security 0. Zeilen, die OpenVPN
#    anders lesen würde als diese Prüfung (Anführungszeichen im Namen, zu lange
#    Zeilen, NUL-Bytes, `setenv opt <direktive>`, `--direktive`), werden
#    abgelehnt, nicht geraten.
#  - WireGuard: keine PreUp/PostUp/PreDown/PostDown, kein SaveConfig (in jeder
#    Schreibweise; wg-quick vergleicht ohne Groß-/Kleinschreibung).
# Die Prüfung in vpn-manager.js (validateOvpnConfig/validateWireGuardConfig)
# bleibt die erste Linie; dieses Skript verlässt sich nicht darauf.
#
# install.sh/post-update.sh kopieren es nach /usr/local/libexec/dvhub-vpn
# (root:root 0755) und tragen CONFIG_DIR und SERVICE_USER fest ein; im
# Container macht das das Dockerfile. Die sudoers-Regeln zeigen nur auf diese
# Kopie.
#
# Nutzung (als root, über sudo -n):
#   dvhub-vpn openvpn up <profil> [<datei>.ovpn]    # Standard client.ovpn; läuft im Vordergrund
#   dvhub-vpn openvpn down                          # beendet den von hier gestarteten openvpn
#   dvhub-vpn openvpn status                        # Exit 0, solange er läuft
#   dvhub-vpn wireguard up <profil> [<datei>.conf]  # Standard wg0.conf, Interface immer wg0
#   dvhub-vpn wireguard down <profil> [<datei>.conf]
#   dvhub-vpn wireguard status                      # wg show wg0 latest-handshakes
#   dvhub-vpn openvpn|wireguard check <profil> [<datei>]  # nur prüfen (von Hand, ohne sudoers-Regel)
#
# Exit-Codes: 2 = Aufruf/Argumente ungültig, 3 = Profil abgelehnt, sonst wie
# das gestartete Programm.
set -euo pipefail
# Byte-genaue Zeilenlängen und feste Meldungen.
export LC_ALL=C

INSTALLED="@INSTALLED@"
CONFIG_DIR="@CONFIG_DIR@"
SERVICE_USER="@SERVICE_USER@"
RUN_DIR=/run/dvhub-vpn
EFFECTIVE_UID="$EUID"
if [[ "$INSTALLED" == "@INSTALLED@" ]]; then
  # Nicht installierte Kopie: nur für Tests (test/dvhub-vpn-helper.test.js).
  CONFIG_DIR="${DVHUB_HELPER_TEST_CONFIG_DIR:-}"
  SERVICE_USER="${DVHUB_HELPER_TEST_SERVICE_USER:-}"
  RUN_DIR="${DVHUB_HELPER_TEST_RUN_DIR:-}"
  EFFECTIVE_UID="${DVHUB_HELPER_TEST_EUID:-$EUID}"
else
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
fi
PROFILES_DIR="$CONFIG_DIR/vpn/profiles"
OVPN_STAGE="$RUN_DIR/openvpn"
OVPN_PID_FILE="$RUN_DIR/openvpn.pid"   # vpn-manager.js: OPENVPN_PID_FILE
WG_STAGE="$RUN_DIR/wireguard"
WG_IFACE=wg0                           # vpn-manager.js: wgInterfaceName()
MAX_FILE_BYTES=1048576
# OpenVPN liest Konfigurationszeilen in Stücken von 255 Zeichen; der Rest einer
# längeren Zeile wäre für OpenVPN eine eigene Zeile, für diese Prüfung nicht.
MAX_LINE=250

die() { echo "dvhub-vpn: $1" >&2; exit "${2:-1}"; }
usage() { die "Aufruf: dvhub-vpn openvpn up|check <profil> [<datei>.ovpn] | openvpn down|status | wireguard up|down|check <profil> [<datei>.conf] | wireguard status" 2; }
refuse() { die "Profil abgelehnt: $1" 3; }

[[ "$EFFECTIVE_UID" -eq 0 ]] || die "muss als root laufen"
[[ -n "$CONFIG_DIR" && -n "$SERVICE_USER" && -n "$RUN_DIR" ]] || die "nicht eingerichtet (CONFIG_DIR/SERVICE_USER fehlen)"

proto="${1:-}" action="${2:-}"
case "$proto $action" in
  "openvpn up"|"openvpn check"|"wireguard up"|"wireguard down"|"wireguard check")
    [[ $# -eq 3 || $# -eq 4 ]] || usage ;;
  "openvpn down"|"openvpn status"|"wireguard status")
    [[ $# -eq 2 ]] || usage ;;
  *) usage ;;
esac

profile="${3:-}"
if [[ $# -ge 3 ]]; then
  # Gleiche Zeichenklasse wie sanitizeProfileName() in vpn-manager.js.
  [[ "$profile" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || die "ungültiger Profilname" 2
  if [[ "$proto" == openvpn ]]; then
    file="${4:-client.ovpn}"
    [[ "$file" =~ ^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}\.ovpn$ ]] || die "ungültiger Dateiname (erwartet <name>.ovpn)" 2
  else
    file="${4:-wg0.conf}"
    [[ "$file" =~ ^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}\.conf$ ]] || die "ungültiger Dateiname (erwartet <name>.conf)" 2
  fi
fi

# ── Lesen als Dienstbenutzer ─────────────────────────────────────────────────
# Das Profil gehört dem Dienstbenutzer. root liest es nie selbst: ein Verweis
# auf /etc/shadow o. Ä. scheitert so an den Rechten des Dienstbenutzers.
as_service_user() {
  if command -v setpriv >/dev/null 2>&1; then
    setpriv --reuid="$SERVICE_USER" --regid="$SERVICE_USER" --init-groups -- "$@"
  elif command -v runuser >/dev/null 2>&1; then
    runuser -u "$SERVICE_USER" -- "$@"
  elif command -v su-exec >/dev/null 2>&1; then
    su-exec "$SERVICE_USER" "$@"
  else
    die "weder setpriv noch runuser noch su-exec vorhanden"
  fi
}

# <quelle> <ziel>: reguläre Datei (kein Verweis), höchstens MAX_FILE_BYTES,
# ohne NUL-Bytes; das Ziel liegt im root-eigenen Ordner und gehört root.
copy_in() {
  local src="$1" dest="$2" size
  [[ -f "$src" && ! -L "$src" ]] || return 1
  as_service_user head -c "$((MAX_FILE_BYTES + 1))" "$src" > "$dest" || return 1
  size="$(wc -c < "$dest" | tr -d '[:space:]')"
  (( size <= MAX_FILE_BYTES )) || refuse "$(basename "$src") ist größer als $MAX_FILE_BYTES Bytes"
  [[ "$(tr -d '\000' < "$dest" | wc -c | tr -d '[:space:]')" == "$size" ]] || refuse "$(basename "$src") enthält NUL-Bytes"
  chmod 0600 "$dest"
}

profile_dir() {  # gibt den geprüften Profilordner aus
  local dir="$PROFILES_DIR/$profile"
  [[ ! -L "$CONFIG_DIR/vpn" && ! -L "$PROFILES_DIR" ]] || refuse "$PROFILES_DIR darf kein Verweis sein"
  [[ -d "$dir" && ! -L "$dir" ]] || refuse "Profilordner fehlt oder ist ein Verweis: $dir"
  printf '%s\n' "$dir"
}

new_stage() {  # <ordner>: leer, root-eigen, nur für root lesbar
  install -d -m 0755 "$RUN_DIR"
  rm -rf "$1"
  install -d -m 0700 "$1"
}

# ── OpenVPN ──────────────────────────────────────────────────────────────────
# Erlaubte Direktiven (Client-Profile). Bewusst NICHT: up/down/route-up/…,
# plugin, management*, config (Nachladen), cd/chroot, daemon, log/log-append/
# status/writepid/replay-persist/tmp-dir (schreiben Dateien als root),
# tls-export-cert, engine/providers/pkcs11-* (laden Bibliotheken), dev-node,
# iproute, script-security außer 0.
OVPN_ALLOWED=" client tls-client pull nobind remote remote-random remote-random-hostname resolv-retry proto proto-force port lport rport bind local float connect-retry connect-retry-max connect-timeout server-poll-timeout explicit-exit-notify http-proxy http-proxy-option http-proxy-timeout socks-proxy dev dev-type topology tun-ipv6 tun-mtu tun-mtu-extra link-mtu mtu-disc mtu-test fragment mssfix sndbuf rcvbuf txqueuelen fast-io persist-tun persist-key persist-local-ip persist-remote-ip ifconfig ifconfig-ipv6 ifconfig-noexec route route-ipv6 route-gateway route-ipv6-gateway route-metric route-delay route-method route-noexec route-nopull pull-filter redirect-gateway redirect-private block-ipv6 allow-pull-fqdn allow-recursive-routing dhcp-option block-outside-dns register-dns ip-win32 disable-dco keepalive ping ping-restart ping-exit ping-timer-rem inactive ca cert key pkcs12 extra-certs tls-auth tls-crypt tls-crypt-v2 key-direction secret dh crl-verify cipher data-ciphers data-ciphers-fallback ncp-ciphers ncp-disable auth keysize tls-cipher tls-ciphersuites tls-groups ecdh-curve tls-version-min tls-version-max tls-cert-profile remote-cert-tls ns-cert-type remote-cert-ku remote-cert-eku verify-x509-name x509-username-field verify-hash peer-fingerprint tls-timeout hand-window tran-window reneg-sec reneg-bytes reneg-pkts replay-window mute-replay-warnings no-replay no-iv key-method tls-exit single-session auth-nocache auth-retry auth-user-pass askpass static-challenge push-peer-info comp-lzo compress allow-compression comp-noadapt user group mlock nice verb mute suppress-timestamps setenv setenv-safe ignore-unknown-option script-security "
# Eingebettete Blöcke <tag>…</tag> (Inhalt sind Daten, keine Direktiven).
OVPN_INLINE=" ca cert key pkcs12 extra-certs tls-auth tls-crypt tls-crypt-v2 secret dh crl-verify auth-user-pass http-proxy-user-pass peer-fingerprint "
in_list() { [[ "$2" == *" $1 "* ]]; }

OVPN_REFS=()
OVPN_LINE=0
ovpn_refuse() { refuse "Zeile $OVPN_LINE: $1"; }

# <arg> → OVPN_REF_OUT (Pfad in der geprüften Kopie). Erlaubt: [inline],
# ein Dateiname im Profilordner, oder <profilordner>/<dateiname>.
ovpn_ref() {
  local a="$1"
  if [[ "$a" == "[inline]" ]]; then OVPN_REF_OUT="$a"; return; fi
  [[ "$a" == /* ]] && { [[ "$a" == "$OVPN_PDIR/"* ]] || ovpn_refuse "Datei außerhalb des Profilordners: $a"; a="${a#"$OVPN_PDIR/"}"; }
  [[ "$a" =~ ^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$ ]] || ovpn_refuse "Dateiname nicht erlaubt: $1"
  OVPN_REFS+=("$a")
  OVPN_REF_OUT="f/$a"
}

# Eine Direktivenzeile (ohne führende Leerzeichen) prüfen; gibt sie (Dateien
# auf die Kopie umgeschrieben) aus.
ovpn_directive() {
  local t="$1" d rest i w=() n
  d="${t%%[[:space:]]*}"
  rest="${t#"$d"}"
  # OpenVPN akzeptiert auch "--name"; Anführungszeichen o. Ä. im Namen nicht raten.
  [[ "$d" =~ ^(--)?([a-z][a-z0-9-]*)$ ]] || ovpn_refuse "unbekannte Zeile: ${t:0:40}"
  d="${BASH_REMATCH[2]}"
  IFS=$' \t\v\f\r' read -r -a w <<< "$rest" || true
  # Ab einem Wort mit # oder ; ist der Rest Kommentar (wie in OpenVPN).
  for ((i = 0; i < ${#w[@]}; i++)); do
    if [[ "${w[$i]}" == '#'* || "${w[$i]}" == ';'* ]]; then w=("${w[@]:0:$i}"); break; fi
  done
  if [[ "$d" == setenv ]]; then
    # `setenv opt <direktive> …` ist für OpenVPN die Direktive selbst.
    [[ ${#w[@]} -ge 1 && "${w[0]}" =~ ^[A-Za-z0-9_]+$ ]] || ovpn_refuse "setenv: ungültiger Name"
    if [[ "${w[0]}" == opt ]]; then
      [[ ${#w[@]} -ge 2 && "${w[1]}" =~ ^[a-z][a-z0-9-]*$ ]] || ovpn_refuse "setenv opt: ungültige Direktive"
      in_list "${w[1]}" "$OVPN_ALLOWED" || ovpn_refuse "Direktive '${w[1]}' nicht erlaubt (setenv opt)"
      case "${w[1]}" in
        setenv|script-security|ca|cert|key|pkcs12|extra-certs|tls-auth|tls-crypt|tls-crypt-v2|secret|dh|crl-verify|auth-user-pass|askpass|http-proxy|socks-proxy)
          ovpn_refuse "setenv opt ${w[1]} nicht erlaubt" ;;
      esac
    fi
    printf '%s\n' "$t"
    return
  fi
  in_list "$d" "$OVPN_ALLOWED" || ovpn_refuse "Direktive '$d' nicht erlaubt"
  n=${#w[@]}
  local plain='^[A-Za-z0-9_.:@=+-]+$'
  case "$d" in
    script-security)
      [[ $n -eq 1 && "${w[0]}" == 0 ]] || ovpn_refuse "script-security nur 0" ;;
    ca|cert|key|pkcs12|extra-certs|dh)
      [[ $n -eq 1 ]] || ovpn_refuse "$d: genau eine Datei"
      ovpn_ref "${w[0]}"; printf '%s %s\n' "$d" "$OVPN_REF_OUT"; return ;;
    tls-auth|secret|tls-crypt|tls-crypt-v2)
      [[ $n -ge 1 && $n -le 2 ]] || ovpn_refuse "$d: Datei [Richtung]"
      [[ $n -lt 2 || "${w[1]}" =~ $plain ]] || ovpn_refuse "$d: ungültiges Argument"
      ovpn_ref "${w[0]}"; printf '%s %s%s\n' "$d" "$OVPN_REF_OUT" "${w[1]:+ ${w[1]}}"; return ;;
    crl-verify)
      [[ $n -eq 1 ]] || ovpn_refuse "crl-verify: nur eine Datei (kein Ordner)"
      ovpn_ref "${w[0]}"; printf '%s %s\n' "$d" "$OVPN_REF_OUT"; return ;;
    auth-user-pass|askpass)
      [[ $n -le 1 ]] || ovpn_refuse "$d: höchstens eine Datei"
      if [[ $n -eq 1 ]]; then ovpn_ref "${w[0]}"; printf '%s %s\n' "$d" "$OVPN_REF_OUT"; return; fi ;;
    http-proxy|socks-proxy)
      [[ $n -ge 2 && $n -le 4 ]] || ovpn_refuse "$d: Host Port [Datei] [Verfahren]"
      for ((i = 0; i < n; i++)); do [[ "${w[$i]}" =~ $plain || $i -eq 2 ]] || ovpn_refuse "$d: ungültiges Argument"; done
      if [[ $n -ge 3 && "${w[2]}" != auto && "${w[2]}" != auto-nct ]]; then
        ovpn_ref "${w[2]}"
        printf '%s %s %s %s%s\n' "$d" "${w[0]}" "${w[1]}" "$OVPN_REF_OUT" "${w[3]:+ ${w[3]}}"; return
      fi ;;
  esac
  printf '%s\n' "$t"
}

# <kopie> <profilordner>: prüft Zeile für Zeile wie OpenVPN sie liest und gibt
# die geprüfte Fassung aus. Struktur wie in OpenVPN (options.c):
#  - <tag> allein auf der Zeile öffnet einen Block; er endet an der ersten
#    Zeile, die (nach Leerzeichen) mit </tag> beginnt — der Rest der Zeile zählt
#    nicht.
#  - <connection> endet an der ersten Zeile mit </connection>, auch mitten in
#    einem inneren Block; sein Inhalt sind wieder Direktiven.
ovpn_check() {
  local src="$1" line t tt tag block="" in_conn=0
  OVPN_PDIR="$2"
  OVPN_LINE=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    OVPN_LINE=$((OVPN_LINE + 1))
    line="${line%$'\r'}"
    (( ${#line} <= MAX_LINE )) || ovpn_refuse "länger als $MAX_LINE Zeichen"
    t="${line#"${line%%[![:space:]]*}"}"
    if [[ $in_conn -eq 1 && "$t" == "</connection>"* ]]; then
      [[ -z "$block" ]] || ovpn_refuse "<$block> in <connection> nicht geschlossen"
      in_conn=0; printf '%s\n' "</connection>"; continue
    fi
    if [[ -n "$block" ]]; then
      [[ "$t" == "</$block>"* ]] && { block=""; printf '%s\n' "${t%%>*}>"; continue; }
      printf '%s\n' "$line"; continue
    fi
    case "$t" in
      ''|'#'*|';'*) printf '%s\n' "$line"; continue ;;
    esac
    if [[ "$t" == '<'* ]]; then
      tt="${t%"${t##*[![:space:]]}"}"
      [[ "$tt" =~ ^\<([a-z0-9-]+)\>$ ]] || ovpn_refuse "ungültiger Block: ${t:0:40}"
      tag="${BASH_REMATCH[1]}"
      if [[ "$tag" == connection ]]; then
        [[ $in_conn -eq 0 ]] || ovpn_refuse "<connection> verschachtelt"
        in_conn=1; printf '%s\n' "<connection>"; continue
      fi
      in_list "$tag" "$OVPN_INLINE" || ovpn_refuse "Block <$tag> nicht erlaubt"
      block="$tag"; printf '%s\n' "<$tag>"; continue
    fi
    ovpn_directive "$t"
  done < "$src"
  [[ -z "$block" && $in_conn -eq 0 ]] || refuse "Block <${block:-connection}> nicht geschlossen"
}

ovpn_stage() {  # <ordner>: Profil prüfen und als <ordner>/client.conf + f/* ablegen
  local stage="$1" pdir r
  pdir="$(profile_dir)"
  new_stage "$stage"
  install -d -m 0700 "$stage/f"
  copy_in "$pdir/$file" "$stage/source.ovpn" || refuse "$pdir/$file fehlt, ist keine reguläre Datei oder nicht lesbar"
  OVPN_REFS=()
  ovpn_check "$stage/source.ovpn" "$pdir" > "$stage/client.conf"
  chmod 0600 "$stage/client.conf"
  rm -f "$stage/source.ovpn"
  for r in ${OVPN_REFS[@]+"${OVPN_REFS[@]}"}; do
    [[ -e "$stage/f/$r" ]] && continue
    copy_in "$pdir/$r" "$stage/f/$r" || refuse "Datei $r fehlt im Profil, ist ein Verweis oder nicht lesbar"
  done
}

ovpn_pid() {  # PID des von hier gestarteten openvpn, falls er noch läuft
  local pid
  pid="$(head -c 16 "$OVPN_PID_FILE" 2>/dev/null | tr -d '[:space:]')" || return 1
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  [[ "$(cat "/proc/$pid/comm" 2>/dev/null)" == openvpn ]] || return 1
  printf '%s\n' "$pid"
}

# ── WireGuard ────────────────────────────────────────────────────────────────
# Schlüssel wie wg-quick sie liest: vor dem ersten '=', ohne Kommentar und
# Leerzeichen, ohne Groß-/Kleinschreibung.
wg_check() {
  local line key n=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    n=$((n + 1))
    line="${line%%#*}"
    [[ "$line" == *=* ]] || continue
    key="${line%%=*}"
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    key="$(printf '%s' "$key" | tr '[:upper:]' '[:lower:]')"
    case "$key" in
      preup|postup|predown|postdown|saveconfig) refuse "Zeile $n: $key nicht erlaubt" ;;
    esac
  done < "$1"
}

wg_stage() {  # <ordner>: Profil prüfen und als <ordner>/wg0.conf ablegen
  local stage="$1" pdir
  pdir="$(profile_dir)"
  new_stage "$stage"
  copy_in "$pdir/$file" "$stage/$WG_IFACE.conf" || refuse "$pdir/$file fehlt, ist keine reguläre Datei oder nicht lesbar"
  wg_check "$stage/$WG_IFACE.conf"
}

case "$proto $action" in
  "openvpn check")
    stage="$(mktemp -d "${TMPDIR:-/tmp}/dvhub-vpn-check.XXXXXX")"
    trap 'rm -rf "$stage"' EXIT
    ovpn_stage "$stage/s"
    echo "dvhub-vpn: Profil $profile/$file: OK"
    ;;
  "openvpn up")
    ovpn_stage "$OVPN_STAGE"
    rm -f "$OVPN_PID_FILE"
    # Erst nach --config: Werte auf der Kommandozeile danach gelten zuletzt.
    exec openvpn --cd "$OVPN_STAGE" --config client.conf --script-security 0 --writepid "$OVPN_PID_FILE"
    ;;
  "openvpn down")
    if pid="$(ovpn_pid)"; then
      kill -TERM "$pid"
    else
      # PID unbekannt (z. B. von einer älteren Version gestartet).
      pkill -TERM -x openvpn || true
    fi
    ;;
  "openvpn status")
    ovpn_pid >/dev/null && exit 0
    [[ -f "$OVPN_PID_FILE" ]] && exit 1
    exec pkill -0 -x openvpn
    ;;
  "wireguard check")
    stage="$(mktemp -d "${TMPDIR:-/tmp}/dvhub-vpn-check.XXXXXX")"
    trap 'rm -rf "$stage"' EXIT
    wg_stage "$stage/s"
    echo "dvhub-vpn: Profil $profile/$file: OK"
    ;;
  "wireguard up")
    wg_stage "$WG_STAGE"
    exec wg-quick up "$WG_STAGE/$WG_IFACE.conf"
    ;;
  "wireguard down")
    # Mit der Kopie vom Start herunterfahren (gleiche Routen/Tabelle); fehlt
    # sie (Neustart, ältere Version), das Profil neu prüfen.
    [[ -f "$WG_STAGE/$WG_IFACE.conf" ]] || wg_stage "$WG_STAGE"
    exec wg-quick down "$WG_STAGE/$WG_IFACE.conf"
    ;;
  "wireguard status")
    exec wg show "$WG_IFACE" latest-handshakes
    ;;
esac
