// services/wallbox/types.js — die eine Liste der Wallbox-Typen (2026-10-20).
//
// Vorher stand die Liste an fünf Stellen (main-wallbox, charger-status,
// eos-evcc-bridge, routes-api, §14a) — jede neue Wallbox musste überall
// nachgetragen werden. Jetzt nur hier; die anderen lesen sie.
//
// 'evcc' = über einen evcc-Ladepunkt; alle anderen sind direkt angebunden
// (Adapter in services/wallbox/adapters.js bzw. eigenen Dateien).

export const DIRECT_WALLBOX_TYPES = Object.freeze(['openevse', 'goe', 'wattpilot', 'victron', 'openwb', 'eebus', 'charx', 'warp', 'ocpp', 'keba', 'heidelberg', 'bender', 'salia', 'peblar', 'nrgkick', 'abl', 'smartwb', 'nexblue', 'smartevse', 'em2go', 'daheimladen', 'phoenix']);
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
    case 'phoenix': return Boolean(String(w.phoenix?.host || '').trim());
    case 'em2go': return Boolean(String(w.em2go?.host || '').trim());
    case 'daheimladen': return Boolean(String(w.daheimladen?.host || '').trim());
    case 'smartevse': return Boolean(String(w.smartevse?.host || '').trim());
    case 'nexblue': return Boolean(String(w.nexblue?.host || '').trim());
    case 'smartwb': return Boolean(String(w.smartwb?.host || '').trim());
    case 'abl': return Boolean(String(w.abl?.host || '').trim());
    case 'nrgkick': return Boolean(String(w.nrgkick?.host || '').trim());
    case 'peblar': return Boolean(String(w.peblar?.host || '').trim());
    case 'salia': return Boolean(String(w.salia?.host || '').trim());
    case 'bender': return Boolean(String(w.bender?.host || '').trim());
    case 'heidelberg': return Boolean(String(w.heidelberg?.host || '').trim());
    case 'keba': return Boolean(String(w.keba?.host || '').trim());
    case 'charx': return Boolean(String(w.charx?.host || '').trim());
    case 'warp': return Boolean(String(w.warp?.host || '').trim());
    case 'ocpp': return cfg?.ocpp?.enabled === true;
    case 'eebus': return /^[0-9a-f]{40}$/i.test(String(w.eebus?.ski || '').trim());
    default: return false;
  }
}
