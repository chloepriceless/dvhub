// services/mqtt/ha-discovery.js -- Home Assistant Auto-Discovery (INTG-03, D-20)
//
// Publishes retained config messages to homeassistant/sensor/dvhub_*/config
// so that Home Assistant automatically discovers DVhub sensors.
//
// HA MQTT Discovery format:
//   Topic:   {prefix}/sensor/{unique_id}/config
//   Payload: { name, state_topic, unique_id, unit_of_measurement, device_class, device: {...} }
//
// All payloads include a shared device block linking sensors to a single "DVhub" device in HA.

const DEVICE_BLOCK = {
  identifiers: ['dvhub'],
  name: 'DVhub',
  manufacturer: 'DVhub',
  model: 'HEMS',
};

/**
 * Sensor definitions for HA auto-discovery.
 * Each entry maps to one homeassistant/sensor/dvhub_{id}/config topic.
 */
const SENSORS = [
  {
    id: 'grid_power_w',
    name: 'DVhub Grid Power',
    state_topic_suffix: 'energy/grid_power_w',
    unit: 'W',
    device_class: 'power',
  },
  {
    id: 'battery_soc_pct',
    name: 'DVhub Battery SoC',
    state_topic_suffix: 'battery/soc_pct',
    unit: '%',
    device_class: 'battery',
  },
  {
    id: 'pv_total_w',
    name: 'DVhub PV Total',
    state_topic_suffix: 'solar/pv_total_w',
    unit: 'W',
    device_class: 'power',
  },
  {
    id: 'epex_price_now',
    name: 'DVhub EPEX Price',
    state_topic_suffix: 'price/epex_current_ct_kwh',
    unit: 'ct/kWh',
    device_class: 'monetary',
  },
  {
    id: 'optimizer_status',
    name: 'DVhub Optimizer Status',
    state_topic_suffix: 'optimizer/status',
    unit: null,
    device_class: null,
  },
  {
    id: 'battery_power_w',
    name: 'DVhub Battery Power',
    state_topic_suffix: 'battery/power_w',
    unit: 'W',
    device_class: 'power',
  },
];

/**
 * Publish Home Assistant MQTT Auto-Discovery config topics.
 *
 * @param {object} hub - MQTT Hub with publish() method
 * @param {Function} getCfg - Config getter returning { mqtt: { haDiscovery, topicPrefix } }
 */
export function publishHaDiscoveryTopics(hub, getCfg) {
  const cfg = getCfg();
  const haConfig = cfg.mqtt?.haDiscovery;
  if (!haConfig?.enabled) return;

  const prefix = haConfig.prefix || 'homeassistant';
  const topicPrefix = cfg.mqtt?.topicPrefix || 'dvhub';

  for (const sensor of SENSORS) {
    const topic = `${prefix}/sensor/dvhub_${sensor.id}/config`;
    const payload = {
      name: sensor.name,
      state_topic: `${topicPrefix}/${sensor.state_topic_suffix}`,
      unique_id: `dvhub_${sensor.id}`,
      device: { ...DEVICE_BLOCK },
    };
    if (sensor.unit) payload.unit_of_measurement = sensor.unit;
    if (sensor.device_class) payload.device_class = sensor.device_class;

    hub.publish(topic, JSON.stringify(payload), { retain: true });
  }
}
