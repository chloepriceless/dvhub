// load-bias-corrector.js -- Adaptive night-baseload correction for the load
// forecast ("Nacht-Grundlast-Schnelllerner").
//
// PROBLEM (operator, 2026-06-28): the base load forecast (SQL same-weekday over
// 28 days, or StatsForecast over a 1-month window) adapts far too slowly. When
// the real nighttime baseload changes (a new always-on consumer, a heatwave AC
// running through the night), the slow rolling average needs WEEKS to catch up.
// In the meantime EOS reserves too little battery for the night, the pack hits
// its SoC floor, and the house pulls from the grid at night.
//
// TECHNIQUE: a tracking-signal-triggered EWMA bias correction (the forecasting
// classic -- Trigg's adaptive smoothing). When the forecast error is
// PERSISTENTLY one-sided over several consecutive nights, the model is treated
// as out of date and a FAST learning rate is used; otherwise a gentle rate just
// tracks. The correction is applied as an EWMA blend of the recent MEASURED
// night load and the base forecast:
//
//     corrected = alpha * measuredRecent + (1 - alpha) * baseForecast
//
// Symmetric on purpose: a persistent OVER-forecast (consumer switched off again,
// weather cooled) raises alpha in the down direction too, so the correction
// relaxes back toward baseline within days instead of staying stuck high.
//
// WHY the trigger is the forecast error, NOT grid import directly: once the
// correction lifts the reserve, the nighttime grid import disappears -- if grid
// import were the trigger it would cancel its own signal and oscillate. The
// measured-load-vs-base-forecast error does not depend on battery dispatch, so
// it stays stable. Grid import is recorded only as the corroborating symptom for
// observability (the operator's mental model: "Netzbezug an 3 Nächten in Folge").
//
// Injection point: createLoadForecast.runForecast() calls applyNightCorrection()
// AFTER state.forecast.load.data is set, so the corrected slots flow unchanged
// into both /api/forecast (buildLoadSection reads state.forecast.load.data) and
// the EOS bridge (loadforecast_power_w). No other wiring changes.
//
// Default ON (operator directive 2026-06-28), but bounded: the blend target is a
// robust per-hour MEDIAN over several nights (a single sensor glitch cannot move
// it), and the result is clamped to [minNightLoadW, maxNightLoadW].

// energy_slots_15m stores load/grid rows as kWh-per-15min (unit='kWh'); x4000
// (x4 for 15min->h, x1000 for kW->W) yields average watts -- identical to
// load-forecast.js / accuracy-tracker.js.
const KWH15_TO_W = 4000;

const DEFAULTS = Object.freeze({
  enabled: true,            // operator directive 2026-06-28: default ON
  nightStartHour: 22,       // Berlin local; window is [start, end) crossing midnight
  nightEndHour: 6,
  consecutiveNights: 3,     // operator's "3 Nächte in Folge" trigger
  windowNights: 3,          // how many recent nights feed the measured median
  marginW: 150,             // |measured - base| must exceed this to count as biased
  minGridImportW: 150,      // night-grid-import threshold for the logged symptom
  alphaFast: 0.6,           // learning rate when a persistent bias is detected
  alphaSlow: 0.25,          // gentle tracking rate otherwise
  minNightLoadW: 0,         // safety clamp (lower)
  maxNightLoadW: 6000,      // safety clamp (upper) -- guards against bad data
  lookbackDays: 10,         // telemetry lookback (>= consecutive+window + slack)
});

/** Resolve the adaptiveNight config with defensive defaults (forecast.load is
 * migration-seeded, so it may be entirely absent on older boxes). Default ON =
 * `enabled` is true unless EXPLICITLY set to false. */
export function selectNightConfig(cfg) {
  const an = cfg?.forecast?.load?.adaptiveNight || {};
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const int = (v, d) => (Number.isInteger(Number(v)) ? Number(v) : d);
  const clampHour = (v, d) => {
    const h = int(v, d);
    return h >= 0 && h <= 23 ? h : d;
  };
  return {
    enabled: an.enabled !== false,
    nightStartHour: clampHour(an.nightStartHour, DEFAULTS.nightStartHour),
    nightEndHour: clampHour(an.nightEndHour, DEFAULTS.nightEndHour),
    consecutiveNights: Math.max(1, int(an.consecutiveNights, DEFAULTS.consecutiveNights)),
    windowNights: Math.max(1, int(an.windowNights, DEFAULTS.windowNights)),
    marginW: Math.max(0, num(an.marginW, DEFAULTS.marginW)),
    minGridImportW: Math.max(0, num(an.minGridImportW, DEFAULTS.minGridImportW)),
    alphaFast: Math.min(1, Math.max(0, num(an.alphaFast, DEFAULTS.alphaFast))),
    alphaSlow: Math.min(1, Math.max(0, num(an.alphaSlow, DEFAULTS.alphaSlow))),
    minNightLoadW: Math.max(0, num(an.minNightLoadW, DEFAULTS.minNightLoadW)),
    maxNightLoadW: Math.max(0, num(an.maxNightLoadW, DEFAULTS.maxNightLoadW)),
    lookbackDays: Math.max(1, int(an.lookbackDays, DEFAULTS.lookbackDays)),
  };
}

/** Is Berlin local hour h inside the night window [start, end)? Handles the
 * usual midnight-crossing window (start > end, e.g. 22..6). */
export function isNightHour(h, start, end) {
  return start <= end ? (h >= start && h < end) : (h >= start || h < end);
}

/** Median of a numeric array (null on empty). */
export function median(values) {
  const a = values.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  const n = a.length;
  if (!n) return null;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

/**
 * Build the per-night, per-hour telemetry query for the night window.
 * Returns SQL + params: [lookbackDays, nightStartHour]. The night a row belongs
 * to is the calendar date of its 22:00 boundary, so hours 00..05 are attributed
 * to the PREVIOUS day's night (subtract one day when hour < nightStartHour).
 *
 * nightStartHour/nightEndHour are coerced to integers and inlined (safe -- not
 * user strings); everything else is parameterized.
 */
export function buildNightQuery(nightStartHour, nightEndHour) {
  const s = Number(nightStartHour) | 0;
  const e = Number(nightEndHour) | 0;
  const nightPred = s <= e
    ? `h >= ${s} AND h < ${e}`
    : `(h >= ${s} OR h < ${e})`;
  return `
    WITH n AS (
      SELECT
        (slot_start_utc AT TIME ZONE 'Europe/Berlin')::date AS local_date,
        EXTRACT(HOUR FROM slot_start_utc AT TIME ZONE 'Europe/Berlin')::int AS h,
        series_key,
        value_num * ${KWH15_TO_W} AS w
      FROM energy_slots_15m
      WHERE series_key IN ('load_power_w', 'grid_import_w')
        AND unit = 'kWh'
        AND source_kind IN ('vrm_import', 'local_live')
        AND slot_start_utc >= NOW() - ($1 || ' days')::interval
    )
    SELECT
      (CASE WHEN h >= $2 THEN local_date
            ELSE local_date - INTERVAL '1 day' END)::date AS night_date,
      h,
      series_key,
      AVG(w) AS avg_w,
      COUNT(*) AS n
    FROM n
    WHERE ${nightPred}
    GROUP BY 1, 2, 3
    ORDER BY 1, 2
  `;
}

/**
 * Fold the flat SQL rows into per-night aggregates.
 * @returns {Array<{date: string, loadMeanW: number|null, gridMeanW: number|null,
 *                  loadByHour: Map<number, number>}>} sorted oldest -> newest.
 */
export function aggregateNights(rows) {
  const byDate = new Map();
  for (const r of rows) {
    const date = String(r.night_date instanceof Date ? r.night_date.toISOString().slice(0, 10) : r.night_date).slice(0, 10);
    const h = Number(r.h);
    const w = Number(r.avg_w);
    const key = String(r.series_key);
    if (!byDate.has(date)) {
      byDate.set(date, { date, loadSum: 0, loadCount: 0, gridSum: 0, gridCount: 0, loadByHour: new Map() });
    }
    const night = byDate.get(date);
    if (!Number.isFinite(w)) continue;
    if (key === 'load_power_w') {
      night.loadSum += w; night.loadCount += 1;
      night.loadByHour.set(h, w);
    } else if (key === 'grid_import_w') {
      night.gridSum += w; night.gridCount += 1;
    }
  }
  return [...byDate.values()]
    .map((nt) => ({
      date: nt.date,
      loadMeanW: nt.loadCount ? nt.loadSum / nt.loadCount : null,
      gridMeanW: nt.gridCount ? nt.gridSum / nt.gridCount : null,
      loadByHour: nt.loadByHour,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Tracking signal: count TRAILING consecutive nights whose measured load is on
 * the same side of the base forecast by more than the margin. Symmetric.
 *
 * @param {Array<{loadMeanW: number|null}>} nights  oldest -> newest
 * @param {number} baseNightW  current base-forecast night mean (reference)
 * @param {number} marginW
 * @returns {{ direction: 'up'|'down'|'none', count: number }}
 *   direction 'up'   = measured persistently ABOVE forecast (under-forecast)
 *   direction 'down' = measured persistently BELOW forecast (over-forecast)
 */
export function computeConsecutiveBias(nights, baseNightW, marginW) {
  let dir = null;
  let count = 0;
  for (let i = nights.length - 1; i >= 0; i--) {
    const m = nights[i].loadMeanW;
    if (!Number.isFinite(m)) break;
    const diff = m - baseNightW;
    const nightDir = diff > marginW ? 'up' : diff < -marginW ? 'down' : null;
    if (!nightDir) break;
    if (dir === null) dir = nightDir;
    if (nightDir !== dir) break;
    count += 1;
  }
  return { direction: dir || 'none', count };
}

/**
 * Per-hour robust target: median of the measured load at each night hour over
 * the most recent `windowNights` nights. Returns Map<hour, watts>.
 */
export function medianByHour(nights, windowNights) {
  const recent = nights.slice(-windowNights);
  const buckets = new Map();
  for (const nt of recent) {
    for (const [h, w] of nt.loadByHour.entries()) {
      if (!buckets.has(h)) buckets.set(h, []);
      buckets.get(h).push(w);
    }
  }
  const out = new Map();
  for (const [h, arr] of buckets.entries()) {
    const med = median(arr);
    if (med !== null) out.set(h, med);
  }
  return out;
}

/** EWMA blend of one slot toward the measured target, clamped. */
export function blendSlot(baseW, measuredW, alpha, minW, maxW) {
  const blended = alpha * measuredW + (1 - alpha) * baseW;
  const clamped = Math.min(maxW, Math.max(minW, blended));
  return Math.round(clamped * 100) / 100;
}

const berlinHourFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Berlin', hour12: false, hour: '2-digit',
});
function getBerlinHour(date) {
  const raw = berlinHourFmt.formatToParts(date).find((p) => p.type === 'hour')?.value ?? '0';
  return Number(raw) % 24;
}

/**
 * Create the night-baseload corrector.
 * @param {object} ctx - { getCfg, pushLog, db } (db is read live via getDb).
 * @returns {{ applyNightCorrection: (slots: Array) => Promise<{applied: boolean, ...}> }}
 */
export function createLoadBiasCorrector(ctx) {
  const { getCfg, pushLog } = ctx;
  const getDb = () => ctx.db;

  /**
   * Apply the adaptive night correction to a load-forecast slot array IN PLACE.
   * Slots are { ts_utc, power_w, confidence }. Never throws -- on any error it
   * leaves the slots untouched and logs. Returns a summary for the caller/log.
   */
  async function applyNightCorrection(slots) {
    const cfg = getCfg();
    const c = selectNightConfig(cfg);
    if (!c.enabled) return { applied: false, reason: 'disabled' };
    if (!Array.isArray(slots) || slots.length === 0) {
      return { applied: false, reason: 'no_slots' };
    }
    const db = getDb();
    if (!db) return { applied: false, reason: 'no_db' };

    // Base night level = mean of the (pre-correction) forecast over night hours.
    const nightSlots = slots.filter((s) => {
      const ts = s?.ts_utc ? new Date(s.ts_utc) : null;
      if (!ts || Number.isNaN(ts.getTime())) return false;
      return isNightHour(getBerlinHour(ts), c.nightStartHour, c.nightEndHour);
    });
    if (nightSlots.length === 0) return { applied: false, reason: 'no_night_slots' };
    const baseNightW = nightSlots.reduce((a, s) => a + (Number(s.power_w) || 0), 0) / nightSlots.length;

    let nights;
    try {
      const sql = buildNightQuery(c.nightStartHour, c.nightEndHour);
      const res = await db.query(sql, [String(c.lookbackDays), c.nightStartHour]);
      nights = aggregateNights(res.rows || []);
    } catch (err) {
      if (pushLog) pushLog('load_forecast_night_correction_error', { error: err?.message ?? String(err) });
      return { applied: false, reason: 'query_error', error: err?.message };
    }

    if (nights.length === 0) {
      return { applied: false, reason: 'no_telemetry' };
    }

    const bias = computeConsecutiveBias(nights, baseNightW, c.marginW);
    const signalActive = bias.count >= c.consecutiveNights && bias.direction !== 'none';
    const alpha = signalActive ? c.alphaFast : c.alphaSlow;
    const targetByHour = medianByHour(nights, c.windowNights);

    // Corroborating symptom: trailing nights with night-grid-import over threshold.
    let gridImportNights = 0;
    for (let i = nights.length - 1; i >= 0; i--) {
      if (Number.isFinite(nights[i].gridMeanW) && nights[i].gridMeanW > c.minGridImportW) gridImportNights += 1;
      else break;
    }

    // Apply the EWMA blend to every night slot for which we have a measured target.
    let correctedCount = 0;
    let maxUpliftW = 0;
    let maxReductionW = 0;
    for (const s of slots) {
      const ts = s?.ts_utc ? new Date(s.ts_utc) : null;
      if (!ts || Number.isNaN(ts.getTime())) continue;
      const h = getBerlinHour(ts);
      if (!isNightHour(h, c.nightStartHour, c.nightEndHour)) continue;
      const measured = targetByHour.get(h);
      if (!Number.isFinite(measured)) continue;
      const baseW = Number(s.power_w) || 0;
      const newW = blendSlot(baseW, measured, alpha, c.minNightLoadW, c.maxNightLoadW);
      const delta = newW - baseW;
      if (delta > maxUpliftW) maxUpliftW = delta;
      if (delta < maxReductionW) maxReductionW = delta;
      s.power_w = newW;
      s.nightCorrected = true;
      correctedCount += 1;
    }

    const summary = {
      applied: correctedCount > 0,
      direction: bias.direction,
      consecutiveBiasNights: bias.count,
      signalActive,
      alpha,
      baseNightW: Math.round(baseNightW),
      gridImportNights,
      correctedSlots: correctedCount,
      maxUpliftW: Math.round(maxUpliftW),
      maxReductionW: Math.round(maxReductionW),
      nightsSeen: nights.length,
    };
    if (pushLog) pushLog('load_forecast_night_correction', summary);
    return summary;
  }

  return { applyNightCorrection };
}
