# syntax=docker/dockerfile:1.7
#
# DVhub — schlankes TimescaleDB-Image (EnergyLink-Profil, 2026-10-19)
#
# Das offizielle timescale/timescaledb:<ver>-pg17 bringt jede TimescaleDB-
# Version mit, die es für PostgreSQL 17 je gab (44 Bibliotheken ab 2.17 plus
# Update-Skripte zwischen allen davon, zusammen ~1,2 GB), damit jede beliebige
# alte Datenbank aktualisiert werden kann. Auf dem SPiNE EnergyLink (~2,3 GB
# Speicher) passt das nicht.
#
# Dieses Image ist das OFFIZIELLE, nur ohne Ballast — dieselben PostgreSQL- und
# TimescaleDB-Programme, dieselben Start- und Einrichtungsskripte
# (docker-entrypoint.sh, 000_install_timescaledb.sh, timescaledb-tune):
#   - TimescaleDB nur in der ausgelieferten Version TS_VERSION, dazu der
#     Update-Weg von den Versionen in TS_UPGRADE_FROM (die wir selbst
#     ausgeliefert haben). DVhub aktualisiert die Erweiterung nach einem
#     Image-Tausch selbst (ALTER EXTENSION).
#   - ohne LLVM-JIT (beschleunigt nur große Analyseabfragen; jit wird aus-
#     geschaltet), ohne pgvector, ohne Entwickler-Header und parallel-copy.
# Ein PostgreSQL-Major-Wechsel geht nie per Image-Tausch (pg_dump/pg_upgrade).
#
# Alles landet in EINER Schicht (FROM scratch): Löschen in einer weiteren
# Schicht über dem offiziellen Image würde nichts kleiner machen.
#
# Bauen (arm64 + amd64):
#   docker buildx build --platform linux/arm64,linux/amd64 \
#     -t bikinibottomcapital/timescaledb-slim:2.30.2-pg17 docker/timescaledb-slim

ARG TS_IMAGE=timescale/timescaledb:2.30.2-pg17

FROM ${TS_IMAGE} AS full
ARG TS_VERSION=2.30.2
# Leerzeichen-getrennt; die Bibliotheken dieser Versionen bleiben ebenfalls,
# damit eine Datenbank dieses Stands starten und aktualisiert werden kann.
ARG TS_UPGRADE_FROM="2.28.2"
RUN set -eux; \
    lib=/usr/local/lib/postgresql; ext=/usr/local/share/postgresql/extension; \
    keep_lib="timescaledb.so timescaledb-${TS_VERSION}.so timescaledb-tsl-${TS_VERSION}.so"; \
    keep_sql="timescaledb.control timescaledb--${TS_VERSION}.sql"; \
    for v in ${TS_UPGRADE_FROM}; do \
      keep_lib="$keep_lib timescaledb-$v.so timescaledb-tsl-$v.so"; \
      keep_sql="$keep_sql timescaledb--$v--${TS_VERSION}.sql"; \
    done; \
    for f in $keep_lib; do test -f "$lib/$f"; done; \
    for f in $keep_sql; do test -f "$ext/$f"; done; \
    for f in "$lib"/timescaledb*.so; do \
      case " $keep_lib " in *" ${f##*/} "*) ;; *) rm -f "$f" ;; esac; \
    done; \
    for f in "$ext"/timescaledb*; do \
      case " $keep_sql " in *" ${f##*/} "*) ;; *) rm -f "$f" ;; esac; \
    done; \
    rm -f "$lib"/vector.so "$ext"/vector* "$lib"/llvmjit.so "$lib"/llvmjit_types.bc; \
    rm -rf "$lib"/bitcode /usr/local/include /usr/lib/llvm* /usr/lib/libLLVM* \
           /usr/local/bin/timescaledb-parallel-copy; \
    # JIT gibt es nicht mehr — auch nicht versuchen (sonst Meldung je Abfrage).
    sed -i "s/^#\?jit = .*/jit = off/" /usr/local/share/postgresql/postgresql.conf.sample; \
    grep -q "^jit = off" /usr/local/share/postgresql/postgresql.conf.sample \
      || echo "jit = off" >> /usr/local/share/postgresql/postgresql.conf.sample; \
    ls "$lib" | grep timescaledb; ls "$ext" | grep timescaledb

FROM scratch
COPY --from=full / /
# Wie im offiziellen Image (docker image inspect timescale/timescaledb:2.30.2-pg17).
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    GOSU_VERSION=1.19 \
    LANG=en_US.utf8 \
    PG_MAJOR=17 \
    PGDATA=/var/lib/postgresql/data
LABEL org.opencontainers.image.title="DVhub TimescaleDB (schlank)" \
      org.opencontainers.image.description="timescale/timescaledb ohne alte Versionen, LLVM-JIT und pgvector" \
      org.opencontainers.image.source="https://github.com/chloepriceless/dvhub"
VOLUME /var/lib/postgresql/data
EXPOSE 5432
STOPSIGNAL SIGINT
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["postgres"]
