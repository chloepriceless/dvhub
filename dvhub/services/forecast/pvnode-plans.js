// services/forecast/pvnode-plans.js — native pvnode V2 plan tiers.
//
// pvnode runs ONE engine for every plan; plans differ only in:
//   - recompute frequency (how often the forecast is regenerated upstream)
//   - monthly call limit (cached forecast requests / month)
//   - forecast horizon (days)
//   - nowcasting + calibration availability
// Source: pvnode.com/pricing, verified 2026-06-25.
//
//   Plan        Recompute   Calls/month   Horizon   Nowcast  Calibration
//   Free        1 / day        250         48 h       –         –
//   Light       24 / day      3000          7 d       –         –
//   Plus        144 / day     3000          7 d       ✓ (10min) ✓
//   Enterprise  custom        custom        ≤1 yr     ✓         ✓
//
// fetchIntervalMs = how often DVhub may hit the pvnode API. It is chosen
// BUDGET-AWARE, not from the raw recompute frequency: the monthly call limit
// caps the sustainable rate. e.g. Plus recomputes every 10 min (144/day) but
// 3000 calls/mo ≈ 100/day ≈ every 14.4 min, so we floor at 15 min (96/day =
// 2880/mo < 3000). Free updates once/day, so a 12 h poll (≈60/mo « 250) always
// has the latest within half a day without wasting budget.

const MIN_FETCH_FLOOR_MS = 15 * 60 * 1000; // hard client floor — never poll faster

/** Plan presets. fetchIntervalMs is the DVhub poll cadence (budget-aware). */
export const PVNODE_PLANS = {
  free:       { label: 'Free',       fetchIntervalMs: 12 * 60 * 60 * 1000, monthlyQuota: 250,     maxForecastDays: 2, nowcast: false, calibration: false },
  light:      { label: 'Light',      fetchIntervalMs:      60 * 60 * 1000, monthlyQuota: 3000,    maxForecastDays: 7, nowcast: false, calibration: false },
  plus:       { label: 'Plus',       fetchIntervalMs:      15 * 60 * 1000, monthlyQuota: 3000,    maxForecastDays: 7, nowcast: true,  calibration: true  },
  enterprise: { label: 'Enterprise', fetchIntervalMs:      15 * 60 * 1000, monthlyQuota: 100000,  maxForecastDays: 7, nowcast: true,  calibration: true  },
};

export const DEFAULT_PVNODE_PLAN = 'free';

/**
 * Resolve the effective pvnode limits from config. The plan preset supplies the
 * defaults; explicit operator overrides (`forecast.pvnode.{fetchIntervalMs,
 * monthlyQuota}`) win — for Enterprise/custom tuning. fetchIntervalMs is always
 * floored at MIN_FETCH_FLOOR_MS so a misconfig can never hammer the API.
 *
 * @param {object} cfg - DVhub config (from getCfg())
 * @returns {{key:string,label:string,fetchIntervalMs:number,monthlyQuota:number,
 *            maxForecastDays:number,nowcast:boolean,calibration:boolean}}
 */
export function resolvePvnodePlan(cfg) {
  const raw = String(cfg?.forecast?.pvnode?.plan ?? DEFAULT_PVNODE_PLAN).toLowerCase();
  const key = PVNODE_PLANS[raw] ? raw : DEFAULT_PVNODE_PLAN;
  const plan = PVNODE_PLANS[key];
  const ov = cfg?.forecast?.pvnode || {};

  const ovInterval = Number(ov.fetchIntervalMs);
  const fetchIntervalMs = Math.max(
    MIN_FETCH_FLOOR_MS,
    Number.isFinite(ovInterval) && ovInterval > 0 ? ovInterval : plan.fetchIntervalMs
  );
  const ovQuota = Number(ov.monthlyQuota);
  const monthlyQuota = Number.isFinite(ovQuota) && ovQuota > 0 ? ovQuota : plan.monthlyQuota;

  return { key, ...plan, fetchIntervalMs, monthlyQuota };
}

export { MIN_FETCH_FLOOR_MS };
