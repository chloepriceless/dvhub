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
// Dieser Job rechnet die Abdeckung genau so nach, wie der Live-Pfad sie beim
// Schreiben zählt (telemetry-store-pg.js buildMaterializedEnergySlotWrites):
//   - Rohwerte scope 'live', source 'local_poll' (nur die eigenen),
//   - jede Probe im Slot ihres Zeitstempels (floor auf 900 s),
//   - Gutschrift je Probe = localSampleCreditSeconds: veraltet 0, sonst
//     min(Auflösung, 90 s, 900 s); samples = Anzahl, maxResS = längste Probe.
// Wo die Rohwerte den Slot ganz abdecken, gewinnt danach wie gewollt der eigene
// Wert; wo sie fehlen oder schon gelöscht sind, bleibt VRM vorn (coverageS 0
// ist für die Reihenfolge dasselbe wie „keine Angabe“).
//
// Portionsweise und wiederaufnehmbar: je Lauf höchstens ein UTC-Tag, eine
// Anfrage (ein UPDATE). Offene Tage liest der Job einmal (und nach dem letzten
// Tag noch einmal zur Kontrolle); nach einem Neustart setzt er dort fort, wo
// noch Zeilen ohne Abdeckung stehen. Idempotent: geschrieben wird nur in Zeilen
// ohne coverageS, und dieselben Rohwerte ergeben dieselben Zahlen. updated_at
// wird gesetzt — damit rechnet die vorberechnete Jahres-Historie die
// betroffenen Monate neu (historySectionFingerprints).

import { LOCAL_SAMPLE_MAX_CREDIT_SECONDS, SLOT_SECONDS } from '../../energy-source-rule.js';

const DAY_MS = 86_400_000;

// Nach dem letzten offenen Tag erst so spät wieder nach offenen Tagen suchen.
export const COVERAGE_RESCAN_MS = 24 * 3_600_000;

export const OPEN_DAYS_SQL = `
SELECT DISTINCT to_char(date_trunc('day', slot_start_utc AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day
FROM energy_slots_15m
WHERE source_kind = 'local_live'
  AND (nullif(meta_json::text, '')::jsonb ->> 'coverageS') IS NULL
ORDER BY 1 DESC`;

export const META_TYPE_SQL = `
SELECT data_type FROM information_schema.columns
WHERE table_name = 'energy_slots_15m' AND column_name = 'meta_json'
ORDER BY (table_schema = current_schema()) DESC
LIMIT 1`;

/**
 * UPDATE für einen UTC-Tag [$1, $2). metaType 'jsonb' oder 'text' (Spalte je
 * Installation unterschiedlich). Gutschrift wie localSampleCreditSeconds.
 */
export function coverageUpdateSql(metaType = 'jsonb') {
  const merged = `coalesce(nullif(e.meta_json::text, ''), '{}')::jsonb
      || jsonb_build_object('coverageS', x.cov, 'samples', x.n, 'maxResS', x.maxres, 'coverageBackfill', true)`;
  const assign = metaType === 'jsonb' ? `(${merged})` : `(${merged})::text`;
  return `
WITH cov AS (
  SELECT to_timestamp(floor(extract(epoch FROM ts_utc) / ${SLOT_SECONDS}) * ${SLOT_SECONDS}) AS slot,
         series_key,
         sum(CASE
               WHEN coalesce(meta_json::text, '') ~ '"stale"\\s*:\\s*true' THEN 0
               WHEN resolution_seconds IS NULL OR resolution_seconds <= 0 THEN 0
               ELSE least(resolution_seconds, ${LOCAL_SAMPLE_MAX_CREDIT_SECONDS}, ${SLOT_SECONDS})
             END)::float8 AS cov,
         count(*)::int AS n,
         coalesce(max(resolution_seconds), 0)::float8 AS maxres
  FROM timeseries_samples
  WHERE scope = 'live' AND source = 'local_poll'
    AND ts_utc >= $1::timestamptz AND ts_utc < $2::timestamptz
  GROUP BY 1, 2
),
x AS (
  SELECT e2.id, coalesce(c.cov, 0) AS cov, coalesce(c.n, 0) AS n, coalesce(c.maxres, 0) AS maxres
  FROM energy_slots_15m e2
  LEFT JOIN cov c ON c.slot = e2.slot_start_utc AND c.series_key = e2.series_key
  WHERE e2.source_kind = 'local_live'
    AND e2.slot_start_utc >= $1::timestamptz AND e2.slot_start_utc < $2::timestamptz
    AND (nullif(e2.meta_json::text, '')::jsonb ->> 'coverageS') IS NULL
)
UPDATE energy_slots_15m e
SET meta_json = ${assign}, updated_at = now()
FROM x
WHERE e.id = x.id`;
}

export function createCoverageBackfill({ getDb, pushLog, now = () => Date.now() } = {}) {
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
      const res = await db.query(coverageUpdateSql(metaType), [from, to]);
      const updated = Number(res.rowCount) || 0;
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
