-- scripts/ci/kleine-platte/synth-data.sql — synthetische Telemetrie für den
-- E2E-Test „kleine Platte“. Aufruf (psql-Variablen):
--   psql -v days=45 -v step=30 -v worker=0 -v workers=3 -f synth-data.sql
-- Mehrere Sitzungen parallel (worker 0..workers-1) teilen sich die Live-Tage
-- (Tag d gehört worker d % workers); Preise, Altdaten und 15-min nur worker 0.
--
-- Erzeugt, rückwärts ab jetzt:
--   * 43 Live-Reihen (scope live, source local_poll, quality raw,
--     resolution_seconds 5 — wie buildLiveTelemetrySamples), davon eine
--     Textreihe; Zeitabstand :step Sekunden (5 = Prod-Dichte ~220 MB/Tag,
--     30 = 1/6 davon, Standard im Test wegen der Laufzeit)
--   * Preise price_ct_kwh/price_eur_mwh in 15 min: Vergangenheit als
--     scope history/price_backfill, die letzten 2 Tage + morgen als
--     scope forecast/price_api (wie buildPriceTelemetrySamples)
--   * importierte Altdaten (scope history, source vrm_import) für die ersten
--     10 Tage, 15 min, 3 Reihen
--   * energy_slots_15m für 8 Reihen über den ganzen Zeitraum (source_kind
--     local_live) — die Wache entfernt Rohwerte nur, wo 15-min-Werte da sind
-- Jeder Tag ist eine eigene Anweisung (\gexec): kein Riesen-WAL in einer
-- Transaktion, Checkpoints dürfen dazwischen laufen.
\set ON_ERROR_STOP on

CREATE TEMP TABLE kp_series(k text, is_text boolean, u text);
INSERT INTO kp_series VALUES
 ('grid_l1_w',false,'W'),('grid_l2_w',false,'W'),('grid_l3_w',false,'W'),('grid_total_w',false,'W'),
 ('grid_import_w',false,'W'),('grid_export_w',false,'W'),('battery_soc_pct',false,'%'),('battery_power_w',false,'W'),
 ('battery_charge_w',false,'W'),('battery_discharge_w',false,'W'),('pv_dc_w',false,'W'),('pv_ac_l1_w',false,'W'),
 ('pv_ac_l2_w',false,'W'),('pv_ac_l3_w',false,'W'),('pv_total_w',false,'W'),('load_power_w',false,'W'),
 ('load_measured_w',false,'W'),('load_power_w_ex_managed',false,'W'),('self_consumption_w',false,'W'),
 ('solar_direct_use_w',false,'W'),('solar_to_battery_w',false,'W'),('solar_to_grid_w',false,'W'),
 ('grid_direct_use_w',false,'W'),('grid_to_battery_w',false,'W'),('battery_direct_use_w',false,'W'),
 ('battery_to_grid_w',false,'W'),('second_battery_charge_w',false,'W'),('second_battery_discharge_w',false,'W'),
 ('second_solar_to_battery_w',false,'W'),('second_grid_to_battery_w',false,'W'),('second_battery_to_grid_w',false,'W'),
 ('second_battery_direct_use_w',false,'W'),('second_battery_soc_pct',false,'%'),('battery_to_second_battery_w',false,'W'),
 ('second_battery_to_battery_w',false,'W'),('grid_setpoint_w',false,'W'),('min_soc_pct',false,'%'),
 ('battery_grid_share_wh',false,'Wh'),('battery_grid_share_pct',false,'%'),('battery_grid_share_to_home_w',false,'W'),
 ('battery_grid_share_to_grid_w',false,'W'),('temperature_c',false,'°C'),('victron_state',true,NULL);

-- Live-Rohwerte, ein Tag je Anweisung (Tag 0 = jüngster, endet jetzt).
SELECT format($q$
  INSERT INTO timeseries_samples (series_key, scope, source, quality, ts_utc, resolution_seconds, value_num, value_text, unit)
  SELECT s.k, 'live', 'local_poll', 'raw', t, 5,
         CASE WHEN s.is_text THEN NULL ELSE round((1000 * sin(extract(epoch FROM t) / 3600 + length(s.k)))::numeric, 1)::float8 END,
         CASE WHEN s.is_text THEN (ARRAY['Bulk','Absorption','Float','Inverting'])[1 + (extract(epoch FROM t)::bigint / 900) %% 4] END,
         s.u
    FROM generate_series(date_trunc('minute', now()) - interval '%s day' - interval '1 day' + interval '%s second',
                         date_trunc('minute', now()) - interval '%s day', interval '%s second') t
   CROSS JOIN kp_series s
  ON CONFLICT DO NOTHING$q$, d, :step, d, :step)
FROM generate_series(:days - 1, 0, -1) d WHERE d % :workers = :worker
\gexec

SELECT (:worker = 0) AS kp_main \gset
\if :kp_main

-- Preise (15 min): Vergangenheit = Historie, letzte 2 Tage + morgen = Prognose.
INSERT INTO timeseries_samples (series_key, scope, source, quality, ts_utc, resolution_seconds, value_num, unit)
SELECT k, CASE WHEN t < now() - interval '2 day' THEN 'history' ELSE 'forecast' END,
          CASE WHEN t < now() - interval '2 day' THEN 'price_backfill' ELSE 'price_api' END,
          CASE WHEN t < now() - interval '2 day' THEN 'backfilled' ELSE 'raw' END,
       t, 900, CASE k WHEN 'price_ct_kwh' THEN 8 + 4 * sin(extract(epoch FROM t) / 43200) ELSE 80 + 40 * sin(extract(epoch FROM t) / 43200) END,
       CASE k WHEN 'price_ct_kwh' THEN 'ct/kWh' ELSE 'EUR/MWh' END
  FROM generate_series(date_trunc('hour', now()) - make_interval(days => :days), date_trunc('hour', now()) + interval '1 day', interval '15 minute') t
 CROSS JOIN (VALUES ('price_ct_kwh'), ('price_eur_mwh')) p(k)
ON CONFLICT DO NOTHING;

-- Importierte Altdaten (VRM, 15 min) für die ältesten 10 Tage.
INSERT INTO timeseries_samples (series_key, scope, source, quality, ts_utc, resolution_seconds, value_num, unit)
SELECT k, 'history', 'vrm_import', 'backfilled', t, 900, 500 + 400 * sin(extract(epoch FROM t) / 3600), 'W'
  FROM generate_series(date_trunc('hour', now()) - make_interval(days => :days), date_trunc('hour', now()) - make_interval(days => :days - 10), interval '15 minute') t
 CROSS JOIN (VALUES ('pv_total_w'), ('grid_import_w'), ('load_power_w')) v(k)
ON CONFLICT DO NOTHING;

-- 15-min-Werte über den ganzen Zeitraum (bis zum letzten vollen Slot).
INSERT INTO energy_slots_15m (slot_start_utc, series_key, source_kind, quality, value_num, unit)
SELECT t, k, 'local_live', 'raw', 100 + 50 * sin(extract(epoch FROM t) / 3600), u
  FROM generate_series(date_trunc('hour', now()) - make_interval(days => :days), date_trunc('hour', now()) - interval '15 minute', interval '15 minute') t
 CROSS JOIN (VALUES ('grid_import_kwh','kWh'), ('grid_export_kwh','kWh'), ('pv_kwh','kWh'), ('load_kwh','kWh'),
                    ('battery_charge_kwh','kWh'), ('battery_discharge_kwh','kWh'), ('price_ct_kwh','ct/kWh'), ('battery_soc_pct','%')) v(k, u)
ON CONFLICT DO NOTHING;
\endif
