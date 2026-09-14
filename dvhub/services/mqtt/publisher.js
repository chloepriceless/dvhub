// services/mqtt/publisher.js -- MQTT Publisher (INTG-02, D-03, D-04)
//
// Broadcasts DVhub state topics every publishIntervalMs (default 5s).
// All state topics use retain:true so newly connecting clients get
// the latest values immediately.
//
// Reads directly from ctx.state (verified state paths from server.js).
//
// DI: hub (MQTT Hub from index.js), ctx (full DI context with state, getCfg, pushLog)

import { buildControlSnapshot, CONTROL_KEYS, CONTROL_TOPIC_SUFFIX } from '../control-snapshot.js';

/**
 * @param {object} hub - MQTT Hub from services/mqtt/index.js
 * @param {{ state: object, getCfg: Function, pushLog: Function }} ctx
 * @returns {{ start: Function, close: Function, topicCount: number }}
 */
export function createMqttPublisher(hub, ctx) {
  const { state, getCfg, pushLog } = ctx;

  let timer = null;
  let lastTopicCount = 0;

  function getIntervalMs() {
    return getCfg().mqtt?.publishIntervalMs || 5000;
  }

  function getPrefix() {
    return getCfg().mqtt?.topicPrefix || 'dvhub';
  }

  /**
   * Find the current EPEX slot price from state.epex.data.
   * Returns the price of the slot containing the current timestamp, or null.
   */
  function getCurrentEpexPrice() {
    const data = state.epex?.data;
    if (!Array.isArray(data) || data.length === 0) return null;
    const now = Date.now();
    const slot = data.find(s => s.startTs <= now && s.endTs > now);
    return slot?.price ?? null;
  }

  /**
   * Publish a single snapshot of all state topics.
   * Called every publishIntervalMs by the interval timer.
   */
  function publishOnce() {
    // Phase 09.2 D-04: outer-boundary timer for the bridge's own publish-cycle
    // health sample. One recordSample per publishOnce — NOT per topic — so
    // the latencyMs ring buffer (cap 60) reflects ~5min of cycles, not
    // ~5s of per-topic noise.
    const __t0 = Date.now();
    const prefix = getPrefix();
    const topics = [];

    // Kodierung (2026-09-14): Strings ROH — vorher kam jeder Textwert JSON-
    // kodiert mit Anführungszeichen in Home Assistant an ("active"), und ein
    // ISO-Zeitstempel war damit für HAs timestamp-Klasse unbrauchbar.
    // Zahlen, Booleans, null und Objekte bleiben JSON (null → "null", HA
    // bekommt dafür ein value_template in ha-discovery.js).
    function pub(suffix, value) {
      const topic = `${prefix}/${suffix}`;
      hub.publish(topic, typeof value === 'string' ? value : JSON.stringify(value), { retain: true });
      topics.push(topic);
    }

    // Energy / Grid
    pub('energy/grid_power_w', state.meter?.grid_total_w ?? 0);
    pub('energy/grid_l1_w', state.meter?.grid_l1_w ?? 0);
    pub('energy/grid_l2_w', state.meter?.grid_l2_w ?? 0);
    pub('energy/grid_l3_w', state.meter?.grid_l3_w ?? 0);

    // Battery
    pub('battery/soc_pct', state.victron?.soc ?? null);
    pub('battery/power_w', state.victron?.batteryPowerW ?? null);
    pub('battery/min_soc_pct', state.victron?.minSocPct ?? null);

    // Solar
    pub('solar/pv_total_w', state.victron?.pvTotalW ?? null);
    pub('solar/pv_dc_w', state.victron?.pvPowerW ?? null);

    // Price
    pub('price/epex_current_ct_kwh', getCurrentEpexPrice());

    // Optimizer (2026-09-14): aus dem echten Prognose-Optimizer-Zustand
    // (services/optimizer/index.js: state.optimizer.source = eos | internal |
    // gated_no_license), Kleinmarkt-Automation als Fallback. Vorher hingen
    // die Topics nur an smallMarketAutomation.lastOutcome — "disabled",
    // während EOS mit 18 Regeln lief (Christins HA-Auszug).
    const opt = state.optimizer || {};
    const sma = state.schedule?.smallMarketAutomation || {};
    const smaActive = !!sma.lastOutcome && sma.lastOutcome !== 'idle' && sma.lastOutcome !== 'disabled';
    let optSource = 'none';
    let optStatus = 'disabled';
    if (opt.source === 'eos' || opt.source === 'internal') {
      optSource = opt.source;
      optStatus = opt.error ? 'error' : (opt.enabled ? 'active' : 'disabled');
    } else if (opt.source === 'gated_no_license') {
      optSource = 'gated';
    } else if (smaActive) {
      optSource = 'market_automation';
      optStatus = 'active';
    }
    pub('optimizer/status', optStatus);
    pub('optimizer/source', optSource);
    pub('optimizer/last_run_at', opt.lastRunAt || sma.lastRunDate || null);
    pub('optimizer/rules_count', Number.isFinite(Number(opt.rulesCount)) ? Number(opt.rulesCount) : null);
    pub('optimizer/error', opt.error ? String(opt.error) : null);

    // System
    pub('system/uptime_sec', Math.round(process.uptime()));
    pub('system/meter_ok', state.meter?.ok ?? false);
    pub('system/victron_updated_at', state.victron?.updatedAt ?? 0);

    // Energy counters
    pub('energy/import_wh', state.energy?.importWh ?? 0);
    pub('energy/export_wh', state.energy?.exportWh ?? 0);
    pub('energy/cost_eur', state.energy?.costEur ?? 0);
    pub('energy/revenue_eur', state.energy?.revenueEur ?? 0);

    // Control (2026-09-14): die aktiven Sollwerte transparent spiegeln, damit
    // ein HA-Akku / Loxone daran hängen kann. null = unbekannt (nie 0
    // erfinden). Schema: docs/MQTT-SCHEMA.md. Victron-spezifische Register
    // (feedExcessDcPv) bewusst nicht dabei.
    const control = buildControlSnapshot(state);
    for (const key of CONTROL_KEYS) pub(CONTROL_TOPIC_SUFFIX[key], control.values[key].value);
    pub('control/source', control.source);
    pub('control/rule', control.rule);
    pub('control/updated_at', control.updatedAt);
    pub('control/paused', control.paused);
    pub('control/state', control.values);

    lastTopicCount = topics.length;
    // Phase 09.2 D-04: track the bridge's own publish-cycle health.
    // Healthy = hub is connected; per-topic samples would flood the ring-buffer.
    // Optional chaining guards the boot-race window before the
    // telemetryReady IIFE in server.js wires ctx.healthTracker.
    ctx.healthTracker?.recordSample('mqtt', {
      latencyMs: Date.now() - __t0,
      success: hub.connected
    });
  }

  async function start() {
    const interval = getIntervalMs();
    pushLog(`[MQTT Publisher] Starting with ${interval}ms interval`);
    // Publish immediately on start, then on interval
    publishOnce();
    // Plan 29-07B: .unref() so an idle publisher timer never holds the event loop
    // open; close() (below) still clearInterval's it on shutdown (unchanged).
    timer = setInterval(publishOnce, interval).unref();
  }

  function close() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  // 2026-09-14: publishIntervalMs ist jetzt in der Oberfläche einstellbar und
  // soll ohne Service-Neustart gelten — Timer neu aufziehen.
  async function restart() {
    close();
    await start();
  }

  return {
    start,
    close,
    restart,
    get topicCount() { return lastTopicCount; },

    // Test-only helpers
    _publishOnce: publishOnce,
    _getIntervalMs: getIntervalMs,
  };
}
