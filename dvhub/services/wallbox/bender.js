// services/wallbox/bender.js — Bender-Laderegler CC612/CC613/ICC (2026-10-20).
//
// Steckt in Mennekes AMTRON Professional/AMEDIO (ECU), SMA EV Charger Business,
// Webasto Live, Optec, Ebee, CUBOS, Ensto. Quelle: bender.de/docs/charge-controller/
// APIs/Modbus-API (v5.38) — in der Weboberfläche „Modbus TCP Server“ einschalten und
// den Registersatz „OMCCI“ (Open Modbus Charge Control Interface) wählen; Mennekes:
// ab Software 5.12. Alle Register sind Holding-Register; 32-Bit-Werte hohes Wort zuerst,
// 0xFFFFFFFF = nicht verfügbar.
//   122 Fahrzeugzustand A=1 B=2 C=3 D=4 E=5 · 212–217 Strom (mA) · 218/219 Energie (Wh)
//   220/221 Leistung (W) · 1000 HEMS-Stromgrenze (A, 0 = Pause)
//   131 Strom bei Kommunikationsausfall (A) · 132 Timeout (s)
import { isReadOnlyMode } from '../../read-only-guard.js';

const READ_ONLY = Object.freeze({ ok: false, error: 'read_only' });
const REWRITE_MS = 5 * 60_000;
const SAFE_A = 6;
const TIMEOUT_S = 300;
const RELEASE_A = 32;
const NA = 0xffffffff;

export function createBenderAdapter(getSettings, deps = {}) {
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
  const missing = () => ({ ok: false, error: 'Bender: keine Adresse eingetragen oder Modbus nicht verfügbar' });
  async function regs(x, address, quantity) {
    const r = await x.t.mbRequest({ ...x.conn, fc: 3, address, quantity });
    const w = Array.isArray(r) ? r : r?.values;
    if (!Array.isArray(w)) throw new Error('keine Antwort');
    return w.map(Number);
  }
  const u32 = (hi, lo) => { const v = hi * 0x10000 + lo; return v === NA ? null : v; };
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
    try { await fn(x); return { ok: true }; } catch (e) { return { ok: false, error: `Bender: ${e?.message || e}` }; }
  }

  return {
    type: 'bender',
    isConfigured: () => Boolean(target()),
    charge: (currentA) => guarded(async (x) => {
      await write(x, 131, SAFE_A);
      await write(x, 132, TIMEOUT_S);
      await write(x, 1000, Math.max(6, Math.floor(Number(currentA))));
    }),
    stop: () => guarded(async (x) => { await write(x, 1000, 0); }),
    // Zurück zur Box: Grenze und Rückfallstrom auf 32 A (die Box begrenzt selbst auf ihre Hardware).
    release: () => guarded(async (x) => {
      await write(x, 131, RELEASE_A);
      await write(x, 1000, RELEASE_A);
    }),
    async status() {
      const x = target();
      if (!x) return missing();
      try {
        const [vs] = await regs(x, 122, 1);
        const m = await regs(x, 212, 10); // 212–221: Ströme, Energie, Leistung
        const currents = [u32(m[0], m[1]), u32(m[2], m[3]), u32(m[4], m[5])].filter((v) => v != null);
        const error = vs === 5;
        return {
          ok: true,
          connected: error ? null : vs >= 2 && vs <= 4,
          charging: vs === 3 || vs === 4,
          carState: error ? 'error' : vs === 2 ? 'waiting' : null,
          powerW: u32(m[8], m[9]),
          currentA: currents.length ? Math.max(...currents) / 1000 : null,
          vehicleSocPct: null,
          raw: { vehicleState: vs, energyWh: u32(m[6], m[7]) },
        };
      } catch (e) {
        return { ok: false, error: `Bender: ${e?.message || e}` };
      }
    },
  };
}
