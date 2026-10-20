// services/wallbox/warp.js — TinkerForge WARP 1/2/3 (2026-10-20).
//
// Quelle: docs.warp-charger.com (HTTP-API; Lesen per GET, Schreiben per POST
// mit JSON auf denselben Pfad):
//   evse/state            charger_state 0 nicht verbunden · 1 wartet auf Freigabe ·
//                         2 bereit · 3 lädt · 4 Fehler; allowed_charging_current (mA)
//   evse/external_enabled {"enabled": true} — Ladeslot „externe Steuerung“ an/aus
//   evse/external_current {"current": mA} — 6000–32000, 0 = gesperrt (für häufige
//                         Änderungen gedacht, schreibt nicht in den Flash)
//   meter/values          power (W), energy_abs (kWh) — nur mit Zähler
import http from 'node:http';
import { isReadOnlyMode } from '../../read-only-guard.js';

const READ_ONLY = Object.freeze({ ok: false, error: 'read_only' });

function call(host, path, { body, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const s = String(host || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const [hostname, port] = s.split(':');
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { accept: 'application/json' };
    if (payload !== null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(payload); }
    const req = http.request({ hostname, port: Number(port) || 80, path: `/${path}`, method: payload === null ? 'GET' : 'POST', headers, timeout: timeoutMs }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return resolve({ ok: false, status: res.statusCode, error: `WARP: HTTP ${res.statusCode} (${path})` });
        let data;
        try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
        resolve({ ok: true, data });
      });
    });
    req.on('timeout', () => req.destroy(new Error('WARP timeout')));
    req.on('error', (e) => resolve({ ok: false, error: `WARP: ${e.message}` }));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

export function createWarpAdapter(getSettings) {
  const host = () => String(getSettings()?.host || '').trim();
  const opts = () => ({ timeoutMs: Number(getSettings()?.timeoutMs) || 5000 });
  async function guarded(fn) {
    if (isReadOnlyMode()) return READ_ONLY;
    if (!host()) return { ok: false, error: 'WARP: keine Adresse eingetragen' };
    return fn();
  }
  const post = (path, body) => call(host(), path, { ...opts(), body });

  return {
    type: 'warp',
    isConfigured: () => Boolean(host()),
    charge: (currentA) => guarded(async () => {
      const en = await post('evse/external_enabled', { enabled: true });
      if (!en.ok) return en;
      const mA = Math.max(6, Math.floor(Number(currentA))) * 1000;
      const r = await post('evse/external_current', { current: Math.min(32000, mA) });
      return r.ok ? { ok: true } : r;
    }),
    stop: () => guarded(async () => {
      const r = await post('evse/external_current', { current: 0 });
      return r.ok ? { ok: true } : r;
    }),
    // Externe Steuerung aus: es gelten wieder die übrigen Ladeslots der Box.
    release: () => guarded(async () => {
      const r = await post('evse/external_enabled', { enabled: false });
      return r.ok ? { ok: true } : r;
    }),
    async status() {
      if (!host()) return { ok: false, error: 'WARP: keine Adresse eingetragen' };
      const st = await call(host(), 'evse/state', opts());
      if (!st.ok || !st.data || typeof st.data !== 'object') return { ok: false, error: st.error || 'WARP: keine Antwort' };
      const m = await call(host(), 'meter/values', opts());
      const cs = Number(st.data.charger_state);
      const power = m.ok && m.data && Number.isFinite(Number(m.data.power)) ? Math.round(Number(m.data.power)) : null;
      return {
        ok: true,
        connected: cs === 4 ? null : cs >= 1 && cs <= 3,
        charging: cs === 3,
        carState: cs === 4 ? 'error' : cs === 1 || cs === 2 ? 'waiting' : null,
        powerW: power,
        currentA: Number.isFinite(Number(st.data.allowed_charging_current)) ? Math.round(Number(st.data.allowed_charging_current) / 1000) : null,
        vehicleSocPct: null,
        raw: { chargerState: cs, iec61851State: st.data.iec61851_state ?? null, errorState: st.data.error_state ?? null, energyKwh: m.ok ? (m.data?.energy_abs ?? null) : null },
      };
    },
  };
}
