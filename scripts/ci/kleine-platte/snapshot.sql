-- scripts/ci/kleine-platte/snapshot.sql — Zustand der Datenbank als EINE JSON-Zeile.
-- Läuft auf TimescaleDB (Community/Apache) und auf reinem PostgreSQL: alles,
-- was es nicht gibt oder was scheitert, steht als null bzw. *_error im Ergebnis.
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on
-- Tage synthetischer Historie (psql -v days=N, Standard 45): daraus das Prüffenster der Stufen.
\if :{?days}
\else
\set days 45
\endif
SELECT set_config('kp.days', :'days', false) \gset kp_
CREATE OR REPLACE FUNCTION pg_temp.kp_snapshot() RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE
  out jsonb := '{}'::jsonb;
  r record;
  n bigint;
  t text;
  extra jsonb := '{}'::jsonb;
  j jsonb;
  jj jsonb;
  wd int := greatest(current_setting('kp.days')::int - 1 - 32, 1);
  tc text;
BEGIN
  out := out || jsonb_build_object(
    'at', now(),
    'db_bytes', pg_database_size(current_database()),
    'samples_bytes', pg_total_relation_size('timeseries_samples'),
    'timescaledb', (SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'),
    'license', current_setting('timescaledb.license', true));
  SELECT count(*) AS n, extract(epoch FROM now() - min(ts_utc)) / 86400 AS oldest_days,
         count(DISTINCT series_key) AS series
    INTO r FROM timeseries_samples WHERE scope = 'live' AND series_key NOT LIKE 'price%';
  out := out || jsonb_build_object('live_raw_rows', r.n, 'live_raw_oldest_days', round(r.oldest_days::numeric, 2), 'live_series', r.series);
  -- Geschützter Bereich: die letzten 25 Tage Rohwerte dürfen nie verschwinden (alle Profile ≥ 30 d).
  SELECT count(*) INTO n FROM timeseries_samples
   WHERE scope = 'live' AND series_key NOT LIKE 'price%' AND ts_utc > now() - interval '25 days' AND ts_utc <= now() - interval '1 hour';
  out := out || jsonb_build_object('live_recent_rows', n);
  SELECT count(*) INTO n FROM timeseries_samples WHERE series_key LIKE 'price%' AND ts_utc < now() - interval '1 day';
  out := out || jsonb_build_object('price_rows_past', n);
  SELECT count(*) INTO n FROM timeseries_samples WHERE scope <> 'live' AND series_key NOT LIKE 'price%' AND ts_utc < now() - interval '1 day';
  out := out || jsonb_build_object('history_rows_past', n);
  SELECT count(*) AS n, count(DISTINCT series_key) AS s, max(slot_start_utc) AS until INTO r FROM energy_slots_15m;
  out := out || jsonb_build_object('slots15_rows', r.n, 'slots15_series', r.s, 'slots15_until', r.until);
  -- Datenstufen (feat/speicher-stufen-1min: timeseries_samples_1m/_15m): jede Tabelle mit
  -- _1m/_1min/_15m/_minute im Namen, außer CAggs und energy_slots_15m. Zeilen + Reihen.
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
            WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
              AND c.relname ~ '^(timeseries|telemetry|samples).*(_1m|_1min|_15m|_minute)$'
              AND c.relname <> 'energy_slots_15m' LOOP
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = t AND column_name = 'series_key') THEN
        EXECUTE format('SELECT jsonb_build_object(''rows'', count(*), ''series'', count(DISTINCT series_key)) FROM %I', t) INTO j;
        -- Abdeckung des Bereichs, den die Wache entfernen darf (32 Tage bis Beginn der Historie
        -- minus 1 Tag): je Reihe Zahl der Zeitfenster; „voll“ = ≥ 90 % der erwarteten Fenster.
        SELECT c.column_name INTO tc FROM information_schema.columns c
         WHERE c.table_schema = 'public' AND c.table_name = t AND c.column_name IN ('bucket_ts', 'slot_start_utc', 'ts_utc', 'bucket')
         ORDER BY array_position(ARRAY['bucket_ts', 'slot_start_utc', 'ts_utc', 'bucket'], c.column_name::text) LIMIT 1;
        IF tc IS NOT NULL THEN
          EXECUTE format($q$SELECT jsonb_build_object('old_window_days', %s, 'old_window_series', count(*), 'old_full_series', count(*) FILTER (WHERE w >= %s))
                              FROM (SELECT series_key, count(DISTINCT %I) AS w FROM %I
                                     WHERE %I > now() - make_interval(days => %s) AND %I <= now() - interval '32 days'
                                     GROUP BY series_key) x$q$,
                         wd, CASE WHEN t ~ '15m' THEN wd * 96 * 0.9 ELSE wd * 1440 * 0.9 END, tc, t, tc, wd + 32, tc) INTO jj;
          j := j || jj;
        END IF;
        extra := extra || jsonb_build_object(t, j);
      ELSE
        EXECUTE format('SELECT count(*) FROM %I', t) INTO n;
        extra := extra || jsonb_build_object(t, jsonb_build_object('rows', n));
      END IF;
    EXCEPTION WHEN OTHERS THEN extra := extra || jsonb_build_object(t, jsonb_build_object('error', SQLERRM));
    END;
  END LOOP;
  out := out || jsonb_build_object('tier_tables', extra);
  IF (out->>'timescaledb') IS NOT NULL THEN
    BEGIN
      SELECT count(*) AS n, count(*) FILTER (WHERE is_compressed) AS c INTO r
        FROM timescaledb_information.chunks WHERE hypertable_name = 'timeseries_samples';
      out := out || jsonb_build_object('chunks', r.n, 'chunks_compressed', r.c);
      SELECT compression_enabled INTO r FROM timescaledb_information.hypertables WHERE hypertable_name = 'timeseries_samples';
      out := out || jsonb_build_object('hypertable', r IS NOT NULL, 'compression_enabled', r.compression_enabled);
      SELECT extract(epoch FROM time_interval) / 3600 AS h INTO r FROM timescaledb_information.dimensions
       WHERE hypertable_name = 'timeseries_samples' AND dimension_type = 'Time';
      out := out || jsonb_build_object('chunk_interval_h', r.h);
      SELECT jsonb_agg(jsonb_build_object('job_id', job_id, 'proc', proc_name, 'schedule', schedule_interval::text, 'config', config))
        INTO extra FROM timescaledb_information.jobs WHERE hypertable_name = 'timeseries_samples';
      out := out || jsonb_build_object('jobs', extra);
    EXCEPTION WHEN OTHERS THEN out := out || jsonb_build_object('timescale_error', SQLERRM);
    END;
    BEGIN
      SELECT before_compression_total_bytes AS b, after_compression_total_bytes AS a INTO r
        FROM hypertable_compression_stats('timeseries_samples');
      out := out || jsonb_build_object('compressed_before_bytes', r.b, 'compressed_after_bytes', r.a);
    EXCEPTION WHEN OTHERS THEN out := out || jsonb_build_object('compression_stats_error', SQLERRM);
    END;
  END IF;
  RETURN out;
END
$f$;
SELECT pg_temp.kp_snapshot();
