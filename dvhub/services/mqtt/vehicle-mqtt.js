// services/mqtt/vehicle-mqtt.js — Fahrzeugdaten über frei wählbare MQTT-Topics.
//
// DVhub kennt den Ladestand des E-Autos bisher nur von TeslaMate oder evcc
// (ev-soc.js). Wer eine andere Marke fährt und kein evcc hat (Wallbox OpenEVSE
// oder go-e), bekam keinen Ladestand — EOS kann das Auto dann nicht planen.
// Statt jeden Hersteller einzeln anzubinden, liest DVhub den Ladestand von
// einem MQTT-Topic: Home Assistant (oder jede andere Quelle) kennt praktisch
// alle Marken und veröffentlicht deren Werte per MQTT.
//
// Nur lesend: es wird nie veröffentlicht und nichts gesteuert.
//
// Einstellungen (optimizer.*):
//   evMqttSocTopic       Topic mit dem Ladestand in Prozent (Pflicht)
//   evMqttSocField       Feldname, falls das Topic ein JSON-Objekt liefert
//   evMqttPluggedTopic   Topic „angesteckt“ (optional; sonst sagt es die Wallbox)
//   evMqttPluggedField   Feldname bei JSON-Objekt
//   evMqttMaxAgeH        wie alt ein Wert höchstens sein darf (Standard 24 h —
//                        ein stehendes Auto ändert seinen Ladestand nicht, viele
//                        Quellen senden nur bei Änderung)
//
// Factory: createVehicleMqtt(hub, ctx) -> { start, getState, close }

export const VEHICLE_MQTT_DEFAULT_MAX_AGE_H = 24;

const PLUGGED_TRUE = new Set(['true', 'on', '1', 'yes', 'connected', 'plugged', 'plugged_in', 'charging', 'angesteckt', 'verbunden']);
const PLUGGED_FALSE = new Set(['false', 'off', '0', 'no', 'disconnected', 'unplugged', 'not_connected', 'abgezogen', 'getrennt']);

/**
 * Wert aus einer MQTT-Nachricht: JSON-Objekt + Feld -> dieses Feld; JSON-Objekt
 * ohne Feld -> null (mehrdeutig); sonst der einfache Wert.
 */
export function extractMqttValue(raw, field) {
  if (raw == null) return null;
  const str = String(raw).trim();
  if (str === '') return null;
  try {
    const json = JSON.parse(str);
    if (json !== null && typeof json === 'object') {
      if (!field) return null;
      const value = json[field];
      return value == null ? null : value;
    }
    return json;
  } catch {
    return str;
  }
}

/** Ladestand in Prozent (0…100) aus einem Wert; "73 %" und "73,5" zählen auch. */
export function parseSocPct(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  const num = typeof value === 'number' ? value : Number(String(value).replace('%', '').replace(',', '.').trim());
  if (!Number.isFinite(num) || num < 0 || num > 100) return null;
  return num;
}

/** „Angesteckt“ aus einem Wert; null, wenn er sich nicht deuten lässt. */
export function parsePlugged(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (PLUGGED_TRUE.has(text)) return true;
  if (PLUGGED_FALSE.has(text)) return false;
  return null;
}

/**
 * @param {{ subscribe: Function }} hub  MQTT-Hub (services/mqtt/index.js)
 * @param {{ getCfg: Function, pushLog?: Function }} ctx
 * @param {{ now?: () => number }} [deps]
 */
export function createVehicleMqtt(hub, ctx, { now = () => Date.now() } = {}) {
  const { getCfg } = ctx;
  // Letzte Nachricht je abonniertem Topic. Der Hub kennt kein Abbestellen für
  // einzelne Handler dieser Art — ein nicht mehr eingestelltes Topic wird
  // einfach nicht mehr gelesen.
  const last = new Map();
  const subscribed = new Set();

  function settings() {
    const opt = getCfg?.()?.optimizer || {};
    const topic = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const field = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
    const maxAgeH = Number(opt.evMqttMaxAgeH) > 0 ? Number(opt.evMqttMaxAgeH) : VEHICLE_MQTT_DEFAULT_MAX_AGE_H;
    return {
      socTopic: topic(opt.evMqttSocTopic),
      socField: field(opt.evMqttSocField),
      pluggedTopic: topic(opt.evMqttPluggedTopic),
      pluggedField: field(opt.evMqttPluggedField),
      maxAgeMs: maxAgeH * 3600_000
    };
  }

  function ensureSubscribed(topic) {
    if (!topic || subscribed.has(topic)) return;
    hub.subscribe(topic, (_wireTopic, payload) => {
      last.set(topic, { raw: payload == null ? '' : payload.toString(), at: now() });
    });
    subscribed.add(topic);
  }

  /**
   * Aktueller Stand. Abonniert die eingestellten Topics beim ersten Aufruf
   * (und neue, sobald die Einstellung geändert wurde).
   * @returns {{ configured: boolean, socPct: number|null, socAt: number|null,
   *   socStale: boolean, plugged: boolean|null, pluggedAt: number|null }}
   */
  function getState() {
    const cfg = settings();
    ensureSubscribed(cfg.socTopic);
    ensureSubscribed(cfg.pluggedTopic);
    const t = now();
    const soc = cfg.socTopic ? last.get(cfg.socTopic) : null;
    const plug = cfg.pluggedTopic ? last.get(cfg.pluggedTopic) : null;
    const socValue = soc ? parseSocPct(extractMqttValue(soc.raw, cfg.socField)) : null;
    const socStale = !!soc && t - soc.at > cfg.maxAgeMs;
    const plugValue = plug && t - plug.at <= cfg.maxAgeMs ? parsePlugged(extractMqttValue(plug.raw, cfg.pluggedField)) : null;
    return {
      configured: !!cfg.socTopic,
      socPct: socStale ? null : socValue,
      socAt: soc ? soc.at : null,
      socStale,
      plugged: plugValue,
      pluggedAt: plug ? plug.at : null
    };
  }

  return {
    getState,
    /** Topics schon beim Start abonnieren, damit der erste Wert nicht verloren geht. */
    start() { getState(); },
    close() { last.clear(); }
  };
}
