#!/bin/sh
# DVhub Container-Entrypoint (WS6)
#
# Idempotent: mehrfaches Anwenden führt zum selben Soll-Zustand. Es gibt hier
# KEINEN destruktiven Schritt — nichts wird gelöscht, nichts überschrieben, was
# der Betreiber gesetzt hat. Die einzige Ausnahme sind die DVHUB_DB_*-Variablen,
# die deklarativ durchgereicht werden (gesetzte Umgebung gewinnt, siehe unten).
#
# Bildet die Teile von install.sh nach, die der Container braucht — ohne
# systemd, sudoers, VPN und Support-Tunnel.
set -eu

CONFIG_PATH="${DV_APP_CONFIG:-/etc/dvhub/config.json}"
CONFIG_DIR="$(dirname "$CONFIG_PATH")"
DATA_DIR="${DV_DATA_DIR:-/var/lib/dvhub}"
# Überschreibbar, damit ein abweichendes Layout (z. B. ein Add-on-Wrapper) und
# ein Testlauf außerhalb des Images denselben Pfad nutzen können.
APP_DIR="${DVHUB_APP_DIR:-/opt/dvhub/dvhub}"
SCRIPTS_DIR="${DVHUB_SCRIPTS_DIR:-/opt/dvhub/scripts}"
RUN_USER="${DVHUB_USER:-dvhub}"

log() { echo "[entrypoint] $*"; }

# ---------------------------------------------------------------------------
# 1. Verzeichnisse (mkdir -p ist idempotent)
# ---------------------------------------------------------------------------
mkdir -p "$CONFIG_DIR" "$CONFIG_DIR/hersteller" "$CONFIG_DIR/tls" "$DATA_DIR"

# ---------------------------------------------------------------------------
# 2. Config-Bootstrap — nur anlegen, nie überschreiben
# ---------------------------------------------------------------------------
if [ ! -f "$CONFIG_PATH" ]; then
  log "lege $CONFIG_PATH aus config.example.json an"
  cp "$APP_DIR/config.example.json" "$CONFIG_PATH"
  FRESH_CONFIG=1
else
  FRESH_CONFIG=0
fi

# ---------------------------------------------------------------------------
# 3. Config nachziehen
#
#   * apiToken        — nur erzeugen, wenn keiner/zu kurz (wie install.sh)
#   * httpPort        — bei FRISCHER Config auf den Container-Port; der
#                       ausgelieferte Default 80 ist für einen non-root-Prozess
#                       nicht bindbar. Eine mitgebrachte Config behält ihren
#                       Port — außer er liegt unter 1024 (httpPort → 8080,
#                       httpsPort → 8443, bzw. DVHUB_HTTP(S)_PORT).
#   * telemetry.database.* — deklarativ aus DVHUB_DB_* (inkl. DVHUB_DB_TIMESCALEDB), weil der Default ein
#                       Unix-Socket (/var/run/postgresql) ist, den es im
#                       Container nicht gibt. Nur GESETZTE Variablen wirken;
#                       nicht gesetzte lassen den vorhandenen Wert stehen.
# ---------------------------------------------------------------------------
FRESH_CONFIG="$FRESH_CONFIG" CONFIG_PATH="$CONFIG_PATH" node -e '
const fs = require("fs");
const crypto = require("crypto");
const p = process.env.CONFIG_PATH;
const fresh = process.env.FRESH_CONFIG === "1";
try {
  const c = JSON.parse(fs.readFileSync(p, "utf8"));
  let changed = false;

  if (!c.apiToken || String(c.apiToken).length < 16) {
    c.apiToken = crypto.randomBytes(24).toString("hex");
    changed = true;
  }

  if (fresh) {
    const port = Number(process.env.DVHUB_HTTP_PORT || 8080);
    if (Number.isFinite(port) && port > 0 && c.httpPort !== port) {
      c.httpPort = port;
      changed = true;
    }
  }

  // Mitgebrachte Config einer nativen Installation (httpPort 80, httpsPort
  // 443): der Prozess läuft ohne root und kann Ports < 1024 nicht öffnen —
  // web.listen würde den Start abbrechen. Auf die Container-Ports umlegen.
  const lowPort = (v) => Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) < 1024;
  if (lowPort(c.httpPort)) {
    const to = Number(process.env.DVHUB_HTTP_PORT || 8080);
    console.log(`[entrypoint] httpPort ${c.httpPort} ist ohne root nicht nutzbar -> ${to}`);
    c.httpPort = to;
    changed = true;
  }
  if (lowPort(c.httpsPort)) {
    const to = Number(process.env.DVHUB_HTTPS_PORT || 8443);
    console.log(`[entrypoint] httpsPort ${c.httpsPort} ist ohne root nicht nutzbar -> ${to}`);
    c.httpsPort = to;
    changed = true;
  }

  const dbEnv = {
    host: process.env.DVHUB_DB_HOST,
    port: process.env.DVHUB_DB_PORT,
    name: process.env.DVHUB_DB_NAME,
    user: process.env.DVHUB_DB_USER,
    password: process.env.DVHUB_DB_PASSWORD,
    // TimescaleDB-Flag: erst damit laufen Hypertable/Continuous-Aggregate-
    // Migrationen (nativ setzt es timescale-provision.sh). "true"/"false".
    timescaledb: process.env.DVHUB_DB_TIMESCALEDB
  };
  if (Object.values(dbEnv).some((v) => v !== undefined && v !== "")) {
    c.telemetry = c.telemetry || {};
    c.telemetry.database = c.telemetry.database || {};
    for (const [key, raw] of Object.entries(dbEnv)) {
      if (raw === undefined || raw === "") continue;
      const value = key === "port" ? Number(raw)
        : key === "timescaledb" ? /^(1|true|yes|on)$/i.test(String(raw))
        : raw;
      if (c.telemetry.database[key] !== value) {
        c.telemetry.database[key] = value;
        changed = true;
      }
    }
  }

  // EOS im Nachbar-Container (docker/compose.yml, Profil „eos“): Adresse
  // deklarativ setzen — eine mitgebrachte Config zeigt sonst auf den EOS der
  // alten Anlage (z. B. :8506). Eingeschaltet wird EOS weiter in DVhub (Pro).
  const eosUrl = process.env.DVHUB_EOS_URL;
  if (eosUrl) {
    c.optimizer = c.optimizer || {};
    c.optimizer.eosProxy = c.optimizer.eosProxy || {};
    if (c.optimizer.eosProxy.url !== eosUrl) {
      c.optimizer.eosProxy.url = eosUrl;
      changed = true;
    }
  }

  if (changed) fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n");
} catch (err) {
  console.error("[entrypoint] Config konnte nicht angepasst werden:", err.message);
  process.exit(1);
}
'

# ---------------------------------------------------------------------------
# 4. appliance-id — die Lizenz bindet daran (services/license/keygen-verify.js
#    readApplianceId liest $DV_DATA_DIR/appliance-id). Container-IDs sind
#    flüchtig, deshalb MUSS die Datei auf dem Volume liegen und darf nur einmal
#    erzeugt werden. Format wie support-provision.sh: kleingeschriebene UUID.
# ---------------------------------------------------------------------------
APPLIANCE_ID_FILE="$DATA_DIR/appliance-id"
if [ ! -s "$APPLIANCE_ID_FILE" ]; then
  if [ -r /proc/sys/kernel/random/uuid ]; then
    tr 'A-Z' 'a-z' < /proc/sys/kernel/random/uuid > "$APPLIANCE_ID_FILE"
  else
    node -e 'console.log(require("crypto").randomUUID())' > "$APPLIANCE_ID_FILE"
  fi
  log "appliance-id erzeugt: $(cat "$APPLIANCE_ID_FILE")"
fi

# ---------------------------------------------------------------------------
# 5. Herstellerprofile abgleichen (fehlende anlegen, Operator-Edits stehen
#    lassen). Non-fatal, genau wie in install.sh.
# ---------------------------------------------------------------------------
node "$SCRIPTS_DIR/reconcile-vendor-profiles.mjs" "$CONFIG_DIR" "$APP_DIR" \
  || log "Herstellerprofil-Abgleich übersprungen"

# ---------------------------------------------------------------------------
# 6. Auf die Datenbank warten (nur wenn ein TCP-Host konfiguriert ist).
#    Die Migrationen laufen beim Serverstart; ohne Warten wäre der erste Start
#    nach `up -d` ein Crash-Restart-Zyklus, bis Postgres oben ist.
# ---------------------------------------------------------------------------
if [ "${DVHUB_WAIT_FOR_DB:-1}" = "1" ]; then
  CONFIG_PATH="$CONFIG_PATH" node -e '
const fs = require("fs");
const net = require("net");
const timeoutSec = Number(process.env.DVHUB_WAIT_FOR_DB_TIMEOUT || 60);
let db = {};
try { db = (JSON.parse(fs.readFileSync(process.env.CONFIG_PATH, "utf8")).telemetry || {}).database || {}; } catch {}
const host = db.host;
// Unix-Socket oder keine Angabe: nichts zu warten.
if (!host || host.startsWith("/")) process.exit(0);
const port = Number(db.port || 5432);
const deadline = Date.now() + timeoutSec * 1000;
const probe = () => new Promise((resolve) => {
  const s = net.connect({ host, port });
  const done = (ok) => { s.destroy(); resolve(ok); };
  s.setTimeout(3000);
  s.once("connect", () => done(true));
  s.once("timeout", () => done(false));
  s.once("error", () => done(false));
});
(async () => {
  while (Date.now() < deadline) {
    if (await probe()) { console.log(`[entrypoint] Datenbank ${host}:${port} erreichbar`); process.exit(0); }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.error(`[entrypoint] Datenbank ${host}:${port} nach ${timeoutSec}s nicht erreichbar — starte trotzdem`);
  process.exit(0);
})();
'
fi

# ---------------------------------------------------------------------------
# 7. Node-Heap an das Container-Limit koppeln
#
# Node richtet seinen Heap NICHT nach dem cgroup-Limit: gemessen meldet es bei
# `--memory=96m` genauso 259 MB heap_size_limit wie bei `--memory=320m`. Ohne
# Deckel wächst der Heap also über die Container-Grenze hinaus und der Prozess
# wird vom OOM-Killer erschlagen, statt vorher aufzuräumen — auf einer 1-GB-Box
# (EnergyLink, DVhub + EOS teilen sich ~700 MB) ist das der wahrscheinlichste
# Absturzweg.
#
# Deshalb: Limit auslesen und daraus ~70 % als Heap-Obergrenze ableiten. Der
# Rest ist Puffer für Node-Binary, Stacks, Puffer und die Alpine-Laufzeit.
# Ein selbst gesetztes --max-old-space-size gewinnt immer.
# ---------------------------------------------------------------------------
if [ "${DVHUB_AUTO_HEAP:-1}" = "1" ] && ! echo "${NODE_OPTIONS:-}" | grep -q "max-old-space-size"; then
  LIMIT_BYTES=""
  if [ -r /sys/fs/cgroup/memory.max ]; then
    LIMIT_BYTES="$(cat /sys/fs/cgroup/memory.max 2>/dev/null)"          # cgroup v2
  elif [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
    LIMIT_BYTES="$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null)"  # cgroup v1
  fi
  # "max" (v2) bzw. absurd grosse Werte (v1 ohne Limit) bedeuten: unbegrenzt.
  case "$LIMIT_BYTES" in
    ''|max|*[!0-9]*) LIMIT_BYTES="" ;;
  esac
  if [ -n "$LIMIT_BYTES" ] && [ "$LIMIT_BYTES" -lt 68719476736 ] 2>/dev/null; then
    HEAP_MB=$(( LIMIT_BYTES / 1024 / 1024 * 70 / 100 ))
    # Unter ~64 MB Heap startet die Anwendung nicht sinnvoll; dann lieber
    # nichts setzen und den Betreiber das Limit korrigieren lassen.
    if [ "$HEAP_MB" -ge 64 ]; then
      NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=$HEAP_MB"
      export NODE_OPTIONS
      log "Container-Limit $(( LIMIT_BYTES / 1024 / 1024 )) MB erkannt -> --max-old-space-size=$HEAP_MB"
    else
      log "Container-Limit $(( LIMIT_BYTES / 1024 / 1024 )) MB ist sehr klein — kein Heap-Deckel gesetzt"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# EEBUS mDNS: dvhub-eebus findet Steuerbox und Geräte über Avahi (D-Bus).
# Stellt der Host Avahi bereit (D-Bus-Socket eingebunden, z. B. balena
# io.balena.features.dbus oder /run/dbus als Volume), wird der genutzt.
# Sonst — und nur wenn EEBUS aktiv ist — eigener dbus + avahi im Container
# (Host-Netz). Fehlschläge sind nicht fatal: EEBUS meldet sie in der GUI.
# ---------------------------------------------------------------------------
EEBUS_ON=0
CONFIG_PATH="$CONFIG_PATH" node -e 'const c=JSON.parse(require("fs").readFileSync(process.env.CONFIG_PATH,"utf8"));process.exit(c?.eebus?.enabled===true?0:1)' 2>/dev/null && EEBUS_ON=1
if [ "$EEBUS_ON" = 1 ] && [ "$(id -u)" = 0 ]; then
  HOST_BUS="${DBUS_SYSTEM_BUS_ADDRESS:-}"
  if [ -z "$HOST_BUS" ] && [ -S /run/dbus/system_bus_socket ] && [ ! -f /run/dbus/.dvhub-own ]; then
    log "EEBUS: nutze Avahi des Hosts (D-Bus /run/dbus)"
  elif [ -n "$HOST_BUS" ]; then
    log "EEBUS: nutze D-Bus des Hosts ($HOST_BUS)"
  elif command -v avahi-daemon >/dev/null 2>&1; then
    mkdir -p /run/dbus /run/avahi-daemon
    rm -f /run/dbus/dbus.pid /run/avahi-daemon/pid
    dbus-daemon --system --fork >/dev/null 2>&1 && touch /run/dbus/.dvhub-own || log "EEBUS: dbus-daemon startet nicht"
    # Nur DVhubs eigene Dienste (SHIP) veröffentlichen — keine Rechner- oder
    # Hardware-Angaben; rlimits leer, weil Container sie nicht setzen dürfen.
    cat > /run/avahi-daemon/dvhub.conf <<'AVAHI'
[server]
use-ipv4=yes
use-ipv6=no
[wide-area]
enable-wide-area=no
[publish]
publish-hinfo=no
publish-workstation=no
[reflector]
[rlimits]
AVAHI
    avahi-daemon --daemonize --no-drop-root --no-chroot -f /run/avahi-daemon/dvhub.conf 2>/dev/null \
      && log "EEBUS: eigenes Avahi im Container gestartet" \
      || log "EEBUS: avahi-daemon startet nicht — Kopplung nur ohne mDNS"
  fi
fi

# ---------------------------------------------------------------------------
# 8. Rechte ablegen
#
# Läuft der Container bereits unter einer unprivilegierten UID (docker run
# --user, viele Orchestratoren, HA-Add-on je nach Profil), ist hier nichts zu
# tun — dann muss das Volume dieser UID gehören. Als root: Besitz geraderücken
# und per su-exec wechseln, damit die Anwendung selbst nie als root läuft.
# ---------------------------------------------------------------------------
if [ "$(id -u)" = "0" ]; then
  chown -R "$RUN_USER:$RUN_USER" "$CONFIG_DIR" "$DATA_DIR" 2>/dev/null || true
  chmod 750 "$CONFIG_DIR" "$DATA_DIR" 2>/dev/null || true
  log "starte als $RUN_USER: $*"
  exec su-exec "$RUN_USER" "$@"
fi

log "starte als uid=$(id -u): $*"
exec "$@"
