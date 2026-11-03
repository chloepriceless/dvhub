// services/config-protected-keys.js — Einstellungen, die nicht über das
// allgemeine Speichern der Konfiguration geändert werden.
//
// installerPortal.* (Fernzugang + Freigaben), datenspende.* (Einwilligung),
// mobileLink.* (Handy-App, an die Schlüsseldatei der Box gebunden) und
// ortsnetz.* (Einwilligung) haben eigene Wege (/api/installer/settings,
// /api/datenspende/*, /api/ortsnetz/settings). Die Einstellungsseite schickt
// beim Speichern ihren beim Laden geklonten Entwurf der ganzen Konfiguration —
// ohne Schutz schaltet ein alter Entwurf einen inzwischen geänderten Schalter
// zurück.
//
// Drei Fälle:
//   Speichern (/api/config)            alle drei bleiben, wie die Box sie hat
//   Import, nur Einstellungen kopieren Fernzugang + Datenspende bleiben (sie
//                                      hängen an Kopplungen dieser Box),
//                                      Ortsnetz kommt aus der Datei
//   Import als Geräte-Tausch           alle drei kommen aus der Datei — die
//                                      Kopplungs-Dateien ziehen mit um, die Box
//                                      soll eins zu eins weiterlaufen
//                                      (eHive-Umzug 2026-10-03: Datenspende
//                                      und Ortsnetz standen danach auf aus)

//
// Dazu (Strix L-0006, 30.10.2026): licensing.* ist Lizenz-Infrastruktur
// (Keygen-Konto, Aktivierungs-Proxy, Node-Lock). Bis 30.10. ließ sich darüber
// per POST /api/config die Adresse umbiegen, an die DVhub den Lizenzschlüssel
// schickt. Diese Schlüssel ändert weder Speichern noch Import — auch kein
// Geräte-Tausch; nur wer die config.json auf der Box selbst bearbeitet.

//
// Dazu (Strix T-0001, 30.10.2026): support.relay (Relay des Support-Tunnels,
// geht vor relay.json) auf Pfad-Ebene — über /api/config ließ es sich auf einen
// fremden Server umbiegen. Speichern und Import ändern es nicht; beim
// Geräte-Tausch kommt es wie die Kopplungen aus der Datei. support.localUser
// und support.tunnel stellt der Kunde weiter selbst.

export const BOX_BOUND_KEYS = Object.freeze(['installerPortal', 'datenspende', 'mobileLink']);
export const BOX_BOUND_PATHS = Object.freeze([['support', 'relay']]);
export const LOCKED_KEYS = Object.freeze(['licensing']);
export const OWN_ROUTE_KEYS = Object.freeze([...BOX_BOUND_KEYS, 'ortsnetz', ...LOCKED_KEYS]);

// Über den Support-Tunnel (Gesamtprüfung 1.0.9) bleiben zusätzlich zu
// apiToken alle Einstellungen, die Zugänge oder Freigaben erteilen, wie die
// Box sie hat — Speichern und Import gleichermaßen. Der Support richtet die
// Anlage ein, gibt sie aber nicht frei.
export const SUPPORT_TUNNEL_KEPT_ROOTS = Object.freeze([
  'support', 'security', 'allowedHosts', 'corsAllowedOrigins', 'trustProxy', 'trustedProxyIps',
  'vpn', 'ortsnetz',
]);
export const SUPPORT_TUNNEL_KEPT_PATHS = Object.freeze([['eebus', 'trusted']]);

const clone = (v) => JSON.parse(JSON.stringify(v));
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Setzt die geschützten Schlüssel in `incoming` auf den Stand der Box und gibt
 * zurück, was die Datei mitgebracht hat (für einen späteren Geräte-Tausch).
 * @param {object} incoming  eingehende Konfiguration (wird verändert)
 * @param {object|undefined} current  gespeicherte Konfiguration der Box
 * @param {{ isImport?: boolean }} [opts]
 * @returns {object} mitgebrachte Werte je Schlüssel
 */
export function protectOwnRouteKeys(incoming, current, { isImport = false } = {}) {
  const carried = {};
  for (const key of OWN_ROUTE_KEYS) {
    const locked = LOCKED_KEYS.includes(key);
    if (isImport && !locked && isObject(incoming[key])) carried[key] = clone(incoming[key]);
    if (isImport && !locked && !BOX_BOUND_KEYS.includes(key)) continue;
    const cur = current?.[key];
    if (cur === undefined) delete incoming[key];
    else incoming[key] = clone(cur);
  }
  for (const [parent, child] of BOX_BOUND_PATHS) {
    const dotted = `${parent}.${child}`;
    if (isImport && isObject(incoming[parent]) && incoming[parent][child] !== undefined) carried[dotted] = clone(incoming[parent][child]);
    const cur = current?.[parent]?.[child];
    if (cur === undefined) {
      if (isObject(incoming[parent])) delete incoming[parent][child];
    } else {
      if (!isObject(incoming[parent])) incoming[parent] = {};
      incoming[parent][child] = clone(cur);
    }
  }
  return carried;
}

/** Geräte-Tausch: die an die Box gebundenen Schalter aus der Datei übernehmen. */
export function applyCarriedKeys(incoming, carried) {
  const applied = [];
  for (const key of BOX_BOUND_KEYS) {
    if (!isObject(carried?.[key])) continue;
    incoming[key] = clone(carried[key]);
    applied.push(key);
  }
  for (const [parent, child] of BOX_BOUND_PATHS) {
    const dotted = `${parent}.${child}`;
    if (carried?.[dotted] === undefined) continue;
    if (!isObject(incoming[parent])) incoming[parent] = {};
    incoming[parent][child] = clone(carried[dotted]);
    applied.push(dotted);
  }
  return applied;
}
