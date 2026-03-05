/**
 * MQTT Transport für Victron Venus OS.
 * Liest Werte über Subscriptions (push-basiert, gecacht),
 * schreibt über W/-Topics mit {"value": X}.
 *
 * Benötigt: npm install mqtt
 */
export function createMqttTransport(victronConfig) {
  const mqttCfg = victronConfig.mqtt || {};
  const broker = mqttCfg.broker || `mqtt://${victronConfig.host}:1883`;
  const portalId = mqttCfg.portalId || '';
  const keepaliveMs = Number(mqttCfg.keepaliveIntervalMs) || 30000;
  const qos = Number(mqttCfg.qos) || 0;

  let client = null;
  let keepaliveTimer = null;
  const cache = {};  // topic -> { value, ts }

  if (!portalId) {
    console.warn('[MQTT] Kein portalId konfiguriert — MQTT-Topics werden nicht korrekt aufgelöst.');
  }

  // ── Topic-Mapping ──────────────────────────────────────────────────
  // Read-Topics (N/ prefix — Venus OS published diese automatisch oder nach keepalive)
  const READ_TOPICS = {
    meter_l1:         `N/${portalId}/system/0/Ac/Grid/L1/Power`,
    meter_l2:         `N/${portalId}/system/0/Ac/Grid/L2/Power`,
    meter_l3:         `N/${portalId}/system/0/Ac/Grid/L3/Power`,
    soc:              `N/${portalId}/system/0/Dc/Battery/Soc`,
    batteryPowerW:    `N/${portalId}/system/0/Dc/Battery/Power`,
    pvPowerW:         `N/${portalId}/system/0/Dc/Pv/Power`,
    acPvL1W:          `N/${portalId}/system/0/Ac/PvOnGrid/L1/Power`,
    acPvL2W:          `N/${portalId}/system/0/Ac/PvOnGrid/L2/Power`,
    acPvL3W:          `N/${portalId}/system/0/Ac/PvOnGrid/L3/Power`,
    selfConsumptionW_l1: `N/${portalId}/system/0/Ac/Consumption/L1/Power`,
    selfConsumptionW_l2: `N/${portalId}/system/0/Ac/Consumption/L2/Power`,
    selfConsumptionW_l3: `N/${portalId}/system/0/Ac/Consumption/L3/Power`,
    gridSetpointW:    `N/${portalId}/settings/0/Settings/CGwacs/AcPowerSetPoint`,
    minSocPct:        `N/${portalId}/settings/0/Settings/CGwacs/BatteryLife/MinimumSocLimit`,
  };

  // Write-Topics (W/ prefix)
  const WRITE_TOPICS = {
    gridSetpointW:      `W/${portalId}/settings/0/Settings/CGwacs/AcPowerSetPoint`,
    chargeCurrentA:     `W/${portalId}/settings/0/Settings/SystemSetup/MaxChargeCurrent`,
    minSocPct:          `W/${portalId}/settings/0/Settings/CGwacs/BatteryLife/MinimumSocLimit`,
    feedExcessDcPv:     `W/${portalId}/settings/0/Settings/CGwacs/OvervoltageFeedIn`,
    dontFeedExcessAcPv: `W/${portalId}/settings/0/Settings/CGwacs/PreventFeedback`,
  };

  // ── Helpers ────────────────────────────────────────────────────────
  function onMessage(topic, payload) {
    try {
      const msg = JSON.parse(payload.toString());
      if (msg.value !== undefined) {
        cache[topic] = { value: msg.value, ts: Date.now() };
      }
    } catch { /* parse-Fehler ignorieren */ }
  }

  function sendKeepalive() {
    if (client?.connected) {
      client.publish(`R/${portalId}/keepalive`, '');
    }
  }

  // ── Transport-Interface ────────────────────────────────────────────
  return {
    type: 'mqtt',

    async init() {
      const mqtt = await import('mqtt');
      const connect = mqtt.default?.connect || mqtt.connect;

      return new Promise((resolve, reject) => {
        client = connect(broker, { clean: true, connectTimeout: 5000 });

        client.on('connect', () => {
          console.log(`[MQTT] Verbunden mit ${broker}`);
          const topics = Object.values(READ_TOPICS);
          client.subscribe(topics, { qos }, (err) => {
            if (err) return reject(err);
            // Keepalive starten — sorgt dafür, dass Settings-Topics gepublished werden
            sendKeepalive();
            keepaliveTimer = setInterval(sendKeepalive, keepaliveMs);
            resolve();
          });
        });

        client.on('message', onMessage);
        client.on('error', (err) => console.error('[MQTT] Fehler:', err.message));
        client.on('reconnect', () => console.log('[MQTT] Reconnecting...'));

        // Timeout falls Broker nicht erreichbar
        setTimeout(() => reject(new Error(`MQTT connect timeout (${broker})`)), 8000);
      });
    },

    /**
     * Liest einen gecachten Wert. name = logischer Punktname (z.B. 'soc', 'batteryPowerW').
     * MQTT liefert Engineering-Werte direkt (kein Register-Decoding nötig).
     */
    getCached(name) {
      const topic = READ_TOPICS[name];
      return topic ? (cache[topic]?.value ?? null) : null;
    },

    /**
     * Liest einen Wert — gibt gecachten Wert zurück oder wartet kurz auf Empfang.
     * Gibt { mqttValue, ts } zurück.
     */
    async readPoint(name) {
      const topic = READ_TOPICS[name];
      if (!topic) throw new Error(`Kein MQTT-Topic-Mapping für: ${name}`);

      const cached = cache[topic];
      if (cached && cached.value != null) return { mqttValue: cached.value, ts: cached.ts };

      // Falls noch kein Wert: R/-Request senden und kurz warten
      if (client?.connected) {
        const readTopic = topic.replace(/^N\//, 'R/');
        client.publish(readTopic, '');
      }
      await new Promise((r) => setTimeout(r, 2000));
      const retry = cache[topic];
      if (retry && retry.value != null) return { mqttValue: retry.value, ts: retry.ts };
      throw new Error(`MQTT-Wert nicht verfügbar für: ${name}`);
    },

    /**
     * Schreibt einen Engineering-Wert auf das passende W/-Topic.
     * writeName = logischer Name (z.B. 'gridSetpointW', 'feedExcessDcPv').
     */
    async mqttWrite(writeName, value) {
      const topic = WRITE_TOPICS[writeName];
      if (!topic) throw new Error(`Kein MQTT-Write-Mapping für: ${writeName}`);
      if (!client?.connected) throw new Error('MQTT nicht verbunden');
      const payload = JSON.stringify({ value });
      client.publish(topic, payload, { qos });
      return { ok: true, topic, value };
    },

    async destroy() {
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      if (client) {
        client.end(true);
        client = null;
      }
    }
  };
}
