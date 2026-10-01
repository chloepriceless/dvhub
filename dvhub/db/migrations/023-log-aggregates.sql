-- Migration 023: Aggregate für die gestufte Log-Aufbewahrung.
--
-- Christin 2026-10-01: Logs 60 Tage in voller Auflösung, danach verdichtet;
-- Seltenes und Verdichtetes für immer (services/log-retention.js). Ohne Aufräumen wuchsen control_events,
-- audit_log und optimizer_run_series unbegrenzt (prod: 1,2 GB, davon 85 % im
-- Audit-Log Rauschen).
--
--   control_events_15m  Sollwert-Schreibbefehle (control_write) je 15 min und
--                       Ziel: Anzahl, Min/Max/Mittel, letzter Wert
--   audit_error_episodes Fehler (…_error, …_failed, MQTT) als Episoden:
--                       Beginn, Ende, Anzahl, erste Meldung — für Fehlersuche
--   audit_log_daily     Rausch-Ereignisse ohne Fehler (Keepalive, Status-OK,
--                       …) als Tageszähler je Ereignistyp und Schwere
-- Seltene Ereignisse und wichtige Audit-Einträge bleiben roh (bis 2 Jahre).
--
-- Reversal:
--   DROP TABLE IF EXISTS control_events_15m; DROP TABLE IF EXISTS audit_log_daily;
--   DROP TABLE IF EXISTS audit_error_episodes; DROP TABLE IF EXISTS audit_error_15m;
--   DELETE FROM schema_migrations WHERE version = 23;

BEGIN;

CREATE TABLE IF NOT EXISTS control_events_15m (
  bucket TIMESTAMPTZ NOT NULL,
  event_type TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  n INTEGER NOT NULL,
  v_min DOUBLE PRECISION,
  v_max DOUBLE PRECISION,
  v_avg DOUBLE PRECISION,
  v_last DOUBLE PRECISION,
  PRIMARY KEY (bucket, event_type, target)
);

CREATE TABLE IF NOT EXISTS audit_log_daily (
  day DATE NOT NULL,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  n INTEGER NOT NULL,
  PRIMARY KEY (day, event_type, severity)
);

-- Fehler-Episoden: gleiche Fehler (event_type) mit < 15 min Abstand bilden
-- eine Episode — Beginn, Ende, Anzahl und die erste Meldung bleiben 2 Jahre.
CREATE TABLE IF NOT EXISTS audit_error_episodes (
  event_type TEXT NOT NULL,
  first_ts TIMESTAMPTZ NOT NULL,
  last_ts TIMESTAMPTZ NOT NULL,
  severity TEXT NOT NULL DEFAULT 'error',
  n INTEGER NOT NULL,
  sample_payload JSONB,
  PRIMARY KEY (event_type, first_ts)
);

-- Fehler, die das Installateur-Portal quittiert hat: nach 24 h als 15-min-
-- Bündel, nach 7 Tagen gelöscht (dauerhaft liegen sie im Portal).
CREATE TABLE IF NOT EXISTS audit_error_15m (
  bucket TIMESTAMPTZ NOT NULL,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'error',
  n INTEGER NOT NULL,
  first_ts TIMESTAMPTZ NOT NULL,
  last_ts TIMESTAMPTZ NOT NULL,
  sample_payload JSONB,
  PRIMARY KEY (bucket, event_type)
);

INSERT INTO schema_migrations (version, description, applied_at)
VALUES (23, 'control_events_15m + audit_log_daily — gestufte Log-Aufbewahrung', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
