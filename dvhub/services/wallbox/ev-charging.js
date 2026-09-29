// services/wallbox/ev-charging.js -- „Lädt das E-Auto gerade?“ für Verbraucher,
// die der Wallbox Vorrang lassen sollen (Heizstab: plan.pauseWhileEvCharging).
//
// Quelle ist die eingestellte Wallbox (cfg.wallbox.type, wie in der EOS-Brücke):
//   - evcc (Standard): irgendein Ladepunkt lädt — aus dem zwischengespeicherten
//     evcc-Poll, kein zusätzlicher HTTP-Aufruf. Wie evcc-integration.anyCharging
//     zählt ein Ladepunkt erst ab >100 W (Handshake-/Abstecken-Phantome).
//   - openevse / goe: status() des Adapters (ein HTTP-Aufruf je Frage).
// Ergebnis: true | false | null (unbekannt — keine Wallbox eingerichtet, keine
// Antwort, evcc-Daten veraltet). Der Aufrufer entscheidet, was „unbekannt“ heißt.

export const EV_CHARGING_MIN_W = 100;
const EVCC_STALE_MS = 3 * 60_000;

/**
 * @param {object} deps
 * @param {()=>object} deps.getCfg
 * @param {object} [deps.evccIntegration]            getStatus() → { url, lastPolledAt, loadpoints }
 * @param {(type:string)=>object|null} [deps.getAdapter]  Adapter mit status() für openevse/goe
 * @param {()=>number} [deps.now]
 * @returns {()=>Promise<boolean|null>}
 */
export function createEvChargingProbe({ getCfg, evccIntegration, getAdapter, now = () => Date.now() }) {
  return async function isEvCharging() {
    const type = getCfg()?.wallbox?.type;
    if (type === 'openevse' || type === 'goe') {
      const adapter = getAdapter?.(type);
      if (!adapter || adapter.isConfigured?.() === false) return null;
      let st;
      try { st = await adapter.status(); } catch { return null; }
      if (!st?.ok) return null;
      if (st.charging !== true) return false;
      // Leistung unbekannt → dem charging-Flag glauben.
      return st.powerW == null || Number(st.powerW) > EV_CHARGING_MIN_W;
    }
    const st = evccIntegration?.getStatus?.();
    if (!st?.url) return null;
    if (!st.lastPolledAt || now() - Number(st.lastPolledAt) > EVCC_STALE_MS) return null;
    const lps = Array.isArray(st.loadpoints) ? st.loadpoints : [];
    return lps.some((lp) => lp?.charging === true && Number(lp.chargePowerW) > EV_CHARGING_MIN_W);
  };
}
