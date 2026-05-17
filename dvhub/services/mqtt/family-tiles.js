// services/mqtt/family-tiles.js -- Generic MQTT value tiles for the Family Dashboard.
//
// Lets the operator configure a list of arbitrary MQTT topics (a Wallbox's
// charging power, any other consumer, a sensor reading, ...) each with a
// display label + optional unit. Whenever a value arrives on a configured
// topic it is cached and surfaced in /api/family/status -> rendered as a
// card on the Family Dashboard.
//
// Display-only: never publishes, never controls. Payload parsing mirrors the
// mqtt-generic device adapter (flat JSON key lookup OR plain primitive).
//
// Factory: createFamilyMqttTiles(hub, ctx) -> { start, close, reload, getTiles }
// DI context: { getCfg, pushLog }

// A tile whose topic produced no message for this long is reported offline.
const OFFLINE_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * @param {{ subscribe: Function }} hub  MQTT Hub from services/mqtt/index.js
 * @param {{ getCfg: Function, pushLog: Function }} ctx  DI context
 */
export function createFamilyMqttTiles(hub, ctx) {
  const { getCfg, pushLog } = ctx;

  // Configured topic-pattern -> { raw: string, lastSeen: number }.
  // Keyed by the *pattern* (not the wire topic) so a wildcard tile resolves:
  // the handler closes over its pattern and writes under that key.
  const lastByTopic = new Map();

  // Patterns already subscribed on the hub. The hub's subscribe() has no
  // unsubscribe — a removed tile simply stops appearing in getTiles(); a
  // stale subscription is a harmless no-op handler.
  const subscribed = new Set();

  /** Configured, enabled tiles with a non-empty topic. */
  function getTileConfigs() {
    const tiles = getCfg?.()?.family?.mqttTiles;
    if (!Array.isArray(tiles)) return [];
    return tiles.filter(t => t && typeof t.topic === 'string' && t.topic.trim() && t.enabled !== false);
  }

  /** Subscribe any configured topic not yet on the wire. Idempotent. */
  function subscribeAll() {
    for (const tile of getTileConfigs()) {
      const pattern = tile.topic;
      if (subscribed.has(pattern)) continue;
      hub.subscribe(pattern, (_topic, payload) => {
        const raw = payload.toString();
        lastByTopic.set(pattern, { raw, lastSeen: Date.now() });

        // D-11/D-12/D-13: historise numeric values into timeseries_samples,
        // fire-and-forget. Look the tile up FRESH (not a stale closure — a
        // field/unit/id edit must be reflected without a restart).
        const tile = getTileConfigs().find(t => t.topic === pattern);
        if (!tile) return;
        const value = extractValue(raw, tile.field);
        if (typeof value !== 'number' || !Number.isFinite(value)) return;  // D-13: numeric only
        // Lazy ctx read — telemetryStore is assigned onto the shared ctx
        // object after this factory runs (server.js wiring order), so a
        // boot-window no-op is expected and acceptable (D-12).
        const store = ctx && ctx.telemetryStore;
        if (!store || typeof store.writeSamples !== 'function') return;
        Promise.resolve()
          .then(() => store.writeSamples([{
            seriesKey: 'mqtt_tile_' + tile.id,
            scope: 'live',
            source: 'mqtt',
            quality: 'raw',
            ts: new Date(),
            resolutionSeconds: 1,
            value,
            valueText: null,
            unit: tile.unit || null,
            meta: { topic: tile.topic }
          }]))
          .catch(err => {
            if (ctx && typeof ctx.pushLog === 'function') {
              ctx.pushLog('family_mqtt_tile_persist_error', { error: err && err.message });
            }
          });
      });
      subscribed.add(pattern);
    }
  }

  /**
   * Extract a display value from a raw MQTT payload.
   *   - JSON object + `field` set -> payload[field]
   *   - JSON object + no field    -> null (ambiguous; operator must pick a field)
   *   - JSON primitive            -> the primitive
   *   - plain string              -> number if numeric, else the trimmed string
   */
  function extractValue(raw, field) {
    if (raw == null) return null;
    const str = String(raw).trim();
    if (str === '') return null;
    try {
      const json = JSON.parse(str);
      if (json !== null && typeof json === 'object') {
        if (field) {
          const v = json[field];
          return (v == null) ? null : v;
        }
        return null; // object payload but no field selected
      }
      return json; // JSON primitive (number / bool / string)
    } catch {
      const num = Number(str);
      return Number.isFinite(num) ? num : str;
    }
  }

  /**
   * Current tile readings for the family payload. Re-reads config every call
   * so newly-added tiles (config save) take effect on the next poll without a
   * restart; subscribeAll() picks up their topics here too.
   */
  function getTiles() {
    subscribeAll();
    const now = Date.now();
    return getTileConfigs().map(tile => {
      const last = lastByTopic.get(tile.topic) || null;
      const value = last ? extractValue(last.raw, tile.field) : null;
      const out = {
        id: tile.id || tile.topic,
        label: tile.label || tile.topic,
        topic: tile.topic,
        unit: typeof tile.unit === 'string' ? tile.unit : '',
        value,
        lastSeen: last ? last.lastSeen : null,
        online: !!(last && (now - last.lastSeen) < OFFLINE_THRESHOLD_MS)
      };
      // Pass the operator-picked per-tile icon/colour through to the kiosk
      // ADDITIVELY (cross-plan data-path gap closed for 11-05): the key is
      // included ONLY when the tile config carries a non-empty string value,
      // mirroring the additive-optional convention used across this phase —
      // an absent key lets the kiosk's resolveTileMeta() auto-derive.
      if (typeof tile.icon === 'string' && tile.icon.trim()) out.icon = tile.icon;
      if (typeof tile.color === 'string' && tile.color.trim()) out.color = tile.color;
      return out;
    });
  }

  async function start() {
    subscribeAll();
    const n = getTileConfigs().length;
    if (n) pushLog?.('family_mqtt_tiles_started', { count: n });
  }

  // Re-read config and subscribe newly-added topics. Safe to call after a
  // config save; removed tiles drop out of getTiles() automatically.
  function reload() {
    subscribeAll();
  }

  function close() {
    lastByTopic.clear();
  }

  return { start, close, reload, getTiles, _extractValue: extractValue };
}
