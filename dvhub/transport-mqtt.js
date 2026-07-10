/**
 * MQTT Transport für Victron Venus OS.
 * Liest Werte über Subscriptions (push-basiert, gecacht),
 * schreibt über W/-Topics mit {"value": X}.
 *
 * Benötigt: npm install mqtt
 */
// Plan 09-07: shared safeInterval wraps the keepalive ticker so a sendKeepalive
// throw (e.g. broker mid-disconnect) never disables the loop.
import { safeInterval } from './services/safe-async.js';

// T-0080 (P1 sweep): MQTT cache freshness. Venus OS pushes N/ values on change +
// after each keepalive; if the broker connection wedges or a subscription is
// silently dropped, the cache keeps the LAST value forever. Serving that stale
// value as if fresh defeats the T-0075 telemetry-freshness floor downstream
// (polling stamps fieldUpdatedAt on any returned value, so a frozen reading
// would look fresh). A cache entry is fresh only if it has a non-null value and
// its timestamp is within maxAgeMs. Pure + exported for testing.
export function mqttCacheEntryFresh(entry, maxAgeMs, nowMs = Date.now()) {
  if (!entry || entry.value == null) return false;
  const max = Number(maxAgeMs);
  if (!Number.isFinite(max) || max <= 0) return true; // staleness disabled
  return (nowMs - Number(entry.ts || 0)) <= max;
}

// T-MQTT-CONSUMPTION (2026-07-04): der Poller fragt den SUMMEN-Punkt
// 'selfConsumptionW' ab (Modbus-Profil: sumRegisters über 817-819) — im
// MQTT-Mapping existierten aber nur die drei Phasen-Topics, sodass
// readPoint('selfConsumptionW') "Kein MQTT-Topic-Mapping" warf und
// state.victron.selfConsumptionW dauerhaft null blieb → loadW (Hausverbrauch-
// Telemetrie → Lastprognose/EOS/Historie) fehlte auf dem MQTT-Transport
// KOMPLETT (live gefunden im Deye-Bridge-Praxistest auf LXC 191).
// Summen-Semantik: eine NIE gesehene Phase zählt 0 (1-/2-phasige Anlagen
// publizieren L2/L3 ggf. gar nicht); eine gesehene, aber STALE Phase macht die
// gesamte Summe stale (T-0080-Frische-Disziplin — sonst würde ein eingefrorenes
// L2 still unterschlagen und die Summe sähe frisch aus). Pure + exportiert für
// test/transport-mqtt-staleness.test.js.
export function sumConsumptionEntries(entries, maxAgeMs, nowMs = Date.now()) {
  let sum = 0;
  let ts = 0;
  let any = false;
  for (const entry of entries) {
    if (!entry) continue;                                          // Phase nie gesehen → 0
    if (!mqttCacheEntryFresh(entry, maxAgeMs, nowMs)) return null; // gesehen, aber stale → Summe stale
    sum += Number(entry.value) || 0;
    ts = Math.max(ts, Number(entry.ts) || 0);
    any = true;
  }
  return any ? { value: sum, ts } : null;
}

// ── Topic-Mapping ────────────────────────────────────────────────────
// Venus-Topic-Schema (N/ = published Werte, W/ = Schreibbefehle). Pure +
// exportiert: das ist der VERTRAG der Universal-MQTT-Schnittstelle
// (hersteller/bridge-mqtt.json, D-27) — der Contract-Test prüft, dass jeder im
// Profil aktivierte Punkt hier ein Topic hat. Eine Bridge, die dieses Schema
// spricht, ist vollständig kompatibel (docs/DEYE-NODERED-BRIDGE.md).
export function buildVenusTopicMaps(portalId) {
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
    // MaxDischargePower (AC-side discharge cap). 0 = no discharge ("hold"), -1 = unlimited,
    // positive = watts. Hidden in the Cerbo console; same target evcc writes for its
    // batteryDischargeControl "hold" mode.
    maxDischargeW:      `W/${portalId}/settings/0/Settings/CGwacs/MaxDischargePower`,
    feedExcessDcPv:     `W/${portalId}/settings/0/Settings/CGwacs/OvervoltageFeedIn`,
    dontFeedExcessAcPv: `W/${portalId}/settings/0/Settings/CGwacs/PreventFeedback`,
  };

  return { READ_TOPICS, WRITE_TOPICS };
}

export function createMqttTransport(victronConfig) {
  const mqttCfg = victronConfig.mqtt || {};
  const broker = mqttCfg.broker || `mqtt://${victronConfig.host}:1883`;
  const portalId = mqttCfg.portalId || '';
  const keepaliveMs = Number(mqttCfg.keepaliveIntervalMs) || 30000;
  const qos = Number(mqttCfg.qos) || 0;
  // Reads older than this are treated as stale (unknown) → re-requested, and the
  // floor downstream holds. Default = 3 keepalive intervals (min 90s). 0 disables.
  const staleMaxAgeMs = mqttCfg.staleMaxAgeMs != null
    ? Number(mqttCfg.staleMaxAgeMs)
    : Math.max(3 * keepaliveMs, 90000);
  let lastStaleReconnectAt = 0;

  let client = null;
  let keepaliveTimer = null;
  const cache = {};  // topic -> { value, ts }

  if (!portalId) {
    console.warn('[MQTT] Kein portalId konfiguriert — MQTT-Topics werden nicht korrekt aufgelöst.');
  }

  const { READ_TOPICS, WRITE_TOPICS } = buildVenusTopicMaps(portalId);

  // T-MQTT-CONSUMPTION: die drei Phasen, aus denen der Summen-Punkt
  // 'selfConsumptionW' gebildet wird (siehe sumConsumptionEntries oben).
  const CONSUMPTION_KEYS = ['selfConsumptionW_l1', 'selfConsumptionW_l2', 'selfConsumptionW_l3'];

  // ── Helpers ────────────────────────────────────────────────────────
  function onMessage(topic, payload, packet) {
    // T-MQTT-RETAIN (2026-07-04, Live-Fund im Deye-Bridge-Praxistest): ein
    // RETAINED-Replay ist KEIN Frische-Beweis. Publiziert eine Bridge mit
    // retain, spielt der Broker die Alt-Werte bei JEDEM (Re-)Subscribe neu ein —
    // inklusive des Stale-Recovery-Reconnects unten. Der Cache stempelte sie mit
    // ts=now, die Frische-Erkennung war dauerhaft ausgehebelt (beobachtet:
    // victron.connected blieb >300 s nach Bridge-Stopp auf true, eingefrorener
    // SoC). Nach MQTT 3.1.1 trägt NUR das Subscribe-Replay das retain-Flag —
    // Live-Publishes an bestehende Subscriber kommen mit retain=false an, auch
    // wenn der Publisher retain gesetzt hat. Replays werden daher verworfen;
    // echte Werte liefert der Keepalive-Zyklus (Venus/Bridge publiziert auf
    // R/<portal>/keepalive alles frisch, Sekunden nach dem Connect).
    if (packet?.retain) return;
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
      const connectFn = mqtt.default?.connect || mqtt.connect;

      // Clean up any existing connection first
      this.destroy();

      return new Promise((resolve, reject) => {
        let settled = false;
        
        client = connectFn(broker, { clean: true, connectTimeout: 5000 });

        const timeoutHandle = setTimeout(() => {
          if (settled) return;
          settled = true;
          if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
          if (client) { client.end(true); client = null; }
          reject(new Error(`MQTT connect timeout (${broker})`));
        }, 8000);

        client.on('connect', () => {
          if (settled) return;
          console.log(`[MQTT] Verbunden mit ${broker}`);
          const topics = Object.values(READ_TOPICS);
          client.subscribe(topics, { qos }, (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutHandle);
            if (err) {
              if (client) { client.end(true); client = null; }
              return reject(err);
            }
            // Keepalive starten — sorgt dafür, dass Settings-Topics gepublished werden
            sendKeepalive();
            if (keepaliveTimer) clearInterval(keepaliveTimer);
            keepaliveTimer = safeInterval('transport-mqtt.keepalive', sendKeepalive, keepaliveMs);
            resolve();
          });
        });

        client.on('message', (topic, payload, packet) => onMessage(topic, payload, packet));
        client.on('error', (err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timeoutHandle);
            if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
            if (client) { client.end(true); client = null; }
            reject(err);
          } else {
            console.error('[MQTT] Fehler:', err?.message || err);
          }
        });
        client.on('reconnect', () => console.log('[MQTT] Reconnecting...'));
      });
    },

    /**
     * Liest einen gecachten Wert. name = logischer Punktname (z.B. 'soc', 'batteryPowerW').
     * MQTT liefert Engineering-Werte direkt (kein Register-Decoding nötig).
     */
    getCached(name) {
      // T-MQTT-CONSUMPTION: Summen-Punkt aus den drei Phasen-Topics.
      if (name === 'selfConsumptionW') {
        const sum = sumConsumptionEntries(
          CONSUMPTION_KEYS.map((k) => cache[READ_TOPICS[k]]), staleMaxAgeMs
        );
        return sum ? sum.value : null;
      }
      const topic = READ_TOPICS[name];
      if (!topic) return null;
      // T-0080: a stale cache entry reads as unknown (null), not the frozen value.
      return mqttCacheEntryFresh(cache[topic], staleMaxAgeMs) ? cache[topic].value : null;
    },

    /**
     * Liest einen Wert — gibt gecachten Wert zurück oder wartet kurz auf Empfang.
     * Gibt { mqttValue, ts } zurück.
     */
    async readPoint(name) {
      // T-MQTT-CONSUMPTION: Summen-Punkt 'selfConsumptionW' = L1+L2+L3 (frisch).
      // Fehlt/stale → alle drei Phasen per R/ nachfordern und einmal nachfassen
      // (gleicher Recovery-Pfad wie der generische Zweig unten).
      if (name === 'selfConsumptionW') {
        const summed = () => sumConsumptionEntries(
          CONSUMPTION_KEYS.map((k) => cache[READ_TOPICS[k]]), staleMaxAgeMs
        );
        let sum = summed();
        if (sum) return { mqttValue: sum.value, ts: sum.ts };
        if (client?.connected) {
          for (const k of CONSUMPTION_KEYS) {
            client.publish(READ_TOPICS[k].replace(/^N\//, 'R/'), '');
          }
        }
        await new Promise((r) => setTimeout(r, 2000));
        sum = summed();
        if (sum) return { mqttValue: sum.value, ts: sum.ts };
        throw new Error('MQTT-Wert nicht verfügbar oder veraltet für: selfConsumptionW');
      }
      const topic = READ_TOPICS[name];
      if (!topic) throw new Error(`Kein MQTT-Topic-Mapping für: ${name}`);

      // T-0080: only a FRESH cache entry is served directly. A stale one falls
      // through to the re-request path (so a wedged subscription is recovered and
      // the downstream T-0075 floor holds instead of trusting a frozen reading).
      if (mqttCacheEntryFresh(cache[topic], staleMaxAgeMs)) {
        return { mqttValue: cache[topic].value, ts: cache[topic].ts };
      }

      // Missing OR stale: re-request via R/ and, if a (now-stale) value existed,
      // the subscription may be wedged → nudge a throttled reconnect to re-subscribe.
      const wasStale = !!cache[topic];
      if (client?.connected) {
        const readTopic = topic.replace(/^N\//, 'R/');
        client.publish(readTopic, '');
        if (wasStale && typeof client.reconnect === 'function') {
          const now = Date.now();
          if (now - lastStaleReconnectAt > staleMaxAgeMs) {
            lastStaleReconnectAt = now;
            try { client.reconnect(); } catch { /* best-effort recovery */ }
          }
        }
      }
      await new Promise((r) => setTimeout(r, 2000));
      if (mqttCacheEntryFresh(cache[topic], staleMaxAgeMs)) {
        return { mqttValue: cache[topic].value, ts: cache[topic].ts };
      }
      throw new Error(`MQTT-Wert nicht verfügbar oder veraltet für: ${name}`);
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
      if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
      if (client) { client.removeAllListeners(); client.end(true); client = null; }
    }
  };
}
