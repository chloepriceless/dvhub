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
//   markMono()/monoOf() — Erzeuger im selben Prozess heften einem veröffentlichten Objekt seine monotone Zeit an
//                      (WeakMap, nicht im JSON sichtbar); Verbraucher lesen sie statt des Wanduhr-Stempels.
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
  function receivedMono(key, stamp) {
    if (stamp == null || stamp === '') return null;
    const s = Number(stamp);
    if (!Number.isFinite(s) || s <= 0) return null;
    let e = seen.get(key);
    if (!e || e.stamp !== s) {
      e = { stamp: s, mono: mono() - Math.max(0, now() - s) };
      seen.set(key, e);
    }
    return e.mono;
  }
  function ageMs(key, stamp) {
    const r = receivedMono(key, stamp);
    return r == null ? Infinity : mono() - r;
  }
  return { ageMs, receivedMono, forget: (key) => seen.delete(key) };
}

const monoMarks = new WeakMap();
/** Erzeuger: dem veröffentlichten Objekt seine monotone Zeit anheften (unsichtbar im JSON). Gibt obj zurück. */
export function markMono(obj, m = monoNow()) {
  if (obj && typeof obj === 'object' && Number.isFinite(m)) monoMarks.set(obj, m);
  return obj;
}
/** Verbraucher: angeheftete monotone Zeit des Objekts oder null (fremder Erzeuger, Test-Objekt). */
export function monoOf(obj) {
  return obj && typeof obj === 'object' && monoMarks.has(obj) ? monoMarks.get(obj) : null;
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
