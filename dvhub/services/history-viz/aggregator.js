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

  // -------------------------------------------------------------------------
  // Plan 09.3-02 Wave 2 helpers — shared across all 5 builders.
  // -------------------------------------------------------------------------

  // resolveRange(view, anchorDate)
  //
  // anchorDate: YYYY-MM-DD. Returns ISO start/end in UTC, inclusive-start,
  // exclusive-end (matches telemetryStore.querySeries `ts_utc >= start AND
  // < end` semantics). For 'month' / 'year' we use rolling fixed-day windows
  // (30 / 365 days) — calendar-aligned variants land in a future plan.
  function resolveRange(view, anchorDate) {
    const anchor = new Date(`${anchorDate}T00:00:00Z`);
    const DAY_MS = 86_400_000;
    let start;
    let end;
    if (view === 'day') {
      start = anchor;
      end = new Date(anchor.getTime() + DAY_MS);
    } else if (view === 'week') {
      // 7-day window ending at the anchor day (inclusive)
      start = new Date(anchor.getTime() - 6 * DAY_MS);
      end = new Date(anchor.getTime() + DAY_MS);
    } else if (view === 'month') {
      // 30-day rolling window ending at the anchor day (inclusive)
      start = new Date(anchor.getTime() - 29 * DAY_MS);
      end = new Date(anchor.getTime() + DAY_MS);
    } else if (view === 'year') {
      // 12-month window ending at the anchor month
      const y = anchor.getUTCFullYear();
      const m = anchor.getUTCMonth(); // 0..11
      // 11 calendar months before the anchor month + the anchor month itself = 12 months
      start = new Date(Date.UTC(y, m - 11, 1));
      end = new Date(Date.UTC(y, m + 1, 1));
    } else {
      start = anchor;
      end = new Date(anchor.getTime() + DAY_MS);
    }
    return { start: start.toISOString(), end: end.toISOString() };
  }

  function round3(n) {
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 1000) / 1000;
  }

  // Sum (W × Δt_seconds / 3600 / 1000) → kWh across all rows matching `key`.
  // Treats gaps as zero (no row → no energy contribution); uses each row's
  // `resolution` field as Δt (capped at 900s by querySeries). Mirrors the
  // existing energy-integration idiom from telemetry-store-pg.js:662 closely
  // enough that totals stay consistent with the historyApi summary tile.
  function sumSeriesKwh(rows, key) {
    let kwh = 0;
    for (const r of rows) {
      if (r.key !== key) continue;
      const w = Number(r.value);
      const dt = Number(r.resolution || 0);
      if (!Number.isFinite(w) || !Number.isFinite(dt) || dt <= 0) continue;
      kwh += (w * dt) / 3_600_000;
    }
    return kwh;
  }

  // Bucket rows of `key` by hour-of-day (UTC). Returns Array<{h:0..23, w:avgPower}>.
  // Average power, not energy — DayProfile renders W on the y-axis.
  function bucketSeriesByHour(rows, key) {
    const sums = new Array(24).fill(0);
    const counts = new Array(24).fill(0);
    for (const r of rows) {
      if (r.key !== key) continue;
      const w = Number(r.value);
      if (!Number.isFinite(w)) continue;
      const d = new Date(r.ts);
      const h = d.getUTCHours();
      sums[h] += w;
      counts[h] += 1;
    }
    const out = [];
    for (let h = 0; h < 24; h++) {
      out.push({ h, w: counts[h] > 0 ? Math.round(sums[h] / counts[h]) : 0 });
    }
    return out;
  }

  // Bucket rows of `key` into N kWh-per-bucket cells, where N is determined by
  // view (24 = hours, 7 = day-of-week, 30 = day-of-month, 12 = month-of-year).
  // Each row contributes (W × dt/3_600_000) kWh into the bucket selected by ts.
  function bucketSeriesKwh(rows, key, view, rangeStart) {
    const startMs = Date.parse(rangeStart);
    let buckets;
    let bucketOf;
    if (view === 'day') {
      buckets = new Array(24).fill(0);
      bucketOf = (ts) => new Date(ts).getUTCHours();
    } else if (view === 'week') {
      buckets = new Array(7).fill(0);
      bucketOf = (ts) => {
        const days = Math.floor((Date.parse(ts) - startMs) / 86_400_000);
        return Math.max(0, Math.min(6, days));
      };
    } else if (view === 'month') {
      // 30-day rolling window → 30 buckets (one per day from rangeStart)
      buckets = new Array(30).fill(0);
      bucketOf = (ts) => {
        const days = Math.floor((Date.parse(ts) - startMs) / 86_400_000);
        return Math.max(0, Math.min(29, days));
      };
    } else if (view === 'year') {
      buckets = new Array(12).fill(0);
      const startDate = new Date(rangeStart);
      const startY = startDate.getUTCFullYear();
      const startM = startDate.getUTCMonth();
      bucketOf = (ts) => {
        const d = new Date(ts);
        const idx = (d.getUTCFullYear() - startY) * 12 + (d.getUTCMonth() - startM);
        return Math.max(0, Math.min(11, idx));
      };
    } else {
      buckets = [];
      bucketOf = () => 0;
    }
    for (const r of rows) {
      if (r.key !== key) continue;
      const w = Number(r.value);
      const dt = Number(r.resolution || 0);
      if (!Number.isFinite(w) || !Number.isFinite(dt) || dt <= 0) continue;
      const idx = bucketOf(r.ts);
      if (idx < 0 || idx >= buckets.length) continue;
      buckets[idx] += (w * dt) / 3_600_000;
    }
    return buckets.map(round3);
  }

  // German short labels per view (matches mockup expectations from D-15).
  const DOW_DE_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  const MONTH_DE_SHORT = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

  function bucketLabelsForView(view, rangeStart) {
    if (view === 'day') {
      return Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
    }
    if (view === 'week') {
      // Map calendar day-of-week to German short label, starting from rangeStart.
      const out = [];
      const startMs = Date.parse(rangeStart);
      for (let i = 0; i < 7; i++) {
        const d = new Date(startMs + i * 86_400_000);
        // getUTCDay: 0=Sunday..6=Saturday; map to Mo=0..So=6
        const dow = (d.getUTCDay() + 6) % 7;
        out.push(DOW_DE_SHORT[dow]);
      }
      return out;
    }
    if (view === 'month') {
      // Day-of-month labels DD.MM. for each of 30 days starting at rangeStart.
      const out = [];
      const startMs = Date.parse(rangeStart);
      for (let i = 0; i < 30; i++) {
        const d = new Date(startMs + i * 86_400_000);
        out.push(`${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.`);
      }
      return out;
    }
    if (view === 'year') {
      const out = [];
      const sd = new Date(rangeStart);
      const startY = sd.getUTCFullYear();
      const startM = sd.getUTCMonth();
      for (let i = 0; i < 12; i++) {
        const m = (startM + i) % 12;
        out.push(MONTH_DE_SHORT[m]);
      }
      return out;
    }
    return [];
  }

  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Plan 09.3-02 Wave 2 — 5 LIVE builders.
  // Pattern (per the plan template):
  //   1. validate() returns 400-envelope on bad input → NEVER cached
  //   2. view-specific guard (e.g. heatmap rejects 'day', ledger rejects ≠'day')
  //   3. cache key = `${card}:${view}:${date}`; HIT returns 200 with body.cached=true
  //   4. resolveRange() → telemetryStore.querySeries (or db.query for ledger)
  //   5. Build payload (typed envelope), putCached(key, payload), return 200
  //   6. try/catch → pushLog + 500 envelope (never cached)
  // -------------------------------------------------------------------------

  async function getSankey({ view, date } = {}) {
    const bad = validate({ view, date });
    if (bad) return bad;
    const key = `sankey:${view}:${date}`;
    const hit = getCached(key);
    if (hit) return { status: 200, body: { ...hit, cached: true }, cached: true };
    try {
      const { start, end } = resolveRange(view, date);
      const rows = await telemetryStore.querySeries({
        seriesKeys: [
          'pv_total_w', 'grid_import_w', 'grid_export_w',
          'load_power_w', 'battery_charge_w', 'battery_discharge_w',
        ],
        start, end, maxResolution: 900,
      });
      const pvKwh = sumSeriesKwh(rows, 'pv_total_w');
      const gridImportKwh = sumSeriesKwh(rows, 'grid_import_w');
      const gridExportKwh = sumSeriesKwh(rows, 'grid_export_w');
      const batteryChargeKwh = sumSeriesKwh(rows, 'battery_charge_w');
      const batteryDischargeKwh = sumSeriesKwh(rows, 'battery_discharge_w');
      // PV-direct = pv generation that didn't go to grid-export or battery-charge
      // → that's the share of PV consumed by the load directly.
      const pvToEigen = Math.max(0, pvKwh - gridExportKwh - batteryChargeKwh);
      const eigenverbrauchKwh = pvToEigen + batteryDischargeKwh + gridImportKwh;
      // Conservation: build flows so that
      //   sum(from PV) = pvToEigen + batteryChargeKwh + gridExportKwh = pvKwh (by construction)
      //   sum(to Eigenverbrauch) = pvToEigen + batteryDischargeKwh + gridImportKwh = eigenverbrauchKwh
      const flows = [
        { from: 'PV',            to: 'Eigenverbrauch', flow: round3(pvToEigen) },
        { from: 'PV',            to: 'Akku-Laden',     flow: round3(batteryChargeKwh) },
        { from: 'PV',            to: 'Einspeisung',    flow: round3(gridExportKwh) },
        { from: 'Akku-Entladen', to: 'Eigenverbrauch', flow: round3(batteryDischargeKwh) },
        { from: 'Netzbezug',     to: 'Eigenverbrauch', flow: round3(gridImportKwh) },
      ].filter(f => f.flow > 0.01);
      const payload = {
        ok: true,
        card: 'sankey',
        view,
        date,
        generatedAt: new Date().toISOString(),
        cached: false,
        flows,
        totals: {
          pvKwh: round3(pvKwh),
          eigenverbrauchKwh: round3(eigenverbrauchKwh),
          einspeisungKwh: round3(gridExportKwh),
        },
      };
      putCached(key, payload);
      return { status: 200, body: payload, cached: false };
    } catch (e) {
      if (typeof pushLog === 'function') pushLog('history_viz_sankey_error', { error: e.message, view, date });
      return { status: 500, body: { ok: false, error: e.message }, cached: false };
    }
  }

  async function getDayProfile({ view, date } = {}) {
    const bad = validate({ view, date });
    if (bad) return bad;
    if (view !== 'day') {
      return { status: 400, body: { ok: false, error: 'view not supported (day-profile is day-only)' }, cached: false };
    }
    const key = `day-profile:${view}:${date}`;
    const hit = getCached(key);
    if (hit) return { status: 200, body: { ...hit, cached: true }, cached: true };
    try {
      const { start, end } = resolveRange(view, date);
      const rows = await telemetryStore.querySeries({
        seriesKeys: ['pv_total_w', 'load_power_w'],
        start, end, maxResolution: 900,
      });
      const pv = bucketSeriesByHour(rows, 'pv_total_w');
      const load = bucketSeriesByHour(rows, 'load_power_w');
      const payload = {
        ok: true,
        card: 'day-profile',
        view,
        date,
        generatedAt: new Date().toISOString(),
        cached: false,
        hours: 24,
        pv,
        load,
      };
      putCached(key, payload);
      return { status: 200, body: payload, cached: false };
    } catch (e) {
      if (typeof pushLog === 'function') pushLog('history_viz_day_profile_error', { error: e.message, view, date });
      return { status: 500, body: { ok: false, error: e.message }, cached: false };
    }
  }

  async function getStack({ view, date } = {}) {
    const bad = validate({ view, date });
    if (bad) return bad;
    const key = `stack:${view}:${date}`;
    const hit = getCached(key);
    if (hit) return { status: 200, body: { ...hit, cached: true }, cached: true };
    try {
      const { start, end } = resolveRange(view, date);
      const rows = await telemetryStore.querySeries({
        seriesKeys: ['pv_total_w', 'battery_discharge_w', 'grid_import_w', 'load_power_w'],
        start, end, maxResolution: 900,
      });
      // PV-direct ≈ min(pv, load). The plan notes "or fallback: min(pv_total_w,
      // load_power_w)" — we always fall back since `pv_direct_w` is not in the
      // canonical series catalogue (verified against telemetry-store-pg.js:24).
      // Compute per-row min, then bucket-integrate as kWh.
      const pvDirectRows = [];
      const byTs = new Map();
      for (const r of rows) {
        const t = r.ts;
        if (!byTs.has(t)) byTs.set(t, {});
        byTs.get(t)[r.key] = r;
      }
      for (const [ts, group] of byTs.entries()) {
        const pvR = group.pv_total_w;
        const loadR = group.load_power_w;
        if (!pvR || !loadR) continue;
        const minW = Math.min(Number(pvR.value) || 0, Number(loadR.value) || 0);
        pvDirectRows.push({
          key: 'pv_direct_w',
          ts,
          value: minW,
          resolution: pvR.resolution,
          unit: 'W',
        });
      }
      const allRows = rows.concat(pvDirectRows);
      const pvDirectKwh = bucketSeriesKwh(allRows, 'pv_direct_w', view, start);
      const batteryDischargeKwh = bucketSeriesKwh(rows, 'battery_discharge_w', view, start);
      const gridImportKwh = bucketSeriesKwh(rows, 'grid_import_w', view, start);
      const loadKwh = bucketSeriesKwh(rows, 'load_power_w', view, start);
      const bucketLabels = bucketLabelsForView(view, start);
      const buckets = bucketLabels.length;
      const payload = {
        ok: true,
        card: 'stack',
        view,
        date,
        generatedAt: new Date().toISOString(),
        cached: false,
        buckets,
        bucketLabels,
        pvDirectKwh,
        batteryDischargeKwh,
        gridImportKwh,
        loadKwh,
      };
      putCached(key, payload);
      return { status: 200, body: payload, cached: false };
    } catch (e) {
      if (typeof pushLog === 'function') pushLog('history_viz_stack_error', { error: e.message, view, date });
      return { status: 500, body: { ok: false, error: e.message }, cached: false };
    }
  }

  async function getHeatmap({ view, date } = {}) {
    const bad = validate({ view, date });
    if (bad) return bad;
    if (view === 'day') {
      return { status: 400, body: { ok: false, error: 'view not supported (heatmap is week|month|year only)' }, cached: false };
    }
    const key = `heatmap:${view}:${date}`;
    const hit = getCached(key);
    if (hit) return { status: 200, body: { ...hit, cached: true }, cached: true };
    try {
      const { start, end } = resolveRange(view, date);
      const rows = await telemetryStore.querySeries({
        seriesKeys: ['pv_total_w'],
        start, end, maxResolution: 900,
      });
      let xLabels;
      let yLabels;
      let matrix;
      let domainMax = 0;
      const startMs = Date.parse(start);
      const endMs = Date.parse(end);
      if (view === 'week' || view === 'month') {
        // x = day (YYYY-MM-DD), y = hour 0..23, v = PV-kWh integrated.
        const days = Math.round((endMs - startMs) / 86_400_000);
        xLabels = [];
        for (let i = 0; i < days; i++) {
          const d = new Date(startMs + i * 86_400_000);
          xLabels.push(d.toISOString().slice(0, 10));
        }
        yLabels = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
        // Energy buckets: cell[xLabel][hour] kWh
        const cells = new Map(); // key=`${xLabel}:${y}` → kWh
        for (const r of rows) {
          if (r.key !== 'pv_total_w') continue;
          const w = Number(r.value);
          const dt = Number(r.resolution || 0);
          if (!Number.isFinite(w) || !Number.isFinite(dt) || dt <= 0) continue;
          const ts = new Date(r.ts);
          const xLabel = ts.toISOString().slice(0, 10);
          const y = ts.getUTCHours();
          const k = `${xLabel}:${y}`;
          const kwh = (w * dt) / 3_600_000;
          cells.set(k, (cells.get(k) || 0) + kwh);
        }
        matrix = [];
        for (const x of xLabels) {
          for (let y = 0; y < 24; y++) {
            const v = round3(cells.get(`${x}:${y}`) || 0);
            if (v > domainMax) domainMax = v;
            matrix.push({ x, y, v });
          }
        }
      } else { // view === 'year'
        // x = month label (Jan..Dez), y = day-of-month 1..31, v = daily PV-kWh.
        // Note: cells outside actual month length stay 0; client treats as empty.
        xLabels = bucketLabelsForView('year', start);
        yLabels = Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, '0'));
        const cells = new Map(); // key=`${monthIdx}:${day}` → kWh
        const startDate = new Date(start);
        const startY = startDate.getUTCFullYear();
        const startM = startDate.getUTCMonth();
        for (const r of rows) {
          if (r.key !== 'pv_total_w') continue;
          const w = Number(r.value);
          const dt = Number(r.resolution || 0);
          if (!Number.isFinite(w) || !Number.isFinite(dt) || dt <= 0) continue;
          const ts = new Date(r.ts);
          const monthIdx = (ts.getUTCFullYear() - startY) * 12 + (ts.getUTCMonth() - startM);
          if (monthIdx < 0 || monthIdx > 11) continue;
          const day = ts.getUTCDate();
          const k = `${monthIdx}:${day}`;
          const kwh = (w * dt) / 3_600_000;
          cells.set(k, (cells.get(k) || 0) + kwh);
        }
        matrix = [];
        for (let m = 0; m < 12; m++) {
          const xLabel = xLabels[m];
          for (let d = 1; d <= 31; d++) {
            const v = round3(cells.get(`${m}:${d}`) || 0);
            if (v > domainMax) domainMax = v;
            matrix.push({ x: xLabel, y: d, v });
          }
        }
      }
      const payload = {
        ok: true,
        card: 'heatmap',
        view,
        date,
        generatedAt: new Date().toISOString(),
        cached: false,
        xLabels,
        yLabels,
        matrix,
        domain: { min: 0, max: round3(domainMax), unit: 'kWh' },
      };
      putCached(key, payload);
      return { status: 200, body: payload, cached: false };
    } catch (e) {
      if (typeof pushLog === 'function') pushLog('history_viz_heatmap_error', { error: e.message, view, date });
      return { status: 500, body: { ok: false, error: e.message }, cached: false };
    }
  }

  async function getLedger({ view, date } = {}) {
    const bad = validate({ view, date });
    if (bad) return bad;
    if (view !== 'day') {
      return { status: 400, body: { ok: false, error: 'view not supported (ledger is day-only)' }, cached: false };
    }
    const key = `ledger:${view}:${date}`;
    const hit = getCached(key);
    if (hit) return { status: 200, body: { ...hit, cached: true }, cached: true };
    try {
      const { start, end } = resolveRange(view, date);
      // SQL — opt.plan_slots holds per-slot import/export Wh + expected_profit_eur;
      // shared.market_price_slots holds price_ct_kwh per slot. JOIN by slot_start.
      // Plan-doc column-name verification (against
      // dvhub/db/migrations/011-opt-tables.sql:127-146 and 009-shared-tables.sql:253-272):
      //   opt.plan_slots:        slot_start, grid_import_wh, grid_export_wh,
      //                          battery_charge_grid_wh, battery_charge_pv_wh,
      //                          battery_discharge_load_wh, battery_discharge_export_wh,
      //                          expected_profit_eur
      //   shared.market_price_slots: slot_start, price_ct_kwh, price_kind='market'
      // No `action`/`kwh`/`price_ct`/`revenue_eur` columns exist — they are
      // DERIVED below: action by sign of net flow, kwh by max(import, export)/1000,
      // priceCt by joined market price, revenueEur by expected_profit_eur (or 0).
      //
      // Test shape (W2-7) supplies a flat row shape with these columns. The
      // production SQL below is the authoritative path; the test double bypasses
      // it and feeds rows directly through `dbQueryFn`.
      const sql = `
        SELECT
          ps.slot_start,
          ps.grid_import_wh,
          ps.grid_export_wh,
          ps.battery_charge_grid_wh,
          ps.battery_charge_pv_wh,
          ps.battery_discharge_load_wh,
          ps.battery_discharge_export_wh,
          ps.expected_profit_eur,
          mps.price_ct_kwh
        FROM opt.plan_slots ps
        LEFT JOIN shared.market_price_slots mps
          ON mps.slot_start = ps.slot_start
         AND mps.price_kind = 'market'
        WHERE ps.slot_start >= $1::timestamptz
          AND ps.slot_start <  $2::timestamptz
        ORDER BY ps.slot_start DESC
        LIMIT 12
      `;
      const result = await db.query(sql, [start, end]);
      const allRows = (result && Array.isArray(result.rows)) ? result.rows : [];
      // SQL LIMIT 12 is the production cap, but the mock adapter (and any future
      // adapter that ignores LIMIT) might return more — enforce in JS so the
      // envelope contract holds regardless of the data source's adherence.
      // Also re-sort DESC defensively in case the SQL ORDER was bypassed.
      const sortedRows = allRows
        .slice()
        .sort((a, b) => {
          const at = typeof a.slot_start === 'string' ? a.slot_start : new Date(a.slot_start).toISOString();
          const bt = typeof b.slot_start === 'string' ? b.slot_start : new Date(b.slot_start).toISOString();
          return bt.localeCompare(at);
        })
        .slice(0, 12);
      const slots = sortedRows.map((row) => {
        const importWh = Number(row.grid_import_wh) || 0;
        const exportWh = Number(row.grid_export_wh) || 0;
        // Action heuristic: net positive export → 'sell', net positive import → 'buy',
        // both ~0 → 'hold' (curtailment slot or pure self-consumption).
        let action = 'hold';
        if (exportWh > importWh && exportWh > 0) action = 'sell';
        else if (importWh > exportWh && importWh > 0) action = 'buy';
        const kwh = Math.max(importWh, exportWh) / 1000;
        const priceCt = Number(row.price_ct_kwh) || 0;
        const revenueEur = Number(row.expected_profit_eur) || 0;
        return {
          ts: typeof row.slot_start === 'string' ? row.slot_start : new Date(row.slot_start).toISOString(),
          action,
          kwh: round3(kwh),
          priceCt: round3(priceCt),
          revenueEur: round3(revenueEur),
        };
      });
      const totalEur = round3(slots.reduce((s, x) => s + x.revenueEur, 0));
      const payload = {
        ok: true,
        card: 'ledger',
        view,
        date,
        generatedAt: new Date().toISOString(),
        cached: false,
        slots,
        totalEur,
      };
      putCached(key, payload);
      return { status: 200, body: payload, cached: false };
    } catch (e) {
      if (typeof pushLog === 'function') pushLog('history_viz_ledger_error', { error: e.message, view, date });
      return { status: 500, body: { ok: false, error: e.message }, cached: false };
    }
  }

  // -------------------------------------------------------------------------
  // Plan 09.3-03 Wave 3 — 3 LIVE builders (Autarky-Calendar / Ring / Duration).
  // CONTEXT D-04 Gruppe B Tier-1 — simpler per-day / per-hour aggregations.
  // Same 6-step template as Wave 2 (validate → guard → cache → fetch → build →
  // putCached). Spot prices for ring + duration come from
  // shared.market_price_slots: verified column names are slot_start
  // (TIMESTAMPTZ), price_kind ('market'), price_ct_kwh (NUMERIC) — see
  // db/migrations/009-shared-tables.sql:253-269. The plan-doc assumed
  // `ts_utc` + `price_ct_per_kwh`; both are corrected to the real schema.
  // -------------------------------------------------------------------------

  function round1(n) {
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 10) / 10;
  }

  // Resolve the optimizer price thresholds (charge-below / sell-above ct/kWh).
  // The project's config-model.js `optimizer` section (verified) carries
  // enabled / allowGridCharge / batteryCapacityWh / maxChargeW / minSocPct etc.
  // but NO chargeBelowCt / sellAboveCt keys — so the plan's documented fallback
  // {chargeBelowCt: 5, sellAboveCt: 12} is used. A one-time pushLog records
  // that the default was applied (so an operator can wire real keys later).
  let __durationThresholdsDefaultLogged = false;
  function resolveDurationThresholds() {
    let opt = {};
    try { opt = (getCfg && getCfg().optimizer) || {}; } catch (_) { opt = {}; }
    const charge = Number.isFinite(Number(opt.chargeBelowCt)) ? Number(opt.chargeBelowCt) : null;
    const sell = Number.isFinite(Number(opt.sellAboveCt)) ? Number(opt.sellAboveCt) : null;
    if (charge === null || sell === null) {
      if (!__durationThresholdsDefaultLogged && typeof pushLog === 'function') {
        pushLog('history_viz_duration_thresholds_default', {
          reason: 'optimizer.chargeBelowCt/sellAboveCt not configured',
          fallback: { chargeBelowCt: 5, sellAboveCt: 12 },
        });
        __durationThresholdsDefaultLogged = true;
      }
    }
    return {
      chargeBelowCt: charge !== null ? charge : 5,
      sellAboveCt: sell !== null ? sell : 12,
    };
  }

  async function getAutarkyCalendar({ view, date } = {}) {
    const bad = validate({ view, date });
    if (bad) return bad;
    const key = `autarky-calendar:${view}:${date}`;
    const hit = getCached(key);
    if (hit) return { status: 200, body: { ...hit, cached: true }, cached: true };
    try {
      const { start, end } = resolveRange(view, date);
      const rows = await telemetryStore.querySeries({
        seriesKeys: ['load_power_w', 'grid_import_w'],
        start, end, maxResolution: 900,
      });
      // Bucket per UTC day, integrate W×Δt → kWh, compute
      //   autarky% = (load - grid_import) / load * 100, clamped [0,100].
      const dailyLoad = {};      // YYYY-MM-DD → kWh
      const dailyGridImp = {};
      for (const r of rows) {
        const w = Number(r.value);
        const dt = Number(r.resolution || 0);
        if (!Number.isFinite(w) || !Number.isFinite(dt) || dt <= 0) continue;
        const dk = new Date(r.ts).toISOString().slice(0, 10);
        const kwh = (w * dt) / 3_600_000;
        if (r.key === 'load_power_w') dailyLoad[dk] = (dailyLoad[dk] || 0) + kwh;
        else if (r.key === 'grid_import_w') dailyGridImp[dk] = (dailyGridImp[dk] || 0) + kwh;
      }
      // Union of day keys so a day with grid-import but no load row still shows.
      const dateSet = new Set([...Object.keys(dailyLoad), ...Object.keys(dailyGridImp)]);
      const dates = [...dateSet].sort();
      const matrix = [];
      for (const d of dates) {
        const load = dailyLoad[d] || 0;
        const imp = dailyGridImp[d] || 0;
        // T-09.3-13 — clamp regardless of row anomalies; load>0 guard prevents
        // div-by-zero (a day with zero recorded load yields 0% autarky).
        const pct = load > 0 ? Math.max(0, Math.min(100, ((load - imp) / load) * 100)) : 0;
        // dow mapping: JS getUTCDay() is 0=Sunday..6=Saturday; the y-axis
        // labels are Mo=0..So=6, so shift by +6 mod 7.
        const jsDow = new Date(`${d}T12:00:00Z`).getUTCDay();
        const dowIdx = (jsDow + 6) % 7;
        matrix.push({ x: d, y: dowIdx, v: round1(pct) });
      }
      const payload = {
        ok: true,
        card: 'autarky-calendar',
        view,
        date,
        generatedAt: new Date().toISOString(),
        cached: false,
        xLabels: dates,
        yLabels: DOW_DE_SHORT.slice(),
        matrix,
        domain: { min: 0, max: 100, unit: '%' },
      };
      putCached(key, payload);
      return { status: 200, body: payload, cached: false };
    } catch (e) {
      if (typeof pushLog === 'function') pushLog('history_viz_autarky_calendar_error', { error: e.message, view, date });
      return { status: 500, body: { ok: false, error: e.message }, cached: false };
    }
  }

  async function getRing({ view, date } = {}) {
    const bad = validate({ view, date });
    if (bad) return bad;
    if (view !== 'day') {
      return { status: 400, body: { ok: false, error: 'view not supported (ring is day-only)' }, cached: false };
    }
    const key = `ring:${view}:${date}`;
    const hit = getCached(key);
    if (hit) return { status: 200, body: { ...hit, cached: true }, cached: true };
    try {
      const { start, end } = resolveRange(view, date);
      const rows = await telemetryStore.querySeries({
        seriesKeys: ['pv_total_w', 'load_power_w'],
        start, end, maxResolution: 900,
      });
      // Per-hour kWh (integrate each row's W×Δt) and per-hour average spot price.
      const pvKwhByHour = new Array(24).fill(0);
      const loadKwhByHour = new Array(24).fill(0);
      for (const r of rows) {
        const w = Number(r.value);
        const dt = Number(r.resolution || 0);
        if (!Number.isFinite(w) || !Number.isFinite(dt) || dt <= 0) continue;
        const h = new Date(r.ts).getUTCHours();
        const kwh = (w * dt) / 3_600_000;
        if (r.key === 'pv_total_w') pvKwhByHour[h] += kwh;
        else if (r.key === 'load_power_w') loadKwhByHour[h] += kwh;
      }
      // Spot price per hour from shared.market_price_slots (parameterized).
      // Aggregate to hour-of-day average; missing hours fall back to 0.
      const spotByHour = new Array(24).fill(0);
      try {
        const priceSql = `
          SELECT EXTRACT(HOUR FROM slot_start) AS h, AVG(price_ct_kwh) AS avg_ct
          FROM shared.market_price_slots
          WHERE price_kind = 'market'
            AND slot_start >= $1::timestamptz
            AND slot_start <  $2::timestamptz
          GROUP BY 1
          ORDER BY 1
        `;
        if (db && typeof db.query === 'function') {
          const pr = await db.query(priceSql, [start, end]);
          for (const row of (pr && Array.isArray(pr.rows) ? pr.rows : [])) {
            const h = Math.trunc(Number(row.h));
            if (h >= 0 && h < 24) spotByHour[h] = round3(Number(row.avg_ct) || 0);
          }
        }
      } catch (priceErr) {
        // Spot price is a non-critical overlay — log and continue with zeros.
        if (typeof pushLog === 'function') pushLog('history_viz_ring_price_error', { error: priceErr.message, view, date });
      }
      const hourly = [];
      for (let h = 0; h < 24; h++) {
        hourly.push({
          h,
          pvKwh: round3(pvKwhByHour[h]),
          loadKwh: round3(loadKwhByHour[h]),
          spotCt: spotByHour[h],
        });
      }
      const pvTotal = pvKwhByHour.reduce((s, x) => s + x, 0);
      const loadTotal = loadKwhByHour.reduce((s, x) => s + x, 0);
      // Autarky = share of load NOT met by grid. Per-hour deficit = max(0, load - pv).
      const deficit = hourly.reduce((s, hr) => s + Math.max(0, hr.loadKwh - hr.pvKwh), 0);
      const autarkyPct = loadTotal > 0
        ? Math.max(0, Math.min(100, Math.round(((loadTotal - deficit) / loadTotal) * 100)))
        : 0;
      const payload = {
        ok: true,
        card: 'ring',
        view,
        date,
        generatedAt: new Date().toISOString(),
        cached: false,
        hourly,
        totals: {
          pvKwh: round3(pvTotal),
          loadKwh: round3(loadTotal),
          autarkyPct,
        },
      };
      putCached(key, payload);
      return { status: 200, body: payload, cached: false };
    } catch (e) {
      if (typeof pushLog === 'function') pushLog('history_viz_ring_error', { error: e.message, view, date });
      return { status: 500, body: { ok: false, error: e.message }, cached: false };
    }
  }

  async function getDuration({ view, date } = {}) {
    const bad = validate({ view, date });
    if (bad) return bad;
    const key = `duration:${view}:${date}`;
    const hit = getCached(key);
    if (hit) return { status: 200, body: { ...hit, cached: true }, cached: true };
    try {
      const { start, end } = resolveRange(view, date);
      // T-09.3-14 — parameterized; ORDER BY DESC server-side. The payload only
      // ships {rank, priceCt} per slot; a year window (~8760 slots) stays well
      // under 50KB (~8760 × ~25B ≈ 220KB raw → but per-rank objects are small;
      // realistically week/month dominate the UI — year is gated by the 5-min
      // cache which prevents storms, T-09.3-15).
      const sql = `
        SELECT price_ct_kwh
        FROM shared.market_price_slots
        WHERE price_kind = 'market'
          AND slot_start >= $1::timestamptz
          AND slot_start <  $2::timestamptz
        ORDER BY price_ct_kwh DESC
      `;
      let rows = [];
      if (db && typeof db.query === 'function') {
        const result = await db.query(sql, [start, end]);
        rows = (result && Array.isArray(result.rows)) ? result.rows : [];
      }
      // Defensive re-sort DESC in case the adapter ignored ORDER BY.
      const prices = rows
        .map((r) => Number(r.price_ct_kwh))
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => b - a);
      const slots = prices.map((p, i) => ({ rank: i + 1, priceCt: round3(p) }));
      const thresholds = resolveDurationThresholds();
      // stats: meanCt + hour-equivalent counts above/below the thresholds.
      // We count SLOTS (not hour-weighted) — documented choice: the duration
      // curve x-axis is rank, and the consumer (Aurora card) labels the stat
      // "N h" loosely; for view='day' a slot is 15min so the label is an
      // upper-ish proxy. A future plan can hour-weight if precision matters.
      const meanCt = prices.length > 0
        ? round3(prices.reduce((s, p) => s + p, 0) / prices.length)
        : 0;
      const stats = {
        meanCt,
        hoursBelowChargeThreshold: prices.filter((p) => p < thresholds.chargeBelowCt).length,
        hoursAboveSellThreshold: prices.filter((p) => p > thresholds.sellAboveCt).length,
      };
      const payload = {
        ok: true,
        card: 'duration',
        view,
        date,
        generatedAt: new Date().toISOString(),
        cached: false,
        slots,
        thresholds,
        stats,
      };
      putCached(key, payload);
      return { status: 200, body: payload, cached: false };
    } catch (e) {
      if (typeof pushLog === 'function') pushLog('history_viz_duration_error', { error: e.message, view, date });
      return { status: 500, body: { ok: false, error: e.message }, cached: false };
    }
  }

  const api = {
    getSankey,
    getHeatmap,
    getLedger,
    getDayProfile,
    getStack,
    getAutarkyCalendar,
    getRing,
    getDuration,
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
