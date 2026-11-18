// services/gate/owner.js — Besitzregister je (Gerät, Punkt), nach Rust `dvhub-gate/src/owner.rs` (A.3).
//
// Regeln (Node und Rust identisch):
//   * Besitz beginnt VOR dem Senden (`begin`): bricht der Aufrufer ab, gilt der Befehl als womöglich angekommen.
//   * `unknown` zählt als angekommen: der Wert bleibt Kandidat (`uncertain[]`).
//   * `acked` macht den Wert zum bestätigten (`confirmed`).
//   * `rejected`/`notSent` (nachweislich nicht angekommen) ändert nichts: der Versuch fällt raus.
// `candidates()` = alle Werte, die gerade am Gerät stehen könnten (confirmed + uncertain[] + noch laufende Versuche)
// — Grundlage der Kandidatenmengen-Übernahme (VÄ-11) und der Besitzprüfung im Not-Halt-Durchgang.
//
// Abweichung von Rust (dort alles unter einer Sperre, also nie zwei Versuche zugleich): Node lässt Legacy-Versuche
// an denselben Punkt gleichzeitig zu. Jeder Versuch bekommt deshalb eine fortlaufende Nummer; ein `acked` ersetzt
// nur Versuche, die VOR ihm begonnen haben. Später begonnene bleiben Kandidaten (Codex 7a183a18 P1).

/**
 * @typedef {number|boolean|string} Scalar
 * @typedef {{ confirmed: Scalar|null, uncertain: Scalar[], inflight: Scalar[], sinceMs: number, lastMs: number, source: string }} Owned
 */

const keyOf = (device, point) => `${device}\u0000${point}`;

export function createOwnerRegister() {
  /** @type {Map<string, { confirmed: { value: Scalar, seq: number }|null, uncertain: { value: Scalar, seq: number }[],
   *   inflight: Map<number, Scalar>, sinceMs: number, lastMs: number, source: string }>} */
  const map = new Map();
  let seq = 0;

  /** @returns {Owned|null} Kopie, damit Aufrufer das Register nicht verändern. */
  function get(device, point) {
    const e = map.get(keyOf(device, point));
    if (!e) return null;
    return {
      confirmed: e.confirmed ? e.confirmed.value : null,
      uncertain: e.uncertain.map((u) => u.value),
      inflight: [...e.inflight.values()],
      sinceMs: e.sinceMs,
      lastMs: e.lastMs,
      source: e.source,
    };
  }

  /** Alle Werte, die gerade am Gerät stehen könnten. */
  function candidates(device, point) {
    const o = get(device, point);
    if (!o) return [];
    return [...(o.confirmed !== null ? [o.confirmed] : []), ...o.uncertain, ...o.inflight];
  }

  /** Vor dem Senden: Versuch eintragen. @returns {number} Kennung des Versuchs für `finish`. */
  function begin(device, point, value, source, nowMs) {
    const k = keyOf(device, point);
    let e = map.get(k);
    if (!e) {
      e = { confirmed: null, uncertain: [], inflight: new Map(), sinceMs: nowMs, lastMs: nowMs, source };
      map.set(k, e);
    }
    e.lastMs = nowMs;
    e.source = source;
    seq += 1;
    e.inflight.set(seq, value);
    return seq;
  }

  /** Nach dem Senden: Ausgang des Versuchs `token`. */
  function finish(device, point, token, delivery) {
    const k = keyOf(device, point);
    const e = map.get(k);
    if (!e || !e.inflight.has(token)) return;
    const value = e.inflight.get(token);
    e.inflight.delete(token);
    if (delivery === 'acked') {
      if (!e.confirmed || token > e.confirmed.seq) e.confirmed = { value, seq: token };
      // Was vor dem bestätigten Write begann, ist überschrieben; später Begonnenes bleibt Kandidat.
      e.uncertain = e.uncertain.filter((u) => u.seq > e.confirmed.seq);
    } else if (delivery === 'unknown') {
      if (!e.confirmed || token > e.confirmed.seq) e.uncertain.push({ value, seq: token });
    }
    // 'rejected' / 'notSent': nachweislich nicht angekommen — nur der Versuch fällt raus.
    if (!e.confirmed && e.uncertain.length === 0 && e.inflight.size === 0) map.delete(k);
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
