// services/history-viz/aggregator.js
//
// Plan 09.3-01 Wave 1 — Phase 09.3 Aurora History-Viz Cards aggregator
// foundation. Implements D-08 (factory under dvhub/services/history-viz),
// D-09 (5min in-memory cache, cap 200 entries, FIFO eviction, 3-segment key
// `${card}:${view}:${date}`, NEVER cache 4xx/5xx) and D-10 (14 stub builders
// returning a typed envelope so the front-end can wire against the contract
// from commit #1).
//
// Wave 1 shipped 14 stub builders returning a 501 `not_implemented` envelope;
// Waves 2–5 replaced each builder body with the real PG aggregation. As of
// Plan 09.3-05 ALL 14 builders are LIVE — the stub factory has been removed.
// The cache, validation, envelope, and dispatch have been LIVE since Wave 1.
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

  // ISO-8601 week number + ISO week-year for a Date (UTC). Week 1 is the week
  // containing the first Thursday; weeks start on Monday. The week-year can
  // differ from the calendar year for the first/last days of a year — we
  // return both so the spaghetti grouping key never collides across years.
  function isoWeek(date) {
    // Copy at UTC midnight so getUTCDay is stable.
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    // ISO day-of-week: Mon=1..Sun=7.
    const dayNum = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
    // Shift to the Thursday of this week — its calendar year is the ISO year.
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const year = d.getUTCFullYear();
    const yearStart = Date.UTC(year, 0, 1);
    const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
    return { year, week };
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

  // -------------------------------------------------------------------------
  // RC-1 — SQL-side downsampling.
  //
  // The shared telemetryStore.querySeries pulls every raw 5-10 s sample for the
  // whole window and dedups in JS — a month/year query returns millions of rows
  // and saturates the PG pool. The history-viz builders now fetch via
  // telemetryStore.queryBucketedSeries, which pushes a TimescaleDB time_bucket
  // GROUP BY into SQL so a year returns ~hundreds-thousands of rows.
  //
  // bucketIntervalForView — picks the SQL bucket width so the resulting bucket
  // rows are sub-multiples of the JS buckets that bucketSeriesKwh /
  // bucketSeriesByHour / per-day aggregations already expect:
  //   day   → 15 minutes  (downstream buckets into 24 hours-of-day)
  //   week  → 1 hour      (downstream buckets into 7 day-of-week)
  //   month → 1 hour      (downstream buckets into 30 days)
  //   year  → 1 day       (downstream buckets into 12 months)
  function bucketIntervalForView(view) {
    if (view === 'day') return '15 minutes';
    if (view === 'year') return '1 day';
    return '1 hour'; // week + month
  }

  // Fetch downsampled telemetry for the history-viz aggregator. Energy-type
  // series (power in W) keep `value` as the energy-equivalent average power so
  // `value × resolution / 3_600_000` stays the exact integrated bucket kWh.
  // Ratio/percentage series (e.g. battery_soc_pct) must use the plain
  // per-bucket mean — pass `meanSeries` so those rows carry value_avg in value.
  async function fetchBucketed({ seriesKeys, start, end, view, meanSeries = [], intervalOverride = null }) {
    // intervalOverride lets a builder request a finer SQL bucket than the
    // view default (e.g. the heatmap 15-min granularity option on week/month,
    // where the view default is '1 hour'). Must be an allow-listed literal —
    // queryBucketedSeries rejects anything else.
    const bucketInterval = intervalOverride || bucketIntervalForView(view);
    const rows = await telemetryStore.queryBucketedSeries({
      seriesKeys, start, end, bucketInterval,
    });
    if (!meanSeries.length) return rows;
    const meanSet = new Set(meanSeries);
    return rows.map((r) => (
      meanSet.has(r.key)
        ? { ...r, value: (r.value_avg == null ? r.value : r.value_avg) }
        : r
    ));
  }

  // -------------------------------------------------------------------------
  // Plan 09.3 round-2 — per-bucket energy-flow decomposition.
  //
  // The Sankey / Autarky-day builders must conserve energy: with a grid-
  // arbitrage battery `batteryCharge + gridExport` can exceed `pv` over a
  // PERIOD total, so the old period-level `pvToEigen = pv − export − charge`
  // clamps to 0 and the PV-out flows overshoot total PV. The fix decomposes
  // each TIME BUCKET independently (where conservation holds by construction)
  // then sums. Returns 7 accumulated flows + per-bucket-derived totals.
  //
  // `rows` is the fetchBucketed output for the 6 energy series; this groups
  // them by bucket ts, integrates W×Δt → kWh per bucket, and runs the
  // priority decomposition (PV → load, then PV → battery, then PV → export;
  // battery → load, then battery → export; grid covers the rest).
  function decomposeEnergyFlows(rows) {
    // bucket ts → { pv, load, gridImport, gridExport, batteryCharge, batteryDischarge } in kWh
    const buckets = new Map();
    const KEY_FIELD = {
      pv_total_w: 'pv',
      load_power_w: 'load',
      grid_import_w: 'gridImport',
      grid_export_w: 'gridExport',
      battery_charge_w: 'batteryCharge',
      battery_discharge_w: 'batteryDischarge',
    };
    for (const r of rows) {
      const field = KEY_FIELD[r.key];
      if (!field) continue;
      const w = Number(r.value);
      const dt = Number(r.resolution || 0);
      if (!Number.isFinite(w) || !Number.isFinite(dt) || dt <= 0) continue;
      let b = buckets.get(r.ts);
      if (!b) {
        b = { pv: 0, load: 0, gridImport: 0, gridExport: 0, batteryCharge: 0, batteryDischarge: 0 };
        buckets.set(r.ts, b);
      }
      b[field] += (w * dt) / 3_600_000;
    }
    let pvToLoad = 0;
    let pvToBattery = 0;
    let pvToExport = 0;
    let gridToBattery = 0;
    let batteryToLoad = 0;
    let batteryToExport = 0;
    let gridToLoad = 0;
    let totalPv = 0;
    let totalLoad = 0;
    for (const b of buckets.values()) {
      const { pv, load, batteryCharge, batteryDischarge } = b;
      totalPv += pv;
      totalLoad += load;
      const pvL = Math.min(pv, load);
      const loadRem1 = load - pvL;
      const pvRem1 = pv - pvL;
      const pvB = Math.min(pvRem1, batteryCharge);
      const pvE = pvRem1 - pvB;
      const gridB = batteryCharge - pvB;
      const battL = Math.min(batteryDischarge, loadRem1);
      const loadRem2 = loadRem1 - battL;
      const battE = batteryDischarge - battL;
      const gridL = loadRem2;
      pvToLoad += pvL;
      pvToBattery += pvB;
      pvToExport += pvE;
      gridToBattery += gridB;
      batteryToLoad += battL;
      batteryToExport += battE;
      gridToLoad += gridL;
    }
    // Guard tiny negatives from floating-point rounding.
    const clamp0 = (n) => (n > 0 ? n : 0);
    return {
      pvToLoad: clamp0(pvToLoad),
      pvToBattery: clamp0(pvToBattery),
      pvToExport: clamp0(pvToExport),
      gridToBattery: clamp0(gridToBattery),
      batteryToLoad: clamp0(batteryToLoad),
      batteryToExport: clamp0(batteryToExport),
      gridToLoad: clamp0(gridToLoad),
      totalPv: clamp0(totalPv),
      totalLoad: clamp0(totalLoad),
    };
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

  // NOTE: Wave 1 shipped a stub-builder factory here that returned a 501
  // `not_implemented` envelope for every card. Waves 2-5 replaced each stub
  // site with a dedicated live builder; Plan 09.3-05 (this wave) lit the final
  // three (top10 / cal-year / scatter), so the factory had no remaining call
  // sites and was removed. All 14 builders are now LIVE — see the api object.

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
      const rows = await fetchBucketed({
        seriesKeys: [
          'pv_total_w', 'grid_import_w', 'grid_export_w',
          'load_power_w', 'battery_charge_w', 'battery_discharge_w',
        ],
        start, end, view,
      });
      // Round-2 fix — decompose energy flows PER TIME BUCKET, then sum. This
      // conserves by construction: for a grid-arbitrage battery the period
      // totals `batteryCharge + gridExport` can exceed `pv`, so the old
      // period-level `pvToEigen = pv − export − charge` clamps to 0 and the
      // PV-out flows overshoot total PV. Per-bucket decomposition cannot
      // overshoot — within a bucket PV-out = pv, into-load = load, etc.
      // The 'grid' flows here are DERIVED (charge − pvCharge, load remainder),
      // independent of the meter's grid_import/grid_export — that is correct:
      // the meter is its own measurement, the Sankey must self-conserve.
      const f = decomposeEnergyFlows(rows);
      const pvKwh = f.totalPv;
      const eigenverbrauchKwh = f.pvToLoad + f.batteryToLoad + f.gridToLoad;
      const einspeisungKwh = f.pvToExport + f.batteryToExport;
      // 7 flow types — conserves: sum(from PV) = totalPv,
      // sum(to Eigenverbrauch) = eigenverbrauchKwh (= totalLoad), by construction.
      const flows = [
        { from: 'PV',            to: 'Eigenverbrauch', flow: round3(f.pvToLoad) },
        { from: 'PV',            to: 'Akku-Laden',     flow: round3(f.pvToBattery) },
        { from: 'PV',            to: 'Einspeisung',    flow: round3(f.pvToExport) },
        { from: 'Netzbezug',     to: 'Eigenverbrauch', flow: round3(f.gridToLoad) },
        { from: 'Netzbezug',     to: 'Akku-Laden',     flow: round3(f.gridToBattery) },
        { from: 'Akku-Entladen', to: 'Eigenverbrauch', flow: round3(f.batteryToLoad) },
        { from: 'Akku-Entladen', to: 'Einspeisung',    flow: round3(f.batteryToExport) },
      ].filter(fl => fl.flow > 0.01);
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
          einspeisungKwh: round3(einspeisungKwh),
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
      const rows = await fetchBucketed({
        seriesKeys: ['pv_total_w', 'load_power_w'],
        start, end, view,
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
      const rows = await fetchBucketed({
        seriesKeys: ['pv_total_w', 'battery_discharge_w', 'grid_import_w', 'load_power_w'],
        start, end, view,
      });
      // RC-E fix — PV-direct ≈ min(pv, load) per TIME BUCKET, not per exact
      // timestamp. The old code joined raw PV + load samples on the exact `ts`
      // string; PV and load are sampled at different ts_utc, so the join almost
      // never matched and pvDirectKwh collapsed to all-zeros.
      //
      // Here PV and load are first bucket-integrated to kWh independently (the
      // same bucketSeriesKwh the other series use), then PV-direct is the
      // per-bucket min of those two energy arrays. min(pvBucketKwh,
      // loadBucketKwh) is the share of PV that the load could consume directly
      // within that bucket — the PV-self-consumption proxy.
      const pvKwh = bucketSeriesKwh(rows, 'pv_total_w', view, start);
      const batteryDischargeKwh = bucketSeriesKwh(rows, 'battery_discharge_w', view, start);
      const gridImportKwh = bucketSeriesKwh(rows, 'grid_import_w', view, start);
      const loadKwh = bucketSeriesKwh(rows, 'load_power_w', view, start);
      const pvDirectKwh = pvKwh.map((pvB, i) => round3(Math.min(pvB, loadKwh[i] || 0)));
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

  async function getHeatmap({ view, date, granularity } = {}) {
    const bad = validate({ view, date });
    if (bad) return bad;
    if (view === 'day') {
      return { status: 400, body: { ok: false, error: 'view not supported (heatmap is week|month|year only)' }, cached: false };
    }
    // Round-2 — optional value-axis granularity. '1h' (default) keeps the
    // hourly rows; '15min' subdivides the day axis into 96 fifteen-minute
    // slots (week/month only — year rows are day-of-month, granularity n/a).
    const gran = granularity === '15min' ? '15min' : '1h';
    // Cache key MUST include granularity so 1h and 15min payloads never collide.
    const key = `heatmap:${view}:${date}:${gran}`;
    const hit = getCached(key);
    if (hit) return { status: 200, body: { ...hit, cached: true }, cached: true };
    try {
      const { start, end } = resolveRange(view, date);
      // For 15-min week/month rows, fetch at a 15-minute SQL bucket so each
      // slot maps to one cell (the view default for week/month is '1 hour').
      const fineGran = gran === '15min' && (view === 'week' || view === 'month');
      const rows = await fetchBucketed({
        seriesKeys: ['pv_total_w'],
        start, end, view,
        intervalOverride: fineGran ? '15 minutes' : null,
      });
      let xLabels;
      let yLabels;
      let matrix;
      let domainMax = 0;
      const startMs = Date.parse(start);
      const endMs = Date.parse(end);
      if (view === 'week' || view === 'month') {
        // x = day (YYYY-MM-DD); y = hour 0..23 ('1h') OR 15-min slot 0..95
        // ('15min', labelled HH:MM); v = PV-kWh integrated.
        const days = Math.round((endMs - startMs) / 86_400_000);
        xLabels = [];
        for (let i = 0; i < days; i++) {
          const d = new Date(startMs + i * 86_400_000);
          xLabels.push(d.toISOString().slice(0, 10));
        }
        const slots = gran === '15min' ? 96 : 24;
        // slotOf(ts) → 0..(slots-1) row index for a timestamp.
        const slotOf = gran === '15min'
          ? (ts) => ts.getUTCHours() * 4 + Math.floor(ts.getUTCMinutes() / 15)
          : (ts) => ts.getUTCHours();
        yLabels = gran === '15min'
          ? Array.from({ length: 96 }, (_, i) => (
            `${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`
          ))
          : Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
        // Energy buckets: cell[xLabel][slot] kWh
        const cells = new Map(); // key=`${xLabel}:${y}` → kWh
        for (const r of rows) {
          if (r.key !== 'pv_total_w') continue;
          const w = Number(r.value);
          const dt = Number(r.resolution || 0);
          if (!Number.isFinite(w) || !Number.isFinite(dt) || dt <= 0) continue;
          const ts = new Date(r.ts);
          const xLabel = ts.toISOString().slice(0, 10);
          const y = slotOf(ts);
          const k = `${xLabel}:${y}`;
          const kwh = (w * dt) / 3_600_000;
          cells.set(k, (cells.get(k) || 0) + kwh);
        }
        matrix = [];
        for (const x of xLabels) {
          for (let y = 0; y < slots; y++) {
            const v = round3(cells.get(`${x}:${y}`) || 0);
            if (v > domainMax) domainMax = v;
            // RC-2 — cell coords MUST be the exact label strings the
            // type:'category' Chart.js scale matches by `===`.
            matrix.push({ x, y: yLabels[y], v });
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
            // RC-2 — emit cell y as the exact yLabels string (zero-padded
            // day-of-month "01".."31"); yLabels[d - 1] aligns with day d.
            matrix.push({ x: xLabel, y: yLabels[d - 1], v });
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
        granularity: gran,
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

  // Build the donut summary { autarkyPct, shares: { pvDirect, battery, grid } }
  // from a decomposed-energy-flow result (decomposeEnergyFlows output). The
  // three shares are the kWh of household load covered by each source; they
  // sum to totalLoad. autarkyPct = (pvDirect + battery) / totalLoad × 100.
  // Day-Autarky and day-Sankey agree because both run decomposeEnergyFlows.
  function autarkyDonutFromFlows(f) {
    const pvDirect = f.pvToLoad;
    const battery = f.batteryToLoad;
    const grid = f.gridToLoad;
    const totalLoad = pvDirect + battery + grid;
    const autarkyPct = totalLoad > 0
      ? Math.max(0, Math.min(100, ((pvDirect + battery) / totalLoad) * 100))
      : 0;
    return {
      autarkyPct: round1(autarkyPct),
      shares: {
        pvDirect: round3(pvDirect),
        battery: round3(battery),
        grid: round3(grid),
      },
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
      // Round-2 fix — fetch all 6 energy series so the autarky split uses the
      // SAME per-bucket decomposition as the Sankey (pvToLoad / batteryToLoad /
      // gridToLoad). Day-Autarky and day-Sankey therefore agree by construction.
      const rows = await fetchBucketed({
        seriesKeys: [
          'pv_total_w', 'grid_import_w', 'grid_export_w',
          'load_power_w', 'battery_charge_w', 'battery_discharge_w',
        ],
        start, end, view,
      });
      // --- day view → donut payload --------------------------------------
      if (view === 'day') {
        const donut = autarkyDonutFromFlows(decomposeEnergyFlows(rows));
        const payload = {
          ok: true,
          card: 'autarky-calendar',
          view,
          date,
          generatedAt: new Date().toISOString(),
          cached: false,
          mode: 'donut',
          autarkyPct: donut.autarkyPct,
          shares: donut.shares,
        };
        putCached(key, payload);
        return { status: 200, body: payload, cached: false };
      }
      // --- week / month / year → per-day calendar matrix + periodTotal ---
      // Group rows by UTC day, then decompose each day's buckets independently.
      const rowsByDay = new Map(); // YYYY-MM-DD → rows[]
      for (const r of rows) {
        const dk = new Date(r.ts).toISOString().slice(0, 10);
        if (!rowsByDay.has(dk)) rowsByDay.set(dk, []);
        rowsByDay.get(dk).push(r);
      }
      const dates = [...rowsByDay.keys()].sort();
      const matrix = [];
      for (const d of dates) {
        const donut = autarkyDonutFromFlows(decomposeEnergyFlows(rowsByDay.get(d)));
        // dow mapping: JS getUTCDay() is 0=Sunday..6=Saturday; the y-axis
        // labels are Mo=0..So=6, so shift by +6 mod 7.
        const jsDow = new Date(`${d}T12:00:00Z`).getUTCDay();
        const dowIdx = (jsDow + 6) % 7;
        matrix.push({ x: d, y: DOW_DE_SHORT[dowIdx], v: round1(donut.autarkyPct) });
      }
      // periodTotal — decompose the WHOLE range's buckets in one pass.
      const periodDonut = autarkyDonutFromFlows(decomposeEnergyFlows(rows));
      const payload = {
        ok: true,
        card: 'autarky-calendar',
        view,
        date,
        generatedAt: new Date().toISOString(),
        cached: false,
        mode: 'calendar',
        xLabels: dates,
        yLabels: DOW_DE_SHORT.slice(),
        matrix,
        domain: { min: 0, max: 100, unit: '%' },
        periodTotal: {
          autarkyPct: periodDonut.autarkyPct,
          shares: periodDonut.shares,
        },
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
      const rows = await fetchBucketed({
        seriesKeys: ['pv_total_w', 'load_power_w'],
        start, end, view,
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

  // -------------------------------------------------------------------------
  // Plan 09.3-04 Wave 4 — 3 LIVE builders (Pheat / Spaghetti / Cycles).
  // CONTEXT D-04 Gruppe B Tier-2 + D-05 (cycle-counter). Same 6-step template
  // as Waves 2-3. Spot-price columns use the verified real schema names:
  // shared.market_price_slots → slot_start (TIMESTAMPTZ), price_kind ('market'),
  // price_ct_kwh (NUMERIC) — see 009-shared-tables.sql:253-269. The plan-doc
  // assumed ts_utc + price_ct_per_kwh.
  // -------------------------------------------------------------------------

  // Battery nominal capacity (kWh) for the cycles charged/discharged kWh axis.
  // The project's canonical key is `optimizer.batteryCapacityWh` (verified in
  // config-model.js:858 + history-runtime.js batteryNominalCapacityKwh() uses
  // exactly this path). Fallback 10 kWh (typical home battery) when unset.
  function batteryNominalKwh() {
    let opt = {};
    try { opt = (getCfg && getCfg().optimizer) || {}; } catch (_) { opt = {}; }
    const wh = Number(opt.batteryCapacityWh);
    if (Number.isFinite(wh) && wh > 0) return wh / 1000;
    return 10;
  }

  // Cumulative |ΔSOC| / 200 — the project-canonical "Vollzyklen" formula
  // (RESEARCH §Cycle-Counter Algorithm). One full cycle = 200% absolute SOC
  // change (100% discharge + 100% charge); /100 converts pct→fraction. This is
  // equivalent to the discharge-energy/capacity formula `computeCycles()` used
  // by the existing kpis.cycles tile in history-runtime.js — both produce a
  // full-cycle count; this one operates directly on the SOC series.
  function countCyclesFromSocSeries(socSeries) {
    if (!Array.isArray(socSeries) || socSeries.length < 2) return 0;
    let cumDelta = 0;
    for (let i = 1; i < socSeries.length; i++) {
      const a = Number(socSeries[i - 1].value);
      const b = Number(socSeries[i].value);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      cumDelta += Math.abs(b - a);
    }
    return cumDelta / 200;
  }

  async function getPheat({ view, date } = {}) {
    const bad = validate({ view, date });
    if (bad) return bad;
    const key = `pheat:${view}:${date}`;
    const hit = getCached(key);
    if (hit) return { status: 200, body: { ...hit, cached: true }, cached: true };
    try {
      const { start, end } = resolveRange(view, date);
      // dow×hour average spot price. Bucket server-side via EXTRACT in the
      // Europe/Berlin zone (a SQL literal, not user input — T-09.3-19); the
      // BETWEEN bounds are parameterized. PG-DOW: 0=Sunday..6=Saturday.
      const sql = `
        SELECT
          EXTRACT(DOW  FROM slot_start AT TIME ZONE 'Europe/Berlin') AS dow,
          EXTRACT(HOUR FROM slot_start AT TIME ZONE 'Europe/Berlin') AS hr,
          AVG(price_ct_kwh) AS avg_ct
        FROM shared.market_price_slots
        WHERE price_kind = 'market'
          AND slot_start >= $1::timestamptz
          AND slot_start <  $2::timestamptz
        GROUP BY dow, hr
        ORDER BY dow, hr
      `;
      let rows = [];
      if (db && typeof db.query === 'function') {
        const result = await db.query(sql, [start, end]);
        rows = (result && Array.isArray(result.rows)) ? result.rows : [];
      }
      // Build a full 7×24 grid (matrix is always 168 cells, gaps → 0).
      const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
      let domainMax = 0;
      for (const r of rows) {
        const pgDow = Math.trunc(Number(r.dow));
        const hr = Math.trunc(Number(r.hr));
        const avg = Number(r.avg_ct);
        if (!Number.isFinite(pgDow) || !Number.isFinite(hr) || hr < 0 || hr > 23) continue;
        // PG-DOW 0=Sun..6=Sat → German Mo=0..So=6.
        const dowIdx = (pgDow + 6) % 7;
        if (dowIdx < 0 || dowIdx > 6) continue;
        const v = Number.isFinite(avg) ? Math.max(0, avg) : 0;
        grid[dowIdx][hr] = round3(v);
        if (v > domainMax) domainMax = v;
      }
      // RC-2 — cell x/y MUST be the exact label strings the type:'category'
      // Chart.js scale matches by `===`. xLabels = zero-padded hour strings,
      // yLabels = German DOW labels.
      const xLabels = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
      const yLabels = DOW_DE_SHORT.slice();
      const matrix = [];
      for (let y = 0; y < 7; y++) {
        for (let x = 0; x < 24; x++) {
          matrix.push({ x: xLabels[x], y: yLabels[y], v: grid[y][x] });
        }
      }
      const payload = {
        ok: true,
        card: 'pheat',
        view,
        date,
        generatedAt: new Date().toISOString(),
        cached: false,
        xLabels,
        yLabels,
        matrix,
        domain: { min: 0, max: round3(domainMax), unit: 'ct/kWh' },
      };
      putCached(key, payload);
      return { status: 200, body: payload, cached: false };
    } catch (e) {
      if (typeof pushLog === 'function') pushLog('history_viz_pheat_error', { error: e.message, view, date });
      return { status: 500, body: { ok: false, error: e.message }, cached: false };
    }
  }

  async function getSpaghetti({ view, date } = {}) {
    const bad = validate({ view, date });
    if (bad) return bad;
    if (view === 'day') {
      return { status: 400, body: { ok: false, error: 'view not supported (spaghetti is week|month|year only)' }, cached: false };
    }
    const key = `spaghetti:${view}:${date}`;
    const hit = getCached(key);
    if (hit) return { status: 200, body: { ...hit, cached: true }, cached: true };
    try {
      const { start, end } = resolveRange(view, date);
      // RESEARCH §Pitfall 5 — ONE bucketed query for the full range; group in
      // JS by date. battery_soc_pct is a percentage series, so it is fetched as
      // the per-bucket MEAN (meanSeries) — an energy integral is meaningless
      // for a ratio. SQL-side time_bucket caps the row count (RC-1).
      const rows = await fetchBucketed({
        seriesKeys: ['battery_soc_pct'],
        start, end, view,
        meanSeries: ['battery_soc_pct'],
      });
      // todayDate: the anchor `date` (the day the user is "viewing now").
      const todayDate = date;
      let series;
      if (view === 'year') {
        // Round-2 fix — year view aggregates SOC to ISO calendar week. One day
        // per line over a year is hundreds of sparse lines; instead emit ~52
        // lines, each = the average 24h SOC profile across that week's days.
        // groupKey = ISO `${year}-W${week}` so weeks never collide year-over-year.
        const byWeek = new Map(); // isoKey → { week, sums:[24], counts:[24] }
        for (const r of rows) {
          if (r.key !== 'battery_soc_pct') continue;
          const v = Number(r.value);
          if (!Number.isFinite(v)) continue;
          const d = new Date(r.ts);
          const { year, week } = isoWeek(d);
          const isoKey = `${year}-W${String(week).padStart(2, '0')}`;
          const h = d.getUTCHours();
          if (!byWeek.has(isoKey)) {
            byWeek.set(isoKey, { week, sums: new Array(24).fill(0), counts: new Array(24).fill(0) });
          }
          const bucket = byWeek.get(isoKey);
          bucket.sums[h] += v;
          bucket.counts[h] += 1;
        }
        const weekKeys = [...byWeek.keys()].sort();
        series = weekKeys.map((isoKey) => {
          const bucket = byWeek.get(isoKey);
          const points = [];
          for (let h = 0; h < 24; h++) {
            const soc = bucket.counts[h] > 0 ? round1(bucket.sums[h] / bucket.counts[h]) : 0;
            points.push({ h, soc });
          }
          return { date: isoKey, label: `KW ${bucket.week}`, isToday: false, points };
        });
      } else {
        // week / month → one line per UTC day; per-day bucket into 24 hourly slots.
        const byDate = new Map(); // dateKey → { sums:[24], counts:[24] }
        for (const r of rows) {
          if (r.key !== 'battery_soc_pct') continue;
          const v = Number(r.value);
          if (!Number.isFinite(v)) continue;
          const d = new Date(r.ts);
          const dateKey = d.toISOString().slice(0, 10);
          const h = d.getUTCHours();
          if (!byDate.has(dateKey)) {
            byDate.set(dateKey, { sums: new Array(24).fill(0), counts: new Array(24).fill(0) });
          }
          const bucket = byDate.get(dateKey);
          bucket.sums[h] += v;
          bucket.counts[h] += 1;
        }
        // Most-recent 30 days, sorted ascending by date.
        const allDates = [...byDate.keys()].sort();
        const recentDates = allDates.slice(-30);
        series = recentDates.map((dateKey) => {
          const bucket = byDate.get(dateKey);
          const points = [];
          for (let h = 0; h < 24; h++) {
            const soc = bucket.counts[h] > 0 ? round1(bucket.sums[h] / bucket.counts[h]) : 0;
            points.push({ h, soc });
          }
          return { date: dateKey, isToday: dateKey === todayDate, points };
        });
      }
      const payload = {
        ok: true,
        card: 'spaghetti',
        view,
        date,
        generatedAt: new Date().toISOString(),
        cached: false,
        series,
        todayDate,
      };
      putCached(key, payload);
      return { status: 200, body: payload, cached: false };
    } catch (e) {
      if (typeof pushLog === 'function') pushLog('history_viz_spaghetti_error', { error: e.message, view, date });
      return { status: 500, body: { ok: false, error: e.message }, cached: false };
    }
  }

  async function getCycles({ view, date } = {}) {
    const bad = validate({ view, date });
    if (bad) return bad;
    if (view === 'day') {
      return { status: 400, body: { ok: false, error: 'view not supported (cycles is week|month|year only)' }, cached: false };
    }
    const key = `cycles:${view}:${date}`;
    const hit = getCached(key);
    if (hit) return { status: 200, body: { ...hit, cached: true }, cached: true };
    try {
      const { start, end } = resolveRange(view, date);
      // battery_soc_pct is a percentage — fetch the per-bucket MEAN (meanSeries),
      // not an energy integral. SQL-side time_bucket caps the row count (RC-1);
      // the cycle counter then walks the downsampled SOC series.
      const rows = await fetchBucketed({
        seriesKeys: ['battery_soc_pct'],
        start, end, view,
        meanSeries: ['battery_soc_pct'],
      });
      // Sort SOC samples by ts, then group by German DOW (Mo=0..So=6).
      const socRows = rows
        .filter((r) => r.key === 'battery_soc_pct' && Number.isFinite(Number(r.value)))
        .map((r) => ({ ts: r.ts, tsMs: Date.parse(r.ts), value: Number(r.value) }))
        .filter((r) => Number.isFinite(r.tsMs))
        .sort((a, b) => a.tsMs - b.tsMs);
      const capKwh = batteryNominalKwh();
      // Per-DOW SOC sub-series. A cycle/energy delta belongs to the DOW of the
      // LATER sample in each consecutive pair (the delta "completes" on that
      // day). Iterate the global sorted series so transitions across midnight
      // are still counted; attribute each ΔSOC to the receiving sample's DOW.
      const perDowCycles = new Array(7).fill(0);
      const perDowCharged = new Array(7).fill(0);   // kWh (positive ΔSOC)
      const perDowDischarged = new Array(7).fill(0); // kWh (abs of negative ΔSOC)
      for (let i = 1; i < socRows.length; i++) {
        const prev = socRows[i - 1];
        const cur = socRows[i];
        const dSoc = cur.value - prev.value; // +ve = charge, -ve = discharge
        const jsDow = new Date(cur.tsMs).getUTCDay(); // 0=Sun..6=Sat
        const dowIdx = (jsDow + 6) % 7;               // Mo=0..So=6
        perDowCycles[dowIdx] += Math.abs(dSoc) / 200; // cumulative |ΔSOC|/200
        const kwh = (Math.abs(dSoc) / 100) * capKwh;  // ΔSOC fraction × capacity
        if (dSoc >= 0) perDowCharged[dowIdx] += kwh;
        else perDowDischarged[dowIdx] += kwh;
      }
      const perDow = [];
      for (let d = 0; d < 7; d++) {
        perDow.push({
          dow: d,
          label: DOW_DE_SHORT[d],
          chargedKwh: round3(perDowCharged[d]),
          dischargedKwh: round3(perDowDischarged[d]),
          cycles: round3(perDowCycles[d]),
        });
      }
      const totals = {
        chargedKwh: round3(perDow.reduce((s, x) => s + x.chargedKwh, 0)),
        dischargedKwh: round3(perDow.reduce((s, x) => s + x.dischargedKwh, 0)),
        cycles: round3(perDow.reduce((s, x) => s + x.cycles, 0)),
      };
      const payload = {
        ok: true,
        card: 'cycles',
        view,
        date,
        generatedAt: new Date().toISOString(),
        cached: false,
        perDow,
        totals,
      };
      putCached(key, payload);
      return { status: 200, body: payload, cached: false };
    } catch (e) {
      if (typeof pushLog === 'function') pushLog('history_viz_cycles_error', { error: e.message, view, date });
      return { status: 500, body: { ok: false, error: e.message }, cached: false };
    }
  }

  // -------------------------------------------------------------------------
  // Plan 09.3-05 Wave 5 — 3 LIVE builders (Top10 / CalYear / Scatter).
  // CONTEXT D-05 (Top10 / Cal-Year) + D-06 (14th card — Wetter×Erlös-Scatter).
  //
  // SCHEMA NOTE (T-09.3-21): the plan-doc's `optimizer_runs` assumption is
  // WRONG. `public.optimizer_runs` is a run-metadata table (run_started_at /
  // status / result_json) with NO revenue_eur / cost_eur / ts / action / kwh /
  // price_ct_per_kwh columns. The per-slot economic data lives in
  // `opt.plan_slots` — slot_start (TIMESTAMPTZ), grid_import_wh, grid_export_wh
  // (BIGINT), expected_profit_eur (NUMERIC) — exactly the table the live
  // `getLedger` builder (Wave 2) already queries, joined to
  // shared.market_price_slots.price_ct_kwh. All 3 Wave-5 builders mirror that
  // verified getLedger schema path. "Revenue" per slot = expected_profit_eur
  // (the optimizer's per-slot economic outcome); daily "net-€" = SUM of it.
  // -------------------------------------------------------------------------

  // Action heuristic shared with getLedger: net export → sell, net import →
  // buy, both ~0 → hold. kWh = max(import, export)/1000.
  function slotActionAndKwh(importWh, exportWh) {
    let action = 'hold';
    if (exportWh > importWh && exportWh > 0) action = 'sell';
    else if (importWh > exportWh && importWh > 0) action = 'buy';
    const kwh = Math.max(importWh, exportWh) / 1000;
    return { action, kwh };
  }

  // Pearson correlation coefficient between two equal-length numeric arrays.
  // Returns 0 when n < 2 or either series has zero variance (avoids NaN).
  function pearsonR(xs, ys) {
    const n = Math.min(xs.length, ys.length);
    if (n < 2) return 0;
    let sx = 0, sy = 0, sxy = 0, sx2 = 0, sy2 = 0;
    for (let i = 0; i < n; i++) {
      const x = Number(xs[i]);
      const y = Number(ys[i]);
      sx += x; sy += y; sxy += x * y; sx2 += x * x; sy2 += y * y;
    }
    const num = n * sxy - sx * sy;
    const den = Math.sqrt((n * sx2 - sx * sx) * (n * sy2 - sy * sy));
    if (!Number.isFinite(den) || den === 0) return 0;
    return num / den;
  }

  async function getTop10({ view, date } = {}) {
    const bad = validate({ view, date });
    if (bad) return bad;
    // Top-10 is a period roll-up — a single day has at most ~96 slots and the
    // "top 10 of the period" framing only makes sense for week|month|year.
    if (view === 'day') {
      return { status: 400, body: { ok: false, error: 'view not supported (top10 is week|month|year only)' }, cached: false };
    }
    const key = `top10:${view}:${date}`;
    const hit = getCached(key);
    if (hit) return { status: 200, body: { ...hit, cached: true }, cached: true };
    try {
      const { start, end } = resolveRange(view, date);
      // The 10 highest-profit sell slots in the period. opt.plan_slots holds
      // grid_import_wh / grid_export_wh / expected_profit_eur per slot; join
      // shared.market_price_slots for the spot price. T-09.3-21: parameterized
      // BETWEEN bounds; ORDER BY ... DESC LIMIT 10 server-side. T-09.3-22: the
      // exact slot ts is already exposed via getLedger / the Spot-Ledger card.
      const sql = `
        SELECT
          ps.slot_start,
          ps.grid_import_wh,
          ps.grid_export_wh,
          ps.expected_profit_eur,
          mps.price_ct_kwh
        FROM opt.plan_slots ps
        LEFT JOIN shared.market_price_slots mps
          ON mps.slot_start = ps.slot_start
         AND mps.price_kind = 'market'
        WHERE ps.slot_start >= $1::timestamptz
          AND ps.slot_start <  $2::timestamptz
          AND ps.grid_export_wh > ps.grid_import_wh
        ORDER BY ps.expected_profit_eur DESC NULLS LAST
        LIMIT 10
      `;
      let rows = [];
      if (db && typeof db.query === 'function') {
        const result = await db.query(sql, [start, end]);
        rows = (result && Array.isArray(result.rows)) ? result.rows : [];
      }
      // Defensive re-sort DESC + re-cap in case the adapter ignored ORDER/LIMIT.
      const slots = rows
        .map((row) => {
          const importWh = Number(row.grid_import_wh) || 0;
          const exportWh = Number(row.grid_export_wh) || 0;
          const { action, kwh } = slotActionAndKwh(importWh, exportWh);
          return {
            ts: typeof row.slot_start === 'string' ? row.slot_start : new Date(row.slot_start).toISOString(),
            action,
            kwh: round3(kwh),
            priceCt: round3(Number(row.price_ct_kwh) || 0),
            revenueEur: round3(Number(row.expected_profit_eur) || 0),
          };
        })
        .sort((a, b) => b.revenueEur - a.revenueEur)
        .slice(0, 10);
      const totalEur = round3(slots.reduce((s, x) => s + x.revenueEur, 0));
      const payload = {
        ok: true,
        card: 'top10',
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
      if (typeof pushLog === 'function') pushLog('history_viz_top10_error', { error: e.message, view, date });
      return { status: 500, body: { ok: false, card: 'top10', error: e.message }, cached: false };
    }
  }

  async function getCalYear({ view, date } = {}) {
    const bad = validate({ view, date });
    if (bad) return bad;
    if (view !== 'year') {
      return { status: 400, body: { ok: false, error: 'view not supported (cal-year is year-only)' }, cached: false };
    }
    const key = `cal-year:${view}:${date}`;
    const hit = getCached(key);
    if (hit) return { status: 200, body: { ...hit, cached: true }, cached: true };
    try {
      const { start, end } = resolveRange(view, date);
      // Per-day signed net-€ over the 12-month window. expected_profit_eur is
      // the optimizer's per-slot economic outcome (already signed: a slot that
      // costs money carries a negative value), so SUM per day yields a signed
      // daily net. date_trunc to UTC day; the matrix is plotted month×day.
      const sql = `
        SELECT
          to_char(date_trunc('day', slot_start AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS d,
          SUM(expected_profit_eur) AS net_eur
        FROM opt.plan_slots
        WHERE slot_start >= $1::timestamptz
          AND slot_start <  $2::timestamptz
        GROUP BY 1
        ORDER BY 1
      `;
      let rows = [];
      if (db && typeof db.query === 'function') {
        const result = await db.query(sql, [start, end]);
        rows = (result && Array.isArray(result.rows)) ? result.rows : [];
      }
      // x = month short label (Jan..Dez), y = day-of-month-1 (0..30).
      // RESEARCH Q2 — the matrix plugin tolerates arbitrary x-label arrays, so
      // short months simply leave their high-y cells absent (leap years OK).
      const xLabels = MONTH_DE_SHORT.slice();
      const yLabels = Array.from({ length: 31 }, (_, i) => String(i + 1));
      const matrix = [];
      let minVal = 0;
      let maxVal = 0;
      for (const row of rows) {
        const d = String(row.d || '');
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
        if (!m) continue;
        const monthIdx = parseInt(m[2], 10) - 1; // 0..11
        const dayIdx = parseInt(m[3], 10) - 1;   // 0..30
        if (monthIdx < 0 || monthIdx > 11 || dayIdx < 0 || dayIdx > 30) continue;
        const v = round3(Number(row.net_eur) || 0);
        if (v < minVal) minVal = v;
        if (v > maxVal) maxVal = v;
        // RC-2 — emit cell y as the exact yLabels string ("1".."31"); the
        // type:'category' scale matches xLabels/yLabels by `===`. yLabels[dayIdx]
        // is the day-of-month label for dayIdx (0-based).
        matrix.push({ x: xLabels[monthIdx], y: yLabels[dayIdx], v });
      }
      // Force 0 into the domain so the diverging palette has a true midpoint
      // (red below 0, faded at 0, green above 0). domain straddles 0 even when
      // every observed day happens to be the same sign.
      const payload = {
        ok: true,
        card: 'cal-year',
        view,
        date,
        generatedAt: new Date().toISOString(),
        cached: false,
        xLabels,
        yLabels,
        matrix,
        domain: { min: Math.min(0, minVal), max: Math.max(0, maxVal), unit: '€' },
      };
      putCached(key, payload);
      return { status: 200, body: payload, cached: false };
    } catch (e) {
      if (typeof pushLog === 'function') pushLog('history_viz_cal_year_error', { error: e.message, view, date });
      return { status: 500, body: { ok: false, card: 'cal-year', error: e.message }, cached: false };
    }
  }

  async function getScatter({ view, date } = {}) {
    const bad = validate({ view, date });
    if (bad) return bad;
    if (view === 'day') {
      return { status: 400, body: { ok: false, error: 'view not supported (scatter is week|month|year only)' }, cached: false };
    }
    const key = `scatter:${view}:${date}`;
    const hit = getCached(key);
    if (hit) return { status: 200, body: { ...hit, cached: true }, cached: true };
    // MANDATORY try/catch + pushLog wrapper (Test W5-9 / T-09.3-21). On ANY
    // thrown exception — e.g. a missing-column SQLSTATE 42703 from schema
    // drift — catch, log via pushLog, and return a structured 500 envelope.
    // NEVER let an exception escape. This is the SQL-throw path; it is NOT the
    // same as the 0-rows path below (which returns 200 weatherDataAvailable
    // false). Matches the error-envelope shape used by every other builder.
    try {
      const { start, end } = resolveRange(view, date);
      // Daily net-€ (from opt.plan_slots) JOIN daily-mean GHI (from
      // weather_forecasts, ghi_wm2 IS NOT NULL) + daily autarky %. The INNER
      // JOIN means days with no GHI row are omitted (T-09.3-24 graceful path).
      // T-09.3-23 — both CTEs are daily-aggregated so the JOIN caps at ~365
      // rows per side regardless of slot resolution.
      const sql = `
        WITH daily_net AS (
          SELECT
            to_char(date_trunc('day', slot_start AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS d,
            SUM(expected_profit_eur) AS net_eur,
            SUM(grid_import_wh) AS import_wh,
            SUM(grid_export_wh + battery_discharge_load_wh) AS supply_wh
          FROM opt.plan_slots
          WHERE slot_start >= $1::timestamptz
            AND slot_start <  $2::timestamptz
          GROUP BY 1
        ),
        daily_weather AS (
          SELECT
            to_char(date_trunc('day', ts_utc AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS d,
            AVG(ghi_wm2) AS ghi
          FROM weather_forecasts
          WHERE ts_utc >= $1::timestamptz
            AND ts_utc <  $2::timestamptz
            AND ghi_wm2 IS NOT NULL
          GROUP BY 1
        )
        SELECT
          n.d,
          w.ghi,
          n.net_eur,
          n.import_wh,
          n.supply_wh
        FROM daily_net n
        JOIN daily_weather w ON w.d = n.d
        ORDER BY n.d
      `;
      let rows = [];
      if (db && typeof db.query === 'function') {
        const result = await db.query(sql, [start, end]);
        rows = (result && Array.isArray(result.rows)) ? result.rows : [];
      }
      // 0-rows path (T-09.3-24): no weather backfill yet → 200, not 500.
      if (rows.length === 0) {
        const emptyPayload = {
          ok: true,
          card: 'scatter',
          view,
          date,
          generatedAt: new Date().toISOString(),
          cached: false,
          points: [],
          correlation: { r: 0, n: 0 },
          weatherDataAvailable: false,
        };
        putCached(key, emptyPayload);
        return { status: 200, body: emptyPayload, cached: false };
      }
      const points = [];
      for (const row of rows) {
        const ghi = Number(row.ghi);
        if (!Number.isFinite(ghi)) continue; // defensive — JOIN should exclude
        const netEur = round3(Number(row.net_eur) || 0);
        // Autarky % per day. The test double supplies autarky_pct directly;
        // the production SQL computes it from supply vs (supply + import).
        let autarkyPct;
        if (Number.isFinite(Number(row.autarky_pct))) {
          autarkyPct = Math.max(0, Math.min(100, Math.round(Number(row.autarky_pct))));
        } else {
          const importWh = Number(row.import_wh) || 0;
          const supplyWh = Number(row.supply_wh) || 0;
          const totalWh = supplyWh + importWh;
          autarkyPct = totalWh > 0
            ? Math.max(0, Math.min(100, Math.round((supplyWh / totalWh) * 100)))
            : 0;
        }
        points.push({
          date: String(row.d || ''),
          ghi: round1(ghi),
          netEur,
          autarkyPct,
        });
      }
      const r = round3(pearsonR(points.map((p) => p.ghi), points.map((p) => p.netEur)));
      const payload = {
        ok: true,
        card: 'scatter',
        view,
        date,
        generatedAt: new Date().toISOString(),
        cached: false,
        points,
        correlation: { r, n: points.length },
        weatherDataAvailable: points.length > 0,
      };
      putCached(key, payload);
      return { status: 200, body: payload, cached: false };
    } catch (e) {
      // SQL-throw path (Test W5-9): structured 500 envelope, never cached,
      // pushLog the underlying error. The envelope error string is the fixed
      // 'aggregator failed' marker the contract test asserts.
      if (typeof pushLog === 'function') {
        pushLog('history-viz', 'scatter aggregator failed', e);
      }
      return {
        status: 500,
        body: { ok: false, card: 'scatter', error: 'aggregator failed', cached: false },
        cached: false,
      };
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
    getPheat,
    getSpaghetti,
    getCycles,
    getTop10,
    getCalYear,
    getScatter,
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
