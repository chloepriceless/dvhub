// services/wallbox/phoenix.js — Phoenix Contact EV Charge Control (2026-10-20).
//
// Steckt u. a. in Wallbe, Compleo Pro, E3/DC Easy Connect und ESL Walli.
// Quelle: Phoenix-Anwenderhandbuch „Installation und Inbetriebnahme der Ladesteuerung
// EV Charge Control“ 108191_de_04 (2020-09-17), Kap. 9. Unit 255, Port 502;
// 32-Bit-Werte im Little-Endian-Format, niederwertiges Wort zuerst.
//   Input 100 Zustand IEC 61851 (ASCII A–F) · 101 Kabel-Stromtragfähigkeit (A) ·
//   104 DIP-Schalter (DIP 1 = Bit 0) · 107 Fehlerbits · 114/116/118 Strom I1–I3 (A) ·
//   120 Wirkleistung (W) · Holding 904 Energiezähler (Wh)
//   Holding 528 Vorgabe Ladestrom (A) · Coil 400 Ladevorgang freigeben (nur bei DIP 10 = 1)
// Kein Watchdog: fällt DVhub aus, bleiben Vorgabe und Freigabe stehen.
import { isReadOnlyMode } from '../../read-only-guard.js';

const READ_ONLY = Object.freeze({ ok: false, error: 'read_only' });
const REWRITE_MS = 5 * 60_000;
const DIP10 = 1 << 9;

const u32 = (lo, hi) => (Number(lo) & 0xffff) + (Number(hi) & 0xffff) * 0x10000;
const s32 = (lo, hi) => { const v = u32(lo, hi); return v >= 0x80000000 ? v - 0x100000000 : v; };
function stateLetter(word) {
  const w = Number(word) & 0xffff;
  for (const c of [w & 0xff, w >> 8]) if (c >= 0x41 && c <= 0x46) return String.fromCharCode(c);
  return null;
}

export function createPhoenixAdapter(getSettings, deps = {}) {
  const now = deps.now || (() => Date.now());
  const s = () => getSettings() || {};
  const written = new Map();
  function target() {
    const t = deps.getTransport?.();
    const host = String(s().host || '').trim();
    if (!host || !t || typeof t.mbRequest !== 'function') return null;
    const unit = Number(s().unitId);
    return { t, conn: { host, port: Number(s().port) || 502, unitId: unit >= 1 && unit <= 255 ? unit : 255, timeoutMs: Number(s().timeoutMs) || 3000 } };
  }
  const missing = () => ({ ok: false, error: 'Phoenix EV-CC: keine Adresse eingetragen oder Modbus nicht verfügbar' });
  async function read(x, fc, address, quantity = 1) {
    const r = await x.t.mbRequest({ ...x.conn, fc, address, quantity });
    const w = Array.isArray(r) ? r : r?.values;
    if (!Array.isArray(w)) throw new Error('keine Antwort');
    return w.map(Number);
  }
  async function once(key, value, fn) {
    const last = written.get(key);
    if (last && last.value === value && now() - last.at < REWRITE_MS) return;
    await fn();
    written.set(key, { value, at: now() });
  }
  const setCurrent = (x, a) => once('hr528', a, () => x.t.mbWriteSingle({ ...x.conn, address: 528, value: a }));
  const enable = (x, on) => once('coil400', on, () => x.t.mbWriteCoil({ ...x.conn, address: 400, value: on }));
  async function guarded(fn) {
    if (isReadOnlyMode()) return READ_ONLY;
    const x = target();
    if (!x) return missing();
    if (typeof x.t.mbWriteCoil !== 'function' || typeof x.t.mbWriteSingle !== 'function') return { ok: false, error: 'Phoenix EV-CC: Modbus-Schreiben nicht verfügbar' };
    try {
      const [dip] = await read(x, 4, 104);
      if (!(dip & DIP10)) return { ok: false, error: 'Phoenix EV-CC: DIP 10 ist aus — ohne ihn nimmt die Ladesteuerung keine Freigabe per Modbus an' };
      await fn(x);
      return { ok: true };
    } catch (e) { return { ok: false, error: `Phoenix EV-CC: ${e?.message || e}` }; }
  }

  return {
    type: 'phoenix',
    isConfigured: () => Boolean(target()),
    charge: (currentA) => guarded(async (x) => {
      await setCurrent(x, Math.min(80, Math.max(6, Math.floor(Number(currentA)))));
      await enable(x, true);
    }),
    stop: () => guarded(async (x) => { await enable(x, false); }),
    release: () => guarded(async (x) => {
      const [pp] = await read(x, 4, 101);
      await setCurrent(x, pp >= 13 && pp <= 32 ? pp : pp > 32 ? 32 : 16);
      await enable(x, true);
    }),
    async status() {
      const x = target();
      if (!x) return missing();
      try {
        const [st] = await read(x, 4, 100);
        const letter = stateLetter(st);
        const [errBits] = await read(x, 4, 107);
        const cur = await read(x, 4, 114, 6);
        const p = await read(x, 4, 120, 2);
        let energyWh = null;
        try { const e = await read(x, 3, 904, 2); energyWh = u32(e[0], e[1]); } catch { /* ältere Firmware */ }
        const error = letter === 'E' || letter === 'F';
        return {
          ok: true,
          connected: error || !letter ? null : letter !== 'A',
          charging: letter === 'C' || letter === 'D',
          carState: error ? 'error' : letter === 'B' ? 'waiting' : null,
          powerW: s32(p[0], p[1]),
          currentA: Math.max(u32(cur[0], cur[1]), u32(cur[2], cur[3]), u32(cur[4], cur[5])),
          vehicleSocPct: null,
          raw: { state: letter, errorBits: errBits, energyWh },
        };
      } catch (e) {
        return { ok: false, error: `Phoenix EV-CC: ${e?.message || e}` };
      }
    },
  };
}
