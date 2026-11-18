// services/gate/owner.js — Besitzregister je (Gerät, Punkt), deckungsgleich mit Rust `dvhub-gate/src/owner.rs` (A.3).
//
// Regeln (Node und Rust identisch):
//   * Besitz beginnt VOR dem Senden (`begin`): bricht der Aufrufer ab, gilt der Befehl als womöglich angekommen.
//   * `unknown` zählt als angekommen: der Wert bleibt in `uncertain[]`.
//   * `acked` macht den Wert zum bestätigten (`confirmed`) und leert `uncertain[]`.
//   * `rejected`/`notSent` (nachweislich nicht angekommen) ändert nichts: der vorher eingetragene Versuch fällt raus.
// `candidates()` = alle Werte, die gerade am Gerät stehen könnten (confirmed + uncertain[]) — Grundlage der
// Kandidatenmengen-Übernahme (VÄ-11) und der Besitzprüfung im Not-Halt-Durchgang.

/**
 * @typedef {number|boolean|string} Scalar
 * @typedef {{ confirmed: Scalar|null, uncertain: Scalar[], sinceMs: number, lastMs: number, source: string }} Owned
 */

const keyOf = (device, point) => `${device}\u0000${point}`;

export function createOwnerRegister() {
  /** @type {Map<string, Owned>} */
  const map = new Map();

  /** @returns {Owned|null} Kopie, damit Aufrufer das Register nicht verändern. */
  function get(device, point) {
    const e = map.get(keyOf(device, point));
    return e ? { ...e, uncertain: [...e.uncertain] } : null;
  }

  /** Alle Werte, die gerade am Gerät stehen könnten. */
  function candidates(device, point) {
    const e = map.get(keyOf(device, point));
    if (!e) return [];
    return e.confirmed !== null ? [e.confirmed, ...e.uncertain] : [...e.uncertain];
  }

  /** Vor dem Senden: Wert als unterwegs (unbestätigt) eintragen. */
  function begin(device, point, value, source, nowMs) {
    const k = keyOf(device, point);
    let e = map.get(k);
    if (!e) {
      e = { confirmed: null, uncertain: [], sinceMs: nowMs, lastMs: nowMs, source };
      map.set(k, e);
    }
    e.lastMs = nowMs;
    e.source = source;
    e.uncertain.push(value);
  }

  /** Nach dem Senden: Ausgang zum vorher mit `begin` eingetragenen Wert. */
  function finish(device, point, value, delivery) {
    const k = keyOf(device, point);
    const e = map.get(k);
    if (!e) return;
    if (delivery === 'acked') {
      e.confirmed = value;
      e.uncertain = [];
    } else if (delivery === 'rejected' || delivery === 'notSent') {
      const pos = e.uncertain.lastIndexOf(value);
      if (pos >= 0) e.uncertain.splice(pos, 1);
      if (e.confirmed === null && e.uncertain.length === 0) map.delete(k);
    }
    // 'unknown': bleibt in uncertain[] — zählt als angekommen.
  }

  /** DVhub gibt das Ziel ab (nach bestätigter Rücknahme, Endpunktwechsel, Wegfall der Richtlinie). */
  function release(device, point) {
    map.delete(keyOf(device, point));
  }

  function keys() {
    return [...map.keys()].map((k) => {
      const i = k.indexOf('\u0000');
      return [k.slice(0, i), k.slice(i + 1)];
    });
  }

  return { get, candidates, begin, finish, release, keys };
}
