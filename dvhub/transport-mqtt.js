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
import { isReadOnlyMode, noteBlockedWrite, ReadOnlyViolation } from './read-only-guard.js';

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
    // T-VERIFY (2026-07-20): Read-Seite für JEDES Write-Target, damit die
    // Write-Verifikation (schedule-eval scheduleWriteVerify) den Ist-Zustand
    // rücklesen kann. Venus published Settings-Topics auf N/ nach Änderung und
    // nach jedem Keepalive — dieselben Pfade wie die W/-Topics unten.
    chargeCurrentA:     `N/${portalId}/settings/0/Settings/SystemSetup/MaxChargeCurrent`,
    maxDischargeW:      `N/${portalId}/settings/0/Settings/CGwacs/MaxDischargePower`,
    feedExcessDcPv:     `N/${portalId}/settings/0/Settings/CGwacs/OvervoltageFeedIn`,
    dontFeedExcessAcPv: `N/${portalId}/settings/0/Settings/CGwacs/PreventFeedback`,
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

// ── DVhub-Topic-Schema (2026-09-14) ──────────────────────────────────
// Herstellerneutrales Gegenstück zum Venus-Schema für Anlagen, deren Akku/PV/
// Zähler nur in Home Assistant, Loxone o. ä. existieren (Profil
// hersteller/dvhub-mqtt.json). Lesewerte kommen unter <prefix>/input/… als
// nackte Zahlen herein, Steuerbefehle gehen unter <prefix>/control/<ziel>/set
// hinaus. Die Zustandsspiegel <prefix>/control/<ziel> (ohne /set) publiziert
// der Hub-Publisher retained — Command- und State-Topic sind getrennt, wie in
// HA üblich. Kein Keepalive, kein R/-Nachfordern: der Lieferant publiziert
// periodisch (Frische-Disziplin T-0080 gilt unverändert, staleMaxAgeMs).
// Victron-Register (feedExcessDcPv, dontFeedExcessAcPv) haben hier bewusst
// kein Topic. Vertrag: docs/MQTT-SCHEMA.md + test/transport-mqtt-dvhub-schema.
export function buildDvhubTopicMaps(topicPrefix) {
  const p = String(topicPrefix || '').replace(/^\/+|\/+$/g, '') || 'dvhub';
  const READ_TOPICS = {
    meter_l1:            `${p}/input/grid/l1_w`,
    meter_l2:            `${p}/input/grid/l2_w`,
    meter_l3:            `${p}/input/grid/l3_w`,
    // Gesamtwerte (HA/Loxone liefern meist nur diese). Haben Vorrang vor den
    // Phasen; Netz/Verbrauch: entweder total_w ODER Phasen publizieren.
    meter_total:         `${p}/input/grid/total_w`,
    soc:                 `${p}/input/battery/soc_pct`,
    batteryPowerW:       `${p}/input/battery/power_w`,
    pvPowerW:            `${p}/input/pv/dc_w`,
    // PV gesamt (DC + AC in einem Wert) — Alternative zu dc_w/ac_*_w, nicht zusätzlich.
    pvTotalInput:        `${p}/input/pv/total_w`,
    acPvL1W:             `${p}/input/pv/ac_l1_w`,
    acPvL2W:             `${p}/input/pv/ac_l2_w`,
    acPvL3W:             `${p}/input/pv/ac_l3_w`,
    selfConsumptionW_l1: `${p}/input/consumption/l1_w`,
    selfConsumptionW_l2: `${p}/input/consumption/l2_w`,
    selfConsumptionW_l3: `${p}/input/consumption/l3_w`,
    selfConsumptionW_total: `${p}/input/consumption/total_w`,
    // Rücklesung der Sollwerte (optional — fehlt sie, bleibt der Punkt null)
    gridSetpointW:       `${p}/input/control/grid_setpoint_w`,
    minSocPct:           `${p}/input/control/min_soc_pct`,
    chargeCurrentA:      `${p}/input/control/charge_current_a`,
    maxDischargeW:       `${p}/input/control/max_discharge_w`,
  };
  const WRITE_TOPICS = {
    gridSetpointW:  `${p}/control/grid_setpoint_w/set`,
    chargeCurrentA: `${p}/control/charge_current_a/set`,
    minSocPct:      `${p}/control/min_soc_pct/set`,
    maxDischargeW:  `${p}/control/max_discharge_w/set`,
  };
  return { READ_TOPICS, WRITE_TOPICS };
}

// Logische Eingänge (HTTP-Push, services/input-push.js) → Schlüssel in
// READ_TOPICS des DVhub-Schemas. Push und MQTT füllen denselben Cache.
export const DVHUB_INPUT_KEYS = {
  grid_total: 'meter_total', grid_l1: 'meter_l1', grid_l2: 'meter_l2', grid_l3: 'meter_l3',
  pv_total: 'pvTotalInput', battery_power: 'batteryPowerW', battery_soc: 'soc',
  consumption_total: 'selfConsumptionW_total',
  consumption_l1: 'selfConsumptionW_l1', consumption_l2: 'selfConsumptionW_l2', consumption_l3: 'selfConsumptionW_l3',
};

/**
 * Payload → Zahl. Versteht nackte Zahlen ("42.5"), JSON-Zahlen und das
 * Venus-Format {"value": X}. undefined = unbrauchbar (kein Wert erfinden);
 * null wird als "Lieferant meldet unbekannt" durchgereicht.
 */
export function parseMqttPayload(payload) {
  const text = String(payload ?? '').trim();
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'number') return Number.isFinite(parsed) ? parsed : undefined;
    if (parsed && typeof parsed === 'object' && 'value' in parsed) {
      const v = parsed.value;
      if (v === null) return null;
      return typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);
    }
    return undefined;
  } catch {
    const n = Number(text);
    return Number.isFinite(n) ? n : undefined;
  }
}

// Broker-URL für Leitstand-Events: nur Schema/Host/Port, niemals Zugangsdaten
// (mqtt://user:pass@host → mqtt://host:port).
function sanitizeBrokerUrl(raw) {
  try {
    const u = new URL(String(raw));
    const port = u.port ? `:${u.port}` : '';
    return `${u.protocol}//${u.hostname}${port}`;
  } catch {
    return String(raw).replace(/\/\/[^/@]*@/, '//');
  }
}

export function createMqttTransport(victronConfig, options = {}) {
  const mqttCfg = victronConfig.mqtt || {};
  // DVhub-Schema ohne eigene Broker-URL: Standard ist der eingebaute DVhub-
  // Broker (server.js reicht ihn als options.defaultBroker herein) — HA/Loxone
  // publizieren dann direkt an DVhub, ein eigener Mosquitto ist nicht nötig.
  // Ohne Broker (DVhub-Schema, kein eigener, kein laufender DVhub-Broker):
  // reiner Push-Modus — Werte nur per HTTP (/api/input/push), keine Verbindung,
  // keine Endlos-Wiederholungen im Log. Steuerwerte liest Loxone dann über
  // /api/integration/loxone (dvhub_control_*).
  const pushOnly = mqttCfg.schema === 'dvhub' && !mqttCfg.broker && !options?.defaultBroker;
  const brokerMode = mqttCfg.broker ? 'own' : (pushOnly ? 'push-only' : (mqttCfg.schema === 'dvhub' ? 'hub' : 'own'));
  const broker = pushOnly ? null : (mqttCfg.broker
    || (mqttCfg.schema === 'dvhub' && options?.defaultBroker)
    || `mqtt://${victronConfig.host}:1883`);
  // Leitstand-Sichtbarkeit (test/transport-mqtt-events.test.js, Kundenfall
  // 2026-09-29): optionale Ereignis-Callback (server.js → pushLog) für
  // mqtt_connected / mqtt_connect_error / mqtt_disconnected. onEvent ist
  // optional — Aufrufer ohne options (altesignal) dürfen nicht brechen.
  const onEvent = typeof options?.onEvent === 'function' ? options.onEvent : null;
  const brokerLabel = pushOnly ? 'kein Broker (nur HTTP-Push)' : sanitizeBrokerUrl(broker);
  let pushOnlyNoted = false;
  function emitEvent(event, details, level) {
    if (!onEvent) return;
    try { onEvent(event, details, level); } catch { /* Log darf den Transport nicht killen */ }
  }
  // Spam-Schutz: an einem toten Broker wirft mqtt.js pro Reconnect-Versuch
  // (~alle 1 s) ein error-Event — Leitstand-Ring (1000 Einträge) und Audit-DB
  // würden von der Sturmschleife zugespült. Identische Fehlertexte melden
  // höchstens alle 30 s einmal; der Kundenfall braucht die Ursache, nicht
  // jeden einzelnen Fehlversuch.
  const CONNECT_ERROR_DEDUP_MS = 30000;
  let lastConnectError = { message: '', ts: 0 };
  // event: 'mqtt_connect_error' (Verbindungsaufbau scheitert) oder 'mqtt_error'
  // (Fehler während einer bestehenden Sitzung) — gleiche Entprellung.
  function emitConnectError(errMessage, event = 'mqtt_connect_error') {
    const message = String(errMessage || 'unknown');
    const now = Date.now();
    const key = `${event}|${message}`;
    if (key === lastConnectError.message && now - lastConnectError.ts < CONNECT_ERROR_DEDUP_MS) return;
    lastConnectError = { message: key, ts: now };
    emitEvent(event, { broker: brokerLabel, error: message }, 'error');
  }
  const portalId = mqttCfg.portalId || '';
  const schema = mqttCfg.schema === 'dvhub' ? 'dvhub' : 'venus';
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
  // Disconnect-Events nur für echte, aktive Sitzungen — nicht für den
  // controlled shutdown (destroy) und nicht für eine nie zustande gekommene
  // Erstverbindung (die meldet mqtt_connect_error).
  let sessionActive = false;
  let closing = false;

  if (schema === 'venus' && !portalId) {
    console.warn('[MQTT] Kein portalId konfiguriert — MQTT-Topics werden nicht korrekt aufgelöst.');
  }

  const { READ_TOPICS, WRITE_TOPICS } = schema === 'dvhub'
    ? buildDvhubTopicMaps(mqttCfg.topicPrefix)
    : buildVenusTopicMaps(portalId);

  // Venus: Wert per R/-Topic nachfordern (Venus published dann auf N/).
  // DVhub-Schema: kein Nachfordern — der Lieferant publiziert periodisch.
  function readRequestTopic(topic) {
    if (schema !== 'venus') return null;
    return String(topic).replace(/^N\//, 'R/');
  }
  function requestRead(topic) {
    const rt = readRequestTopic(topic);
    if (rt && client?.connected) client.publish(rt, '');
  }
  // Venus: {"value": X}; DVhub-Schema: nackte Zahl (HA/Loxone-freundlich).
  function encodeWrite(value) {
    return schema === 'dvhub' ? String(value) : JSON.stringify({ value });
  }

  // ── MQTT-PAYLOAD-FIX (Kundenfall 2026-10-02, Deye-Bridge deye1) ────────
  // Ein verwerfbarer Payload war bisher UNSICHTBAR: der Venus-Zweig unten
  // verwarf alles, was kein JSON-Objekt mit .value ist, ohne eine Zeile Log.
  // Eine Bridge, die nackte Zahlen publiziert ("26" statt {"value":26}),
  // sah damit aus wie ein Lieferausfall ("Wert nicht verfügbar oder
  // veraltet") statt wie ein Formatfehler. Je Topic entprellt gemeldet
  // (gleiches Muster wie CONNECT_ERROR_DEDUP_MS oben) — ein 1-s-Takt darf
  // den Leitstand-Ring nicht fluten.
  const BAD_PAYLOAD_DEDUP_MS = 60000;
  const badPayloadAt = new Map();
  function noteUnusablePayload(topic, payload) {
    const now = Date.now();
    if (now - (badPayloadAt.get(topic) || 0) < BAD_PAYLOAD_DEDUP_MS) return;
    badPayloadAt.set(topic, now);
    const sample = JSON.stringify(String(payload ?? '').slice(0, 60));
    console.warn(`[MQTT] Payload für ${topic} nicht verwertbar (Venus erwartet {"value":X}): ${sample}`);
    // typeof-Guard: Stände zwischen 2026-09-14 und 2026-09-29 (z. B. 572475c)
    // haben den Parser, aber noch kein emitEvent — Warnung geht auch ohne Leitstand.
    if (typeof emitEvent === 'function') emitEvent('mqtt_payload_unusable', { topic, sample }, 'warn');
  }

  // T-MQTT-CONSUMPTION: die drei Phasen, aus denen der Summen-Punkt
  // 'selfConsumptionW' gebildet wird (siehe sumConsumptionEntries oben).
  const CONSUMPTION_KEYS = ['selfConsumptionW_l1', 'selfConsumptionW_l2', 'selfConsumptionW_l3'];
  const GRID_KEYS = ['meter_l1', 'meter_l2', 'meter_l3'];
  const freshEntry = (key) => {
    const e = READ_TOPICS[key] ? cache[READ_TOPICS[key]] : null;
    return mqttCacheEntryFresh(e, staleMaxAgeMs) ? { value: Number(e.value), ts: e.ts } : null;
  };
  // Hausverbrauch: frischer Gesamtwert hat Vorrang, sonst Phasensumme.
  function consumptionEntry() {
    return freshEntry('selfConsumptionW_total')
      || sumConsumptionEntries(CONSUMPTION_KEYS.map((k) => cache[READ_TOPICS[k]]), staleMaxAgeMs);
  }
  // PV (DVhub-Schema): dc_w, sonst pv/total_w.
  function pvEntry() {
    return freshEntry('pvPowerW') || freshEntry('pvTotalInput');
  }

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
    if (schema === 'dvhub') {
      // Nackte Zahl, JSON-Zahl oder {value}; Unbrauchbares wird ignoriert.
      const v = parseMqttPayload(payload);
      if (v !== undefined) cache[topic] = { value: v, ts: Date.now() };
      return;
    }
    // MQTT-PAYLOAD-FIX: parseMqttPayload ist derselbe Toleranz-Parser, den der
    // dvhub-Zweig oben schon nutzt — er versteht das dokumentierte Venus-Format
    // {"value": X} (docs/DEYE-NODERED-BRIDGE.md), zusätzlich aber auch nackte
    // Zahlen ("-952") und JSON-Zahlen. {"value": null} bleibt null und wird
    // bewusst MIT gespeichert (Alarm-Decoderei: null ≠ 0).
    const v = parseMqttPayload(payload);
    if (v !== undefined) {
      cache[topic] = { value: v, ts: Date.now() };
      rememberAlarmTopic(topic, v);
    } else {
      noteUnusablePayload(topic, payload);
    }
  }

  // T-MQTT-ALARMS: Alarmwerte je Dienst nach dbus-Pfad ablegen
  // (N/<portal>/<dienst>/<instanz>/<pfad…>). `null` wird bewusst MIT gespeichert:
  // Venus meldet so „Alarm vom Gerät nicht unterstützt", und der Decoder
  // überspringt null — als 0 gelesen wäre es ein falsches „alles in Ordnung".
  const alarmCache = { vebus: {}, battery: {}, ts: 0 };
  function rememberAlarmTopic(topic, value) {
    const parts = String(topic).split('/');
    const service = parts[2];
    if (service !== 'vebus' && service !== 'battery') return;
    const path = parts.slice(4).join('/');
    if (!path) return;
    alarmCache[service][path] = value;
    alarmCache.ts = Date.now();
  }

  /** Rohwerte für buildActiveAlarmsFromDbus; null wenn nie etwas ankam/zu alt. */
  function getAlarmValues(maxAgeMs = staleMaxAgeMs) {
    if (!alarmCache.ts) return null;
    if (maxAgeMs > 0 && (Date.now() - alarmCache.ts) > maxAgeMs) return null;
    return { vebus: { ...alarmCache.vebus }, battery: { ...alarmCache.battery }, ts: alarmCache.ts };
  }

  function sendKeepalive() {
    if (schema !== 'venus') return;   // DVhub-Schema kennt kein Keepalive
    if (client?.connected) {
      client.publish(`R/${portalId}/keepalive`, '');
    }
  }

  // ── Transport-Interface ────────────────────────────────────────────
  return {
    type: 'mqtt',
    getAlarmValues,

    async init() {
      if (pushOnly) {
        if (!pushOnlyNoted) {
          pushOnlyNoted = true;
          console.log('[MQTT] DVhub-Schema ohne Broker — nur HTTP-Push (/api/input/push).');
          emitEvent('mqtt_push_only', { broker: brokerLabel }, 'info');
        }
        return;
      }
      const mqtt = await import('mqtt');
      // options.connectFn: nur für Tests (Fake-Client); Betrieb nutzt mqtt.js.
      const connectFn = typeof options?.connectFn === 'function' ? options.connectFn : (mqtt.default?.connect || mqtt.connect);

      // Clean up any existing connection first
      this.destroy();
      closing = false;

      return new Promise((resolve, reject) => {
        let settled = false;
        
        // T-MQTT-AUTH (2026-07-25): Venus >= 3.x verlangt auf dem lokalen Broker
        // (FlashMQ) Zugangsdaten — geprüft am Ekrano GX: ohne Passwort kommt
        // „Connection refused: Not authorized", mit dem Remote-Console-Passwort
        // verbindet er (Benutzername beliebig). Ohne diese Optionen konnte der
        // MQTT-Transport an einem aktuellen GX gar nicht arbeiten. Zusätzlich
        // TLS-Option: das Gerät liefert ein selbstsigniertes Zertifikat
        // (CN=venus.local), eine CA-Prüfung schlägt zwangsläufig fehl.
        // clean: true + resubscribe-Default (mqtt.js >=2 verdrahtet): NACH einem
        // Reconnect uebernimmt mqtt.js die Registration der damals abonnierten
        // Topics selbst — unser subscribe() laeuft im settled-Zweig NICHT mehr.
        // Der Reconnect-Test in test/transport-mqtt-events.test.js prueft den
        // Datenfluss nach Reconnect explizit, falls sich diese Abhaengigkeit je
        // aendert (Upgrade/Refactor).
        const connectOpts = { clean: true, connectTimeout: 5000 };
        // Broker der DVhub-MQTT-Integration mitbenutzt: auch deren Zugangsdaten
        // übernehmen (sonst anonym → abgewiesen), eigene Angaben unter
        // victron.mqtt haben aber Vorrang.
        const auth = brokerMode === 'hub' ? (options?.defaultBrokerAuth || {}) : {};
        const username = mqttCfg.username || auth.username;
        const password = mqttCfg.password || auth.password;
        if (username) connectOpts.username = username;
        if (password) connectOpts.password = password;
        if (String(broker).startsWith('mqtts://')) {
          connectOpts.rejectUnauthorized = typeof mqttCfg.rejectUnauthorized === 'boolean'
            ? mqttCfg.rejectUnauthorized === true
            : auth.rejectUnauthorized === true;
        }
        client = connectFn(broker, connectOpts);

        const timeoutHandle = setTimeout(() => {
          if (settled) return;
          settled = true;
          emitConnectError('timeout');
          if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
          if (client) { client.end(true); client = null; }
          // brokerLabel statt broker: die Meldung landet über server.js im
          // journal/console — Zugangsdaten gehören nicht in Logs.
          reject(new Error(`MQTT connect timeout (${brokerLabel})`));
        }, 8000);

        client.on('connect', () => {
          if (settled) {
            // Reconnect im laufenden Betrieb (mqtt.js resubscribed selbst): die
            // Sitzung gilt wieder als aktiv — ohne das bliebe sessionActive auf
            // false und JEDE spätere Trennung wäre unsichtbar; zudem wäre der
            // Leitstand einseitig (getrennt ja, wieder verbunden nein).
            sessionActive = true;
            lastConnectError = { message: '', ts: 0 };
            emitEvent('mqtt_connected', { broker: brokerLabel }, 'info');
            return;
          }
          console.log(`[MQTT] Verbunden mit ${brokerLabel}`);
          // T-MQTT-ALARMS (2026-07-25): Geräte-Alarme kamen bisher NUR über
          // Modbus-Blockreads — auf MQTT blieb das Banner dauerhaft leer.
          // Wildcards, weil die Instanz-Nummern anlagenspezifisch sind
          // (Live-Dump Ekrano: vebus/276, battery/512).
          const topics = Object.values(READ_TOPICS).concat((schema === 'venus' && portalId) ? [
            `N/${portalId}/vebus/+/Alarms/#`,
            `N/${portalId}/vebus/+/VebusError`,
            `N/${portalId}/battery/+/Alarms/#`
          ] : []);
          client.subscribe(topics, { qos }, (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutHandle);
            if (err) {
              emitConnectError(err?.message || err);
              if (client) { client.end(true); client = null; }
              return reject(err);
            }
            sessionActive = true;
            // Neue SUCCESS-Session setzt das Dedup-Fenster zurueck: ein frischer
            // Ausfall nach einem Reconnect ist ein neues Ereignis, kein Echo.
            lastConnectError = { message: '', ts: 0 };
            emitEvent('mqtt_connected', { broker: brokerLabel }, 'info');
            // Keepalive starten — sorgt dafür, dass Settings-Topics gepublished werden
            sendKeepalive();
            if (keepaliveTimer) clearInterval(keepaliveTimer);
            keepaliveTimer = safeInterval('transport-mqtt.keepalive', sendKeepalive, keepaliveMs);
            resolve();
          });
        });

        client.on('message', (topic, payload, packet) => onMessage(topic, payload, packet));
        client.on('error', (err) => {
          // Während einer bestehenden Sitzung ist ein Fehler KEIN Verbindungs-
          // aufbau-Problem — eigener Ereignisname, sonst führt der Leitstand in
          // die falsche Richtung (Broker-Port prüfen, obwohl die Verbindung steht).
          emitConnectError(err?.message || err, sessionActive ? 'mqtt_error' : 'mqtt_connect_error');
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
        // Broker-Neustart/Keepalive-Aus: mqtt.js feuert dafür nur 'close', kein
        // 'error'. Ohne mqtt_disconnected wäre verbunden→getrennt im Leitstand
        // unsichtbar (dieselbe Blindstelle wie der Kundenfall).
        client.on('close', () => {
          if (sessionActive && !closing) {
            sessionActive = false;
            emitEvent('mqtt_disconnected', { broker: brokerLabel }, 'warn');
          }
        });
        client.on('reconnect', () => console.log('[MQTT] Reconnecting...'));
      });
    },

    /**
     * Liest einen gecachten Wert. name = logischer Punktname (z.B. 'soc', 'batteryPowerW').
     * MQTT liefert Engineering-Werte direkt (kein Register-Decoding nötig).
     */
    // Netzleistung für den Poller: { total, l1, l2, l3, ts } (Rohwerte, Bezug
    // positiv) oder null, wenn nichts Frisches vorliegt. Frischer Gesamtwert
    // hat Vorrang; sonst Phasensumme mit derselben Regel wie beim Verbrauch
    // (nie gesehene Phase = 0, gesehene aber veraltete → alles ungültig).
    // null ist WICHTIG: früher wurde ein toter Zufluss als 0 W „ok“ gemeldet.
    readGrid() {
      const total = freshEntry('meter_total');
      if (total) {
        const ph = GRID_KEYS.map((k) => freshEntry(k));
        return { total: total.value, l1: ph[0]?.value ?? null, l2: ph[1]?.value ?? null, l3: ph[2]?.value ?? null, ts: total.ts };
      }
      const entries = GRID_KEYS.map((k) => cache[READ_TOPICS[k]]);
      const sum = sumConsumptionEntries(entries, staleMaxAgeMs);
      if (!sum) return null;
      const v = entries.map((e) => (e ? Number(e.value) : 0));
      return { total: sum.value, l1: v[0], l2: v[1], l3: v[2], ts: sum.ts };
    },

    // HTTP-Push (services/input-push.js): Wert eines logischen Eingangs in den
    // Cache schreiben, als wäre er per MQTT gekommen. Nur im DVhub-Schema.
    ingest(input, value, nowMs = Date.now()) {
      if (schema !== 'dvhub') return false;
      const key = DVHUB_INPUT_KEYS[input];
      const topic = key && READ_TOPICS[key];
      const v = Number(value);
      if (!topic || !Number.isFinite(v)) return false;
      cache[topic] = { value: v, ts: nowMs };
      return true;
    },
    inputStatus(nowMs = Date.now()) {
      if (schema !== 'dvhub') return null;
      return Object.fromEntries(Object.entries(DVHUB_INPUT_KEYS).map(([input, key]) => {
        const e = cache[READ_TOPICS[key]];
        return [input, {
          topic: READ_TOPICS[key],
          value: e ? e.value : null,
          ageMs: e ? nowMs - e.ts : null,
          fresh: mqttCacheEntryFresh(e, staleMaxAgeMs, nowMs),
        }];
      }));
    },
    get staleMaxAgeMs() { return staleMaxAgeMs; },
    get brokerMode() { return brokerMode; },

    getCached(name) {
      // T-MQTT-CONSUMPTION: Summen-Punkt aus den Phasen-Topics bzw. Gesamtwert.
      if (name === 'selfConsumptionW') {
        const sum = consumptionEntry();
        return sum ? sum.value : null;
      }
      if (name === 'pvPowerW' && schema === 'dvhub') {
        const pv = pvEntry();
        return pv ? pv.value : null;
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
        const summed = consumptionEntry;
        let sum = summed();
        if (sum) return { mqttValue: sum.value, ts: sum.ts };
        for (const k of CONSUMPTION_KEYS) requestRead(READ_TOPICS[k]);
        await new Promise((r) => setTimeout(r, 2000));
        sum = summed();
        if (sum) return { mqttValue: sum.value, ts: sum.ts };
        throw new Error('MQTT-Wert nicht verfügbar oder veraltet für: selfConsumptionW');
      }
      if (name === 'pvPowerW' && schema === 'dvhub') {
        let pv = pvEntry();
        if (pv) return { mqttValue: pv.value, ts: pv.ts };
        await new Promise((r) => setTimeout(r, 2000));
        pv = pvEntry();
        if (pv) return { mqttValue: pv.value, ts: pv.ts };
        throw new Error('MQTT-Wert nicht verfügbar oder veraltet für: pvPowerW');
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
        requestRead(topic);
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
     * T-VERIFY: Liest einen Punkt und akzeptiert NUR Werte, die NACH sinceTs
     * beobachtet wurden — für Read-after-Write-Verifikation. Ein frischer
     * Cache-Eintrag von VOR dem Write würde sonst fälschlich als Bestätigung
     * durchgehen (staleMaxAgeMs ist dafür viel zu grob, default 90 s). Fehlt ein
     * Nach-Write-Wert, wird er per R/-Topic aktiv nachgefordert (Venus published
     * dann auf N/) und einmal nachgefasst. Wirft, wenn bis dahin nichts kommt —
     * der Aufrufer unterscheidet "kein Beweis" von "falscher Wert".
     * Gibt { mqttValue, ts } zurück.
     */
    async readPointSince(name, sinceTs) {
      const topic = READ_TOPICS[name];
      if (!topic) throw new Error(`Kein MQTT-Topic-Mapping für: ${name}`);
      const freshEnough = () => {
        const e = cache[topic];
        return e && e.value != null && Number(e.ts || 0) >= Number(sinceTs || 0);
      };
      if (freshEnough()) return { mqttValue: cache[topic].value, ts: cache[topic].ts };
      requestRead(topic);
      await new Promise((r) => setTimeout(r, 2000));
      if (freshEnough()) return { mqttValue: cache[topic].value, ts: cache[topic].ts };
      throw new Error(`Kein Nach-Write-Wert empfangen für: ${name}`);
    },

    /**
     * Schreibt einen Engineering-Wert auf das passende W/-Topic.
     * writeName = logischer Name (z.B. 'gridSetpointW', 'feedExcessDcPv').
     */
    async mqttWrite(writeName, value) {
      const topic = WRITE_TOPICS[writeName];
      if (!topic) throw new Error(`Kein MQTT-Write-Mapping für: ${writeName}`);
      // Lese-Modus: einzige MQTT-Schreibstelle zur Anlage (W/-Topics).
      // Vor dem Verbindungscheck, damit die Ablehnung unabhaengig davon greift.
      if (isReadOnlyMode()) {
        noteBlockedWrite(`MQTT ${topic}`);
        throw new ReadOnlyViolation(`Schreibzugriff im Lese-Modus abgelehnt (MQTT ${writeName})`);
      }
      if (pushOnly) {
        // Kein Broker: der Sollwert ist im DVhub-Zustand gespeichert und steht
        // Loxone unter /api/integration/loxone bereit — kein Fehler pro Zyklus.
        return { ok: true, topic: null, value, pushOnly: true };
      }
      if (!client?.connected) throw new Error('MQTT nicht verbunden');
      const payload = encodeWrite(value);
      client.publish(topic, payload, { qos });
      return { ok: true, topic, value };
    },

    async destroy() {
      closing = true;
      sessionActive = false;
      if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
      if (client) { client.removeAllListeners(); client.end(true); client = null; }
    },

    // Schema-Vertrag + Test-Seams (2026-09-14)
    schema,
    _onMessage: onMessage,
    _cacheSnapshot: () => ({ ...cache }),
    _writeTopics: () => ({ ...WRITE_TOPICS }),
    _readTopics: () => ({ ...READ_TOPICS }),
    _encodeWrite: encodeWrite,
    _readRequestTopic: readRequestTopic
  };
}
