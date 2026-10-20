// services/wallbox/heidelberg.js — Amperfied (Heidelberg) connect und Elli Gen 2 (2026-10-20).
//
// Beide nutzen dasselbe Modbus-TCP-Registerlayout (Elli: „Based on the registry
// implementation of the Ghost platform from eSystems“, Referenz Amperfied):
//   Amperfied „Modbus Register Layout connect series“ (04/2025),
//   Elli „Modbus Registerliste v1.0“ (15.10.2025, ab FW R03.004.045.121-elli).
// FC4: 5 Zustand nach EN 61851 (2 A1 · 3 A2 · 4 B1 · 5 B2 · 6 C1 · 7 C2 · 8 Derating ·
//      9 E · 10 F/gesperrt · 11 Fehler), 6–8 Strom (0,1 A), 14 Leistung (VA),
//      17/18 Energie seit Installation (VAh, hohes/niedriges Wort), 100 Hardware-Höchststrom (A).
// FC6: 257 Watchdog (ms; ohne Modbus-Verkehr in dieser Zeit → Rückfallstrom), 261
//      Höchststrom (0,1 A; 0 = nicht laden), 262 Rückfallstrom (0,1 A).
// Elli: 261 kann durch interne Grenzen weiter gesenkt werden; Höchstwert 16 A
// (22-kW-Variante später 32 A). Heidelberg Energy Control (nur RS485) geht über
// ein Modbus-TCP-Gateway mit derselben Registerbelegung.
import { isReadOnlyMode } from '../../read-only-guard.js';

const READ_ONLY = Object.freeze({ ok: false, error: 'read_only' });
const REWRITE_MS = 5 * 60_000;
const WATCHDOG_MS = 60_000;
const FAILSAFE_DA = 60; // 6,0 A

export function createHeidelbergAdapter(getSettings, deps = {}) {
  const now = deps.now || (() => Date.now());
  const s = () => getSettings() || {};
  const written = new Map();
  function target() {
    const t = deps.getTransport?.();
    const host = String(s().host || '').trim();
    if (!host || !t || typeof t.mbRequest !== 'function') return null;
    const unit = Number(s().unitId);
    return { t, conn: { host, port: Number(s().port) || 502, unitId: unit >= 1 && unit <= 255 ? unit : 1, timeoutMs: Number(s().timeoutMs) || 3000 } };
  }
  const missing = () => ({ ok: false, error: 'Wallbox: keine Adresse eingetragen oder Modbus nicht verfügbar' });
  async function input(x, address, quantity = 1) {
    const r = await x.t.mbRequest({ ...x.conn, fc: 4, address, quantity });
    return Array.isArray(r) ? r : r?.values;
  }
  async function write(x, address, value) {
    const last = written.get(address);
    if (last && last.value === value && now() - last.at < REWRITE_MS) return;
    await x.t.mbWriteSingle({ ...x.conn, address, value });
    written.set(address, { value, at: now() });
  }
  async function hwMaxDa(x) {
    try { const v = Number((await input(x, 100))[0]); return v >= 6 && v <= 32 ? v * 10 : 160; } catch { return 160; }
  }
  async function guarded(fn) {
    if (isReadOnlyMode()) return READ_ONLY;
    const x = target();
    if (!x) return missing();
    try { await fn(x); return { ok: true }; } catch (e) { return { ok: false, error: `Wallbox: ${e?.message || e}` }; }
  }

  return {
    type: 'heidelberg',
    isConfigured: () => Boolean(target()),
    charge: (currentA) => guarded(async (x) => {
      const da = Math.min(Math.max(6, Math.floor(Number(currentA))) * 10, await hwMaxDa(x));
      await write(x, 262, FAILSAFE_DA);
      await write(x, 257, WATCHDOG_MS);
      await write(x, 261, da);
    }),
    stop: () => guarded(async (x) => { await write(x, 261, 0); }),
    release: () => guarded(async (x) => {
      await write(x, 257, 0);
      await write(x, 261, await hwMaxDa(x));
    }),
    async status() {
      const x = target();
      if (!x) return missing();
      try {
        const state = Number((await input(x, 5))[0]);
        const cur = await input(x, 6, 3);
        const power = Number((await input(x, 14))[0]);
        let energyWh = null;
        try { const e = await input(x, 17, 2); energyWh = Number(e[0]) * 0x10000 + Number(e[1]); } catch { /* ältere Layouts */ }
        const error = state === 9 || state === 11;
        return {
          ok: true,
          connected: error ? null : state >= 4 && state <= 8,
          charging: state === 7,
          carState: error ? 'error' : state === 4 || state === 5 || state === 6 ? 'waiting' : null,
          powerW: Number.isFinite(power) ? power : null,
          currentA: Math.max(...cur.map(Number)) / 10,
          vehicleSocPct: null,
          raw: { state, energyWh },
        };
      } catch (e) {
        return { ok: false, error: `Wallbox: ${e?.message || e}` };
      }
    },
  };
}
