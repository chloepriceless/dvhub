// services/wallbox/charger-status.js — Steck-/Ladezustand direkt von der Wallbox.
//
// Ist die Wallbox eine OpenEVSE oder ein go-e (cfg.wallbox.type), fragt DVhub
// sie selbst alle 15 s nach „Auto steckt / lädt / Leistung“. Vorher kam der
// Steckzustand NUR aus evcc — lief evcc nicht (oder sah diese Box nicht), war
// das Auto für DVhub „Steckzustand unbekannt“ und wurde bei EOS nicht
// angemeldet, obwohl es an der OpenEVSE hing und lud (prod 2026-10-01).
// Bei evcc als Wallbox bleibt evcc die Quelle (ev-soc.js).

export const CHARGER_STATUS_INTERVAL_MS = 15_000;
export const CHARGER_STATUS_MAX_AGE_MS = 90_000;
export const DIRECT_CHARGERS = Object.freeze(['openevse', 'goe', 'wattpilot']);

/**
 * @param {object} deps
 * @param {()=>object} deps.getCfg
 * @param {(type:string)=>object|null} deps.getAdapter  Adapter mit status() (services/wallbox/adapters.js)
 * @param {()=>number} [deps.now]
 */
export function createChargerStatusPoller({ getCfg, getAdapter, now = () => Date.now() }) {
  let timer = null;
  let running = false;
  let last = null; // { type, ok, connected, charging, powerW, currentA, vehicleSocPct, at, error }

  async function poll() {
    if (running) return last;
    const type = getCfg()?.wallbox?.type;
    if (!DIRECT_CHARGERS.includes(type)) { last = null; return null; }
    const adapter = getAdapter(type);
    if (!adapter || adapter.isConfigured?.() === false) { last = null; return null; }
    running = true;
    try {
      const st = await adapter.status();
      last = st?.ok
        ? {
          type, ok: true, at: now(), error: null,
          connected: st.connected === true,
          charging: st.charging === true,
          // go-e/Wattpilot unterscheiden „wartet auf Ladestart“ und „fertig“ (mypv-regulator.js).
          carState: typeof st.carState === 'string' ? st.carState : null,
          // Rohwerte der Box (z. B. frc beim go-e/Wattpilot → Lademodus, main-wallbox.js).
          raw: st.raw && typeof st.raw === 'object' ? st.raw : null,
          powerW: Number.isFinite(Number(st.powerW)) ? Math.round(Number(st.powerW)) : null,
          currentA: Number.isFinite(Number(st.currentA)) ? Number(st.currentA) : null,
          vehicleSocPct: Number.isFinite(Number(st.vehicleSocPct)) ? Number(st.vehicleSocPct) : null,
        }
        // Fehler: alten Zustand behalten (mit altem Zeitstempel → veraltet nach 90 s)
        : { ...(last || { type, ok: false }), type, error: st?.error || 'no_status', errorAt: now() };
    } catch (e) {
      last = { ...(last || { type, ok: false }), type, error: String(e?.message || e).slice(0, 120), errorAt: now() };
    } finally {
      running = false;
    }
    return last;
  }

  return {
    start() {
      if (timer) return;
      poll().catch(() => {});
      timer = setInterval(() => { poll().catch(() => {}); }, CHARGER_STATUS_INTERVAL_MS);
      timer.unref?.();
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    poll,
    /** Letzter GÜLTIGER Zustand, nicht älter als 90 s — sonst null. */
    fresh() {
      if (!last || !last.ok || !Number.isFinite(last.at)) return null;
      if (last.type !== getCfg()?.wallbox?.type) return null;
      return now() - last.at <= CHARGER_STATUS_MAX_AGE_MS ? last : null;
    },
    raw: () => last,
  };
}
