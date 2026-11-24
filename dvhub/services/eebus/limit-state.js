// services/eebus/limit-state.js — Zustandsmaschine der Netzseite (EEBUS LPC / LPP).
//
// DVhub ist gegenüber der Steuerbox des Netzbetreibers (§14a EnWG, Energy
// Guard) das „Controllable System“. Die Anwendungsfälle „Limitation of Power
// Consumption“ (LPC) und „… Production“ (LPP) schreiben dafür fünf Zustände vor:
//
//   init                  nach dem Start, bis die Steuerbox sich meldet
//                         (spätestens nach 120 s ohne Heartbeat → failsafe);
//                         eine gespeicherte, noch gültige Grenze gilt hier schon
//   unlimited_controlled  Steuerbox verbunden, keine aktive Grenze
//   limited               aktive Grenze, bis Ablauf ihrer Dauer oder Aufhebung
//   failsafe              Heartbeat weg → Failsafe-Grenze, mindestens für die
//                         Failsafe-Dauer (2–24 h); eine neue Grenze der wieder
//                         verbundenen Steuerbox beendet ihn vorher
//   unlimited_autonomous  Failsafe-Dauer abgelaufen, Steuerbox weiterhin weg
//
// Ohne gekoppelte Steuerbox ist die Maschine „disabled“ — dann gibt es auch nie
// einen Failsafe (Anlagen ohne Steuerbox dürfen nicht auf 4,2 kW fallen).
//
// Rein funktional mit eingespeister Uhr; services/eebus/index.js füttert die
// Ereignisse der Brücke ein und setzt das Ergebnis (effective()) um. Der Zustand
// wird persistiert (toJSON / restore), denn Failsafe-Werte und ein laufender
// Failsafe müssen einen Neustart überdauern.

import { pickMonoNow } from '../mono-clock.js';

export const LP_STATES = Object.freeze([
  'disabled', 'init', 'unlimited_controlled', 'limited', 'failsafe', 'unlimited_autonomous',
]);

export const HEARTBEAT_TIMEOUT_MS = 120_000;

/**
 * @param {object} opts
 * @param {'lpc'|'lpp'} opts.kind
 * @param {number} opts.failsafeW            Vorgabe bis die Steuerbox eigene Werte schreibt
 * @param {number} opts.failsafeDurationS    dito (EEBUS: 2–24 h)
 * @param {() => number} [opts.now]
 * @param {() => number} [opts.monoNow]  monotone Uhr für Abstände (A28); ohne Angabe misst eine eingespielte now-Uhr mit
 */
export function createLimitStateMachine({ kind, failsafeW, failsafeDurationS, now: nowArg = null, monoNow: monoNowArg = null }) {
  const now = nowArg || (() => Date.now());
  // A28 (24.11.2026): im laufenden Prozess messen Failsafe-Dauer, Heartbeat-Frist (120 s), Init-Frist und die
  // Reihenfolge „neue Grenze nach Failsafe-Beginn“ monoton. Die Zeitpunkte (since, failsafeSince, lastHeartbeatAt,
  // lastWriteAt) bleiben Systemzeit für Anzeige und Ablage; das Wiederherstellen nach einem Neustart (restore) prüft
  // wie bisher mit der Systemzeit und rechnet die Restzeit danach monoton weiter. Nichts Monotones wird gespeichert.
  const mono = pickMonoNow(monoNowArg, nowArg);
  const m = { initAt: null, lastHeartbeatAt: null, lastWriteAt: null, failsafeSince: null };
  const s = {
    kind,
    state: 'disabled',
    since: now(),
    initAt: null,
    heartbeatOk: false,
    lastHeartbeatAt: null,
    limit: null,              // { w, active, receivedAt, until|null }
    failsafeW: Number(failsafeW),
    failsafeDurationS: Number(failsafeDurationS),
    failsafeSince: null,
    lastWriteAt: null,
    // Nur von der Steuerbox geschriebene Failsafe-Werte werden gespeichert und
    // nach einem Neustart wieder übernommen; DVhubs eigene Vorgaben kommen
    // immer frisch aus der Konfiguration.
    failsafeWFromEg: false,
    failsafeDurationFromEg: false,
  };

  function go(next) {
    if (s.state === next) return false;
    s.state = next;
    s.since = now();
    if (next === 'failsafe') { s.failsafeSince = now(); m.failsafeSince = mono(); }
    if (next !== 'failsafe') { s.failsafeSince = null; m.failsafeSince = null; }
    return true;
  }

  function limitValid() {
    return Boolean(s.limit && s.limit.active && (s.limit.until == null || s.limit.until > now()));
  }

  function controlledState() {
    return limitValid() ? 'limited' : 'unlimited_controlled';
  }

  /** Steuerbox gekoppelt (true) oder nicht (false). */
  function setEnabled(enabled) {
    if (!enabled) return go('disabled');
    if (s.state !== 'disabled') return false;
    s.initAt = now();
    m.initAt = mono();
    return go('init');
  }

  /** Neue Grenze der Steuerbox (bereits freigegebener Schreibvorgang). */
  function onLimit({ w, durationS, active }) {
    const t = now();
    const d = Number(durationS);
    s.limit = {
      w: Number(w),
      active: active === true,
      receivedAt: t,
      until: Number.isFinite(d) && d > 0 ? t + d * 1000 : null,
    };
    s.lastWriteAt = t;
    m.lastWriteAt = mono();
    // Ein Schreibvorgang beweist eine lebende Verbindung.
    s.heartbeatOk = true;
    s.lastHeartbeatAt = t;
    m.lastHeartbeatAt = m.lastWriteAt;
    if (s.state === 'disabled') return false;
    return go(controlledState());
  }

  /** Failsafe-Grenze, von der Steuerbox geschrieben. */
  function onFailsafeLimit(w) {
    if (!Number.isFinite(Number(w)) || Number(w) < 0) return;
    s.failsafeW = Number(w);
    s.failsafeWFromEg = true;
  }

  /**
   * DVhubs eigene Failsafe-Vorgabe ändern (automatisch Pmin,14a) — nur, solange
   * die Steuerbox keinen eigenen Wert geschrieben hat. true = geändert.
   */
  function setDefaultFailsafeW(w) {
    if (s.failsafeWFromEg || !Number.isFinite(Number(w)) || Number(w) < 0 || Number(w) === s.failsafeW) return false;
    s.failsafeW = Number(w);
    return true;
  }

  /** Failsafe-Mindestdauer, von der Steuerbox geschrieben. */
  function onFailsafeDuration(seconds) {
    if (!Number.isFinite(Number(seconds)) || Number(seconds) <= 0) return;
    s.failsafeDurationS = Number(seconds);
    s.failsafeDurationFromEg = true;
  }

  /** Heartbeat-Zustand laut Brücke (openeebus prüft die Frist). */
  function onHeartbeat(ok) {
    s.heartbeatOk = ok === true;
    if (s.heartbeatOk) { s.lastHeartbeatAt = now(); m.lastHeartbeatAt = mono(); }
    return evaluate();
  }

  // Heartbeat seit mehr als 120 s weg? openeebus meldet einen Verbindungsabbau
  // sofort als „kein Heartbeat“; EEBUS verlangt den Failsafe erst nach 120 s
  // ohne Heartbeat — ein Neustart der Steuerbox oder ein kurzer Netzaussetzer
  // darf die Anlage nicht für mindestens 2 h in den Failsafe schicken.
  function heartbeatLost(tm) {
    if (s.heartbeatOk) return false;
    return m.lastHeartbeatAt == null || tm - m.lastHeartbeatAt >= HEARTBEAT_TIMEOUT_MS;
  }

  /** Zeitabhängige Übergänge; regelmäßig aufrufen. Liefert true bei Zustandswechsel. */
  function evaluate() {
    const t = now();
    const tm = mono();
    if (s.heartbeatOk) { s.lastHeartbeatAt = t; m.lastHeartbeatAt = tm; }
    switch (s.state) {
      case 'disabled':
        return false;
      case 'init':
        if (s.heartbeatOk) return go(controlledState());
        if (m.initAt != null && tm - m.initAt >= HEARTBEAT_TIMEOUT_MS) return go('failsafe');
        return false;
      case 'limited':
      case 'unlimited_controlled':
        if (heartbeatLost(tm)) return go('failsafe');
        return go(controlledState());
      case 'failsafe': {
        // Eine neue Grenze der wieder verbundenen Steuerbox beendet den Failsafe (Reihenfolge monoton; eine Grenze aus
        // einem früheren Prozess hat keine monotone Zeit und beendet ihn nie).
        if (s.heartbeatOk && m.lastWriteAt != null && m.failsafeSince != null && m.lastWriteAt > m.failsafeSince) return go(controlledState());
        if (m.failsafeSince != null && tm - m.failsafeSince < s.failsafeDurationS * 1000) return false;
        return go(s.heartbeatOk ? controlledState() : 'unlimited_autonomous');
      }
      case 'unlimited_autonomous':
        if (s.heartbeatOk) return go(controlledState());
        return false;
      default:
        return false;
    }
  }

  /**
   * Was DVhub jetzt umsetzen muss.
   * @returns {{ state: string, limitW: number|null, reason: string, until: number|null }}
   */
  function effective() {
    switch (s.state) {
      // Nach einem Neustart: eine gespeicherte, noch gültige Grenze der
      // Steuerbox gilt sofort weiter, nicht erst nach dem ersten Herzschlag
      // (bis zu 120 s ohne Grenze, Fable R2 P2-4). Eine in init empfangene
      // Grenze wechselt ohnehin nach limited (onLimit).
      case 'init':
        if (limitValid()) return { state: s.state, limitW: s.limit.w, reason: `${kind}_limit_restored`, until: s.limit.until };
        return { state: s.state, limitW: null, reason: s.state, until: null };
      case 'limited':
        return { state: s.state, limitW: s.limit.w, reason: `${kind}_limit`, until: s.limit.until };
      case 'failsafe':
        return {
          state: s.state,
          limitW: s.failsafeW,
          reason: `${kind}_failsafe`,
          until: s.failsafeSince + s.failsafeDurationS * 1000,
        };
      default:
        return { state: s.state, limitW: null, reason: s.state, until: null };
    }
  }

  function snapshot() {
    return {
      ...effective(),
      since: s.since,
      heartbeatOk: s.heartbeatOk,
      lastHeartbeatAt: s.lastHeartbeatAt,
      limit: s.limit ? { ...s.limit } : null,
      failsafeW: s.failsafeW,
      failsafeDurationS: s.failsafeDurationS,
    };
  }

  /** Persistierbarer Stand (Failsafe-Werte, letzte Grenze, laufender Failsafe). */
  function toJSON() {
    return {
      failsafeW: s.failsafeWFromEg ? s.failsafeW : null,
      failsafeDurationS: s.failsafeDurationFromEg ? s.failsafeDurationS : null,
      limit: s.limit,
      failsafeSince: s.state === 'failsafe' ? s.failsafeSince : null,
    };
  }

  /**
   * Gespeicherten Stand nach einem Neustart übernehmen. Ein laufender Failsafe
   * läuft weiter (bis zur Failsafe-Dauer ab seinem ursprünglichen Beginn).
   */
  function restore(saved) {
    if (!saved || typeof saved !== 'object') return;
    if (saved.failsafeW != null) onFailsafeLimit(saved.failsafeW);
    if (saved.failsafeDurationS != null) onFailsafeDuration(saved.failsafeDurationS);
    if (saved.limit && typeof saved.limit === 'object') s.limit = { ...saved.limit };
    const since = Number(saved.failsafeSince);
    if (Number.isFinite(since) && since > 0 && now() - since < s.failsafeDurationS * 1000 && s.state !== 'disabled') {
      s.state = 'failsafe';
      s.since = since;
      s.failsafeSince = since;
      // Restzeit aus dem früheren Prozess (Systemzeit, einmalig) — ab hier läuft sie monoton ab.
      m.failsafeSince = mono() - Math.max(0, now() - since);
    }
  }

  return { setEnabled, onLimit, onFailsafeLimit, onFailsafeDuration, setDefaultFailsafeW, onHeartbeat, evaluate, effective, snapshot, toJSON, restore };
}
