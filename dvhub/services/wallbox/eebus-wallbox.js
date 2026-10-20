// services/wallbox/eebus-wallbox.js — EEBUS-Wallbox als Hauptwallbox (2026-10-20).
//
// Elli / VW ID. Charger, Cupra, Audi, Škoda, Porsche Wallbox, Kontron/Steca/
// ghostONE sprechen EEBUS. Zwei Wege:
//   • Auto steckt und die Box meldet OPEV (nur dvhub-eebus in Go, eebus-go):
//       Laden(A) → Ladestrom je Phase (OPEV), Stopp → 0 A (eebus-go setzt Werte unter
//       dem Minimum auf den Standardwert der Box, meist 0 = Pause), Freigeben → aufheben.
//       Ladestand, Leistung und Strom kommen vom Auto (EVSOC/EVCEM).
//   • sonst über die Verbrauchsgrenze (LPC), die die Box für §14a ohnehin beherrscht:
//       Laden(A) → Grenze A × 230 V × Phasen, Stopp → 0 W, Freigeben → aufheben.
//       Die Grenze gilt zusammen mit einem §14a-Anteil — der kleinere (services/eebus).
// Wechselt DVhub von LPC auf OPEV, hebt es die eigene LPC-Grenze auf.
// Ungeprüft an einer echten EEBUS-Wallbox (Stand 20.10.2026).

import { isReadOnlyMode } from '../../read-only-guard.js';

const READ_ONLY = Object.freeze({ ok: false, error: 'read_only' });
const VOLTAGE_V = 230;
const CHARGING_MIN_W = 100;

export function createEebusWallboxAdapter(getSettings, deps = {}) {
  const ski = () => String(getSettings()?.ski || '').trim().toLowerCase();
  const phases = () => (Number(getSettings()?.phases) === 1 ? 1 : 3);
  const eebus = () => deps.getEebus?.() || null;
  const missing = () => ({ ok: false, error: 'EEBUS-Wallbox: EEBUS aus oder Gerät nicht gekoppelt (Integrationen → EEBUS)' });
  let lpcSet = false; // DVhub hat eine eigene LPC-Grenze gesetzt

  function opevEv(e) {
    const ev = e?.deviceInfo?.(ski())?.ev;
    return ev?.connected && ev.opev && typeof e.setEvCurrentLimits === 'function' ? ev : null;
  }
  async function lpc(e, w) {
    const r = await e.setEmsLimit(ski(), w);
    if (r?.ok !== false) lpcSet = w != null;
    return r;
  }
  async function control(amps, lpcW) {
    if (isReadOnlyMode()) return READ_ONLY;
    const e = eebus();
    if (!e?.setEmsLimit || !ski()) return missing();
    if (opevEv(e)) {
      if (lpcSet) { const r = await lpc(e, null); if (r?.ok === false) return r; }
      return e.setEvCurrentLimits(ski(), amps);
    }
    return lpc(e, lpcW);
  }

  return {
    type: 'eebus',
    isConfigured: () => Boolean(ski() && eebus()?.deviceInfo?.(ski())?.hasLpc),
    charge: (currentA) => {
      const a = Math.max(6, Math.floor(Number(currentA)));
      const max = opevEv(eebus())?.maxA;
      return control([Number.isFinite(max) && max >= 6 ? Math.min(a, max) : a], a * VOLTAGE_V * phases());
    },
    stop: () => control([0], 0),
    async release() {
      if (isReadOnlyMode()) return READ_ONLY;
      const e = eebus();
      if (!e?.setEmsLimit || !ski()) return missing();
      if (opevEv(e)) {
        const r = await e.setEvCurrentLimits(ski(), null);
        if (r?.ok === false || !lpcSet) return r;
      }
      return lpc(e, null);
    },
    async status() {
      const info = eebus()?.deviceInfo?.(ski());
      if (!info) return missing();
      if (!info.connected) return { ok: false, error: 'EEBUS-Wallbox nicht verbunden' };
      const ev = info.ev;
      if (ev) {
        const p = Number(ev.powerW ?? info.powerW);
        const amps = (ev.phasesA || []).filter(Number.isFinite);
        const charging = ev.connected && Number.isFinite(p) && p > CHARGING_MIN_W;
        return {
          ok: true,
          connected: ev.connected,
          charging,
          carState: charging ? 'charging' : ev.connected ? 'waiting' : null,
          powerW: Number.isFinite(p) ? p : null,
          currentA: amps.length ? Math.max(...amps) : null,
          vehicleSocPct: ev.connected && Number.isFinite(ev.soc) ? ev.soc : null,
          raw: { hasLpc: info.hasLpc, name: info.name, opev: ev.opev },
        };
      }
      const p = Number(info.powerW);
      const charging = Number.isFinite(p) ? p > CHARGING_MIN_W : null;
      return {
        ok: true,
        connected: charging === true ? true : null,
        charging: charging === true,
        carState: charging ? 'charging' : null,
        powerW: Number.isFinite(p) ? p : null,
        currentA: null,
        vehicleSocPct: null,
        raw: { hasLpc: info.hasLpc, name: info.name },
      };
    },
  };
}
