-- Migration 027: Datenstufen 1 min und 15 min für ALLE aufgenommenen Reihen.
--
-- Christin 23.11.2026 (Konzept Speicher-Überwachung, S3 a+c): 5 s → 1 min →
-- 15 min; 15-min-Werte für jede Reihe, für immer. Befüllt von
-- services/telemetry-tiers.js (laufend + Rückfüllung in Portionen), gelesen als
-- Rückfall, wo Rohwerte fehlen (telemetry-store-pg.js).
--
-- Nummer 027 (Koordination 23.11.): 025 = Systemwirkungsgrad (T12), 026 =
-- Speicher-Wache; zwei Dateien mit derselben Nummer würden still nur eine anwenden.
--
-- Läuft auf JEDER Box (nicht an cfg.telemetry.database.timescaledb gebunden):
-- normale Tabellen. Hypertable + Kompression (Community) richtet
-- ensureTierStorage() beim ersten Lauf ein, solange die Tabellen leer sind,
-- und heilt nach, wenn TimescaleDB später dazukommt (wie tuneTimescale).
--
-- energy_slots_15m bleibt unverändert: dort stehen kWh je Slot und Quelle
-- (local_live/vrm_import) mit eigener Schreib-Logik; Historie, Erlösrechnung,
-- Spitzenlast und Exporte lesen sie weiter genauso.
--
-- Reversal:
--   DROP TABLE IF EXISTS timeseries_samples_1m, timeseries_samples_15m,
--     telemetry_tier_state, telemetry_tier_dirty;
--   DELETE FROM schema_migrations WHERE version = 27;

BEGIN;

CREATE TABLE IF NOT EXISTS timeseries_samples_1m (
  series_key  TEXT NOT NULL,
  scope       TEXT NOT NULL,
  source      TEXT NOT NULL,
  bucket_ts   TIMESTAMPTZ NOT NULL,
  n           INTEGER NOT NULL,
  n_num       INTEGER NOT NULL DEFAULT 0,
  value_sum   DOUBLE PRECISION,
  covered_s   DOUBLE PRECISION,
  res_min     INTEGER NOT NULL,
  value_avg   DOUBLE PRECISION,
  value_min   DOUBLE PRECISION,
  value_max   DOUBLE PRECISION,
  value_first DOUBLE PRECISION,
  value_last  DOUBLE PRECISION,
  value_text  TEXT,
  unit        TEXT,
  PRIMARY KEY (series_key, scope, source, bucket_ts)
);
CREATE INDEX IF NOT EXISTS idx_timeseries_samples_1m_bucket ON timeseries_samples_1m (bucket_ts);

CREATE TABLE IF NOT EXISTS timeseries_samples_15m (
  series_key  TEXT NOT NULL,
  scope       TEXT NOT NULL,
  source      TEXT NOT NULL,
  bucket_ts   TIMESTAMPTZ NOT NULL,
  n           INTEGER NOT NULL,
  n_num       INTEGER NOT NULL DEFAULT 0,
  value_sum   DOUBLE PRECISION,
  covered_s   DOUBLE PRECISION,
  res_min     INTEGER NOT NULL,
  value_avg   DOUBLE PRECISION,
  value_min   DOUBLE PRECISION,
  value_max   DOUBLE PRECISION,
  value_first DOUBLE PRECISION,
  value_last  DOUBLE PRECISION,
  value_text  TEXT,
  unit        TEXT,
  PRIMARY KEY (series_key, scope, source, bucket_ts)
);
CREATE INDEX IF NOT EXISTS idx_timeseries_samples_15m_bucket ON timeseries_samples_15m (bucket_ts);

-- Zeiger: bis done_until (exklusiv) sind beide Stufen fertig. NULL = noch kein
-- Lauf. Die Zeile legt die Migration an, damit writeSamples sie von Anfang an
-- sperren kann (FOR SHARE gegen den Lauf mit FOR UPDATE).
CREATE TABLE IF NOT EXISTS telemetry_tier_state (
  id           TEXT PRIMARY KEY,
  done_until   TIMESTAMPTZ,
  started_from TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO telemetry_tier_state (id) VALUES ('tiers') ON CONFLICT (id) DO NOTHING;

-- Nachzügler: Viertelstunden hinter dem Zeiger, in die später noch Feinwerte
-- geschrieben wurden; der nächste Lauf verdichtet sie neu.
CREATE TABLE IF NOT EXISTS telemetry_tier_dirty (
  bucket_ts TIMESTAMPTZ PRIMARY KEY,
  marked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO schema_migrations (version, description, applied_at)
VALUES (27, 'Datenstufen 1 min + 15 min für alle Reihen (timeseries_samples_1m/_15m, Zeiger, Nachzügler)', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
