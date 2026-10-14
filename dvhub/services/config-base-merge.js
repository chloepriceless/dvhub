// services/config-base-merge.js — Speichern der Einstellungsseite als
// Dreiwege-Abgleich (2026-10-14).
//
// Die Einstellungsseite hält die ganze Konfiguration so, wie sie beim Öffnen
// war, und schickt sie beim Speichern vollständig zurück. Was die Box seitdem
// selbst geändert hat — Zeitplan-Regeln (von Hand, automatisch abgeschaltet,
// Börsenautomatik, Stop-SoC), Standard-Sollwerte vom Dashboard, Schalter
// anderer Wege —, sprang dadurch zurück. Die Seite schickt deshalb den Stand
// beim Öffnen als `base` mit, und je Pfad gilt:
//
//   Formular = base   → nicht angefasst, die Box behält ihren jetzigen Wert
//   Formular ≠ base   → im Formular geändert, das Formular gewinnt
//   (fehlt im Formular, stand in base → im Formular gelöscht)
//
// Objekte werden je Schlüssel abgeglichen, Listen als Ganzes. `current` ist
// die GESCHWÄRZTE Konfiguration der Box (wie GET /api/config sie liefert):
// So bleiben unangetastete Geheimnisse '***' und restoreRedacted setzt sie
// wie bisher ein — nie landet der echte Wert im Stärke-Check des Tokens.

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function merge(incoming, base, current) {
  if (same(incoming, base)) return clone(current);
  if (!isObject(incoming) || !isObject(base) || !isObject(current)) return clone(incoming);
  const out = {};
  for (const key of new Set([...Object.keys(current), ...Object.keys(base), ...Object.keys(incoming)])) {
    const v = merge(incoming[key], base[key], current[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/**
 * @param {object} incoming  Konfiguration aus dem Formular
 * @param {object} base      Stand beim Öffnen der Seite
 * @param {object} current   jetziger Stand der Box (geschwärzt)
 * @returns {object} zu speichernde Konfiguration
 */
export function mergeAgainstBase(incoming, base, current) {
  if (!isObject(incoming) || !isObject(base) || !isObject(current)) return incoming;
  return merge(incoming, base, current);
}
