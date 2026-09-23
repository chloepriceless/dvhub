/**
 * Wallbox-Adapter fuer die EOS-Bruecke (eos-evcc-bridge.js).
 *
 * Gemeinsame Schnittstelle — jede Methode liefert { ok, error? }:
 *   charge(currentA)  laden mit diesem Strom je Phase
 *   stop()            nicht laden
 *   release()         Vorgabe zuruecknehmen: die Wallbox macht wieder, was sie
 *                     ohne DVhub machen wuerde
 *   status()          { ok, connected, charging, powerW, currentA, raw }
 *
 * OpenEVSE (ESP32-Firmware v4/v5, auch Kinetos): Claims-API. Ein Claim ist die
 * Vorgabe eines Clients mit Prioritaet; DVhub meldet sich als eigener Client
 * (Vendor "Unregistered" 0xFFFE) und bekommt API-Prioritaet 500 — ein Eingriff
 * von Hand in der OpenEVSE (Manual, 1000), RFID, OCPP und Sicherheitsgrenzen
 * gewinnen immer. Quelle: openevse_esp32_firmware src/evse_man.h, api.yml.
 *
 * go-e (API v2, in der App "HTTP API v2" aktivieren): GET /api/set mit frc
 * (0 neutral, 1 aus, 2 an) und amp (Strom in A). Quelle: goecharger/
 * go-eCharger-API-v2 apikeys-en.md; evcc charger/go-e.go nutzt bei v2 genauso
 * frc + amp.
 */
import http from 'node:http';
import https from 'node:https';

// Vendor 0xFFFE (Unregistered) << 16 | 0x0D01 ("DVhub"). evcc nutzt 0x00040001.
export const OPENEVSE_DVHUB_CLIENT = 0xFFFE0D01;

function request(urlStr, { method = 'GET', body, auth, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(urlStr); } catch (e) { resolve({ ok: false, error: `invalid url: ${e.message}` }); return; }
    const client = url.protocol === 'https:' ? https : http;
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { accept: 'application/json' };
    if (payload !== null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(payload); }
    if (auth?.username) headers.authorization = 'Basic ' + Buffer.from(`${auth.username}:${auth.password || ''}`).toString('base64');
    const req = client.request(url, { method, headers, timeout: timeoutMs }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; if (raw.length > 1_000_000) req.destroy(new Error('payload too large')); });
      res.on('end', () => {
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ ok: true, status: res.statusCode, data });
        else resolve({ ok: false, status: res.statusCode, error: `HTTP ${res.statusCode}`, data });
      });
    });
    req.on('timeout', () => req.destroy(new Error('wallbox timeout')));
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** Ganze Ampere, nie unter 6 A (Norm-Minimum) — beide Boxen nehmen nur Ganzzahlen. */
function wholeAmps(currentA) {
  return Math.max(6, Math.floor(Number(currentA)));
}

export function createOpenEvseAdapter(getSettings) {
  const base = () => String(getSettings()?.url || '').replace(/\/+$/, '');
  const auth = () => ({ username: getSettings()?.username || '', password: getSettings()?.password || '' });
  const claimUrl = () => `${base()}/claims/${OPENEVSE_DVHUB_CLIENT}`;
  const opts = (extra) => ({ auth: auth(), timeoutMs: Number(getSettings()?.timeoutMs) || 5000, ...extra });

  return {
    type: 'openevse',
    isConfigured: () => Boolean(base()),
    async charge(currentA) {
      return request(claimUrl(), opts({ method: 'POST', body: { state: 'active', charge_current: wholeAmps(currentA), auto_release: false } }));
    },
    async stop() {
      return request(claimUrl(), opts({ method: 'POST', body: { state: 'disabled', auto_release: false } }));
    },
    async release() {
      const res = await request(claimUrl(), opts({ method: 'DELETE' }));
      // 404 = es gab keinen Claim — Ziel erreicht.
      return res.ok || res.status === 404 ? { ok: true } : res;
    },
    async status() {
      const res = await request(`${base()}/status`, opts());
      if (!res.ok || typeof res.data !== 'object') return { ok: false, error: res.error || 'no status' };
      const d = res.data;
      return {
        ok: true,
        connected: Number(d.vehicle) === 1,
        charging: String(d.status) === 'active' && Number(d.amp) > 0,
        powerW: Number.isFinite(Number(d.power)) ? Number(d.power) : null,
        currentA: Number.isFinite(Number(d.pilot)) ? Number(d.pilot) : null,
        vehicleSocPct: Number(d.battery_level) > 0 ? Number(d.battery_level) : null,
        raw: { status: d.status, state: d.state, vehicle: d.vehicle, pilot: d.pilot, amp: d.amp, max_current: d.max_current }
      };
    }
  };
}

export function createGoeAdapter(getSettings) {
  const base = () => String(getSettings()?.url || '').replace(/\/+$/, '');
  const opts = () => ({ timeoutMs: Number(getSettings()?.timeoutMs) || 5000 });
  const set = (query) => request(`${base()}/api/set?${query}`, opts());
  const expectOk = (res) => {
    // /api/set antwortet je Schluessel mit true oder einer Fehlermeldung.
    if (!res.ok) return res;
    const bad = res.data && typeof res.data === 'object'
      ? Object.entries(res.data).filter(([, v]) => v !== true)
      : [];
    return bad.length ? { ok: false, error: bad.map(([k, v]) => `${k}: ${v}`).join(', ') } : { ok: true };
  };

  return {
    type: 'goe',
    isConfigured: () => Boolean(base()),
    async charge(currentA) {
      return expectOk(await set(`amp=${wholeAmps(currentA)}&frc=2`));
    },
    async stop() {
      return expectOk(await set('frc=1'));
    },
    async release() {
      return expectOk(await set('frc=0'));
    },
    async status() {
      const res = await request(`${base()}/api/status?filter=car,amp,frc,alw,nrg,fwv`, opts());
      if (!res.ok || typeof res.data !== 'object') return { ok: false, error: res.error || 'no status' };
      const d = res.data;
      const car = Number(d.car);
      const totalW = Array.isArray(d.nrg) && Number.isFinite(Number(d.nrg[11])) ? Number(d.nrg[11]) : null;
      return {
        ok: true,
        connected: car >= 2 && car <= 4,
        charging: car === 2,
        powerW: totalW,
        currentA: Number.isFinite(Number(d.amp)) ? Number(d.amp) : null,
        vehicleSocPct: null,
        raw: { car: d.car, amp: d.amp, frc: d.frc, alw: d.alw, fwv: d.fwv }
      };
    }
  };
}

/**
 * evcc als Adapter — dieselbe Schnittstelle ueber die bestehende Anbindung.
 * Stopp-Modus bleibt evcc-spezifisch (off / pv / minpv).
 */
export function createEvccAdapter(evccIntegration, getLoadpoint, getStopMode) {
  return {
    type: 'evcc',
    isConfigured: () => Boolean(evccIntegration?.getStatus?.().url),
    async charge(currentA) {
      const cur = await evccIntegration.setMaxCurrent(getLoadpoint(), currentA);
      if (!cur?.ok) return cur || { ok: false, error: 'maxcurrent failed' };
      return evccIntegration.setMode(getLoadpoint(), 'now');
    },
    async stop() {
      return evccIntegration.setMode(getLoadpoint(), getStopMode());
    },
    async release() {
      // evcc kennt kein "Vorgabe zuruecknehmen". Bewusst nichts tun: so blieb
      // es schon vor den Adaptern — wer die Weitergabe abschaltet, findet evcc
      // im zuletzt gesetzten Modus und schaltet dort selbst um.
      return { ok: true };
    },
    async status() {
      const lp = (evccIntegration?.getLoadpoints?.() || []).find((l) => l.id === getLoadpoint());
      if (!lp) return { ok: false, error: 'Ladepunkt nicht gefunden' };
      return { ok: true, connected: lp.connected, charging: lp.charging, powerW: lp.chargePowerW, currentA: null, vehicleSocPct: lp.vehicleSocPct, raw: { mode: lp.mode } };
    }
  };
}
