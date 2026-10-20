// services/wallbox/nrgkick.js — NRGkick Gen2 (2026-10-20).
//
// Quelle: NRGkick „local API“ (JSON, SmartModule ≥ 4.0; in der NRGkick-App
// einschalten, BasicAuth optional). Die Box beschreibt die API selbst unter
// ihrer IP-Adresse; Demo: nrgkick.com/wp-content/uploads/local_api_docu_simulate-1.html
//   GET /control?current_set=<A>&charge_pause=0|1
//   GET /values  general.status (1 STANDBY · 2 CONNECTED · 3 CHARGING · 6 ERROR · 7 WAKEUP),
//                powerflow.total_active_power (W), energy.total_charged_energy (Wh)
//   GET /info    general.rated_current (A)
// Kein Watchdog: fällt DVhub aus, bleibt die letzte Vorgabe stehen.
import http from 'node:http';
import { isReadOnlyMode } from '../../read-only-guard.js';

const READ_ONLY = Object.freeze({ ok: false, error: 'read_only' });
const STATUS = { UNKNOWN: 0, STANDBY: 1, CONNECTED: 2, CHARGING: 3, ERROR: 6, WAKEUP: 7 };

function get(settings, path) {
  return new Promise((resolve) => {
    const s = String(settings.host || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const [hostname, port] = s.split(':');
    const headers = { accept: 'application/json' };
    if (settings.username) headers.authorization = 'Basic ' + Buffer.from(`${settings.username}:${settings.password || ''}`).toString('base64');
    const req = http.request({ hostname, port: Number(port) || 80, path, method: 'GET', headers, timeout: Number(settings.timeoutMs) || 5000 }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return resolve({ ok: false, error: `NRGkick: HTTP ${res.statusCode}` });
        try { resolve({ ok: true, data: raw ? JSON.parse(raw) : {} }); } catch { resolve({ ok: false, error: 'NRGkick: ungültige Antwort' }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('NRGkick timeout')));
    req.on('error', (e) => resolve({ ok: false, error: `NRGkick: ${e.message}` }));
    req.end();
  });
}

export function createNrgkickAdapter(getSettings) {
  const s = () => getSettings() || {};
  async function control(query) {
    if (isReadOnlyMode()) return READ_ONLY;
    if (!String(s().host || '').trim()) return { ok: false, error: 'NRGkick: keine Adresse eingetragen' };
    const r = await get(s(), `/control?${query}`);
    return r.ok ? { ok: true } : r;
  }
  return {
    type: 'nrgkick',
    isConfigured: () => Boolean(String(s().host || '').trim()),
    charge: (currentA) => control(`current_set=${Math.max(6, Math.floor(Number(currentA)))}&charge_pause=0`),
    stop: () => control('charge_pause=1'),
    async release() {
      if (isReadOnlyMode()) return READ_ONLY;
      const info = await get(s(), '/info');
      const rated = Number(info.ok ? info.data?.general?.rated_current : NaN);
      return control(`current_set=${Number.isFinite(rated) && rated >= 6 ? Math.floor(rated) : 16}&charge_pause=0`);
    },
    async status() {
      if (!String(s().host || '').trim()) return { ok: false, error: 'NRGkick: keine Adresse eingetragen' };
      const r = await get(s(), '/values');
      if (!r.ok) return r;
      const g = r.data?.general || {};
      const raw = g.status;
      const code = typeof raw === 'number' ? raw : (STATUS[String(raw || '').toUpperCase()] ?? 0);
      const power = Number(r.data?.powerflow?.total_active_power);
      const error = code === 6;
      return {
        ok: true,
        connected: error ? null : code === 2 || code === 3 || code === 7 ? true : code === 1 ? false : null,
        charging: code === 3,
        carState: error ? 'error' : code === 2 ? 'waiting' : null,
        powerW: Number.isFinite(power) ? Math.round(power) : null,
        currentA: null,
        vehicleSocPct: null,
        raw: { status: code, energyWh: Number(r.data?.energy?.total_charged_energy) || null },
      };
    },
  };
}
