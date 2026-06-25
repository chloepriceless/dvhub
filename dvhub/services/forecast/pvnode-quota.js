// services/forecast/pvnode-quota.js — Phase 07 D-A5 (re-scoped) + REVIEWS L2.
//
// SINGLE QUOTA AUTHORITY for pvnode client-side counter.
//
// Why client-side: pvnode emits NO rate-limit headers (empirical 2026-04-16 scan of
// openapi.json; confirmed via probe-pvnode-headers.js scaffolding). We track usage in the
// pvnode_quota DB table (Wave-0 schema) and centralize all warning/critical/exhausted
// thresholds here. pvnode-client.js calls `pvnodeQuota.increment(1)` after each 2xx —
// never `store.incrementPvnodeQuota` directly. Single entry point = consistent threshold
// logging and future-proof wiring for the /api/forecast/pvnode/quota admin endpoint.
//
// Thresholds (fire in `increment`):
//   - >= 80 % used → pushLog('pvnode_quota_warning')
//   - >= 95 % used → pushLog('pvnode_quota_critical') — Plan 07-03 backfill reads this
//                    via isLowBudget() to suspend early
// Exhaustion (fire in `markExhausted`, invoked on HTTP 429 from client):
//   - in-memory timestamp flag set for `retryAfterSeconds` seconds (default 1h)
//   - `isExhausted()` becomes true; pvnode-client.js checks it BEFORE network calls
//
// Design notes:
// - getCfg() re-read every call (never cached at module scope — QUAL-05)
// - Exhausted flag is in-memory only (Retry-After is inherently transient; DB write would
//   be racy across restarts and the flag is self-healing after the timer expires)
// - Defaults: monthly limit comes from the selected pvnode plan (pvnode-plans.js):
//   Free 250, Light/Plus 3000, Enterprise high. An explicit
//   forecast.pvnode.monthlyQuota override still wins.

import { resolvePvnodePlan } from './pvnode-plans.js';

/**
 * Create the pvnode client-side monthly quota tracker.
 *
 * @param {object} ctx - DI context { getCfg, pushLog }
 * @param {object} deps - { store } — forecast-store with incrementPvnodeQuota/getPvnodeQuotaUsed
 * @returns {{
 *   increment: (n?:number) => Promise<void>,
 *   getUsed:   () => Promise<{used:number, limit:number, remaining:number, month_utc:string}>,
 *   isExhausted: () => boolean,
 *   markExhausted: (retryAfterSeconds?:number) => void,
 *   isLowBudget: (threshold?:number) => Promise<boolean>
 * }}
 */
export function createPvnodeQuota(ctx, { store }) {
  const { getCfg, pushLog } = ctx;

  // In-memory exhaustion flag. Timestamp in ms since epoch; isExhausted() compares against Date.now().
  let quotaExhaustedUntil = 0;

  /**
   * Read the effective monthly call limit from the selected pvnode plan
   * (Free 250, Light/Plus 3000, Enterprise high) — an explicit
   * `forecast.pvnode.monthlyQuota` override still wins (resolved in
   * resolvePvnodePlan). Always read via getCfg() — never cached (QUAL-05).
   */
  function getLimit() {
    return resolvePvnodePlan(getCfg()).monthlyQuota;
  }

  /**
   * Current UTC month key as YYYY-MM-01 (matches Wave-0 schema pvnode_quota.month_utc).
   */
  function currentMonthKey() {
    return new Date().toISOString().slice(0, 7) + '-01';
  }

  /**
   * Increment the persisted counter by `n` and fire threshold logs (80% warning, 95% critical).
   * Called after each successful 2xx from pvnode-client.js (REVIEWS L2: single entry point).
   */
  async function increment(n = 1) {
    await store.incrementPvnodeQuota(n);
    const used = await store.getPvnodeQuotaUsed();
    const limit = getLimit();
    const ratio = limit > 0 ? used / limit : 0;
    pushLog('pvnode_quota_usage', { used, limit, ratio: Math.round(ratio * 10000) / 10000 });
    if (ratio >= 0.95) {
      pushLog('pvnode_quota_critical', { used, limit });
    } else if (ratio >= 0.80) {
      pushLog('pvnode_quota_warning', { used, limit });
    }
  }

  /**
   * Read current month's usage + configured limit.
   * Exposed via /api/forecast/pvnode/quota (Plan 07-03).
   */
  async function getUsed() {
    const used = await store.getPvnodeQuotaUsed();
    const limit = getLimit();
    return {
      used,
      limit,
      remaining: Math.max(0, limit - used),
      month_utc: currentMonthKey()
    };
  }

  /**
   * Is the client currently in a self-imposed cool-down after a 429?
   * @returns {boolean}
   */
  function isExhausted() {
    return Date.now() < quotaExhaustedUntil;
  }

  /**
   * Mark the client as exhausted for the given number of seconds.
   * Called by pvnode-client.js on HTTP 429 (with Retry-After seconds when available,
   * else 1h fallback). Subsequent fetchForecast() calls short-circuit to cached data.
   */
  function markExhausted(retryAfterSeconds = 3600) {
    const seconds = Number.isFinite(Number(retryAfterSeconds)) && retryAfterSeconds > 0
      ? Number(retryAfterSeconds)
      : 3600;
    quotaExhaustedUntil = Date.now() + seconds * 1000;
    pushLog('pvnode_quota_exhausted', { retryAfterSeconds: seconds });
  }

  /**
   * Returns true when (limit - used) / limit < threshold. Used by Plan 07-03 backfill
   * to suspend early when remaining budget is tight (default 20% floor).
   */
  async function isLowBudget(threshold = 0.20) {
    const { used, limit } = await getUsed();
    if (limit <= 0) return true; // misconfigured → fail-safe low-budget
    return (limit - used) / limit < threshold;
  }

  return { increment, getUsed, isExhausted, markExhausted, isLowBudget };
}
