// services/wallbox/adapter-cache.js — ein Wallbox-Adapter je Typ und Einstellung (2026-10-20).
//
// Adapter halten Zustand (Lebenszeichen, gemerkter Modus, Schreib-Entprellung). Darum
// teilen sich Statusabfrage, Steuerung und EOS-Brücke einen Adapter; ändern sich die
// Einstellungen des Typs, entsteht ein neuer (alter Zustand gilt dann nicht mehr).
export function createWallboxAdapterCache(build, settingsOf) {
  const cache = new Map();
  return {
    get(type) {
      if (!type) return null;
      let key;
      try { key = JSON.stringify(settingsOf(type) ?? null); } catch { key = String(Math.random()); }
      const hit = cache.get(type);
      if (hit && hit.key === key) return hit.adapter;
      const adapter = build(type);
      cache.set(type, { key, adapter });
      return adapter;
    },
  };
}
