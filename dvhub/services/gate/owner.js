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
// an denselben Punkt gleichzeitig zu, und in welcher Reihenfolge überlappende Versuche am Gerät wirken, weiß das Tor
// nicht. Ein `acked` ersetzt deshalb nur Versuche, die schon ABGESCHLOSSEN waren, als er begann; überlappende bleiben
// Kandidaten — auch ein vorher bestätigter Wert (Codex 7a183a18 P1, 710d8f36 P1). Nacheinander (wie in Rust) ist das
// dieselbe Regel wie dort.
//
// Ohne Quittung (MQTT QoS 0) endet jeder Versuch `unknown`. Damit die Kandidaten nicht ohne Ende wachsen, steht jeder
// Wert höchstens einmal in `uncertain[]` (der jüngste Versuch zählt), und mehr als MAX_UNCERTAIN verschiedene Werte
// werden auf die jüngsten gekürzt — mit `truncated: true`: die Kandidatenmenge ist dann ausdrücklich unvollständig
// (Codex 710d8f36 P2). Ein später begonnener, quittierter Write hebt die Kürzung wieder auf.

/**
 * @typedef {number|boolean|string} Scalar
 * @typedef {{ confirmed: Scalar|null, uncertain: Scalar[], inflight: Scalar[], truncated: boolean,
 *             sinceMs: number, lastMs: number, source: string }} Owned
 */

export const MAX_UNCERTAIN = 32;

const keyOf = (device, point) => `${device}\u0000${point}`;

export function createOwnerRegister() {
  /**
   * Versuch: `begin`/`settle` sind Zeitpunkte einer gemeinsamen Ereignisuhr (Beginn bzw. Ausgang).
   * @type {Map<string, { confirmed: { value: Scalar, begin: number, settle: number }|null,
   *   uncertain: { value: Scalar, begin: number, settle: number }[], inflight: Map<number, { value: Scalar, begin: number }>,
   *   truncatedUpTo: number, sinceMs: number, lastMs: number, source: string }>}
   */
  const map = new Map();
  let clock = 0;
  let tokens = 0;

  /** @returns {Owned|null} Kopie, damit Aufrufer das Register nicht verändern. */
  function get(device, point) {
    const e = map.get(keyOf(device, point));
    if (!e) return null;
    return {
      confirmed: e.confirmed ? e.confirmed.value : null,
      uncertain: e.uncertain.map((u) => u.value),
      inflight: [...e.inflight.values()].map((a) => a.value),
      truncated: e.truncatedUpTo >= 0,
      sinceMs: e.sinceMs,
      lastMs: e.lastMs,
      source: e.source,
    };
  }

  /** Alle Werte, die gerade am Gerät stehen könnten (bei `truncated` nicht vollständig). */
  function candidates(device, point) {
    const o = get(device, point);
    if (!o) return [];
    return [...(o.confirmed !== null ? [o.confirmed] : []), ...o.uncertain, ...o.inflight];
  }

  /** Je Wert nur der jüngste Versuch; höchstens MAX_UNCERTAIN Werte, sonst kürzen und vermerken. */
  function compact(e, list) {
    const byValue = new Map();
    for (const u of list) {
      const have = byValue.get(u.value);
      if (!have || u.settle > have.settle) byValue.set(u.value, u);
    }
    const sorted = [...byValue.values()].sort((a, b) => b.settle - a.settle);
    for (const dropped of sorted.slice(MAX_UNCERTAIN)) e.truncatedUpTo = Math.max(e.truncatedUpTo, dropped.settle);
    e.uncertain = sorted.slice(0, MAX_UNCERTAIN).sort((a, b) => a.settle - b.settle);
  }

  /** Vor dem Senden: Versuch eintragen. @returns {number} Kennung des Versuchs für `finish`. */
  function begin(device, point, value, source, nowMs) {
    const k = keyOf(device, point);
    let e = map.get(k);
    if (!e) {
      e = { confirmed: null, uncertain: [], inflight: new Map(), truncatedUpTo: -1, sinceMs: nowMs, lastMs: nowMs, source };
      map.set(k, e);
    }
    e.lastMs = nowMs;
    e.source = source;
    clock += 1;
    tokens += 1;
    e.inflight.set(tokens, { value, begin: clock });
    return tokens;
  }

  /** Nach dem Senden: Ausgang des Versuchs `token`. */
  function finish(device, point, token, delivery) {
    const k = keyOf(device, point);
    const e = map.get(k);
    if (!e || !e.inflight.has(token)) return;
    const a = e.inflight.get(token);
    e.inflight.delete(token);
    clock += 1;
    const rec = { value: a.value, begin: a.begin, settle: clock };
    if (delivery === 'acked') {
      // Überlappt hat, was noch lief, als dieser Write begann (Ausgang danach) — dessen Wert kann danach gewirkt haben.
      // Ein Kandidat mit demselben Wert wie der bestätigte bringt keine Unsicherheit.
      const overlapped = (x) => x.settle > rec.begin && x.value !== rec.value;
      const keep = e.uncertain.filter(overlapped);
      if (e.confirmed && overlapped(e.confirmed)) keep.push(e.confirmed);
      e.confirmed = rec;
      if (e.truncatedUpTo < rec.begin) e.truncatedUpTo = -1; // alles Gekürzte war vorher abgeschlossen → überholt
      compact(e, keep);
    } else if (delivery === 'unknown') {
      // Immer festhalten, auch beim bestätigten Wert: überholt ein überlappender ACK später den bestätigten Wert,
      // kann dieser Versuch danach gewirkt haben — sein Zeitpunkt zählt (Codex 5dda7ee7 P1).
      compact(e, [...e.uncertain, rec]);
    }
    // 'rejected' / 'notSent': nachweislich nicht angekommen — nur der Versuch fällt raus.
    if (!e.confirmed && e.uncertain.length === 0 && e.inflight.size === 0 && e.truncatedUpTo < 0) map.delete(k);
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
