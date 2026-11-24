-- Migration 018: Remove 45-day retention policy on timeseries_samples.
--
-- User request 2026-05-14: keep granular 5s-resolution telemetry samples for
-- as long as possible. The previous 45-day retention policy (migration 014)
-- dropped chunks older than 45 days entirely, losing the raw resolution
-- forever.
--
-- Disk-math — BERICHTIGT 23.11.2026 (die Zahlen vom 14.05. waren um den
-- Faktor ~1000 zu optimistisch, „~50 KB / Woche, 24.000:1“ stimmte nie):
--   - Prod-Messung 23.11.2026 (Radxa A7S, 48 Live-Reihen, ~553.000 Zeilen/Tag):
--     roh ~220 MB pro Tag, komprimiert ~7,5 MB pro Tag (Verhältnis ~29:1).
--   - „Für immer“ kostet damit auch komprimiert ~2,7 GB pro Jahr, nur für die
--     Messwerte. OHNE Kompression (Apache-Edition, reines Postgres) wächst die
--     Datenbank um ~110–230 MB pro Tag — eine kleine Platte ist in Wochen voll.
--   - Absicherung: services/storage-guard.js (Platz-Wache, roter Hinweis
--     „Datenbank ohne Kompression“), Konzept
--     .planning/konzept/2026-11-23-speicher-ueberwachung.md.
-- (Nur Kommentar geändert: der Runner führt Migrationen über die Versionsnummer
-- in schema_migrations, ohne Prüfsumme — angewendete Boxen laufen sie nicht neu.)
--
-- Strategy:
--   - REMOVE the 45-day retention policy. Chunks live indefinitely.
--   - KEEP the compression policy from migration 014 untouched (compress
--     chunks older than 7 days). That's the mechanism that makes
--     long retention affordable (~29:1, see the corrected numbers above).
--
-- Defense-in-depth (separate code change, not in this migration):
--   - services/forecast/forecast-store.js#runSmartRetention previously
--     deleted samples with resolution_seconds <= 15 older than 30 days under
--     disk pressure. That rule is now also disabled in code (see commit
--     log around this migration) so disk-pressure handling no longer races
--     this migration's intent. If disk ever truly fills, ops can manually
--     re-apply add_retention_policy('timeseries_samples',
--     drop_after => INTERVAL '<X> days') to re-enable culling.
--
-- Reversal:
--   SELECT add_retention_policy(
--     'timeseries_samples',
--     drop_after => INTERVAL '45 days',
--     if_not_exists => TRUE
--   );

-- Only attempt the TimescaleDB call when the extension is actually installed.
-- On stock Postgres remove_retention_policy() does not exist and a raw call
-- crashes the whole migration — even when the runner's timescaledb flag is off.
-- The guard checks the REAL extension state (more robust than a flag-skip: it
-- also covers "flag true but package missing"). No-op without the extension.
-- 21.10.2026: auch unter der Apache-Lizenz kein Aufruf — remove_retention_policy
-- gibt es nur in der Community-Fassung („not supported under the current apache
-- license“). Die Datei lief als eine Transaktion, also scheiterte 018 auf jeder
-- Apache-Box bei jedem Start samt Eintrag in schema_migrations. Unter Apache
-- kann es keine Aufbewahrungsrichtlinie geben; nach der Nachrüstung auf
-- Community ist 018 längst eingetragen (Lauf vorher ohne Fehler).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb')
     AND current_setting('timescaledb.license', true) = 'timescale' THEN
    PERFORM remove_retention_policy('timeseries_samples', if_exists => TRUE);
  END IF;
END $$;

-- Register migration (idempotent). MUST stay OUTSIDE the guard above so 018
-- always records itself even on a timescaledb-less box (else: endless re-run).
INSERT INTO schema_migrations (version, description, applied_at)
VALUES (18, 'Remove 45d retention on timeseries_samples — keep granular 5s data indefinitely (compression at 7d still active)', NOW())
ON CONFLICT (version) DO NOTHING;
