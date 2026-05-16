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
// Map + start/close lifecycle. The hub's subscribe() has NO unsubscribe — a
// single permanent `#` subscription is fine (exactly one sub).
//
// Factory: createMqttTopicObserver(hub, ctx) -> { start, close, getTopics, get observedSince }
// DI context: { pushLog }

// Memory-exhaustion caps (RESEARCH Pitfall 5). A noisy broker with per-message
// topics could otherwise grow the Map unbounded; a retained payload could be a
// huge JSON blob. MAX_TOPICS evicts the oldest topic by lastAt; MAX_PAYLOAD_CHARS
// bounds the stored preview length.
const MAX_TOPICS = 500;
const MAX_PAYLOAD_CHARS = 512;

/**
 * @param {{ subscribe: Function }} hub  MQTT Hub from services/mqtt/index.js
 * @param {{ pushLog?: Function }} ctx   DI context
 */
export function createMqttTopicObserver(hub, ctx) {
  const { pushLog = () => {} } = ctx || {};
  const topics = new Map(); // topic -> { count, lastAt, lastPayload, seq }
  let startedAt = null;
  // Monotonic update counter. Date.now() has only millisecond resolution, so
  // two messages in the same tick share a lastAt — `seq` is the deterministic
  // tiebreaker that keeps getTopics()/eviction "most recent wins" ordering
  // correct under sub-ms broker message rates (the normal MQTT case).
  let seq = 0;

  function onMessage(topic, payload) {
    let entry = topics.get(topic);
    if (!entry) {
      if (topics.size >= MAX_TOPICS) {
        // Evict the oldest topic by lastAt (seq breaks lastAt ties) — keeps the Map bounded.
        let oldestKey = null, oldestAt = Infinity, oldestSeq = Infinity;
        for (const [k, v] of topics) {
          if (v.lastAt < oldestAt || (v.lastAt === oldestAt && v.seq < oldestSeq)) {
            oldestAt = v.lastAt; oldestSeq = v.seq; oldestKey = k;
          }
        }
        if (oldestKey) topics.delete(oldestKey);
      }
      entry = { count: 0, lastAt: 0, lastPayload: '', seq: 0 };
      topics.set(topic, entry);
    }
    entry.count++;
    entry.lastAt = Date.now();
    entry.seq = ++seq;
    entry.lastPayload = String(payload).slice(0, MAX_PAYLOAD_CHARS);
  }

  function start() {
    hub.subscribe('#', onMessage);   // # = all topics; hub has no unsubscribe (1 sub, fine)
    startedAt = Date.now();
    pushLog('mqtt_topic_observer_started');
  }

  function getTopics() {
    return [...topics.entries()]
      .map(([topic, v]) => ({ topic, count: v.count, lastAt: v.lastAt, lastPayload: v.lastPayload, _seq: v.seq }))
      // Most recent first; _seq breaks lastAt ties deterministically (sub-ms rates).
      .sort((a, b) => (b.lastAt - a.lastAt) || (b._seq - a._seq))
      .map(({ _seq, ...t }) => t);
  }

  function close() {
    topics.clear();
  }

  return { start, close, getTopics, get observedSince() { return startedAt; } };
}
