// services/history-backfill/pv-ac.js — AC-PV der eigenen Viertelstunden für den
// Altbestand aus den Rohwerten nachtragen (Christin 24.11.2026, Nebenbefund T12).
//
// Die Historie liest pvAcKwh aus der Reihe pv_ac_w (telemetry-store-pg.js
// MATERIALIZED_SLOT_FIELDS). Die Live-Telemetrie schrieb sie bis 24.11.2026 nie —
// nur pv_ac_l1..l3_w (ohne die zweite AC-PV-Position) und pv_total_w. Seitdem
// schreibt telemetry-runtime.js pv_ac_w; dieser Job trägt die eigenen
// Viertelstunden davor nach:
//   Energie je Slot = Σ max(PV gesamt − DC-PV, 0) × min(Auflösung, 900 s)
// — dieselbe Rechnung wie der Live-Pfad (sampleEnergyBySlot) für pv_total_w, aus
// denselben Proben. Der Vermerk (Abdeckung) kommt von der pv_total_w-Zeile des
// Slots, damit die Quellwahl gegen VRM (energy-source-rule.js) für PV gesamt und
// AC-PV gleich ausfällt.
//
// Portionsweise wie coverage.js: je Lauf ein UTC-Tag (ein INSERT), nur Tage ab
// den ersten eigenen Rohwerten und nur abgeschlossene (vor gestern, damit nichts
// mit dem Live-Pfad kollidiert), Pause = zehnfache Laufzeit. Idempotent: ON
// CONFLICT DO NOTHING, nur Slots ohne eigene pv_ac_w-Zeile.
// Codex eea3b53a:
//   - erst wenn coverage.js den Tag abgeschlossen hat (jede eigene pv_total_w-
//     Zeile hat Abdeckung oder Vermerk) — sonst würde ein leerer Vermerk kopiert;
//   - nur Slots, deren Rohwerte noch vollständig da sind: PV gesamt aus den Proben
//     nachgerechnet muss zum gespeicherten Slot-Wert passen (±2 %, mind. 0,005 kWh);
//     die Platz-Wache löscht alte Rohwerte, die Viertelstunden bleiben;
//   - ein Tag gilt erst nach erfolgreichem INSERT als bearbeitet.
// Slots ohne passende Rohwerte bleiben offen (nichts zu raten); damit der Job sie
// nicht endlos wiederholt, merkt er sich die bearbeiteten Tage bis zum Neustart.

import { COVERAGE_PAUSE_FACTOR, COVERAGE_RESCAN_MS } from './coverage.js';

const DAY_MS = 86_400_000;

export const PV_AC_FIRST_RAW_SQL = `
SELECT to_char(min(ts_utc) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS first_day
FROM timeseries_samples
WHERE series_key = 'pv_total_w' AND scope = 'live' AND source = 'local_poll'`;

// $1 erster Rohdaten-Tag, $2 Grenze (exklusiv). Offen = ein eigener pv_total_w-Slot
// ohne eigene pv_ac_w-Zeile; abgeschlossen = alle pv_total_w-Zeilen des Tages mit
// Abdeckung oder Vermerk (coverage.js ist durch).
export const PV_AC_OPEN_DAYS_SQL = `
SELECT day FROM (
  SELECT to_char(date_trunc('day', t.slot_start_utc AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
         bool_and((m.j ->> 'coverageS') IS NOT NULL OR (m.j ->> 'coverageBackfill') IS NOT NULL) AS finalized,
         bool_or(NOT EXISTS (
           SELECT 1 FROM energy_slots_15m a
           WHERE a.slot_start_utc = t.slot_start_utc AND a.series_key = 'pv_ac_w' AND a.source_kind = 'local_live')) AS open
  FROM energy_slots_15m t
  CROSS JOIN LATERAL (SELECT nullif(t.meta_json::text, '')::jsonb AS j) m
  WHERE t.source_kind = 'local_live' AND t.series_key = 'pv_total_w'
    AND t.slot_start_utc >= $1::timestamptz AND t.slot_start_utc < $2::timestamptz
  GROUP BY 1
) d
WHERE finalized AND open
ORDER BY day DESC`;

// $1/$2 UTC-Tag [von, bis).
export const PV_AC_INSERT_SQL = `
WITH s AS (
  SELECT ts_utc,
         max(value_num) FILTER (WHERE series_key = 'pv_total_w') AS ptot,
         coalesce(max(value_num) FILTER (WHERE series_key = 'pv_dc_w'), 0) AS pdc,
         max(resolution_seconds) FILTER (WHERE series_key = 'pv_total_w') AS res
  FROM timeseries_samples
  WHERE scope = 'live' AND source = 'local_poll'
    AND ts_utc >= $1::timestamptz AND ts_utc < $2::timestamptz
    AND series_key IN ('pv_total_w', 'pv_dc_w')
  GROUP BY ts_utc
),
e AS (
  SELECT to_timestamp(floor(extract(epoch FROM ts_utc) / 900) * 900) AS slot,
         sum(greatest(ptot - pdc, 0) * least(res, 900)) / 3600000.0 AS kwh,
         sum(ptot * least(res, 900)) / 3600000.0 AS ptot_kwh
  FROM s
  WHERE ptot IS NOT NULL AND res > 0
  GROUP BY 1
)
INSERT INTO energy_slots_15m (slot_start_utc, series_key, source_kind, quality, value_num, unit, meta_json)
SELECT e.slot, 'pv_ac_w', 'local_live', 'raw_derived', e.kwh, 'kWh', t.meta_json
FROM e
JOIN energy_slots_15m t
  ON t.slot_start_utc = e.slot AND t.series_key = 'pv_total_w' AND t.source_kind = 'local_live'
WHERE abs(e.ptot_kwh - coalesce(t.value_num, 0)) <= greatest(0.005, 0.02 * abs(coalesce(t.value_num, 0)))
  AND ((nullif(t.meta_json::text, '')::jsonb ->> 'coverageS') IS NOT NULL
    OR (nullif(t.meta_json::text, '')::jsonb ->> 'coverageBackfill') IS NOT NULL)
ON CONFLICT (slot_start_utc, series_key, source_kind) DO NOTHING`;

export function createPvAcBackfill({ getDb, pushLog, onDayUpdated = null, now = () => Date.now() } = {}) {
  let running = false;
  let queue = null;
  let firstDay = null;
  let doneAt = null;
  let pauseUntil = 0;
  const processed = new Set();
  const log = (event, data) => { if (typeof pushLog === 'function') pushLog(event, data); };

  async function runOnce() {
    if (running) return { skipped: 'already running' };
    const db = getDb?.();
    if (!db || typeof db.query !== 'function') return { skipped: 'no database' };
    if (doneAt != null && now() - doneAt < COVERAGE_RESCAN_MS) return { skipped: 'done' };
    if (now() < pauseUntil) return { skipped: 'pause' };
    running = true;
    const startedAt = now();
    try {
      if (!firstDay) {
        const f = await db.query(PV_AC_FIRST_RAW_SQL);
        firstDay = f.rows?.[0]?.first_day || null;
        if (!firstDay) {
          doneAt = now();
          return { done: true };
        }
      }
      if (!queue || queue.length === 0) {
        // Nur abgeschlossene Tage: vor gestern (UTC).
        const limit = new Date(Math.floor(now() / DAY_MS) * DAY_MS - DAY_MS).toISOString();
        const open = await db.query(PV_AC_OPEN_DAYS_SQL, [`${firstDay}T00:00:00.000Z`, limit]);
        queue = (open.rows || []).map((r) => String(r.day).slice(0, 10)).filter((day) => !processed.has(day));
        if (queue.length === 0) {
          doneAt = now();
          log('history_pv_ac_backfill_done', {});
          return { done: true };
        }
        doneAt = null;
      }
      const day = queue.shift();
      const from = `${day}T00:00:00.000Z`;
      const to = new Date(Date.parse(from) + DAY_MS).toISOString();
      const res = await db.query(PV_AC_INSERT_SQL, [from, to]);
      processed.add(day);   // erst nach Erfolg (Codex eea3b53a)
      const inserted = Number(res.rowCount) || 0;
      pauseUntil = now() + (now() - startedAt) * COVERAGE_PAUSE_FACTOR;
      if (inserted > 0 && typeof onDayUpdated === 'function') {
        try { onDayUpdated(from); } catch { /* nur Zwischenspeicher */ }
      }
      log('history_pv_ac_backfill', { day, inserted, remaining: queue.length });
      return { day, inserted, remaining: queue.length };
    } catch (e) {
      queue = null;
      log('history_pv_ac_backfill_error', { error: e.message });
      return { error: e.message };
    } finally {
      running = false;
    }
  }

  return { runOnce };
}
