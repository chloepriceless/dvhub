// services/curtailment/index.js -- T-CURTAIL Increment 2b orchestrator.
// Wires the pure calibration engine to live prod data:
//   - GHI per slot         <- weather_observed (hourly; a 15-min slot uses its
//                             containing UTC hour; loxone_measured preferred)
//   - PV actual per slot   <- energy_slots_15m series_key='pv_total_w' (kWh/slot)
//   - spot price per slot  <- timeseries_samples series_key='price_ct_kwh' (15-min)
// CLEAN day = a local (Berlin) day with NO negative-price slot (= unthrottled) ->
// calibration reference. CURTAILED slot = negative-price slot -> curtailed =
// max(0, wouldHave - actual). Calibration slopes persist in pv_calibration.
//
// Deterministic: pure functions below + closed-form solar position + zero-random
// fit => same data yields the same numbers. See T-CURTAIL-IRRADIANCE-DESIGN.md.

import crypto from 'node:crypto';
import { solarElevationDeg, elevationBand } from './solar-position.js';
import { calibrate, estimateWouldHaveW, binKeyFor } from './calibration.js';

const SLOT_MS = 15 * 60 * 1000;
const ARRAY_ID = 'total'; // single aggregated array (prod has one plant)

// --- pure helpers (exported for testing) ---

/** Epoch ms truncated to the start of its UTC hour. */
export function hourKey(tsMs) {
  return Math.floor(tsMs / 3600000) * 3600000;
}

/** Start of the 15-min slot (ms) — for sub-hourly measured-GHI matching. */
export function slotKey(tsMs) {
  return Math.floor(tsMs / 900000) * 900000;
}

/** Local (Europe/Berlin) calendar date 'YYYY-MM-DD' for an instant. Deterministic. */
export function berlinDate(tsMs) {
  return new Date(tsMs).toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
}

/**
 * GHI/temperature per UTC hour from weather_observed rows, preferring measured
 * sources over reanalysis when both cover the same hour.
 * @param {Array<{ts_utc,ghi_wm2,temperature_c,source}>} rows
 * @returns {Map<number,{ghi:number|null,temp:number|null,source:string}>}
 */
// Source-priority for GHI ranking, driven by forecast.ghiPrimarySource.
//   'measured' (default): local station > ERA5 archive > forecast.
//   'archive'           : ERA5 archive > local station > forecast.
// The forecast (source 'forecast:*') is always the last-resort gap-filler.
export function rankFor(primary) {
  if (primary === 'archive') {
    return (s) => (s === 'open_meteo_archive' ? 0 : s === 'loxone_measured' ? 1 : 2);
  }
  return (s) => (s === 'loxone_measured' ? 0 : s === 'open_meteo_archive' ? 1 : 2);
}

export function buildGhiByHour(rows, { primary = 'measured' } = {}) {
  const rank = rankFor(primary);
  const map = new Map();
  for (const r of rows) {
    const k = hourKey(new Date(r.ts_utc).getTime());
    const prev = map.get(k);
    if (!prev || rank(r.source) < rank(prev.source)) {
      map.set(k, { ghi: r.ghi_wm2 == null ? null : Number(r.ghi_wm2), temp: r.temperature_c == null ? null : Number(r.temperature_c), source: r.source });
    }
  }
  return map;
}

/**
 * Slot-aware GHI index. `byHour` is the hourly ranking above (all sources);
 * `bySlot` holds ONLY sub-hourly MEASURED GHI (source 'loxone_measured',
 * stamped at 15-min slots by the mqtt-weather tee — T-CURTAIL 1b) keyed by
 * 15-min slot. resolveGhi() prefers a per-slot measurement, falling back to the
 * hour — so when a fine measured source exists, each 15-min PV slot is paired
 * with its OWN irradiance instead of four quarters sharing one hourly value.
 * Archive/forecast (hourly) only ever populate byHour.
 * @param {Array<{ts_utc,ghi_wm2,temperature_c,source,resolution_seconds?}>} rows
 * @returns {{byHour: Map, bySlot: Map}}
 */
export function buildGhiIndex(rows, { primary = 'measured' } = {}) {
  const bySlot = new Map();
  const hourlyRows = [];
  // When the operator prefers the ERA5 archive, the local 15-min station is
  // demoted to a fallback — so its fine measurements do NOT pre-empt the hourly
  // archive at slot level (bySlot stays empty for loxone_measured).
  const useFineMeasured = primary !== 'archive';
  for (const r of rows) {
    const res = r.resolution_seconds == null ? null : Number(r.resolution_seconds);
    const isFineMeasured = useFineMeasured && r.source === 'loxone_measured' && (res == null || res < 3600);
    if (isFineMeasured) {
      const k = slotKey(new Date(r.ts_utc).getTime());
      if (!bySlot.has(k)) {
        bySlot.set(k, {
          ghi: r.ghi_wm2 == null ? null : Number(r.ghi_wm2),
          temp: r.temperature_c == null ? null : Number(r.temperature_c),
          source: r.source,
        });
      }
    } else {
      // archive / forecast / hourly-measured (and ALL rows when primary=archive)
      // -> the hourly fallback bucket, ranked per the operator's preference.
      hourlyRows.push(r);
    }
  }
  return { byHour: buildGhiByHour(hourlyRows, { primary }), bySlot };
}

/**
 * Resolve GHI for a slot instant. Accepts EITHER a slot-aware index
 * ({byHour, bySlot}) — prefers a per-15-min measurement, else the hour — OR a
 * plain hourly Map (back-compat with callers/tests passing buildGhiByHour's
 * result directly).
 */
export function resolveGhi(g, ts) {
  if (!g) return undefined;
  if (g.byHour instanceof Map) {
    const fine = g.bySlot && g.bySlot.get(slotKey(ts));
    if (fine && fine.ghi != null) return fine;
    return g.byHour.get(hourKey(ts));
  }
  if (typeof g.get === 'function') return g.get(hourKey(ts));  // plain hourly Map
  return undefined;
}

/** Set of Berlin dates that contain at least one negative-price slot. */
export function buildDirtyDays(priceRows) {
  const dirty = new Set();
  for (const r of priceRows) {
    if (Number(r.value_num) < 0) dirty.add(berlinDate(new Date(r.ts_utc).getTime()));
  }
  return dirty;
}

/** ts(ms) -> actual PV kWh for the slot, dedup preferring local_live. */
export function buildActualByTs(pvRows) {
  const map = new Map();
  for (const r of pvRows) {
    const ts = new Date(r.slot_start_utc).getTime();
    if (!map.has(ts)) map.set(ts, Number(r.value_num)); // rows arrive local_live-first
  }
  return map;
}

/**
 * Build clean-day calibration samples (one per PV slot on a clean day that has
 * GHI). Pure given the resolved inputs.
 */
export function buildSamples({ actualByTs, ghiByHour, dirtyDays, kWp, lat, lon }) {
  const samples = [];
  for (const [ts, actualKwh] of actualByTs) {
    if (dirtyDays.has(berlinDate(ts))) continue;           // skip throttled days
    const g = resolveGhi(ghiByHour, ts);
    if (!g || g.ghi == null) continue;
    const elev = solarElevationDeg(lat, lon, new Date(ts));
    const band = elevationBand(elev);
    if (band < 0) continue;                                 // night
    samples.push({
      ts,
      arrayId: ARRAY_ID,
      ghi: g.ghi,
      actualW: actualKwh * 4000,                            // kWh/15min -> avg W
      kWp,
      ambientC: g.temp,
      month: new Date(ts).getUTCMonth() + 1,
      elevBand: band,
    });
  }
  return samples;
}

/** Deterministic hash of the calibration inputs (for refit-skip + audit). */
export function calibrationInputsHash({ kWp, samples }) {
  let sx = 0, sy = 0;
  for (const s of samples) { sx += s.ghi; sy += s.actualW; }
  const canon = JSON.stringify({ kWp, n: samples.length, sx: Math.round(sx), sy: Math.round(sy) });
  return crypto.createHash('sha1').update(canon).digest('hex').slice(0, 16);
}

/**
 * Compute calibrated curtailment over the negative-price slots in range.
 * Fallback ladder per slot: trusted (month,band) slope -> array-global trusted
 * slope -> skipped (counted). Pure given resolved inputs.
 * @returns {{curtailedKwh, expectedKwh, negSlots, computedSlots, fallbackSlots, skippedSlots}}
 */
export function computeCurtailment({ priceRows, actualByTs, ghiByHour, bins, pAcRated, kWp, lat, lon }) {
  // array-global fallback slope = sample-weighted mean of trusted bin slopes.
  let wsum = 0, nsum = 0;
  for (const b of bins.values()) {
    if (b.trusted && Number.isFinite(b.slope)) { wsum += b.slope * b.n; nsum += b.n; }
  }
  const globalSlope = nsum > 0 ? wsum / nsum : null;

  let curtailedKwh = 0, expectedKwh = 0;
  let negSlots = 0, computedSlots = 0, fallbackSlots = 0, skippedSlots = 0;

  for (const r of priceRows) {
    if (!(Number(r.value_num) < 0)) continue;               // only curtailed (neg-price) slots
    negSlots++;
    const ts = new Date(r.ts_utc).getTime();
    const g = resolveGhi(ghiByHour, ts);
    if (!g || g.ghi == null) { skippedSlots++; continue; }
    const elev = solarElevationDeg(lat, lon, new Date(ts));
    const band = elevationBand(elev);
    if (band < 0) { skippedSlots++; continue; }             // night -> no PV anyway
    const month = new Date(ts).getUTCMonth() + 1;
    const bin = bins.get(binKeyFor(ARRAY_ID, month, band));
    let slope = (bin && bin.trusted) ? bin.slope : null;
    if (slope == null) { slope = globalSlope; if (slope != null) fallbackSlots++; }
    else computedSlots++;
    if (slope == null) { skippedSlots++; continue; }

    const wouldHaveW = estimateWouldHaveW({ ghi: g.ghi, slope, kWp, ambientC: g.temp, pAcRated });
    if (wouldHaveW == null) { skippedSlots++; continue; }
    const wouldHaveKwh = wouldHaveW / 4000;                  // avg W -> kWh/15min
    const actualKwh = actualByTs.get(ts) ?? 0;
    expectedKwh += wouldHaveKwh;
    curtailedKwh += Math.max(0, wouldHaveKwh - actualKwh);
  }
  return {
    curtailedKwh: Math.round(curtailedKwh * 100) / 100,
    expectedKwh: Math.round(expectedKwh * 100) / 100,
    negSlots, computedSlots, fallbackSlots, skippedSlots,
  };
}

// --- orchestrator (DB-bound) ---

function isoTs(d) { return new Date(d).toISOString(); }

export function createCurtailmentService(ctx, { store }) {
  const { getCfg, pushLog } = ctx;

  function resolveInputs() {
    const cfg = getCfg();
    const plants = cfg.userEnergyPricing?.pvPlants;
    const kWp = Number(cfg.userEnergyPricing?.totalKwp)
      || (Array.isArray(plants) ? plants.reduce((s, p) => s + (Number(p.kwp) || 0), 0) : 0);
    let lat = cfg.forecast?.location?.latitude ?? cfg.schedule?.smallMarketAutomation?.location?.latitude;
    let lon = cfg.forecast?.location?.longitude ?? cfg.schedule?.smallMarketAutomation?.location?.longitude;
    return { kWp, lat, lon };
  }

  // includeForecast: merge weather_forecasts GHI as a low-priority fallback.
  // ONLY for the APPLY path (computeForRange) — NOT for calibration, because
  // weather_forecasts mutates (ON CONFLICT UPDATE per fetch) + is pruned, which
  // would make the fitted slopes non-deterministic. The fit stays on the
  // immutable observed/archive GHI only.
  async function readWindow(fromIso, toIso, { includeForecast = false } = {}) {
    const queries = [
      store.query(
        `SELECT slot_start_utc, value_num FROM energy_slots_15m
           WHERE series_key='pv_total_w' AND source_kind IN ('local_live','vrm_import')
             AND slot_start_utc >= $1 AND slot_start_utc < $2
           ORDER BY slot_start_utc ASC, source_kind ASC`, [fromIso, toIso]),
      store.query(
        `SELECT ts_utc, value_num FROM timeseries_samples
           WHERE series_key='price_ct_kwh' AND value_num IS NOT NULL
             AND ts_utc >= $1 AND ts_utc < $2 ORDER BY ts_utc ASC`, [fromIso, toIso]),
      store.query(
        `SELECT ts_utc, ghi_wm2, temperature_c, source, resolution_seconds FROM weather_observed
           WHERE ts_utc >= $1 AND ts_utc < $2 ORDER BY ts_utc ASC`, [fromIso, toIso]),
    ];
    // GHI fallback (T-CURTAIL §10): recent days the ERA5 archive hasn't reached
    // get the Open-Meteo forecast GHI so neg-price slots aren't skipped (which
    // would drop the KPI to the weather-blind PVGIS estimate). Ranked below
    // measured/archive in buildGhiByHour -> only fills gaps.
    if (includeForecast) {
      queries.push(store.query(
        `SELECT ts_utc, ghi_wm2, temperature_c, provider FROM weather_forecasts
           WHERE ghi_wm2 IS NOT NULL AND ts_utc >= $1 AND ts_utc < $2 ORDER BY ts_utc ASC`, [fromIso, toIso]));
    }
    const res = await Promise.all(queries);
    const [pv, price, ghi] = res;
    let ghiRows = ghi.rows;
    if (includeForecast && res[3]) {
      ghiRows = ghiRows.concat(res[3].rows.map((r) => ({
        ts_utc: r.ts_utc, ghi_wm2: r.ghi_wm2, temperature_c: r.temperature_c,
        source: `forecast:${r.provider || 'open_meteo'}`,
      })));
    }
    return { pvRows: pv.rows, priceRows: price.rows, ghiRows };
  }

  /**
   * Recalibrate over [calFrom, calTo] and persist bins. Returns a summary.
   */
  async function recalibrate({ calFrom, calTo }) {
    const { kWp, lat, lon } = resolveInputs();
    if (!kWp || lat == null || lon == null) return { ok: false, error: 'missing_kwp_or_location' };
    const { pvRows, priceRows, ghiRows } = await readWindow(isoTs(calFrom), isoTs(calTo));
    const primary = getCfg()?.forecast?.ghiPrimarySource || 'measured';
    const ghiByHour = buildGhiIndex(ghiRows, { primary });
    const dirtyDays = buildDirtyDays(priceRows);
    const actualByTs = buildActualByTs(pvRows);
    const samples = buildSamples({ actualByTs, ghiByHour, dirtyDays, kWp, lat, lon });
    const { bins, pAcRatedByArray } = calibrate(samples);
    const inputsHash = calibrationInputsHash({ kWp, samples });
    const fromStr = isoTs(calFrom).slice(0, 10);
    const toStr = isoTs(calTo).slice(0, 10);
    const rows = [];
    for (const b of bins.values()) {
      rows.push({
        array_id: b.arrayId, month: b.month, elev_band: b.elevBand,
        slope: b.slope, sample_count: b.n, trusted: b.trusted, p_ac_rated: b.pAcRated,
        inputs_hash: inputsHash, computed_from: fromStr, computed_to: toStr,
      });
    }
    if (rows.length) await store.upsertCalibrationBins(rows);
    const trusted = rows.filter(r => r.trusted).length;
    pushLog('curtail_recalibrate', { bins: rows.length, trusted, samples: samples.length, dirtyDays: dirtyDays.size, kWp });
    return {
      ok: true, kWp, lat, lon, inputsHash,
      sampleCount: samples.length, dirtyDayCount: dirtyDays.size,
      binCount: rows.length, trustedBins: trusted,
      pAcRated: pAcRatedByArray.get(ARRAY_ID) ?? null,
    };
  }

  /** Compute calibrated curtailment for [from, to] using persisted bins. */
  async function computeForRange({ from, to }) {
    const { kWp, lat, lon } = resolveInputs();
    if (!kWp || lat == null || lon == null) return { ok: false, error: 'missing_kwp_or_location' };
    const { pvRows, priceRows, ghiRows } = await readWindow(isoTs(from), isoTs(to), { includeForecast: true });
    const primary = getCfg()?.forecast?.ghiPrimarySource || 'measured';
    const ghiByHour = buildGhiIndex(ghiRows, { primary });
    const actualByTs = buildActualByTs(pvRows);
    const binRows = await store.getCalibrationBins(ARRAY_ID);
    const bins = new Map();
    let pAcRated = null;
    for (const r of binRows) {
      bins.set(binKeyFor(ARRAY_ID, r.month, r.elev_band), { arrayId: ARRAY_ID, month: r.month, elevBand: r.elev_band, slope: r.slope == null ? null : Number(r.slope), n: r.sample_count, trusted: r.trusted });
      if (r.p_ac_rated != null) pAcRated = Number(r.p_ac_rated);
    }
    const result = computeCurtailment({ priceRows, actualByTs, ghiByHour, bins, pAcRated, kWp, lat, lon });
    return { ok: true, from: isoTs(from), to: isoTs(to), kWp, ...result };
  }

  return { recalibrate, computeForRange, readWindow, resolveInputs };
}
