-- 001-schemas.sql
-- Create TimescaleDB extension and schema namespaces.

CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE SCHEMA IF NOT EXISTS shared;
CREATE SCHEMA IF NOT EXISTS dv;
CREATE SCHEMA IF NOT EXISTS opt;
CREATE SCHEMA IF NOT EXISTS exec;
