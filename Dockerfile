# syntax=docker/dockerfile:1.7
#
# DVhub — Minimal-Laufzeitimage (WS6)
#
# Gemeinsame Basis für die SPiNE-EnergyLink-App (ARM64) und einen künftigen
# Home-Assistant-Add-on-Wrapper. Bewusst SCHLANK: nur die Node-Anwendung.
#
# NICHT enthalten (Absicht, siehe .planning/T-CONTAINER-STACK-KONZEPT-2026-07-01.md):
#   * Postgres/TimescaleDB — eigener Container (docker/compose.yml) bzw.
#     externer Host (§2); nur der pg-Client ist für Backup/Restore enthalten
#   * Python-Forecast-venv und ML-Modelle — würden das Image vervielfachen;
#     der EnergyLink hat ~1 GB RAM / ~2,3 GB Disk. Forecast/ML bleiben dem
#     Voll-Stack-Image vorbehalten.
#   * EOS (Pro) — eigenes Image `dvhub-eos` aus dem DV-EOS-Fork (§6)
#   * VPN: OpenVPN und WireGuard laufen im DVhub-Container (NET_ADMIN +
#     /dev/net/tun); IPsec weiterhin nur nativ
#
# Updates laufen image-basiert. Im Container wird NICHT per git aktualisiert;
# deshalb liegt hier auch kein .git und kein git-Binary im Image.
#
# Bauen (Multi-Arch, benötigt buildx):
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     --build-arg VCS_REF="$(git rev-parse --short HEAD)" \
#     -t bikinibottomcapital/dvhub:dev --push .

ARG NODE_VERSION=22-alpine

# ---------------------------------------------------------------------------
# Stage 1 — Produktionsabhängigkeiten
#
# Läuft absichtlich auf der BUILD-Plattform statt unter QEMU-Emulation: die
# Produktionsabhängigkeiten sind reines JavaScript/WASM. Verifiziert gegen
# package-lock.json (1.0.5): 168 Pakete, kein binding.gyp, kein natives
# .node-Binary — brotli-wasm ist WASM und damit architekturneutral.
#
# ACHTUNG: Kommt jemals eine Abhängigkeit mit nativem Build dazu (node-gyp,
# prebuilds), ist dieser Trick FALSCH — dann `--platform=$BUILDPLATFORM`
# entfernen, damit je Zielarchitektur echt installiert wird.
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION} AS deps

WORKDIR /build
COPY dvhub/package.json dvhub/package-lock.json ./

# --omit=dev: kein eslint/playwright im Laufzeitimage.
# --ignore-scripts: keine Paket-Lifecycle-Skripte beim Installieren; keine der
# Produktionsabhängigkeiten braucht welche (siehe oben).
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

# ---------------------------------------------------------------------------
# Stage 2 — Laufzeit
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime

ARG VCS_REF=unknown
ARG APP_VERSION=1.0.6

LABEL org.opencontainers.image.title="DVhub" \
      org.opencontainers.image.description="Direktvermarktungs-Schnittstelle für Victron ESS — Minimal-Laufzeitimage" \
      org.opencontainers.image.source="https://github.com/chloepriceless/dvhub" \
      org.opencontainers.image.licenses="SEE LICENSE IN LICENSE.md" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}"

# tzdata ist auf Alpine NICHT vorinstalliert. Ohne das Paket fällt jede
# Zeitzonenrechnung auf UTC zurück — für Preisfenster, Zeitpläne und die
# 15-Minuten-Slots wäre das ein stiller Datenfehler, kein Schönheitsfehler.
# su-exec (~10 kB) lässt den Entrypoint nach dem Setup die Rechte ablegen.
# postgresql17-client: pg_dump/pg_restore/psql für DB-Backup und -Restore aus
# der Oberfläche (services/db-backup.js, Container-Modus). Version passend zum
# DB-Container (docker/compose.yml: TimescaleDB auf PostgreSQL 17) — pg_dump
# muss mindestens so neu sein wie der Server. Die Binaries liegen unter
# /usr/libexec/postgresql17, nicht im PATH (→ DVHUB_PG_BIN_DIR).
# openvpn + wireguard-tools + sudo + iproute2 (2026-10-02): das VPN zum Direktvermarkter läuft
# IM DVhub-Container — gleicher Code wie nativ (vpn-manager.js startet
# `sudo openvpn --config …`). sudo darf NUR openvpn mit DVhub-Profilen und das
# Prüfen/Beenden von openvpn, genau wie die nativen sudoers-Regeln. Der
# Container braucht dafür NET_ADMIN + /dev/net/tun (docker/compose.yml); mit
# Host-Netz entsteht tun0 wie nativ direkt auf dem Gerät.
RUN apk add --no-cache tzdata su-exec postgresql17-client openvpn wireguard-tools sudo iproute2 procps \
    && addgroup -g 10001 -S dvhub \
    && adduser -u 10001 -G dvhub -S -H -s /sbin/nologin dvhub \
    && printf '%s\n' \
      'Defaults:dvhub !requiretty' \
      'dvhub ALL=(root) NOPASSWD: /usr/sbin/openvpn --config /etc/dvhub/vpn/profiles/*' \
      'dvhub ALL=(root) NOPASSWD: /usr/bin/pkill -0 -x openvpn' \
      'dvhub ALL=(root) NOPASSWD: /usr/bin/pkill -15 -x openvpn' \
      'dvhub ALL=(root) NOPASSWD: /usr/bin/pkill -9 -x openvpn' \
      'dvhub ALL=(root) NOPASSWD: /usr/bin/wg-quick up /etc/dvhub/vpn/profiles/*' \
      'dvhub ALL=(root) NOPASSWD: /usr/bin/wg-quick down /etc/dvhub/vpn/profiles/*' \
      'dvhub ALL=(root) NOPASSWD: /usr/bin/wg show *' \
      > /etc/sudoers.d/dvhub-vpn \
    && chmod 0440 /etc/sudoers.d/dvhub-vpn

# DV_SERVICE_USE_SUDO=0: im Container gibt es weder systemd noch sudo.
# DV_ENABLE_SERVICE_ACTIONS bleibt bewusst UNGESETZT (Default aus) — sonst
# verlangt server.js einen apiToken und der Neustart-Pfad liefe ins Leere.
#
# DVHUB_RUNTIME=container: Update/Reboot/Restart/Timescale-Upgrade antworten
# mit einem Klartext-Hinweis statt git/apt/systemd aufzurufen (routes-api.js
# CONTAINER_REFUSED_ENDPOINTS); DB-Backup/-Restore laufen direkt als DB-Admin
# statt über sudo (services/db-backup.js pgRuntime).
ENV NODE_ENV=production \
    TZ=Europe/Berlin \
    DV_APP_CONFIG=/etc/dvhub/config.json \
    DV_DATA_DIR=/var/lib/dvhub \
    DVHUB_VERSION=${APP_VERSION} \
    DVHUB_HTTP_PORT=8080 \
    DV_SERVICE_USE_SUDO=0 \
    DVHUB_RUNTIME=container \
    DVHUB_PG_BIN_DIR=/usr/libexec/postgresql17

# Verzeichnislayout wie bei der nativen Installation, damit Pfade und Skripte
# (z. B. scripts/reconcile-vendor-profiles.mjs "$CONFIG_DIR" "$APP_DIR")
# unverändert funktionieren.
WORKDIR /opt/dvhub/dvhub

# --chown direkt beim Kopieren: ein nachgelagertes `chown -R` würde jede
# berührte Datei in eine zusätzliche Layer duplizieren — bei node_modules
# allein ~68 MB obendrauf.
COPY --from=deps --chown=dvhub:dvhub /build/node_modules /opt/dvhub/dvhub/node_modules
COPY --chown=dvhub:dvhub dvhub/ /opt/dvhub/dvhub/
COPY --chown=dvhub:dvhub scripts/reconcile-vendor-profiles.mjs /opt/dvhub/scripts/
# package.json verweist mit "SEE LICENSE IN ../LICENSE.md" hierauf.
COPY --chown=dvhub:dvhub LICENSE.md THIRD-PARTY-LICENSES.md /opt/dvhub/
COPY --chmod=0755 docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /etc/dvhub /var/lib/dvhub \
    && chown dvhub:dvhub /etc/dvhub /var/lib/dvhub

# Zustand lebt ausschließlich hier — beide müssen als Volume eingehängt werden,
# sonst verliert ein Image-Tausch Config, Lizenzbindung und appliance-id.
VOLUME ["/etc/dvhub", "/var/lib/dvhub"]

EXPOSE 8080

# Ohne curl/wget: Node kann das selbst. Prüft dieselbe Route, die auch die
# Fernüberwachung liest.
#
# Der Port kommt aus der CONFIG, nicht aus der Umgebung: eine mitgebrachte
# Config (z. B. von einer bestehenden Installation) bringt ihren eigenen
# httpPort mit — der ausgelieferte Default ist 80. Würde hier stur
# DVHUB_HTTP_PORT geprüft, meldete der Healthcheck „unhealthy", obwohl die
# Anwendung sauber läuft. Umgebung dient nur als Rückfallwert.
#
# Zeiten auf schwache Zielhardware ausgelegt: auf einem Raspberry Pi 4 mit
# echtem Datenbestand lief der Check waehrend der Startphase wiederholt in den
# 5-Sekunden-Timeout, obwohl die Anwendung sauber antwortete (/api/status
# danach 0,18 s). Ein Orchestrator haette den Container in dieser Phase
# grundlos neu gestartet. Der EnergyLink ist knapper bestueckt als der Pi.
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD node -e "const fs=require('fs');let p=process.env.DVHUB_HTTP_PORT||8080;try{const c=JSON.parse(fs.readFileSync(process.env.DV_APP_CONFIG||'/etc/dvhub/config.json','utf8'));if(Number.isFinite(c.httpPort))p=c.httpPort}catch{};fetch('http://127.0.0.1:'+p+'/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
