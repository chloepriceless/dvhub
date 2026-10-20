// services/wallbox/types.js — die eine Liste der Wallbox-Typen (2026-10-20).
//
// Vorher stand die Liste an fünf Stellen (main-wallbox, charger-status,
// eos-evcc-bridge, routes-api, §14a) — jede neue Wallbox musste überall
// nachgetragen werden. Jetzt nur hier; die anderen lesen sie.
//
// 'evcc' = über einen evcc-Ladepunkt; alle anderen sind direkt angebunden
// (Adapter in services/wallbox/adapters.js bzw. eigenen Dateien).

export const DIRECT_WALLBOX_TYPES = Object.freeze(['openevse', 'goe', 'wattpilot', 'victron', 'openwb', 'eebus', 'charx', 'warp']);
export const WALLBOX_TYPES = Object.freeze(['evcc', ...DIRECT_WALLBOX_TYPES]);

/** Ist die gewählte direkte Wallbox eingerichtet (Adresse bzw. GX vorhanden)? */
export function directWallboxConfigured(cfg) {
  const w = cfg?.wallbox || {};
  switch (w.type) {
    case 'openevse': return Boolean(w.openevse?.url);
    case 'goe': return Boolean(w.goe?.url);
    case 'wattpilot': return Boolean(w.wattpilot?.host);
    case 'victron': return Boolean(cfg?.victron?.host);
    case 'openwb': return Boolean(String(w.openwb?.host || '').trim());
    case 'charx': return Boolean(String(w.charx?.host || '').trim());
    case 'warp': return Boolean(String(w.warp?.host || '').trim());
    case 'eebus': return /^[0-9a-f]{40}$/i.test(String(w.eebus?.ski || '').trim());
    default: return false;
  }
}
