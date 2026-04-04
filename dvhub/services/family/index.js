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

/**
 * Create the family service. Aggregates cross-service data into the
 * dashboard payload and holds the in-memory presence state.
 *
 * @param {object} ctx - DI context { state, getCfg, pushLog,
 *   buildFallbackStatusPayload, forecastService, optimizerService,
 *   epexNowNext, costSummary }
 * @returns {{ start: Function, close: Function,
 *             buildFamilyStatus: Function,
 *             setPresence: Function, getPresence: Function }}
 */
export function createFamilyService(ctx) {
  const { getCfg, pushLog } = ctx;

  // In-memory presence state (D-19). Resets on process restart — intentional
  // for v1.0; Phase 04 integrations persist it via MQTT/Loxone.
  let presence = { detected: false, source: null, updatedAt: 0 };

  // Response cache (Research Pitfall 9).
  let cached = null;
  let cachedAt = 0;

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
  function deriveEnergySection(victron, meter) {
    const solarKw = kw(victron?.pvTotalW);
    const batteryKw = kw(victron?.batteryPowerW); // positive = charging
    const evKw = kw(victron?.evPowerW); // placeholder; many installs lack EV data
    // grid_total_w convention: positive = import, negative = export (default)
    const gridTotalW = Number(meter?.grid_total_w || 0);
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
   * Devices section. Phase 04 INTG-05 will populate with detected 50W+ loads.
   */
  function deriveDevicesSection() {
    return []; // Phase 04 INTG-05
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
   */
  function derivePriceSection(epexNN, epexState) {
    if (!epexNN) {
      return {
        nowCtKwh: null,
        nextHourCtKwh: null,
        todayMinCtKwh: null,
        todayMaxCtKwh: null,
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

    return { nowCtKwh, nextHourCtKwh, todayMinCtKwh, todayMaxCtKwh, slots };
  }

  /**
   * Optimizer section. Returns { enabled: false } when optimizer missing (D-22).
   */
  function deriveOptimizerSection(optimizerStatus) {
    if (!optimizerStatus || !optimizerStatus.enabled) {
      return { enabled: false };
    }
    const schedule = Array.isArray(optimizerStatus.schedule) ? optimizerStatus.schedule : [];
    const first = schedule[0] || null;
    const second = schedule[1] || null;

    const actionLabel = (action) => {
      switch (action) {
        case 'grid_charging': return 'Günstig laden';
        case 'self_consume': return 'Batterie nutzt Solar';
        case 'discharge': return 'Batterie entlädt';
        case 'hold': return 'Batterie hält';
        default: return action || 'unbekannt';
      }
    };

    return {
      enabled: true,
      source: optimizerStatus.source || null,
      lastRunAt: optimizerStatus.lastRunAt || null,
      currentAction: first?.action || optimizerStatus.currentAction || null,
      currentActionLabel: actionLabel(first?.action || optimizerStatus.currentAction),
      nextActionAt: second?.ts || null,
      nextActionLabel: second ? actionLabel(second.action) : null,
      schedule
    };
  }

  /**
   * Savings section. Pre-formatted strings for direct display in the UI.
   */
  function deriveSavingsSection(costs) {
    const todayEur = Math.abs(Number(costs?.netEur || 0)).toFixed(2);
    // Month estimate: linearly extrapolate today's net across ~30 days.
    // Phase 04 will compute real month-to-date from history.
    const monthEur = Math.round(Math.abs(Number(costs?.netEur || 0)) * 30).toString();
    const feedInRevenueEur = Math.abs(Number(costs?.revenueEur || 0)).toFixed(2);
    const avoidedCostEur = Math.abs(Number(costs?.costEur || 0)).toFixed(2);

    return { todayEur, monthEur, feedInRevenueEur, avoidedCostEur };
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
    const forecast = deriveForecastSection(forecastResponse);
    const price = derivePriceSection(epexNN, epexState);
    const optimizer = deriveOptimizerSection(optimizerStatus);
    const savings = deriveSavingsSection(costs);
    const greeting = deriveGreetingSection(energy, optimizerStatus, cfg);

    const payload = {
      now,
      energy,
      battery,
      ev,
      devices,
      forecast,
      price,
      optimizer,
      savings,
      greeting,
      presence: { ...presence },
      config: {
        screensaver: cfg?.family?.screensaver || null,
        presence: cfg?.family?.presence || null
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

  async function start() {
    // Stateless aggregator — no timers, no resources to acquire.
    pushLog?.('family_service_started', {});
  }

  async function close() {
    cached = null;
  }

  return { start, close, buildFamilyStatus, setPresence, getPresence };
}
