// services/wallbox/abl.js — ABL eM4 Single/Twin (Controller/Extender) (2026-10-20).
//
// Quelle: ABL „Schnittstellenbeschreibung Modbus TCP Wallbox eM4 Controller/Extender“
// R01 (19.12.2023): Modbus TCP 502, Unit 0xFF, FC3 lesen, FC16 schreiben (FC6 nicht
// beschrieben), Werte über mehrere Register big endian.
//   Produkt (standalone 0x01xx): 0x0124 Idefault — Höchststrom laut Installation (0,1 A)
//   Outlet 1 (links/einzeln) 0x30xx, Outlet 2 (rechts, Twin) 0x31xx:
//     +0x01 Strom L1–L3 (3×uint32, 0,1 A) · +0x0D Wirkleistung (uint32, W)
//     +0x0F Energie (uint32, 0,01 kWh) · +0x31 Status · +0x32 Icmax EMS-Vorgabe (0,1 A; 0 = aus)
// Kein Watchdog beschrieben: fällt DVhub aus, bleibt die letzte Vorgabe stehen.
// eMH1 (Modbus ASCII über RS485) und eMH2/eMH3 (keine lokale Doku) sind nicht abgedeckt.
import { isReadOnlyMode } from '../../read-only-guard.js';

const READ_ONLY = Object.freeze({ ok: false, error: 'read_only' });

export function createAblAdapter(getSettings, deps = {}) {
  const s = () => getSettings() || {};
  const base = () => (Number(s().outlet) === 2 ? 0x3100 : 0x3000);
  function target() {
    const t = deps.getTransport?.();
    const host = String(s().host || '').trim();
    if (!host || !t || typeof t.mbRequest !== 'function') return null;
    return { t, conn: { host, port: Number(s().port) || 502, unitId: 255, timeoutMs: Number(s().timeoutMs) || 3000 } };
  }
  const missing = () => ({ ok: false, error: 'ABL: keine Adresse eingetragen oder Modbus nicht verfügbar' });
  async function read(x, address, quantity) {
    const r = await x.t.mbRequest({ ...x.conn, fc: 3, address, quantity });
    const w = Array.isArray(r) ? r : r?.values;
    if (!Array.isArray(w)) throw new Error('keine Antwort');
    return w.map(Number);
  }
  const u32 = (hi, lo) => hi * 0x10000 + lo;
  async function idefault(x) {
    try { const [v] = await read(x, 0x0124, 1); return v >= 60 && v <= 320 ? v : 160; } catch { return 160; }
  }
  async function setIcmax(fn) {
    if (isReadOnlyMode()) return READ_ONLY;
    const x = target();
    if (!x) return missing();
    if (typeof x.t.mbWriteMultiple !== 'function') return { ok: false, error: 'ABL: Modbus-Schreiben (FC16) nicht verfügbar' };
    try {
      const da = await fn(x);
      await x.t.mbWriteMultiple({ ...x.conn, address: base() + 0x32, values: [da] });
      return { ok: true };
    } catch (e) { return { ok: false, error: `ABL: ${e?.message || e}` }; }
  }

  return {
    type: 'abl',
    isConfigured: () => Boolean(target()),
    charge: (currentA) => setIcmax(async (x) => Math.min(Math.max(6, Math.floor(Number(currentA))) * 10, await idefault(x))),
    stop: () => setIcmax(async () => 0),
    release: () => setIcmax(async (x) => idefault(x)),
    async status() {
      const x = target();
      if (!x) return missing();
      try {
        const b = base();
        const c = await read(x, b + 0x01, 6);
        const p = await read(x, b + 0x0d, 2);
        const e = await read(x, b + 0x0f, 2);
        const [st] = await read(x, b + 0x31, 1);
        const hi = st >> 4;
        const error = hi === 0xf;
        const currents = [u32(c[0], c[1]), u32(c[2], c[3]), u32(c[4], c[5])];
        return {
          ok: true,
          // A0: EV erkannt (gesperrt) · A1/A2: kein EV · B*: EV erkannt · C2: lädt · E*: kein EV/Bootvorgang
          connected: error ? null : st === 0xa0 || hi === 0xb || hi === 0xc,
          charging: st === 0xc2,
          carState: error ? 'error' : st === 0xb3 ? 'complete' : hi === 0xb ? 'waiting' : null,
          powerW: u32(p[0], p[1]),
          currentA: Math.max(...currents) / 10,
          vehicleSocPct: null,
          raw: { status: st, energyWh: u32(e[0], e[1]) * 10 },
        };
      } catch (err) {
        return { ok: false, error: `ABL: ${err?.message || err}` };
      }
    },
  };
}
