// services/wallbox/em2go.js — EM2GO (EM011/EM022 OCPP/ONC, Pro Power) (2026-10-20).
//
// Quelle: EM2GO „Programmieren von EV-Wallboxen ModBus TCP“ V5 01/2023
// (media.elv.com/file/252210_modbus_tcp_register.pdf). Port 502, FC03 lesen — höchstens
// 3 Register je Anfrage (sonst Ausnahme 0xFF) —, FC16 schreiben, Big Endian.
//   0 Zustand (1 Standby · 2 Verbunden · 3 Starte · 4 Lädt · 5 Start fehlgeschlagen ·
//     6 Laden beendet · 7 Systemfehler · 8 Transaktion geplant · 9 Update · 10 Start)
//   2 Kabel (0/1) · 4 Fehlercode (0 = keiner) · 6/8/10 Strom L1–L3 (0,1 A)
//   12 Leistung UInt32 W · 28 Zählerstand UInt32 (0,1 kWh) · 32 EVSE-Höchststrom (0,1 A)
//   87 Rückfallstrom (0,1 A) · 89 Kommunikations-Timeout (s) · 91 Strombegrenzung (0,1 A)
//   93 Lademodus (0 Plug & Charge · 1 auf Befehl) · 95 Ladebefehl (1 Start · 2 Stopp; nur bei 93 = 1)
// Die Unit-ID nennt die Doku nicht (Standard hier 1, einstellbar). Ob schon Lesen den
// Timeout zurücksetzt, ist nicht beschrieben — darum 600 s, länger als der Neuschreibtakt.
import { isReadOnlyMode } from '../../read-only-guard.js';

const READ_ONLY = Object.freeze({ ok: false, error: 'read_only' });
const REWRITE_MS = 5 * 60_000;
const TIMEOUT_S = 600;
const FALLBACK_DA = 60;

export function createEm2goAdapter(getSettings, deps = {}) {
  const now = deps.now || (() => Date.now());
  const s = () => getSettings() || {};
  const written = new Map();
  let switchedMode = false; // DVhub hat Plug & Charge → Befehlsmodus umgestellt
  let stopped = false;
  function target() {
    const t = deps.getTransport?.();
    const host = String(s().host || '').trim();
    if (!host || !t || typeof t.mbRequest !== 'function') return null;
    const unit = Number(s().unitId);
    return { t, conn: { host, port: Number(s().port) || 502, unitId: unit >= 1 && unit <= 255 ? unit : 1, timeoutMs: Number(s().timeoutMs) || 3000 } };
  }
  const missing = () => ({ ok: false, error: 'EM2GO: keine Adresse eingetragen oder Modbus nicht verfügbar' });
  async function read(x, address, quantity = 1) {
    const r = await x.t.mbRequest({ ...x.conn, fc: 3, address, quantity });
    const w = Array.isArray(r) ? r : r?.values;
    if (!Array.isArray(w)) throw new Error('keine Antwort');
    return w.map(Number);
  }
  async function put(x, address, value, { force = false } = {}) {
    const last = written.get(address);
    if (!force && last && last.value === value && now() - last.at < REWRITE_MS) return;
    await x.t.mbWriteMultiple({ ...x.conn, address, values: [value] });
    written.set(address, { value, at: now() });
  }
  async function maxDa(x) {
    try { const v = (await read(x, 32))[0]; return v >= 60 && v <= 320 ? v : 160; } catch { return 160; }
  }
  async function guarded(fn) {
    if (isReadOnlyMode()) return READ_ONLY;
    const x = target();
    if (!x) return missing();
    if (typeof x.t.mbWriteMultiple !== 'function') return { ok: false, error: 'EM2GO: Modbus-Schreiben (FC16) nicht verfügbar' };
    try { await fn(x); return { ok: true }; } catch (e) { return { ok: false, error: `EM2GO: ${e?.message || e}` }; }
  }

  return {
    type: 'em2go',
    isConfigured: () => Boolean(target()),
    charge: (currentA) => guarded(async (x) => {
      const da = Math.min(Math.max(6, Math.floor(Number(currentA))) * 10, await maxDa(x));
      await put(x, 87, FALLBACK_DA);
      await put(x, 89, TIMEOUT_S);
      await put(x, 91, da);
      const [mode] = await read(x, 93);
      const [state] = await read(x, 0);
      // Im Befehlsmodus startet die Box erst auf Befehl (Auto verbunden, aber kein Vorgang).
      if (mode === 1 && (stopped || state === 2 || state === 6)) await put(x, 95, 1, { force: true });
      stopped = false;
    }),
    stop: () => guarded(async (x) => {
      const [mode] = await read(x, 93);
      if (mode !== 1) { await put(x, 93, 1, { force: true }); switchedMode = true; }
      await put(x, 95, 2, { force: true });
      stopped = true;
    }),
    release: () => guarded(async (x) => {
      const max = await maxDa(x);
      await put(x, 87, max);
      await put(x, 91, max);
      if (switchedMode) { await put(x, 93, 0, { force: true }); switchedMode = false; }
      else if (stopped) await put(x, 95, 1, { force: true });
      stopped = false;
    }),
    async status() {
      const x = target();
      if (!x) return missing();
      try {
        const [state] = await read(x, 0);
        const [cable, , errCode] = await read(x, 2, 3);
        const c12 = await read(x, 6, 3);
        const [c3] = await read(x, 10);
        const p = await read(x, 12, 2);
        let energyWh = null;
        try { const e = await read(x, 28, 2); energyWh = (e[0] * 0x10000 + e[1]) * 100; } catch { /* optional */ }
        const error = state === 7 || state === 5 || errCode > 0;
        return {
          ok: true,
          connected: error ? null : cable === 1,
          charging: state === 4,
          carState: error ? 'error' : state === 2 || state === 3 || state === 8 ? 'waiting' : state === 6 ? 'complete' : null,
          powerW: p[0] * 0x10000 + p[1],
          currentA: Math.max(c12[0], c12[2], c3) / 10,
          vehicleSocPct: null,
          raw: { state, errorCode: errCode, energyWh },
        };
      } catch (e) {
        return { ok: false, error: `EM2GO: ${e?.message || e}` };
      }
    },
  };
}
