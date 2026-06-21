// services/forecast/ensemble.js — Phase 07 MLAI-09 / D-A4.
//
// Inverse-MAE weighted ensemble merge. Replaces simple averaging decision from Phase 01-03
// (STATE.md: "mergePvForecasts uses simple averaging; sophisticated weighting deferred to
// accuracy tracking"). With the accuracy tracker persisting mae_7d_* per provider (Wave-0
// schema, Plan 07-04 activation), we can now weight providers by their rolling 7-day MAE:
// the provider with the smallest error gets the largest weight.
//
// Single-source invariant (D-C3): the mae7d argument MUST be sourced from accuracy_tracker
// to stay consistent with ml-correction's feature pipeline. Plan 07-04 will wire the DB read;
// for now `computeWeights(mae7d)` is a pure function taking the dict directly.
//
// Pure functions — no DI context, no side effects. Matches pv-forecast.js `mergePvForecasts`
// style (pure transform).

/**
 * Compute normalized inverse-MAE weights summing to 1.0.
 *
 * Providers with null, 0, negative, or non-finite MAE are excluded (treated as missing);
 * the remaining weights renormalize. If all providers are invalid, returns {} — caller should
 * fall back to uniform weights (uniform fallback is NOT applied here to keep this fn pure).
 *
 * @param {Record<string, number|null|undefined>} mae7d — e.g. { pvnode: 120, solcast: 200, pvlib: 180 }
 * @returns {Record<string, number>} weights — e.g. { pvnode: 0.45, solcast: 0.27, pvlib: 0.28 }
 */
export function computeWeights(mae7d) {
  if (!mae7d || typeof mae7d !== 'object') return {};
  const entries = Object.entries(mae7d).filter(([, v]) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0;
  });
  if (entries.length === 0) return {};
  const invSum = entries.reduce((s, [, v]) => s + 1 / Number(v), 0);
  if (!Number.isFinite(invSum) || invSum <= 0) return {};
  return Object.fromEntries(
    entries.map(([k, v]) => [k, (1 / Number(v)) / invSum])
  );
}

/**
 * Merge per-slot forecasts from multiple providers using weights.
 *
 * Input shape: providersBySlot[providerName] is an array of { ts_utc: string, power_w: number }.
 * Weights: weights[providerName] is the multiplier. Providers missing from weights OR with
 * weight 0 are skipped entirely (per Plan 07-02 spec).
 *
 * Output: merged array sorted by ts_utc ascending, each slot power_w = the weighted MEAN over
 * the providers actually present in THAT slot — Σ(power_w * weight) / Σ(weight_present) — rounded
 * to 1 decimal place (matching pvnode-client rounding). Phase 26-02: dividing by the effective
 * present-provider weight sum (not by a hardcoded 1.0) fixes systematic PV underestimation when
 * a provider has partial slot coverage (e.g. solcast 48h vs pvnode 72h). At full coverage with
 * Σw = 1.0 the renorm is the identity → result stays bit-identical to the legacy behaviour.
 *
 * Determinism: both accumulators are summed across ALL providers/slots FIRST, then divided once
 * per slot — never normalized incrementally — so provider/slot iteration order cannot change the
 * result. A slot whose effective weightSum is <= 0 or non-finite is dropped (no NaN/Inf escapes
 * into the battery control path).
 *
 * @param {Record<string, Array<{ts_utc:string, power_w:number}>>} providersBySlot
 * @param {Record<string, number>} weights
 * @returns {Array<{ts_utc:string, power_w:number}>}
 */
export function mergeForecasts(providersBySlot, weights) {
  const slotMap = new Map();
  const weightSum = new Map();
  const tsRepr = new Map();   // canonical instant -> first-seen original ts_utc string
  if (!providersBySlot || typeof providersBySlot !== 'object') return [];
  if (!weights || typeof weights !== 'object') return [];

  for (const [provider, slots] of Object.entries(providersBySlot)) {
    const w = Number(weights[provider]);
    if (!Number.isFinite(w) || w === 0) continue;
    if (!Array.isArray(slots)) continue;
    for (const s of slots) {
      if (!s || typeof s.ts_utc !== 'string') continue;
      const p = Number(s.power_w);
      if (!Number.isFinite(p)) continue;
      // Canonicalise the timestamp so providers that emit the SAME instant in
      // different string formats (e.g. '…T12:00:00.000Z' vs '…T12:00:00+00:00',
      // a real consequence of mixing 30/38/60-min providers) collapse to ONE
      // slot. Without this, mergedSlots carries two distinct ts_utc strings for
      // one instant → the combined `INSERT … ON CONFLICT (model, ts_utc)` batch
      // targets the same timestamptz twice → Postgres aborts the whole forecast
      // cycle with "ON CONFLICT DO UPDATE command cannot affect row a second
      // time", so `combined` was never persisted and the ensemble never went live.
      const d = new Date(s.ts_utc);
      if (Number.isNaN(d.getTime())) continue;
      const key = d.toISOString();
      if (!tsRepr.has(key)) tsRepr.set(key, s.ts_utc);
      const acc = slotMap.get(key) ?? 0;
      slotMap.set(key, acc + p * w);
      const wAcc = weightSum.get(key) ?? 0;
      weightSum.set(key, wAcc + w);
    }
  }

  const out = [];
  for (const [key, power_w] of slotMap.entries()) {
    const wSum = weightSum.get(key);
    // Guard: drop slots with no positive/finite effective weight (no NaN/Inf in control path).
    if (!Number.isFinite(wSum) || wSum <= 0) continue;
    out.push({ ts_utc: tsRepr.get(key), power_w: Math.round((power_w / wSum) * 10) / 10 });
  }
  return out.sort((a, b) => a.ts_utc.localeCompare(b.ts_utc));
}
