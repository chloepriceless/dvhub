// services/wallbox/nexblue.js — Nexblue Edge 2 / Edge Max / Point 2 / Delta (2026-10-20).
//
// Quelle: nexblue.com/pages/nexblue-modbus-technical-doc. Modbus in der Nexblue-App
// einschalten; Unit 200, FC4 Input / FC3 Holding / FC16 schreiben. 32-Bit-Werte
// „full Little-Endian (DCBA)“: die vier Bytes in umgekehrter Reihenfolge, also
// Register 0 = Bytes 0/1 und Register 1 = Bytes 2/3 der Little-Endian-Darstellung.
//   IR 100 Zustand (OCPP-artig: 0 Available · 1 Preparing · 2 Charging · 3 SuspendedEVSE ·
//          4 SuspendedEV · 5 Finishing · 7 Unavailable · 8 Faulted)
//   IR 126 Leistung FLOAT32 W · IR 130 Energie UINT64 Wh
//   HR 1000 Strom FLOAT32 A (0–32) — muss regelmäßig geschrieben werden (Lebenszeichen)
//   HR 1002 Rückfallstrom FLOAT32 (≤ 16 A) · HR 1004 Rückfall-Timeout UINT32 s (30–1800)
// Nach einem Stromausfall gelten wieder die Standardwerte — DVhub schreibt alles neu.
// Den Rückfall kann man nicht abschalten: „Freigeben“ setzt ihn auf 16 A.
import { isReadOnlyMode } from '../../read-only-guard.js';

const READ_ONLY = Object.freeze({ ok: false, error: 'read_only' });
const TIMEOUT_S = 300;
const FALLBACK_A = 6;

export function encodeDcba32(kind, value) {
  const b = Buffer.alloc(4);
  if (kind === 'float') b.writeFloatLE(Number(value));
  else b.writeUInt32LE(Math.max(0, Math.round(Number(value))) >>> 0);
  return [b.readUInt16BE(0), b.readUInt16BE(2)];
}
export function decodeDcbaFloat(r0, r1) {
  const b = Buffer.alloc(4); b.writeUInt16BE(r0 & 0xffff, 0); b.writeUInt16BE(r1 & 0xffff, 2);
  const v = b.readFloatLE(0);
  return Number.isFinite(v) ? v : null;
}
function decodeDcbaU64(r) {
  const b = Buffer.alloc(8); r.forEach((w, i) => b.writeUInt16BE(w & 0xffff, i * 2));
  return Number(b.readBigUInt64LE(0));
}

export function createNexblueAdapter(getSettings, deps = {}) {
  const s = () => getSettings() || {};
  let lastA = null; // letzte Vorgabe — wird als Lebenszeichen wiederholt
  function target() {
    const t = deps.getTransport?.();
    const host = String(s().host || '').trim();
    if (!host || !t || typeof t.mbRequest !== 'function') return null;
    const unit = Number(s().unitId);
    return { t, conn: { host, port: Number(s().port) || 502, unitId: unit >= 1 && unit <= 247 ? unit : 200, timeoutMs: Number(s().timeoutMs) || 3000 } };
  }
  const missing = () => ({ ok: false, error: 'Nexblue: keine Adresse eingetragen oder Modbus nicht verfügbar' });
  const write = (x, address, values) => x.t.mbWriteMultiple({ ...x.conn, address, values });
  async function input(x, address, quantity) {
    const r = await x.t.mbRequest({ ...x.conn, fc: 4, address, quantity });
    const w = Array.isArray(r) ? r : r?.values;
    if (!Array.isArray(w)) throw new Error('keine Antwort');
    return w.map(Number);
  }
  async function control(fn) {
    if (isReadOnlyMode()) return READ_ONLY;
    const x = target();
    if (!x) return missing();
    if (typeof x.t.mbWriteMultiple !== 'function') return { ok: false, error: 'Nexblue: Modbus-Schreiben (FC16) nicht verfügbar' };
    try { await fn(x); return { ok: true }; } catch (e) { return { ok: false, error: `Nexblue: ${e?.message || e}` }; }
  }

  return {
    type: 'nexblue',
    isConfigured: () => Boolean(target()),
    charge: (currentA) => control(async (x) => {
      const a = Math.min(32, Math.max(6, Math.floor(Number(currentA))));
      await write(x, 1004, encodeDcba32('uint', TIMEOUT_S));
      await write(x, 1002, encodeDcba32('float', FALLBACK_A));
      await write(x, 1000, encodeDcba32('float', a));
      lastA = a;
    }),
    stop: () => control(async (x) => { await write(x, 1000, encodeDcba32('float', 0)); lastA = 0; }),
    release: () => control(async (x) => {
      await write(x, 1002, encodeDcba32('float', 16));
      await write(x, 1000, encodeDcba32('float', 32));
      lastA = null;
    }),
    async status() {
      const x = target();
      if (!x) return missing();
      try {
        // Lebenszeichen: die letzte Vorgabe erneut schreiben (setzt den Rückfall-Timer zurück).
        if (lastA != null && !isReadOnlyMode() && typeof x.t.mbWriteMultiple === 'function') await write(x, 1000, encodeDcba32('float', lastA));
        const [st] = await input(x, 100, 1);
        const p = await input(x, 126, 2);
        let energyWh = null;
        try { energyWh = decodeDcbaU64(await input(x, 130, 4)); } catch { /* ältere Firmware */ }
        const power = decodeDcbaFloat(p[0], p[1]);
        const error = st === 8;
        return {
          ok: true,
          connected: error ? null : st >= 1 && st <= 5,
          charging: st === 2,
          carState: error ? 'error' : st === 1 || st === 3 || st === 4 ? 'waiting' : st === 5 ? 'complete' : null,
          powerW: power == null ? null : Math.round(power),
          currentA: null,
          vehicleSocPct: null,
          raw: { state: st, energyWh },
        };
      } catch (e) {
        return { ok: false, error: `Nexblue: ${e?.message || e}` };
      }
    },
  };
}
