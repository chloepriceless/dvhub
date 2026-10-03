// services/mqtt/topic-observer.js -- inbound MQTT topic registry for the
// Integrations-page MQTT Inspector drawer (Phase 09.4 D-05).
//
// `ctx.mqttPublisher.topicCount` is OUTBOUND-only — it counts DVhub's own
// ~22 published state topics and knows nothing about what other clients put
// on the broker (RESEARCH Pitfall 1). This component subscribes to the `#`
// multi-level wildcard and maintains an in-memory registry of every topic
// seen on the broker, so the MQTT Inspector has a true "MQTT Explorer" data
// source.
//
// Modelled on services/mqtt/family-tiles.js: factory(hub, ctx) + an in-memory
// Map + start/close lifecycle.
//
// Nur bei Bedarf (2026-10-03): das `#`-Abo lässt den Broker JEDE Nachricht an
// DVhub schicken — auf dem eHive war das der größte Posten der Leerlauf-CPU
// (13 % eines Kerns, fast alles MQTT-Empfang), obwohl nur der MQTT-Inspektor
// und die Topic-Vorschläge im Geräte-Editor die Liste lesen. Das Abo wird
// darum erst beim ersten getTopics() gesetzt und IDLE_MS nach dem letzten
// Abruf wieder beendet. Der erste Abruf liefert, was bis dahin ankam
// (retained sofort, der Rest binnen Sekunden — der Inspektor fragt laufend).
//
// Factory: createMqttTopicObserver(hub, ctx) -> { start, close, getTopics, get observedSince, get observing }
// DI context: { pushLog, now, idleMs }

// Memory-exhaustion caps (RESEARCH Pitfall 5). A noisy broker with per-message
// topics could otherwise grow the Map unbounded; a retained payload could be a
// huge JSON blob. MAX_TOPICS evicts the oldest topic by lastAt; MAX_PAYLOAD_CHARS
// bounds the stored preview length.
const MAX_TOPICS = 500;
const MAX_PAYLOAD_CHARS = 512;
export const TOPIC_OBSERVER_IDLE_MS = 10 * 60_000;

/**
 * @param {{ subscribe: Function }} hub  MQTT Hub from services/mqtt/index.js
 * @param {{ pushLog?: Function }} ctx   DI context
 */
export function createMqttTopicObserver(hub, ctx) {
  const { pushLog = () => {}, now = () => Date.now(), idleMs = TOPIC_OBSERVER_IDLE_MS } = ctx || {};
  const topics = new Map(); // topic -> { count, lastAt, lastPayload, seq }
  let startedAt = null;     // seit wann das '#'-Abo läuft; null = hört nicht mit
  let started = false;
  let lastUsedAt = 0;
  let idleTimer = null;
  // Monotonic update counter. Date.now() has only millisecond resolution, so
  // two messages in the same tick share a lastAt — `seq` is the deterministic
  // tiebreaker that keeps getTopics()/eviction "most recent wins" ordering
  // correct under sub-ms broker message rates (the normal MQTT case).
  let seq = 0;

  function onMessage(topic, payload) {
    let entry = topics.get(topic);
    if (entry) {
      // Map in Zugriffsreihenfolge halten (zuletzt aktualisiert = hinten): so ist
      // der erste Schlüssel immer der älteste und das Verdrängen kostet O(1)
      // statt eines Durchlaufs über alle 500 Themen bei jedem neuen Thema.
      topics.delete(topic);
    } else {
      if (topics.size >= MAX_TOPICS) topics.delete(topics.keys().next().value);
      entry = { count: 0, lastAt: 0, lastPayload: '', seq: 0 };
    }
    topics.set(topic, entry);
    entry.count++;
    entry.lastAt = now();
    entry.seq = ++seq;
    // Nur den Anfang dekodieren — große Payloads (Bilder, JSON-Dumps) nicht
    // komplett in einen String wandeln.
    entry.lastPayload = (Buffer.isBuffer(payload) ? payload.subarray(0, MAX_PAYLOAD_CHARS * 4).toString() : String(payload))
      .slice(0, MAX_PAYLOAD_CHARS);
  }

  function observe() {
    if (startedAt !== null) return;
    hub.subscribe('#', onMessage);   // # = all topics
    startedAt = now();
    pushLog('mqtt_topic_observer_listening');
  }

  function release() {
    if (startedAt === null) return;
    hub.unsubscribe?.('#', onMessage);
    startedAt = null;
    topics.clear();
    pushLog('mqtt_topic_observer_idle');
  }

  /** Abo beenden, wenn seit idleMs niemand die Liste gelesen hat. */
  function checkIdle() {
    if (startedAt !== null && now() - lastUsedAt >= idleMs) release();
  }

  function start() {
    started = true;
    if (!idleTimer) {
      idleTimer = setInterval(checkIdle, 60_000);
      idleTimer.unref?.();
    }
    pushLog('mqtt_topic_observer_started');
  }

  function getTopics() {
    if (started) {
      lastUsedAt = now();
      observe();
    }
    return [...topics.entries()]
      .map(([topic, v]) => ({ topic, count: v.count, lastAt: v.lastAt, lastPayload: v.lastPayload, _seq: v.seq }))
      // Most recent first; _seq breaks lastAt ties deterministically (sub-ms rates).
      .sort((a, b) => (b.lastAt - a.lastAt) || (b._seq - a._seq))
      .map(({ _seq, ...t }) => t);
  }

  function close() {
    started = false;
    if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
    release();
    topics.clear();
  }

  return {
    start, close, getTopics, checkIdle,
    get observedSince() { return startedAt; },
    get observing() { return startedAt !== null; },
  };
}
