// services/wallbox/smartwb.js — EVSE-WiFi / smartWB (2026-10-20).
//
// Quelle: „EVSE-WiFi API-Dokumentation“ (Mathias Nachbaur, Stand 27.05.2022,
// smartwb.de), HTTP GET:
//   /getParameters → list[0]: vehicleState (1 bereit · 2 Fahrzeug angeschlossen ·
//                    3 Fahrzeug lädt · 5 Fehler), actualPower (kW), actualCurrent (A),
//                    maxCurrent (A), meterReading (kWh), alwaysActive
//   /setCurrent?current=<A>  — im Modus Always Active/Remote beendet 0 den Ladevorgang
//   /setStatus?active=true|false — Start/Ende im Normal-Modus
// Kein Watchdog: fällt DVhub aus, bleibt die letzte Vorgabe stehen.
import http from 'node:http';
import { isReadOnlyMode } from '../../read-only-guard.js';

const READ_ONLY = Object.freeze({ ok: false, error: 'read_only' });

function get(host, path, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const s = String(host || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const [hostname, port] = s.split(':');
    const req = http.request({ hostname, port: Number(port) || 80, path, method: 'GET', timeout: timeoutMs }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return resolve({ ok: false, error: `smartWB: HTTP ${res.statusCode}` });
        let data = raw;
        try { data = JSON.parse(raw); } catch { /* Befehle antworten mit Text */ }
        resolve({ ok: true, data });
      });
    });
    req.on('timeout', () => req.destroy(new Error('smartWB timeout')));
    req.on('error', (e) => resolve({ ok: false, error: `smartWB: ${e.message}` }));
    req.end();
  });
}

export function createSmartwbAdapter(getSettings) {
  const host = () => String(getSettings()?.host || '').trim();
  async function params() {
    const r = await get(host(), '/getParameters');
    const p = r.ok ? r.data?.list?.[0] : null;
    return p && typeof p === 'object' ? { ok: true, p } : { ok: false, error: r.error || 'smartWB: keine Parameter' };
  }
  async function guarded(fn) {
    if (isReadOnlyMode()) return READ_ONLY;
    if (!host()) return { ok: false, error: 'smartWB: keine Adresse eingetragen' };
    const pr = await params();
    if (!pr.ok) return pr;
    for (const path of fn(pr.p)) {
      const r = await get(host(), path);
      if (!r.ok) return r;
    }
    return { ok: true };
  }

  return {
    type: 'smartwb',
    isConfigured: () => Boolean(host()),
    charge: (currentA) => guarded((p) => {
      const a = Math.max(6, Math.floor(Number(currentA)));
      return p.alwaysActive ? [`/setCurrent?current=${a}`] : [`/setCurrent?current=${a}`, '/setStatus?active=true'];
    }),
    stop: () => guarded((p) => (p.alwaysActive ? ['/setCurrent?current=0'] : ['/setStatus?active=false'])),
    release: () => guarded((p) => {
      const max = Number(p.maxCurrent) >= 6 ? Math.floor(Number(p.maxCurrent)) : 16;
      return p.alwaysActive ? [`/setCurrent?current=${max}`] : [`/setCurrent?current=${max}`, '/setStatus?active=true'];
    }),
    async status() {
      if (!host()) return { ok: false, error: 'smartWB: keine Adresse eingetragen' };
      const pr = await params();
      if (!pr.ok) return pr;
      const p = pr.p;
      const vs = Number(p.vehicleState);
      const kw = Number(p.actualPower);
      const error = vs === 5;
      return {
        ok: true,
        connected: error ? null : vs === 2 || vs === 3,
        charging: vs === 3,
        carState: error ? 'error' : vs === 2 ? 'waiting' : null,
        powerW: Number.isFinite(kw) ? Math.round(kw * 1000) : null,
        currentA: Number.isFinite(Number(p.actualCurrent)) ? Number(p.actualCurrent) : null,
        vehicleSocPct: null,
        raw: { vehicleState: vs, alwaysActive: Boolean(p.alwaysActive), meterKwh: Number(p.meterReading) || null },
      };
    },
  };
}
