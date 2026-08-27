# syntax=docker/dockerfile:1.7
#
# DVhub — Minimal-Laufzeitimage (WS6)
#
# Gemeinsame Basis für die SPiNE-EnergyLink-App (ARM64) und einen künftigen
# Home-Assistant-Add-on-Wrapper. Bewusst SCHLANK: nur die Node-Anwendung.
#
# NICHT enthalten (Absicht, siehe .planning/T-CONTAINER-STACK-KONZEPT-2026-07-01.md):
#   * Postgres/TimescaleDB — eigener Container bzw. externer Host (§2)
#   * Python-Forecast-venv und ML-Modelle — würden das Image vervielfachen;
#     der EnergyLink hat ~1 GB RAM / ~2,3 GB Disk. Forecast/ML bleiben dem
#     Voll-Stack-Image vorbehalten.
#   * EOS (Pro) — eigenes Image `dvhub-eos` aus dem DV-EOS-Fork (§6)
#   * VPN (openvpn/wireguard/strongswan) — v1 nativ-only (§9)
#
# Updates laufen image-basiert. Im Container wird NICHT per git aktualisiert;
# deshalb liegt hier auch kein .git und kein git-Binary im Image.
#
# Bauen (Multi-Arch, benötigt buildx):
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     --build-arg VCS_REF="$(git rev-parse --short HEAD)" \
#     -t ghcr.io/chloepriceless/dvhub:dev --push .

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
ARG APP_VERSION=1.0.5

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
RUN apk add --no-cache tzdata su-exec \
    && addgroup -g 10001 -S dvhub \
    && adduser -u 10001 -G dvhub -S -H -s /sbin/nologin dvhub

# DV_SERVICE_USE_SUDO=0: im Container gibt es weder systemd noch sudo.
# DV_ENABLE_SERVICE_ACTIONS bleibt bewusst UNGESETZT (Default aus) — sonst
# verlangt server.js einen apiToken und der Neustart-Pfad liefe ins Leere.
#
# DVHUB_RUNTIME=container ist das Kennzeichen für den künftigen Runtime-Guard
# (Konzept §8.3 / Roadmap 4): der Update-Button darf im Container nicht
# `git fetch/merge` aufrufen. Dieser Backend-Zweig existiert noch NICHT — die
# Variable ist gesetzt, damit er sie vorfindet, wenn er gebaut wird.
ENV NODE_ENV=production \
    TZ=Europe/Berlin \
    DV_APP_CONFIG=/etc/dvhub/config.json \
    DV_DATA_DIR=/var/lib/dvhub \
    DVHUB_VERSION=${APP_VERSION} \
    DVHUB_HTTP_PORT=8080 \
    DV_SERVICE_USE_SUDO=0 \
    DVHUB_RUNTIME=container

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
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "const p=process.env.DVHUB_HTTP_PORT||8080;fetch('http://127.0.0.1:'+p+'/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
