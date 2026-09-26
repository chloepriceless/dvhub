-- Migration 021: Tagesaggregat des Wechselrichter-Wirkungsgrads (Akku-DC → AC).
--
-- Christin 2026-09-27: Die History soll zeigen, wie effizient die Anlage bei
-- Grundlast und bei Volllast wandelt. Aus den ~5-s-Live-Samples in
-- timeseries_samples summiert services/inverter-efficiency/daily.js je Tag und
-- Lastbereich die AC- und DC-Energie auf. Die History liest nur diese Zeilen —
-- ein Monat sind ~30 Zeilen je Bereich, ein Jahr ~365 — statt Millionen Rohwerte.
-- η einer Periode = Σ ac_wh / Σ dc_wh (energiegewichtet), Tage lassen sich
-- deshalb exakt zu Monaten und Jahren addieren.
--
-- Schema:
--   (day, bucket) PRIMARY KEY -- genau eine Zeile je Tag und Bereich; der Job
--                                UPSERTet, eine Neuberechnung überschreibt.
--   bucket                    -- 'base' (Grundlast) | 'full' (Volllast); die
--                                Grenzen hängen an der Nennleistung pnom_w.
--   ac_wh / dc_wh             -- Energie aus dem Wechselrichter / in den
--                                Wechselrichter über alle gültigen Samples.
--   seconds / samples         -- Datenbasis (Dauer, Anzahl) für die Anzeige
--                                „zu wenig Daten".
--   pnom_w                    -- Nennleistung, mit der die Bereiche gebildet
--                                wurden (nachvollziehbar bei Umrüstung).
--   Ein Tag ohne gültige Samples bekommt trotzdem beide Zeilen mit 0 — daran
--   erkennt der Job, dass der Tag bereits berechnet ist.
--
-- Reversal:
--   DROP TABLE IF EXISTS inverter_efficiency_daily;
--   DELETE FROM schema_migrations WHERE version = 21;

BEGIN;

CREATE TABLE IF NOT EXISTS inverter_efficiency_daily (
  day DATE NOT NULL,
  bucket TEXT NOT NULL CHECK (bucket IN ('base', 'full')),
  ac_wh DOUBLE PRECISION NOT NULL DEFAULT 0,
  dc_wh DOUBLE PRECISION NOT NULL DEFAULT 0,
  seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
  samples INTEGER NOT NULL DEFAULT 0,
  pnom_w DOUBLE PRECISION NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (day, bucket)
);

INSERT INTO schema_migrations (version, description, applied_at)
VALUES (21, 'inverter_efficiency_daily — Tagesaggregat Wechselrichter-Wirkungsgrad je Lastbereich', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
