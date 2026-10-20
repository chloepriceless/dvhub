// services/wallbox/schneider.js — Schneider EVlink Pro AC (2026-10-20).
//
// Quelle: „EVlink Pro AC Modbus Connectivity Guide“ GEX1969300–06 (03/2026, se.com).
// Modbus TCP, Port 502, Server-ID 255, Adressen ab 0:
//   1 EV-Zustand (IEC 61851: 0 E · 1 F · 2 A1 · 3 B1 · 4 C1 · 5 D1 · 6 A2 · 7 B2 · 8 C2 lädt ·
//     9 D2 lädt · 10 CP ungültig · 11 CP-Fehler) · 150 OCPP-Status (3 Charging, 9 Faulted)
//   2999/3001/3003 Strom L1–L3 float32 A · 3059 Wirkleistung gesamt float32 kW
//   3203 Energie gesamt int64 Wh
//   4000 Lifebit: 1 schreiben = Lebenszeichen (die Box setzt 0 zurück), 2 = Überwachung aus.
//        Kommt das Lebenszeichen nicht innerhalb der in eSetup eingestellten Frist, gilt der
//        dort eingestellte Ersatzstrom (4005/4006, nur lesbar).
//   4004 Vorgabe A (0–32), wirkt nach höchstens 15 s.
// Aus der Praxis (evcc charger/schneider-v3.go, MIT — nur Hinweis): Gleitkomma- und
// 64-Bit-Werte kommen mit dem niederwertigen Wort zuerst; je nach Firmware Holding-Register
// mit FC6 oder Input-Register mit FC16; Vorgabe 0 = aus. Ungeprüft an einer echten Box.
import { isReadOnlyMode } from '../../read-only-guard.js';

const READ_ONLY = Object.freeze({ ok: false, error: 'read_only' });
const MAX_A = 32;

const f32 = (lo, hi) => { const b = Buffer.alloc(4); b.writeUInt16BE(hi, 0); b.writeUInt16BE(lo, 2); return b.readFloatBE(0); };
const u64 = (w) => w.reduce((acc, x, i) => acc + Number(x) * 2 ** (16 * i), 0);

export function createSchneiderAdapter(getSettings, deps = {}) {
  const s = () => getSettings() || {};
  let mode = null; // 'holding' (FC3/FC6) | 'input' (FC4/FC16), beim ersten Zugriff ermittelt
  let controlling = false; // DVhub hat eine Vorgabe gesetzt → Lebenszeichen halten

  function target() {
    const t = deps.getTransport?.();
    const host = String(s().host || '').trim();
    if (!host || !t || typeof t.mbRequest !== 'function') return null;
    const unit = Number(s().unitId);
    return { t, conn: { host, port: Number(s().port) || 502, unitId: unit >= 1 && unit <= 255 ? unit : 255, timeoutMs: Number(s().timeoutMs) || 3000 } };
  }
  const missing = () => ({ ok: false, error: 'Schneider: keine Adresse eingetragen oder Modbus nicht verfügbar' });
  async function raw(x, fc, address, quantity) {
    const r = await x.t.mbRequest({ ...x.conn, fc, address, quantity });
    const w = Array.isArray(r) ? r : r?.values;
    if (!Array.isArray(w)) throw new Error('keine Antwort');
    return w.map(Number);
  }
  async function read(x, address, quantity = 1) {
    if (!mode) {
      try { const w = await raw(x, 3, address, quantity); mode = 'holding'; return w; } catch (e) {
        try { const w = await raw(x, 4, address, quantity); mode = 'input'; return w; } catch { throw e; }
      }
    }
    return raw(x, mode === 'input' ? 4 : 3, address, quantity);
  }
  async function write(x, address, value) {
    if (!mode) await read(x, 4004);
    if (mode === 'input') await x.t.mbWriteMultiple({ ...x.conn, address, values: [value] });
    else await x.t.mbWriteSingle({ ...x.conn, address, value });
  }
  async function control(fn) {
    if (isReadOnlyMode()) return READ_ONLY;
    const x = target();
    if (!x) return missing();
    if (typeof x.t.mbWriteSingle !== 'function' && typeof x.t.mbWriteMultiple !== 'function') return { ok: false, error: 'Schneider: Modbus-Schreiben nicht verfügbar' };
    try { await fn(x); return { ok: true }; } catch (e) { return { ok: false, error: `Schneider: ${e?.message || e}` }; }
  }
  async function setpoint(x, a) {
    await write(x, 4000, 1);
    await write(x, 4004, a);
    controlling = true;
  }

  return {
    type: 'schneider',
    isConfigured: () => Boolean(target()),
    charge: (currentA) => control((x) => setpoint(x, Math.min(MAX_A, Math.max(6, Math.floor(Number(currentA)))))),
    stop: () => control((x) => setpoint(x, 0)),
    release: () => control(async (x) => {
      await write(x, 4004, MAX_A);
      await write(x, 4000, 2);
      controlling = false;
    }),
    async status() {
      const x = target();
      if (!x) return missing();
      try {
        if (controlling && !isReadOnlyMode()) {
          const [life] = await read(x, 4000);
          if (life === 0) await write(x, 4000, 1);
        }
        const [ev] = await read(x, 1);
        const [ocpp] = await read(x, 150);
        const c = await read(x, 2999, 6);
        const p = await read(x, 3059, 2);
        let energyWh = null;
        try { energyWh = u64(await read(x, 3203, 4)); } catch { /* optional */ }
        const error = ev === 0 || ev === 1 || ev === 10 || ev === 11 || ocpp === 9;
        const charging = ev === 8 || ev === 9;
        const connected = error ? null : [3, 4, 5, 7, 8, 9].includes(ev);
        const amps = [f32(c[0], c[1]), f32(c[2], c[3]), f32(c[4], c[5])].filter(Number.isFinite);
        const kw = f32(p[0], p[1]);
        return {
          ok: true,
          connected,
          charging,
          carState: error ? 'error' : charging ? 'charging' : connected ? 'waiting' : null,
          powerW: Number.isFinite(kw) ? Math.round(kw * 1000) : null,
          currentA: amps.length ? Math.round(Math.max(...amps) * 10) / 10 : null,
          vehicleSocPct: null,
          raw: { evState: ev, ocppStatus: ocpp, energyWh, registers: mode },
        };
      } catch (e) {
        return { ok: false, error: `Schneider: ${e?.message || e}` };
      }
    },
  };
}
