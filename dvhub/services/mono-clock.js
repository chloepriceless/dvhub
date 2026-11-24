// services/mono-clock.js — monotone Zeitquelle für Zeitgeber (A23 b, Christin 23.11.2026).
//
// Abstände (Fristen, Takte, Frische, Wiederholungen) misst DVhub mit einer monotonen Uhr: ein Sprung der Wanduhr
// (NTP, Hand-Einstellung, Board ohne Hardware-Uhr nach dem Start) darf sie weder verlängern noch verkürzen. Die
// Wanduhr (Date.now) bleibt für alles, was ein Mensch liest oder was gespeichert wird: Status, Protokoll, Anzeige.
// Vorbild: services/inverter/sungrow.js (A7/A17/A21/A22) — dort dieselbe Quelle (performance.now) lokal.
//
// Werkzeuge:
//   monoNow()        — Laufzeit des Prozesses in ms (performance.now), nur für Abstände innerhalb EINES Prozesses.
//   pickMonoNow()    — eingespielte Uhren (Tests) übernehmen wie in sungrow.js: ohne eigene monotone Uhr misst eine
//                      eingespielte Wanduhr auch die Abstände; die echte Date.now bleibt dabei außen vor.
//   createStampAge() — Zeitstempel von außen (Poller, Messwerte mit Wanduhr-ts): am Übergabepunkt die Empfangszeit
//                      monoton merken. Neu gesehener Stempel → Alter einmal aus der Wanduhr (nie negativ), danach
//                      wächst es monoton weiter, solange derselbe Stempel steht.
//   markMono()/monoAgeOf() — Erzeuger im selben Prozess heften einem veröffentlichten Objekt seine monotone Zeit an
//                      (WeakMap, nicht im JSON sichtbar); Verbraucher lesen dessen Alter statt des Wanduhr-Stempels.
//   stampMono()/monoStampOf()/monoStampAge() — A24: Erzeuger (Poller, MQTT-Eingang, Zweit-WR, Schreibpfad) stempeln
//                      einen Wanduhr-Stempel zusätzlich monoton; Verbraucher prüfen Frische und Reihenfolge damit
//                      (stampAfter), Fristen mit monoDeadlinePassed. Unsichtbar, an Wert und Uhr gebunden.
//   bootStamp()/readBootClock() — prozessübergreifend (Box-Watchdog): Laufzeit seit Systemstart (Linux /proc/uptime,
//                      CLOCK_BOOTTIME, läuft auch im Ruhezustand weiter) plus Start-Kennung (boot_id). Ohne /proc
//                      (macOS, Tests) null bzw. {} — dann gilt der bisherige Wanduhr-Vergleich.

import fs from 'node:fs';
import { performance } from 'node:perf_hooks';

/** Monotone Prozess-Uhr in ms. Nur Differenzen sind aussagekräftig. */
export const monoNow = () => performance.now();

/**
 * Monotone Uhr für einen Dienst wählen: eine ausdrücklich übergebene gewinnt; sonst eine eingespielte Uhr (Tests),
 * damit deren Zeitreise weiter wirkt; sonst monoNow. Die echte Date.now gilt nicht als eingespielt.
 * @param {(() => number)|null|undefined} monoNowArg
 * @param {(() => number)|null|undefined} nowArg
 * @returns {() => number}
 */
export function pickMonoNow(monoNowArg, nowArg) {
  if (typeof monoNowArg === 'function') return monoNowArg;
  if (typeof nowArg === 'function' && nowArg !== Date.now) return nowArg;
  return monoNow;
}

/**
 * Alter von Wanduhr-Stempeln, die von außen kommen, monoton weitergeführt. Je Schlüssel wird der zuletzt gesehene
 * Stempel gemerkt; ändert er sich, gilt er als empfangen vor max(0, Wanduhr − Stempel) — nach einem Rücksprung
 * also „jetzt“ statt in der Zukunft, nach einem Sprung vorwärts einmal zu alt (bis zum nächsten Stempel). Danach
 * zählt nur die monotone Uhr. Ungültiger Stempel → Alter Infinity, receivedMono null.
 * @param {{ now?: () => number, monoNow?: () => number }} [clocks]
 */
export function createStampAge({ now = Date.now, monoNow: mono = monoNow } = {}) {
  const seen = new Map();
  // producerMono (A24): monotone Zeit des Erzeugers (monoStampOf mit derselben Uhr) — dann gilt sie statt der Schätzung.
  function receivedMono(key, stamp, producerMono = null) {
    if (stamp == null || stamp === '') return null;
    const s = Number(stamp);
    if (!Number.isFinite(s)) return null;
    let e = seen.get(key);
    if (producerMono != null && Number.isFinite(Number(producerMono))) {
      if (!e || e.stamp !== s || e.mono !== Number(producerMono)) {
        e = { stamp: s, mono: Number(producerMono) };
        seen.set(key, e);
      }
      return e.mono;
    }
    if (!e || e.stamp !== s) {
      e = { stamp: s, mono: mono() - Math.max(0, now() - s) };
      seen.set(key, e);
    }
    return e.mono;
  }
  function ageMs(key, stamp, producerMono = null) {
    const r = receivedMono(key, stamp, producerMono);
    return r == null ? Infinity : mono() - r;
  }
  return { ageMs, receivedMono, forget: (key) => seen.delete(key) };
}

const monoMarks = new WeakMap();
/**
 * Erzeuger: dem veröffentlichten Objekt seine monotone Zeit samt Uhr anheften (unsichtbar im JSON). Die Uhr reist mit,
 * damit ein Verbraucher das Alter mit derselben Uhr misst (eingespielte Test-Uhren eingeschlossen). Gibt obj zurück.
 */
export function markMono(obj, clock = monoNow) {
  if (obj && typeof obj === 'object' && typeof clock === 'function') {
    const m = clock();
    if (Number.isFinite(m)) monoMarks.set(obj, { m, clock });
  }
  return obj;
}
/** Verbraucher: monotones Alter des Objekts in ms seit markMono, oder null (fremder Erzeuger, Test-Objekt). */
export function monoAgeOf(obj) {
  const e = obj && typeof obj === 'object' ? monoMarks.get(obj) : undefined;
  return e ? e.clock() - e.m : null;
}

// --- Monotone Stempel beim Erzeuger (A24, Christin 23.11.2026) -------------------------------------------------------
// Ein Messwert bekommt seinen Zeitstempel bisher nur als Wanduhr (fieldUpdatedAt, meter.updatedAt, …). Verbraucher, die
// „frisch?“ oder „kam der Messwert NACH meinem Schreiben?“ prüfen, mussten die Empfangszeit daraus schätzen — nach einem
// Rücksprung der Systemzeit kann so ein Wert von VOR dem Schreiben als neuer gelten (Codex 32af6fd2/4fd0803c P1).
// stampMono() heftet dem Wanduhr-Stempel container[key] beim Erzeuger die monotone Zeit an, monoStampOf() liest sie.
//   • Unsichtbar: WeakMap am Behälter, nie im JSON, nie in der Datenbank, nie über IPC zum Web-Prozess — performance.now
//     beginnt in jedem Prozess neu, ein Vergleich über Prozess- oder Neustartgrenzen wäre sinnlos.
//   • An den Wanduhr-Wert gebunden: die Marke gilt nur, solange container[key] noch genau den Wert hat, den der Erzeuger
//     gestempelt hat. Setzt ein anderer Pfad den Stempel ohne Marke neu oder löscht ihn, gilt sie nicht mehr — der
//     Verbraucher fällt auf das bisherige Verhalten (Wanduhr) zurück, nie auf eine veraltete monotone Zeit.
//   • An die Uhr gebunden: nur ein Verbraucher mit DERSELBEN monotonen Uhr (Funktions-Identität) bekommt die Marke. Im
//     Betrieb ist das überall monoNow; Tests mit eingespielter Uhr bekommen Marken nur, wenn Erzeuger und Verbraucher
//     dieselbe Uhr haben — sonst gilt die Wanduhr wie bisher.
const stampMarks = new WeakMap();

/**
 * Erzeuger: den eben gesetzten Wanduhr-Stempel container[key] zusätzlich monoton merken.
 * @param {object} container  z. B. state.victron.fieldUpdatedAt, state.meter, state.sungrowSecond
 * @param {string} key
 * @param {{ clock?: () => number, at?: number, wallNow?: number }} [opts]
 *   at      — monotone Zeit, wenn sie früher gemessen wurde (MQTT: Empfang der Nachricht); sonst clock()
 *   wallNow — Wanduhr beim Stempeln (für Fristen: container[key] ist dann ein Ablaufzeitpunkt, s. monoDeadlinePassed)
 * @returns {number|null} die gemerkte monotone Zeit
 */
export function stampMono(container, key, { clock = monoNow, at, wallNow } = {}) {
  if (!container || typeof container !== 'object' || typeof clock !== 'function') return null;
  const wall = container[key];
  if (wall == null || !Number.isFinite(Number(wall))) { clearMonoStamp(container, key); return null; }
  const m = at != null ? Number(at) : clock();
  if (!Number.isFinite(m)) { clearMonoStamp(container, key); return null; }
  let marks = stampMarks.get(container);
  if (!marks) { marks = new Map(); stampMarks.set(container, marks); }
  marks.set(key, { m, clock, wall: Number(wall), wallNow: Number.isFinite(Number(wallNow)) ? Number(wallNow) : null });
  return m;
}

/** Marke vergessen (z. B. wenn der Erzeuger den Stempel löscht). */
export function clearMonoStamp(container, key) {
  if (container && typeof container === 'object') stampMarks.get(container)?.delete(key);
}

function validMark(container, key, clock) {
  if (!container || typeof container !== 'object') return null;
  const e = stampMarks.get(container)?.get(key);
  if (!e || e.clock !== clock) return null;
  const wall = container[key];
  if (wall == null || Number(wall) !== e.wall) return null;
  return e;
}

/**
 * Verbraucher: monotone Zeit zum Stempel container[key] — oder null (kein Erzeuger-Stempel, andere Uhr, Stempel
 * inzwischen ohne Marke überschrieben). Dann gilt das bisherige Wanduhr-Verhalten.
 */
export function monoStampOf(container, key, clock = monoNow) {
  const e = validMark(container, key, clock);
  return e ? e.m : null;
}

/** Verbraucher: monotones Alter des Stempels container[key] in ms, oder null wie monoStampOf. */
export function monoStampAge(container, key, clock = monoNow) {
  const m = monoStampOf(container, key, clock);
  return m == null ? null : clock() - m;
}

/**
 * Verbraucher einer Frist: container[key] ist ein Ablaufzeitpunkt (Wanduhr), beim Setzen mit wallNow gestempelt. Die
 * Restzeit von damals läuft monoton ab. true/false = abgelaufen ja/nein, null = keine passende Marke (dann Wanduhr).
 */
export function monoDeadlinePassed(container, key, clock = monoNow) {
  const e = validMark(container, key, clock);
  if (!e || e.wallNow == null) return null;
  return clock() - e.m > e.wall - e.wallNow;
}

/**
 * Reihenfolge zweier Stempel: liegt a nach b? Beide monoton (gleiche Uhr), wenn beide da sind — sonst beide Wanduhr.
 * Nie gemischt: eine monotone und eine Wanduhr-Zeit sind nicht vergleichbar.
 * @param {{ wall: number, mono: number|null }} a
 * @param {{ wall: number, mono: number|null }} b
 */
export function stampAfter(a, b) {
  if (a?.mono != null && b?.mono != null) return a.mono > b.mono;
  return Number(a?.wall) > Number(b?.wall);
}

const UPTIME_PATH = '/proc/uptime';
const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';
let cachedBootId;

/**
 * Laufzeit seit Systemstart (ms, /proc/uptime = CLOCK_BOOTTIME) und Start-Kennung. null ohne /proc (macOS) oder bei
 * unlesbaren Werten. Die Kennung wechselt mit jedem Systemstart; zusammen mit der Laufzeit ergibt das eine Zeit, die
 * zwei Prozesse (DVhub und der Box-Watchdog) vergleichen können und die kein Sprung der Wanduhr verschiebt.
 * @param {{ fsImpl?: typeof fs, uptimePath?: string, bootIdPath?: string }} [opts]
 * @returns {{ bootMs: number, bootId: string }|null}
 */
export function readBootClock({ fsImpl = fs, uptimePath = UPTIME_PATH, bootIdPath = BOOT_ID_PATH } = {}) {
  try {
    const up = Number(String(fsImpl.readFileSync(uptimePath, 'utf8')).trim().split(/\s+/)[0]);
    if (!Number.isFinite(up) || up < 0) return null;
    const useCache = fsImpl === fs && bootIdPath === BOOT_ID_PATH;
    let bootId = useCache ? cachedBootId : undefined;
    if (bootId === undefined) {
      bootId = String(fsImpl.readFileSync(bootIdPath, 'utf8')).trim();
      if (useCache) cachedBootId = bootId;
    }
    if (!bootId) return null;
    return { bootMs: Math.round(up * 1000), bootId };
  } catch { return null; }
}

/** Felder für eine Herzschlag-Datei: { bootMs, bootId } oder {} ohne /proc. */
export function bootStamp(read = readBootClock) {
  const b = read();
  return b ? { bootMs: b.bootMs, bootId: b.bootId } : {};
}
