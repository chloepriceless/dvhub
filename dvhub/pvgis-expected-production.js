// pvgis-expected-production.js — WS3 (2026-05-30)
//
// Computes the EXPECTED PV production (Soll-Ertrag) per calendar month for the
// operator's real array geometry, using the EU JRC PVGIS PVcalc API. This
// replaces the crude `pvPotentialKwhAnnual × static-monthly-distribution` model
// in history-runtime.computeExpectedPvKwh, so the curtailment KPI card
// (curtailedPvKwh = expected − actual) reflects the actual orientations —
// including the yield penalty of the 9 kWp north-facing string.
//
// One PVcalc call per plane (cheap, stable for a fixed system) → summed monthly
// profile, cached to reference-data/pvgis-expected-production.json keyed by an
// inputs hash so it only refetches when the geometry/location changes.
//
// NEVER throws — every failure path returns null so the caller falls back to
// the legacy estimate.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PVGIS_BASE = 'https://re.jrc.ec.europa.eu/api/v5_2/PVcalc';
const DEFAULT_LOSS_PCT = 14;
const FETCH_TIMEOUT_MS = 20000;

/**
 * DVhub azimuth convention is 0=N, 90=E, 180=S, 270=W. PVGIS "aspect" is
 * 0=S, -90=E, 90=W, ±180=N. Convert and normalise to [-180, 180].
 * @param {number} azimuthDeg
 * @returns {number}
 */
export function azimuthDegToPvgisAspect(azimuthDeg) {
  let aspect = Number(azimuthDeg) - 180;
  if (aspect > 180) aspect -= 360;
  if (aspect < -180) aspect += 360;
  return aspect;
}

/**
 * Stable hash of the inputs so the cache invalidates when geometry/location
 * changes but is reused otherwise.
 */
export function pvgisInputsHash({ lat, lon, planes, lossPct }) {
  const norm = {
    lat: Number(lat).toFixed(4),
    lon: Number(lon).toFixed(4),
    lossPct: Number(lossPct),
    planes: (planes || [])
      .map((p) => ({
        kwp: Number(p.kwp),
        tiltDeg: Number(p.tiltDeg),
        azimuthDeg: Number(p.azimuthDeg),
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
  return crypto.createHash('sha256').update(JSON.stringify(norm)).digest('hex').slice(0, 16);
}

/**
 * Which plane entries carry enough geometry (kwp + tiltDeg + azimuthDeg) for a
 * PVGIS lookup. Works on any array of {kwp,tiltDeg,azimuthDeg,...} — forecast.pv
 * .strings AND userEnergyPricing.pvPlants share these field names.
 */
export function planesWithGeometry(planes) {
  return (Array.isArray(planes) ? planes : []).filter(
    (p) =>
      p &&
      Number.isFinite(Number(p.kwp)) &&
      Number(p.kwp) > 0 &&
      Number.isFinite(Number(p.tiltDeg)) &&
      Number.isFinite(Number(p.azimuthDeg)),
  );
}

/**
 * Universal geometry source: every DVhub user configures their string layout
 * (label/kWp/tiltDeg/azimuthDeg per Dachfläche) in `forecast.pv.strings` via the
 * Settings UI. Prefer that; fall back to userEnergyPricing.pvPlants geometry if
 * a user only filled in the market-premium plants. Returns the geometried
 * planes (possibly []), so changing an orientation in the settings changes the
 * computed expected production for that user.
 */
export function resolvePlanesFromConfig(cfg) {
  const strings = cfg?.forecast?.pv?.strings;
  const fromStrings = planesWithGeometry(strings);
  if (fromStrings.length > 0) return fromStrings;
  return planesWithGeometry(cfg?.userEnergyPricing?.pvPlants);
}

/**
 * Fetch the monthly expected production [kWh] for ONE plane. Returns a 12-entry
 * array (Jan..Dec) or null on any failure.
 */
async function fetchPlaneMonthly({ lat, lon, kwp, tiltDeg, azimuthDeg, lossPct, fetchImpl }) {
  const aspect = azimuthDegToPvgisAspect(azimuthDeg);
  const url =
    `${PVGIS_BASE}?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}` +
    `&peakpower=${encodeURIComponent(kwp)}&loss=${encodeURIComponent(lossPct)}` +
    `&angle=${encodeURIComponent(tiltDeg)}&aspect=${encodeURIComponent(aspect)}` +
    `&outputformat=json`;
  const doFetch = fetchImpl || globalThis.fetch;
  if (!doFetch) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await doFetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const monthlyArr = data?.outputs?.monthly?.fixed;
    if (!Array.isArray(monthlyArr) || monthlyArr.length !== 12) return null;
    // PVGIS months are 1..12; sort defensively and map E_m.
    const byMonth = new Array(12).fill(0);
    for (const m of monthlyArr) {
      const idx = Number(m?.month) - 1;
      const e = Number(m?.E_m);
      if (idx >= 0 && idx < 12 && Number.isFinite(e)) byMonth[idx] = e;
    }
    return byMonth;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compute the summed monthly expected production for all geometried planes.
 * Returns { monthly:[12], annualKwh, perPlane, inputsHash, fetchedAt } or null.
 */
export async function computePvgisMonthlyProduction({ lat, lon, planes, lossPct = DEFAULT_LOSS_PCT, fetchImpl } = {}) {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return null;
  const geo = planesWithGeometry(planes);
  if (geo.length === 0) return null;

  const monthly = new Array(12).fill(0);
  const perPlane = [];
  for (const p of geo) {
    const pm = await fetchPlaneMonthly({
      lat,
      lon,
      kwp: Number(p.kwp),
      tiltDeg: Number(p.tiltDeg),
      azimuthDeg: Number(p.azimuthDeg),
      lossPct,
      fetchImpl,
    });
    if (!pm) return null; // partial result would skew the curtailment KPI — bail to fallback
    for (let i = 0; i < 12; i += 1) monthly[i] += pm[i];
    perPlane.push({
      kwp: Number(p.kwp),
      tiltDeg: Number(p.tiltDeg),
      azimuthDeg: Number(p.azimuthDeg),
      annualKwh: Number(pm.reduce((a, b) => a + b, 0).toFixed(1)),
    });
  }
  const annualKwh = Number(monthly.reduce((a, b) => a + b, 0).toFixed(1));
  return {
    monthly: monthly.map((v) => Number(v.toFixed(2))),
    annualKwh,
    perPlane,
    lat: Number(lat),
    lon: Number(lon),
    lossPct: Number(lossPct),
    inputsHash: pvgisInputsHash({ lat, lon, planes: geo, lossPct }),
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Read the cached monthly profile. Synchronous — safe in the KPI hot path. The
 * service (createPvgisExpectedProductionService) is the single owner that keeps
 * this cache consistent with the current config (boot + on every config save),
 * so the consumer just trusts it. Optionally pass `planes` to additionally
 * require the cached geometry hash to match the current planes (used by the
 * service's own skip-if-fresh check). Returns monthly[12] or null.
 */
export function readCachedPvgisMonthly({ cachePath, planes } = {}) {
  try {
    if (!cachePath || !fs.existsSync(cachePath)) return null;
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (!Array.isArray(cached?.monthly) || cached.monthly.length !== 12) return null;
    if (planes !== undefined) {
      const geo = planesWithGeometry(planes);
      if (geo.length === 0) return null;
      const wantHash = pvgisInputsHash({
        lat: cached.lat,
        lon: cached.lon,
        planes: geo,
        lossPct: cached.lossPct ?? DEFAULT_LOSS_PCT,
      });
      if (cached?.inputsHash !== wantHash) return null;
    }
    return cached.monthly;
  } catch {
    return null;
  }
}

/**
 * Service: refresh() computes + writes the cache (skips the network if the
 * cached hash already matches). Mirrors the BNetzA applicable-value service.
 */
export function createPvgisExpectedProductionService({ cachePath, getCfg, fetchImpl } = {}) {
  function resolveInputs() {
    const cfg = getCfg ? getCfg() : {};
    const loc = cfg?.forecast?.location || {};
    const lat = Number(loc.latitude);
    const lon = Number(loc.longitude);
    const planes = resolvePlanesFromConfig(cfg);
    return { lat, lon, planes };
  }

  async function refresh() {
    const { lat, lon, planes } = resolveInputs();
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || planes.length === 0) {
      return { ok: false, skipped: 'no location or no geometried pvPlants' };
    }
    // Skip the network if the cache already matches the current geometry.
    const fresh = readCachedPvgisMonthly({ cachePath, planes });
    if (fresh) return { ok: true, cached: true };
    const result = await computePvgisMonthlyProduction({ lat, lon, planes, fetchImpl });
    if (!result) return { ok: false, error: 'pvgis fetch failed' };
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify(result, null, 2));
      return { ok: true, cached: false, annualKwh: result.annualKwh };
    } catch (e) {
      return { ok: false, error: `cache write failed: ${e.message}` };
    }
  }

  return { refresh, resolveInputs };
}
