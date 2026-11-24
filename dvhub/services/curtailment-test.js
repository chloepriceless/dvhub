// services/curtailment-test.js — Feldtest-Auslöser für die Negativpreis- und
// Direktvermarkter-Abregelung (M14b, Sungrow-Feldtest).
//
// Anlass (Christin): die Negativpreis-/DV-Abregelung kontrolliert am echten
// Gerät testen können — aus dem Leitstand, statt eigener Skripte (die schief
// gingen). Zwei Auslöser, beide über GENAU denselben Ernstfall-Pfad:
//   • "Negativpreis-Abregelung testen (X min)" — ein Lease macht priceNegative
//     im Regeltakt (schedule-eval) wahr; das ist derselbe Pfad wie § 51 bei echt
//     negativem Preis (Sollwert-Puffer + feedExcessDcPv-Sperre).
//   • "Direktvermarkter-Abregelung testen (X min)" — setForcedOff('curtailment_
//     test', { until }) → der dv_forced_off-Pfad, exakt wie ein echtes DV-Signal.
//
// SICHERHEIT: Jeder Test bekommt ein selbst-ablaufendes Lease (until). Er endet
// garantiert nach X min, auch ohne weitere Aktion — er kann die Anlage nie
// dauerhaft sperren. Das DV-Lease läuft über denselben 1-s-Watchdog
// (expireLeaseIfNeeded) ab wie ein echtes DV-forcedOff; das Negativpreis-Lease
// wird im Regeltakt nur gelesen (Date.now() < until) und fällt danach von selbst
// weg. Läuft ein Not-Halt, lehnt der Start ab (keine Steuer-Writes im Not-Halt).
//
// PROTOKOLL: Eine 1-Sekunden-Abtastung DIREKT aus dem Regeltakt (state.victron/
// state.meter, die der Sungrow-Regler selbst liest) — NICHT aus /api/status (das
// bei Sungrow nur alle paar Sekunden aktualisiert, zu grob). Je WR getrennt
// (PV, Akku) plus Netz und der Abregel-Zustand (gesichert/geschrieben/
// verifiziert/wiederhergestellt), damit das Abregel-Verhalten sauber mitläuft.
//
// ZEIT (A23 b, Christin 23.11.2026): die Zeitbegrenzung misst eine monotone Uhr. startedAt/until/stoppedAt bleiben
// Wanduhr (Anzeige, Protokoll, DV-Lease offUntil); ob der Test läuft, wie lange noch und tMs der Abtastung rechnen
// monoton ab dem Start. So endet der Test nach X min Laufzeit, auch wenn die Systemzeit springt (NTP, Hand-
// Einstellung). Läuft er so ab, nimmt sample() das eigene DV-Lease mit zurück — das Wanduhr-Lease (offUntil) liefe
// nach einem Rücksprung sonst um die Sprungweite weiter. Nach einem Sprung vorwärts endet das DV-Lease über
// expireLeaseIfNeeded früher als der Test (sichere Seite: weniger Abregelung).

import { pickMonoNow } from './mono-clock.js';

// Monotoner Ablauf je Testlauf (am Objekt state.ctrl.curtailmentTest, nicht im JSON), mit der Uhr des Dienstes. Auf
// Modulebene, damit auch Leser außerhalb des Dienstes (Sungrow-Aktuator: „Akku nicht laden“) dieselbe Frist sehen.
const runs = new WeakMap();

/**
 * Restzeit eines Testlaufs in ms (≤ 0 = abgelaufen): monoton, wenn der Dienst den Lauf gestartet hat; sonst (von außen
 * gesetzt, Tests) gegen die Wanduhr until − nowMs.
 */
export function curtailmentTestRemainingMs(t, nowMs = Date.now()) {
  if (!t) return 0;
  const r = runs.get(t);
  return r ? r.untilMono - r.clock() : Number(t.until) - nowMs;
}

/** Läuft der Testlauf (aktiv und nicht abgelaufen)? Siehe curtailmentTestRemainingMs. */
export function curtailmentTestRunning(t, nowMs = Date.now()) {
  return !!(t && t.active === true && curtailmentTestRemainingMs(t, nowMs) > 0);
}

const MIN_MINUTES = 1;
const MAX_MINUTES = 60;                       // Sicherheits-Obergrenze je Test
const MAX_SAMPLES = 60 * (MAX_MINUTES + 2);   // bounded gegen Speicherwuchs

export const CURTAILMENT_TEST_MODES = Object.freeze(new Set(['negativePrice', 'dv']));

// Sequenz-/Abregel-Ereignisse, die ins Protokoll gehören (aus dem Log-Ringpuffer
// im Testfenster): gesichert/geschrieben/verifiziert/wiederhergestellt.
const PROTOCOL_EVENTS = new Set([
  'dv_victron_write', 'dv_victron_write_error', 'dv_seq_readback_mismatch',
  'dv_seq_restore_already_set', 'dv_release_skipped_no_own_block', 'dv_seq_restore_invalid',
  'negative_price_protection_on', 'negative_price_protection_off',
  'ctrl_off', 'ctrl_on', 'ctrl_lease_expired', 'sungrow_ems_write',
  'dv_control_seq_budget', // P2: Schreibbudget der Einspeise-Sequenz erreicht
]);

export function createCurtailmentTest(ctx) {
  const state = ctx.state;
  const pushLog = ctx.pushLog || (() => {});
  const now = ctx.now || (() => Date.now());
  const mono = pickMonoNow(ctx.monoNow, ctx.now);

  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const current = () => state.ctrl.curtailmentTest || null;
  const remaining = (t) => curtailmentTestRemainingMs(t, now());
  const running = (t) => curtailmentTestRunning(t, now());

  // Abgelaufenen Lauf beenden und ein noch eigenes DV-Lease mit zurücknehmen (wie stop()): nur, wenn offUntil noch das
  // eigene ist — ein echtes DV-Signal hat es verschoben und läuft über sein eigenes Lease ab. true = beendet.
  function expireIfDue(t) {
    if (!t || t.active !== true || remaining(t) > 0) return false;
    finish('expired');
    if (t.mode === 'dv' && state.ctrl.forcedOff === true && state.ctrl.offUntil === t.until) {
      ctx.clearForcedOff?.('curtailment_test_expired');
    }
    return true;
  }

  /** Test gerade aktiv (und Lease nicht abgelaufen)? */
  function isActive() {
    return running(current());
  }

  /** „Akku nicht laden" aktiv? Von services/inverter/sungrow.js (stepForced) gelesen: sperrt nur das Laden (M25). */
  function batteryHoldActive() {
    const t = current();
    return running(t) && t.blockCharge === true;
  }

  function start({ mode, minutes, blockCharge = false, actor = null } = {}) {
    const m = String(mode || '');
    if (!CURTAILMENT_TEST_MODES.has(m)) {
      return { ok: false, status: 400, error: 'mode must be negativePrice or dv' };
    }
    const mins = Math.round(num(minutes) ?? 0);
    if (!(mins >= MIN_MINUTES && mins <= MAX_MINUTES)) {
      return { ok: false, status: 400, error: `minutes must be ${MIN_MINUTES}..${MAX_MINUTES}` };
    }
    // Im Not-Halt schreibt DVhub nichts — ein Test über den echten Pfad wäre
    // wirkungslos und widerspräche „als ob aus". Ablehnen.
    if (state.ctrl.discretionaryWritesPaused === true) {
      return { ok: false, status: 409, error: 'emergency_stop_active' };
    }
    // Ohne aktive Steuerung (Volleinspeiser / „nur beobachten") gibt es keine
    // Abregelung zu testen.
    if (ctx.getCfg?.()?.dvControl?.enabled !== true) {
      return { ok: false, status: 409, error: 'dv_control_disabled' };
    }
    const existing = current();
    // Ein abgelaufener, noch nicht abgetasteter Lauf (sample() kommt jede Sekunde) wird erst sauber beendet, samt
    // eigenem DV-Lease — sonst überschriebe der neue Lauf ihn und das Lease bliebe stehen (Codex 944bcef1 P2).
    expireIfDue(existing);
    if (running(existing)) {
      return { ok: false, status: 409, error: 'curtailment_test_already_running', test: publicView() };
    }
    // Blocker 5 (Codex-Review 16.11.): Läuft bereits eine ECHTE DV-Abschaltung (forcedOff mit
    // fremder Quelle, nicht unser Test), den DV-Test NICHT starten — sonst überschriebe
    // setForcedOff deren offUntil mit der kürzeren Test-Frist und stop() gäbe die echte Sperre
    // frei. Der Ernstfall hat Vorrang.
    if (m === 'dv' && state.ctrl.forcedOff === true && now() < (Number(state.ctrl.offUntil) || 0) && state.ctrl.lastSignal !== 'curtailment_test') {
      return { ok: false, status: 409, error: 'real_dv_restriction_active', test: publicView() };
    }
    const startedAt = now();
    const until = startedAt + mins * 60000;
    const startedMono = mono();
    state.ctrl.curtailmentTest = {
      active: true, mode: m, minutes: mins, blockCharge: blockCharge === true,
      startedAt, until, samples: [], events: [], stoppedAt: null, stopReason: null,
      actor: actor?.actor_ip || null,
    };
    runs.set(state.ctrl.curtailmentTest, { startedMono, untilMono: startedMono + mins * 60000, clock: mono });
    // DV-Test: echtes Lease über denselben Pfad wie ein DV-Signal. Der Aufruf
    // sperrt die Einspeisung sofort (applyDvVictronControl(false)) und läuft über
    // den 1-s-Watchdog (expireLeaseIfNeeded) von selbst ab.
    if (m === 'dv') {
      ctx.setForcedOff('curtailment_test', { until });
    }
    // Negativpreis-Test: kein eigener Write — der nächste evaluateSchedule()-Lauf
    // (≤ ~15 s) liest das Lease und geht in den priceNegative-Ernstfallpfad.
    pushLog('curtailment_test_started', {
      mode: m, minutes: mins, blockCharge: blockCharge === true,
      until: new Date(until).toISOString(),
    }, actor || undefined);
    return { ok: true, status: 200, test: publicView() };
  }

  function stop({ actor = null, reason = 'operator' } = {}) {
    const t = current();
    if (!t || t.active !== true) {
      return { ok: true, status: 200, alreadyStopped: true, test: publicView() };
    }
    const mode = t.mode;
    const leaseUntil = t.until;
    finish(reason);
    // DV-Lease aktiv aufheben, aber NUR, wenn es noch unseres ist (kam während
    // des Tests ein echtes DV-Signal, hat es offUntil verschoben — dann nicht
    // anfassen, der Ernstfall hat Vorrang und läuft über sein eigenes Lease ab).
    if (mode === 'dv' && state.ctrl.forcedOff === true && state.ctrl.offUntil === leaseUntil) {
      ctx.clearForcedOff?.('curtailment_test_stopped');
    }
    pushLog('curtailment_test_stopped', { mode, reason }, actor || undefined);
    return { ok: true, status: 200, test: publicView() };
  }

  // Test beenden (manuell oder Lease-Ablauf). Negativpreis: der nächste Eval-Lauf
  // sieht now() >= until → priceNegative false → Freigabe. DV: expireLeaseIfNeeded
  // hebt forcedOff auf. „Akku nicht laden" gilt ohnehin nur solange active && now<until.
  function finish(reason) {
    const t = current();
    if (!t || t.active !== true) return;
    t.active = false;
    t.stoppedAt = now();
    t.stopReason = reason;
    t.events = collectEvents(t.startedAt, t.stoppedAt);
    pushLog('curtailment_test_finished', { mode: t.mode, reason, samples: t.samples.length });
  }

  function collectEvents(fromMs, toMs) {
    const out = [];
    const log = Array.isArray(state.log) ? state.log : [];
    for (const row of log) {
      if (!row || !PROTOCOL_EVENTS.has(row.event)) continue;
      const ts = Date.parse(row.ts);
      if (!Number.isFinite(ts) || ts < fromMs - 1500 || ts > toMs + 1500) continue;
      out.push({ ts: row.ts, event: row.event, level: row.level || 'info', register: row.register, point: row.point, reason: row.reason, value: row.value, error: row.error });
    }
    return out;
  }

  // 1-Sekunden-Abtastung aus dem Regeltakt. Wird aus dem 1-s-Interval (server.js)
  // aufgerufen. Beendet den Test bei Lease-Ablauf.
  function sample() {
    const t = current();
    if (!t || t.active !== true) return;
    if (expireIfDue(t)) return;
    if (t.samples.length >= MAX_SAMPLES) return;
    const v = state.victron || {};
    const second = v.sungrowSecond || state.sungrowSecond || {};
    const act = state.schedule?.active || {};
    const dcFeed = act.feedExcessDcPv ? num(act.feedExcessDcPv.value) : null;
    const startMono = runs.get(t)?.startedMono;
    t.samples.push({
      tMs: startMono != null ? mono() - startMono : now() - t.startedAt,
      // Netz (System-Zähler am Master) + PV/Akku je WR, genau die Felder, die der
      // Regler selbst liest — nicht die gröbere /api/status-Momentaufnahme.
      gridTotalW: num(state.meter?.grid_total_w),
      pvTotalW: num(v.pvTotalW),
      pvMasterW: num(v.sungrowMasterPvW ?? v.pvPowerW),
      pvSlaveW: num(second.pvPowerW),
      battMasterW: num(v.sungrowMasterBatteryW ?? v.batteryPowerW),
      battSlaveW: num(second.batteryPowerW),
      // Abregel-Zustand: feedExcessDcPv 0 = gesperrt; dv_seq_saved vorhanden =
      // Werte vor der Sperre gesichert; forcedOff/negativePriceActive = welcher Pfad.
      dcFeed,
      blocked: dcFeed == null ? null : dcFeed === 0,
      forcedOff: state.ctrl.forcedOff === true,
      negativePriceActive: state.ctrl.negativePriceActive === true,
      saved: Object.keys(state.ctrl._dvSeqSaved || {}),
    });
  }

  function publicView() {
    const t = current();
    if (!t) return null;
    const active = running(t);
    return {
      active,
      mode: t.mode,
      minutes: t.minutes,
      blockCharge: t.blockCharge === true,
      startedAt: t.startedAt,
      until: t.until,
      remainingMs: active ? Math.max(0, remaining(t)) : 0,
      stoppedAt: t.stoppedAt,
      stopReason: t.stopReason || null,
      sampleCount: Array.isArray(t.samples) ? t.samples.length : 0,
      samples: Array.isArray(t.samples) ? t.samples : [],
      events: Array.isArray(t.events) ? t.events : [],
    };
  }

  function getStatus() {
    return { ok: true, status: 200, test: publicView() };
  }

  return { start, stop, sample, finish, getStatus, isActive, batteryHoldActive, publicView };
}
