// services/wallbox/smartevse.js — SmartEVSE v3 (2026-10-20).
//
// Quelle: github.com/SmartEVSE/SmartEVSE-3 (MIT), docs/REST_API.md und src/esp32.cpp.
//   GET  /settings → mode_id (0 OFF · 1 NORMAL · 2 SOLAR · 3 SMART · 4 PAUSE),
//        evse.state_id (0 A kein Auto · 1 B · 2 C lädt · 3 D · 9 B1 · 10 C1 · 11–14 Modem),
//        evse.error_id, settings.override_current/current_min/current_max,
//        ev_meter.import_active_power (W), total_wh, currents L1–L3 (0,1 A),
//        ev_state.computed_soc (nur mit Modem)
//   POST /settings?mode=…&override_current=<A×10>&disable_override_current=1 — der Rumpf
//        muss mitgeschickt werden (leer), sonst wartet der Webserver ab v3.6 bis zum Timeout.
// override_current wirkt nur in NORMAL/SMART; DVhub schaltet dafür auf NORMAL und merkt
// sich den alten Modus für „Freigeben“. Ein Moduswechsel schreibt in den Flash der Box,
// darum nur bei Bedarf. Die Stromvorgabe selbst wird nicht gespeichert (nach Neustart weg).
// Kein Watchdog: fällt DVhub aus, bleibt die letzte Vorgabe bis zum Neustart der Box.
import http from 'node:http';
import { isReadOnlyMode } from '../../read-only-guard.js';

const READ_ONLY = Object.freeze({ ok: false, error: 'read_only' });

function request(host, method, path, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const s = String(host || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const [hostname, port] = s.split(':');
    const headers = method === 'POST' ? { 'content-length': 0 } : {};
    const req = http.request({ hostname, port: Number(port) || 80, path, method, headers, timeout: timeoutMs }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return resolve({ ok: false, error: `SmartEVSE: HTTP ${res.statusCode}` });
        try { resolve({ ok: true, data: JSON.parse(raw) }); } catch { resolve({ ok: false, error: 'SmartEVSE: Antwort kein JSON' }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('SmartEVSE timeout')));
    req.on('error', (e) => resolve({ ok: false, error: `SmartEVSE: ${e.message}` }));
    req.end();
  });
}

const rejected = (v) => typeof v === 'string' && /not allowed/i.test(v);

export function createSmartevseAdapter(getSettings) {
  const host = () => String(getSettings()?.host || '').trim();
  let prevMode = null; // Modus vor der ersten DVhub-Vorgabe — für „Freigeben“
  const missing = () => ({ ok: false, error: 'SmartEVSE: keine Adresse eingetragen' });
  const read = () => request(host(), 'GET', '/settings');
  async function post(query) {
    const r = await request(host(), 'POST', `/settings?${query}`);
    if (!r.ok) return r;
    const bad = ['mode', 'override_current'].find((k) => rejected(r.data?.[k]));
    return bad ? { ok: false, error: `SmartEVSE: ${bad} nicht erlaubt (Lastverteil-Node oder außerhalb current_min…current_max?)` } : { ok: true };
  }
  async function guarded(fn) {
    if (isReadOnlyMode()) return READ_ONLY;
    if (!host()) return missing();
    const g = await read();
    if (!g.ok) return g;
    const query = fn(g.data || {});
    return query ? post(query) : { ok: true };
  }
  const remember = (m) => { if (prevMode == null && Number.isInteger(m)) prevMode = m; };

  return {
    type: 'smartevse',
    isConfigured: () => Boolean(host()),
    charge: (currentA) => guarded((d) => {
      const lo = Number(d.settings?.current_min) || 6;
      const hi = Number(d.settings?.current_max) || 16;
      const dA = Math.min(hi, Math.max(lo, Math.floor(Number(currentA)))) * 10;
      const m = Number(d.mode_id);
      if (m === 1 || m === 3) return Number(d.settings?.override_current) === dA ? null : `override_current=${dA}`;
      remember(m);
      return `mode=1&override_current=${dA}`;
    }),
    stop: () => guarded((d) => {
      const m = Number(d.mode_id);
      if (m === 0) return null;
      remember(m);
      return 'mode=0';
    }),
    release: () => guarded((d) => {
      const m = Number(d.mode_id);
      // Zurück in den gemerkten Modus; ohne eigenen Wechsel bleibt der Modus der Box
      // (SMART/SOLAR) — nur OFF/PAUSE würden nie laden und werden zu NORMAL.
      const back = prevMode ?? (m === 0 || m === 4 ? 1 : m);
      prevMode = null;
      return m === back ? 'disable_override_current=1' : `disable_override_current=1&mode=${back}`;
    }),
    async status() {
      if (!host()) return missing();
      const g = await read();
      if (!g.ok) return g;
      const d = g.data || {};
      const sid = Number(d.evse?.state_id);
      const error = Number(d.evse?.error_id) > 0;
      const meter = d.ev_meter && d.ev_meter.description !== 'Disabled' ? d.ev_meter : null;
      const cur = meter ? ['L1', 'L2', 'L3'].map((k) => Number(meter.currents?.[k])).filter(Number.isFinite) : [];
      const soc = Number(d.ev_state?.computed_soc);
      return {
        ok: true,
        connected: error ? null : sid !== 0,
        charging: sid === 2 || sid === 3,
        carState: error ? 'error' : sid === 1 || sid === 9 || sid === 10 || (sid >= 11 && sid <= 14) ? 'waiting' : null,
        powerW: meter && Number.isFinite(Number(meter.import_active_power)) ? Math.round(Number(meter.import_active_power)) : null,
        currentA: cur.length ? Math.max(...cur) / 10 : null,
        vehicleSocPct: soc > 0 && soc <= 100 ? soc : null,
        raw: { modeId: Number(d.mode_id), stateId: sid, errorId: Number(d.evse?.error_id) || 0, energyWh: meter ? Number(meter.total_wh) || null : null },
      };
    },
  };
}
