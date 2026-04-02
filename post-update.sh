#!/usr/bin/env bash
# post-update.sh -- Idempotent system-level setup for DVhub.
# Run as root after git pull to ensure all system requirements are met.
# Safe to run multiple times — only applies changes that are missing.
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/dvhub}"
APP_DIR="${APP_DIR:-$INSTALL_DIR/dvhub}"
SERVICE_USER="${SERVICE_USER:-dvhub}"
SERVICE_NAME="${SERVICE_NAME:-dvhub}"
CONFIG_DIR="${CONFIG_DIR:-/etc/dvhub}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Dieses Skript muss als root ausgeführt werden." >&2
  exit 1
fi

echo "DVhub post-update (idempotent)"

# ── 1. Pakete ──
NEEDED_PKGS=""
for pkg in openvpn wireguard-tools strongswan; do
  if ! dpkg -s "$pkg" >/dev/null 2>&1; then
    NEEDED_PKGS="$NEEDED_PKGS $pkg"
  fi
done
if [[ -n "$NEEDED_PKGS" ]]; then
  echo "  Installiere fehlende Pakete:$NEEDED_PKGS"
  apt-get update -qq
  apt-get install -y $NEEDED_PKGS
else
  echo "  Pakete: OK"
fi

# ── 2. Node capabilities (privileged ports 80, 443, 502) ──
NODE_BIN="$(command -v node)"
if [[ -n "$NODE_BIN" ]]; then
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

# ── 4. Self-Signed TLS Zertifikat ──
if [[ ! -f "$CONFIG_DIR/tls/cert.pem" ]]; then
  echo "  Generiere Self-Signed TLS Zertifikat..."
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$CONFIG_DIR/tls/key.pem" \
    -out "$CONFIG_DIR/tls/cert.pem" \
    -days 3650 -subj "/CN=dvhub/O=DVhub/C=DE" 2>/dev/null
  chmod 600 "$CONFIG_DIR/tls/key.pem"
  chown "$SERVICE_USER:$SERVICE_USER" "$CONFIG_DIR/tls/"* 2>/dev/null || true
else
  echo "  TLS Zertifikat: OK"
fi

# ── 5. Sudoers (vollstaendig, idempotent) ──
OPENVPN_PATH="$(command -v openvpn || echo /usr/sbin/openvpn)"
WG_QUICK_PATH="$(command -v wg-quick || echo /usr/bin/wg-quick)"
WG_PATH="$(command -v wg || echo /usr/bin/wg)"
IPSEC_PATH="$(command -v ipsec || echo /usr/sbin/ipsec)"
IP_PATH="$(command -v ip || echo /usr/sbin/ip)"
KILL_PATH="$(which kill 2>/dev/null || echo /usr/bin/kill)"
SYSTEMCTL_PATH="$(command -v systemctl)"
LN_PATH="$(command -v ln || echo /usr/bin/ln)"
RM_PATH="$(command -v rm || echo /usr/bin/rm)"

SUDOERS_FILE="/etc/sudoers.d/${SERVICE_NAME}-service-actions"
cat >"${SUDOERS_FILE}" <<SUDOERS
${SERVICE_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL_PATH} restart ${SERVICE_NAME}.service
${SERVICE_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL_PATH} is-active ${SERVICE_NAME}.service
${SERVICE_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL_PATH} show ${SERVICE_NAME}.service *
${SERVICE_USER} ALL=(root) NOPASSWD: ${OPENVPN_PATH} --config *
${SERVICE_USER} ALL=(root) NOPASSWD: ${WG_QUICK_PATH} up *
${SERVICE_USER} ALL=(root) NOPASSWD: ${WG_QUICK_PATH} down *
${SERVICE_USER} ALL=(root) NOPASSWD: ${WG_PATH} show *
${SERVICE_USER} ALL=(root) NOPASSWD: ${IPSEC_PATH} up *
${SERVICE_USER} ALL=(root) NOPASSWD: ${IPSEC_PATH} down *
${SERVICE_USER} ALL=(root) NOPASSWD: ${IPSEC_PATH} status *
${SERVICE_USER} ALL=(root) NOPASSWD: ${IPSEC_PATH} reload
${SERVICE_USER} ALL=(root) NOPASSWD: ${LN_PATH} -sf *
${SERVICE_USER} ALL=(root) NOPASSWD: ${RM_PATH} -f /etc/ipsec.d/dvhub-*
${SERVICE_USER} ALL=(root) NOPASSWD: ${IP_PATH} link show *
${SERVICE_USER} ALL=(root) NOPASSWD: ${IP_PATH} addr show *
${SERVICE_USER} ALL=(root) NOPASSWD: ${KILL_PATH} -0 *
${SERVICE_USER} ALL=(root) NOPASSWD: ${KILL_PATH} -15 *
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/bash ${INSTALL_DIR}/post-update.sh
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/apt-get update *
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/apt-get upgrade *
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/apt list *
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/sbin/setcap *
SUDOERS
chmod 440 "${SUDOERS_FILE}"
echo "  Sudoers: OK"

# ── 6. npm install ──
if [[ -f "$APP_DIR/package.json" ]]; then
  cd "$APP_DIR"
  npm install --omit=dev 2>&1 | tail -1
  echo "  npm install: OK"
fi

# ── 7. Berechtigungen ──
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR" "$CONFIG_DIR" 2>/dev/null || true
echo "  Berechtigungen: OK"

# ── 8. systemd Service aktuell? ──
CURRENT_EXECSTART=$(grep "ExecStart=" /etc/systemd/system/${SERVICE_NAME}.service 2>/dev/null | head -1 || echo "")
EXPECTED_EXECSTART="ExecStart=/usr/bin/node ${APP_DIR}/server.js"
if [[ "$CURRENT_EXECSTART" != "$EXPECTED_EXECSTART" ]]; then
  echo "  Service-Datei wird aktualisiert..."
  sed -i "s|^ExecStart=.*|${EXPECTED_EXECSTART}|" /etc/systemd/system/${SERVICE_NAME}.service
  systemctl daemon-reload
fi
echo "  systemd Service: OK"

echo ""
echo "Post-Update abgeschlossen. Neustart mit: systemctl restart ${SERVICE_NAME}"
