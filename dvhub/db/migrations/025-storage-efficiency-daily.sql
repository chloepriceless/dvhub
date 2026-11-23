-- Migration 025: Tagesaggregat Speicherweg mit Wandlung (T12, Christin 23.11.2026).
--
-- „Akku-Wirkungsgrad (DC rein und raus wie bisher) und einen Systemwirkungsgrad,
-- wo auch AC mit rein genommen wird.“ services/inverter-efficiency/storage.js
-- summiert je Tag aus den ~5-s-Live-Samples, was in den Akku ging (DC-PV direkt
-- und über den Lader mit AC-Eingang) und was er über den Wandler als AC abgab.
-- Die History-Karte „Eigenverbrauch bewertet“ liest nur diese Zeilen; Tage
-- addieren sich exakt zu Monaten und Jahren (Σ Energie, kein Mittel).
--
-- Schema (Wh, nur Proben mit |Akku| ≥ 100 W zählen als Laden/Entladen):
--   charge_dc_wh       Akku geladen (DC am Akku)
--   pv_to_batt_wh      davon DC-PV direkt (ohne Wandlung)
--   conv_to_batt_wh    davon über den Lader (DC-Seite)
--   ac_in_wh           AC-Eingang des Laders dafür
--   discharge_dc_wh    Akku entladen (DC am Akku)
--   ac_out_wh          AC-Abgabe des Wandlers aus dem Akku (anteilig neben DC-PV)
--   charge_all_wh      Akku geladen, alle Proben (für den Akku-Wirkungsgrad DC)
--   discharge_all_wh   Akku entladen, alle Proben
--   converter_loss_wh  Wandlerverlust gesamt über alle Proben (mit Leerlauf und PV-Wandlung)
--   soc_first_pct      erster / letzter Ladestand des Tages (ΔSoC ohne die
--   soc_last_pct       VRM-gemischten 15-min-Werte; Kapazität rechnet die History)
--   seconds / samples  Datenbasis
--   Ein Tag ohne Proben bekommt eine Zeile mit 0 — daran erkennt der Job,
--   dass er berechnet ist.
--
-- Reversal:
--   DROP TABLE IF EXISTS storage_efficiency_daily;
--   DELETE FROM schema_migrations WHERE version = 25;

BEGIN;

CREATE TABLE IF NOT EXISTS storage_efficiency_daily (
  day DATE PRIMARY KEY,
  charge_dc_wh DOUBLE PRECISION NOT NULL DEFAULT 0,
  pv_to_batt_wh DOUBLE PRECISION NOT NULL DEFAULT 0,
  conv_to_batt_wh DOUBLE PRECISION NOT NULL DEFAULT 0,
  ac_in_wh DOUBLE PRECISION NOT NULL DEFAULT 0,
  discharge_dc_wh DOUBLE PRECISION NOT NULL DEFAULT 0,
  ac_out_wh DOUBLE PRECISION NOT NULL DEFAULT 0,
  charge_all_wh DOUBLE PRECISION NOT NULL DEFAULT 0,
  discharge_all_wh DOUBLE PRECISION NOT NULL DEFAULT 0,
  converter_loss_wh DOUBLE PRECISION NOT NULL DEFAULT 0,
  soc_first_pct DOUBLE PRECISION,
  soc_last_pct DOUBLE PRECISION,
  seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
  samples INTEGER NOT NULL DEFAULT 0,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version, description, applied_at)
VALUES (25, 'storage_efficiency_daily — Speicherweg mit Wandlung je Tag (Systemwirkungsgrad)', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
