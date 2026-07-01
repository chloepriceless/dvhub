// services/family/index.js -- Family Dashboard Status Service (DASH-02).
// Aggregates Live-Daten + Forecast + Optimizer + Cost into a single payload
// for the Family Dashboard (/api/family/status).
//
// Decisions (see .planning/phases/03-waf-dashboard/03-CONTEXT.md):
//   D-05: Single combined endpoint — ein Call alle 5s.
//   D-07: Response-Payload { now, energy, battery, ev, devices, forecast,
//         price, optimizer, savings, greeting, presence, config }. Jede
//         Sektion vorkalkuliert, keine Client-Berechnung.
//   D-13: Tageszeit-abhängige Begrüßung; Stimmungs-Pill um Optimizer-Status
//         erweitert ("Optimizer lädt gerade günstig").
//   D-14: Bei mehreren PV-Strings/EVs aggregiert anzeigen; Einzel-Details
//         im Breakdown-Panel. Phase 03 liefert leere `strings`/`vehicles`
//         Arrays als Platzhalter — Phase 04 füllt diese.
//   D-19: Presence-Hook — in-memory state, gesetzt via POST /api/family/presence.
//   D-22: Null-safe wenn forecastService/optimizerService noch nicht bereit.
//
// Caches buildFamilyStatus() for 2 seconds (Research Pitfall 9) to avoid
// recomputation storm when mehrere Tablets pollen.

const CACHE_TTL_MS = 2000;
const TODAY_KPIS_REFRESH_MS = 60_000;

/**
 * Create the family service. Aggregates cross-service data into the
 * dashboard payload and holds the in-memory presence state.
 *
 * @param {object} ctx - DI context { state, getCfg, pushLog,
 *   buildFallbackStatusPayload, forecastService, optimizerService,
 *   epexNowNext, costSummary, historyApi }
 * @returns {{ start: Function, close: Function,
 *             buildFamilyStatus: Function,
 *             setPresence: Function, getPresence: Function,
 *             refreshTodayKpis: Function }}
 */
export function createFamilyService(ctx) {
  const { getCfg, pushLog } = ctx;

  // In-memory presence state (D-19). Resets on process restart — intentional
  // for v1.0; Phase 04 integrations persist it via MQTT/Loxone.
  let presence = { detected: false, source: null, updatedAt: 0 };

  // Response cache (Research Pitfall 9).
  let cached = null;
  let cachedAt = 0;

  // Today-KPIs + downsampled hourly chart arrays refreshed in the background
  // (60s) via historyApi.getSummary. buildFamilyStatus reads this synchronously
  // — stays null until first refresh completes or until historyApi is
  // unavailable (telemetry disabled).
  let todayKpis = null;
  let todayCharts = null;
  let todayKpisAt = 0;
  let todayKpisTimer = null;
  // Month/year KPI snapshots for the bottom-bar period metrics (2026-06-13).
  // Refreshed every ~10 min piggybacked on the todayKpis tick — these are
  // heavy aggregate queries, the kiosk does not need them minute-fresh.
  const periodKpis = { month: null, year: null };
  let periodKpisAt = 0;
  const PERIOD_KPIS_TTL_MS = 10 * 60 * 1000;

  // --------------------------------------------------------------------
  // Section derivers -- each takes the already-computed status payload
  // and shapes it into the dashboard-friendly format.
  // --------------------------------------------------------------------

  function kw(watts) {
    const n = Number(watts || 0);
    return Math.round(n / 10) / 100; // kW with 2 decimals
  }

  /**
   * Energy flow section. Computes solar / home / grid / battery / ev kW
   * from victron + meter state.
   */
  /**
   * Today section — actual kWh counters from telemetry history (not forecast).
   * Reads the last snapshot refreshed by refreshTodayKpis(); returns null when
   * telemetry is disabled or the first refresh hasn't completed yet.
   */
  function deriveTodaySection(kpis, charts) {
    if (!kpis || typeof kpis !== 'object') return null;
    const round1 = (n) => (typeof n === 'number' && Number.isFinite(n))
      ? Math.round(n * 10) / 10
      : null;
    return {
      pvKwh: round1(kpis.pvKwh),
      loadKwh: round1(kpis.loadKwh),
      importKwh: round1(kpis.importKwh),
      exportKwh: round1(kpis.exportKwh),
      batteryChargeKwh: round1(kpis.batteryChargeKwh),
      batteryDischargeKwh: round1(kpis.batteryDischargeKwh),
      selfConsumptionKwh: round1(kpis.selfConsumptionKwh),
      charts: charts || null,
      updatedAt: todayKpisAt || null
    };
  }

  /**
   * Downsample 15-min history slots into 24 hourly buckets. `fieldOrFn` is
   * either a key on each slot or a function returning the slot's contribution.
   * Values are summed per hour (for kWh → kW-avg) and rounded to 2 decimals.
   * Returns a fixed-length [24] array so Chart.js can render a full-day line
   * even when the day is still in progress (future hours come out as 0).
   */
  function toHourlyBuckets(slots, fieldOrFn, { average = false } = {}) {
    if (!Array.isArray(slots) || slots.length === 0) return null;
    const sums = new Array(24).fill(0);
    const counts = new Array(24).fill(0);
    for (const slot of slots) {
      if (!slot || !slot.ts) continue;
      const h = new Date(slot.ts).getHours();
      if (!Number.isFinite(h) || h < 0 || h > 23) continue;
      const raw = typeof fieldOrFn === 'function' ? fieldOrFn(slot) : Number(slot[fieldOrFn] || 0);
      if (!Number.isFinite(raw)) continue;
      sums[h] += raw;
      counts[h] += 1;
    }
    return sums.map((s, i) => {
      const v = average && counts[i] > 0 ? s / counts[i] : s;
      return Math.round(v * 100) / 100;
    });
  }

  /**
   * Build per-panel 24h hourly chart arrays from historyApi dayEnergyLines +
   * dayPriceLines. Each array is 24 numbers (00:00-23:00 local). Signs follow
   * the UI's internal convention: positive grid = import, positive bat = net
   * charge over that hour, negative = discharge.
   */
  function buildTodayCharts(historyBody) {
    if (!historyBody || !historyBody.charts) return null;
    const energyLines = historyBody.charts.dayEnergyLines;
    const priceLines = historyBody.charts.dayPriceLines;
    return {
      solar: toHourlyBuckets(energyLines, 'pvKwh'),
      home: toHourlyBuckets(energyLines, 'loadKwh'),
      bat: toHourlyBuckets(energyLines, (s) => (Number(s.batteryChargeKwh || 0) - Number(s.batteryDischargeKwh || 0))),
      grid: toHourlyBuckets(energyLines, (s) => (Number(s.importKwh || 0) - Number(s.exportKwh || 0))),
      // Price panel is labelled "EPEX Strompreis" and needs the real
      // wholesale market curve at the native 15-minute resolution EPEX
      // publishes. Downsampling to 24 hourly buckets would wash out the
      // intraday swings that drive optimizer decisions, which is exactly
      // what users open this panel to see.
      price: toQuarterHourlyBuckets(priceLines, 'marketPriceCtKwh')
    };
  }

  /**
   * Build a fixed-length 96-bucket array (15-min resolution × 24 h) from
   * chronological slot rows. Slots are placed by their local hour+minute.
   * Missing buckets are left as null so Chart.js renders them as gaps
   * instead of collapsing the line to zero.
   */
  function toQuarterHourlyBuckets(slots, field) {
    if (!Array.isArray(slots) || slots.length === 0) return null;
    const buckets = new Array(96).fill(null);
    for (const slot of slots) {
      if (!slot || !slot.ts) continue;
      const d = new Date(slot.ts);
      const h = d.getHours();
      const m = d.getMinutes();
      if (!Number.isFinite(h) || !Number.isFinite(m)) continue;
      const idx = h * 4 + Math.floor(m / 15);
      if (idx < 0 || idx > 95) continue;
      const raw = Number(slot[field]);
      if (!Number.isFinite(raw)) continue;
      buckets[idx] = Math.round(raw * 100) / 100;
    }
    return buckets;
  }

  function deriveEnergySection(victron, meter) {
    const solarKw = kw(victron?.pvTotalW);
    const batteryKw = kw(victron?.batteryPowerW); // positive = charging
    const evKw = kw(victron?.evPowerW); // placeholder; many installs lack EV data
    // Normalize to internal convention: positive gridKw = import, negative = export.
    // The meter exposes `semantics.positiveMeans` which is "feed_in" on Victron
    // (the default — positive raw grid_total_w means feeding into the grid) or
    // "grid_import" on some third-party meters. Flip the sign when the raw meter
    // uses feed_in-positive so the downstream pipeline and UI (family.js line 429
    // autarkie calc) can uniformly treat positive gridKw as import.
    const positiveMeans = meter?.semantics?.positiveMeans || 'feed_in';
    const rawGridW = Number(meter?.grid_total_w || 0);
    const gridTotalW = positiveMeans === 'feed_in' ? -rawGridW : rawGridW;
    const gridKw = kw(gridTotalW);
    const feedingToGrid = gridTotalW < 0;

    // Home consumption: solar + gridImport - battery charge - ev charge - gridExport
    // (energy flowing into the house minus energy stored/consumed by big loads and exported).
    const gridImportKw = Math.max(0, gridKw);
    const gridExportKw = Math.max(0, -gridKw);
    const homeKw = Math.max(
      0,
      Math.round((solarKw + gridImportKw - Math.max(0, batteryKw) - Math.max(0, evKw) - gridExportKw) * 100) / 100
    );

    // Surplus = solar covers the house with room to spare. In practice this
    // means we're not importing (gridKw <= 0) AND solar is producing.
    // Also true if battery is charging from PV (powerW > 0 with no import).
    const surplus = solarKw > 0 && gridKw <= 0 && homeKw < solarKw + 0.001
      ? true
      : solarKw > homeKw + Math.max(0, batteryKw) + Math.max(0, evKw);

    return {
      solarKw,
      homeKw,
      gridKw,
      batteryKw,
      evKw,
      feedingToGrid,
      surplus
    };
  }

  /**
   * Battery section. `strings: []` is the D-14 placeholder for multi-string
   * installations — Phase 04 will populate it from Victron battery topology.
   */
  function deriveBatterySection(victron, cfg) {
    const socPct = Number(victron?.soc ?? 0);
    const powerW = Number(victron?.batteryPowerW || 0);
    const powerKw = kw(powerW);

    let mode = 'idle';
    if (powerW > 100) mode = 'charging';
    else if (powerW < -100) mode = 'discharging';

    const capacityWh = Number(cfg?.optimizer?.batteryCapacityWh || 0);
    const capacityKwh = Math.round((capacityWh / 1000) * 10) / 10;

    // Runtime estimate: at current discharge power, how many hours to empty?
    let runtimeHours = null;
    if (mode === 'discharging' && capacityKwh > 0) {
      const availableKwh = (socPct / 100) * capacityKwh;
      runtimeHours = Math.round(availableKwh / Math.abs(powerKw || 1) * 10) / 10;
    }

    return {
      socPct,
      powerKw,
      mode,
      capacityKwh,
      runtimeHours,
      strings: [] // D-14 multi-string breakdown (Phase 04)
    };
  }

  /**
   * EV section. `vehicles: []` is the D-14 placeholder for multi-EV setups.
   */
  /**
   * EVCC section (operator request #23, 2026-06-13). Surfaces the evcc
   * loadpoint(s) + selected loadpoint so the Family EV panel can show the
   * vehicle/charge state (when no Tesla) and switch the charge mode. Reads the
   * cached state from the evcc integration (which polls whenever a URL is set).
   * Returns { available:false, loadpoints:[] } when evcc is unreachable/unset.
   */
  function deriveEvccSection() {
    const svc = ctx.evccIntegration;
    if (!svc || typeof svc.getLoadpoints !== 'function') return { available: false, loadpoints: [] };
    let lps = [];
    try { lps = svc.getLoadpoints() || []; } catch (err) {
      pushLog?.('family_evcc_error', { error: err.message });
      return { available: false, loadpoints: [] };
    }
    // Loadpoint selection is configured on the Integrations page
    // (cfg.evcc.dashboardLoadpoint, 1-based); fall back to the first loadpoint.
    const selRaw = Number((getCfg?.() || {}).evcc?.dashboardLoadpoint);
    const selected = (Number.isInteger(selRaw) && lps.some((l) => l.id === selRaw))
      ? selRaw
      : (lps[0]?.id ?? null);
    return {
      available: lps.length > 0,
      selectedLoadpoint: selected,
      loadpoints: lps
    };
  }

  function deriveEvSection(victron /*, cfg */) {
    const evPowerW = Number(victron?.evPowerW || 0);
    const powerKw = kw(evPowerW);
    const socPct = victron?.evSocPct != null ? Number(victron.evSocPct) : null;

    let mode = 'idle';
    if (evPowerW > 100) {
      // Solar charging = grid isn't importing more than PV produces; simple heuristic.
      const solarW = Number(victron?.pvTotalW || 0);
      mode = solarW >= evPowerW ? 'solar_charging' : 'grid_charging';
    }

    return {
      powerKw,
      socPct,
      mode,
      finishEstIso: null,
      vehicles: [] // D-14 multi-EV breakdown (Phase 04)
    };
  }

  /**
   * Devices section (INTG-05, verdrahtet 2026-06-17). Bündelt die Live-Messwerte
   * des Geräte-Service (Shelly-HTTP + mqtt-generic Adapter) als Dashboard-Karten.
   * deviceService.getDevices() liefert {id,name,powerW,energyTodayWh,online,lastSeen};
   * das Family-Dashboard erwartet {id,name,watts,...} und filtert clientseitig per
   * DEVICE_THRESHOLD_W. Offline-Geräte → watts 0 (fallen unter die Schwelle).
   */
  function deriveDevicesSection() {
    const list = ctx.deviceService?.getDevices?.() || [];
    const out = [];
    for (const d of list) {
      if (!d || d.id == null) continue;
      const powerW = Number(d.powerW);
      const watts = d.online && Number.isFinite(powerW) ? Math.max(0, Math.round(powerW)) : 0;
      const energyTodayWh = Number(d.energyTodayWh);
      out.push({
        id: String(d.id),
        name: String(d.name || d.id),
        watts,
        online: !!d.online,
        output: (typeof d.output === 'boolean') ? d.output : null,
        switchable: !!d.switchable,
        energyTodayWh: Number.isFinite(energyTodayWh) ? energyTodayWh : null,
        emoji: '🔌',
        color: 'var(--device)'
      });
    }
    return out;
  }

  /**
   * MQTT tiles section. Operator-configured generic MQTT topics (Wallbox,
   * any other consumer, a sensor reading) — each { id, label, topic, unit,
   * value, online, lastSeen }. Empty array when the service is unavailable
   * or no tiles are configured. The Family Dashboard renders one card per
   * tile that has a value.
   */
  function deriveMqttTilesSection() {
    const svc = ctx.familyMqttTiles;
    if (!svc || typeof svc.getTiles !== 'function') return [];
    try {
      return svc.getTiles();
    } catch (err) {
      pushLog?.('family_mqtt_tiles_error', { error: err.message });
      return [];
    }
  }

  /**
   * Tesla section. Surfaces the full TeslaMate snapshot (range, battery,
   * charging, climate, location) for the Family Dashboard. Returns
   * { enabled: false } when the integration is disabled or the subscriber
   * is unavailable (D-22 null-safe).
   */
  function deriveTeslaSection() {
    const teslaCfg = (getCfg?.() || {}).integrations?.tesla || {};
    if (!teslaCfg.enabled) return { enabled: false };
    const svc = ctx.teslamateService;
    if (!svc || typeof svc.getState !== 'function') return { enabled: false };

    let s;
    try {
      s = svc.getState();
    } catch (err) {
      pushLog?.('family_tesla_error', { error: err.message });
      return { enabled: false };
    }

    const lastUpdateAt = svc.lastUpdateAt
      ? new Date(svc.lastUpdateAt).getTime()
      : null;

    // Phase 11-06 round 7: derive "charging" from BOTH signals. TeslaMate
    // re-publishes charger_power / charger_voltage far more often than
    // charging_state, so after a dvhub restart charging_state can be
    // momentarily null while the car is clearly drawing power. Treat the car
    // as charging when chargingState is 'Charging' OR a positive charger
    // power is reported -- no fabricated values, only an OR of signals that
    // are already present.
    const chargerPowerKw = s.chargerPower ?? null;
    const charging = s.chargingState === 'Charging'
      || (typeof chargerPowerKw === 'number' && chargerPowerKw > 0);

    // Stale = the car is offline/asleep/suspended → no live data, values frozen.
    // `since` is TeslaMate's state-change timestamp so the UI can show
    // "veraltet seit …" instead of presenting a frozen SoC as live (2026-06-13).
    const STALE_STATES = new Set(['offline', 'asleep', 'suspended']);
    const stale = STALE_STATES.has(s.state || '');

    return {
      enabled: true,
      name: s.displayName || teslaCfg.name || 'Tesla',
      state: s.state || null,                       // asleep|online|offline|charging|driving
      since: s.since || null,                       // TeslaMate state-change timestamp (ISO)
      stale,                                        // true → values frozen (offline/asleep/suspended)
      batteryLevel: s.batteryLevel ?? null,         // %
      usableBatteryLevel: s.usableBatteryLevel ?? null,
      rangeKm: s.estRangeKm ?? null,                // estimated range
      ratedRangeKm: s.ratedRangeKm ?? null,
      chargingState: s.chargingState || null,       // Charging|Complete|Disconnected|...
      charging,                                     // derived: chargingState OR chargerPowerKw>0
      pluggedIn: s.pluggedIn ?? null,
      chargeLimitSoc: s.chargeLimitSoc ?? null,
      chargerPowerKw,
      insideTempC: s.insideTemp ?? null,
      geofence: s.geofence || null,
      lastUpdateAt
    };
  }

  /**
   * Forecast section. Reshapes forecastService response into dashboard-friendly
   * today/tomorrow/next48h aggregates. Returns null if service unavailable (D-22).
   */
  function deriveForecastSection(forecastResponse) {
    if (!forecastResponse) return null;
    const pvSlots = forecastResponse?.pv?.slots || [];
    const loadSlots = forecastResponse?.load?.slots || [];

    // Group PV slots by local date (YYYY-MM-DD)
    const dayKey = (isoStr) => {
      try { return new Date(isoStr).toISOString().slice(0, 10); }
      catch { return ''; }
    };

    const nowIsoDay = new Date().toISOString().slice(0, 10);
    const tomorrowIsoDay = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    function aggregateDay(slots, iso) {
      let kwhTotal = 0;
      let peakW = 0;
      for (const s of slots) {
        const d = dayKey(s.start || s.ts);
        if (d !== iso) continue;
        const powerW = Number(s.powerW ?? s.pv_watts ?? 0);
        // 15-min slot → energy in Wh = power * 0.25h
        kwhTotal += (powerW * 0.25) / 1000;
        if (powerW > peakW) peakW = powerW;
      }
      return {
        kwhTotal: Math.round(kwhTotal * 10) / 10,
        peakKw: Math.round((peakW / 1000) * 10) / 10
      };
    }

    const next48h = pvSlots.slice(0, 192).map(s => ({
      ts: typeof s.start === 'string' ? Date.parse(s.start) : Number(s.ts || 0),
      kw: Math.round((Number(s.powerW ?? s.pv_watts ?? 0) / 1000) * 100) / 100,
      confidence: Number(s.confidence ?? 0.5)
    }));

    return {
      pv: {
        today: aggregateDay(pvSlots, nowIsoDay),
        tomorrow: aggregateDay(pvSlots, tomorrowIsoDay),
        next48h
      },
      load: {
        today: aggregateDay(loadSlots, nowIsoDay)
      }
    };
  }

  /**
   * Price section. Reads from ctx.epexNowNext() + state.epex.data.
   *
   * Exposes two distinct prices, since the raw EPEX spot is not what a
   * dynamic-tariff customer actually pays on import:
   *   - nowCtKwh        : current EPEX spot (wholesale, market signal)
   *   - importCtKwh     : user's actual import price incl. grid fees, taxes,
   *                       VAT (from costs.userImportPriceNowCtKwh). This is
   *                       the number the UI should show when labelled as
   *                       "Kosten" or "Bezug".
   */
  function derivePriceSection(epexNN, epexState, costs) {
    const importCtKwh = (costs && typeof costs.userImportPriceNowCtKwh === 'number' && Number.isFinite(costs.userImportPriceNowCtKwh))
      ? Math.round(costs.userImportPriceNowCtKwh * 100) / 100
      : null;

    if (!epexNN) {
      return {
        nowCtKwh: null,
        nextHourCtKwh: null,
        todayMinCtKwh: null,
        todayMaxCtKwh: null,
        importCtKwh,
        slots: []
      };
    }

    const nowCtKwh = epexNN.current?.ct_kwh != null ? Number(epexNN.current.ct_kwh) : null;
    const nextHourCtKwh = epexNN.next?.ct_kwh != null ? Number(epexNN.next.ct_kwh) : null;

    // todayMin/Max from epexNowNext are eur/MWh — convert to ct/kWh (divide by 10).
    const todayMinCtKwh = epexNN.todayMin != null ? Math.round(Number(epexNN.todayMin) / 10 * 100) / 100 : null;
    const todayMaxCtKwh = epexNN.todayMax != null ? Math.round(Number(epexNN.todayMax) / 10 * 100) / 100 : null;

    const slots = Array.isArray(epexState?.data)
      ? epexState.data.map(row => ({
          ts: Number(row.ts),
          ctKwh: Number(row.ct_kwh ?? 0)
        }))
      : [];

    return { nowCtKwh, nextHourCtKwh, todayMinCtKwh, todayMaxCtKwh, importCtKwh, slots };
  }

  /**
   * Optimizer section. Returns { enabled: false } when optimizer missing (D-22).
   */
  function deriveOptimizerSection(optimizerStatus) {
    // Operator request 2026-06-13: the Family optimizer widget shows the LIVE
    // DV-EOS/optimizer PLAN — the forecast_optimizer schedule rules (the same
    // slots the Leitstand/Einstellungen table renders), not just the internal-
    // optimizer status (whose schedule is empty when EOS is the primary source).
    const nowTs = Date.now();
    const rules = Array.isArray(ctx.state?.schedule?.rules) ? ctx.state.schedule.rules : [];
    const planSlots = rules
      .filter((r) => r && r.source === 'forecast_optimizer'
        && Number.isFinite(Number(r.slotTs)) && Number(r.slotEndTs) > nowTs)
      .sort((a, b) => Number(a.slotTs) - Number(b.slotTs))
      .slice(0, 16)
      .map((r) => ({
        startTs: Number(r.slotTs),
        endTs: Number(r.slotEndTs),
        target: r.target || null,
        gridW: r.target === 'gridSetpointW' && Number.isFinite(Number(r.value)) ? Number(r.value) : null,
        value: Number.isFinite(Number(r.value)) ? Number(r.value) : null,
        enabled: r.enabled !== false
      }));

    if ((!optimizerStatus || !optimizerStatus.enabled) && planSlots.length === 0) {
      return { enabled: false, planSlots: [] };
    }
    const schedule = Array.isArray(optimizerStatus?.schedule) ? optimizerStatus.schedule : [];
    const first = schedule[0] || null;
    const second = schedule[1] || null;

    const actionLabel = (action) => {
      switch (action) {
        case 'grid_charging': return 'Günstig laden';
        case 'self_consume': return 'Batterie nutzt Solar';
        case 'discharge': return 'Batterie entlädt';
        case 'hold': return 'Batterie hält';
        // null (not 'unbekannt') when there is no internal-schedule action —
        // with EOS as primary source the schedule is always empty and the
        // family panel falls back to its own planSlots ('Wartet'/'—').
        default: return action || null;
      }
    };

    return {
      enabled: true,
      source: optimizerStatus?.source || (planSlots.length ? 'eos' : null),
      lastRunAt: optimizerStatus?.lastRunAt || null,
      currentAction: first?.action || optimizerStatus?.currentAction || null,
      currentActionLabel: actionLabel(first?.action || optimizerStatus?.currentAction),
      nextActionAt: second?.ts || null,
      nextActionLabel: second ? actionLabel(second.action) : null,
      schedule,
      planSlots
    };
  }

  /**
   * Weather section (operator request 2026-06-13) — recycles the hourly
   * Open-Meteo cache the PV forecast already fetches (state.forecast.weather,
   * services/forecast/weather-fetch.js). No extra upstream call. Returns
   * null when the weather fetcher has no data (widget hides itself).
   */
  function deriveWeatherSection() {
    const rows = ctx.state?.forecast?.weather?.data;
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const now = Date.now();
    const HOUR = 3600 * 1000;
    const toTs = (r) => new Date(r.ts_utc).getTime();
    // Current = the hour bucket we are in (rows are hourly, Europe/Berlin).
    let current = null;
    for (const r of rows) {
      const ts = toTs(r);
      if (ts <= now && now < ts + HOUR) { current = r; break; }
    }
    if (!current) current = rows.find((r) => toTs(r) >= now) || rows[rows.length - 1];
    // Today min/max (local calendar day).
    const dayKey = new Date(now).toLocaleDateString('en-CA');
    let minC = null; let maxC = null;
    for (const r of rows) {
      if (new Date(toTs(r)).toLocaleDateString('en-CA') !== dayKey) continue;
      const t = Number(r.temperature_c);
      if (!Number.isFinite(t)) continue;
      if (minC == null || t < minC) minC = t;
      if (maxC == null || t > maxC) maxC = t;
    }
    // Next 12 hours for the detail panel / hourly strip. The family widget's
    // "ausführlich" detail level (operator request 2026-06-13) surfaces wind +
    // humidity per hour, so they ride along here too.
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    const hours = rows
      .filter((r) => toTs(r) >= now - HOUR)
      .slice(0, 12)
      .map((r) => ({
        ts: toTs(r),
        tempC: num(r.temperature_c),
        code: num(r.weather_code),
        precipPct: num(r.precip_prob_pct),
        cloudPct: num(r.cloud_cover_pct),
        windMs: num(r.wind_speed_ms),
        humidityPct: num(r.humidity_pct)
      }));
    // Multi-day outlook (today + the following days, up to 4 from forecast_days).
    // One entry per local calendar day: min/max temp, a representative midday
    // symbol (the row closest to 12:00 local), and the worst precip probability.
    const dayBuckets = new Map();
    for (const r of rows) {
      const ts = toTs(r);
      const d = new Date(ts);
      const key = d.toLocaleDateString('en-CA');
      let b = dayBuckets.get(key);
      if (!b) { b = { key, ts, minC: null, maxC: null, precipMaxPct: null, middayCode: null, middayDelta: Infinity }; dayBuckets.set(key, b); }
      const t = num(r.temperature_c);
      if (t != null) {
        if (b.minC == null || t < b.minC) b.minC = t;
        if (b.maxC == null || t > b.maxC) b.maxC = t;
      }
      const pp = num(r.precip_prob_pct);
      if (pp != null && (b.precipMaxPct == null || pp > b.precipMaxPct)) b.precipMaxPct = pp;
      const code = num(r.weather_code);
      const delta = Math.abs(d.getHours() - 12);
      if (code != null && delta < b.middayDelta) { b.middayCode = code; b.middayDelta = delta; }
    }
    const days = Array.from(dayBuckets.values())
      .sort((a, b) => a.ts - b.ts)
      .slice(0, 4)
      .map((b) => ({ dateKey: b.key, ts: b.ts, minC: b.minC, maxC: b.maxC, code: b.middayCode, precipMaxPct: b.precipMaxPct }));
    return {
      provider: 'open_meteo',
      tempC: num(current.temperature_c),
      code: num(current.weather_code),
      cloudPct: num(current.cloud_cover_pct),
      precipPct: num(current.precip_prob_pct),
      windMs: num(current.wind_speed_ms),
      humidityPct: num(current.humidity_pct),
      visibilityM: num(current.visibility_m),
      minC, maxC, hours, days
    };
  }

  /**
   * Curated per-period KPI subset for the bottom-bar metrics (2026-06-13).
   * Source: historyApi.getSummary kpis (same numbers as the Historie page).
   */
  function pickPeriodKpis(k) {
    if (!k || typeof k !== 'object') return null;
    const r2 = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n) * 100) / 100 : null);
    return {
      pvKwh: r2(k.pvKwh),
      exportKwh: r2(k.exportKwh),
      importKwh: r2(k.importKwh),
      loadKwh: r2(k.loadKwh),
      selfConsumptionKwh: r2(k.selfConsumptionKwh),
      exportRevenueEur: r2(k.exportRevenueEur),
      importCostEur: r2(k.importCostEur),
      netEur: r2(k.netEur),
      avoidedImportGrossEur: r2(k.avoidedImportGrossEur),
      grossReturnEur: r2(k.grossReturnEur),
      dvRevenueCtKwh: r2(k.dvRevenueCtKwh),
      periodMarketValueCtKwh: r2(k.periodMarketValueCtKwh),
      annualMarketValueCtKwh: r2(k.annualMarketValueCtKwh),
      weightedApplicableValueCtKwh: r2(k.weightedApplicableValueCtKwh),
      cycles: r2(k.cycles),
      eegExtensionMonths: r2(k.eegExtensionMonths)
    };
  }

  async function refreshPeriodKpis() {
    if (!ctx.historyApi || typeof ctx.historyApi.getSummary !== 'function') return;
    if (Date.now() - periodKpisAt < PERIOD_KPIS_TTL_MS) return;
    periodKpisAt = Date.now(); // set BEFORE the await so a slow query is not re-fired
    try {
      const now = new Date();
      const monthDate = now.toISOString().slice(0, 8) + '01';
      const yearDate = now.getFullYear() + '-01-01';
      const [m, y] = await Promise.all([
        ctx.historyApi.getSummary({ view: 'month', date: monthDate }),
        ctx.historyApi.getSummary({ view: 'year', date: yearDate })
      ]);
      if (m?.body?.kpis) periodKpis.month = m.body.kpis;
      if (y?.body?.kpis) periodKpis.year = y.body.kpis;
      cached = null;
    } catch (err) {
      pushLog?.('family_period_kpis_error', { error: err.message });
    }
  }

  /**
   * Savings section. Pre-formatted strings for direct display in the UI.
   */
  function deriveSavingsSection(costs) {
    const todayEur = Math.abs(Number(costs?.netEur || 0)).toFixed(2);
    // SIGNED net grid balance for the powerflow centre — the SAME status.costs.netEur
    // the Leitstand shows (positive = earned, negative = paid). The centre used to
    // show feedInRevenueEur + avoidedCostEur, which double-counts self-consumption
    // value and read ~15 € while the Leitstand showed ~0 € (operator report
    // 2026-06-13). Now both screens tell the same story.
    const netEur = Math.round(Number(costs?.netEur || 0) * 100) / 100;
    // Month: REAL month-to-date net from the history KPIs when available
    // (was: today's net × 30 extrapolation).
    const monthNet = Number(periodKpis.month?.netEur);
    const monthEur = Number.isFinite(monthNet)
      ? Math.round(monthNet).toString()
      : Math.round(Math.abs(Number(costs?.netEur || 0)) * 30).toString();
    // Revenue: prefer the history KPI (consistent with the Historie page).
    const histRevenue = Number(todayKpis?.exportRevenueEur);
    const feedInRevenueEur = (Number.isFinite(histRevenue)
      ? histRevenue
      : Math.abs(Number(costs?.revenueEur || 0))).toFixed(2);
    // Avoided cost: the REAL avoided-import value (self-consumed energy ×
    // gross tariff) from the history KPIs. The old |costEur| was simply the
    // day's ACTUAL grid bill — labelling that "Kosten vermieden" (and summing
    // it into the crossing's "Gewinn heute") was wrong.
    const histAvoided = Number(todayKpis?.avoidedImportGrossEur);
    const avoidedCostEur = (Number.isFinite(histAvoided)
      ? histAvoided
      : Math.abs(Number(costs?.costEur || 0))).toFixed(2);

    return { todayEur, netEur, monthEur, feedInRevenueEur, avoidedCostEur };
  }

  /**
   * Greeting / mood pill section (D-13). Time-of-day dependent, with
   * optimizer-status override ("Optimizer lädt gerade günstig").
   */
  function deriveGreetingSection(energy, optimizerStatus /*, cfg */) {
    const now = new Date();
    const hour = now.getHours();

    let hello;
    if (hour < 11) hello = 'Guten Morgen';
    else if (hour < 14) hello = 'Guten Tag';
    else if (hour < 18) hello = 'Guten Nachmittag';
    else hello = 'Guten Abend';

    const surplus = energy.surplus;

    // LLM stack removed 2026-06-13 (operator decision: no generated copy,
    // run on small hardware) — the greeting is the rule-based sentence only.
    const message = surplus
      ? 'Dein Haus produziert mehr Strom als es braucht'
      : 'Dein Haus braucht gerade mehr als die Sonne liefert';

    const mood = surplus ? 'good' : 'warn';
    let moodLabel = surplus ? 'Alles läuft perfekt' : 'Batterie hilft aus';

    // D-13: optimizer-status extension
    if (optimizerStatus?.enabled) {
      const firstAction = Array.isArray(optimizerStatus.schedule) && optimizerStatus.schedule[0]
        ? optimizerStatus.schedule[0].action
        : optimizerStatus.currentAction;
      if (firstAction === 'grid_charging') {
        moodLabel = 'Optimizer lädt gerade günstig';
      }
    }

    let time = '';
    let date = '';
    try {
      time = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
      date = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }).format(now);
    } catch {
      time = now.toTimeString().slice(0, 5);
      date = now.toDateString();
    }

    return { hello, message, mood, moodLabel, time, date };
  }

  // --------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------

  /**
   * Build the combined family status payload (D-07). Cached for 2s.
   */
  function buildFamilyStatus() {
    const now = Date.now();
    if (cached && (now - cachedAt) < CACHE_TTL_MS) return cached;

    const cfg = getCfg?.() || {};

    // Pull the raw status payload built by server.js buildCurrentStatusPayload.
    const status = (typeof ctx.buildFallbackStatusPayload === 'function')
      ? ctx.buildFallbackStatusPayload(now)
      : {};
    const victron = status.victron || {};
    const meter = status.meter || {};
    const costs = status.costs || {};
    const epexState = status.epex || {};

    // Null-safe pulls (D-22).
    let forecastResponse = null;
    try {
      if (ctx.forecastService && typeof ctx.forecastService.buildForecastResponse === 'function') {
        forecastResponse = ctx.forecastService.buildForecastResponse();
      }
    } catch (err) {
      pushLog?.('family_forecast_error', { error: err.message });
      forecastResponse = null;
    }

    let optimizerStatus = null;
    try {
      if (ctx.optimizerService && typeof ctx.optimizerService.getStatus === 'function') {
        optimizerStatus = ctx.optimizerService.getStatus();
      }
    } catch (err) {
      pushLog?.('family_optimizer_error', { error: err.message });
      optimizerStatus = null;
    }

    const epexNN = (typeof ctx.epexNowNext === 'function') ? ctx.epexNowNext() : null;

    const energy = deriveEnergySection(victron, meter);
    const battery = deriveBatterySection(victron, cfg);
    const ev = deriveEvSection(victron, cfg);
    const devices = deriveDevicesSection();
    const mqttTiles = deriveMqttTilesSection();
    const tesla = deriveTeslaSection();
    const evcc = deriveEvccSection();
    const forecast = deriveForecastSection(forecastResponse);
    const price = derivePriceSection(epexNN, epexState, costs);
    const optimizer = deriveOptimizerSection(optimizerStatus);
    const weather = deriveWeatherSection();
    const periods = {
      day: pickPeriodKpis(todayKpis),
      month: pickPeriodKpis(periodKpis.month),
      year: pickPeriodKpis(periodKpis.year)
    };
    const savings = deriveSavingsSection(costs);
    const greeting = deriveGreetingSection(energy, optimizerStatus, cfg);
    const today = deriveTodaySection(todayKpis, todayCharts);

    const payload = {
      now,
      energy,
      battery,
      ev,
      devices,
      mqttTiles,
      tesla,
      evcc,
      forecast,
      today,
      price,
      optimizer,
      weather,
      periods,
      savings,
      greeting,
      presence: { ...presence },
      config: {
        screensaver: cfg?.family?.screensaver || null,
        presence: cfg?.family?.presence || null,
        weather: cfg?.family?.weather || null
      }
    };

    cached = payload;
    cachedAt = now;
    return payload;
  }

  /**
   * Record presence state from a webhook call (D-08, D-19).
   * Invalidates the status cache so the next buildFamilyStatus reflects it.
   */
  function setPresence({ detected, source } = {}) {
    const normalizedSource = (typeof source === 'string' && source.length > 0)
      ? source
      : 'unknown';
    presence = {
      detected: Boolean(detected),
      source: normalizedSource,
      updatedAt: Date.now()
    };
    pushLog?.('family_presence', { detected: presence.detected, source: presence.source });
    cached = null; // invalidate so next buildFamilyStatus reflects new presence
  }

  /**
   * Return a shallow copy of the presence state. Mutations on the result
   * must not affect internal state.
   */
  function getPresence() {
    return { ...presence };
  }

  /**
   * Fetch today's energy KPIs from historyApi and cache them. Called once on
   * start() and then every 60 s. Also exposed on the public API so tests and
   * diagnostic paths can trigger a synchronous refresh before asserting.
   */
  async function refreshTodayKpis() {
    if (!ctx.historyApi || typeof ctx.historyApi.getSummary !== 'function') {
      todayKpis = null;
      todayCharts = null;
      return;
    }
    try {
      const today = new Date().toISOString().slice(0, 10);
      const result = await ctx.historyApi.getSummary({ view: 'day', date: today });
      if (result && result.body && result.body.kpis) {
        todayKpis = result.body.kpis;
        todayCharts = buildTodayCharts(result.body);
        todayKpisAt = Date.now();
        // Invalidate the buildFamilyStatus cache so the next call surfaces the
        // fresh `today` section without waiting 2 s.
        cached = null;
      }
      // Month/year aggregates for the bottom-bar period metrics (10-min TTL).
      refreshPeriodKpis().catch(() => { /* logged inside */ });
    } catch (err) {
      pushLog?.('family_today_kpis_error', { error: err.message });
    }
  }

  async function start() {
    pushLog?.('family_service_started', {});
    // server.js wires `ctx.historyApi` inside an async IIFE that races the
    // synchronous top-level code that calls familyService.start(). Poll ctx
    // with a short backoff (up to ~10 s) before firing the first refresh,
    // otherwise the first tablet poll after boot reports today=null and the
    // UI has to wait for the 60 s interval to tick.
    (async () => {
      for (let attempt = 0; attempt < 40; attempt++) {
        if (ctx.historyApi && typeof ctx.historyApi.getSummary === 'function') {
          await refreshTodayKpis();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      pushLog?.('family_today_kpis_bootstrap_timeout', {});
    })().catch((err) => {
      pushLog?.('family_today_kpis_bootstrap_error', { error: err.message });
    });
    todayKpisTimer = setInterval(() => {
      refreshTodayKpis().catch((err) => {
        pushLog?.('family_today_kpis_timer_error', { error: err.message });
      });
    }, TODAY_KPIS_REFRESH_MS);
    // unref so the interval does not hold the event loop open during shutdown.
    if (todayKpisTimer && typeof todayKpisTimer.unref === 'function') {
      todayKpisTimer.unref();
    }
  }

  async function close() {
    cached = null;
    if (todayKpisTimer) {
      clearInterval(todayKpisTimer);
      todayKpisTimer = null;
    }
  }

  return { start, close, buildFamilyStatus, setPresence, getPresence, refreshTodayKpis };
}
