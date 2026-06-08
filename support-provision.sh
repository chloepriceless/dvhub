#!/usr/bin/env bash
# support-provision.sh — T-0113 Tier 3: idempotent provisioning for the
# customer-initiated reverse-SSH support tunnel.
#
# Shared by install.sh (first install) AND post-update.sh (ExecStartPre on every
# service start) so the two never drift — same pattern as the sudoers block.
# Safe to run repeatedly. Requires root (writes /var/lib/dvhub, creates a user).
#
# What it ensures:
#   * appliance-id   — a UUID at ${DATA_DIR}/appliance-id (relay-registry key)
#   * relay keypair  — Level A (Appliance->Relay), ${DATA_DIR}/support/relay_id_ed25519,
#                      generated locally, PRIVATE key never leaves the box
#   * known_hosts    — the relay hostkey PIN (guards first-connect MITM)
#   * relay.json     — sidecar with host/port/user; peer-assigned shellPort/webPort
#                      are PRESERVED (kept out of config.json, which is overwritten
#                      verbatim by POST /api/config)
#   * dvhub-support  — OPTIONAL login user (group dvhub, NO sudo) carrying Christin's
#                      support pubkey (Level B). Default ON (opt-out). Reconciled to
#                      the config flag support.localUser.enabled unless overridden.
#
# Security model: the deposited support key alone grants NOTHING — the box sits
# behind NAT and is only reachable while the customer holds a tunnel open (a
# customer-initiated, time-bounded, killable action in the UI). The runtime tunnel
# runs entirely as the unprivileged dvhub user (outbound autossh, no sudo).
set -euo pipefail

SERVICE_USER="${SERVICE_USER:-dvhub}"
DATA_DIR="${DATA_DIR:-/var/lib/dvhub}"
CONFIG_PATH="${CONFIG_PATH:-/etc/dvhub/config.json}"
# SUPPORT_LOCAL_USER: explicit override. "1" force-create, "0" force-remove.
# Empty -> follow the config flag support.localUser.enabled (default ON / opt-out).
SUPPORT_LOCAL_USER="${SUPPORT_LOCAL_USER:-}"

# --- public constants --------------------------------------------------------
SUPPORT_USER="dvhub-support"
RELAY_HOST="support.dvhub.de"
RELAY_PORT="47821"
RELAY_USER="dvhub-support"
# Relay hostkey PIN (S4, from the Hetzner support relay). Guards the first connect
# against MITM. StrictHostKeyChecking=yes on the client refuses on mismatch.
RELAY_HOSTKEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMCBb6vi0LTevujdKl0Vz9y8YvE2uMIjJvYbPZ9WDpyT"
# Christin's support PUBLIC key (Level B — login on the appliance). Public by
# nature; safe to bake in. The matching private key stays with Christin only.
SUPPORT_PUBKEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAsaBYifIY6dFAGzDtF28qVa75IHaMRzEx5buoGDhWBN dvhub-support"

if [[ "${EUID}" -ne 0 ]]; then
  echo "support-provision.sh muss als root ausgeführt werden." >&2
  exit 1
fi

SUP_DIR="$DATA_DIR/support"
mkdir -p "$SUP_DIR"

# 1. appliance-id (UUID; relay registry is keyed by it; ^[a-z0-9-]{1,36}$) -----
APPLIANCE_ID_FILE="$DATA_DIR/appliance-id"
if [[ ! -s "$APPLIANCE_ID_FILE" ]]; then
  if [[ -r /proc/sys/kernel/random/uuid ]]; then
    tr 'A-Z' 'a-z' < /proc/sys/kernel/random/uuid > "$APPLIANCE_ID_FILE"
  else
    node -e 'console.log(require("crypto").randomUUID())' > "$APPLIANCE_ID_FILE"
  fi
fi
APPLIANCE_ID="$(tr -d '[:space:]' < "$APPLIANCE_ID_FILE" 2>/dev/null || echo "")"

# 2. relay keypair — Level A, Appliance->Relay (private key never leaves) -------
KEY="$SUP_DIR/relay_id_ed25519"
if [[ ! -f "$KEY" ]]; then
  ssh-keygen -t ed25519 -N "" -f "$KEY" -C "dvhub-appliance-${APPLIANCE_ID}" >/dev/null
fi

# 3. relay hostkey pin (known_hosts) ------------------------------------------
KNOWN_HOSTS="$SUP_DIR/known_hosts"
PIN_LINE="[${RELAY_HOST}]:${RELAY_PORT} ${RELAY_HOSTKEY}"
if [[ ! -f "$KNOWN_HOSTS" ]] || ! grep -qF "$RELAY_HOSTKEY" "$KNOWN_HOSTS"; then
  printf '%s\n' "$PIN_LINE" > "$KNOWN_HOSTS"
fi

# 4. relay sidecar — host/port/user; PRESERVE peer-assigned ports --------------
SIDECAR="$SUP_DIR/relay.json"
node -e '
  const fs = require("fs");
  const [p, host, port, user] = process.argv.slice(1);
  let o = {};
  try { o = JSON.parse(fs.readFileSync(p, "utf8")) || {}; } catch { o = {}; }
  o.host = host; o.port = Number(port); o.user = user;
  if (o.shellPort == null) o.shellPort = 0;
  if (o.webPort == null) o.webPort = 0;
  fs.writeFileSync(p, JSON.stringify(o, null, 2) + "\n");
' "$SIDECAR" "$RELAY_HOST" "$RELAY_PORT" "$RELAY_USER"

# 5. ownership + permissions (dvhub owns its keys; private key 0600) -----------
chown -R "$SERVICE_USER:$SERVICE_USER" "$SUP_DIR" 2>/dev/null || true
chown "$SERVICE_USER:$SERVICE_USER" "$APPLIANCE_ID_FILE" 2>/dev/null || true
chmod 700 "$SUP_DIR"
chmod 600 "$KEY" 2>/dev/null || true
chmod 644 "$KEY.pub" "$KNOWN_HOSTS" "$SIDECAR" "$APPLIANCE_ID_FILE" 2>/dev/null || true

# 6. decide whether the dvhub-support login user should exist ------------------
WANT_USER=1
if [[ "$SUPPORT_LOCAL_USER" == "0" ]]; then
  WANT_USER=0
elif [[ "$SUPPORT_LOCAL_USER" == "1" ]]; then
  WANT_USER=1
else
  # No explicit flag -> follow the config flag (default ON / opt-out).
  FLAG="$(node -e '
    try { const c = require(process.argv[1]); process.stdout.write(c?.support?.localUser?.enabled === false ? "false" : "true"); }
    catch { process.stdout.write("true"); }
  ' "$CONFIG_PATH" 2>/dev/null || echo true)"
  [[ "$FLAG" == "false" ]] && WANT_USER=0 || WANT_USER=1
fi

if [[ "$WANT_USER" == "1" ]]; then
  if ! id "$SUPPORT_USER" >/dev/null 2>&1; then
    # Login user in the dvhub GROUP (so it shares dvhub-scoped read access),
    # own shell, NO sudo. More rights are the customer's call, never ours.
    useradd --create-home --shell /bin/bash --gid "$SERVICE_USER" "$SUPPORT_USER"
  fi
  SUPPORT_HOME="$(getent passwd "$SUPPORT_USER" | cut -d: -f6)"
  SSH_DIR="${SUPPORT_HOME:-/home/$SUPPORT_USER}/.ssh"
  AUTH="$SSH_DIR/authorized_keys"
  mkdir -p "$SSH_DIR"
  # Idempotent: ensure exactly the support pubkey is authorized (no duplicates).
  if [[ ! -f "$AUTH" ]] || ! grep -qF "$SUPPORT_PUBKEY" "$AUTH"; then
    printf '%s\n' "$SUPPORT_PUBKEY" > "$AUTH"
  fi
  chown -R "$SUPPORT_USER:$SERVICE_USER" "$SSH_DIR"
  chmod 700 "$SSH_DIR"
  chmod 600 "$AUTH"
  echo "  Support: Login-User '$SUPPORT_USER' bereit (Gruppe $SERVICE_USER, kein sudo). Zugang nur via kundeninitiiertem Tunnel."
else
  if id "$SUPPORT_USER" >/dev/null 2>&1; then
    userdel -r "$SUPPORT_USER" 2>/dev/null || userdel "$SUPPORT_USER" 2>/dev/null || true
    echo "  Support: Login-User '$SUPPORT_USER' entfernt (opt-out: support.localUser.enabled=false)."
  else
    echo "  Support: kein Login-User (opt-out)."
  fi
fi

echo "  Support: appliance-id=${APPLIANCE_ID} · Relay=${RELAY_USER}@${RELAY_HOST}:${RELAY_PORT}"
echo "  Support: Relay-PUBkey (für Registrierung beim Support):"
echo "    $(cat "$KEY.pub" 2>/dev/null || echo '<fehlt>')"
