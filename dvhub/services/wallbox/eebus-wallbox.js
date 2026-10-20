// services/wallbox/eebus-wallbox.js — EEBUS-Wallbox als Hauptwallbox (2026-10-20).
//
// Elli / VW ID. Charger, Cupra, Audi, Škoda, Porsche Wallbox, Kontron/Steca/
// ghostONE sprechen EEBUS. openeebus (DVhubs EEBUS-Stack) kennt die E-Auto-
// Abläufe (EVCC/OPEV/OSCEV) nicht — DVhub steuert die Box deshalb über die
// Verbrauchsgrenze (LPC), die sie für §14a ohnehin beherrscht:
//   Laden(A)   → Grenze A × 230 V × Phasen
//   Stopp      → Grenze 0 W (die Box pausiert)
//   Freigeben  → Grenze aufheben (die Box lädt nach eigener Einstellung)
// Die Grenze gilt zusammen mit einem §14a-Anteil — der kleinere (services/eebus).
// Messwert: Leistung, wenn die Box sie per MPC meldet. Ob ein Auto steckt, weiß
// DVhub nur, solange es lädt (sonst „unbekannt“).
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

  async function limit(w) {
    if (isReadOnlyMode()) return READ_ONLY;
    const e = eebus();
    if (!e?.setEmsLimit || !ski()) return missing();
    return e.setEmsLimit(ski(), w);
  }

  return {
    type: 'eebus',
    isConfigured: () => Boolean(ski() && eebus()?.deviceInfo?.(ski())?.hasLpc),
    charge: (currentA) => limit(Math.max(6, Math.floor(Number(currentA))) * VOLTAGE_V * phases()),
    stop: () => limit(0),
    release: () => limit(null),
    async status() {
      const info = eebus()?.deviceInfo?.(ski());
      if (!info) return missing();
      if (!info.connected) return { ok: false, error: 'EEBUS-Wallbox nicht verbunden' };
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
