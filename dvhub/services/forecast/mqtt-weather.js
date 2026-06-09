// services/forecast/mqtt-weather.js -- Configurable MQTT weather provider (T-0131).
//
// End-customer-friendly weather source over MQTT. Two presets:
//   - 'weather4lox' (LoxBerry "Weather4Lox" plugin): a STANDARDISED topic schema,
//     so the customer supplies only broker + topic prefix (default `weather4lox`).
//     We read the HOURLY forecast `<prefix>/hfcNN_*` (NN = forecast hour, ~8h
//     horizon): `hfcNN_sr` = GHI W/m², `hfcNN_sky` = cloud %, `hfcNN_tt` = temp
//     °C, `hfcNN_hu` = humidity %, `hfcNN_date` = Loxone epoch — plus the live
//     `<prefix>/cur_*` nowcast values.
//   - 'custom': the customer maps individual topics (GHI / temp / cloud) for any
//     other source (Home Assistant, ioBroker, Node-RED, a bare station). Those
//     map to a single current ("nowcast") row.
//
// Rows are written to weather_forecasts with provider='mqtt'. forecast-store's
// getLatestWeather merges them with Open-Meteo (local preferred in the overlap,
// Open-Meteo fills the longer >8h horizon) so the existing pvlib / ML / pv-forecast
// consumers need no change.
//
// The provider runs its OWN lightweight mqtt client (default brokerUrl = the
// top-level mqtt.brokerUrl) rather than the shared hub, because in real setups
// Weather4Lox usually lives on the LoxBerry's own broker — keeping it decoupled
// also means it works even when DVhub's own MQTT publishing is disabled.
//
// Factory: createMqttWeather(ctx, { store }) -> { start, close, ingest, _flush, _raw }
// DI context: { state, getCfg, pushLog, bumpForecastVersion }

import { safeInterval } from '../safe-async.js';

// Loxone stores timestamps as seconds since 2009-01-01 00:00:00 UTC.
// unix_seconds = loxone_seconds + 1230768000.
export const LOXONE_EPOCH_OFFSET_S = 1230768000;

export const WEATHER4LOX_DEFAULT_PREFIX = 'weather4lox';

// weather4lox sentinel for "no value available".
const NO_VALUE_SENTINEL = -9999;

// How many hourly forecast slots to scan (weather4lox emits hfc1..hfcN; 48 is a
// safe upper bound — most setups expose ~8).
const MAX_FORECAST_SLOTS = 48;

// Default flush cadence: build rows from the buffered topic values and upsert
// them. weather4lox publishes retained values, so the first flush after connect
// already has a full set; 60s keeps the DB current without churn.
const DEFAULT_FLUSH_INTERVAL_MS = 60_000;

/**
 * Convert a Loxone epoch (seconds since 2009-01-01) to Unix milliseconds.
 * @param {number|string} loxEpoch
 * @returns {number} Unix ms, or NaN if not finite.
 */
export function loxoneEpochToUnixMs(loxEpoch) {
  const n = Number(loxEpoch);
  if (!Number.isFinite(n)) return NaN;
  return (n + LOXONE_EPOCH_OFFSET_S) * 1000;
}

/**
 * Parse an MQTT payload into a finite number.
 * Tolerates a bare numeric string ("203.0") or a JSON `{"value": X}` envelope.
 * Returns null for empty / non-numeric payloads and the weather4lox -9999
 * "no value" sentinel.
 * @param {Buffer|string|number} payload
 * @returns {number|null}
 */
export function parseNumeric(payload) {
  if (payload == null) return null;
  let raw = typeof payload === 'string' ? payload : (Buffer.isBuffer(payload) ? payload.toString() : String(payload));
  raw = raw.trim();
  if (raw === '') return null;
  if (raw[0] === '{' || raw[0] === '[') {
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object' && 'value' in obj) raw = String(obj.value);
    } catch { /* fall through to Number() */ }
  }
  const v = Number(raw);
  if (!Number.isFinite(v)) return null;
  if (v <= NO_VALUE_SENTINEL) return null; // weather4lox "no value"
  return v;
}

/**
 * Strip the configured prefix from a topic, returning the trailing key
 * (e.g. `weather4lox/hfc8_sr` -> `hfc8_sr`). Returns null if the topic is not
 * under the prefix.
 * @param {string} topic
 * @param {string} prefix
 * @returns {string|null}
 */
export function topicSuffix(topic, prefix) {
  if (typeof topic !== 'string') return null;
  const base = (prefix || '').replace(/\/+$/, '');
  const p = base ? base + '/' : '';
  if (p && !topic.startsWith(p)) return null;
  return topic.slice(p.length);
}

/**
 * Build weather_forecasts rows from a flat weather4lox key→value map.
 * Only slots with BOTH a timestamp (`hfcNN_date`) and irradiance (`hfcNN_sr`)
 * become rows; the others are skipped (incomplete).
 * @param {Object<string, number>} raw - e.g. { hfc1_sr: 0, hfc1_date: 5502..., ... }
 * @param {{ provider?: string, maxSlots?: number }} [opts]
 * @returns {Array<object>} rows matching the weather_forecasts schema
 */
export function buildWeather4loxRows(raw, { provider = 'mqtt', maxSlots = MAX_FORECAST_SLOTS } = {}) {
  const rows = [];
  if (!raw || typeof raw !== 'object') return rows;
  for (let n = 1; n <= maxSlots; n++) {
    const date = raw[`hfc${n}_date`];
    const sr = raw[`hfc${n}_sr`];
    if (date == null || sr == null) continue; // need timestamp + irradiance
    const tsMs = loxoneEpochToUnixMs(date);
    if (!Number.isFinite(tsMs)) continue;
    rows.push({
      provider,
      ts_utc: new Date(tsMs).toISOString(),
      ghi_wm2: sr,
      dni_wm2: null,
      dhi_wm2: null,
      temperature_c: raw[`hfc${n}_tt`] ?? null,
      wind_speed_ms: raw[`hfc${n}_ws`] ?? null,
      cloud_cover_pct: raw[`hfc${n}_sky`] ?? null,
      visibility_m: null,
      humidity_pct: raw[`hfc${n}_hu`] ?? null
    });
  }
  return rows;
}

/**
 * Build a single current ("nowcast") weather row for the custom preset, where
 * the customer maps individual topics to fields. Stamps it at the current full
 * hour so it aligns with the hourly weather_forecasts grid.
 * @param {{ ghi?: number|null, temperature?: number|null, cloud?: number|null }} values
 * @param {number} nowMs - injected current time (ms) for testability
 * @param {{ provider?: string }} [opts]
 * @returns {object|null} a row, or null if no GHI value is present
 */
export function buildCustomNowcastRow(values, nowMs, { provider = 'mqtt' } = {}) {
  const ghi = values?.ghi;
  if (ghi == null || !Number.isFinite(Number(ghi))) return null;
  const hourMs = Math.floor(nowMs / 3_600_000) * 3_600_000;
  return {
    provider,
    ts_utc: new Date(hourMs).toISOString(),
    ghi_wm2: Number(ghi),
    dni_wm2: null,
    dhi_wm2: null,
    temperature_c: values.temperature ?? null,
    wind_speed_ms: null,
    cloud_cover_pct: values.cloud ?? null,
    visibility_m: null,
    humidity_pct: null
  };
}

/**
 * Resolve the effective MQTT-weather config from the full config object.
 * @param {object} cfg
 * @returns {{ enabled: boolean, brokerUrl: string|null, username?: string, password?: string,
 *             preset: string, prefix: string, custom: object, flushIntervalMs: number }}
 */
export function resolveMqttWeatherConfig(cfg) {
  const w = cfg?.forecast?.weather || {};
  const m = w.mqtt || {};
  const topMqtt = cfg?.mqtt || {};
  return {
    enabled: w.provider === 'mqtt',
    brokerUrl: m.brokerUrl || topMqtt.brokerUrl || null,
    username: m.username || topMqtt.username || undefined,
    password: m.password || topMqtt.password || undefined,
    preset: m.preset || 'weather4lox',
    prefix: m.prefix || WEATHER4LOX_DEFAULT_PREFIX,
    custom: {
      ghiTopic: m.ghiTopic || '',
      ghiUnit: m.ghiUnit || 'wm2',
      tempTopic: m.tempTopic || '',
      cloudTopic: m.cloudTopic || ''
    },
    flushIntervalMs: Number(m.flushIntervalMs) > 0 ? Number(m.flushIntervalMs) : DEFAULT_FLUSH_INTERVAL_MS
  };
}

/**
 * Create the MQTT weather provider.
 * @param {object} ctx - DI context { state, getCfg, pushLog, bumpForecastVersion }
 * @param {{ store: object }} deps - forecast-store instance
 * @returns {{ start: Function, close: Function, ingest: Function, _flush: Function, _raw: Function }}
 */
export function createMqttWeather(ctx, { store }) {
  const { getCfg, pushLog } = ctx;

  let client = null;
  let flushTimer = null;
  // Flat buffer of the latest value per topic-suffix (weather4lox key or, for
  // custom, the logical field name). Last-write-wins; retained values land here
  // immediately on subscribe.
  let raw = Object.create(null);
  let cfgSnapshot = null;
  let writing = false;

  /**
   * Ingest a single message into the buffer. Pure-ish: updates `raw`, parses
   * the value, and returns the key it stored (or null if ignored). Exposed for
   * tests so the wire layer can be exercised without a broker.
   * @param {string} topic
   * @param {Buffer|string} payload
   */
  function ingest(topic, payload) {
    const c = cfgSnapshot || resolveMqttWeatherConfig(getCfg());
    const value = parseNumeric(payload);

    if (c.preset === 'custom') {
      // Map the configured topics to logical field names.
      let field = null;
      if (topic === c.custom.ghiTopic) field = 'ghi';
      else if (topic === c.custom.tempTopic) field = 'temperature';
      else if (topic === c.custom.cloudTopic) field = 'cloud';
      if (!field) return null;
      if (value == null) { delete raw[field]; return null; }
      raw[field] = value;
      return field;
    }

    // weather4lox preset: store every recognised <prefix>/<key> numeric value.
    const key = topicSuffix(topic, c.prefix);
    if (key == null) return null;
    if (value == null) { delete raw[key]; return null; }
    raw[key] = value;
    return key;
  }

  /** Build rows from the current buffer for the active preset. */
  function buildRows(c, nowMs = Date.now()) {
    if (c.preset === 'custom') {
      const row = buildCustomNowcastRow(
        { ghi: raw.ghi, temperature: raw.temperature, cloud: raw.cloud },
        nowMs,
        { provider: 'mqtt' }
      );
      return row ? [row] : [];
    }
    return buildWeather4loxRows(raw, { provider: 'mqtt' });
  }

  /** Flush buffered values into weather_forecasts. */
  async function flush() {
    if (writing) return;
    const c = cfgSnapshot || resolveMqttWeatherConfig(getCfg());
    if (!c.enabled) return;
    const rows = buildRows(c);
    if (rows.length === 0) {
      pushLog('mqtt_weather_flush_skip', { reason: 'no_complete_slots', preset: c.preset });
      return;
    }
    writing = true;
    try {
      for (const row of rows) {
        await store.insertWeather(row);
      }
      if (ctx.state?.forecast?.weather) {
        ctx.state.forecast.weather.lastFetchAt = Date.now();
        ctx.state.forecast.weather.error = null;
      }
      ctx.bumpForecastVersion?.();
      pushLog('mqtt_weather_flush_ok', { rows: rows.length, preset: c.preset });
    } catch (err) {
      if (ctx.state?.forecast?.weather) ctx.state.forecast.weather.error = err?.message ?? String(err);
      pushLog('mqtt_weather_flush_error', { error: err?.message ?? String(err) });
    } finally {
      writing = false;
    }
  }

  /** Topics to subscribe to for the active preset. */
  function subscriptionTopics(c) {
    if (c.preset === 'custom') {
      return [c.custom.ghiTopic, c.custom.tempTopic, c.custom.cloudTopic].filter(Boolean);
    }
    const base = (c.prefix || WEATHER4LOX_DEFAULT_PREFIX).replace(/\/+$/, '');
    return [`${base}/#`];
  }

  async function start() {
    const c = resolveMqttWeatherConfig(getCfg());
    cfgSnapshot = c;
    if (!c.enabled) return; // provider !== 'mqtt' — nothing to do
    if (!c.brokerUrl) {
      pushLog('mqtt_weather_skip', { reason: 'no_broker_url' });
      return;
    }
    const topics = subscriptionTopics(c);
    if (topics.length === 0) {
      pushLog('mqtt_weather_skip', { reason: 'no_topics', preset: c.preset });
      return;
    }

    try {
      const mqtt = await import('mqtt');
      const connectFn = mqtt.default?.connect || mqtt.connect;
      const opts = { reconnectPeriod: 5000, connectTimeout: 10_000 };
      if (c.username) opts.username = c.username;
      if (c.password) opts.password = c.password;

      client = connectFn(c.brokerUrl, opts);

      client.on('connect', () => {
        for (const t of topics) client.subscribe(t, { qos: 0 });
        pushLog('mqtt_weather_connected', { preset: c.preset, topics: topics.length });
      });
      client.on('message', (topic, payload) => {
        try { ingest(topic, payload); }
        catch (err) { pushLog('mqtt_weather_ingest_error', { error: err?.message ?? String(err) }); }
      });
      client.on('error', (err) => pushLog('mqtt_weather_client_error', { error: err?.message ?? String(err) }));
    } catch (err) {
      pushLog('mqtt_weather_start_error', { error: err?.message ?? String(err) });
      return;
    }

    // Periodic flush — overlap-guarded inside flush().
    if (flushTimer) clearInterval(flushTimer);
    flushTimer = safeInterval('mqtt-weather.flush', () => {
      flush().catch(err => pushLog('mqtt_weather_flush_interval_error', { error: err?.message ?? String(err) }));
    }, c.flushIntervalMs);
  }

  function close() {
    if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
    if (client) { client.removeAllListeners?.(); client.end?.(true); client = null; }
    raw = Object.create(null);
    cfgSnapshot = null;
  }

  return {
    start,
    close,
    ingest,
    // Test/observability helpers
    _flush: flush,
    _raw: () => ({ ...raw })
  };
}
