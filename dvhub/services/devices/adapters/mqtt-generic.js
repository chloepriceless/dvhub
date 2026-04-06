// services/devices/adapters/mqtt-generic.js -- MQTT Generic adapter (INTG-05)
//
// Subscribes to configurable MQTT topics and extracts power/energy readings
// from device messages. Supports Zigbee2MQTT, Tasmota, HA-MQTT, Loxone-MQTT.
//
// Field extraction: FLAT key lookup only (payload[powerField]).
// Nested field support (e.g., ENERGY.Power) explicitly NOT supported in v1.0.
// Fallback: parseFloat for plain number payloads (covers Tasmota plain).
//
// Threat mitigations:
//   T-04-14: Validate numeric fields with Number.isFinite() before storing

const OFFLINE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

/**
 * @param {object} hub - MQTT hub with subscribe(topic, handler)
 * @param {Array<{id: string, name: string, mqtt: {topic: string, powerField: string, energyField: string}}>} deviceConfigs
 * @param {Function} pushLog
 * @returns {{ type: string, start: Function, close: Function, getDevices: Function, _setLastSeen: Function }}
 */
export function createMqttGenericAdapter(hub, deviceConfigs, pushLog) {
  /** @type {Map<string, {id: string, name: string, powerW: number|null, energyTodayWh: number|null, lastSeen: number}>} */
  const readings = new Map();

  // Topic -> deviceId mapping for dispatch
  const topicToDevice = new Map();

  // Initialize all devices with null readings
  for (const cfg of deviceConfigs) {
    readings.set(cfg.id, {
      id: cfg.id,
      name: cfg.name,
      powerW: null,
      energyTodayWh: null,
      lastSeen: 0,
    });
    topicToDevice.set(cfg.mqtt.topic, cfg);
  }

  /**
   * Safely extract a finite number, returning null for non-finite/null/undefined values (T-04-14).
   */
  function safeNumber(val) {
    if (val == null) return null;  // null or undefined -> null
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Try parseFloat fallback for plain number payloads (Tasmota plain).
   */
  function tryPlainNumber(str) {
    const num = parseFloat(str);
    return Number.isFinite(num) ? num : null;
  }

  /**
   * Handle incoming MQTT message for a device.
   */
  function handleMessage(deviceCfg, _topic, payload) {
    const payloadStr = payload.toString();
    let powerW = null;
    let energyTodayWh = null;
    let parsed = false;

    try {
      const json = JSON.parse(payloadStr);
      if (typeof json === 'object' && json !== null) {
        // Flat key lookup only
        powerW = safeNumber(json[deviceCfg.mqtt.powerField]);
        energyTodayWh = safeNumber(json[deviceCfg.mqtt.energyField]);
        parsed = true;
      }
      // If JSON.parse returned a primitive (number, string), fall through to plain number path
    } catch {
      // JSON parse failed entirely
    }

    if (!parsed) {
      // Try parseFloat fallback (plain number payload like "125.3")
      powerW = tryPlainNumber(payloadStr);
      energyTodayWh = null;
    }

    const reading = readings.get(deviceCfg.id);
    if (reading) {
      reading.powerW = powerW;
      reading.energyTodayWh = energyTodayWh;
      reading.lastSeen = Date.now();
    }
  }

  async function start() {
    for (const cfg of deviceConfigs) {
      hub.subscribe(cfg.mqtt.topic, (topic, payload) => {
        handleMessage(cfg, topic, payload);
      });
    }
    if (deviceConfigs.length) {
      pushLog('mqtt_generic_started', { count: deviceConfigs.length });
    }
  }

  function close() {
    // No-op: hub handles unsubscribe on shutdown
  }

  function getDevices() {
    const now = Date.now();
    const result = [];
    for (const reading of readings.values()) {
      result.push({
        id: reading.id,
        name: reading.name,
        powerW: reading.powerW,
        energyTodayWh: reading.energyTodayWh,
        online: reading.lastSeen > 0 && (now - reading.lastSeen) < OFFLINE_THRESHOLD_MS,
        lastSeen: reading.lastSeen,
      });
    }
    return result;
  }

  // Test helper: allows tests to manipulate lastSeen for offline detection
  function _setLastSeen(deviceId, ts) {
    const reading = readings.get(deviceId);
    if (reading) reading.lastSeen = ts;
  }

  return { type: 'mqtt-generic', start, close, getDevices, _setLastSeen };
}
