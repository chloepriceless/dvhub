// services/eebus/limit-state.js — Zustandsmaschine der Netzseite (EEBUS LPC / LPP).
//
// DVhub ist gegenüber der Steuerbox des Netzbetreibers (§14a EnWG, Energy
// Guard) das „Controllable System“. Die Anwendungsfälle „Limitation of Power
// Consumption“ (LPC) und „… Production“ (LPP) schreiben dafür fünf Zustände vor:
//
//   init                  nach dem Start, bis die Steuerbox sich meldet
//                         (spätestens nach 120 s ohne Heartbeat → failsafe)
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
 */
export function createLimitStateMachine({ kind, failsafeW, failsafeDurationS, now = () => Date.now() }) {
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
  };

  function go(next) {
    if (s.state === next) return false;
    s.state = next;
    s.since = now();
    if (next === 'failsafe') s.failsafeSince = now();
    if (next !== 'failsafe') s.failsafeSince = null;
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
    // Ein Schreibvorgang beweist eine lebende Verbindung.
    s.heartbeatOk = true;
    s.lastHeartbeatAt = t;
    if (s.state === 'disabled') return false;
    return go(controlledState());
  }

  function onFailsafeLimit(w) {
    if (Number.isFinite(Number(w)) && Number(w) >= 0) s.failsafeW = Number(w);
  }

  function onFailsafeDuration(seconds) {
    if (Number.isFinite(Number(seconds)) && Number(seconds) > 0) s.failsafeDurationS = Number(seconds);
  }

  /** Heartbeat-Zustand laut Brücke (openeebus prüft die Frist). */
  function onHeartbeat(ok) {
    s.heartbeatOk = ok === true;
    if (s.heartbeatOk) s.lastHeartbeatAt = now();
    return evaluate();
  }

  /** Zeitabhängige Übergänge; regelmäßig aufrufen. Liefert true bei Zustandswechsel. */
  function evaluate() {
    const t = now();
    switch (s.state) {
      case 'disabled':
        return false;
      case 'init':
        if (s.heartbeatOk) return go(controlledState());
        if (t - s.initAt >= HEARTBEAT_TIMEOUT_MS) return go('failsafe');
        return false;
      case 'limited':
      case 'unlimited_controlled':
        if (!s.heartbeatOk) return go('failsafe');
        return go(controlledState());
      case 'failsafe': {
        // Eine neue Grenze der wieder verbundenen Steuerbox beendet den Failsafe.
        if (s.heartbeatOk && s.lastWriteAt != null && s.lastWriteAt > s.failsafeSince) return go(controlledState());
        if (t - s.failsafeSince < s.failsafeDurationS * 1000) return false;
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
      failsafeW: s.failsafeW,
      failsafeDurationS: s.failsafeDurationS,
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
    onFailsafeLimit(saved.failsafeW);
    onFailsafeDuration(saved.failsafeDurationS);
    if (saved.limit && typeof saved.limit === 'object') s.limit = { ...saved.limit };
    const since = Number(saved.failsafeSince);
    if (Number.isFinite(since) && since > 0 && now() - since < s.failsafeDurationS * 1000 && s.state !== 'disabled') {
      s.state = 'failsafe';
      s.since = since;
      s.failsafeSince = since;
    }
  }

  return { setEnabled, onLimit, onFailsafeLimit, onFailsafeDuration, onHeartbeat, evaluate, effective, snapshot, toJSON, restore };
}
