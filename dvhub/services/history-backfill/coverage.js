// services/history-backfill/coverage.js — Abdeckung der eigenen 15-min-Werte für
// den Altbestand aus den Rohwerten nachrechnen (T14 = C, Christin 24.11.2026).
//
// Seit 1.0.10 trägt jede eigene Viertelstunde (energy_slots_15m, local_live) in
// meta_json ihre Abdeckung {coverageS, samples, maxResS}. Ältere Zeilen haben
// keine; für sie gilt nach energy-source-rule.js „VRM vor lokal“ (Regel B vom
// 05.11.2026 bleibt). Dadurch gewannen z. B. im November 2026 bis zum 05.11.
// 14:00 die VRM-Akkuwerte (AC-seitig) — der „Akku-Wirkungsgrad (DC)“ der
// Historie mischte DC und AC (93,4 % statt 97,7 %).
//
// Altbestand hat zwei Lücken in der Buchführung (Codex 14c21520), beide erst
// seit 05.11.2026 14:17 bzw. 10.11.2026 behoben:
//   - keine Kennzeichnung veralteter Proben (meta.stale): nach einem Lesefehler
//     schrieb DVhub die gehaltenen Werte mit frischem Zeitstempel weiter;
//   - resolution_seconds je Probe einzeln gerundet (5,3-s-Takt → 5 s).
// Darum rechnet der Job die Abdeckung aus den ZEITSTEMPELN (Abstand zur vorigen
// Probe derselben Reihe, ≤ 90 s zählt, länger = Lücke und nie vollständig, wie
// maxResS im Live-Pfad) und verlangt eine unabhängige Bestätigung: die eigenen
// Werte des Slots für Netzbezug, Einspeisung und PV müssen zum VRM-Import passen
// (|Δ| ≤ max(0,02 kWh, 5 %); auf Prod-Daten mit bekannter Abdeckung passen so
// ~98 % der vollständigen Slots, 06.–22.11.2026). Gehaltene Werte nach einem
// Ausfall weichen davon ab; der verbleibende Fehler ist durch die Toleranz
// begrenzt. Nur dann wird {coverageS, samples, maxResS} geschrieben und der
// eigene Wert kann gewinnen. Sonst bleibt VRM vorn (Regel B vom 05.11. bleibt):
//   coverageBackfill 'vrm-mismatch'  — passt nicht zum VRM-Import
//   coverageBackfill 'unverified'    — keine Vergleichsreihe im Slot
//
// Portionsweise und wiederaufnehmbar: je Lauf höchstens ein UTC-Tag, eine
// Anfrage (ein UPDATE). Offene Tage liest der Job einmal (und nach dem letzten
// Tag noch einmal zur Kontrolle); nach einem Neustart setzt er dort fort, wo
// noch Zeilen ohne Abdeckung und ohne Vermerk stehen. Idempotent: geschrieben
// wird nur in solche Zeilen. updated_at wird gesetzt und der Prüfwert-Speicher
// der Historie verworfen (onDayUpdated) — die vorberechnete Jahres-Historie
// rechnet die betroffenen Monate neu.

import { LOCAL_SAMPLE_MAX_GAP_SECONDS, SLOT_SECONDS } from '../../energy-source-rule.js';
import { MATERIALIZED_ENERGY_SERIES } from '../../telemetry-store-pg.js';

const DAY_MS = 86_400_000;

// Vergleich mit dem VRM-Import je Slot (Prod 06.–22.11.2026: ~98 % der
// vollständigen Slots innerhalb).
export const COVERAGE_CHECK_SERIES = Object.freeze(['grid_import_w', 'grid_export_w', 'pv_total_w']);
export const COVERAGE_AGREE_ABS_KWH = 0.02;
export const COVERAGE_AGREE_REL = 0.05;

// Nach dem letzten offenen Tag erst so spät wieder nach offenen Tagen suchen.
export const COVERAGE_RESCAN_MS = 24 * 3_600_000;

export const OPEN_DAYS_SQL = `
SELECT DISTINCT to_char(date_trunc('day', slot_start_utc AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day
FROM energy_slots_15m
WHERE source_kind = 'local_live'
  AND (nullif(meta_json::text, '')::jsonb ->> 'coverageS') IS NULL
  AND (nullif(meta_json::text, '')::jsonb ->> 'coverageBackfill') IS NULL
ORDER BY 1 DESC`;

export const META_TYPE_SQL = `
SELECT data_type FROM information_schema.columns
WHERE table_name = 'energy_slots_15m' AND column_name = 'meta_json'
ORDER BY (table_schema = current_schema()) DESC
LIMIT 1`;

/**
 * UPDATE für einen UTC-Tag [$1, $2). $3 Toleranz kWh, $4 Toleranz relativ,
 * $5 Vergleichsreihen, $6 Rohreihen. metaType 'jsonb' oder 'text' (Spalte je Installation).
 */
export function coverageUpdateSql(metaType = 'jsonb') {
  const merged = `coalesce(nullif(e.meta_json::text, ''), '{}')::jsonb
      || CASE
           WHEN x.agrees THEN jsonb_build_object('coverageS', x.cov, 'samples', x.n, 'maxResS', x.maxres, 'coverageBackfill', 'raw')
           WHEN x.checked THEN jsonb_build_object('coverageBackfill', 'vrm-mismatch')
           ELSE jsonb_build_object('coverageBackfill', 'unverified')
         END`;
  const assign = metaType === 'jsonb' ? `(${merged})` : `(${merged})::text`;
  const gap = LOCAL_SAMPLE_MAX_GAP_SECONDS;
  return `
WITH raw AS (
  SELECT series_key, ts_utc,
         coalesce(meta_json::text, '') ~ '"stale"\\s*:\\s*true' AS stale,
         extract(epoch FROM ts_utc - lag(ts_utc) OVER (PARTITION BY series_key ORDER BY ts_utc))::float8 AS dt
  FROM timeseries_samples
  WHERE scope = 'live' AND source = 'local_poll'
    AND ts_utc >= $1::timestamptz - interval '${gap + 30} seconds' AND ts_utc < $2::timestamptz
    AND series_key = ANY($6::text[])
),
cov AS (
  SELECT to_timestamp(floor(extract(epoch FROM ts_utc) / ${SLOT_SECONDS}) * ${SLOT_SECONDS}) AS slot,
         series_key,
         sum(CASE WHEN stale OR dt IS NULL OR dt <= 0 OR dt > ${gap} THEN 0 ELSE dt END)::float8 AS cov,
         count(*)::int AS n,
         coalesce(max(dt), 0)::float8 AS maxres
  FROM raw
  WHERE ts_utc >= $1::timestamptz
  GROUP BY 1, 2
),
chk AS (
  SELECT l.slot_start_utc AS slot,
         bool_and(r.value_num IS NULL
           OR abs(l.value_num - r.value_num) <= greatest($3::float8, $4::float8 * greatest(abs(l.value_num), abs(r.value_num)))) AS agrees
  FROM energy_slots_15m l
  LEFT JOIN energy_slots_15m r
    ON r.slot_start_utc = l.slot_start_utc AND r.series_key = l.series_key AND r.source_kind = 'vrm_import'
  WHERE l.source_kind = 'local_live'
    AND l.slot_start_utc >= $1::timestamptz AND l.slot_start_utc < $2::timestamptz
    AND l.series_key = ANY($5::text[])
  GROUP BY 1
),
x AS (
  SELECT e2.id, coalesce(c.cov, 0) AS cov, coalesce(c.n, 0) AS n, coalesce(c.maxres, 0) AS maxres,
         coalesce(k.agrees, false) AS agrees, (k.slot IS NOT NULL) AS checked
  FROM energy_slots_15m e2
  LEFT JOIN cov c ON c.slot = e2.slot_start_utc AND c.series_key = e2.series_key
  LEFT JOIN chk k ON k.slot = e2.slot_start_utc
  WHERE e2.source_kind = 'local_live'
    AND e2.slot_start_utc >= $1::timestamptz AND e2.slot_start_utc < $2::timestamptz
    AND (nullif(e2.meta_json::text, '')::jsonb ->> 'coverageS') IS NULL
    AND (nullif(e2.meta_json::text, '')::jsonb ->> 'coverageBackfill') IS NULL
)
UPDATE energy_slots_15m e
SET meta_json = ${assign}, updated_at = now()
FROM x
WHERE e.id = x.id`;
}

// Nur Reihen, die als Viertelstunde gespeichert werden (sonst liest der Job alle Rohreihen).
export const COVERAGE_RAW_SERIES = Object.freeze([...MATERIALIZED_ENERGY_SERIES]);
export const COVERAGE_UPDATE_PARAMS = (from, to) => [from, to, COVERAGE_AGREE_ABS_KWH, COVERAGE_AGREE_REL, COVERAGE_CHECK_SERIES, COVERAGE_RAW_SERIES];

export function createCoverageBackfill({ getDb, pushLog, onDayUpdated = null, now = () => Date.now() } = {}) {
  let running = false;
  let queue = null;          // offene Tage, neueste zuerst
  let metaType = null;
  let doneAt = null;         // letzter Kontroll-Scan ohne offene Tage
  const log = (event, data) => { if (typeof pushLog === 'function') pushLog(event, data); };

  /** Ein Lauf = höchstens ein Tag. */
  async function runOnce() {
    if (running) return { skipped: 'already running' };
    const db = getDb?.();
    if (!db || typeof db.query !== 'function') return { skipped: 'no database' };
    if (doneAt != null && now() - doneAt < COVERAGE_RESCAN_MS) return { skipped: 'done' };
    running = true;
    try {
      if (!metaType) {
        const t = await db.query(META_TYPE_SQL);
        metaType = String(t.rows?.[0]?.data_type || 'text').toLowerCase() === 'jsonb' ? 'jsonb' : 'text';
      }
      if (!queue || queue.length === 0) {
        const open = await db.query(OPEN_DAYS_SQL);
        queue = (open.rows || []).map((r) => String(r.day).slice(0, 10));
        if (queue.length === 0) {
          doneAt = now();
          log('history_coverage_backfill_done', {});
          return { done: true };
        }
        doneAt = null;
      }
      const day = queue.shift();
      const from = `${day}T00:00:00.000Z`;
      const to = new Date(Date.parse(from) + DAY_MS).toISOString();
      const res = await db.query(coverageUpdateSql(metaType), COVERAGE_UPDATE_PARAMS(from, to));
      const updated = Number(res.rowCount) || 0;
      // Prüfwert-Speicher der Historie verwerfen (sonst bis zu 6 h alte Quellwahl).
      if (updated > 0 && typeof onDayUpdated === 'function') {
        try { onDayUpdated(from); } catch { /* nur Zwischenspeicher */ }
      }
      log('history_coverage_backfill', { day, updated, remaining: queue.length });
      return { day, updated, remaining: queue.length };
    } catch (e) {
      // Beim nächsten Lauf neu einlesen (wiederaufnehmbar über die Datenbank).
      queue = null;
      log('history_coverage_backfill_error', { error: e.message });
      return { error: e.message };
    } finally {
      running = false;
    }
  }

  return { runOnce };
}
