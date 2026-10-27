#!/usr/bin/env bash
# post-update.sh -- Idempotent system-level setup for DVhub.
# Run as root after git pull to ensure all system requirements are met.
# Safe to run multiple times — only applies changes that are missing.
set -euo pipefail

# BEGIN DVHUB RELEASE LAYOUT — Paket-Box (docs/release-pakete.md)
# Liegt dieses Skript (auch über einen Verweis wie /opt/dvhub/post-update.sh
# oder /opt/dvhub/current/…) in einem Release-Paket — neben ihm
# .dvhub-release.json —, ist der Programmordner der Box zwei Ebenen über dem
# Release (/opt/dvhub/releases/<v> → /opt/dvhub). Dort bleiben venvs, bin/ und
# Marker; Programmdateien kommen über /opt/dvhub/current. node_modules liegt
# im Paket: kein npm install (Schritt 6), die Unit zeigt durch current.
PU_RELEASE_DIR=""
PU_CODE_DIR=""
PU_RELEASE_REV=""
_pu_self="$(dirname "$(readlink -f "${BASH_SOURCE[0]:-$0}" 2>/dev/null || echo "${BASH_SOURCE[0]:-$0}")")"
if [[ -f "$_pu_self/.dvhub-release.json" ]]; then
  PU_RELEASE_DIR="$_pu_self"
  INSTALL_DIR="${INSTALL_DIR:-$(dirname "$(dirname "$_pu_self")")}"
  PU_CODE_DIR="$INSTALL_DIR/current"
  APP_DIR="${APP_DIR:-$PU_CODE_DIR/dvhub}"
  PU_RELEASE_REV="$(sed -n 's/^  "git_sha": "\([0-9a-f]\{7\}\).*/\1/p' "$_pu_self/.dvhub-release.json" | head -1)"
fi
# END DVHUB RELEASE LAYOUT

# Programmordner: wo dieses Skript liegt, wenn niemand ihn nennt
# (Gegenprüfung a2ff2a85): install.sh --dir /srv/app trägt /srv/app in die Unit
# ein, setzt aber kein INSTALL_DIR — mit /opt/dvhub als Rückfall schrieb dieser
# Lauf ExecStart/ExecStartPre auf einen leeren Ordner um.
INSTALL_DIR="${INSTALL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)}"
APP_DIR="${APP_DIR:-$INSTALL_DIR/dvhub}"
SERVICE_USER="${SERVICE_USER:-dvhub}"
# Dienstname: als ExecStartPre nur über DV_SERVICE_NAME der Unit bekannt
# (z. B. dvhub2.service; Gegenprüfung 963dd115) — sonst trüge jeder Start
# „dvhub“ in dvhub-update und die sudoers-Regeln ein.
SERVICE_NAME="${SERVICE_NAME:-${DV_SERVICE_NAME:+${DV_SERVICE_NAME%.service}}}"
SERVICE_NAME="${SERVICE_NAME:-dvhub}"
# Konfigurations- und Datenordner wie die Unit (Gegenprüfung 25.10.2026):
# install.sh --config /pfad/config.json trägt den Ordner in die Unit
# (DV_APP_CONFIG, DV_DATA_DIR) und in dvhub-vpn ein. Als ExecStartPre stehen
# die Werte in der Umgebung; über sudo (Update aus der Oberfläche) nicht —
# dann aus der Unit-Datei. Sonst trüge dieser Lauf /etc/dvhub in dvhub-vpn
# ein, und das VPN fände sein Profil nicht mehr.
PU_UNIT_FILE="${PU_UNIT_FILE:-/etc/systemd/system/${SERVICE_NAME}.service}"
# Erst systemctl show (führt Drop-ins zusammen), dann die Unit-Datei selbst.
pu_unit_env() {
  local v=""
  if command -v systemctl >/dev/null 2>&1; then
    v="$(systemctl show -p Environment --value "${SERVICE_NAME}.service" 2>/dev/null | tr ' ' '\n' | sed -n "s/^$1=//p" | head -1)" || v=""
  fi
  [[ -n "$v" ]] || v="$(sed -n "s/^Environment=$1=//p" "$PU_UNIT_FILE" 2>/dev/null | head -1)" || v=""
  printf '%s' "$v"
}
if [[ -z "${CONFIG_DIR:-}" && -z "${CONFIG_PATH:-}" ]]; then
  CONFIG_PATH="${DV_APP_CONFIG:-$(pu_unit_env DV_APP_CONFIG)}"
  [[ -n "$CONFIG_PATH" ]] && CONFIG_DIR="$(dirname "$CONFIG_PATH")"
fi
CONFIG_DIR="${CONFIG_DIR:-/etc/dvhub}"
CONFIG_PATH="${CONFIG_PATH:-$CONFIG_DIR/config.json}"
DATA_DIR="${DATA_DIR:-${DV_DATA_DIR:-$(pu_unit_env DV_DATA_DIR)}}"
DATA_DIR="${DATA_DIR:-/var/lib/dvhub}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Dieses Skript muss als root ausgeführt werden." >&2
  exit 1
fi

echo "DVhub post-update (idempotent)"

# ── Startzeit-Budget ──
# Dieses Skript läuft als ExecStartPre bei JEDEM Dienststart; die Unit hat
# TimeoutStartSec=120. Läuft es länger, scheitert der Start trotz '-', und
# Restart=always wiederholt dieselbe langsame Arbeit (Gegenprüfung 25.10.2026).
# Darum laufen langsame Schritte entkoppelt (systemd-run: Pakete, npm, EOS,
# Forecast, TimescaleDB, Stack-Update) oder mit Zeitgrenze aus einem
# gemeinsamen Budget. Was nicht fertig wird, setzt der nächste Start fort —
# jeder Marker steht erst nach Erfolg.
PU_BUDGET_S="${DVHUB_START_BUDGET_S:-90}"
pu_left() { echo $(( PU_BUDGET_S - SECONDS )); }
pu_bounded() {  # <höchstens sekunden> <befehl…> — 124, wenn die Zeit fehlt oder abläuft
  local max="$1" left
  shift
  left="$(pu_left)"
  (( left < max )) && max="$left"
  if (( max < 3 )); then
    echo "  WARN: Startzeit aufgebraucht — übersprungen bis zum nächsten Start: $*" >&2
    return 124
  fi
  if command -v timeout >/dev/null 2>&1; then
    timeout -k 5 "$max" "$@"
  else
    "$@"
  fi
}
# ── Ende Startzeit-Budget ──

# BEGIN DVHUB INSTALL-DIR OWNERSHIP — keep this block byte-identical in install.sh and post-update.sh.
# DVHUB_ROOT_OWNED_INSTALL (Review 25.10.2026, P1): der Programmordner gehört
# root und ist für den Dienstbenutzer nur lesbar. root führt daraus bei jedem
# Dienststart post-update.sh und weitere Skripte aus; gehörte er dem
# Dienstbenutzer, könnte der sie vorher ändern. Der Dienst schreibt nur in
# CONFIG_DIR und DATA_DIR; Updates aus der Oberfläche laufen über
# /usr/local/libexec/dvhub-update. Die Marke oben ist die Untergrenze, die
# dvhub-update beim Auschecken prüft — nicht entfernen.
# Voller Durchlauf nur, wenn sich der Stand geändert hat oder etwas nicht passt
# (Marker .root-owned-rev, selbst root-eigen); sonst kostet der Schritt nichts.
# Geändert wird nur, was nicht passt (Gegenprüfung 25.10.2026: früher chown -R
# über alles, auch die großen venvs). Optional mit Zeitgrenze (post-update.sh,
# Dienststart): reicht sie nicht, bleibt der Marker alt und der nächste Lauf
# macht dort weiter, wo noch etwas falsch ist.
# safe.directory (systemweit) lässt den Dienstbenutzer im root-eigenen Repo
# lesen (Update-Prüfung: git rev-parse/log/tag).
dvhub_root_own_install_dir() {  # <ordner> [<höchstens sekunden je Schritt>]
  local dir="$1" mark="$1/.root-owned-rev" want lim=() rc=0 wrong
  [[ -d "$dir" ]] || return 0
  [[ -n "${2:-}" ]] && command -v timeout >/dev/null 2>&1 && lim=(timeout -k 5 "$2")
  want="$(git -c safe.directory="$dir" -c core.fsmonitor=false -C "$dir" rev-parse --verify -q HEAD 2>/dev/null)" || want=nogit
  if [[ "$(cat "$mark" 2>/dev/null)" != "$want" || -z "$(find "$dir" "$mark" -maxdepth 0 -user 0 2>/dev/null | sed -n 2p)" ]]; then
    wrong="$(${lim[@]+"${lim[@]}"} find "$dir" -xdev \( \( ! -user 0 -o ! -group 0 \) -o \( ! -type l \( -perm -0020 -o -perm -0002 -o ! -perm -0004 -o \( -type d ! -perm -0001 \) \) \) \) -print -quit 2>/dev/null)" || rc=$?
    if [[ -n "$wrong" && "$rc" -ne 124 && "$rc" -ne 137 ]]; then
      echo "  Rechte: $dir gehört root (Dienstbenutzer nur lesend)"
      # Ein Durchgang für Besitz und Rechte (Gegenprüfung c784e6a1).
      rc=0
      ${lim[@]+"${lim[@]}"} find "$dir" -xdev \( \( ! -user 0 -o ! -group 0 \) -exec chown -h 0:0 {} + -o -true \) \
        ! -type l \( -perm -0020 -o -perm -0002 -o ! -perm -0004 -o \( -type d ! -perm -0001 \) \) -exec chmod go-w,a+rX {} + 2>/dev/null || rc=$?
    fi
    if [[ "$rc" -eq 124 || "$rc" -eq 137 ]]; then
      echo "  Rechte: Zeitgrenze erreicht — der nächste Start setzt fort" >&2
      return 1
    fi
    rm -f "$mark"
    printf '%s\n' "$want" > "$mark"
  fi
  if command -v git >/dev/null 2>&1 && ! git config --system --get-all safe.directory 2>/dev/null | grep -Fxq "$dir"; then
    git config --system --add safe.directory "$dir" 2>/dev/null || true
  fi
}
# END DVHUB INSTALL-DIR OWNERSHIP

# ── 0. Programmordner root-eigen — VOR allem, was daraus als root läuft ──
# Zeitgrenze je Durchgang: der erste Start nach der Umstellung geht einmal über
# den ganzen Ordner; reicht die Zeit nicht, macht der nächste Start weiter.
OWN_LIMIT="$(pu_left)"; (( OWN_LIMIT > 45 )) && OWN_LIMIT=45
dvhub_root_own_install_dir "$INSTALL_DIR" "$OWN_LIMIT" || echo "  WARN: Rechte für $INSTALL_DIR nicht (vollständig) gesetzt" >&2

# ── 1. Pakete ──
# wireguard-tools wird GETRENNT und OHNE Recommends installiert (T-UPDATE-SHARPEN
# 2026-07-03): sein Recommends `wireguard-modules` ist virtuell und wird nur von
# linux-image-* bereitgestellt — in einem LXC (kein Kernel-Paket) löst apt das
# durch ein KOMPLETTES Kernel-Image auf (~0,5 GB nutzlos; live beobachtet:
# linux-image-rt-amd64). Das Modul kommt im Container vom HOST-Kernel.
# Die übrigen Pakete behalten ihre Recommends — die sind FUNKTIONAL NÖTIG
# (strongswan-starter → strongswan-charon = der IKE-Daemon selbst; libstrongswan
# → libstrongswan-standard-plugins = Crypto-Plugins). NIE pauschal
# --no-install-recommends auf die ganze Liste!
NEEDED_PKGS=""
for pkg in openvpn strongswan autossh openssh-client libjemalloc2; do
  if ! dpkg -s "$pkg" >/dev/null 2>&1; then
    NEEDED_PKGS="$NEEDED_PKGS $pkg"
  fi
done
NEED_WG=""
if ! dpkg -s wireguard-tools >/dev/null 2>&1; then
  NEED_WG="wireguard-tools"
fi
if [[ -n "$NEEDED_PKGS" || -n "$NEED_WG" ]]; then
  # T-0077: NON-FATAL. The packages are VPN tools (openvpn/wg/strongswan), not
  # required for the core app to boot — best-effort, retry next run.
  # Entkoppelt (Gegenprüfung 25.10.2026): apt-get update + install brauchen auf
  # einem langsamen Board mit schlechtem Netz leicht mehr als TimeoutStartSec.
  # Eine eigene transiente Unit läuft weiter, auch wenn DVhub neu startet; der
  # nächste Start prüft wieder mit dpkg -s und stößt nur an, was noch fehlt.
  # DPkg::Lock::Timeout: wartet auf andere apt-Läufe (TimescaleDB, Stack-Update),
  # statt sofort zu scheitern.
  PKG_SCRIPT='apt-get -o DPkg::Lock::Timeout=300 update -qq || exit 1
if [ -n "$1" ]; then DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y $1 || exit 1; fi
if [ -n "$2" ]; then DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y --no-install-recommends "$2" || exit 1; fi
echo "Pakete installiert:$1 $2"'
  if systemctl is-active --quiet dvhub-vpn-packages.service 2>/dev/null; then
    echo "  Pakete:$NEEDED_PKGS ${NEED_WG} — Installation läuft bereits im Hintergrund"
  elif command -v systemd-run >/dev/null 2>&1 \
      && systemd-run --collect --quiet --unit "dvhub-vpn-packages" \
           --description "DVhub fehlende Pakete (VPN, Fern-Support)" \
           --property=StandardOutput="append:$DATA_DIR/vpn-packages.log" \
           --property=StandardError="append:$DATA_DIR/vpn-packages.log" \
           bash -c "$PKG_SCRIPT" dvhub-vpn-packages "${NEEDED_PKGS# }" "$NEED_WG" 2>/dev/null; then
    echo "  Pakete:$NEEDED_PKGS ${NEED_WG} — Installation im Hintergrund gestartet (Log: $DATA_DIR/vpn-packages.log)"
  else
    setsid bash -c "$PKG_SCRIPT" dvhub-vpn-packages "${NEEDED_PKGS# }" "$NEED_WG" </dev/null >>"$DATA_DIR/vpn-packages.log" 2>&1 &
    echo "  Pakete:$NEEDED_PKGS ${NEED_WG} — Installation im Hintergrund gestartet (ohne systemd-run)"
  fi
else
  echo "  Pakete: OK"
fi

# ── 2. Port-Recht (80, 443, 502) + Speicherverwalter ──
# Frueher setcap an der node-Datei; jetzt AmbientCapabilities + jemalloc per
# Drop-in, Umstieg ueber zwei Starts (Begruendung in node-runtime-provision.sh).
# Fehlt das Skript (Teil-Deploy), bleibt es beim alten setcap.
NODE_BIN="$(command -v node)"
if [[ -f "$INSTALL_DIR/node-runtime-provision.sh" ]]; then
  pu_bounded 20 env SERVICE_NAME="$SERVICE_NAME" DATA_DIR="$DATA_DIR" NODE_BIN="$NODE_BIN" \
    bash "$INSTALL_DIR/node-runtime-provision.sh" || true
elif [[ -n "$NODE_BIN" ]]; then
  setcap cap_net_bind_service=+ep "$NODE_BIN" 2>/dev/null || true
  echo "  setcap: OK ($NODE_BIN)"
fi

# ── 3. Verzeichnisse ──
mkdir -p "$CONFIG_DIR/vpn/profiles"
mkdir -p "$CONFIG_DIR/tls"
mkdir -p "$CONFIG_DIR/hersteller"
chmod 700 "$CONFIG_DIR/vpn" 2>/dev/null || true
chmod 700 "$CONFIG_DIR/vpn/profiles" 2>/dev/null || true
echo "  Verzeichnisse: OK"

# ── 3b. Herstellerprofile abgleichen (T-MANAGED-VENDOR-PROFILES) ──
# Fehlende Profile anlegen UND ausgelieferte Bugfixes an Bestandsboxen bringen,
# ohne Operator-Edits zu zerstören: ein UNVERÄNDERTES Profil (Hash in der
# ausgelieferten Historie hersteller/.shipped-hashes.json) wird mit der neuen
# Version überschrieben; ein GEÄNDERTES Profil (z. B. victron.json auf
# transport=mqtt umgestellt) bleibt stehen — die neue Version landet als
# <name>.dist daneben. Node-Helper (unit-getestet), non-fatal.
if [[ -d "$APP_DIR/hersteller" ]]; then
  pu_bounded 20 node "$INSTALL_DIR/scripts/reconcile-vendor-profiles.mjs" "$CONFIG_DIR" "$APP_DIR" \
    || echo "  (Herstellerprofil-Abgleich übersprungen — Node-Helper nicht ausführbar oder Zeit aufgebraucht)"
  chown -R "$SERVICE_USER:$SERVICE_USER" "$CONFIG_DIR/hersteller" 2>/dev/null || true
fi

# ── 4. Self-Signed TLS Zertifikat ──
if [[ ! -f "$CONFIG_DIR/tls/cert.pem" ]]; then
  echo "  Generiere Self-Signed TLS Zertifikat..."
  # Plan 08-05 Task 1: 397 days (≤ 398) keeps the cert browser-compatible
  # (Apple/Chrome/Mozilla hard-limit since Sep 2020). Was 3650 (10y).
  if pu_bounded 30 openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$CONFIG_DIR/tls/key.pem" \
    -out "$CONFIG_DIR/tls/cert.pem" \
    -days 397 -subj "/CN=dvhub/O=DVhub/C=DE" 2>/dev/null; then
    chmod 600 "$CONFIG_DIR/tls/key.pem"
    chown "$SERVICE_USER:$SERVICE_USER" "$CONFIG_DIR/tls/"* 2>/dev/null || true
  else
    # Halbes Paar weg, damit der nächste Start neu erzeugt.
    rm -f "$CONFIG_DIR/tls/cert.pem" "$CONFIG_DIR/tls/key.pem"
    echo "  WARN: TLS-Zertifikat nicht erzeugt — nächster Start" >&2
  fi
else
  echo "  TLS Zertifikat: OK"
fi

# ── 5. Sudoers (vollstaendig, idempotent) ──
IPSEC_PATH="$(command -v ipsec || echo /usr/sbin/ipsec)"
IP_PATH="$(command -v ip || echo /usr/sbin/ip)"
PKILL_PATH="$(command -v pkill || echo /usr/bin/pkill)"
SYSTEMCTL_PATH="$(command -v systemctl)"
# BEGIN DVHUB HELPERS — keep this block byte-identical in install.sh and post-update.sh.
# Root-eigene Hilfsskripte (Review/Gegenprüfung 25.10.2026): die sudoers-Regeln
# zeigen nur auf diese Kopien unter /usr/local/libexec, nie auf eine Datei im
# Programmordner und nie auf apt-get/setcap/openvpn/wg-quick mit beliebigen
# Argumenten. Jedes Skript prüft seine Argumente selbst. Die Kopie entsteht aus
# dem (root-eigenen) Programmordner, Platzhalter werden fest eingetragen
# (INSTALL_DIR, CONFIG_DIR, SERVICE_USER, SERVICE_NAME, INSTALLED=1 — ohne das letzte liefe
# ein Skript im Testbetrieb), und sie ersetzt die alte erst, wenn sie fertig ist.
DVHUB_LIBEXEC="${DVHUB_LIBEXEC:-/usr/local/libexec}"
IPSEC_LINK_PATH="$DVHUB_LIBEXEC/dvhub-ipsec-link"
MODBUS_REDIRECT_PATH="$DVHUB_LIBEXEC/dvhub-modbus-redirect"
UPDATE_HELPER_PATH="$DVHUB_LIBEXEC/dvhub-update"
APT_HELPER_PATH="$DVHUB_LIBEXEC/dvhub-apt"
SETCAP_HELPER_PATH="$DVHUB_LIBEXEC/dvhub-setcap"
VPN_HELPER_PATH="$DVHUB_LIBEXEC/dvhub-vpn"
dvhub_install_helper() {  # <datei im Programmordner> <ziel>
  local src="$INSTALL_DIR/$1" dest="$2" tmp
  [[ -f "$src" ]] || return 0
  install -d -o root -g root -m 0755 "$(dirname "$dest")" || return 1
  tmp="$(mktemp "${dest}.XXXXXX")" || return 1
  if sed -e "s|^INSTALL_DIR=\"@INSTALL_DIR@\"\$|INSTALL_DIR=\"${INSTALL_DIR}\"|" \
         -e "s|^CONFIG_DIR=\"@CONFIG_DIR@\"\$|CONFIG_DIR=\"${CONFIG_DIR}\"|" \
         -e "s|^SERVICE_USER=\"@SERVICE_USER@\"\$|SERVICE_USER=\"${SERVICE_USER}\"|" \
         -e "s|^SERVICE_NAME=\"@SERVICE_NAME@\"\$|SERVICE_NAME=\"${SERVICE_NAME}\"|" \
         -e "s|^INSTALLED=\"@INSTALLED@\"\$|INSTALLED=\"1\"|" "$src" > "$tmp" \
     && chown root:root "$tmp" && chmod 0755 "$tmp" && mv -f "$tmp" "$dest"; then
    return 0
  fi
  rm -f "$tmp"
  echo "  WARN: Hilfsskript $dest nicht installiert" >&2
  return 1
}
dvhub_install_helpers() {
  local rc=0
  dvhub_install_helper dvhub-ipsec-link.sh "$IPSEC_LINK_PATH" || rc=1
  dvhub_install_helper dvhub-modbus-redirect.sh "$MODBUS_REDIRECT_PATH" || rc=1
  dvhub_install_helper dvhub-update.sh "$UPDATE_HELPER_PATH" || rc=1
  dvhub_install_helper dvhub-apt.sh "$APT_HELPER_PATH" || rc=1
  dvhub_install_helper dvhub-setcap.sh "$SETCAP_HELPER_PATH" || rc=1
  dvhub_install_helper dvhub-vpn.sh "$VPN_HELPER_PATH" || rc=1
  return "$rc"
}
# END DVHUB HELPERS
dvhub_install_helpers || echo "  WARN: nicht alle Hilfsskripte installiert — betroffene Funktionen bis zum nächsten Start eingeschränkt" >&2
# BEGIN DVHUB RELEASE HELPER — keep this block byte-identical in install.sh and post-update.sh.
# Release-Pakete (docs/release-pakete.md): root-eigener Einstieg dvhub-release
# (Node, Platzhalter wie oben fest eingetragen) und der Vertrauensanker für die
# Paketsignaturen. Der Anker gehört root (/etc/dvhub gehört dem Dienst) und wird
# hier nur angelegt, solange er fehlt oder noch keinen Schlüssel hat — danach
# übernimmt ihn dvhub-release nur aus Paketen, die gegen ihn geprüft wurden.
RELEASE_HELPER_PATH="$DVHUB_LIBEXEC/dvhub-release"
RELEASE_TRUST="${DVHUB_RELEASE_TRUST:-/etc/dvhub-release/allowed_signers}"
dvhub_install_helper dvhub-release.cjs "$RELEASE_HELPER_PATH" || echo "  WARN: dvhub-release nicht installiert" >&2
if [[ -f "$INSTALL_DIR/release-keys/allowed_signers" ]] \
   && ! grep -qE '^[^#]*(ssh-ed25519|ssh-rsa|ecdsa-sha2-)' "$RELEASE_TRUST" 2>/dev/null; then
  install -d -o root -g root -m 0755 "$(dirname "$RELEASE_TRUST")" \
    && install -o root -g root -m 0644 "$INSTALL_DIR/release-keys/allowed_signers" "$RELEASE_TRUST" \
    || echo "  WARN: Vertrauensanker $RELEASE_TRUST nicht angelegt" >&2
fi
# END DVHUB RELEASE HELPER
SUDOERS_FILE="/etc/sudoers.d/${SERVICE_NAME}-service-actions"
# Erst in eine Nebendatei schreiben und mit visudo -c prüfen (2026-10-18):
# eine ungültige Datei in /etc/sudoers.d legt bei klassischem sudo ALLE
# sudo-Aufrufe lahm, sudo-rs überspringt ungültige Regeln still.
SUDOERS_NEW="$(mktemp /etc/dvhub-sudoers.XXXXXX)"
cat >"${SUDOERS_NEW}" <<SUDOERS
# BEGIN DVHUB SUDOERS — keep this block byte-identical with install.sh.
${SERVICE_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL_PATH} restart ${SERVICE_NAME}.service
${SERVICE_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL_PATH} is-active ${SERVICE_NAME}.service
${SERVICE_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL_PATH} show ${SERVICE_NAME}.service *
# Fern-Support-Tunnel als eigener Dienst (2026-10-14): überlebt einen Neustart
# von DVhub. Nur Start/Stopp genau dieser Unit; sie läuft selbst als ${SERVICE_USER}.
${SERVICE_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL_PATH} start dvhub-support-tunnel.service
${SERVICE_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL_PATH} stop dvhub-support-tunnel.service
# EOS neu starten (2026-10-16): Knopf in der Oberfläche und Wache für hängende
# Läufe. Nur restart genau dieser Unit.
${SERVICE_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL_PATH} restart eos.service
# OpenVPN und WireGuard (Gegenprüfung 25.10.2026, P2): nur über das
# root-eigene Hilfsskript dvhub-vpn. Es nimmt einen Profilnamen (keine Pfade,
# keine Optionen), liest das Profil als ${SERVICE_USER}, prüft die Kopie
# (OpenVPN: erlaubte Direktiven, --script-security 0; WireGuard: keine
# Pre/Post-Up/Down, kein SaveConfig) und startet nur sie. Früher:
# openvpn --config *, wg-quick up|down *, wg show * — beliebige Argumente als root.
${SERVICE_USER} ALL=(root) NOPASSWD: ${VPN_HELPER_PATH} openvpn up *
${SERVICE_USER} ALL=(root) NOPASSWD: ${VPN_HELPER_PATH} openvpn down
${SERVICE_USER} ALL=(root) NOPASSWD: ${VPN_HELPER_PATH} openvpn status
${SERVICE_USER} ALL=(root) NOPASSWD: ${VPN_HELPER_PATH} wireguard up *
${SERVICE_USER} ALL=(root) NOPASSWD: ${VPN_HELPER_PATH} wireguard down *
${SERVICE_USER} ALL=(root) NOPASSWD: ${VPN_HELPER_PATH} wireguard status
${SERVICE_USER} ALL=(root) NOPASSWD: ${IPSEC_PATH} up *
${SERVICE_USER} ALL=(root) NOPASSWD: ${IPSEC_PATH} down *
${SERVICE_USER} ALL=(root) NOPASSWD: ${IPSEC_PATH} status *
${SERVICE_USER} ALL=(root) NOPASSWD: ${IPSEC_PATH} reload
# IPsec-Verweise in /etc/ipsec.d (2026-10-18): nur über das root-eigene
# Hilfsskript (Kopie von dvhub-ipsec-link.sh, prüft den Profilnamen selbst).
# sudo-rs (Ubuntu 26.04) überspringt Regeln mit * oder ? mitten im Argument;
# erlaubt ist nur ein alleinstehendes * am Ende (test/sudoers-sudo-rs.test.js).
${SERVICE_USER} ALL=(root) NOPASSWD: ${IPSEC_LINK_PATH} link *
${SERVICE_USER} ALL=(root) NOPASSWD: ${IPSEC_LINK_PATH} unlink *
# Ersatzweg Modbus-Port (2026-10-18): Umleitung am Tunnel-Interface nur über
# das root-eigene Hilfsskript (prüft Interface und Ports selbst).
${SERVICE_USER} ALL=(root) NOPASSWD: ${MODBUS_REDIRECT_PATH} add *
${SERVICE_USER} ALL=(root) NOPASSWD: ${MODBUS_REDIRECT_PATH} del
${SERVICE_USER} ALL=(root) NOPASSWD: ${IP_PATH} link show *
${SERVICE_USER} ALL=(root) NOPASSWD: ${IP_PATH} addr show *
# Process control — pkill by exact process name, not generic kill PID.
# strongSwan charon/starter (OpenVPN beendet/prüft jetzt dvhub-vpn).
${SERVICE_USER} ALL=(root) NOPASSWD: ${PKILL_PATH} -15 -x charon
${SERVICE_USER} ALL=(root) NOPASSWD: ${PKILL_PATH} -15 -x starter
${SERVICE_USER} ALL=(root) NOPASSWD: ${PKILL_PATH} -9 -x charon
${SERVICE_USER} ALL=(root) NOPASSWD: ${PKILL_PATH} -9 -x starter
# Software-Update aus der Oberfläche (Review 25.10.2026): nur über den
# root-eigenen Einstieg dvhub-update (prüft Tag/Commit/Untergrenze selbst).
# Früher: bash ${INSTALL_DIR}/post-update.sh — eine Datei im Programmordner.
${SERVICE_USER} ALL=(root) NOPASSWD: ${UPDATE_HELPER_PATH} fetch
${SERVICE_USER} ALL=(root) NOPASSWD: ${UPDATE_HELPER_PATH} stash
${SERVICE_USER} ALL=(root) NOPASSWD: ${UPDATE_HELPER_PATH} stash-pop
${SERVICE_USER} ALL=(root) NOPASSWD: ${UPDATE_HELPER_PATH} checkout-main
${SERVICE_USER} ALL=(root) NOPASSWD: ${UPDATE_HELPER_PATH} checkout-tag *
${SERVICE_USER} ALL=(root) NOPASSWD: ${UPDATE_HELPER_PATH} checkout-commit *
${SERVICE_USER} ALL=(root) NOPASSWD: ${UPDATE_HELPER_PATH} npm-install
${SERVICE_USER} ALL=(root) NOPASSWD: ${UPDATE_HELPER_PATH} post-update
# Release-Pakete (docs/release-pakete.md): nur über den root-eigenen Einstieg
# dvhub-release; er prüft Kanal und Version selbst, startet Installation und
# Rückweg als eigene Unit und lädt nur signierte Pakete.
${SERVICE_USER} ALL=(root) NOPASSWD: ${RELEASE_HELPER_PATH} check *
${SERVICE_USER} ALL=(root) NOPASSWD: ${RELEASE_HELPER_PATH} install *
${SERVICE_USER} ALL=(root) NOPASSWD: ${RELEASE_HELPER_PATH} rollback
${SERVICE_USER} ALL=(root) NOPASSWD: ${RELEASE_HELPER_PATH} status
# Paketpflege aus der Oberfläche (Gegenprüfung 25.10.2026, P2): nur feste
# Aktionen über dvhub-apt bzw. dvhub-setcap. Früher apt-get update/upgrade *,
# apt list *, fuser *, setcap * — mit -o APT::Update::Pre-Invoke::=… oder einer
# Capability auf einer beliebigen Datei wurde der Dienstbenutzer root.
${SERVICE_USER} ALL=(root) NOPASSWD: ${APT_HELPER_PATH} refresh
${SERVICE_USER} ALL=(root) NOPASSWD: ${APT_HELPER_PATH} list-upgradable
${SERVICE_USER} ALL=(root) NOPASSWD: ${APT_HELPER_PATH} upgrade-all
${SERVICE_USER} ALL=(root) NOPASSWD: ${APT_HELPER_PATH} upgrade-security
${SERVICE_USER} ALL=(root) NOPASSWD: ${APT_HELPER_PATH} lock-held
${SERVICE_USER} ALL=(root) NOPASSWD: ${SETCAP_HELPER_PATH} node
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/sbin/reboot
# T-PKGUPDATE (Christin 2026-07-02): the GUI TimescaleDB extension upgrade
# ("Jetzt aktualisieren") bounces PostgreSQL twice around ALTER EXTENSION … UPDATE
# — a fresh backend must load the new .so. Scoped to a restart of the postgresql
# meta-unit only; the dvhub app restart afterwards reuses the ${SERVICE_NAME} rule above.
${SERVICE_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL_PATH} restart postgresql.service
# T-DBRESTORE (Christin 2026-07-02): the GUI DB backup/restore runs as the
# postgres SUPERUSER — the non-super app role (dvhub) cannot dump/restore objects
# owned by another role (e.g. the postgres-owned victron_internals hypertable).
# Scoped to the three pg client binaries; run as postgres (a DB superuser but an
# unprivileged OS user), never as root.
${SERVICE_USER} ALL=(postgres) NOPASSWD: /usr/bin/pg_dump
${SERVICE_USER} ALL=(postgres) NOPASSWD: /usr/bin/pg_restore
${SERVICE_USER} ALL=(postgres) NOPASSWD: /usr/bin/psql
# END DVHUB SUDOERS
SUDOERS
chmod 440 "${SUDOERS_NEW}"
if command -v visudo >/dev/null 2>&1 && ! VISUDO_OUT="$(visudo -cf "${SUDOERS_NEW}" 2>&1)"; then
  echo "  Sudoers: Prüfung fehlgeschlagen — bisherige Regeln bleiben aktiv:" >&2
  echo "${VISUDO_OUT}" | sed 's/^/    /' >&2
  rm -f "${SUDOERS_NEW}"
else
  mv -f "${SUDOERS_NEW}" "${SUDOERS_FILE}"
  echo "  Sudoers: OK"
fi

# ── 6. npm install (Lockfile-Guard + non-fatal) ──
# T-0077: this runs as ExecStartPre on EVERY service start. The old unconditional
# `npm install` hit the npm registry on every boot under `set -e`, so a boot with
# no network (Proxmox stop-mode backup reboot) failed the whole hook -> the service
# refused to start (fleet-brick risk). Now: only when the dependency lockfile changed
# since the last SUCCESSFUL install, and never fatal (the marker is only advanced on
# success, so a failed/offline run simply retries next time).
if [[ -f "$APP_DIR/package.json" ]]; then
  cd "$APP_DIR"
  LOCK_FILE="package-lock.json"
  [[ -f "$APP_DIR/$LOCK_FILE" ]] || LOCK_FILE="package.json"
  NPM_MARKER="$INSTALL_DIR/.npm-install-hash"
  CURRENT_HASH="$(sha256sum "$APP_DIR/$LOCK_FILE" 2>/dev/null | awk '{print $1}')"
  STORED_HASH="$(cat "$NPM_MARKER" 2>/dev/null || echo "")"
  if [[ -n "${PU_RELEASE_DIR:-}" ]]; then
    # Paket-Box: node_modules kommt fertig und geprüft im Release (read-only).
    echo "  npm install: entfällt (Release-Paket bringt node_modules mit)"
  elif [[ -d "$APP_DIR/node_modules" && -n "$CURRENT_HASH" && "$CURRENT_HASH" == "$STORED_HASH" ]]; then
    echo "  npm install: uebersprungen (${LOCK_FILE} unveraendert)"
  else
    echo "  npm install (${LOCK_FILE} geaendert oder node_modules fehlt)..."
    # Als root (Review 25.10.2026): $APP_DIR und node_modules gehören root; der
    # Dienstbenutzer schreibt dort nichts mehr. Auch das Update aus der
    # Oberfläche ruft npm als root auf (dvhub-update npm-install). Eigener Cache
    # unter /root (dvhub/.npmrc: ${HOME}/.cache/dvhub-npm).
    # Marker vor dem Lauf ungueltig machen (Review 25.10.2026): bricht npm ab
    # (Timeout, Stromausfall, Abbruch aus der Oberflaeche), bleibt node_modules
    # halb zurueck — ein stehender Marker haette die Reparatur unterdrueckt.
    rm -f "$NPM_MARKER"
    # Entkoppelt (Gegenprüfung 25.10.2026): npm install braucht auf einem
    # langsamen Board leicht länger als TimeoutStartSec. Eine eigene transiente
    # Unit führt es aus (Marker erst nach Erfolg; dieselbe Sperre wie
    # dvhub-update npm-install aus der Oberfläche). Der Start wartet eine
    # Weile; ist npm bis dahin fertig, startet DVhub gleich mit vollständigen
    # Modulen. Sonst läuft die Unit weiter und startet DVhub nach Erfolg selbst
    # neu (Merker NPM_RESTART_FLAG); scheitert sie, versucht es der nächste Start.
    NPM_UNIT=dvhub-npm-install
    # Merker und Sperre teilt die Unit mit dvhub-update (Update aus der
    # Oberfläche): das nimmt den Merker weg und wartet auf die Sperre.
    NPM_RESTART_FLAG="${NPM_RESTART_FLAG:-/run/dvhub-npm-restart}"
    NPM_LOCK="${NPM_LOCK:-/run/lock/dvhub-update.lock}"
    NPM_SCRIPT='cd "$1" || exit 1
if command -v flock >/dev/null 2>&1; then exec 9>"$5" && flock -w 600 9 || exit 1; fi
rm -f "$3"
HOME=/root npm install --omit=dev || exit 1
[ -n "$2" ] && printf "%s\n" "$2" > "$3"
echo "npm install: OK"
if [ -e "$4" ]; then rm -f "$4"; systemctl restart --no-block "$6"; fi'
    rm -f "$NPM_RESTART_FLAG"
    NPM_DETACHED=0
    if systemctl is-active --quiet "$NPM_UNIT.service" 2>/dev/null; then
      NPM_DETACHED=1
    elif command -v systemd-run >/dev/null 2>&1 \
        && systemd-run --collect --quiet --unit "$NPM_UNIT" \
             --description "DVhub npm install (Abhaengigkeiten nach Update)" \
             --property=StandardOutput="append:$DATA_DIR/npm-install.log" \
             --property=StandardError="append:$DATA_DIR/npm-install.log" \
             bash -c "$NPM_SCRIPT" "$NPM_UNIT" "$APP_DIR" "$CURRENT_HASH" "$NPM_MARKER" "$NPM_RESTART_FLAG" "$NPM_LOCK" "${SERVICE_NAME}.service" 2>/dev/null; then
      NPM_DETACHED=1
    fi
    if [[ "$NPM_DETACHED" -eq 1 ]]; then
      NPM_WAIT_MAX=$(( $(pu_left) - 25 ))
      (( NPM_WAIT_MAX > 75 )) && NPM_WAIT_MAX=75
      NPM_WAITED=0
      while (( NPM_WAITED < NPM_WAIT_MAX )) && systemctl is-active --quiet "$NPM_UNIT.service" 2>/dev/null; do
        sleep 2
        NPM_WAITED=$(( NPM_WAITED + 2 ))
      done
      if systemctl is-active --quiet "$NPM_UNIT.service" 2>/dev/null; then
        touch "$NPM_RESTART_FLAG"
        echo "  npm install: laeuft im Hintergrund weiter (Log: $DATA_DIR/npm-install.log) — DVhub startet danach neu"
      elif [[ -n "$CURRENT_HASH" && "$(cat "$NPM_MARKER" 2>/dev/null)" == "$CURRENT_HASH" ]]; then
        echo "  npm install: OK"
      else
        echo "  WARN: npm install fehlgeschlagen (non-fatal, Netz?). Marker NICHT aktualisiert -> Retry beim naechsten Lauf (Log: $DATA_DIR/npm-install.log)." >&2
      fi
    # Ohne systemd-run (oder es startet keine Unit): im Vordergrund, mit Zeitgrenze.
    # `if` suppresses `set -e`; no pipe so the rc is npm's own (not tail's).
    elif pu_bounded 75 env HOME=/root npm install --omit=dev; then
      [[ -n "$CURRENT_HASH" ]] && printf '%s\n' "$CURRENT_HASH" >"$NPM_MARKER"
      echo "  npm install: OK"
    else
      echo "  WARN: npm install fehlgeschlagen oder Zeit aufgebraucht (non-fatal). Marker NICHT aktualisiert -> Retry beim naechsten Lauf." >&2
    fi
  fi
fi

# ── 7. Berechtigungen ──
# Nur Konfiguration gehört dem Dienstbenutzer; der Programmordner bleibt root
# (Schritt 0). Früher: chown -R auf $INSTALL_DIR — siehe Review 25.10.2026.
chown -R "$SERVICE_USER:$SERVICE_USER" "$CONFIG_DIR" 2>/dev/null || true
echo "  Berechtigungen: OK"

# ── 8. systemd Service aktuell? ──
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
CURRENT_EXECSTART=$(grep "^ExecStart=" "$SERVICE_FILE" 2>/dev/null | head -1 || echo "")
EXPECTED_EXECSTART="ExecStart=/usr/bin/node ${APP_DIR}/server.js"
SERVICE_CHANGED=0
if [[ "$CURRENT_EXECSTART" != "$EXPECTED_EXECSTART" ]]; then
  echo "  Service-Datei wird aktualisiert..."
  sed -i "s|^ExecStart=.*|${EXPECTED_EXECSTART}|" "$SERVICE_FILE"
  SERVICE_CHANGED=1
fi

# Phase 16 D-09: ensure the ExecStartPre hook is present in the LIVE unit file.
# Existing prod boxes were installed before this hook existed, and a tar|ssh deploy
# never re-runs install.sh — so post-update.sh must add the hook to the unit itself.
# T-0077: the hook MUST be non-fatal ('-+'). A box installed before T-0077 carries
# the old fatal form ('+', no '-'); migrate it in place so a failed/offline
# post-update can never block the service start. Idempotent: insert if absent,
# rewrite only if the present line differs from the expected non-fatal form.
EXPECTED_EXECSTARTPRE="ExecStartPre=-+/usr/bin/bash ${PU_CODE_DIR:-$INSTALL_DIR}/post-update.sh"
if [[ -f "$SERVICE_FILE" ]]; then
  CURRENT_EXECSTARTPRE="$(grep -E '^ExecStartPre=.*post-update\.sh' "$SERVICE_FILE" | head -1 || echo "")"
  if [[ -z "$CURRENT_EXECSTARTPRE" ]]; then
    echo "  ExecStartPre-Hook (D-09) wird eingefuegt..."
    # Insert the ExecStartPre line immediately before the ExecStart= line.
    sed -i "\|^ExecStart=|i ${EXPECTED_EXECSTARTPRE}" "$SERVICE_FILE"
    SERVICE_CHANGED=1
  elif [[ "$CURRENT_EXECSTARTPRE" != "$EXPECTED_EXECSTARTPRE" ]]; then
    echo "  ExecStartPre-Hook (T-0077) auf non-fatal (-+) migriert..."
    sed -i "s|^ExecStartPre=.*post-update\.sh.*|${EXPECTED_EXECSTARTPRE}|" "$SERVICE_FILE"
    SERVICE_CHANGED=1
  fi
fi

# T-0077 (P0-3, Hub-refute Auflage): ensure an explicit start timeout bounds a
# WEDGED ExecStartPre (post-update.sh). The '-' prefix ignores a non-zero EXIT but
# NOT a hang; without TimeoutStartSec a wedged start (npm/apt blocking on a
# dead-but-accepting network) hits systemd's 90s default and Restart=always loops.
# Insert once if absent (idempotent); existing boxes never re-run install.sh.
if [[ -f "$SERVICE_FILE" ]] && ! grep -qE '^TimeoutStartSec=' "$SERVICE_FILE"; then
  echo "  TimeoutStartSec=120 (T-0077) wird eingefuegt..."
  sed -i "\|^ExecStart=|a TimeoutStartSec=120" "$SERVICE_FILE"
  SERVICE_CHANGED=1
fi

# A2 (Improvements 2026-07-02): bounded STOP timeout as belt-and-braces to the
# in-app 5s shutdown watchdog. Before the watchdog, 3 of 6 observed stops hung
# the full systemd 90s default and ended in SIGKILL; a clean stop needs ~1-6s.
# TimeoutStopSec=15 keeps a wedged SYNC teardown step (or a wedged node) from
# stretching every restart/update to 90s. Same idempotent insert-once pattern
# as TimeoutStartSec above (existing boxes never re-run install.sh).
if [[ -f "$SERVICE_FILE" ]] && ! grep -qE '^TimeoutStopSec=' "$SERVICE_FILE"; then
  echo "  TimeoutStopSec=15 (A2) wird eingefuegt..."
  sed -i "\|^ExecStart=|a TimeoutStopSec=15" "$SERVICE_FILE"
  SERVICE_CHANGED=1
fi

if [[ "$SERVICE_CHANGED" -eq 1 ]]; then
  systemctl daemon-reload
fi
echo "  systemd Service: OK"

# ── 9. Support-Provisioning (T-0113 Tier 3, idempotent) ──
# Ensure the reverse-SSH support-tunnel prerequisites (appliance-id, relay
# keypair, hostkey pin, relay sidecar) and reconcile the dvhub-support login user
# to the config flag support.localUser.enabled. Shared with install.sh via the
# same support-provision.sh so the two never drift. Runs as root (this hook is
# ExecStartPre with '+'). NON-FATAL — a provisioning hiccup must never block boot.
if [[ -f "$INSTALL_DIR/support-provision.sh" ]]; then
  echo "  Support-Provisioning (T-0113)..."
  if pu_bounded 30 env SERVICE_USER="$SERVICE_USER" DATA_DIR="$DATA_DIR" CONFIG_PATH="$CONFIG_PATH" \
         bash "$INSTALL_DIR/support-provision.sh"; then
    echo "  Support-Provisioning: OK"
  else
    echo "  WARN: Support-Provisioning fehlgeschlagen (non-fatal). Fern-Support ggf. bis zum nächsten Lauf eingeschränkt." >&2
  fi
fi

# ── 9b. EEBUS (dvhub-eebus) bauen/aktualisieren (entkoppelt, idempotent) ──
# Nur wenn EEBUS aktiviert ist oder dvhub-eebus schon installiert war: dann
# baut eebus-provision.sh den Hilfsprozess im Hintergrund (Go-Fassung: Go von
# go.dev + eebus-go) — der Boot wird nie blockiert. NON-FATAL.
if [[ -f "$INSTALL_DIR/eebus-provision.sh" && ! -f "$DATA_DIR/.no-eebus" ]]; then
  EEBUS_ON=0
  if command -v node >/dev/null 2>&1 && [[ -f "$CONFIG_PATH" ]]; then
    node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(c?.eebus?.enabled===true?0:1)' "$CONFIG_PATH" 2>/dev/null && EEBUS_ON=1
  fi
  if [[ "$EEBUS_ON" -eq 1 || -x "$INSTALL_DIR/bin/dvhub-eebus" ]]; then
    if systemctl is-active --quiet dvhub-eebus-provision.service 2>/dev/null; then
      echo "  EEBUS: Bau läuft bereits"
    elif command -v systemd-run >/dev/null 2>&1; then
      systemd-run --collect --quiet --unit "dvhub-eebus-provision" \
        --description "DVhub EEBUS provisioning" \
        --setenv=INSTALL_DIR="$INSTALL_DIR" --setenv=DATA_DIR="$DATA_DIR" \
        bash "$INSTALL_DIR/eebus-provision.sh" 2>/dev/null \
        && echo "  EEBUS: Prüfung/Bau im Hintergrund gestartet" \
        || echo "  EEBUS: Hintergrund-Start fehlgeschlagen (non-fatal)"
    fi
  fi
fi

# ── 10. EOS-Provisionierung / Retrofit (idempotent, entkoppelt) ──
# EOS läuft seit v1.0 standardmäßig als DV-Fork. Boxen, die vor dieser Änderung
# ohne EOS installiert wurden, werden hier nachgerüstet (Provisioning-Logik in
# der gemeinsamen eos-provision.sh, geteilt mit install.sh). Das schwere
# clone+pip darf den Service-Start NIE blockieren (ExecStartPre, TimeoutStartSec=
# 120): fehlt EOS oder ist es veraltet, wird die Provisionierung ENTKOPPELT über
# eine eigene transient systemd-Unit gestartet (überlebt dvhub-Restarts). Ein
# bereits aktueller Stand wird nur schnell auf "läuft" geprüft (kein fetch/pip
# pro Boot) — "aktuell" heisst: der Marker $DATA_DIR/.eos-provisioned stimmt mit
# eos-version.env überein. KEIN RAM-Gate mehr (Christin 2026-09-20): EOS kommt
# immer mit. Opt-out weiterhin via $DATA_DIR/.no-eos. NON-FATAL durchgängig.
EOS_DIR="$INSTALL_DIR/eos"
EOS_VENV="$INSTALL_DIR/eos-venv"
EOS_UNIT_PATH="${EOS_UNIT_PATH:-/etc/systemd/system/eos.service}"
if [[ -f "$INSTALL_DIR/eos-provision.sh" && ! -f "$DATA_DIR/.no-eos" ]]; then
  # Gewuenschter EOS-Stand aus eos-version.env gegen den zuletzt installierten
  # (Marker $DATA_DIR/.eos-provisioned) — reiner Dateivergleich, KEIN Netzzugriff,
  # also weiterhin billig genug fuer jeden Boot.
  EOS_WANT=""
  if [[ -f "$INSTALL_DIR/eos-version.env" ]]; then
    _pr="$(grep -E '^EOS_REPO_URL=' "$INSTALL_DIR/eos-version.env" | tail -1 | cut -d= -f2- | tr -d '"'"'"'\r')"
    _pp="$(grep -E '^EOS_PIN=' "$INSTALL_DIR/eos-version.env" | tail -1 | cut -d= -f2- | tr -d '"'"'"'\r')"
    [[ -n "$_pr" && -n "$_pp" ]] && EOS_WANT="${_pr}@${_pp}"
  fi
  EOS_HAVE="$(cat "$DATA_DIR/.eos-provisioned" 2>/dev/null || true)"
  # Bestandsboxen haben noch keinen Marker. Die laufen hier einmalig durch die
  # (entkoppelte) Provisionierung — idempotent, und danach ist die Flotte auf
  # einem nachweisbaren Stand statt auf "irgendwas von damals".
  EOS_CURRENT=0
  [[ -n "$EOS_WANT" && "$EOS_HAVE" == "$EOS_WANT" ]] && EOS_CURRENT=1
  # Ausfuehrbares venv gehoert dazu (Review 25.10.2026): ein Update, das
  # eos-venv/ weggeraeumt hatte, meldete sonst "EOS: OK" mit totem Dienst.
  if [[ -d "$EOS_DIR/.git" && -f "$EOS_UNIT_PATH" && -x "$EOS_VENV/bin/python" && "$EOS_CURRENT" -eq 1 ]]; then
    # Aktuell — nur sicherstellen, dass der Dienst läuft (schnell).
    systemctl enable eos.service >/dev/null 2>&1 || true
    systemctl is-active --quiet eos.service || systemctl start eos.service >/dev/null 2>&1 || true
    echo "  EOS: OK (aktuell: ${EOS_HAVE})"
  elif systemctl is-active --quiet dvhub-eos-provision.service 2>/dev/null; then
    echo "  EOS: Hintergrund-Provisionierung läuft bereits"
  else
    # Fehlt ODER veraltet -> entkoppelt nachziehen, damit clone+pip den Boot nie
    # blockiert. Genau hier landet auch das EOS-Upgrade: eine neue Version in
    # eos-version.env macht den Marker ungleich, und der naechste Service-Start
    # stoesst die Neu-Provisionierung an.
    if [[ -d "$EOS_DIR/.git" && -n "$EOS_HAVE" ]]; then
      echo "  EOS: neue Version angefordert (${EOS_HAVE:-unbekannt} -> ${EOS_WANT}) — starte entkoppelte Aktualisierung..."
    else
      echo "  EOS: nicht installiert oder Stand unbekannt — starte entkoppelte Hintergrund-Provisionierung..."
    fi
    if command -v systemd-run >/dev/null 2>&1; then
      systemd-run --collect --quiet --unit "dvhub-eos-provision" \
        --description "DVhub EOS provisioning (retrofit)" \
        --setenv=SERVICE_USER="$SERVICE_USER" \
        --setenv=INSTALL_DIR="$INSTALL_DIR" \
        --setenv=DATA_DIR="$DATA_DIR" \
        bash "$INSTALL_DIR/eos-provision.sh" 2>/dev/null \
        || echo "  WARN: EOS-Hintergrund-Provisionierung konnte nicht gestartet werden (non-fatal)." >&2
    else
      SERVICE_USER="$SERVICE_USER" INSTALL_DIR="$INSTALL_DIR" DATA_DIR="$DATA_DIR" \
        setsid bash "$INSTALL_DIR/eos-provision.sh" </dev/null >>"$DATA_DIR/eos-provision.log" 2>&1 &
    fi
  fi
fi

# ── 11. Forecast-venv-Provisionierung / Retrofit (idempotent, entkoppelt) ──
# Das Forecast-Python-venv (/opt/dvhub/forecast-venv, pvlib/statsforecast/…
# aus python/requirements.lock) wird vom Installer angelegt. Boxen, die
# VOR der Forecast-venv-Einführung installiert wurden — oder deren Lockfile sich
# geändert hat — werden hier nachgerüstet (Provisioning in der gemeinsamen
# forecast-provision.sh, geteilt mit install.sh). Der pip-Lauf ist schwer
# (numpy/scipy/pvlib/statsforecast) und darf den Service-Start NIE blockieren
# (ExecStartPre, TimeoutStartSec=120): fehlt/veraltet das venv, wird die
# Provisionierung ENTKOPPELT über eine eigene transiente systemd-Unit gestartet
# (überlebt dvhub-Restarts). Aktuelles venv = schneller Marker-Check (kein pip pro
# Boot). NON-FATAL durchgängig. Laufzeit-Consumer: services/python-bridge.
FORECAST_VENV="$INSTALL_DIR/forecast-venv"
FC_LOCK="$APP_DIR/python/requirements.lock"
[[ -f "$FC_LOCK" ]] || FC_LOCK="$APP_DIR/python/requirements.txt"
FC_MARKER="$DATA_DIR/.forecast-venv.lockhash"
if [[ -f "$INSTALL_DIR/forecast-provision.sh" && -f "$FC_LOCK" ]]; then
  FC_CUR="$(sha256sum "$FC_LOCK" 2>/dev/null | awk '{print $1}')"
  FC_PREV="$(cat "$FC_MARKER" 2>/dev/null || echo '')"
  if [[ -x "$FORECAST_VENV/bin/python3" && -n "$FC_CUR" && "$FC_CUR" == "$FC_PREV" ]]; then
    echo "  Forecast-venv: OK (requirements unveraendert)"
  elif systemctl is-active --quiet dvhub-forecast-provision.service 2>/dev/null; then
    echo "  Forecast-venv: Hintergrund-Provisionierung laeuft bereits"
  else
    echo "  Forecast-venv: fehlt/veraltet — starte entkoppelte Hintergrund-Provisionierung..."
    if command -v systemd-run >/dev/null 2>&1; then
      systemd-run --collect --quiet --unit "dvhub-forecast-provision" \
        --description "DVhub forecast venv provisioning (retrofit)" \
        --setenv=SERVICE_USER="$SERVICE_USER" \
        --setenv=INSTALL_DIR="$INSTALL_DIR" \
        --setenv=APP_DIR="$APP_DIR" \
        --setenv=DATA_DIR="$DATA_DIR" \
        bash "$INSTALL_DIR/forecast-provision.sh" 2>/dev/null \
        || echo "  WARN: Forecast-venv-Hintergrund-Provisionierung konnte nicht gestartet werden (non-fatal)." >&2
    else
      SERVICE_USER="$SERVICE_USER" INSTALL_DIR="$INSTALL_DIR" APP_DIR="$APP_DIR" DATA_DIR="$DATA_DIR" \
        setsid bash "$INSTALL_DIR/forecast-provision.sh" </dev/null >>"$DATA_DIR/forecast-provision.log" 2>&1 &
    fi
  fi
fi

# ── 12. TimescaleDB-Provisionierung / Retrofit (idempotent, entkoppelt) ──
# Boxen, die VOR der TimescaleDB-Installer-Provisionierung (Christin 2026-07-02)
# aufgesetzt wurden, laufen auf reinem Postgres — inkonsistent zu prod und ein
# prod-Backup lässt sich nicht restaurieren. Hier nachgerüstet über die geteilte
# timescale-provision.sh (single source of truth mit install.sh). Der Lauf macht
# u.a. `apt install` + einen Postgres-RESTART; das darf den dvhub-Service-Start
# NIE stören → ENTKOPPELT über eine transiente systemd-Unit (überlebt
# dvhub-Restarts, unterbricht den Boot nicht). Schneller Skip nur wenn die
# COMMUNITY-Edition schon aktiv ist (prod = No-op); eine Apache-Box oder eine Box
# ganz ohne Extension triggert die (Re-)Provisionierung, die dann auf Community
# hochzieht (ALTER EXTENSION UPDATE). NON-FATAL durchgängig.
# PostgreSQL schreibarm (2026-10-01, SD-Karte): idempotent, nur Reload.
if [[ -f "$INSTALL_DIR/pg-write-tuning.sh" ]] && command -v psql >/dev/null 2>&1; then
  pu_bounded 30 bash "$INSTALL_DIR/pg-write-tuning.sh" || true
fi
if [[ -f "$INSTALL_DIR/timescale-provision.sh" ]] && command -v psql >/dev/null 2>&1; then
  TS_ACTIVE=0
  # `su postgres` (NON-login): a login shell would prepend the postgres user's MOTD
  # banner (community-scripts Proxmox LXCs — prod's platform) to the psql output,
  # so the == "timescale" check would wrongly fail and re-launch provisioning on
  # every restart.
  # Seit 21.10.2026 entscheidet timescale-provision.sh --check: fertig erst, wenn
  # die Bibliothek laedt, keine Parktabelle wartet und keine Hypertable Zeilen in
  # ihrer Elterntabelle hat (Begruendung dort). Scheitert die Abfrage, weil die
  # Bibliothek zur Katalog-Version fehlt, startet die Nachruestung und repariert.
  # Zeitgrenze: haengt PostgreSQL (z. B. noch im Recovery), entscheidet der
  # naechste Start; die Nachruestung startet dann nicht unnoetig.
  TS_RC=0
  TS_CHECK="$(pu_bounded 20 env DB_NAME=dvhub bash "$INSTALL_DIR/timescale-provision.sh" --check 2>/dev/null)" || TS_RC=$?
  [[ "$TS_CHECK" == "timescale" ]] && TS_ACTIVE=1
  if [[ "$TS_ACTIVE" -eq 1 ]]; then
    echo "  TimescaleDB: OK (Community-Edition aktiv)"
  elif [[ "$TS_RC" -eq 124 || "$TS_RC" -eq 137 ]]; then
    echo "  TimescaleDB: Pruefung ueber der Zeitgrenze — entscheidet der naechste Start" >&2
  elif systemctl is-active --quiet dvhub-timescale-provision.service 2>/dev/null; then
    echo "  TimescaleDB: Hintergrund-Provisionierung laeuft bereits"
  else
    echo "  TimescaleDB: nicht aktiv — starte entkoppelte Hintergrund-Provisionierung..."
    if command -v systemd-run >/dev/null 2>&1; then
      # Ausgabe in dieselbe Datei wie beim setsid-Weg unten (das Journal ist fuer
      # den Support-Zugang nicht lesbar).
      systemd-run --collect --quiet --unit "dvhub-timescale-provision" \
        --description "DVhub TimescaleDB provisioning (retrofit)" \
        --property=StandardOutput="append:$DATA_DIR/timescale-provision.log" \
        --property=StandardError="append:$DATA_DIR/timescale-provision.log" \
        --setenv=SERVICE_USER="$SERVICE_USER" \
        --setenv=INSTALL_DIR="$INSTALL_DIR" \
        --setenv=DATA_DIR="$DATA_DIR" \
        --setenv=CONFIG_PATH="$CONFIG_PATH" \
        --setenv=DB_NAME=dvhub \
        bash "$INSTALL_DIR/timescale-provision.sh" 2>/dev/null \
        || echo "  WARN: TimescaleDB-Hintergrund-Provisionierung konnte nicht gestartet werden (non-fatal)." >&2
    else
      SERVICE_USER="$SERVICE_USER" INSTALL_DIR="$INSTALL_DIR" DATA_DIR="$DATA_DIR" CONFIG_PATH="$CONFIG_PATH" DB_NAME=dvhub \
        setsid bash "$INSTALL_DIR/timescale-provision.sh" </dev/null >>"$DATA_DIR/timescale-provision.log" 2>&1 &
    fi
  fi
fi

# TimescaleDB package-maintenance timer (Christin 2026-07-02, "Pakete auto"):
# ensure the nightly apt-only maintenance unit exists on boxes provisioned before
# this feature. Create-if-missing (idempotent) — the units just call
# ${INSTALL_DIR}/pkg-maintain.sh, so no rewrite is needed once present. The unit
# body is kept in sync with install.sh. NON-FATAL.
if [[ -f "$INSTALL_DIR/pkg-maintain.sh" ]] && [[ ! -f /etc/systemd/system/dvhub-pkg-maintain.timer ]]; then
  echo "  pkg-maintain: richte naechtlichen Paket-Wartungs-Timer ein..."
  cat >/etc/systemd/system/dvhub-pkg-maintain.service <<PKGSVC
[Unit]
Description=DVhub TimescaleDB package maintenance (apt only, no restart)
After=postgresql.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=INSTALL_DIR=${INSTALL_DIR}
Environment=SERVICE_USER=${SERVICE_USER}
Environment=DATA_DIR=${DATA_DIR}
Environment=DB_NAME=dvhub
ExecStart=/usr/bin/bash ${INSTALL_DIR}/pkg-maintain.sh
PKGSVC
  cat >/etc/systemd/system/dvhub-pkg-maintain.timer <<PKGTIMER
[Unit]
Description=DVhub TimescaleDB package maintenance (nightly)

[Timer]
OnCalendar=*-*-* 03:17:00
RandomizedDelaySec=1200
Persistent=true

[Install]
WantedBy=timers.target
PKGTIMER
  systemctl daemon-reload 2>/dev/null || true
  systemctl enable --now dvhub-pkg-maintain.timer >/dev/null 2>&1 || true
fi

# ── 13. Stack-Update bei Versionswechsel (entkoppelt, 2026-10-15) ──
# Christin: ein Update auf eine neue DVhub-Version soll alles auf den neuesten
# Stand bringen. npm (Schritt 6), Python (11) und EOS (10) laufen schon
# versionsgesteuert; stack-update.sh hebt zusätzlich TimescaleDB-Pakete, die
# System-Pakete des Stacks (innerhalb ihrer Hauptversion) und die
# TimescaleDB-Erweiterung in der Datenbank an und startet DVhub bei Bedarf neu.
# Nur einmal je Version: der Marker wird VOR dem Start geschrieben — ein
# DVhub-Neustart aus stack-update.sh löst es nicht erneut aus. NON-FATAL.
if [[ -f "$INSTALL_DIR/stack-update.sh" ]]; then
  STACK_VER="$(grep -m1 '"version"' "$APP_DIR/package.json" 2>/dev/null | sed -E 's/.*"version" *: *"([^"]+)".*/\1/')"
  STACK_REV="${PU_RELEASE_REV:-$(git -C "$INSTALL_DIR" rev-parse --short HEAD 2>/dev/null || echo nogit)}"
  STACK_WANT="${STACK_VER:-unbekannt}@${STACK_REV}"
  STACK_MARKER="$DATA_DIR/.stack-updated-version"
  if [[ "$(cat "$STACK_MARKER" 2>/dev/null)" == "$STACK_WANT" ]]; then
    echo "  Stack-Update: OK (${STACK_WANT})"
  elif systemctl is-active --quiet dvhub-stack-update.service 2>/dev/null; then
    echo "  Stack-Update: laeuft bereits"
  else
    echo "$STACK_WANT" > "$STACK_MARKER" 2>/dev/null || true
    echo "  Stack-Update: neue Version ${STACK_WANT} — starte entkoppelt (Pakete, TimescaleDB)"
    if command -v systemd-run >/dev/null 2>&1; then
      systemd-run --collect --quiet --unit "dvhub-stack-update" \
        --description "DVhub Stack-Update (Pakete, TimescaleDB) nach Versions-Update" \
        --setenv=INSTALL_DIR="$INSTALL_DIR" --setenv=DATA_DIR="$DATA_DIR" \
        --setenv=SERVICE_NAME="$SERVICE_NAME" --setenv=DB_NAME=dvhub \
        --setenv=STACK_UPDATE_VERSION="$STACK_WANT" \
        bash "$INSTALL_DIR/stack-update.sh" 2>/dev/null \
        || echo "  WARN: Stack-Update konnte nicht gestartet werden (non-fatal)." >&2
    else
      INSTALL_DIR="$INSTALL_DIR" DATA_DIR="$DATA_DIR" SERVICE_NAME="$SERVICE_NAME" DB_NAME=dvhub STACK_UPDATE_VERSION="$STACK_WANT" \
        setsid bash "$INSTALL_DIR/stack-update.sh" </dev/null >>"$DATA_DIR/stack-update.log" 2>&1 &
    fi
  fi
fi

# BEGIN DVHUB RELEASE BOOT HOOK — Release-Pakete (docs/release-pakete.md)
# Paket-Box: einen durch Stromausfall unterbrochenen Auftrag fortsetzen.
# git-Box: die einmalige Umstellung auf Pakete planen (als Zeitgeber-Unit, nach
# dem Neustart der Oberfläche; nur offizielles Repo, sauberer Checkout,
# Schlüssel vorhanden, höchstens alle 24 h). NON-FATAL.
if [[ -x "${RELEASE_HELPER_PATH:-}" ]]; then
  pu_bounded 20 "$RELEASE_HELPER_PATH" boot-hook || echo "  WARN: dvhub-release boot-hook fehlgeschlagen (non-fatal)" >&2
fi
# END DVHUB RELEASE BOOT HOOK

echo ""
echo "Post-Update abgeschlossen. Neustart mit: systemctl restart ${SERVICE_NAME}"
