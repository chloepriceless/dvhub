// open-meteo-archive.js -- historical OBSERVED GHI backfill from the Open-Meteo
// Archive API (ERA5 reanalysis). Universal: works for ANY location and any past
// date, no account/key required. Writes the immutable weather_observed store,
// which the irradiance-calibrated curtailment estimator reads.
// See .planning/T-CURTAIL-IRRADIANCE-DESIGN.md §3a / §10.
//
// Resolution: the archive is reliably HOURLY (shortwave_radiation = GHI W/m²,
// hour-average). Downstream calibration aligns hourly GHI onto the 15-min slots
// deterministically. timeformat=unixtime gives unambiguous UTC timestamps.

const ARCHIVE_BASE = 'https://archive-api.open-meteo.com/v1/archive';
export const ARCHIVE_SOURCE = 'open_meteo_archive';
const CHUNK_DAYS = 92;             // keep each request response modest
const RESOLUTION_SECONDS = 3600;  // archive hourly

/**
 * Build the Open-Meteo Archive URL for an inclusive [startDate, endDate] window
 * (YYYY-MM-DD, UTC). Requests hourly GHI + temperature as unix timestamps.
 */
export function buildArchiveUrl({ lat, lon, startDate, endDate }) {
  const p = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    start_date: startDate,
    end_date: endDate,
    hourly: 'shortwave_radiation,temperature_2m',
    timeformat: 'unixtime',
  });
  return `${ARCHIVE_BASE}?${p.toString()}`;
}

/**
 * Parse an Open-Meteo Archive response into weather_observed rows.
 * Pure + deterministic (no Date.now). Skips entries with a non-finite ts.
 * @returns {Array<{source,ts_utc,ghi_wm2,temperature_c,resolution_seconds}>}
 */
export function parseArchiveResponse(data) {
  const h = data?.hourly;
  if (!h || !Array.isArray(h.time)) return [];
  const rows = [];
  for (let i = 0; i < h.time.length; i++) {
    const sec = h.time[i];
    if (!Number.isFinite(sec)) continue;
    const ghi = h.shortwave_radiation?.[i];
    const temp = h.temperature_2m?.[i];
    rows.push({
      source: ARCHIVE_SOURCE,
      ts_utc: new Date(sec * 1000).toISOString(),
      ghi_wm2: Number.isFinite(ghi) ? ghi : null,
      temperature_c: Number.isFinite(temp) ? temp : null,
      resolution_seconds: RESOLUTION_SECONDS,
    });
  }
  return rows;
}

// --- deterministic UTC date helpers (pure) ---

export function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

/** Add `days` to a YYYY-MM-DD string, return YYYY-MM-DD (UTC). */
export function addDaysUtc(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

/**
 * Split an inclusive [startDate, endDate] window into <= chunkDays sub-windows.
 * Returns [] when startDate > endDate. Pure + deterministic.
 */
export function chunkDateRange(startDate, endDate, chunkDays = CHUNK_DAYS) {
  const chunks = [];
  if (!startDate || !endDate || startDate > endDate) return chunks;
  let s = startDate;
  while (s <= endDate) {
    let e = addDaysUtc(s, chunkDays - 1);
    if (e > endDate) e = endDate;
    chunks.push({ startDate: s, endDate: e });
    s = addDaysUtc(e, 1);
  }
  return chunks;
}

/**
 * Given the existing per-source coverage and a desired [startDate, endDate]
 * window, return the missing sub-windows to fetch (head + tail gaps only). Pure.
 * @param {{min_ts?, max_ts?}|null} coverage - row from getObservedGhiCoverage() for ARCHIVE_SOURCE
 */
export function computeBackfillWindows(coverage, startDate, endDate) {
  if (!startDate || !endDate || startDate > endDate) return [];
  if (!coverage || !coverage.min_ts || !coverage.max_ts) {
    return [{ startDate, endDate }];
  }
  const minObs = new Date(coverage.min_ts).toISOString().slice(0, 10);
  const maxObs = new Date(coverage.max_ts).toISOString().slice(0, 10);
  const windows = [];
  if (startDate < minObs) windows.push({ startDate, endDate: addDaysUtc(minObs, -1) });
  if (maxObs < endDate) windows.push({ startDate: addDaysUtc(maxObs, 1), endDate });
  return windows;
}

/** Fetch + parse a single archive chunk. */
export async function fetchArchiveChunk({ lat, lon, startDate, endDate }, fetchImpl = fetch) {
  const url = buildArchiveUrl({ lat, lon, startDate, endDate });
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Open-Meteo Archive HTTP ${res.status}`);
  return parseArchiveResponse(await res.json());
}

/**
 * Fill weather_observed for an inclusive [startDate, endDate] (UTC) window by
 * chunked archive fetches + idempotent batch upserts. A failed chunk is logged
 * and skipped (the next opportunistic run retries the still-missing window).
 * @returns {Promise<{written:number,chunks:number,failed:number,from:string,to:string}>}
 */
export async function backfillObservedGhi(ctx, { store, lat, lon, startDate, endDate, fetchImpl = fetch }) {
  const pushLog = ctx?.pushLog;
  const chunks = chunkDateRange(startDate, endDate);
  let written = 0;
  let failed = 0;
  for (const c of chunks) {
    try {
      const rows = await fetchArchiveChunk({ lat, lon, startDate: c.startDate, endDate: c.endDate }, fetchImpl);
      if (rows.length) {
        const r = await store.insertObservedWeatherBatch(rows);
        written += r.written || 0;
      }
      pushLog?.('ghi_backfill_chunk', { from: c.startDate, to: c.endDate, rows: rows.length });
    } catch (e) {
      failed++;
      pushLog?.('ghi_backfill_chunk_error', { from: c.startDate, to: c.endDate, error: e?.message ?? String(e) });
    }
  }
  return { written, chunks: chunks.length, failed, from: startDate, to: endDate };
}
