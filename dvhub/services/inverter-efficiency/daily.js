// services/inverter-efficiency/daily.js — Wechselrichter-Wirkungsgrad (Akku-DC → AC)
// als Tagesaggregat (Christin 2026-09-27).
//
// Aus den ~5-s-Live-Samples summiert der Job je Tag und Lastbereich die AC- und
// DC-Energie auf und legt sie in inverter_efficiency_daily ab (Migration 021).
// Die History liest nur diese Tageszeilen. η einer Periode = Σ AC-Wh / Σ DC-Wh
// — energiegewichtet, kein Mittel von Mitteln —, deshalb addieren sich Tage
// exakt zu Monaten und Jahren. Die Rohwerte bleiben unverändert erhalten.
//
// Bilanz je Sample (alle Reihen tragen denselben Poll-Zeitstempel):
//   AC aus dem Wechselrichter = Last + Einspeisung − Netzbezug − AC-PV
//   DC in den Wechselrichter  = Akku-Entladung (BMS, +=Laden) + DC-PV
// NICHT grid_total_w verwenden: Vorzeichen bzw. Phasensumme dieser Reihe hat die
// Kalibrierung vom 21.07.2026 verfälscht (η nachts 0,77 statt real ~0,93 —
// gegengeprüft über 45 Nachtbilanzen und die SoC-Abnahme).
//
// Filter wie bei der Kalibrierung vom 2026-09-27: nur Entladung > 300 W,
// stabile Samples (Akku ±5 % zum Vorgänger, Abstand < 12 s), SoC 7–98 %,
// PV-Anteil am DC < 10 %, plausibles η 0,4–1,02.

export const EFFICIENCY_SERIES_KEYS = Object.freeze([
  'battery_power_w',
  'load_power_w',
  'grid_import_w',
  'grid_export_w',
  'pv_dc_w',
  'pv_ac_l1_w',
  'pv_ac_l2_w',
  'pv_ac_l3_w',
  'battery_soc_pct',
]);

// Lastbereiche relativ zur Nennleistung, damit dieselbe Definition auf jeder
// Anlagengröße passt. Bei 24 kW: Grundlast 0,48–3 kW, Volllast ab 18 kW.
export const EFFICIENCY_BUCKETS = Object.freeze({
  base: Object.freeze({ fromFrac: 0.02, toFrac: 0.125 }),
  full: Object.freeze({ fromFrac: 0.75, toFrac: null }),
});

// Feine Lastbereiche für die Kurven-Kalibrierung (Migration 022, curve.js),
// relativ zur Nennleistung. Bin i = [EDGES[i], EDGES[i+1]), der letzte offen.
// Unten eng, weil η dort steil abfällt. Die Grenzen von Grund- (0,02–0,125)
// und Volllast (≥ 0,75) sind Bin-Grenzen — beide Bereiche sind deshalb exakt
// die Summe ihrer Bins, ein Datenbankdurchlauf reicht für beides.
// ACHTUNG: Grenzen nie ändern, ohne die Tabelle neu zu rechnen (alte Zeilen
// hätten sonst eine andere Bedeutung).
export const EFFICIENCY_BIN_EDGES = Object.freeze([
  0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.10, 0.125,
  0.15, 0.20, 0.25, 0.30, 0.40, 0.50, 0.60, 0.75, 0.85,
]);
export const EFFICIENCY_BIN_COUNT = EFFICIENCY_BIN_EDGES.length;

export function bucketOfBin(bin) {
  const from = EFFICIENCY_BIN_EDGES[bin];
  if (from >= EFFICIENCY_BUCKETS.base.fromFrac && from < EFFICIENCY_BUCKETS.base.toFrac) return 'base';
  if (from >= EFFICIENCY_BUCKETS.full.fromFrac) return 'full';
  return null;
}

// Unter 10 Minuten Datenbasis in einer Periode wird kein Wert angezeigt.
export const MIN_SECONDS_FOR_VALUE = 600;

const DEFAULT_NOMINAL_W = 24000;
const DAY_MS = 86_400_000;

export const DAILY_EFFICIENCY_SQL = `
WITH p AS (
  SELECT ts_utc AS t,
    max(value_num) FILTER (WHERE series_key = 'battery_power_w') AS bp,
    max(value_num) FILTER (WHERE series_key = 'load_power_w') AS ld,
    max(value_num) FILTER (WHERE series_key = 'grid_import_w') AS gi,
    max(value_num) FILTER (WHERE series_key = 'grid_export_w') AS ge,
    coalesce(max(value_num) FILTER (WHERE series_key = 'pv_dc_w'), 0) AS pdc,
    coalesce(max(value_num) FILTER (WHERE series_key = 'pv_ac_l1_w'), 0)
      + coalesce(max(value_num) FILTER (WHERE series_key = 'pv_ac_l2_w'), 0)
      + coalesce(max(value_num) FILTER (WHERE series_key = 'pv_ac_l3_w'), 0) AS pac,
    max(value_num) FILTER (WHERE series_key = 'battery_soc_pct') AS soc
  FROM timeseries_samples
  WHERE scope = 'live'
    AND ts_utc >= ($1::date::timestamp AT TIME ZONE $2::text)
    AND ts_utc < (($1::date + 1)::timestamp AT TIME ZONE $2::text)
    AND series_key = ANY($3::text[])
  GROUP BY ts_utc
),
q AS (
  SELECT *, lag(bp) OVER (ORDER BY t) AS bp_prev, lag(t) OVER (ORDER BY t) AS t_prev
  FROM p
),
r AS (
  SELECT (ld + ge - gi - pac) AS ac,
         (-bp + pdc) AS dc,
         extract(epoch FROM (t - t_prev)) AS dt
  FROM q
  WHERE bp < -300
    AND ld IS NOT NULL AND gi IS NOT NULL AND ge IS NOT NULL
    AND bp_prev IS NOT NULL
    AND t - t_prev < interval '12 seconds'
    AND abs(bp - bp_prev) < 0.05 * abs(bp)
    AND soc BETWEEN 7 AND 98
    AND (pac + pdc) < 0.10 * (-bp)
),
b AS (
  SELECT width_bucket(ac / $4::float8, $5::float8[]) - 1 AS bin,
         ac, dc, dt
  FROM r
  WHERE dc > 0 AND ac / dc BETWEEN 0.4 AND 1.02
)
SELECT bin,
       sum(ac * dt) / 3600.0 AS ac_wh,
       sum(dc * dt) / 3600.0 AS dc_wh,
       sum(dt) AS seconds,
       count(*)::int AS samples
FROM b
WHERE bin >= 0
GROUP BY bin
ORDER BY bin`;

export const UPSERT_BIN_SQL = `
INSERT INTO inverter_efficiency_bins_daily (day, bin, ac_wh, dc_wh, seconds, samples, pnom_w, computed_at)
VALUES ($1::date, $2, $3, $4, $5, $6, $7, now())
ON CONFLICT (day, bin) DO UPDATE SET
  ac_wh = EXCLUDED.ac_wh,
  dc_wh = EXCLUDED.dc_wh,
  seconds = EXCLUDED.seconds,
  samples = EXCLUDED.samples,
  pnom_w = EXCLUDED.pnom_w,
  computed_at = now()`;

export const UPSERT_EFFICIENCY_SQL = `
INSERT INTO inverter_efficiency_daily (day, bucket, ac_wh, dc_wh, seconds, samples, pnom_w, computed_at)
VALUES ($1::date, $2, $3, $4, $5, $6, $7, now())
ON CONFLICT (day, bucket) DO UPDATE SET
  ac_wh = EXCLUDED.ac_wh,
  dc_wh = EXCLUDED.dc_wh,
  seconds = EXCLUDED.seconds,
  samples = EXCLUDED.samples,
  pnom_w = EXCLUDED.pnom_w,
  computed_at = now()`;

// Erster Tag mit Rohdaten, begrenzt auf gut ein Jahr Rückblick.
export const FIRST_RAW_DAY_SQL = `
SELECT to_char(min(ts_utc) AT TIME ZONE $1::text, 'YYYY-MM-DD') AS first_day
FROM timeseries_samples
WHERE series_key = 'battery_power_w' AND scope = 'live'
  AND ts_utc > now() - interval '400 days'`;

// Noch nicht berechnete Tage zwischen erstem Rohdatentag und gestern, neueste zuerst.
export const MISSING_DAYS_SQL = `
SELECT to_char(d, 'YYYY-MM-DD') AS day
FROM generate_series($1::date, $2::date, interval '1 day') AS d
WHERE NOT EXISTS (SELECT 1 FROM inverter_efficiency_bins_daily e WHERE e.day = d::date)
ORDER BY d DESC
LIMIT $3`;

export function nominalInverterPowerW(cfg) {
  const w = Number(cfg?.optimizer?.inverterMaxPowerW);
  return Number.isFinite(w) && w > 0 ? w : DEFAULT_NOMINAL_W;
}

export function bucketBoundsW(cfg) {
  const pnom = nominalInverterPowerW(cfg);
  return {
    base: { fromW: Math.round(pnom * EFFICIENCY_BUCKETS.base.fromFrac), toW: Math.round(pnom * EFFICIENCY_BUCKETS.base.toFrac) },
    full: { fromW: Math.round(pnom * EFFICIENCY_BUCKETS.full.fromFrac), toW: null },
  };
}

// Kalendertag (YYYY-MM-DD) eines Zeitpunkts in der Anlagen-Zeitzone.
export function localDateString(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function round(n, digits = 3) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

// Fasst beliebig viele Tageszeilen je Bereich zusammen (Tag, Monat, Jahr …).
export function summarizeEfficiencyRows(rows) {
  const out = {};
  for (const bucket of Object.keys(EFFICIENCY_BUCKETS)) {
    let ac = 0;
    let dc = 0;
    let seconds = 0;
    for (const r of rows || []) {
      if (!r || r.bucket !== bucket) continue;
      ac += Number(r.ac_wh) || 0;
      dc += Number(r.dc_wh) || 0;
      seconds += Number(r.seconds) || 0;
    }
    const enough = seconds >= MIN_SECONDS_FOR_VALUE && dc > 0;
    const eta = enough ? ac / dc : null;
    out[bucket] = {
      etaPct: eta == null ? null : round(eta * 100, 1),
      acKwh: round(ac / 1000),
      dcKwh: round(dc / 1000),
      hours: round(seconds / 3600, 1),
      enough,
      // η ≥ 99,5 % bedeutet: die Last wird aus dem Akku-DC abgeleitet statt
      // gemessen — dann ist der Wirkungsgrad aus diesen Reihen nicht bestimmbar.
      measurable: eta == null ? null : eta < 0.995,
    };
  }
  return out;
}

export function createInverterEfficiencyDaily({ getDb, getCfg, pushLog, maxBackfillDays = 31 } = {}) {
  let running = false;
  let firstRawDay = null;
  let finalizedDay = null;

  const timeZone = () => getCfg?.()?.timeZone || 'Europe/Berlin';
  const log = (event, data) => { if (typeof pushLog === 'function') pushLog(event, data); };

  async function computeDay(db, day) {
    const cfg = getCfg?.() || {};
    const pnom = nominalInverterPowerW(cfg);
    const res = await db.query(DAILY_EFFICIENCY_SQL, [
      day, timeZone(), EFFICIENCY_SERIES_KEYS, pnom, EFFICIENCY_BIN_EDGES,
    ]);
    const byBin = new Map((res.rows || []).map((r) => [Number(r.bin), r]));
    const buckets = Object.fromEntries(Object.keys(EFFICIENCY_BUCKETS).map((k) => [k, { ac: 0, dc: 0, seconds: 0, samples: 0 }]));
    // Alle Bins immer schreiben — 0-Zeilen markieren den Tag als berechnet.
    for (let bin = 0; bin < EFFICIENCY_BIN_COUNT; bin++) {
      const r = byBin.get(bin) || {};
      const row = { ac: Number(r.ac_wh) || 0, dc: Number(r.dc_wh) || 0, seconds: Number(r.seconds) || 0, samples: Number(r.samples) || 0 };
      await db.query(UPSERT_BIN_SQL, [day, bin, row.ac, row.dc, row.seconds, row.samples, pnom]);
      const bucket = bucketOfBin(bin);
      if (bucket) for (const k of ['ac', 'dc', 'seconds', 'samples']) buckets[bucket][k] += row[k];
    }
    // Grund-/Volllast (History-Karte, Migration 021) = Summe ihrer Bins.
    for (const [bucket, t] of Object.entries(buckets)) {
      await db.query(UPSERT_EFFICIENCY_SQL, [day, bucket, t.ac, t.dc, t.seconds, t.samples, pnom]);
    }
  }

  // Heute (laufend) und einmal pro Tag den abgeschlossenen Vortag neu rechnen,
  // dann fehlende ältere Tage nachholen (höchstens maxBackfillDays je Lauf,
  // damit die Box beim ersten Start nicht minutenlang rechnet).
  async function runOnce({ now = new Date() } = {}) {
    if (running) return { skipped: 'already running' };
    const db = getDb?.();
    if (!db || typeof db.query !== 'function') return { skipped: 'no database' };
    running = true;
    const computed = [];
    try {
      const tz = timeZone();
      const today = localDateString(now, tz);
      const yesterday = localDateString(new Date(now.getTime() - DAY_MS), tz);
      await computeDay(db, today);
      computed.push(today);
      if (finalizedDay !== yesterday) {
        await computeDay(db, yesterday);
        computed.push(yesterday);
        finalizedDay = yesterday;
      }
      if (!firstRawDay) {
        const first = await db.query(FIRST_RAW_DAY_SQL, [tz]);
        firstRawDay = first.rows?.[0]?.first_day || null;
      }
      if (firstRawDay && firstRawDay < yesterday) {
        const missing = await db.query(MISSING_DAYS_SQL, [firstRawDay, yesterday, maxBackfillDays]);
        for (const row of missing.rows || []) {
          await computeDay(db, row.day);
          computed.push(row.day);
        }
      }
      log('inverter_efficiency_daily', { days: computed.length, newest: computed[0], oldest: computed[computed.length - 1] });
      return { computed };
    } catch (e) {
      log('inverter_efficiency_daily_error', { error: e.message, computed: computed.length });
      return { error: e.message, computed };
    } finally {
      running = false;
    }
  }

  return { runOnce, computeDay };
}
