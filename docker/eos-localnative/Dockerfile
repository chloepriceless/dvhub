# syntax=docker/dockerfile:1.7
#
# DVhub-EOS im local-native-Modus — Image
# bikinibottomcapital/dvhub-eos-localnative:<EOS_NATIVE_BIN_VERSION>
# (optimizer.eosProxy.mode=local-native, 1.0.11, PLAN rust-1.1 §6.2 E2).
#
# Statt Python-EOS + Rust-Wheel (docker/eos-native) läuft hier das eigenständige
# Binär `dvhub-optimize serve` direkt als EOS-kompatible HTTP-Fassade (eos-genetic,
# bildet die EOS v0.4.0rc3-Schnittstelle nach: /v1/health, /v1/config(/*),
# /v1/measurement/*, /v1/prediction/*, POST /v1/optimize [SYNCHRON], /v1/energy-
# management/plan|solution). Kein Python-EOS, −170..−230 MB RAM.
#
# Das Binär ist statisch (musl), stripped, ~3 MB, läuft ohne weitere
# Abhängigkeiten. Python bleibt NUR für den unveränderten EOS-Wächter
# (docker/compose.yml, configs: dvhub-eos-watch) im Image — ein reiner
# stdlib-Prozess (urllib/subprocess/signal), der EOS neu startet, wenn DVhub es
# anfordert. Sein RAM-Anteil ist klein (~15–20 MiB Interpreter-RSS) gegen den
# vollen Python-EOS-Server (~205–290 MiB); der Neustart-Mechanismus bleibt damit
# byte-genau der von docker/eos-native (gleiches Skript, gleicher Signal-Weg).
#
# Bezug des Binärs: beim Bau als benannter Build-Kontext `bins` gemountet (wie
# docker/eos-native die Wheels mountet) — vorher mit
#   scripts/eos-native-wheels.sh fetch <dir> AARCH64 X86_64 --prefix EOS_NATIVE_BIN
# geholt und dort gegen eos-version.env sha256-geprüft; hier wird die sha256 je
# Architektur NOCH EINMAL hart geprüft (Bau scheitert bei Abweichung).
#
# Bauen (multi-arch, aus dem Repo-Wurzelordner):
#   docker buildx bake -f docker/eos-localnative/docker-bake.hcl dvhub-eos-localnative
# (Variablen siehe docker-bake.hcl; Pins aus eos-version.env.)

# Base: schlankes Debian-Python. Reicht für den Wächter (stdlib) und trägt das
# statische Binär; konservativ und sauber vor maximal klein (der Wächter darf
# nicht brechen). Der tz-Datenbestand steckt im Binär (chrono-tz), kein tzdata
# nötig — die Fassade rechnet Europe/Berlin korrekt.
FROM python:3.13-slim AS fetch
ARG TARGETARCH
ARG EOS_NATIVE_BIN_X86_64
ARG EOS_NATIVE_BIN_X86_64_SHA256
ARG EOS_NATIVE_BIN_AARCH64
ARG EOS_NATIVE_BIN_AARCH64_SHA256
RUN --mount=from=bins,target=/tmp/bins \
    set -eu; \
    case "$TARGETARCH" in \
      amd64) f="$EOS_NATIVE_BIN_X86_64"; s="$EOS_NATIVE_BIN_X86_64_SHA256" ;; \
      arm64) f="$EOS_NATIVE_BIN_AARCH64"; s="$EOS_NATIVE_BIN_AARCH64_SHA256" ;; \
      *) echo "kein dvhub-optimize-Binär für $TARGETARCH gepinnt" >&2; exit 1 ;; \
    esac; \
    [ -n "$f" ] && [ -n "$s" ] || { echo "Binär-Pin für $TARGETARCH fehlt (eos-version.env)" >&2; exit 1; }; \
    echo "$s  /tmp/bins/$f" | sha256sum -c -; \
    install -m 0755 "/tmp/bins/$f" /usr/local/bin/dvhub-optimize; \
    # Rauchtest: läuft das Binär ohne Python-Rückfall? (muss die eos-genetic-
    # Fassade melden, nicht scheitern).
    /usr/local/bin/dvhub-optimize version | grep -q 'eos-genetic'

# Eigene Rauchtest-Stufe, damit nur die Quittung ins Image kommt (und die Stufe
# nicht von BuildKit übersprungen wird — das Image hängt an /bin-smoke-ok).
FROM fetch AS smoke
RUN dvhub-optimize version && touch /bin-smoke-ok

FROM python:3.13-slim
COPY --from=fetch /usr/local/bin/dvhub-optimize /usr/local/bin/dvhub-optimize
COPY --from=smoke /bin-smoke-ok /usr/local/share/dvhub-eos-localnative/bin-smoke-ok
ARG EOS_NATIVE_BIN_VERSION=0.1.0
ENV EOS_BUILD_VERSION=${EOS_NATIVE_BIN_VERSION}
LABEL org.opencontainers.image.title="DVhub-EOS (local-native)" \
      org.opencontainers.image.description="Eigenständiger Rust-Optimierer dvhub-optimize serve als EOS v0.4.0rc3-Fassade (eos-genetic), ohne Python-EOS" \
      org.opencontainers.image.version="${EOS_NATIVE_BIN_VERSION}" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/chloepriceless/EOS" \
      net.dvhub.eos.engine="dvhub-optimize" \
      net.dvhub.eos.native-bin="${EOS_NATIVE_BIN_VERSION}"
VOLUME /data
EXPOSE 8503
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8503/v1/health',timeout=4).status==200 else 1)"]
# Standardlauf OHNE Compose-Wächter (Notbau / direkter `docker run`): die Fassade
# direkt. Im Stack setzt docker/compose.eos-localnative.yml das command: auf den
# Python-Wächter davor (dvhub-optimize serve als Kindprozess, 127.0.0.1).
CMD ["dvhub-optimize", "serve", "--listen", "127.0.0.1:8503", "--state-dir", "/data"]
