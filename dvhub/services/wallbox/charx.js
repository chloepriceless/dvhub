// services/wallbox/charx.js — Phoenix Contact CHARX SEC-3xxx (2026-10-20).
//
// Quelle: Handbuch „CHARX control modular“ 109999_en_04, Anhang B 3 (Modbus TCP,
// Unit 1, Port 502, 16-Bit-Holding-Register; FC3 und FC4 liefern dasselbe).
// Register je Ladepunkt x000…x999 (x = Nummer des Ladepunkts in der CHARX):
//   x101 Höchststrom laut Konfiguration (A)
//   x244 Wirkleistung (2 Register, MSW zuerst, mW) · x250 Energie (4 Register, Wh)
//   x297 aktueller Ladestrom (A) · x299 Fahrzeugstatus IEC 61851 (ASCII: A1, B2, C2, E0, F0, IN)
//   x300 Ladefreigabe (nur, wenn an der CHARX Freigabemodus „Modbus“ eingestellt ist)
//   x301 Höchststrom 6–80 A · x306 Strom nach abgelaufenem Watchdog · x307 Watchdog (s, 65535 = aus)
// Auch für Geräte mit CHARX-Steuerung (Veton, LadeFoxx …).
import { isReadOnlyMode } from '../../read-only-guard.js';

const READ_ONLY = Object.freeze({ ok: false, error: 'read_only' });
const WATCHDOG_S = 300;
const WATCHDOG_FALLBACK_A = 6;

export function createCharxAdapter(getSettings, deps = {}) {
  const s = () => getSettings() || {};
  const base = () => Math.max(1, Math.min(99, Number(s().chargePoint) || 1)) * 1000;
  function target() {
    const t = deps.getTransport?.();
    const host = String(s().host || '').trim();
    if (!host || !t || typeof t.mbRequest !== 'function') return null;
    return { t, conn: { host, port: Number(s().port) || 502, unitId: 1, timeoutMs: Number(s().timeoutMs) || 3000 } };
  }
  const missing = () => ({ ok: false, error: 'CHARX: keine Adresse eingetragen oder Modbus nicht verfügbar' });
  const read = async (x, address, quantity) => {
    const r = await x.t.mbRequest({ ...x.conn, fc: 3, address, quantity });
    return Array.isArray(r) ? r : r?.values;
  };
  const write = (x, address, value) => x.t.mbWriteSingle({ ...x.conn, address, value });
  async function guarded(fn) {
    if (isReadOnlyMode()) return READ_ONLY;
    const x = target();
    if (!x) return missing();
    try { await fn(x); return { ok: true }; } catch (e) { return { ok: false, error: `CHARX: ${e?.message || e}` }; }
  }
  async function maxA(x) {
    const r = await read(x, base() + 101, 1);
    const v = Number(r?.[0]);
    return v >= 6 && v <= 80 ? v : 16;
  }

  return {
    type: 'charx',
    isConfigured: () => Boolean(target()),
    charge: (currentA) => guarded(async (x) => {
      const amps = Math.min(Math.max(6, Math.floor(Number(currentA))), await maxA(x));
      // Watchdog zuerst: stirbt DVhub, fällt die Box nach 5 min auf 6 A zurück.
      await write(x, base() + 306, WATCHDOG_FALLBACK_A);
      await write(x, base() + 307, WATCHDOG_S);
      await write(x, base() + 301, amps);
      await write(x, base() + 300, 1);
    }),
    stop: () => guarded(async (x) => {
      await write(x, base() + 307, WATCHDOG_S);
      await write(x, base() + 300, 0);
    }),
    // Zurück zur Einstellung der Box: Watchdog aus, Höchststrom laut Konfiguration, freigegeben.
    release: () => guarded(async (x) => {
      await write(x, base() + 307, 65535);
      await write(x, base() + 301, await maxA(x));
      await write(x, base() + 300, 1);
    }),
    async status() {
      const x = target();
      if (!x) return missing();
      try {
        const b = base();
        const st = await read(x, b + 299, 1);
        const p = await read(x, b + 244, 2);
        const e = await read(x, b + 250, 4);
        const cur = await read(x, b + 297, 1);
        const code = String.fromCharCode((st[0] >> 8) & 0xff, st[0] & 0xff).replace(/\0/g, '').trim();
        const letter = code[0] || '';
        const powerMw = (p[0] * 0x10000) + p[1];
        const energyWh = ((e[0] * 0x10000 + e[1]) * 0x100000000) + (e[2] * 0x10000 + e[3]);
        const error = letter === 'E' || letter === 'F';
        // Bei 7 kW ruht kein „C1“ — als „lädt“ zählt C2 (Schütz zu); C1 = wartet aufs Auto.
        return {
          ok: true,
          connected: error ? null : (letter === 'B' || letter === 'C' || letter === 'D'),
          charging: code === 'C2' || code === 'D2',
          carState: error ? 'error' : (code === 'C1' || code === 'B2' ? 'waiting' : null),
          powerW: Math.round(powerMw / 1000),
          currentA: Number.isFinite(Number(cur?.[0])) ? Number(cur[0]) : null,
          vehicleSocPct: null,
          raw: { iecState: code, energyWh },
        };
      } catch (e2) {
        return { ok: false, error: `CHARX: ${e2?.message || e2}` };
      }
    },
  };
}
