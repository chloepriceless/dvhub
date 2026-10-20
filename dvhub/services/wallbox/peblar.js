// services/wallbox/peblar.js — Peblar Home / Home Plus (2026-10-20).
//
// Quelle: Peblars offizieller Modbus-Client github.com/Peblar/py-modbus-api-client
// (MIT; nur die Registerliste nachgelesen). Modbus TCP 502 ab FW 1.6, in der
// Peblar-Weboberfläche unter Einstellungen → Advanced auf „ReadWrite“ stellen.
// Adressen wörtlich: Input-Register 30000…, Holding-Register 40000…
//   30000 Energie gesamt (Int64, Wh) · 30014 Leistung gesamt (Int32, W)
//   30022–30027 Strom L1–L3 (Int32, mA) · 30110 CP-Zustand (ASCII „A“…„F“)
//   40000 Ladestrom (UInt32, mA; 0 = Pause — Peblar erlaubt höchstens 3 Pausen je 10 min)
// Watchdog-/Rückfall-Register sind im Client nicht beschrieben → DVhub schreibt
// keine; fällt DVhub aus, bleibt die letzte Vorgabe stehen.
import { isReadOnlyMode } from '../../read-only-guard.js';

const READ_ONLY = Object.freeze({ ok: false, error: 'read_only' });
const RELEASE_MA = 32000;

export function createPeblarAdapter(getSettings, deps = {}) {
  const s = () => getSettings() || {};
  function target() {
    const t = deps.getTransport?.();
    const host = String(s().host || '').trim();
    if (!host || !t || typeof t.mbRequest !== 'function') return null;
    return { t, conn: { host, port: Number(s().port) || 502, unitId: 1, timeoutMs: Number(s().timeoutMs) || 3000 } };
  }
  const missing = () => ({ ok: false, error: 'Peblar: keine Adresse eingetragen oder Modbus nicht verfügbar' });
  async function input(x, address, quantity) {
    const r = await x.t.mbRequest({ ...x.conn, fc: 4, address, quantity });
    const w = Array.isArray(r) ? r : r?.values;
    if (!Array.isArray(w)) throw new Error('keine Antwort');
    return w.map(Number);
  }
  const i32 = (hi, lo) => { const v = hi * 0x10000 + lo; return v >= 0x80000000 ? v - 0x100000000 : v; };
  async function setMa(ma) {
    if (isReadOnlyMode()) return READ_ONLY;
    const x = target();
    if (!x) return missing();
    if (typeof x.t.mbWriteMultiple !== 'function') return { ok: false, error: 'Peblar: Modbus-Schreiben (FC16) nicht verfügbar' };
    try {
      await x.t.mbWriteMultiple({ ...x.conn, address: 40000, values: [Math.floor(ma / 0x10000), ma & 0xffff] });
      return { ok: true };
    } catch (e) { return { ok: false, error: `Peblar: ${e?.message || e}` }; }
  }

  return {
    type: 'peblar',
    isConfigured: () => Boolean(target()),
    charge: (currentA) => setMa(Math.max(6, Math.floor(Number(currentA))) * 1000),
    stop: () => setMa(0),
    release: () => setMa(RELEASE_MA),
    async status() {
      const x = target();
      if (!x) return missing();
      try {
        const e = await input(x, 30000, 4);
        const p = await input(x, 30014, 2);
        const c = await input(x, 30022, 6);
        const [cp] = await input(x, 30110, 1);
        const letter = String.fromCharCode((cp >> 8) & 0xff).toUpperCase();
        const error = letter === 'E' || letter === 'F';
        const currents = [i32(c[0], c[1]), i32(c[2], c[3]), i32(c[4], c[5])];
        return {
          ok: true,
          connected: error ? null : letter === 'B' || letter === 'C' || letter === 'D',
          charging: letter === 'C' || letter === 'D',
          carState: error ? 'error' : letter === 'B' ? 'waiting' : null,
          powerW: i32(p[0], p[1]),
          currentA: Math.max(...currents) / 1000,
          vehicleSocPct: null,
          raw: { cpState: letter, energyWh: ((e[0] * 0x10000 + e[1]) * 0x100000000) + (e[2] * 0x10000 + e[3]) },
        };
      } catch (err) {
        return { ok: false, error: `Peblar: ${err?.message || err}` };
      }
    },
  };
}
