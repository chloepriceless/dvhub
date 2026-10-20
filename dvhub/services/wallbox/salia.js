// services/wallbox/salia.js — Hardy Barth Salia cPH2 / cPμ2 (2026-10-20).
//
// Quelle: docs.echarge.de/modbus-tcp/documentation (MapVersion 2.1.0): Modbus TCP,
// Unit 1, PDU-Adressen 0-basiert („30001“ = Input 0, „40107“ = Holding 106).
//   FC4 0 Zustand · 1014/1015 Leistung Float32 W · 1022/1023 Energie Float32 kWh
//   FC6 106 Modus (0 ECO · 1 POWER · 2 MANUAL — ein Moduswechsel setzt die Grenze
//       zurück, deshalb danach den Strom neu schreiben) · 201 Strom (A) · 202 Start/Stopp
//       203 Failsafe-Timeout (s; 0 aus, sonst 10–3600) · 205 Failsafe-Strom (A)
//       207 Lebenszeichen (beliebiger Wert, spätestens alle Timeout/2)
// Ob „bereit“ (1) ein angestecktes Auto meint, ist nicht dokumentiert — dann „unbekannt“.
import { isReadOnlyMode } from '../../read-only-guard.js';

const READ_ONLY = Object.freeze({ ok: false, error: 'read_only' });
const REWRITE_MS = 5 * 60_000;
const FAILSAFE_S = 300;
const FAILSAFE_A = 6;

export function createSaliaAdapter(getSettings, deps = {}) {
  const now = deps.now || (() => Date.now());
  const s = () => getSettings() || {};
  const written = new Map();
  let controlling = false;
  function target() {
    const t = deps.getTransport?.();
    const host = String(s().host || '').trim();
    if (!host || !t || typeof t.mbRequest !== 'function') return null;
    return { t, conn: { host, port: Number(s().port) || 502, unitId: 1, timeoutMs: Number(s().timeoutMs) || 3000 } };
  }
  const missing = () => ({ ok: false, error: 'Salia: keine Adresse eingetragen oder Modbus nicht verfügbar' });
  async function input(x, address, quantity = 1) {
    const r = await x.t.mbRequest({ ...x.conn, fc: 4, address, quantity });
    const w = Array.isArray(r) ? r : r?.values;
    if (!Array.isArray(w)) throw new Error('keine Antwort');
    return w.map(Number);
  }
  const f32 = (hi, lo) => { const b = Buffer.alloc(4); b.writeUInt16BE(hi & 0xffff, 0); b.writeUInt16BE(lo & 0xffff, 2); const v = b.readFloatBE(0); return Number.isFinite(v) ? v : null; };
  async function write(x, address, value, { force = false } = {}) {
    const last = written.get(address);
    if (!force && last && last.value === value && now() - last.at < REWRITE_MS) return;
    await x.t.mbWriteSingle({ ...x.conn, address, value });
    written.set(address, { value, at: now() });
  }
  async function guarded(fn) {
    if (isReadOnlyMode()) return READ_ONLY;
    const x = target();
    if (!x) return missing();
    try { await fn(x); return { ok: true }; } catch (e) { return { ok: false, error: `Salia: ${e?.message || e}` }; }
  }

  return {
    type: 'salia',
    isConfigured: () => Boolean(target()),
    charge: (currentA) => guarded(async (x) => {
      await write(x, 203, FAILSAFE_S);
      await write(x, 205, FAILSAFE_A);
      const modeChanged = written.get(106)?.value !== 2;
      await write(x, 106, 2);
      await write(x, 201, Math.max(6, Math.floor(Number(currentA))), { force: modeChanged });
      await write(x, 202, 1);
      controlling = true;
    }),
    stop: () => guarded(async (x) => { await write(x, 202, 0); controlling = true; }),
    release: () => guarded(async (x) => {
      await write(x, 203, 0);
      await write(x, 106, 1);
      controlling = false;
    }),
    async status() {
      const x = target();
      if (!x) return missing();
      try {
        // Lebenszeichen, solange DVhub steuert (Failsafe-Timeout 300 s, Abfrage alle 15 s).
        if (controlling && !isReadOnlyMode()) await x.t.mbWriteSingle({ ...x.conn, address: 207, value: 1 });
        const [state] = await input(x, 0);
        const p = await input(x, 1014, 2);
        let energyKwh = null;
        try { const e = await input(x, 1022, 2); energyKwh = f32(e[0], e[1]); } catch { /* ältere Map */ }
        const power = f32(p[0], p[1]);
        const error = state === 4;
        return {
          ok: true,
          connected: error ? null : state === 2 || state === 3 || state === 7 ? true : state === 0 ? false : null,
          charging: state === 2,
          carState: error ? 'error' : state === 3 ? 'waiting' : null,
          powerW: power == null ? null : Math.round(power),
          currentA: null,
          vehicleSocPct: null,
          raw: { state, energyKwh },
        };
      } catch (e) {
        return { ok: false, error: `Salia: ${e?.message || e}` };
      }
    },
  };
}
