// services/mqtt/ha-discovery.js -- Home Assistant Auto-Discovery (INTG-03, D-20)
//
// Publishes retained config messages to {prefix}/{component}/dvhub_<id>/config so
// Home Assistant auto-discovers DVhub as a single "DVhub" device with all its
// entities. HA MQTT Discovery format:
//   Topic:   {prefix}/{component}/{unique_id}/config        (component = sensor | binary_sensor)
//   Payload: { name, state_topic, unique_id, object_id, device, origin, unit_of_measurement,
//              device_class, state_class, ... }
//
// Entity set + device_class/state_class/units verified against the current HA
// MQTT-Discovery + Energy-Dashboard spec (2026-06-13 research + adversarial review):
//   - Power topics  -> device_class power,  state_class measurement,  W.
//   - SoC (measured)-> device_class battery, state_class measurement,  %.
//   - minSoc is a SETPOINT, NOT a measured SoC -> NO device_class (review fix).
//   - import/export Wh -> device_class energy, state_class total_increasing, Wh.
//     These are the day-to-date grid counters (reset daily; total_increasing
//     handles the reset) and ARE the HA Energy-Dashboard grid sources.
//   - cost/revenue EUR -> device_class monetary, NO state_class (display sensors;
//     the Energy-Dashboard COST slot additionally needs a last_reset — follow-up).
//   - epex price is a ct/kWh RATE, not a monetary total -> NO device_class (review
//     fix: 'monetary' was wrong), state_class measurement.
//   - optimizer last_run is a DATE-ONLY string -> plain text, NO timestamp class.
//   - meter_ok -> binary_sensor, device_class connectivity, payload true/false.
//
// NOTE: the HA Energy-Dashboard SOLAR and BATTERY slots need cumulative Wh
// counters that DVhub does not yet publish (only instantaneous pv_*_w /
// battery_power_w). Those slots remain a follow-up (publish solar/pv_total_wh,
// battery/charge_wh, battery/discharge_wh by integrating the power curve).

const DEVICE_BLOCK = {
  identifiers: ['dvhub'],
  name: 'DVhub',
  manufacturer: 'DVhub',
  model: 'HEMS',
};

const ORIGIN_BLOCK = {
  name: 'DVhub',
  support_url: 'https://dvhub.de',
};

// Publisher sendet null als Text "null" (Strings roh, alles andere JSON).
// HA soll daraus "unknown" machen, keinen Zahlen-Parsefehler.
const NULL_SAFE_TEMPLATE = '{{ none if value in ("null", "") else value }}';

/**
 * Full entity set for HA auto-discovery. Each maps to one
 * {prefix}/{component}/dvhub_{id}/config topic.
 */
const ENTITIES = [
  // --- Power (instantaneous, W) ---
  { id: 'grid_power_w', name: 'DVhub Netzleistung', suffix: 'energy/grid_power_w', unit: 'W', device_class: 'power', state_class: 'measurement', icon: 'mdi:transmission-tower' },
  { id: 'grid_l1_w', name: 'DVhub Netz L1', suffix: 'energy/grid_l1_w', unit: 'W', device_class: 'power', state_class: 'measurement' },
  { id: 'grid_l2_w', name: 'DVhub Netz L2', suffix: 'energy/grid_l2_w', unit: 'W', device_class: 'power', state_class: 'measurement' },
  { id: 'grid_l3_w', name: 'DVhub Netz L3', suffix: 'energy/grid_l3_w', unit: 'W', device_class: 'power', state_class: 'measurement' },
  { id: 'battery_power_w', name: 'DVhub Batterieleistung', suffix: 'battery/power_w', unit: 'W', device_class: 'power', state_class: 'measurement', icon: 'mdi:home-battery' },
  { id: 'pv_total_w', name: 'DVhub PV gesamt', suffix: 'solar/pv_total_w', unit: 'W', device_class: 'power', state_class: 'measurement', icon: 'mdi:solar-power' },
  { id: 'pv_dc_w', name: 'DVhub PV DC', suffix: 'solar/pv_dc_w', unit: 'W', device_class: 'power', state_class: 'measurement', icon: 'mdi:solar-power' },

  // --- Battery state ---
  { id: 'battery_soc_pct', name: 'DVhub Batterie SoC', suffix: 'battery/soc_pct', unit: '%', device_class: 'battery', state_class: 'measurement' },
  // minSoc is a SETPOINT (optimizer floor), not a measured SoC -> no device_class.
  { id: 'battery_min_soc_pct', name: 'DVhub Batterie Min-SoC', suffix: 'battery/min_soc_pct', unit: '%', device_class: null, state_class: 'measurement', icon: 'mdi:battery-arrow-down-outline' },

  // --- Price (ct/kWh RATE, not a monetary total) ---
  { id: 'epex_price_ct_kwh', name: 'DVhub Strompreis', suffix: 'price/epex_current_ct_kwh', unit: 'ct/kWh', device_class: null, state_class: 'measurement', icon: 'mdi:cash' },

  // --- Energy counters (Wh, day-to-date, reset daily) -> HA Energy-Dashboard grid sources ---
  { id: 'import_wh', name: 'DVhub Netzbezug (heute)', suffix: 'energy/import_wh', unit: 'Wh', device_class: 'energy', state_class: 'total_increasing', icon: 'mdi:transmission-tower-import' },
  { id: 'export_wh', name: 'DVhub Einspeisung (heute)', suffix: 'energy/export_wh', unit: 'Wh', device_class: 'energy', state_class: 'total_increasing', icon: 'mdi:transmission-tower-export' },

  // --- Money (EUR, day-to-date) -> display sensors (cost-slot last_reset = follow-up) ---
  { id: 'cost_eur', name: 'DVhub Stromkosten (heute)', suffix: 'energy/cost_eur', unit: 'EUR', device_class: 'monetary', state_class: null, icon: 'mdi:cash-minus' },
  { id: 'revenue_eur', name: 'DVhub Erlös (heute)', suffix: 'energy/revenue_eur', unit: 'EUR', device_class: 'monetary', state_class: null, icon: 'mdi:cash-plus' },

  // --- Optimizer ---
  { id: 'optimizer_status', name: 'DVhub Optimizer', suffix: 'optimizer/status', unit: null, device_class: null, state_class: null, icon: 'mdi:robot' },
  { id: 'optimizer_source', name: 'DVhub Optimizer-Quelle', suffix: 'optimizer/source', unit: null, device_class: null, state_class: null, icon: 'mdi:source-branch' },
  // last_run is a DATE-ONLY string -> plain text, not device_class timestamp.
  { id: 'optimizer_last_run', name: 'DVhub Optimizer letzter Lauf', suffix: 'optimizer/last_run_at', unit: null, device_class: null, state_class: null, icon: 'mdi:clock-outline' },
  // Plan (2026-09-14): Zustand = Anzahl Slots, der Plan selbst (slots[], devices[])
  // hängt als Attribute dran — ApexCharts/Template-Karten lesen ihn direkt.
  { id: 'optimizer_plan', name: 'DVhub Optimizer-Plan', suffix: 'optimizer/plan/slot_count', unit: 'Slots', device_class: null, state_class: null, icon: 'mdi:calendar-clock',
    json_attributes_suffix: 'optimizer/plan/ranges', value_template: NULL_SAFE_TEMPLATE },
  { id: 'optimizer_plan_next', name: 'DVhub Optimizer nächster Slot', suffix: 'optimizer/plan/next_start', unit: null, device_class: 'timestamp', state_class: null, icon: 'mdi:skip-next',
    json_attributes_suffix: 'optimizer/plan/next', value_template: NULL_SAFE_TEMPLATE },

  // --- Control (2026-09-14): DVhubs aktive Sollwerte, gespiegelt aus dem
  // Steuerpfad (services/control-snapshot.js). Sollwerte sind KEINE Messungen
  // → keine power/battery device_class; Einheit + measurement reichen HA für
  // Verlauf und Automationen ("wenn dvhub_control_grid_setpoint_w < 0, Akku
  // entladen"). Victron-spezifische Register (feedExcess) bleiben draußen.
  // null kommt als Text "null" an → value_template macht daraus unknown statt
  // eines Zahlenfehlers im HA-Log.
  { id: 'control_grid_setpoint_w', name: 'DVhub Sollwert Netz', suffix: 'control/grid_setpoint_w', unit: 'W', device_class: null, state_class: 'measurement', icon: 'mdi:transmission-tower', value_template: NULL_SAFE_TEMPLATE },
  { id: 'control_charge_current_a', name: 'DVhub Sollwert Ladestrom', suffix: 'control/charge_current_a', unit: 'A', device_class: null, state_class: 'measurement', icon: 'mdi:current-dc', value_template: NULL_SAFE_TEMPLATE },
  { id: 'control_min_soc_pct', name: 'DVhub Sollwert Min-SoC', suffix: 'control/min_soc_pct', unit: '%', device_class: null, state_class: 'measurement', icon: 'mdi:battery-arrow-down-outline', value_template: NULL_SAFE_TEMPLATE },
  { id: 'control_max_discharge_w', name: 'DVhub Sollwert Entladegrenze', suffix: 'control/max_discharge_w', unit: 'W', device_class: null, state_class: 'measurement', icon: 'mdi:battery-arrow-up-outline', value_template: NULL_SAFE_TEMPLATE },
  { id: 'control_source', name: 'DVhub Steuerquelle', suffix: 'control/source', unit: null, device_class: null, state_class: null, icon: 'mdi:source-branch' },
  { id: 'control_rule', name: 'DVhub Steuerregel', suffix: 'control/rule', unit: null, device_class: null, state_class: null, icon: 'mdi:calendar-clock', entity_category: 'diagnostic', value_template: NULL_SAFE_TEMPLATE },
  // updated_at ist ISO-8601 (oder null) → timestamp-Klasse; leer bleibt unknown.
  { id: 'control_updated_at', name: 'DVhub Sollwert geändert', suffix: 'control/updated_at', unit: null, device_class: 'timestamp', state_class: null, entity_category: 'diagnostic',
    value_template: NULL_SAFE_TEMPLATE },

  // --- System / diagnostics ---
  { id: 'uptime_sec', name: 'DVhub Uptime', suffix: 'system/uptime_sec', unit: 's', device_class: 'duration', state_class: 'measurement', icon: 'mdi:timer-outline', entity_category: 'diagnostic' },
  // victron_updated_at is epoch MS -> convert to a timestamp, guarding the 0 case.
  { id: 'victron_updated_at', name: 'DVhub Victron letztes Update', suffix: 'system/victron_updated_at', unit: null, device_class: 'timestamp', state_class: null, entity_category: 'diagnostic',
    value_template: '{{ none if (value|int) == 0 else ((value|int / 1000) | timestamp_utc) }}' },
  { component: 'binary_sensor', id: 'meter_ok', name: 'DVhub Zähler', suffix: 'system/meter_ok', device_class: 'connectivity', payload_on: 'true', payload_off: 'false', entity_category: 'diagnostic' },
];

function buildPayload(entity, topicPrefix, swVersion) {
  const payload = {
    name: entity.name,
    state_topic: `${topicPrefix}/${entity.suffix}`,
    unique_id: `dvhub_${entity.id}`,
    object_id: `dvhub_${entity.id}`,
    device: { ...DEVICE_BLOCK },
    origin: swVersion ? { ...ORIGIN_BLOCK, sw_version: String(swVersion) } : { ...ORIGIN_BLOCK },
  };
  if (entity.unit) payload.unit_of_measurement = entity.unit;
  if (entity.device_class) payload.device_class = entity.device_class;
  if (entity.state_class) payload.state_class = entity.state_class;
  if (entity.icon) payload.icon = entity.icon;
  if (entity.value_template) payload.value_template = entity.value_template;
  if (entity.entity_category) payload.entity_category = entity.entity_category;
  // JSON-Attribute aus einem zweiten Topic (Plan-Slots): HA hängt das Objekt
  // als Entitäts-Attribute an; ein "null"-Payload wird von HA ignoriert.
  if (entity.json_attributes_suffix) payload.json_attributes_topic = `${topicPrefix}/${entity.json_attributes_suffix}`;
  if ((entity.component || 'sensor') === 'binary_sensor') {
    if (entity.payload_on) payload.payload_on = entity.payload_on;
    if (entity.payload_off) payload.payload_off = entity.payload_off;
  }
  return payload;
}

/**
 * Number of entities DVhub would publish for HA discovery (for the UI).
 */
export function haDiscoveryEntityCount() {
  return ENTITIES.length;
}

/**
 * Publish Home Assistant MQTT Auto-Discovery config topics (retained).
 *
 * @param {object} hub - MQTT Hub with publish(topic, payload, opts) method
 * @param {Function} getCfg - Config getter returning { mqtt: { haDiscovery, topicPrefix } }
 * @param {string} [swVersion] - DVhub app version for the origin block
 * @returns {number} count of config topics published (0 if disabled / no hub)
 */
export function publishHaDiscoveryTopics(hub, getCfg, swVersion) {
  const cfg = getCfg();
  const haConfig = cfg.mqtt?.haDiscovery;
  if (!haConfig?.enabled || !hub?.publish) return 0;

  const prefix = haConfig.prefix || 'homeassistant';
  const topicPrefix = cfg.mqtt?.topicPrefix || 'dvhub';

  let n = 0;
  for (const entity of ENTITIES) {
    const component = entity.component || 'sensor';
    const topic = `${prefix}/${component}/dvhub_${entity.id}/config`;
    hub.publish(topic, JSON.stringify(buildPayload(entity, topicPrefix, swVersion)), { retain: true });
    n++;
  }
  return n;
}

/**
 * Remove DVhub's HA-discovered entities by publishing an empty retained payload
 * to each config topic (the canonical HA device-removal method). Used when the
 * operator turns HA Discovery OFF so HA drops the entities instead of keeping
 * ghosts. Uses the given prefix (or the configured/default one).
 *
 * @param {object} hub
 * @param {Function} getCfg
 * @param {string} [prefixOverride]
 * @returns {number} count of config topics cleared
 */
export function clearHaDiscoveryTopics(hub, getCfg, prefixOverride) {
  if (!hub?.publish) return 0;
  const cfg = getCfg();
  const prefix = prefixOverride || cfg.mqtt?.haDiscovery?.prefix || 'homeassistant';
  let n = 0;
  for (const entity of ENTITIES) {
    const component = entity.component || 'sensor';
    const topic = `${prefix}/${component}/dvhub_${entity.id}/config`;
    hub.publish(topic, '', { retain: true });
    n++;
  }
  return n;
}
