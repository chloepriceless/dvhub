// services/wallbox/openwb.js — openWB als Hauptwallbox (2026-10-20).
//
// Schnittstellen nachgelesen in der openWB-2-Software (github.com/openWB/core,
// GPL-3.0 — kein Code übernommen):
//
// mode 'pro'  — openWB Pro und series2 Satellit, eigene HTTP-Schnittstelle:
//   GET  http://<host>/connect.php → JSON mit plug_state, charge_state, power_all,
//        powers, currents, imported (Wh), offered_current, phases_in_use, soc_value
//   POST http://<host>/connect.php  ampere=<A>  (0 = nicht laden)
//   Ohne übergeordneten Regler hält die Box die letzte Vorgabe; „Freigeben“
//   ändert deshalb nichts (wie beim evcc-Adapter).
//
// mode 'secondary' — openWB series2/Duo mit openWB-Software im Modus „Nur
//   Ladepunkt“ (Einstellungen der Box): DVhub steuert wie eine übergeordnete
//   openWB über den MQTT-Broker der Box (Port 1883):
//   openWB/set/internal_chargepoint/<n>/data/set_current   A (0 = Stopp)
//   openWB/set/internal_chargepoint/global_data             {"heartbeat": <s>, "parent_ip": …}
//   Messwerte retained unter openWB/internal_chargepoint/<n>/get/<feld>.
//   Bleibt das Lebenszeichen 80 s aus, stoppt die Box selbst (openWB-Failsafe) —
//   DVhub schickt es bei jeder Statusabfrage (alle 15 s, charger-status.js).

import http from 'node:http';
import mqtt from 'mqtt';
import { isReadOnlyMode } from '../../read-only-guard.js';

const READ_ONLY = Object.freeze({ ok: false, error: 'read_only' });
const VALUES_MAX_AGE_MS = 120_000;

function wholeAmps(currentA) {
  return Math.max(6, Math.floor(Number(currentA)));
}

function hostPort(host) {
  const s = String(host || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const m = s.match(/^(.*?)(?::(\d+))?$/);
  return { hostname: m[1], port: m[2] ? Number(m[2]) : 80 };
}

function httpRequest(host, { method = 'GET', form = null, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const { hostname, port } = hostPort(host);
    const body = form ? new URLSearchParams(form).toString() : null;
    const headers = { accept: 'application/json' };
    if (body !== null) { headers['content-type'] = 'application/x-www-form-urlencoded'; headers['content-length'] = Buffer.byteLength(body); }
    const req = http.request({ hostname, port, path: '/connect.php', method, headers, timeout: timeoutMs }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; if (raw.length > 1_000_000) req.destroy(new Error('payload too large')); });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return resolve({ ok: false, error: `HTTP ${res.statusCode}` });
        let data = raw;
        try { data = raw ? JSON.parse(raw) : null; } catch { /* POST antwortet mit Text */ }
        resolve({ ok: true, data });
      });
    });
    req.on('timeout', () => req.destroy(new Error('openWB timeout')));
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    if (body !== null) req.write(body);
    req.end();
  });
}

// Eine MQTT-Verbindung je Box (wie die Wattpilot-Verbindung).
const connections = new Map();
function getConnection(host, chargepoint, deps) {
  const key = `${host}#${chargepoint}`;
  let c = connections.get(key);
  if (c && (deps.mqttConnect ? c.connectFn === deps.mqttConnect : true)) return c;
  const connectFn = deps.mqttConnect || ((url, opts) => mqtt.connect(url, opts));
  const { hostname } = hostPort(host);
  const prefix = `openWB/internal_chargepoint/${chargepoint}/get/`;
  const client = connectFn(`mqtt://${hostname}:1883`, { reconnectPeriod: 5000, connectTimeout: 5000, clientId: `dvhub-openwb-${process.pid}-${chargepoint}` });
  c = { client, connectFn, values: {}, lastMessageAt: 0 };
  client.on('connect', () => client.subscribe(`${prefix}#`));
  client.on('message', (topic, payload) => {
    if (!String(topic).startsWith(prefix)) return;
    let v = String(payload);
    try { v = JSON.parse(v); } catch { /* Rohtext */ }
    c.values[String(topic).slice(prefix.length)] = v;
    c.lastMessageAt = (deps.now || Date.now)();
  });
  client.on('error', () => { /* Wiederverbinden übernimmt mqtt.js */ });
  connections.set(key, c);
  return c;
}

function publish(client, topic, value) {
  return new Promise((resolve) => {
    if (!client.connected) return resolve({ ok: false, error: 'openWB: keine MQTT-Verbindung (Port 1883)' });
    client.publish(topic, JSON.stringify(value), { qos: 0, retain: false }, (err) => resolve(err ? { ok: false, error: err.message } : { ok: true }));
  });
}

const num = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true';

export function createOpenWbAdapter(getSettings, deps = {}) {
  const now = deps.now || Date.now;
  const settings = () => getSettings() || {};
  const mode = () => (settings().mode === 'secondary' ? 'secondary' : 'pro');
  const host = () => String(settings().host || '').trim();
  const cpNum = () => (Number(settings().chargepoint) === 1 ? 1 : 0);
  const timeoutMs = () => Number(settings().timeoutMs) || 5000;

  function conn() { return getConnection(host(), cpNum(), deps); }
  async function heartbeat(c) {
    return publish(c.client, 'openWB/set/internal_chargepoint/global_data', { heartbeat: Math.floor(now() / 1000), parent_ip: 'DVhub' });
  }

  async function setCurrent(amps) {
    if (isReadOnlyMode()) return READ_ONLY;
    if (!host()) return { ok: false, error: 'openWB: keine Adresse eingetragen' };
    if (mode() === 'pro') {
      const r = await httpRequest(host(), { method: 'POST', form: { ampere: String(amps) }, timeoutMs: timeoutMs() });
      return r.ok ? { ok: true } : r;
    }
    const c = conn();
    const hb = await heartbeat(c);
    if (!hb.ok) return hb;
    return publish(c.client, `openWB/set/internal_chargepoint/${cpNum()}/data/set_current`, amps);
  }

  // Modus „Nur Ladepunkt“: gleich verbinden, damit die (retained) Messwerte
  // schon da sind, wenn der erste Status gefragt wird. Die Verbindung wird je
  // Box wiederverwendet (getConnection).
  if (mode() === 'secondary' && host()) conn();

  return {
    type: 'openwb',
    isConfigured: () => Boolean(host()),
    charge: (currentA) => setCurrent(wholeAmps(currentA)),
    stop: () => setCurrent(0),
    // Ohne übergeordneten Regler gibt es keinen eigenen Automatikbetrieb der
    // Box — die letzte Vorgabe bleibt (Modus „secondary“: solange DVhub lebt).
    release: async () => (isReadOnlyMode() ? READ_ONLY : { ok: true }),
    async status() {
      if (!host()) return { ok: false, error: 'openWB: keine Adresse eingetragen' };
      if (mode() === 'pro') {
        const r = await httpRequest(host(), { timeoutMs: timeoutMs() });
        if (!r.ok || !r.data || typeof r.data !== 'object') return { ok: false, error: r.error || 'openWB: keine Antwort von connect.php' };
        const d = r.data;
        const charging = truthy(d.charge_state);
        return {
          ok: true,
          connected: truthy(d.plug_state),
          charging,
          carState: charging ? 'charging' : null,
          powerW: num(d.power_all),
          currentA: num(d.offered_current),
          vehicleSocPct: num(d.soc_value) > 0 ? num(d.soc_value) : null,
          raw: { phasesInUse: num(d.phases_in_use), phasesTarget: num(d.phases_target), importedWh: num(d.imported), serial: d.serial ?? null },
        };
      }
      const c = conn();
      // Lebenszeichen auch ohne Befehl: sonst stoppt die Box nach 80 s.
      if (c.client.connected && !isReadOnlyMode()) await heartbeat(c);
      const v = c.values;
      if (!c.lastMessageAt || now() - c.lastMessageAt > VALUES_MAX_AGE_MS || !('plug_state' in v)) {
        return { ok: false, error: c.client.connected
          ? 'openWB sendet keine Ladepunkt-Werte — ist die Box auf „Nur Ladepunkt“ gestellt?'
          : 'openWB: keine MQTT-Verbindung (Port 1883)' };
      }
      const charging = truthy(v.charge_state);
      return {
        ok: true,
        connected: truthy(v.plug_state),
        charging,
        carState: charging ? 'charging' : null,
        powerW: num(v.power),
        currentA: num(v.evse_current),
        vehicleSocPct: num(v.soc) > 0 ? num(v.soc) : null,
        raw: { phasesInUse: num(v.phases_in_use), importedWh: num(v.imported), fault: v.fault_str ?? null },
      };
    },
  };
}

/** Nur für Tests: Verbindungen vergessen. */
export function _resetOpenWbConnections() {
  for (const c of connections.values()) { try { c.client.end?.(true); } catch { /* egal */ } }
  connections.clear();
}
