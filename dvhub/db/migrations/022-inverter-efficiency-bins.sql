-- Migration 022: Wechselrichter-Wirkungsgrad je Tag und feinem Lastbereich.
--
-- Christin 2026-10-01: DVhub kalibriert daraus autonom die lastabhängige
-- Wirkungsgradkurve (services/inverter-efficiency/curve.js) und gibt sie an
-- EOS. Wie Migration 021, nur mit festen, feinen Lastbereichen (bin) statt
-- Grund-/Volllast. Die Grenzen stehen in daily.js (EFFICIENCY_BIN_EDGES) und
-- sind relativ zur Nennleistung pnom_w. Jeder berechnete Tag hat ALLE Bins
-- (0-Zeilen eingeschlossen) — daran erkennt der Job, dass der Tag fertig ist.
--
--   ac_wh / dc_wh   Energie aus / in den Wechselrichter (Entladung)
--   seconds/samples Datenbasis
--   pnom_w          Nennleistung, mit der die Bins gebildet wurden
--
-- Reversal:
--   DROP TABLE IF EXISTS inverter_efficiency_bins_daily;
--   DELETE FROM schema_migrations WHERE version = 22;

BEGIN;

CREATE TABLE IF NOT EXISTS inverter_efficiency_bins_daily (
  day DATE NOT NULL,
  bin SMALLINT NOT NULL CHECK (bin >= 0 AND bin < 64),
  ac_wh DOUBLE PRECISION NOT NULL DEFAULT 0,
  dc_wh DOUBLE PRECISION NOT NULL DEFAULT 0,
  seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
  samples INTEGER NOT NULL DEFAULT 0,
  pnom_w DOUBLE PRECISION NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (day, bin)
);

INSERT INTO schema_migrations (version, description, applied_at)
VALUES (22, 'inverter_efficiency_bins_daily — Wirkungsgrad je Tag und Lastbereich (Kurven-Kalibrierung)', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
