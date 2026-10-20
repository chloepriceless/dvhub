// services/wallbox/keba.js — KEBA KeContact P30/P40 (2026-10-20).
//
// Quelle: KEBA „KeContact P30 Modbus TCP Programmers Guide“ V1.07 (P40 Modbus
// Guide V1.02 gleiche Register): Modbus TCP, Unit 255, FC3 lesen — je Register
// ein UINT32 (2 Wörter, einzeln lesen), FC6 schreiben (UINT16). KEBA empfiehlt,
// höchstens alle 5 s zu schreiben: DVhub schreibt einen Wert nur, wenn er sich
// ändert (nach 5 min erneut — 5004 gilt nur bis zum Neustart der Box).
// Voraussetzung P30: DIP-Schalter DSW1.3 = ON (Modbus und UDP schließen sich aus).
// P40: Modbus in der KEBA-App einschalten; 5014 erst mit späterer Software —
// Stopp deshalb über Strom 0.
import { isReadOnlyMode } from '../../read-only-guard.js';

const READ_ONLY = Object.freeze({ ok: false, error: 'read_only' });
const REWRITE_MS = 5 * 60_000;
const FAILSAFE_A = 6;
const FAILSAFE_S = 300;

export function createKebaAdapter(getSettings, deps = {}) {
  const now = deps.now || (() => Date.now());
  const s = () => getSettings() || {};
  const p40 = () => s().model === 'p40';
  const written = new Map(); // Register → { value, at }
  function target() {
    const t = deps.getTransport?.();
    const host = String(s().host || '').trim();
    if (!host || !t || typeof t.mbRequest !== 'function') return null;
    return { t, conn: { host, port: Number(s().port) || 502, unitId: 255, timeoutMs: Number(s().timeoutMs) || 3000 } };
  }
  const missing = () => ({ ok: false, error: 'KEBA: keine Adresse eingetragen oder Modbus nicht verfügbar' });
  async function u32(x, address) {
    const r = await x.t.mbRequest({ ...x.conn, fc: 3, address, quantity: 2 });
    const w = Array.isArray(r) ? r : r?.values;
    return (Number(w[0]) * 0x10000) + Number(w[1]);
  }
  async function write(x, address, value) {
    const last = written.get(address);
    if (last && last.value === value && now() - last.at < REWRITE_MS) return;
    await x.t.mbWriteSingle({ ...x.conn, address, value });
    written.set(address, { value, at: now() });
  }
  async function guarded(fn) {
    if (isReadOnlyMode()) return READ_ONLY;
    const x = target();
    if (!x) return missing();
    try { await fn(x); return { ok: true }; } catch (e) { return { ok: false, error: `KEBA: ${e?.message || e}` }; }
  }
  async function hwMaxMa(x) {
    try { const v = await u32(x, 1110); return v >= 6000 && v <= 63000 ? v : 16000; } catch { return 16000; }
  }

  return {
    type: 'keba',
    isConfigured: () => Boolean(target()),
    charge: (currentA) => guarded(async (x) => {
      // Failsafe zuerst: bricht die Verbindung 5 min ab, lädt die Box mit 6 A weiter.
      await write(x, 5016, FAILSAFE_A * 1000);
      await write(x, 5018, FAILSAFE_S);
      await write(x, 5004, Math.max(6, Math.floor(Number(currentA))) * 1000);
      if (!p40()) await write(x, 5014, 1);
    }),
    stop: () => guarded(async (x) => {
      if (p40()) await write(x, 5004, 0);
      else await write(x, 5014, 0);
    }),
    // Zurück zur Box: Failsafe aus, Strom auf Hardware-Höchstwert, freigegeben.
    release: () => guarded(async (x) => {
      await write(x, 5018, 0);
      await write(x, 5004, await hwMaxMa(x));
      if (!p40()) await write(x, 5014, 1);
    }),
    async status() {
      const x = target();
      if (!x) return missing();
      try {
        const state = await u32(x, 1000);
        const cable = await u32(x, 1004);
        const powerMw = await u32(x, 1020);
        let energy = null;
        try { energy = (await u32(x, 1036)) / 10; } catch { /* ältere Firmware */ }
        const error = state === 4;
        return {
          ok: true,
          connected: error ? null : cable === 5 || cable === 7,
          charging: state === 3,
          carState: error ? 'error' : state === 2 || state === 5 ? 'waiting' : null,
          powerW: Math.round(powerMw / 1000),
          currentA: null,
          vehicleSocPct: null,
          raw: { state, cable, energyWh: energy, model: p40() ? 'p40' : 'p30' },
        };
      } catch (e) {
        return { ok: false, error: `KEBA: ${e?.message || e}` };
      }
    },
  };
}
