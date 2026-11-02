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

export const BOX_BOUND_KEYS = Object.freeze(['installerPortal', 'datenspende', 'mobileLink']);
export const LOCKED_KEYS = Object.freeze(['licensing']);
export const OWN_ROUTE_KEYS = Object.freeze([...BOX_BOUND_KEYS, 'ortsnetz', ...LOCKED_KEYS]);

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
  return applied;
}
