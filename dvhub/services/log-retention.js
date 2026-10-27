// services/log-retention.js — gestufte Aufbewahrung der Log-Tabellen.
//
// Christin 2026-10-01. Vorher wuchsen control_events, audit_log und
// optimizer_run_series unbegrenzt (prod nach 7 Monaten 1,2 GB — mehr als alle
// 5-s-Messwerte, davon 85 % Rauschen im Audit-Log).
//
//   Seltenes bleibt FÜR IMMER roh: Abregelung, ctrl_on/off, Schreibfehler,
//   Negativpreis-Schutz (control_events ohne control_write) und alle wichtigen
//   Audit-Einträge (Einstellungen, Lizenz, Restore, Rechtsfreigaben …).
//   control_write   (Sollwert alle paar Sekunden, 99 %) → nach 60 Tagen
//                   15-min-Werte in control_events_15m (für immer).
//   Rauschen        (Keepalive, Status-OK, …) → nach 60 Tagen Tageszähler in
//                   audit_log_daily (für immer).
//   Fehler          (…_error, …_failed, MQTT):
//     mit Installateur-Portal — sobald das Portal sie quittiert hat (ihre id ≤
//       Quittungs-Cursor): 24 h voll, dann 7 Tage 15-min-Bündel
//       (audit_error_15m: Anzahl, erste/letzte Zeit, erste Meldung), dann weg.
//       Dauerhaft liegen sie im Portal pro Anlage. Nicht Quittiertes (Portal
//       weg) fällt unter die Regel ohne Portal — es geht nichts verloren.
//     ohne Portal — 60 Tage voll, dann Episoden in audit_error_episodes
//       (Beginn, Ende, Anzahl, erste Meldung; < 15 min Abstand = eine Episode),
//       für immer.
//   optimizer_run_series  nach 14 Tagen bleibt je Tag die Vorhersage, mit der
//                   der Tag geplant war: der Day-Ahead-Plan vom Vortag (erster
//                   Lauf ≥ 30 min nach Eingang der Day-Ahead-Preise), nur mit
//                   den Slots dieses Tages; nach 2 Jahren weg.
//   optimizer_runs  (25.10.2026) nach 14 Tagen gehen Läufe ohne Reihen; der
//                   jüngste Lauf je Optimierer bleibt immer.
//
// Christin 2026-10-18: Einzelwerte bei Kunden 14 statt 60 Tage (control_write
// allein ~9 MB/Tag), Fehler weiter 60 Tage voll. Auf unseren eigenen Geräten
// telemetry.logRetention.mode = 'full': nichts verdichten oder löschen.
//
// Tag für Tag (verdichten, dann löschen), idempotent (ON CONFLICT DO NOTHING
// bzw. Verdichten+Löschen in einer Transaktion). Je Lauf höchstens
// TIME_BUDGET_MS — die erste Runde einer alten Box verteilt sich auf Nächte.

export const LOG_DETAIL_DAYS = 14;
export const LOG_ERROR_DETAIL_DAYS = 60;   // Fehler → Episoden erst nach 60 Tagen
export const LOG_AGGREGATE_DAYS = 730;      // nur optimizer_run_series
export const PORTAL_ERROR_RAW_HOURS = 24;
export const PORTAL_ERROR_BUCKET_DAYS = 7;
const TIME_BUDGET_MS = 5 * 60_000;

// Fehler → nach 60 Tagen Episoden.
export const AUDIT_ERROR_SQL = `(
  event_type LIKE '%\\_error' OR event_type LIKE '%\\_failed' OR event_type LIKE '[MQTT]%'
)`;
// Rauschen ohne Fehler → nach 60 Tagen nur noch Tageszähler.
export const AUDIT_NOISE_SQL = `(
  (event_type IN ('control_write', 'control_keepalive', 'control_discharge_floor',
                  'eos_forecast_bridge', 'eos_config_sync', 'eos_new_plan_detected',
                  'eos_grid_hold', 'optimizer_run')
   OR event_type LIKE '%\\_ok')
  AND NOT ${AUDIT_ERROR_SQL}
)`;
export const ERROR_EPISODE_GAP = '15 minutes';

const sql = {
  oldestControlWriteDay: `SELECT (min(ts_utc) AT TIME ZONE $1)::date::text AS day
    FROM control_events WHERE event_type = 'control_write' AND ts_utc < $2`,
  aggregateControlDay: `INSERT INTO control_events_15m (bucket, event_type, target, n, v_min, v_max, v_avg, v_last)
    SELECT date_bin('15 minutes', ts_utc, TIMESTAMPTZ '2000-01-01 00:00:00+00'), event_type, coalesce(target, ''),
           count(*), min(value_num), max(value_num), avg(value_num),
           (array_agg(value_num ORDER BY ts_utc DESC, id DESC))[1]
      FROM control_events
     WHERE event_type = 'control_write'
       AND ts_utc >= ($1::date::timestamp AT TIME ZONE $2) AND ts_utc < (($1::date + 1)::timestamp AT TIME ZONE $2)
     GROUP BY 1, 2, 3
    ON CONFLICT DO NOTHING`,
  deleteControlDay: `DELETE FROM control_events
     WHERE event_type = 'control_write'
       AND ts_utc >= ($1::date::timestamp AT TIME ZONE $2) AND ts_utc < (($1::date + 1)::timestamp AT TIME ZONE $2)`,

  oldestAuditErrorDay: `SELECT (min(ts_utc) AT TIME ZONE $1)::date::text AS day
    FROM audit_log WHERE ${AUDIT_ERROR_SQL} AND ts_utc < $2`,
  // Lücken-und-Inseln: neue Episode, wenn der vorige gleiche Fehler > 15 min her ist.
  aggregateErrorDay: `WITH e AS (
      SELECT left(event_type, 200) AS et, coalesce(severity, 'error') AS sev, ts_utc, payload,
             lag(ts_utc) OVER (PARTITION BY event_type ORDER BY ts_utc, id) AS prev
        FROM audit_log
       WHERE ${AUDIT_ERROR_SQL}
         AND ts_utc >= ($1::date::timestamp AT TIME ZONE $2) AND ts_utc < (($1::date + 1)::timestamp AT TIME ZONE $2)
    ), g AS (
      SELECT *, sum(CASE WHEN prev IS NULL OR ts_utc - prev > interval '${ERROR_EPISODE_GAP}' THEN 1 ELSE 0 END)
                OVER (PARTITION BY et ORDER BY ts_utc) AS grp
        FROM e
    )
    INSERT INTO audit_error_episodes (event_type, first_ts, last_ts, severity, n, sample_payload)
    SELECT et, min(ts_utc), max(ts_utc), max(sev), count(*), (array_agg(payload ORDER BY ts_utc))[1]
      FROM g GROUP BY et, grp
    ON CONFLICT DO NOTHING`,
  deleteErrorDay: `DELETE FROM audit_log
     WHERE ${AUDIT_ERROR_SQL}
       AND ts_utc >= ($1::date::timestamp AT TIME ZONE $2) AND ts_utc < (($1::date + 1)::timestamp AT TIME ZONE $2)`,

  oldestAuditNoiseDay: `SELECT (min(ts_utc) AT TIME ZONE $1)::date::text AS day
    FROM audit_log WHERE ${AUDIT_NOISE_SQL} AND ts_utc < $2`,
  aggregateAuditDay: `INSERT INTO audit_log_daily (day, event_type, severity, n)
    SELECT $1::date, left(event_type, 200), coalesce(severity, 'info'), count(*)
      FROM audit_log
     WHERE ${AUDIT_NOISE_SQL}
       AND ts_utc >= ($1::date::timestamp AT TIME ZONE $2) AND ts_utc < (($1::date + 1)::timestamp AT TIME ZONE $2)
     GROUP BY 2, 3
    ON CONFLICT DO NOTHING`,
  deleteAuditDay: `DELETE FROM audit_log
     WHERE ${AUDIT_NOISE_SQL}
       AND ts_utc >= ($1::date::timestamp AT TIME ZONE $2) AND ts_utc < (($1::date + 1)::timestamp AT TIME ZONE $2)`,


  // Portal hat quittiert: älter als 24 h → 15-min-Bündel (Transaktion mit dem Löschen).
  bucketAckedErrors: `INSERT INTO audit_error_15m (bucket, event_type, severity, n, first_ts, last_ts, sample_payload)
    SELECT date_bin('15 minutes', ts_utc, TIMESTAMPTZ '2000-01-01 00:00:00+00'), left(event_type, 200),
           max(coalesce(severity, 'error')), count(*), min(ts_utc), max(ts_utc), (array_agg(payload ORDER BY ts_utc))[1]
      FROM audit_log WHERE ${AUDIT_ERROR_SQL} AND ts_utc < $1 AND id <= $2
     GROUP BY 1, 2
    ON CONFLICT (bucket, event_type) DO UPDATE SET
      n = audit_error_15m.n + EXCLUDED.n,
      first_ts = least(audit_error_15m.first_ts, EXCLUDED.first_ts),
      last_ts = greatest(audit_error_15m.last_ts, EXCLUDED.last_ts)`,
  deleteAckedErrors: `DELETE FROM audit_log WHERE ${AUDIT_ERROR_SQL} AND ts_utc < $1 AND id <= $2`,
  dropErrorBuckets: 'DELETE FROM audit_error_15m WHERE bucket < $1',
  dropOptimizerSeries: `DELETE FROM optimizer_run_series WHERE optimizer_run_id IN (
      SELECT id FROM optimizer_runs WHERE run_started_at < $1)`,
};

// Laufreihen tageweise: ein Tag ist fertig, wenn nur noch EIN Lauf Werte
// für ihn hat. Exportiert für den PostgreSQL-Test.
export const SERIES_RETENTION_SQL = Object.freeze({
  // $1 Zeitzone, $2 Stichtag
  oldestMultiRunDay: `SELECT day::text AS day FROM (
      SELECT (ts_utc AT TIME ZONE $1)::date AS day
        FROM optimizer_run_series WHERE ts_utc < $2
       GROUP BY 1 HAVING count(DISTINCT optimizer_run_id) > 1
    ) x ORDER BY day LIMIT 1`,
  // $1 Tag (YYYY-MM-DD), $2 Zeitzone. Ein „Lauf“ ist ein Durchgang der
  // Optimierer-Schleife (alle paar Minuten, Reihen meist stündlich über ~48 h —
  // auch ohne Preise für den Tag, deshalb taugt die Abdeckung nicht).
  // Bleibt: der erste Lauf, der mindestens 30 min nach Eingang der Day-Ahead-
  // Preise für diesen Tag startete (audit_log epex_dayahead_arrived, Datum im
  // payload; bis dahin hat EOS mit den neuen Preisen gerechnet). Fehlt der
  // Eintrag: 14:30 Uhr am Vortag. Kein Lauf danach: der früheste mit Werten
  // des Tages. Alle anderen Werte dieses Tages gehen.
  thinSeriesDay: `WITH d AS (
      SELECT ($1::date::timestamp AT TIME ZONE $2) AS d0, (($1::date + 1)::timestamp AT TIME ZONE $2) AS d1
    ), anchor AS (
      SELECT coalesce(
        (SELECT min(ts_utc) FROM audit_log
          WHERE event_type = 'epex_dayahead_arrived' AND payload->>'date' = to_char($1::date, 'YYYY-MM-DD')) + interval '30 minutes',
        (($1::date - 1)::timestamp + time '14:30') AT TIME ZONE $2) AS a
    ), cand AS (
      SELECT s.optimizer_run_id AS id, min(r.run_started_at) AS started
        FROM optimizer_run_series s JOIN optimizer_runs r ON r.id = s.optimizer_run_id, d
       WHERE s.ts_utc >= d.d0 AND s.ts_utc < d.d1
       GROUP BY s.optimizer_run_id
    ), keep AS (
      SELECT cand.id FROM cand, anchor
       ORDER BY (cand.started >= anchor.a) DESC, cand.started ASC, cand.id ASC
       LIMIT 1
    )
    DELETE FROM optimizer_run_series s USING d
     WHERE s.ts_utc >= d.d0 AND s.ts_utc < d.d1
       AND s.optimizer_run_id <> (SELECT id FROM keep)`,
});

// Optimierer-Läufe (Review 25.10.2026): je Schleifendurchgang eine Zeile mit
// result_json, vorher nie gelöscht (prod 32 005 Zeilen / 32 MB). Nach dem
// Stichtag der Einzelwerte geht jeder Lauf, der keine Reihen mehr hat — das
// Ausdünnen oben lässt je Tag nur den Day-Ahead-Plan stehen, nach 2 Jahren
// auch den nicht. Es bleibt also, was gelesen wird: Läufe mit Reihen (Tagesplan,
// Ausdünnen braucht run_started_at) und der jüngste Lauf je Optimierer
// (getLatestOptimizerRun → /api/optimizer/runs/latest für die Leitstand-Kurve,
// Prognose-Inspektor; wahlweise je Optimierer gefiltert), auch
// wenn er älter ist. Paketweise ($2 Zeilen), damit eine alte Box nicht in
// einem Rutsch löscht. Exportiert für den PostgreSQL-Test.
export const OPTIMIZER_RUN_BATCH = 5000;
export const OPTIMIZER_RUN_RETENTION_SQL = Object.freeze({
  // $1 Stichtag, $2 Paketgröße
  deleteRunsWithoutSeries: `DELETE FROM optimizer_runs WHERE id IN (
      SELECT r.id FROM optimizer_runs r
       WHERE r.run_started_at < $1
         AND NOT EXISTS (SELECT 1 FROM optimizer_run_series s WHERE s.optimizer_run_id = r.id)
         AND r.id NOT IN (SELECT DISTINCT ON (optimizer) id FROM optimizer_runs
                           ORDER BY optimizer, run_started_at DESC, id DESC)
       ORDER BY r.run_started_at
       LIMIT $2)`,
});

/** Stichtage: Beginn des lokalen Tages vor `days` Tagen (als ISO-Zeitpunkt). */
function cutoffs(nowMs, detailDays, aggregateDays) {
  const day = 86_400_000;
  return {
    detail: new Date(nowMs - detailDays * day).toISOString(),
    aggregate: new Date(nowMs - aggregateDays * day).toISOString(),
  };
}

/**
 * @param {object} deps
 * @param {() => (number|null)} [deps.getErrorAckId]  höchste audit_log.id, die das
 *   Installateur-Portal quittiert hat (null = kein Portal / nichts quittiert)
 */
export function createLogRetention({ getDb, getCfg, pushLog, getErrorAckId = () => null, now = () => Date.now() } = {}) {
  let running = false;
  const log = (e, d) => { try { pushLog?.(e, d); } catch { /* egal */ } };

  async function runOnce() {
    if (running) return { skipped: 'already running' };
    const db = getDb?.();
    if (!db || typeof db.query !== 'function') return { skipped: 'no database' };
    const cfg = getCfg?.() || {};
    const r = cfg.telemetry?.logRetention || {};
    // Unsere eigenen Geräte: alles behalten (Einstellungen → Datenbank).
    if (r.mode === 'full') return { skipped: 'full' };
    const detailDays = Number(r.detailDays) > 0 ? Number(r.detailDays) : LOG_DETAIL_DAYS;
    const errorDetailDays = Math.max(detailDays, Number(r.errorDetailDays) > 0 ? Number(r.errorDetailDays) : LOG_ERROR_DETAIL_DAYS);
    const aggregateDays = Math.max(detailDays, Number(r.aggregateDays) > 0 ? Number(r.aggregateDays) : LOG_AGGREGATE_DAYS);
    const tz = cfg.timeZone || 'Europe/Berlin';
    const t0 = now();
    const { detail, aggregate } = cutoffs(t0, detailDays, aggregateDays);
    const errorDetail = cutoffs(t0, errorDetailDays, aggregateDays).detail;
    const out = { portalErrors: 0, controlDays: 0, errorDays: 0, auditDays: 0, optimizerRows: 0, optimizerRuns: 0, deleted: 0, done: true };
    const budgetLeft = () => now() - t0 < TIME_BUDGET_MS;
    running = true;
    try {
      // Vom Portal quittierte Fehler: 24 h voll, dann 15-min-Bündel, nach 7 Tagen weg.
      const ackId = Number(getErrorAckId?.());
      if (Number.isFinite(ackId) && ackId > 0) {
        const rawCut = new Date(t0 - (Number(r.portalErrorRawHours) > 0 ? Number(r.portalErrorRawHours) : PORTAL_ERROR_RAW_HOURS) * 3_600_000).toISOString();
        const client = typeof db.connect === 'function' ? await db.connect() : db;
        try {
          await client.query('BEGIN');
          await client.query(sql.bucketAckedErrors, [rawCut, ackId]);
          const del = await client.query(sql.deleteAckedErrors, [rawCut, ackId]);
          await client.query('COMMIT');
          out.portalErrors = del.rowCount || 0;
          out.deleted += out.portalErrors;
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {});
          throw e;
        } finally {
          if (client !== db) client.release?.();
        }
        const bucketCut = new Date(t0 - (Number(r.portalErrorBucketDays) > 0 ? Number(r.portalErrorBucketDays) : PORTAL_ERROR_BUCKET_DAYS) * 86_400_000).toISOString();
        out.deleted += (await db.query(sql.dropErrorBuckets, [bucketCut])).rowCount || 0;
      }
      // Älteste noch rohe Tage vor dem Stichtag verdichten — aber nur ganze
      // Tage, die komplett vor dem Stichtag liegen.
      const localDay = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(iso));
      const plans = {
        control: [sql.oldestControlWriteDay, sql.aggregateControlDay, sql.deleteControlDay, 'controlDays', detail],
        error: [sql.oldestAuditErrorDay, sql.aggregateErrorDay, sql.deleteErrorDay, 'errorDays', errorDetail],
        audit: [sql.oldestAuditNoiseDay, sql.aggregateAuditDay, sql.deleteAuditDay, 'auditDays', detail],
      };
      for (const q of Object.values(plans)) {
        let previous = null;
        const cut = q[4];
        const cutDay = localDay(cut);
        while (budgetLeft()) {
          const oldest = (await db.query(q[0], [tz, cut])).rows?.[0]?.day;
          if (!oldest || oldest >= cutDay) break;
          // Schutz: derselbe Tag noch einmal = Löschen hat ihn nicht geleert
          // (z. B. Zeitzonen-Grenzfall) — nicht endlos auf der DB kreisen.
          if (oldest === previous) { log('log_retention_stuck', { day: oldest }); break; }
          previous = oldest;
          await db.query(q[1], [oldest, tz]);
          const del = await db.query(q[2], [oldest, tz]);
          out.deleted += del.rowCount || 0;
          out[q[3]] += 1;
        }
      }
      // Laufreihen: je Tag nur der Plan, mit dem der Tag geplant war.
      const detailDay = localDay(detail);
      let previousSeriesDay = null;
      while (budgetLeft()) {
        const day = (await db.query(SERIES_RETENTION_SQL.oldestMultiRunDay, [tz, detail])).rows?.[0]?.day;
        if (!day || day >= detailDay) break;
        if (day === previousSeriesDay) { log('log_retention_stuck', { day, table: 'optimizer_run_series' }); break; }
        previousSeriesDay = day;
        const del = await db.query(SERIES_RETENTION_SQL.thinSeriesDay, [day, tz]);
        out.optimizerRows += del.rowCount || 0;
        out.deleted += del.rowCount || 0;
      }
      // Optimierer-Reihen nach 2 Jahren weg; Ereignisse und Verdichtetes bleiben.
      if (budgetLeft()) out.deleted += (await db.query(sql.dropOptimizerSeries, [aggregate])).rowCount || 0;
      // Läufe ohne Reihen nach dem Stichtag (siehe OPTIMIZER_RUN_RETENTION_SQL).
      while (budgetLeft()) {
        const n = (await db.query(OPTIMIZER_RUN_RETENTION_SQL.deleteRunsWithoutSeries, [detail, OPTIMIZER_RUN_BATCH])).rowCount || 0;
        out.optimizerRuns += n;
        out.deleted += n;
        if (n === 0) break;
      }
      out.done = budgetLeft();
      if (out.deleted) log('log_retention', out);
      return out;
    } catch (e) {
      log('log_retention_error', { error: e.message });
      return { error: e.message };
    } finally {
      running = false;
    }
  }

  return { runOnce };
}
