# TimescaleDB als Apache-Fassung (keine Kompression, keine CAggs) — wie eine
# native Debian-Box mit dem Paket postgresql-<ver>-timescaledb. Die Lizenz steht
# in der Vorlage, aus der initdb postgresql.conf anlegt; damit läuft schon die
# Ersteinrichtung (CREATE EXTENSION) unter Apache.
ARG BASE=timescale/timescaledb:2.30.2-pg17
FROM ${BASE}
RUN echo "timescaledb.license = 'apache'" >> /usr/local/share/postgresql/postgresql.conf.sample
