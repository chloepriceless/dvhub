-- Migration 024: device_readings (Geräte-Verlauf der Smart-Plugs) als Migration.
--
-- M23 (Feld 19.11.2026): Nach dem Update stand jede Minute rot
--   device_persist_error … "Relation »device_readings« existiert nicht".
-- Die Tabelle legte bisher nur der Geräte-Dienst an (services/devices/index.js,
-- ensureSchema in start()). start() läuft beim Hochfahren oft, bevor der
-- Datenbank-Pool steht — dann fehlte die Tabelle, der Speicher-Takt lief aber.
-- Migrationen laufen vor der Freigabe des Pools (telemetry-store-pg.js
-- runPendingMigrations), auf jeder Installation (nativ, Paket, Container).
-- Spalten wie im Dienst (ts_utc schon TIMESTAMPTZ, vgl. Migration 017); auf
-- Anlagen, die die Tabelle schon haben, ändert sich nichts.
--
-- Reversal:
--   DELETE FROM schema_migrations WHERE version = 24;
--   (die Tabelle bleibt — der Geräte-Dienst legt sie ohnehin an)

BEGIN;

CREATE TABLE IF NOT EXISTS device_readings (
  id BIGSERIAL PRIMARY KEY,
  device_id TEXT NOT NULL,
  ts_utc TIMESTAMPTZ NOT NULL DEFAULT now(),
  power_w DOUBLE PRECISION,
  energy_today_wh DOUBLE PRECISION,
  online BOOLEAN NOT NULL DEFAULT true,
  meta_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_device_readings_device_ts ON device_readings (device_id, ts_utc);

INSERT INTO schema_migrations (version, description, applied_at)
VALUES (24, 'device_readings — Geräte-Verlauf als Migration (M23)', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
