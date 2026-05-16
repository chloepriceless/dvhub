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
  // Plan 09.4-A — EPEX spot price source.
  //
  // The Phase-08.1 `shared.market_price_slots` table is 0 rows on prod —
  // nothing ever populated it (no `INSERT INTO shared.market_price` anywhere
  // in the codebase). The live EPEX prices land in `public.timeseries_samples`
  // via epex-fetch.js → buildPriceTelemetrySamples → telemetryStore.writeSamples
  // as `series_key='price_ct_kwh'` (forecast scope) + the price_backfill job
  // (history scope) — ~25k rows / 359 days. `price_ct_kwh` is a ratio series
  // (ct/kWh), NOT energy, so consumers take the per-slot value / AVG directly —
  // never a W×Δt integral.
  //
  // priceRowsSql() — parameterized SELECT mirroring the old market_price_slots
  // query 1:1: `slot_start`→`ts_utc`, `price_ct_kwh` is the row column name
  // `value_num` aliased back to `price_ct_kwh` so callers' row handling is
  // unchanged. No `price_kind` filter — `series_key='price_ct_kwh'` is the
  // selector. Both scopes (forecast + history) are included so the full
  // 359-day window is covered.
  const PRICE_SERIES_KEY = 'price_ct_kwh';
  function priceRowsSql() {
    return `
      SELECT value_num AS price_ct_kwh
      FROM timeseries_samples
      WHERE series_key = '${PRICE_SERIES_KEY}'
        AND value_num IS NOT NULL
        AND ts_utc >= $1::timestamptz
        AND ts_utc <  $2::timestamptz
      ORDER BY value_num DESC
    `;
  }

  // -------------------------------------------------------------------------
  // Resolve the optimizer's "charge battery from grid" permission. This is the
  // EEG/§14a-relevant `optimizer.allowGridCharge` flag (a flat-rate / Pauschal-
  // tariff feature). Default OFF — matches schedule-eval.js:
  // `cfg.optimizer?.allowGridCharge ?? false`.
  //
  // It governs energy-flow ATTRIBUTION in the Sankey / Autarky-donut: when the
  // setting is OFF, the battery is charged from PV only and ALL grid import
  // serves self-consumption — there is no Netzbezug→Akku-Laden flow.
  function isGridChargeAllowed() {
    let opt = {};
    try { opt = (getCfg && getCfg().optimizer) || {}; } catch (_) { opt = {}; }
    return opt.allowGridCharge === true;
  }

  // -------------------------------------------------------------------------
  // Plan 09.3 / 09.4 — energy-flow decomposition.
  //
  // The Sankey / Autarky-day builders must conserve energy. Two attribution
  // modes, selected by `gridChargeAllowed`:
  //
  //  A) gridChargeAllowed === false (DEFAULT):
  //     The battery is charged ONLY from PV and ALL grid import serves self-
  //     consumption — there is NO Netzbezug→Akku-Laden flow. We use a single
  //     PERIOD-TOTAL decomposition with PV-priority (PV → load, then battery,
  //     then export; battery → load, then export; grid → load only). This
  //     conserves cleanly and avoids the per-bucket `batteryCharge − pvToBattery`
  //     residual that the per-bucket path mislabels as grid→battery.
  //
  //  B) gridChargeAllowed === true (flat-rate / Pauschal tariff):
  //     Grid→battery charging is legitimate. We keep the per-bucket
  //     decomposition: with a grid-arbitrage battery `batteryCharge +
  //     gridExport` can exceed `pv` over a PERIOD total, so a period-level
  //     `pvToEigen = pv − export − charge` clamps to 0 and overshoots total
  //     PV. Per-bucket decomposition cannot overshoot — within a bucket
  //     PV-out = pv, into-load = load — and surfaces the grid→battery residual.
  //
  // Both modes return the same 7-flow shape + totals; only the attribution of
  // battery charging and grid import changes.
  //
  // `rows` is the fetchBucketed output for the 6 energy series; this groups
  // them by bucket ts, integrates W×Δt → kWh per bucket, then decomposes.
  function decomposeEnergyFlows(rows, gridChargeAllowed = false) {
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
    // Guard tiny negatives from floating-point rounding.
    const clamp0 = (n) => (n > 0 ? n : 0);

    if (!gridChargeAllowed) {
      // --- DEFAULT: period-total PV-priority decomposition ------------------
      // No Netzbezug→Akku-Laden flow. Battery charge is attributed to PV; all
      // grid import serves the household load (Netzbezug→Eigenverbrauch).
      let totalPv = 0;
      let totalLoad = 0;
      let totalCharge = 0;
      let totalDischarge = 0;
      for (const b of buckets.values()) {
        totalPv += b.pv;
        totalLoad += b.load;
        totalCharge += b.batteryCharge;
        totalDischarge += b.batteryDischarge;
      }
      totalPv = clamp0(totalPv);
      totalLoad = clamp0(totalLoad);
      totalCharge = clamp0(totalCharge);
      totalDischarge = clamp0(totalDischarge);
      // PV-priority: PV → load, then battery, then export.
      const pvToLoad = Math.min(totalPv, totalLoad);
      const pvAfterLoad = totalPv - pvToLoad;
      const pvToBattery = Math.min(pvAfterLoad, totalCharge);
      const pvToExport = pvAfterLoad - pvToBattery;
      // Battery → load, then export.
      const loadAfterPv = totalLoad - pvToLoad;
      const batteryToLoad = Math.min(totalDischarge, loadAfterPv);
      const batteryToExport = totalDischarge - batteryToLoad;
      // Grid covers the remaining load only — never the battery.
      const gridToLoad = loadAfterPv - batteryToLoad;
      return {
        pvToLoad: clamp0(pvToLoad),
        pvToBattery: clamp0(pvToBattery),
        pvToExport: clamp0(pvToExport),
        gridToBattery: 0,
        batteryToLoad: clamp0(batteryToLoad),
        batteryToExport: clamp0(batteryToExport),
        gridToLoad: clamp0(gridToLoad),
        totalPv,
        totalLoad,
      };
    }

    // --- gridChargeAllowed: per-bucket decomposition (grid→battery legit) ---
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
      // Plan 09.4 — energy-flow attribution depends on optimizer.allowGridCharge.
      // DEFAULT (flag OFF): the battery is charged from PV only and ALL grid
      // import serves self-consumption — NO Netzbezug→Akku-Laden flow. A
      // period-total PV-priority decomposition conserves cleanly here.
      // Flag ON (flat-rate / Pauschal tariff): grid→battery charging is
      // legitimate — the per-bucket decomposition surfaces that residual.
      // Either way the Sankey self-conserves (it does not use the meter's
      // grid_import/grid_export for flows — the meter is its own measurement).
      const gridChargeAllowed = isGridChargeAllowed();
      const f = decomposeEnergyFlows(rows, gridChargeAllowed);
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
      // Plan 09.4 — fetch the EPEX spot price alongside PV in the SAME bucketed
      // query so the per-bucket mean price is aligned 1:1 with the PV buckets
      // (same bucketInterval). `price_ct_kwh` is a ratio series → meanSeries, so
      // its `value` carries the plain per-bucket AVG, not an energy integral.
      const rows = await fetchBucketed({
        seriesKeys: ['pv_total_w', PRICE_SERIES_KEY],
        start, end, view,
        meanSeries: [PRICE_SERIES_KEY],
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
        // Plan 09.4 — price buckets: per-cell running mean of the EPEX spot
        // price (ct/kWh). `priceCells` accumulates {sum,count}; a cell's mean
        // price < 0 → `neg` true → curtailment overlay on the frontend.
        const priceCells = new Map(); // key=`${xLabel}:${y}` → { sum, count }
        for (const r of rows) {
          const ts = new Date(r.ts);
          const xLabel = ts.toISOString().slice(0, 10);
          const y = slotOf(ts);
          const k = `${xLabel}:${y}`;
          if (r.key === PRICE_SERIES_KEY) {
            const p = Number(r.value);
            if (!Number.isFinite(p)) continue;
            const pc = priceCells.get(k) || { sum: 0, count: 0 };
            pc.sum += p;
            pc.count += 1;
            priceCells.set(k, pc);
            continue;
          }
          if (r.key !== 'pv_total_w') continue;
          const w = Number(r.value);
          const dt = Number(r.resolution || 0);
          if (!Number.isFinite(w) || !Number.isFinite(dt) || dt <= 0) continue;
          const kwh = (w * dt) / 3_600_000;
          cells.set(k, (cells.get(k) || 0) + kwh);
        }
        matrix = [];
        for (const x of xLabels) {
          for (let y = 0; y < slots; y++) {
            const k = `${x}:${y}`;
            const v = round3(cells.get(k) || 0);
            if (v > domainMax) domainMax = v;
            const pc = priceCells.get(k);
            const neg = !!(pc && pc.count > 0 && pc.sum / pc.count < 0);
            // RC-2 — cell coords MUST be the exact label strings the
            // type:'category' Chart.js scale matches by `===`.
            matrix.push({ x, y: yLabels[y], v, neg });
          }
        }
      } else { // view === 'year'
        // x = month label (Jan..Dez), y = day-of-month 1..31, v = daily PV-kWh.
        // Note: cells outside actual month length stay 0; client treats as empty.
        xLabels = bucketLabelsForView('year', start);
        yLabels = Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, '0'));
        const cells = new Map(); // key=`${monthIdx}:${day}` → kWh
        // Plan 09.4 — per-cell mean spot price (see week/month branch).
        const priceCells = new Map(); // key=`${monthIdx}:${day}` → { sum, count }
        const startDate = new Date(start);
        const startY = startDate.getUTCFullYear();
        const startM = startDate.getUTCMonth();
        for (const r of rows) {
          const ts = new Date(r.ts);
          const monthIdx = (ts.getUTCFullYear() - startY) * 12 + (ts.getUTCMonth() - startM);
          if (monthIdx < 0 || monthIdx > 11) continue;
          const day = ts.getUTCDate();
          const k = `${monthIdx}:${day}`;
          if (r.key === PRICE_SERIES_KEY) {
            const p = Number(r.value);
            if (!Number.isFinite(p)) continue;
            const pc = priceCells.get(k) || { sum: 0, count: 0 };
            pc.sum += p;
            pc.count += 1;
            priceCells.set(k, pc);
            continue;
          }
          if (r.key !== 'pv_total_w') continue;
          const w = Number(r.value);
          const dt = Number(r.resolution || 0);
          if (!Number.isFinite(w) || !Number.isFinite(dt) || dt <= 0) continue;
          const kwh = (w * dt) / 3_600_000;
          cells.set(k, (cells.get(k) || 0) + kwh);
        }
        matrix = [];
        for (let m = 0; m < 12; m++) {
          const xLabel = xLabels[m];
          for (let d = 1; d <= 31; d++) {
            const k = `${m}:${d}`;
            const v = round3(cells.get(k) || 0);
            if (v > domainMax) domainMax = v;
            const pc = priceCells.get(k);
            const neg = !!(pc && pc.count > 0 && pc.sum / pc.count < 0);
            // RC-2 — emit cell y as the exact yLabels string (zero-padded
            // day-of-month "01".."31"); yLabels[d - 1] aligns with day d.
            matrix.push({ x: xLabel, y: yLabels[d - 1], v, neg });
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
      // NOTE (Plan 09.4): the Spot-Ledger card was removed from the frontend
      // (public/history-viz.js — the `ledger` slug is intentionally absent), so
      // this builder is dead code on the request path and was NOT re-pointed in
      // 09.4. Its SQL still references the Phase-08.1 multi-schema tables
      // `opt.plan_slots` / `shared.market_price_slots`, which are 0 rows on prod
      // — nothing ever populated them. The earlier "verified column names"
      // claims against migrations 011/009 were schema-shape checks only; the
      // tables were never written to. If the Ledger card is ever revived,
      // re-point it the same way as getTop10 (dispatchSlotsCte()).
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
  // putCached). Plan 09.4-A — spot prices for ring + duration come from
  // `public.timeseries_samples` (series_key='price_ct_kwh', columns ts_utc +
  // value_num) via priceRowsSql(). The earlier `shared.market_price_slots`
  // source was never populated on prod (0 rows); the multi-schema table was
  // created additively and its cutover deferred.
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
      // SAME decomposition as the Sankey (pvToLoad / batteryToLoad /
      // gridToLoad). Day-Autarky and day-Sankey therefore agree by construction.
      const rows = await fetchBucketed({
        seriesKeys: [
          'pv_total_w', 'grid_import_w', 'grid_export_w',
          'load_power_w', 'battery_charge_w', 'battery_discharge_w',
        ],
        start, end, view,
      });
      // Plan 09.4 — the autarky donut follows the SAME grid-charge rule as the
      // Sankey: with optimizer.allowGridCharge OFF (default) ALL grid import is
      // a load source (grid share), the battery is PV-charged, and autarky =
      // (pvDirect + battery) / load. Pass the flag so both agree.
      const gridChargeAllowed = isGridChargeAllowed();
      // --- day view → donut payload --------------------------------------
      if (view === 'day') {
        const donut = autarkyDonutFromFlows(decomposeEnergyFlows(rows, gridChargeAllowed));
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
        const donut = autarkyDonutFromFlows(decomposeEnergyFlows(rowsByDay.get(d), gridChargeAllowed));
        // dow mapping: JS getUTCDay() is 0=Sunday..6=Saturday; the y-axis
        // labels are Mo=0..So=6, so shift by +6 mod 7.
        const jsDow = new Date(`${d}T12:00:00Z`).getUTCDay();
        const dowIdx = (jsDow + 6) % 7;
        matrix.push({ x: d, y: DOW_DE_SHORT[dowIdx], v: round1(donut.autarkyPct) });
      }
      // periodTotal — decompose the WHOLE range's buckets in one pass.
      const periodDonut = autarkyDonutFromFlows(decomposeEnergyFlows(rows, gridChargeAllowed));
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
      // Spot price per hour from timeseries_samples price_ct_kwh (Plan 09.4-A,
      // parameterized). price_ct_kwh is a ratio series → take the per-hour MEAN
      // (AVG of value_num), never a W×Δt integral. Missing hours fall back to 0.
      const spotByHour = new Array(24).fill(0);
      try {
        const priceSql = `
          SELECT EXTRACT(HOUR FROM ts_utc) AS h, AVG(value_num) AS avg_ct
          FROM timeseries_samples
          WHERE series_key = '${PRICE_SERIES_KEY}'
            AND value_num IS NOT NULL
            AND ts_utc >= $1::timestamptz
            AND ts_utc <  $2::timestamptz
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
      // Plan 09.4-A — EPEX spot prices are sourced from timeseries_samples
      // (series_key='price_ct_kwh'); the row column is aliased back to
      // `price_ct_kwh` so the downstream sort/map is unchanged.
      const sql = priceRowsSql();
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
  // as Waves 2-3. Plan 09.4-A — Pheat's spot-price source is
  // `public.timeseries_samples` (series_key='price_ct_kwh', columns ts_utc +
  // value_num). The earlier `shared.market_price_slots` source was never
  // populated on prod (0 rows).
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
      // Plan 09.4-A — EPEX spot prices are sourced from timeseries_samples
      // (series_key='price_ct_kwh'). price_ct_kwh is a ratio series → the
      // per-cell aggregate is the MEAN (AVG of value_num), never an integral.
      const sql = `
        SELECT
          EXTRACT(DOW  FROM ts_utc AT TIME ZONE 'Europe/Berlin') AS dow,
          EXTRACT(HOUR FROM ts_utc AT TIME ZONE 'Europe/Berlin') AS hr,
          AVG(value_num) AS avg_ct
        FROM timeseries_samples
        WHERE series_key = '${PRICE_SERIES_KEY}'
          AND value_num IS NOT NULL
          AND ts_utc >= $1::timestamptz
          AND ts_utc <  $2::timestamptz
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

  // -------------------------------------------------------------------------
  // Plan 09.4 — Negativpreis-Heatmap (slug: neg-price). A dedicated matrix
  // card visualising WHEN the EPEX spot price was negative (grid pays you to
  // consume — curtailment-relevant). month + year only.
  //
  //   month view: x = day-of-month "01".."31", y = hour-of-day "00".."23",
  //               cell v = MEAN spot price (ct/kWh) for that day-hour.
  //   year  view: x = month "Jan".."Dez", y = day-of-month "1".."31",
  //               cell v = that day's MINIMUM spot price (deeply-negative
  //               days stand out).
  //
  // price_ct_kwh is a ratio series → the per-cell aggregate is AVG / MIN of
  // value_num, NEVER an energy integral (same source path as getPheat). The
  // raw SIGNED price is emitted as `v` (negatives included, never clamped);
  // the frontend owns the diverging colour scale centred at 0. domain exposes
  // the true signed min/max so the client can size the scale.
  // -------------------------------------------------------------------------
  async function getNegPrice({ view, date } = {}) {
    const bad = validate({ view, date });
    if (bad) return bad;
    if (view !== 'month' && view !== 'year') {
      return { status: 400, body: { ok: false, error: 'view not supported (neg-price is month|year only)' }, cached: false };
    }
    const key = `neg-price:${view}:${date}`;
    const hit = getCached(key);
    if (hit) return { status: 200, body: { ...hit, cached: true }, cached: true };
    try {
      const { start, end } = resolveRange(view, date);
      // Bucket server-side via EXTRACT in the Europe/Berlin zone (a SQL
      // literal, not user input — T-09.3-19); the BETWEEN bounds are
      // parameterized. month → AVG per day×hour; year → MIN per month×day.
      let sql;
      if (view === 'month') {
        sql = `
          SELECT
            EXTRACT(DAY  FROM ts_utc AT TIME ZONE 'Europe/Berlin') AS dom,
            EXTRACT(HOUR FROM ts_utc AT TIME ZONE 'Europe/Berlin') AS hr,
            AVG(value_num) AS agg_ct
          FROM timeseries_samples
          WHERE series_key = '${PRICE_SERIES_KEY}'
            AND value_num IS NOT NULL
            AND ts_utc >= $1::timestamptz
            AND ts_utc <  $2::timestamptz
          GROUP BY dom, hr
          ORDER BY dom, hr
        `;
      } else {
        sql = `
          SELECT
            EXTRACT(YEAR  FROM ts_utc AT TIME ZONE 'Europe/Berlin') AS yr,
            EXTRACT(MONTH FROM ts_utc AT TIME ZONE 'Europe/Berlin') AS mon,
            EXTRACT(DAY   FROM ts_utc AT TIME ZONE 'Europe/Berlin') AS dom,
            MIN(value_num) AS agg_ct
          FROM timeseries_samples
          WHERE series_key = '${PRICE_SERIES_KEY}'
            AND value_num IS NOT NULL
            AND ts_utc >= $1::timestamptz
            AND ts_utc <  $2::timestamptz
          GROUP BY yr, mon, dom
          ORDER BY yr, mon, dom
        `;
      }
      let rows = [];
      if (db && typeof db.query === 'function') {
        const result = await db.query(sql, [start, end]);
        rows = (result && Array.isArray(result.rows)) ? result.rows : [];
      }
      let xLabels;
      let yLabels;
      const matrix = [];
      let domainMin = Infinity;
      let domainMax = -Infinity;
      // `present` keys mark cells that actually carry a price — cells outside
      // the data window stay `null` so the frontend can render them empty
      // (a true 0 ct/kWh price reads identically to a missing cell otherwise).
      const cells = new Map();
      if (view === 'month') {
        // x = day-of-month "01".."31", y = hour-of-day "00".."23".
        xLabels = Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, '0'));
        yLabels = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
        for (const r of rows) {
          const dom = Math.trunc(Number(r.dom));
          const hr = Math.trunc(Number(r.hr));
          const v = Number(r.agg_ct);
          if (!Number.isFinite(dom) || dom < 1 || dom > 31) continue;
          if (!Number.isFinite(hr) || hr < 0 || hr > 23) continue;
          if (!Number.isFinite(v)) continue;
          cells.set(`${dom}:${hr}`, round3(v));
        }
        for (let d = 1; d <= 31; d++) {
          for (let h = 0; h < 24; h++) {
            const raw = cells.get(`${d}:${h}`);
            const v = raw == null ? null : raw;
            if (v != null) {
              if (v < domainMin) domainMin = v;
              if (v > domainMax) domainMax = v;
            }
            // RC-2 — cell x/y MUST be the exact label strings the
            // type:'category' Chart.js scale matches by `===`.
            matrix.push({ x: xLabels[d - 1], y: yLabels[h], v });
          }
        }
      } else {
        // year — x = month "Jan".."Dez", y = day-of-month "1".."31".
        xLabels = bucketLabelsForView('year', start);
        yLabels = Array.from({ length: 31 }, (_, i) => String(i + 1));
        const startDate = new Date(start);
        const startY = startDate.getUTCFullYear();
        const startM = startDate.getUTCMonth(); // 0..11
        for (const r of rows) {
          const yr = Math.trunc(Number(r.yr));
          const mon = Math.trunc(Number(r.mon)); // 1..12
          const dom = Math.trunc(Number(r.dom)); // 1..31
          const v = Number(r.agg_ct);
          if (!Number.isFinite(yr) || !Number.isFinite(mon) || !Number.isFinite(dom)) continue;
          if (!Number.isFinite(v)) continue;
          // monthIdx 0..11 relative to the 12-month window start.
          const monthIdx = (yr - startY) * 12 + ((mon - 1) - startM);
          if (monthIdx < 0 || monthIdx > 11) continue;
          if (dom < 1 || dom > 31) continue;
          cells.set(`${monthIdx}:${dom}`, round3(v));
        }
        for (let m = 0; m < 12; m++) {
          for (let d = 1; d <= 31; d++) {
            const raw = cells.get(`${m}:${d}`);
            const v = raw == null ? null : raw;
            if (v != null) {
              if (v < domainMin) domainMin = v;
              if (v > domainMax) domainMax = v;
            }
            matrix.push({ x: xLabels[m], y: yLabels[d - 1], v });
          }
        }
      }
      // Empty-window guard — no priced samples in range → flat 0 domain so the
      // frontend renders the friendly placeholder instead of an Infinity scale.
      if (!Number.isFinite(domainMin)) domainMin = 0;
      if (!Number.isFinite(domainMax)) domainMax = 0;
      const payload = {
        ok: true,
        card: 'neg-price',
        view,
        date,
        generatedAt: new Date().toISOString(),
        cached: false,
        xLabels,
        yLabels,
        matrix,
        domain: { min: round3(domainMin), max: round3(domainMax), unit: 'ct/kWh' },
      };
      putCached(key, payload);
      return { status: 200, body: payload, cached: false };
    } catch (e) {
      if (typeof pushLog === 'function') pushLog('history_viz_neg_price_error', { error: e.message, view, date });
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
  // SCHEMA NOTE (Plan 09.4-B): the Phase-08.1 `opt.plan_slots` table is 0 rows
  // on prod — no `INSERT INTO opt.` writer exists anywhere; the multi-schema
  // cutover was deferred. There is NO `expected_profit_eur` column anywhere in
  // the legacy schema. The realized per-slot economics are reconstructed from
  // `public.energy_slots_15m` — an EAV table keyed by (slot_start_utc,
  // series_key, source_kind) where `value_num` already holds the per-15-min
  // ENERGY in kWh (despite the `_w` suffix on the series_key; `unit='kWh'`).
  // The dispatch cards read the `grid_import_w` / `grid_export_w` series and
  // join the EPEX price (`timeseries_samples` series_key='price_ct_kwh').
  //
  // Per-slot net € is DERIVED — there is no stored profit column. Consistent
  // with the legacy net-€ in history-runtime.js:1332-1333
  //   exportRevenueEur = exportKwh × marketPriceCtKwh / 100
  //   netEur           = exportRevenueEur − selfConsumptionCostEur
  // the dispatch cards value export at the EPEX price and import cost at the
  // same EPEX price (the per-slot market price is the only price the
  // aggregator's DI ctx exposes — the full pricingConfig LCOE breakdown lives
  // in history-runtime, out of scope here):
  //   netEur = (exportKwh − importKwh) × price_ct_kwh / 100
  // This is a signed market-value cashflow per slot; SUM per day = daily net.
  // -------------------------------------------------------------------------

  // Action heuristic: net export → sell, net import → buy, both ~0 → hold.
  // kWh = max(import, export) — energy_slots_15m value_num is already in kWh.
  function slotActionAndKwh(importKwh, exportKwh) {
    let action = 'hold';
    if (exportKwh > importKwh && exportKwh > 0) action = 'sell';
    else if (importKwh > exportKwh && importKwh > 0) action = 'buy';
    const kwh = Math.max(importKwh, exportKwh);
    return { action, kwh };
  }

  // SQL for the realized-dispatch source. energy_slots_15m is EAV, so the
  // per-slot import/export kWh are pivoted with FILTER aggregates and joined to
  // the 15-min EPEX price from timeseries_samples. source_kind IN
  // ('vrm_import','local_live') = the realized telemetry tiers; `unit='kWh'`
  // excludes the legacy pre-Sept-2025 `unit='W'` rows so the energy stays
  // consistent. Derived per-slot net € = (export−import)×price/100.
  function dispatchSlotsCte() {
    return `
      WITH slot_flows AS (
        SELECT
          slot_start_utc AS ts,
          SUM(value_num) FILTER (WHERE series_key = 'grid_import_w') AS import_kwh,
          SUM(value_num) FILTER (WHERE series_key = 'grid_export_w') AS export_kwh
        FROM energy_slots_15m
        WHERE series_key IN ('grid_import_w', 'grid_export_w')
          AND source_kind IN ('vrm_import', 'local_live')
          AND unit = 'kWh'
          AND slot_start_utc >= $1::timestamptz
          AND slot_start_utc <  $2::timestamptz
        GROUP BY slot_start_utc
      ),
      slot_price AS (
        SELECT
          time_bucket('15 minutes', ts_utc) AS ts,
          AVG(value_num) AS price_ct_kwh
        FROM timeseries_samples
        WHERE series_key = '${PRICE_SERIES_KEY}'
          AND value_num IS NOT NULL
          AND ts_utc >= $1::timestamptz
          AND ts_utc <  $2::timestamptz
        GROUP BY 1
      ),
      slot_net AS (
        SELECT
          f.ts,
          COALESCE(f.import_kwh, 0) AS import_kwh,
          COALESCE(f.export_kwh, 0) AS export_kwh,
          COALESCE(p.price_ct_kwh, 0) AS price_ct_kwh,
          (COALESCE(f.export_kwh, 0) - COALESCE(f.import_kwh, 0))
            * COALESCE(p.price_ct_kwh, 0) / 100.0 AS net_eur
        FROM slot_flows f
        LEFT JOIN slot_price p ON p.ts = f.ts
      )`;
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
      // The 10 highest-revenue sell slots in the period. Plan 09.4-B — realized
      // per-slot import/export kWh come from energy_slots_15m, joined to the
      // 15-min EPEX price; per-slot net € is DERIVED (no stored profit column).
      // Parameterized BETWEEN bounds; ORDER BY net_eur DESC LIMIT 10 server-side.
      // The export>import filter keeps this a "best SELLING slots" ranking.
      const sql = `
        ${dispatchSlotsCte()}
        SELECT ts, import_kwh, export_kwh, price_ct_kwh, net_eur
        FROM slot_net
        WHERE export_kwh > import_kwh
        ORDER BY net_eur DESC NULLS LAST
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
          const importKwh = Number(row.import_kwh) || 0;
          const exportKwh = Number(row.export_kwh) || 0;
          const { action, kwh } = slotActionAndKwh(importKwh, exportKwh);
          return {
            ts: typeof row.ts === 'string' ? row.ts : new Date(row.ts).toISOString(),
            action,
            kwh: round3(kwh),
            priceCt: round3(Number(row.price_ct_kwh) || 0),
            revenueEur: round3(Number(row.net_eur) || 0),
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
      // Per-day signed net-€ over the 12-month window. Plan 09.4-B — the
      // per-slot net € is DERIVED ((export−import)×price/100, signed: a slot
      // that nets a cost carries a negative value), so SUM per day yields a
      // signed daily net. date_trunc to UTC day; the matrix is plotted month×day.
      const sql = `
        ${dispatchSlotsCte()}
        SELECT
          to_char(date_trunc('day', ts AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS d,
          SUM(net_eur) AS net_eur
        FROM slot_net
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
      // Daily net-€ (Plan 09.4-B: derived from energy_slots_15m realized flows
      // × EPEX price) JOIN daily-mean GHI (from weather_forecasts, ghi_wm2 IS
      // NOT NULL — the open_meteo_archive provider holds a full year of
      // historical GHI). The INNER JOIN means days with no GHI row are omitted
      // (T-09.3-24 graceful path). Both daily aggregates cap the JOIN at ~365
      // rows per side. import_kwh/export_kwh drive the daily autarky %.
      const sql = `
        ${dispatchSlotsCte()},
        daily_net AS (
          SELECT
            to_char(date_trunc('day', ts AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS d,
            SUM(net_eur) AS net_eur,
            SUM(import_kwh) AS import_kwh,
            SUM(export_kwh) AS export_kwh
          FROM slot_net
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
          n.import_kwh,
          n.export_kwh
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
        // the production SQL computes it from realized export vs (export +
        // import) kWh — a grid-flow self-sufficiency proxy (Plan 09.4-B; the
        // energy_slots_15m value_num is already kWh).
        let autarkyPct;
        if (Number.isFinite(Number(row.autarky_pct))) {
          autarkyPct = Math.max(0, Math.min(100, Math.round(Number(row.autarky_pct))));
        } else {
          const importKwh = Number(row.import_kwh) || 0;
          const exportKwh = Number(row.export_kwh) || 0;
          const totalKwh = exportKwh + importKwh;
          autarkyPct = totalKwh > 0
            ? Math.max(0, Math.min(100, Math.round((exportKwh / totalKwh) * 100)))
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
    getNegPrice,
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
