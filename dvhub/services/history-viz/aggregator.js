// services/history-viz/aggregator.js
//
// Plan 09.3-01 Wave 1 — Phase 09.3 Aurora History-Viz Cards aggregator
// foundation. Implements D-08 (factory under dvhub/services/history-viz),
// D-09 (5min in-memory cache, cap 200 entries, FIFO eviction, 3-segment key
// `${card}:${view}:${date}`, NEVER cache 4xx/5xx) and D-10 (14 stub builders
// returning a typed envelope so the front-end can wire against the contract
// from commit #1).
//
// Stubs return `{ status: 501, body: { ok:false, error:'not_implemented', ... } }`
// — Waves 2–5 replace each builder body with the real PG aggregation. The cache,
// validation, envelope, and dispatch are LIVE from this commit forward; future
// waves only need to drop the SQL into each makeStub call.
//
// Validation contract (V5 / T-09.3-01):
//   view ∈ {'day','week','month','year'}
//   date matches /^\d{4}-\d{2}-\d{2}$/
//   invalid → { status: 400, body: { ok:false, error:'invalid view'|'invalid date' } }
//   400s NEVER hit the cache (Pitfall §cache-poisoning + Test 7).
//
// Cache contract (D-09 / T-09.3-02):
//   key  = `${card}:${view}:${date}` (3 colon-separated segments REQUIRED so
//          that getCached('sankey:day:2026-05-15') and
//          getCached('sankey:week:2026-05-15') never collide — RESEARCH §Pitfall 6)
//   ttl  = 5 * 60 * 1000 ms
//   cap  = 200 entries
//   evict = FIFO via cache.keys().next().value
//   bustCache(prefix) — Waves 2–5 call this after a successful refresh of the
//                       underlying PG row (e.g., after a backfill batch).

/**
 * @param {object} ctx - DI context { state, getCfg, pushLog, db, telemetryStore }
 * @returns {object} aggregator API
 */
export function createHistoryVizAggregator(ctx) {
  // The destructure is intentionally permissive — Wave 1 stubs do not call
  // pool/telemetryStore at all, but the references are captured here so Waves
  // 2-5 can use them without touching this signature.
  const { getCfg, pushLog, db, telemetryStore } = ctx; // eslint-disable-line no-unused-vars

  const CACHE_TTL_MS = 5 * 60 * 1000;
  const CACHE_CAP = 200;
  const VALID_VIEWS = new Set(['day', 'week', 'month', 'year']);
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  // Map preserves insertion order — that gives us FIFO eviction without a
  // separate timestamp ledger. Each value is `{ payload, expiresAt }`.
  const cache = new Map();

  function getCached(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      cache.delete(key);
      return null;
    }
    return entry.payload;
  }

  function putCached(key, payload) {
    if (cache.size >= CACHE_CAP) {
      // FIFO eviction — Map preserves insertion order, so .keys().next().value
      // is the oldest entry (the one inserted first).
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
    cache.set(key, { payload, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  function bustCache(prefix) {
    if (!prefix) {
      cache.clear();
      return;
    }
    for (const k of cache.keys()) {
      if (k.startsWith(prefix)) cache.delete(k);
    }
  }

  function envelope(card, view, date, payload, cached) {
    return {
      ok: true,
      card,
      view,
      date,
      generatedAt: new Date().toISOString(),
      cached,
      ...payload,
    };
  }

  function validate({ view, date }) {
    if (!VALID_VIEWS.has(view)) {
      return { status: 400, body: { ok: false, error: 'invalid view' }, cached: false };
    }
    const ds = String(date || '');
    if (!DATE_RE.test(ds)) {
      return { status: 400, body: { ok: false, error: 'invalid date' }, cached: false };
    }
    // Pattern-shape passes ⇒ also verify the date components form a real
    // calendar day (rejects 2026-99-99, 2026-13-01, 2026-02-30, etc).
    // Build via UTC to avoid TZ overflow ambiguity, then sanity-check that
    // the Date round-trips through the same Y-M-D triple. Parameterless
    // construction is intentional — Date.UTC accepts JS-month (0-indexed).
    const [y, mo, d] = ds.split('-').map(n => parseInt(n, 10));
    const ts = Date.UTC(y, mo - 1, d);
    if (!Number.isFinite(ts)) {
      return { status: 400, body: { ok: false, error: 'invalid date' }, cached: false };
    }
    const back = new Date(ts);
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
      return { status: 400, body: { ok: false, error: 'invalid date' }, cached: false };
    }
    return null;
  }

  /**
   * Stub-builder factory. Waves 2–5 replace each `makeStub(card)` site with a
   * dedicated builder that runs the SQL aggregation, builds the Chart.js-ready
   * payload, and routes through `putCached(key, body)` on a 200 result.
   *
   * The current behaviour:
   *   1. Validate `view` + `date`. Return 400 on bad input (NEVER cached).
   *   2. Check cache by 3-segment key. On hit, return 200 with `cached:true`.
   *   3. On miss, return 501 `not_implemented` with the full envelope keys
   *      present so the front-end can wire against the contract from day 1.
   *      501 responses are NOT cached (only successful 200 envelopes will be,
   *      starting with Wave 2).
   */
  function makeStub(card) {
    return async function ({ view, date } = {}) {
      const bad = validate({ view, date });
      if (bad) return bad;

      const key = `${card}:${view}:${date}`;
      const hit = getCached(key);
      if (hit) {
        // Re-stamp `cached: true` on the cached envelope; the `ok`, `card`,
        // `view`, `date` fields are preserved verbatim from the original
        // 200 build (Waves 2-5).
        return { status: 200, body: { ...hit, cached: true }, cached: true };
      }

      const body = {
        ok: false,
        card,
        view,
        date,
        generatedAt: new Date().toISOString(),
        cached: false,
        error: 'not_implemented',
      };
      // 501 stubs are NOT cached. Cache only mints from successful 200 results
      // in Waves 2-5 (the future builder will call putCached(key, body)).
      return { status: 501, body, cached: false };
    };
  }

  const api = {
    getSankey: makeStub('sankey'),
    getHeatmap: makeStub('heatmap'),
    getLedger: makeStub('ledger'),
    getDayProfile: makeStub('day-profile'),
    getStack: makeStub('stack'),
    getAutarkyCalendar: makeStub('autarky-calendar'),
    getRing: makeStub('ring'),
    getDuration: makeStub('duration'),
    getPheat: makeStub('pheat'),
    getSpaghetti: makeStub('spaghetti'),
    getCycles: makeStub('cycles'),
    getTop10: makeStub('top10'),
    getCalYear: makeStub('cal-year'),
    getScatter: makeStub('scatter'),
    bustCache,
    // Exposed for unit tests only — DO NOT consume from route handlers. The
    // routes-api dispatcher calls the public getXxx methods exclusively.
    __test_internals: {
      cache,
      getCached,
      putCached,
      validate,
      envelope,
      CACHE_TTL_MS,
      CACHE_CAP,
    },
  };
  return api;
}
