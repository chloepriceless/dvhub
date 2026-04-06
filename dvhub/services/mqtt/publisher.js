// services/mqtt/publisher.js -- MQTT Publisher (INTG-02, D-03, D-04)
//
// Broadcasts DVhub state topics every publishIntervalMs (default 5s).
// All state topics use retain:true so newly connecting clients get
// the latest values immediately.
//
// Reads directly from ctx.state (verified state paths from server.js).
//
// DI: hub (MQTT Hub from index.js), ctx (full DI context with state, getCfg, pushLog)

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
    const prefix = getPrefix();
    const topics = [];

    function pub(suffix, value) {
      const topic = `${prefix}/${suffix}`;
      hub.publish(topic, JSON.stringify(value), { retain: true });
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

    // Optimizer
    pub('optimizer/status', state.schedule?.smallMarketAutomation?.lastOutcome === 'idle' ? 'disabled' : 'active');
    pub('optimizer/source', state.schedule?.smallMarketAutomation?.lastOutcome || 'none');
    pub('optimizer/last_run_at', state.schedule?.smallMarketAutomation?.lastRunDate || null);

    // System
    pub('system/uptime_sec', Math.round(process.uptime()));
    pub('system/meter_ok', state.meter?.ok ?? false);
    pub('system/victron_updated_at', state.victron?.updatedAt ?? 0);

    // Energy counters
    pub('energy/import_wh', state.energy?.importWh ?? 0);
    pub('energy/export_wh', state.energy?.exportWh ?? 0);
    pub('energy/cost_eur', state.energy?.costEur ?? 0);
    pub('energy/revenue_eur', state.energy?.revenueEur ?? 0);

    lastTopicCount = topics.length;
  }

  function start() {
    const interval = getIntervalMs();
    pushLog(`[MQTT Publisher] Starting with ${interval}ms interval`);
    // Publish immediately on start, then on interval
    publishOnce();
    timer = setInterval(publishOnce, interval);
  }

  function close() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    start,
    close,
    get topicCount() { return lastTopicCount; },

    // Test-only helpers
    _publishOnce: publishOnce,
    _getIntervalMs: getIntervalMs,
  };
}
