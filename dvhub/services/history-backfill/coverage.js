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
// Darum rechnet der Job die Abdeckung aus den ZEITSTEMPELN: ein Abstand zur
// vorigen Probe derselben Reihe zählt ganz, wenn er höchstens die gespeicherte
// Auflösung + 1,5 s ist (Rundung, Takt-Schwankung); länger (Neustart, Hänger)
// zählt nur die gespeicherte Auflösung — wie der Live-Pfad nach einem Neustart —
// und die Lücke steht in maxResS (über 90 s: nie vollständig).
// Dazu eine Bestätigung je Slot (Codex 31a46774), sonst bleibt VRM vorn (Regel B
// vom 05.11. bleibt):
//   1. Netzbezug, Einspeisung, PV und Hausverbrauch (der Haupt-GX) passen zum VRM-Import
//      (|Δ| ≤ max(0,02 kWh, 5 %); Prod 06.–22.11.2026: ~98 % der vollständigen
//      Slots), mindestens ein echtes Vergleichspaar, eines davon ≥ 0,05 kWh
//      (nachts zählt der Hausverbrauch) — fehlt VRM, ist nichts bestätigt;
//   2. die eigene Energiebilanz des Slots ist schlüssig: PV + Bezug − Einspeisung
//      − Last der Haupt-GX − Laden + Entladen (= Wandlerverlust) liegt in
//      [−0,02 kWh; 0,06 kWh + 15 % von Akku-Durchsatz + PV] (Prod: 99,9 % der
//      vollständigen Slots). Ein gehaltener Akkuwert sprengt die Bilanz; die
//      VRM-Akkumengen selbst taugen nicht zum Vergleich (AC-seitig, je Slot verrauscht).
// Ergebnis im Vermerk coverageBackfill: 'raw' (bestätigt, mit Abdeckung),
// 'vrm-mismatch' (verglichen, passt nicht), 'unverified' (nichts zu vergleichen).
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
export const COVERAGE_CHECK_SERIES = Object.freeze(['grid_import_w', 'grid_export_w', 'pv_total_w', 'load_power_w']);
export const COVERAGE_AGREE_ABS_KWH = 0.02;
export const COVERAGE_AGREE_REL = 0.05;
// Mindestens ein Vergleichspaar so groß — sonst sagt „passt“ nichts.
export const COVERAGE_INFORMATIVE_KWH = 0.05;
// Energiebilanz je Slot (Wandlerverlust), Spielraum relativ zu Akku-Durchsatz + PV;
// Prod 06.–22.11.2026: 99,9 % der vollständigen Slots darin.
export const COVERAGE_BALANCE_MIN_KWH = -0.02;
export const COVERAGE_BALANCE_MAX_KWH = 0.06;
export const COVERAGE_BALANCE_MAX_REL = 0.15;
// Abstand bis Auflösung + so viel zählt ganz (Rundung, Takt-Schwankung).
export const COVERAGE_SPACING_SLACK_S = 1.5;

// Nach dem letzten offenen Tag erst so spät wieder nach offenen Tagen suchen.
export const COVERAGE_RESCAN_MS = 24 * 3_600_000;
// Kleine Boards schonen: nach einem Tag mindestens das Zehnfache seiner Laufzeit
// Pause (A7S: ein Tag 12–30 s → höchstens ~10 % Datenbank-Last).
export const COVERAGE_PAUSE_FACTOR = 10;

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
 * UPDATE für einen UTC-Tag [$1, $2). $3/$4 Toleranz kWh/relativ, $5 Vergleichsreihen,
 * $6 Rohreihen, $7 Mindestgröße eines Vergleichs, $8–$10 Bilanzgrenzen.
 * metaType 'jsonb' oder 'text' (Spalte je Installation).
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
         resolution_seconds::float8 AS res,
         extract(epoch FROM ts_utc - lag(ts_utc) OVER (PARTITION BY series_key ORDER BY ts_utc))::float8 AS dt
  FROM timeseries_samples
  WHERE scope = 'live' AND source = 'local_poll'
    AND ts_utc >= $1::timestamptz - interval '${gap + 30} seconds' AND ts_utc < $2::timestamptz
    AND series_key = ANY($6::text[])
),
cov AS (
  SELECT to_timestamp(floor(extract(epoch FROM ts_utc) / ${SLOT_SECONDS}) * ${SLOT_SECONDS}) AS slot,
         series_key,
         sum(CASE
               WHEN stale OR dt IS NULL OR dt <= 0 THEN 0
               WHEN dt <= coalesce(res, 0) + ${COVERAGE_SPACING_SLACK_S} AND dt <= ${gap} THEN dt
               ELSE least(greatest(coalesce(res, 0), 0), dt, ${gap})
             END)::float8 AS cov,
         count(*)::int AS n,
         coalesce(max(dt), 0)::float8 AS maxres
  FROM raw
  WHERE ts_utc >= $1::timestamptz
  GROUP BY 1, 2
),
lraw AS (
  -- Gemessene Last der Haupt-GX (load_measured_w, seit 25.10.2026 nur mit zweiter
  -- GX geschrieben): polling.js kappt Last − Akku 2 bei 0, das lässt sich aus den
  -- Viertelstunden nicht zurückrechnen (Codex 2cd5234d). Je Probe die gemessene,
  -- sonst Last + Akku-2-Laden − Akku-2-Entladen (wie EFFICIENCY_SAMPLES_CTE).
  SELECT ts_utc,
         max(value_num) FILTER (WHERE series_key = 'load_measured_w') AS lm,
         max(value_num) FILTER (WHERE series_key = 'load_power_w') AS lp,
         coalesce(max(value_num) FILTER (WHERE series_key = 'second_battery_charge_w'), 0) AS c2,
         coalesce(max(value_num) FILTER (WHERE series_key = 'second_battery_discharge_w'), 0) AS d2,
         max(resolution_seconds) FILTER (WHERE series_key IN ('load_measured_w', 'load_power_w')) AS res
  FROM timeseries_samples
  WHERE scope = 'live' AND source = 'local_poll'
    AND ts_utc >= $1::timestamptz AND ts_utc < $2::timestamptz
    AND series_key IN ('load_measured_w', 'load_power_w', 'second_battery_charge_w', 'second_battery_discharge_w')
  GROUP BY ts_utc
),
lmain AS (
  SELECT to_timestamp(floor(extract(epoch FROM ts_utc) / ${SLOT_SECONDS}) * ${SLOT_SECONDS}) AS slot,
         sum(coalesce(lm, lp + c2 - d2) * least(res, ${SLOT_SECONDS})) / 3600000.0 AS kwh
  FROM lraw
  WHERE res > 0 AND coalesce(lm, lp) IS NOT NULL
  GROUP BY 1
  HAVING count(lm) > 0
),
bal AS (
  SELECT slot_start_utc AS slot,
         coalesce(max(value_num) FILTER (WHERE series_key = 'pv_total_w'), 0) AS pv,
         coalesce(max(value_num) FILTER (WHERE series_key = 'grid_import_w'), 0) AS gi,
         coalesce(max(value_num) FILTER (WHERE series_key = 'grid_export_w'), 0) AS ge,
         coalesce(max(value_num) FILTER (WHERE series_key = 'load_power_w'), 0) AS ld,
         coalesce(max(value_num) FILTER (WHERE series_key = 'battery_charge_w'), 0) AS ch,
         coalesce(max(value_num) FILTER (WHERE series_key = 'battery_discharge_w'), 0) AS dis,
         coalesce(max(value_num) FILTER (WHERE series_key = 'second_battery_charge_w'), 0) AS ch2,
         coalesce(max(value_num) FILTER (WHERE series_key = 'second_battery_discharge_w'), 0) AS dis2
  FROM energy_slots_15m
  WHERE source_kind = 'local_live'
    AND slot_start_utc >= $1::timestamptz AND slot_start_utc < $2::timestamptz
  GROUP BY 1
),
bal2 AS (
  -- Last der Haupt-GX: aus load_measured_w, sonst aus dem Slot zurückgerechnet.
  SELECT b.*, coalesce(m.kwh, b.ld + b.ch2 - b.dis2) AS ldm
  FROM bal b LEFT JOIN lmain m ON m.slot = b.slot
),
pairs AS (
  -- Hausverbrauch: polling.js zieht Akku 2 (zweite GX) von der Last ab, der VRM-Import
  -- der Haupt-GX nicht — verglichen wird die gemessene Last der Haupt-GX
  -- (wie EFFICIENCY_SAMPLES_CTE: Last + Akku-2-Laden − Akku-2-Entladen).
  SELECT l.slot_start_utc AS slot,
         count(*)::int AS n,
         bool_and(abs(lv.v - r.value_num) <= greatest($3::float8, $4::float8 * greatest(abs(lv.v), abs(r.value_num)))) AS within,
         max(greatest(abs(lv.v), abs(r.value_num))) AS biggest
  FROM energy_slots_15m l
  JOIN energy_slots_15m r
    ON r.slot_start_utc = l.slot_start_utc AND r.series_key = l.series_key AND r.source_kind = 'vrm_import'
  JOIN bal2 b ON b.slot = l.slot_start_utc
  CROSS JOIN LATERAL (SELECT CASE WHEN l.series_key = 'load_power_w' THEN b.ldm ELSE l.value_num END AS v) lv
  WHERE l.source_kind = 'local_live'
    AND l.slot_start_utc >= $1::timestamptz AND l.slot_start_utc < $2::timestamptz
    AND l.series_key = ANY($5::text[])
    AND l.value_num IS NOT NULL AND r.value_num IS NOT NULL
  GROUP BY 1
),
chk AS (
  -- Bilanz (Wandlerverlust der Haupt-GX); Spielraum wächst mit Akku-Durchsatz und PV
  -- (DC-PV wird gewandelt) — Codex b7eefc4a; Prod: 99,9 % der vollständigen Slots.
  -- Mit der Last der Haupt-GX (sie enthält Akku 2 schon, dessen AC-Seite).
  SELECT p.slot,
         p.within AND p.biggest >= $7::float8
           AND (b.pv + b.gi - b.ge - b.ldm - b.ch + b.dis) >= $8::float8
           AND (b.pv + b.gi - b.ge - b.ldm - b.ch + b.dis)
               <= $9::float8 + $10::float8 * (b.ch + b.dis + b.pv) AS agrees
  FROM pairs p JOIN bal2 b ON b.slot = p.slot
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
export const COVERAGE_UPDATE_PARAMS = (from, to) => [
  from, to, COVERAGE_AGREE_ABS_KWH, COVERAGE_AGREE_REL, COVERAGE_CHECK_SERIES, COVERAGE_RAW_SERIES,
  COVERAGE_INFORMATIVE_KWH, COVERAGE_BALANCE_MIN_KWH, COVERAGE_BALANCE_MAX_KWH, COVERAGE_BALANCE_MAX_REL
];

export function createCoverageBackfill({ getDb, pushLog, onDayUpdated = null, now = () => Date.now() } = {}) {
  let running = false;
  let queue = null;          // offene Tage, neueste zuerst
  let metaType = null;
  let doneAt = null;         // letzter Kontroll-Scan ohne offene Tage
  let passDone = false;      // ein ganzer Durchgang über die offenen Tage ist gelaufen (Platz-Wache wartet darauf)
  let pauseUntil = 0;        // frühester nächster Tag (Laufzeit × COVERAGE_PAUSE_FACTOR)
  const log = (event, data) => { if (typeof pushLog === 'function') pushLog(event, data); };

  /** Ein Lauf = höchstens ein Tag. */
  async function runOnce() {
    if (running) return { skipped: 'already running' };
    const db = getDb?.();
    if (!db || typeof db.query !== 'function') return { skipped: 'no database' };
    if (doneAt != null && now() - doneAt < COVERAGE_RESCAN_MS) return { skipped: 'done' };
    if (now() < pauseUntil) return { skipped: 'pause' };
    running = true;
    const startedAt = now();
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
      if (queue.length === 0) passDone = true;
      pauseUntil = now() + (now() - startedAt) * COVERAGE_PAUSE_FACTOR;
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

  // Fertig für die Platz-Wache: nichts mehr offen, oder ein ganzer Durchgang gelaufen (Tage, die offen bleiben —
  // z. B. ohne passenden VRM-Vergleich —, sperren die Aufbewahrung nicht für immer).
  return { runOnce, isDone: () => doneAt != null || passDone };
}
