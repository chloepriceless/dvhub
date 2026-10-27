// services/vehicle-pull/index.js — Ladestand des E-Autos per Abruf: beliebiger
// HTTP-Endpunkt (JSON + Pfad) oder Home Assistant (REST-API, Langzeit-Token).
//
// Owner-Vorgabe 2026-10-27: jede Marke muss gehen. Wer weder TeslaMate noch
// evcc noch einen MQTT-Broker hat, kennt den Ladestand oft trotzdem — in Home
// Assistant (Hersteller-Integrationen) oder hinter einer eigenen URL (Skript,
// Node-RED, Hersteller-Bridge). DVhub fragt sie ab, nur lesend.
//
// Einstellungen (optimizer.*):
//   HTTP: evHttpUrl, evHttpToken (Bearer, optional, geheim), evHttpSocPath,
//         evHttpPluggedPath, evHttpTimePath (optional), evHttpIntervalSec,
//         evHttpTimeoutMs
//   HA:   evHaUrl, evHaToken (geheim), evHaSocEntity, evHaPluggedEntity,
//         evHaIntervalSec
//   beide: evMqttMaxAgeH — wie alt ein Wert hoechstens sein darf (wie MQTT).
//
// Jede Quelle nennt den Zeitpunkt ihres Werts: HTTP aus evHttpTimePath, sonst
// der Abruf; HA aus last_reported (sonst last_updated). Zu alte Werte gelten
// als unbekannt.
//
// Sicherheit (SSRF): DVhub holt die URL serverseitig. Erlaubt sind http(s);
// http nur im eigenen Netz (RFC1918, Loopback, *.local) — dort steht Home
// Assistant meist —, ins Internet nur https. Nie: Link-Local (169.254.x.x,
// Cloud-Metadaten), 0.0.0.0, Multicast, Zugangsdaten in der URL. Keine
// Weiterleitungen, Zeitlimit, Antwort hoechstens 256 KB. Geprueft beim
// Speichern (routes/config-routes.js) UND vor jedem Abruf.

import { parseSocPct, parsePlugged } from '../mqtt/vehicle-mqtt.js';

export const VEHICLE_PULL_KINDS = Object.freeze(['http', 'homeassistant']);
const TICK_MS = 15_000;
const MAX_BODY = 256 * 1024;
const DEFAULT_INTERVAL_SEC = 60;
const DEFAULT_TIMEOUT_MS = 5000;
const HA_ENTITY_RE = /^[a-z_]+\.[a-z0-9_]+$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function ipv4(host) {
  const p = host.split('.');
  if (p.length !== 4 || !p.every((x) => /^\d{1,3}$/.test(x))) return null;
  const n = p.map(Number);
  return n.every((x) => x <= 255) ? n : null;
}

/** Adresse fuer einen Fahrzeug-Abruf erlaubt? (siehe Kopf) */
export function isAllowedVehicleUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;
  let local;
  const v4 = ipv4(host);
  if (v4) {
    if (v4[0] === 0 || v4[0] >= 224) return false;                 // 0/8, Multicast, reserviert
    if (v4[0] === 169 && v4[1] === 254) return false;              // Link-Local / Cloud-Metadaten
    local = v4[0] === 127 || v4[0] === 10 || (v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31) || (v4[0] === 192 && v4[1] === 168);
  } else if (host.includes(':')) {
    if (host === '::' || /^fe[89ab]/.test(host) || /^ff/.test(host)) return false; // unbestimmt, Link-Local, Multicast
    local = host === '::1' || /^f[cd]/.test(host);
  } else {
    local = host === 'localhost' || host.endsWith('.local');
  }
  if (u.protocol === 'http:') return local;
  return true;
}

/** Wert unter einem Pfad wie `data.vehicles[0].soc` oder `data.vehicles.0.soc`. Leer = ganzes Dokument. */
export function readJsonPath(doc, path) {
  const p = String(path || '').trim();
  if (!p) return { found: true, value: doc };
  const parts = p.replace(/\[(\d+)\]/g, '.$1').split('.').filter((x) => x !== '');
  let cur = doc;
  for (const key of parts) {
    if (FORBIDDEN_KEYS.has(key) || cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, key)) {
      return { found: false, value: undefined };
    }
    cur = cur[key];
  }
  return { found: true, value: cur };
}

function parseTime(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v))) {
    const n = Number(v);
    return n < 1e12 ? Math.round(n * 1000) : Math.round(n);   // Sekunden oder Millisekunden
  }
  const ms = Date.parse(String(v));
  return Number.isFinite(ms) ? ms : null;
}

function settings(cfg, kind) {
  const o = cfg?.optimizer || {};
  const maxAgeMs = (Number(o.evMqttMaxAgeH) > 0 ? Number(o.evMqttMaxAgeH) : 24) * 3600_000;
  if (kind === 'http') {
    const url = String(o.evHttpUrl || '').trim();
    return {
      configured: !!url, url, token: String(o.evHttpToken || ''), socPath: String(o.evHttpSocPath || ''),
      pluggedPath: String(o.evHttpPluggedPath || ''), timePath: String(o.evHttpTimePath || ''),
      intervalMs: Math.max(15, Number(o.evHttpIntervalSec) || DEFAULT_INTERVAL_SEC) * 1000,
      timeoutMs: Math.min(30_000, Math.max(500, Number(o.evHttpTimeoutMs) || DEFAULT_TIMEOUT_MS)),
      maxAgeMs,
    };
  }
  const url = String(o.evHaUrl || '').trim().replace(/\/+$/, '');
  const socEntity = String(o.evHaSocEntity || '').trim();
  return {
    configured: !!url && !!socEntity, url, token: String(o.evHaToken || ''), socEntity,
    pluggedEntity: String(o.evHaPluggedEntity || '').trim(),
    intervalMs: Math.max(15, Number(o.evHaIntervalSec) || DEFAULT_INTERVAL_SEC) * 1000,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxAgeMs,
  };
}

/**
 * @param {{ getCfg: Function, pushLog?: Function }} ctx
 * @param {{ fetch?: Function, now?: () => number }} [deps]
 */
export function createVehiclePull(ctx, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const now = deps.now || Date.now;
  const blank = () => ({ socPct: null, socAt: null, plugged: null, pluggedAt: null, error: null, warning: null, lastAttemptAt: null, lastOkAt: null, running: false });
  const st = { http: blank(), homeassistant: blank() };
  let timer = null;

  async function getJson(url, token, timeoutMs) {
    if (!isAllowedVehicleUrl(url)) throw new Error('Adresse nicht erlaubt (http nur im eigenen Netz, sonst https; keine Zugangsdaten in der URL)');
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const headers = { Accept: 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      let res;
      try {
        res = await fetchImpl(url, { headers, signal: ac.signal, redirect: 'manual' });
      } catch (e) {
        if (ac.signal.aborted) throw new Error(`Zeitüberschreitung nach ${timeoutMs} ms`, { cause: e });
        throw new Error(`nicht erreichbar: ${e?.cause?.code || e?.message || e}`, { cause: e });
      }
      if (res.status >= 300 && res.status < 400) throw new Error(`Weiterleitung (HTTP ${res.status}) wird nicht verfolgt`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let text;
      try { text = await res.text(); } catch (e) {
        if (ac.signal.aborted) throw new Error(`Zeitüberschreitung nach ${timeoutMs} ms`, { cause: e });
        throw e;
      }
      if (text.length > MAX_BODY) throw new Error('Antwort zu groß (über 256 KB)');
      try { return JSON.parse(text); } catch (e) { throw new Error('Antwort ist kein JSON', { cause: e }); }
    } finally {
      clearTimeout(t);
    }
  }

  async function refreshHttp(s, out) {
    const doc = await getJson(s.url, s.token, s.timeoutMs);
    const at = now();
    const soc = readJsonPath(doc, s.socPath);
    if (!soc.found) {
      Object.assign(out, { socPct: null, socAt: null, error: `Pfad „${s.socPath}“ nicht in der Antwort gefunden` });
    } else {
      const pct = parseSocPct(soc.value);
      if (pct === null) Object.assign(out, { socPct: null, socAt: null, error: `Wert unter „${s.socPath || '(ganze Antwort)'}“ ist kein Ladestand 0–100 %` });
      else {
        let socAt = at;
        out.warning = null;
        if (s.timePath) {
          const tv = readJsonPath(doc, s.timePath);
          const ms = tv.found ? parseTime(tv.value) : null;
          if (ms === null) out.warning = `Zeit-Pfad „${s.timePath}“ nicht lesbar — Abrufzeit verwendet`;
          else socAt = ms;
        }
        Object.assign(out, { socPct: pct, socAt, error: null, lastOkAt: at });
      }
    }
    if (s.pluggedPath) {
      const pv = readJsonPath(doc, s.pluggedPath);
      const plugged = pv.found ? parsePlugged(pv.value) : null;
      Object.assign(out, { plugged, pluggedAt: plugged === null ? null : at });
      if (plugged === null && !out.error) out.warning = `Pfad „${s.pluggedPath}“ (angesteckt) nicht lesbar`;
    } else Object.assign(out, { plugged: null, pluggedAt: null });
  }

  async function haEntity(s, entity) {
    if (!HA_ENTITY_RE.test(entity)) throw new Error(`Entität „${entity}“ ungültig (Form: sensor.name)`);
    const doc = await getJson(`${s.url}/api/states/${entity}`, s.token, s.timeoutMs);
    const state = doc?.state;
    if (state === undefined || state === null || state === 'unavailable' || state === 'unknown') {
      throw new Error(`Entität „${entity}“ ist „${state ?? 'leer'}“`);
    }
    const at = parseTime(doc.last_reported) ?? parseTime(doc.last_updated) ?? now();
    return { state, at };
  }

  async function refreshHa(s, out) {
    const soc = await haEntity(s, s.socEntity);
    const pct = parseSocPct(soc.state);
    if (pct === null) Object.assign(out, { socPct: null, socAt: null, error: `Entität „${s.socEntity}“ meldet „${soc.state}“ — kein Ladestand 0–100 %` });
    else Object.assign(out, { socPct: pct, socAt: soc.at, error: null, lastOkAt: now() });
    if (s.pluggedEntity) {
      try {
        const p = await haEntity(s, s.pluggedEntity);
        const plugged = parsePlugged(p.state);
        Object.assign(out, { plugged, pluggedAt: plugged === null ? null : p.at });
      } catch (e) {
        Object.assign(out, { plugged: null, pluggedAt: null, warning: e.message });
      }
    } else Object.assign(out, { plugged: null, pluggedAt: null });
  }

  /** Eine Quelle jetzt abfragen. Fehler landen in getState().error, nie als Ausnahme. */
  async function refresh(kind) {
    if (!VEHICLE_PULL_KINDS.includes(kind)) return;
    const s = settings(ctx.getCfg?.(), kind);
    const out = st[kind];
    if (!s.configured) { st[kind] = blank(); return; }
    if (out.running) return;
    out.running = true;
    out.lastAttemptAt = now();
    out.warning = null;
    try {
      if (kind === 'http') await refreshHttp(s, out);
      else await refreshHa(s, out);
    } catch (e) {
      // Abruf gescheitert: letzter Wert bleibt (er altert ueber socAt aus).
      out.error = String(e?.message || e);
    } finally {
      out.running = false;
    }
    if (out.error) ctx.pushLog?.('vehicle_pull_error', { kind, error: out.error });
  }

  /**
   * @returns {{ configured: boolean, socPct: number|null, socAt: number|null,
   *   socStale: boolean, plugged: boolean|null, pluggedAt: number|null,
   *   error: string|null, warning: string|null, lastAttemptAt: number|null, lastOkAt: number|null }}
   */
  function getState(kind) {
    const s = settings(ctx.getCfg?.(), kind);
    const cur = st[kind] || blank();
    const t = now();
    const socStale = cur.socAt !== null && t - cur.socAt > s.maxAgeMs;
    const plugStale = cur.pluggedAt !== null && t - cur.pluggedAt > s.maxAgeMs;
    return {
      configured: s.configured,
      socPct: s.configured && !socStale ? cur.socPct : null,
      socAt: cur.socAt,
      socStale,
      plugged: s.configured && !plugStale ? cur.plugged : null,
      pluggedAt: cur.pluggedAt,
      error: cur.error,
      warning: cur.warning,
      lastAttemptAt: cur.lastAttemptAt,
      lastOkAt: cur.lastOkAt,
    };
  }

  function tick() {
    const cfg = ctx.getCfg?.();
    for (const kind of VEHICLE_PULL_KINDS) {
      const s = settings(cfg, kind);
      if (!s.configured) { if (st[kind].lastAttemptAt !== null) st[kind] = blank(); continue; }
      const last = st[kind].lastAttemptAt;
      if (last === null || now() - last >= s.intervalMs) refresh(kind);
    }
  }

  return {
    refresh, getState, tick,
    start() { if (!timer) { tick(); timer = setInterval(tick, TICK_MS); timer.unref?.(); } },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
  };
}
