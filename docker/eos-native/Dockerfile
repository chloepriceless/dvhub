# syntax=docker/dockerfile:1.7
#
# DVhub-EOS mit Rust-Kern — Image bikinibottomcapital/dvhub-eos:<EOS_IMAGE_TAG>
# (T-0415, Christin 11.11.2026: DVhub liefert DVhub-EOS IMMER mit aktivem
# Rust-Kern aus).
#
# Zwei Stufen wie tools/dvhub-eos/build-image.sh im Fork, nur mit dem gepinnten
# Wheel statt eines Eigenbaus:
#   base    = unverändertes Root-Dockerfile des Forks am Git-Tag (kein zweites
#             Rezept hier) — benannter Kontext aus docker-bake.hcl (target:eos-base)
#   wheels  = die Wheels des Fork-Releases zu genau diesem Tag, vorher von
#             scripts/eos-native-wheels.sh geholt und gegen eos-version.env geprüft;
#             hier wird die sha256 noch einmal geprüft
#   dvhubscripts = scripts/ dieses Repos (eos-native-smoke.py)
# Ergebnis: Wheel im venv, EOS_OPTIMIZATION__GENETIC__BACKEND=native, und eine
# Bau-Stufe "smoke", die einen nativen Lauf ohne Python-Rückfall verlangt —
# scheitert sie, scheitert der Bau (nichts wird veröffentlicht).
# Bauen: docker buildx bake -f docker/eos-native/docker-bake.hcl dvhub-eos
# (Variablen siehe dort; die CI setzt sie aus docker/.env.example und
# eos-version.env).
# Notfall ohne neues Image: EOS_OPTIMIZATION__GENETIC__BACKEND=python.

FROM base AS eos
ARG TARGETARCH
ARG EOS_NATIVE_X86_64
ARG EOS_NATIVE_X86_64_SHA256
ARG EOS_NATIVE_AARCH64
ARG EOS_NATIVE_AARCH64_SHA256
RUN --mount=from=ghcr.io/astral-sh/uv:0.12.7,source=/uv,target=/tmp/uv \
    --mount=from=wheels,target=/tmp/wheels \
    set -eu; \
    case "$TARGETARCH" in \
      amd64) f="$EOS_NATIVE_X86_64"; s="$EOS_NATIVE_X86_64_SHA256" ;; \
      arm64) f="$EOS_NATIVE_AARCH64"; s="$EOS_NATIVE_AARCH64_SHA256" ;; \
      *) echo "kein Rust-Kern für $TARGETARCH gepinnt" >&2; exit 1 ;; \
    esac; \
    [ -n "$f" ] && [ -n "$s" ] || { echo "Wheel-Pin für $TARGETARCH fehlt (eos-version.env)" >&2; exit 1; }; \
    echo "$s  /tmp/wheels/$f" | sha256sum -c -; \
    /tmp/uv pip install --python /opt/venv/bin/python --no-deps --no-cache "/tmp/wheels/$f"; \
    /opt/venv/bin/python -c "import akkudoktoreos_native as n; print('akkudoktoreos_native', n.__version__)"
COPY --from=dvhubscripts eos-native-smoke.py /usr/local/share/dvhub-eos/native-smoke.py
ENV EOS_OPTIMIZATION__GENETIC__BACKEND=native

# Rauchtest im Bau: Kern zertifiziert, kurzer Lauf nativ, kein Rückfall. Eigene
# Stufe, damit nichts aus dem Lauf im Image bleibt; das Image übernimmt nur die
# Quittung (und hängt damit von dieser Stufe ab — ohne sie würde BuildKit sie
# überspringen).
FROM eos AS smoke
RUN python /usr/local/share/dvhub-eos/native-smoke.py && touch /native-smoke-ok

FROM eos
COPY --from=smoke /native-smoke-ok /usr/local/share/dvhub-eos/native-smoke-ok
