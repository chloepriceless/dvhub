# syntax=docker/dockerfile:1.7
#
# DVhub — schlankes EOS-Image (EnergyLink-Profil, 2026-10-19)
#
# Grundlage ist unser dvhub-eos:<EOS_TAG> — das unveränderte Akkudoktor-EOS,
# gebaut aus dessen eigenem Dockerfile (Inhalt wie akkudoktor/eos). Hier fliegt
# nur raus, was DVhub nicht braucht:
#   - EOSdash (EOS' eigene Weboberfläche: bokeh, python-fasthtml, monsterui und
#     was nur an ihnen hängt). EOS startet EOSdash als eigenen Prozess und
#     importiert es nicht; abgeschaltet ist es ohnehin
#     (EOS_SERVER__STARTUP_EOSDASH=false, unten fest gesetzt).
#   - matplotlib (nur für EOS' Diagramm-Ausgabe genetic*visualize.py, die DVhub
#     nicht aufruft) samt fonttools, pillow, kiwisolver, …
#   - die Testordner der Bibliotheken (pandas/tests, scipy/**/tests, …).
# EOS selbst bleibt unverändert; DVhub zeigt den Plan selbst an.
#
# Alles landet in EINER Schicht (FROM scratch) — Löschen in einer weiteren
# Schicht würde das Image nicht kleiner machen.
#
# Bauen:
#   docker buildx build --platform linux/arm64,linux/amd64 \
#     --build-arg EOS_TAG=v0.4.0rc3 \
#     -t bikinibottomcapital/dvhub-eos-slim:v0.4.0rc3 docker/eos-slim

ARG EOS_IMAGE=docker.io/bikinibottomcapital/dvhub-eos
ARG EOS_TAG=v0.4.0rc3

FROM ${EOS_IMAGE}:${EOS_TAG} AS full
# Pakete samt allem, was NUR von ihnen gebraucht wird (siehe drop-packages.py).
ARG DROP_PACKAGES="bokeh matplotlib python-fasthtml monsterui"
COPY drop-packages.py /tmp/drop-packages.py
RUN set -eux; \
    /opt/venv/bin/python -I /tmp/drop-packages.py ${DROP_PACKAGES}; \
    rm /tmp/drop-packages.py; \
    site=$(/opt/venv/bin/python -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])'); \
    find "$site" -type d -name tests -prune -exec rm -rf {} +; \
    find "$site" -type d -name __pycache__ -path '*/tests/*' -prune -exec rm -rf {} + ; \
    rm -rf /usr/local/lib/python3*/test /usr/local/lib/python3*/idlelib /usr/local/lib/python3*/tkinter /usr/local/lib/python3*/turtledemo; \
    # Rechnet EOS noch? Kern-Module müssen sich laden lassen.
    /opt/venv/bin/python -c 'import akkudoktoreos.server.eos, akkudoktoreos.optimization.genetic.genetic, akkudoktoreos.prediction.prediction, akkudoktoreos.config.config; print("EOS-Module laden")'

FROM scratch
COPY --from=full / /
# Wie im Ausgangsimage (docker image inspect dvhub-eos:v0.4.0rc3).
ENV PATH=/opt/venv/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin \
    PYTHON_VERSION=3.13.15 \
    EOS_DIR=/opt/eos \
    EOS_DATA_DIR=/data \
    EOS_CACHE_DIR=/data/cache \
    EOS_HEALTHCHECK_PORT_FILE=/data/cache/eos-healthcheck-port \
    EOS_OUTPUT_DIR=/data/output \
    EOS_CONFIG_DIR=/data/config \
    MPLCONFIGDIR=/data/mplconfigdir \
    EOS_SERVER__STARTUP_EOSDASH=false \
    OPENBLAS_NUM_THREADS=1 \
    OMP_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    LANG=C.UTF-8 \
    VENV_PATH=/opt/venv
ARG EOS_TAG=v0.4.0rc3
ENV EOS_BUILD_VERSION=${EOS_TAG}
LABEL org.opencontainers.image.title="DVhub EOS (schlank)" \
      org.opencontainers.image.description="Akkudoktor-EOS ohne EOSdash, matplotlib und Testordner" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/Akkudoktor-EOS/EOS"
WORKDIR /opt/eos
VOLUME /data
EXPOSE 8503
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["python", "-m", "akkudoktoreos.server.container_healthcheck"]
CMD ["python", "-m", "akkudoktoreos.server.eos", "--host", "0.0.0.0", "--run_as_user", "eos"]
