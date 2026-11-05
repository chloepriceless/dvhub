// services/optimizer/eos-run-trigger.js — DVhub stößt jeden EOS-Lauf selbst an.
//
// Bis 2026-10-11 rechnete EOS nach eigenem Takt, und drei Dinge standen dafür
// nur in unserem Fork (DV-EOS): Start zur vollen Viertelstunde, der jüngste
// GÜLTIGE Ladestand aus dem Messwertspeicher, und der Warmstart, wenn sich der
// Steuerzeitraum ändert. Alle drei gehen mit unverändertem EOS über
// POST /v1/optimize (an v0.4.0rc2 geprüft):
//
//   - WANN gerechnet wird, bestimmt DVhub: zur vollen Viertelstunde (Takt wie
//     bisher optimizer.eosEmsIntervalSec). EOS' eigene Läufe sind aus
//     (ems.mode = DISABLED, eos-config-sync) — ein ausdrücklich angestoßener
//     Lauf rechnet trotzdem.
//   - Der Ladestand reist im Aufruf mit (`soc`, ganze Prozent je Gerät). EOS
//     schaut dann nicht in seinen Messwertspeicher; das minütliche Schreiben
//     des Ladestands entfällt (es hatte EOS zwischen den Läufen ausgelastet,
//     weil EOS den Speicher nie kürzt — eHive 2026-10-11).
//   - EOS liefert mit jeder Lösung `start_solution` zurück. Ändert sich der
//     Steuerzeitraum (er folgt dem Preishorizont und schrumpft stündlich),
//     passt die Länge nicht mehr und EOS verwirft den Warmstart. DVhub kürzt
//     oder verlängert sie deshalb selbst (alignStartSolution) und gibt sie mit.
//     Bei gleichem Steuerzeitraum schickt DVhub nichts: EOS nimmt dann seine
//     eigene letzte Lösung und verschiebt sie selbst um die vergangenen Slots.
//
// Der Aufruf antwortet erst, wenn der Lauf fertig ist (Minuten bis über eine
// halbe Stunde). Währenddessen wird kein zweiter angestoßen — EOS würde ihn
// nur hinter dem laufenden einreihen, mit dann veraltetem Ladestand.

export const EOS_RUN_TIMEOUT_MS = 3 * 3600_000;
// So lange nach der Grenze wird gestartet: sicher im neuen Slot (EOS rundet
// den Laufbeginn auf den Slot ab), und der Prognose-Push derselben Minute ist
// durch.
export const EOS_RUN_BOUNDARY_OFFSET_MS = 2_000;
// Mindestabstand für außerplanmäßige Anstöße (EOS-Neustart, noch kein Plan).
export const EOS_RUN_KICK_MIN_GAP_MS = 120_000;
// Mittlere Laufdauer (eosRun.avgDurationS) über so viele erfolgreiche Läufe —
// für den Hinweis bei langen Läufen (eos-run-hint.js).
export const EOS_RUN_DURATION_WINDOW = 8;
// Nach einem DVhub-Neustart kann EOS noch am Lauf des alten Prozesses rechnen.
// So lange wird ein beschäftigtes EOS nicht zusätzlich angestoßen.
export const EOS_RUN_STARTUP_GRACE_MS = 60 * 60_000;

/**
 * Stößt DVhub die EOS-Läufe an (Standard)? optimizer.eosStartAfterPreviousRun
 * = true stellt auf das alte Verhalten zurück: EOS rechnet nach eigenem Takt
 * (ab dem Ende des vorigen Laufs) und liest den Ladestand aus Messwerten, die
 * DVhub dann wieder minütlich schreibt.
 */
export function dvhubTriggersEosRuns(cfg) {
  // Fernbetrieb: der Rechendienst rechnet nur auf Auftrag (eos-remote.js).
  if (cfg?.optimizer?.eosProxy?.mode === 'remote') return true;
  return cfg?.optimizer?.eosStartAfterPreviousRun !== true;
}

/** Spielraum beim Zuordnen eines Plans zu seinem Lauf (Uhren von DVhub und EOS/Rechendienst). */
export const PLAN_MATCH_SLACK_MS = 120_000;

/**
 * Steuerzeitraum des gezeigten Plans: eosRun.lastPlanControl, wenn der Plan
 * (generatedAt = EOS-Zeit beim Fertigstellen der Lösung, geneticsolution.py)
 * aus genau diesem Lauf stammt; sonst null (unbekannt — z. B. Plan aus einem
 * früheren Prozess oder EOS' eigenem Takt).
 * @returns {object|null} ohne runStartedAt/runDoneAt
 */
export function planControlFor(lastPlanControl, generatedAtMs) {
  const c = lastPlanControl;
  if (!c || !Number.isFinite(generatedAtMs)) return null;
  if (!(generatedAtMs >= c.runStartedAt - PLAN_MATCH_SLACK_MS && generatedAtMs <= c.runDoneAt + PLAN_MATCH_SLACK_MS)) return null;
  const out = { ...c };
  delete out.runStartedAt;
  delete out.runDoneAt;
  delete out.at;
  return out;
}

/** Erste Grenze (Vielfaches von intervalMs seit Epoche) NACH nowMs. */
export function nextBoundaryMs(nowMs, intervalMs) {
  return (Math.floor(nowMs / intervalMs) + 1) * intervalMs;
}

/**
 * Startlösung eines früheren Laufs an den jetzigen Lauf anpassen.
 *
 * Aufbau (genetic.py, v0.4.0rc2): [Akku-Block][Auto-Block, falls das Auto
 * mitoptimiert wird][Gene der planbaren Geräte]. Jeder Block hat ein Gen je
 * Slot des Steuerzeitraums, Gen 0 gehört zum Slot ab `geneStartMs`.
 *
 * Je Block: die vergangenen Slots vorn abschneiden, dann auf die neue Länge
 * kürzen oder mit dem letzten Gen auffüllen. Die Geräte-Gene bleiben, wie sie
 * sind (EOS prüft sie selbst gegen die aktuellen Geräte).
 *
 * @returns {{genes:number[], startMs:number, blocks:number, elapsedSlots:number}|null}
 *   null, wenn sich die Lösung nicht sicher zuordnen lässt — dann nichts
 *   mitschicken (EOS rechnet ohne Warmstart, wie nach einem Neustart).
 */
export function alignStartSolution({ genes, geneStartMs, previousSlots, currentSlots, slotMs, runStartMs }) {
  if (!Array.isArray(genes) || !genes.every((g) => Number.isFinite(g))) return null;
  const P = Math.trunc(Number(previousSlots));
  const N = Math.trunc(Number(currentSlots));
  if (!(P > 0) || !(N > 0) || !(slotMs > 0)) return null;
  if (!Number.isFinite(geneStartMs) || !Number.isFinite(runStartMs)) return null;
  // Ein oder zwei Blöcke? Eindeutig, solange es weniger Geräte-Gene als Slots
  // gibt (ein Gen je Gerät, ein Slot je Viertelstunde).
  const L = genes.length;
  let blocks = 0;
  if (L >= P && L < 2 * P) blocks = 1;
  else if (L >= 2 * P && L < 3 * P) blocks = 2;
  if (!blocks) return null;
  const elapsedSlots = Math.floor((runStartMs - geneStartMs) / slotMs);
  if (elapsedSlots < 0 || elapsedSlots >= P) return null;

  const out = [];
  for (let b = 0; b < blocks; b += 1) {
    const block = genes.slice(b * P + elapsedSlots, (b + 1) * P);
    while (block.length < N) block.push(block[block.length - 1]);
    out.push(...block.slice(0, N));
  }
  out.push(...genes.slice(blocks * P));
  return { genes: out, startMs: geneStartMs + elapsedSlots * slotMs, blocks, elapsedSlots };
}

/**
 * @param {object} deps
 * @param {()=>boolean} deps.isActive            Stößt DVhub die Läufe an? (Anbindung an, EOS 0.4 erkannt, nicht abgewählt)
 * @param {()=>number} deps.getIntervalSec       Takt der Läufe in Sekunden
 * @param {()=>number} deps.getSlotSec           Slotbreite der Optimierung in Sekunden
 * @param {()=>number|null} deps.getHorizonHours zuletzt an EOS gesendeter Steuerzeitraum
 * @param {()=>Promise<{soc?:object, skipped?:string}>} deps.collectSoc  Ladestände je EOS-Gerät (ganze Prozent)
 * @param {(body:object, timeoutMs:number)=>Promise<{ok:boolean,data?:object,error?:string}>} deps.postOptimize
 * @param {()=>Promise<any>} [deps.onSolution]   Lauf fertig → Lösung abholen
 * @param {()=>{status:string}} [deps.eosStatus] Zustand aus dem EOS-Monitor
 * @param {()=>Promise<{ok:boolean, error?:string, pushed?:boolean}>} [deps.prepareRun]
 *   Vor jedem Lauf pusht die Bridge frisch (Schätzpreise nur hinter dem
 *   Steuerzeitraum, alles dahinter gelöscht; eos-forecast-bridge.js).
 *   ok:false (keine echten Preise, Import oder Steuerzeitraum gescheitert) →
 *   kein Lauf.
 * @param {()=>object|null} [deps.getControlInfo] Steuerzeitraum dieses Laufs
 *   (state.optimizer.eosControl, nach prepareRun gelesen) — mit dem Plan als
 *   eosRun.lastPlanControl abgelegt: Leitstand und Regel-Umsetzung erkennen
 *   daran geschätzte Preise im Plan (E-Auto-Frist, eos-forecast-bridge.js).
 * @param {object} [deps.state]                  state.optimizer.eosRun wird hier geführt
 */
export function createEosRunTrigger({
  isActive, getIntervalSec, getSlotSec, getHorizonHours, collectSoc, postOptimize,
  onSolution, eosStatus, prepareRun, getControlInfo, state, pushLog,
  now = () => Date.now(),
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clearTimer = (t) => clearTimeout(t),
  timeoutMs = EOS_RUN_TIMEOUT_MS,
}) {
  const startedAt = now();
  let timer = null;
  let running = false;      // start() aufgerufen, stop() noch nicht
  // stop() aufgerufen: ein noch laufender Lauf und spätere kick() planen nichts
  // mehr ein (Gesamtprüfung Release 1.0.9). start() hebt das wieder auf.
  let stopped = false;
  let inFlight = null;      // Promise des laufenden Aufrufs
  let lastAttemptAt = 0;
  let finishedRuns = 0;     // beantwortete Aufrufe dieses Prozesses (auch Fehler)
  let lastStart = null;     // { genes, startMs, slots } der letzten Lösung
  const recentDurationsS = []; // Dauer der letzten erfolgreichen Läufe (s)

  const log = (type, data) => { try { pushLog?.(type, data); } catch { /* Log darf nie stören */ } };
  const publish = (patch) => {
    if (!state?.optimizer) return;
    state.optimizer.eosRun = { ...(state.optimizer.eosRun || {}), ...patch };
  };

  function slotsFor(hours) {
    const slotSec = Number(getSlotSec());
    const h = Number(hours);
    if (!(slotSec > 0) || !(h > 0)) return null;
    return Math.round((h * 3600) / slotSec);
  }

  /** Startlösung für diesen Lauf, falls sich der Steuerzeitraum geändert hat. */
  function warmStartFor(currentSlots, runAtMs) {
    if (!lastStart || !currentSlots || lastStart.slots === currentSlots) return null;
    const slotMs = Number(getSlotSec()) * 1000;
    const aligned = alignStartSolution({
      genes: lastStart.genes, geneStartMs: lastStart.startMs,
      previousSlots: lastStart.slots, currentSlots, slotMs,
      runStartMs: Math.floor(runAtMs / slotMs) * slotMs,
    });
    if (!aligned) return null;
    return { ...aligned, previousSlots: lastStart.slots };
  }

  async function run(reason) {
    lastAttemptAt = now();
    // Geschätzte Preise dürfen nie im Steuerzeitraum liegen. Beim Push ist das
    // so, ein Lauf an der Grenze oder per kick kam aber mit dem Stand eines
    // älteren Pushs — deshalb vor jedem Lauf frisch pushen (Gegenprüfung
    // a6dbbd1d). Danach erst den Steuerzeitraum lesen: der Push setzt ihn neu.
    if (typeof prepareRun === 'function') {
      let prep;
      try { prep = await prepareRun(); } catch (err) { prep = { ok: false, error: err?.message || String(err) }; }
      if (prep && prep.ok === false) {
        const error = prep.error || 'Vorbereitung des Laufs fehlgeschlagen';
        log('eos_run_skipped', { reason, error });
        publish({ lastError: error, lastErrorAt: now() });
        return { ok: false, skipped: error };
      }
    }
    // stop() während der Vorbereitung bzw. des Ladestand-Lesens: keinen Lauf
    // mehr an EOS schicken (Gegenprüfung 63c034af, P3).
    if (stopped) return { ok: false, skipped: 'stopped' };
    // Beginn erst nach der Vorbereitung: ein Neu-Push gehört nicht zur
    // Rechenzeit, die Startlösung richtet sich nach dem echten Beginn.
    const at = now();
    const socRes = await collectSoc();
    if (stopped) return { ok: false, skipped: 'stopped' };
    const soc = socRes?.soc;
    if (!soc || !Object.keys(soc).length) {
      const error = socRes?.skipped || socRes?.error || 'kein Ladestand';
      log('eos_run_skipped', { reason, error });
      publish({ lastError: error, lastErrorAt: at });
      return { ok: false, skipped: error };
    }
    const horizonHours = getHorizonHours();
    let control;
    try { control = typeof getControlInfo === 'function' ? (getControlInfo() || null) : null; } catch { control = null; }
    const currentSlots = slotsFor(horizonHours);
    const warm = warmStartFor(currentSlots, at);
    const body = { soc };
    if (warm) {
      body.start_solution = warm.genes;
      body.start_solution_datetime = new Date(warm.startMs).toISOString();
    }
    publish({ inFlight: true, startedAt: at, reason });
    log('eos_run_started', {
      reason, soc, horizonHours,
      warmStart: warm ? { from: warm.previousSlots, to: currentSlots, elapsedSlots: warm.elapsedSlots } : 'eos',
    });
    const res = await postOptimize(body, timeoutMs);
    const durationS = Math.round((now() - at) / 100) / 10;
    finishedRuns += 1;
    const sol = res?.ok ? res.data : null;
    if (!sol) {
      const error = res?.error || 'keine Lösung';
      log('eos_run_failed', { reason, error, durationS });
      publish({ inFlight: false, lastError: error, lastErrorAt: now() });
      return { ok: false, error };
    }
    const startMs = Date.parse(sol.start_solution_datetime);
    lastStart = Array.isArray(sol.start_solution) && Number.isFinite(startMs) && currentSlots
      ? { genes: sol.start_solution, startMs, slots: currentSlots }
      : null;
    log('eos_run_done', { reason, durationS, genes: lastStart ? lastStart.genes.length : null });
    recentDurationsS.push(durationS);
    if (recentDurationsS.length > EOS_RUN_DURATION_WINDOW) recentDurationsS.shift();
    const avgDurationS = Math.round(recentDurationsS.reduce((a, s) => a + s, 0) / recentDurationsS.length * 10) / 10;
    const doneAt = now();
    publish({
      inFlight: false, lastDoneAt: doneAt, lastDurationS: durationS, lastError: null, lastErrorAt: null,
      avgDurationS, recentRuns: recentDurationsS.length,
      lastPlanControl: control ? { ...control, runStartedAt: at, runDoneAt: doneAt } : null,
    });
    try { await onSolution?.(); } catch { /* der Monitor holt sie sonst beim nächsten Takt */ }
    return { ok: true, durationS };
  }

  /** Lauf anstoßen, wenn keiner läuft. Wirft nie. */
  function trigger(reason = 'boundary') {
    // Nach stop() keinen Lauf mehr anstoßen — auch nicht über kick() aus einem
    // noch laufenden runOptimization beim Abschalten (Gegenprüfung a80fa938, P3).
    if (stopped) return Promise.resolve({ ok: false, skipped: 'stopped' });
    if (!isActive()) return Promise.resolve({ ok: false, skipped: 'inactive' });
    if (inFlight) {
      log('eos_run_skipped', { reason, error: 'voriger Lauf rechnet noch' });
      return Promise.resolve({ ok: false, skipped: 'in_flight' });
    }
    // Nach einem DVhub-Neustart: rechnet EOS noch (antwortet nicht rechtzeitig),
    // gehört der Lauf dem alten Prozess. Nicht dahinter einreihen.
    if (finishedRuns === 0 && now() - startedAt < EOS_RUN_STARTUP_GRACE_MS && eosStatus?.()?.status === 'busy') {
      log('eos_run_skipped', { reason, error: 'EOS rechnet noch (Lauf vor dem DVhub-Neustart)' });
      return Promise.resolve({ ok: false, skipped: 'eos_busy' });
    }
    // Dieser Lauf rechnet schon mit dem aktuellen Stand: ein vorgemerkter
    // Neuplan entfällt — scheitert der Lauf, wird er wieder vorgemerkt
    // (Gegenprüfung 27a172cb).
    const carried = pendingReplan;
    clearPending();
    inFlight = run(reason)
      .catch((err) => {
        const error = err?.message || String(err);
        log('eos_run_failed', { reason, error });
        publish({ inFlight: false, lastError: error, lastErrorAt: now() });
        return { ok: false, error };
      })
      .then((res) => {
        if (carried && !pendingReplan && !stopped && !(res && res.ok)) pendingReplan = carried;
        return res;
      })
      .finally(() => { inFlight = null; armPending(); });
    return inFlight;
  }

  // Neuplan nach einer Einstellungsänderung ('replan:…'), der auf einen
  // laufenden oder gerade gestarteten Lauf trifft: nicht verwerfen, sondern
  // nachholen — nach dem Lauf, frühestens 2 min nach dessen Start. Startet
  // inzwischen ohnehin ein Lauf, rechnet der schon mit der neuen Einstellung
  // und der Nachholtermin entfällt (Gegenprüfung a25589cc).
  let pendingReplan = null;
  let pendingTimer = null;
  function clearPending() {
    pendingReplan = null;
    if (pendingTimer) { clearTimer(pendingTimer); pendingTimer = null; }
  }
  function armPending(delayMs) {
    if (stopped) { pendingReplan = null; return; }
    if (!pendingReplan || pendingTimer || inFlight) return;
    const wait = delayMs ?? Math.max(0, lastAttemptAt + EOS_RUN_KICK_MIN_GAP_MS - now());
    pendingTimer = setTimer(() => {
      pendingTimer = null;
      const reason = pendingReplan;
      pendingReplan = null;
      return reason ? kick(reason) : undefined;
    }, wait);
  }

  /** Außer der Reihe (EOS neu gestartet, noch kein Plan) — höchstens alle 2 min. */
  function kick(reason) {
    if (stopped) return Promise.resolve({ ok: false, skipped: 'stopped' });
    const replan = String(reason || '').startsWith('replan:');
    if (inFlight || now() - lastAttemptAt < EOS_RUN_KICK_MIN_GAP_MS) {
      if (replan) { pendingReplan = reason; armPending(); }
      return Promise.resolve({ ok: false, skipped: 'recent' });
    }
    return trigger(reason).then((res) => {
      // Nach einem DVhub-Neustart rechnet EOS noch den alten Lauf: Neuplan in
      // 2 min erneut versuchen statt verwerfen (Gegenprüfung 27a172cb).
      if (replan && res?.skipped === 'eos_busy') { pendingReplan = reason; armPending(EOS_RUN_KICK_MIN_GAP_MS); }
      return res;
    });
  }

  function schedule() {
    if (!running) return;
    const intervalMs = Math.max(60, Number(getIntervalSec()) || 900) * 1000;
    const nextAt = nextBoundaryMs(now(), intervalMs) + EOS_RUN_BOUNDARY_OFFSET_MS;
    publish({ nextAt });
    timer = setTimer(() => {
      timer = null;
      trigger('boundary');
      schedule();
    }, Math.max(0, nextAt - now()));
  }

  return {
    start() { stopped = false; if (!running) { running = true; schedule(); } },
    stop() { stopped = true; running = false; if (timer) clearTimer(timer); timer = null; clearPending(); },
    trigger,
    kick,
    isActive,
    isRunning: () => inFlight !== null,
    /** Für Tests und die Statusanzeige. */
    lastStartSolution: () => (lastStart ? { ...lastStart, genes: [...lastStart.genes] } : null),
  };
}
