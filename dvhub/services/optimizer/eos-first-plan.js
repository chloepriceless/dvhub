// services/optimizer/eos-first-plan.js — Erstplan-Wache nach einem Neustart.
//
// Warum es das gibt (Diagnose auf prod, 2026-09-21): nach einem Neustart stand
// 15–30 min kein EOS-Plan, obwohl EOS nach ~90 s rechenfertig war. Drei
// Verzoegerungen addierten sich:
//   1. EOS' Start-Run (ems.startup_delay=5) trifft einen frischen Prozess ohne
//      importierte Prognosen — 'No PV forecast data available - defaulting to
//      demo data', kein 'Energy management run done'. Der Lauf ist verloren.
//   2. Die naechste Chance ist erst der naechste ems.interval-Tick (prod 900 s,
//      am Uhrenraster ausgerichtet).
//   3. DVhub holte die fertige Loesung erst im naechsten eigenen Optimizer-Lauf
//      ab (getOptInterval, 15 min). Gemessen 14.09.: Loesung 12:16:36 fertig,
//      abgeholt erst 12:26:42 — zehn Minuten Leerlauf.
//
// Diese Wache deckt (2) und (3) ab: solange EOS keine Loesung hat, tickt sie
// kurz nach (Standard 30 s) und senkt ems.interval voruebergehend auf
// boostIntervalSec, damit EOS direkt nach dem Prognose-Push rechnet statt zum
// naechsten Viertelstunden-Raster. Sobald eine Loesung steht, wird ems.interval
// zurueckgesetzt und ein regulaerer Optimizer-Lauf angestossen, der sie abholt.
//
// Ueberlappende EOS-Laeufe sind dabei ausgeschlossen: EOS' RetentionManager
// ueberspringt einen faelligen Job, solange der vorige noch laeuft
// (retentionmanager.py:411, `not job.is_running`). Deshalb ist der Boost auch
// auf schwacher Hardware unkritisch — ein langer Lauf auf der ARM-Testbox
// verschiebt nur den naechsten Tick, er stapelt ihn nicht.
//
// Alle Abhaengigkeiten werden injiziert, damit der Ablauf ohne echte Timer und
// ohne laufendes EOS testbar bleibt.

/**
 * @param {object} deps
 * @param {(sinceMs: number) => Promise<boolean>} deps.hasFreshSolution
 *        true, sobald EOS eine Loesung hat, die NACH `sinceMs` gerechnet wurde
 * @param {(sec: number) => Promise<any>} deps.setEmsIntervalSec  PUT /v1/config/ems/interval
 * @param {() => any} deps.triggerOptimization             regulaerer Optimizer-Lauf (holt die Loesung ab)
 * @param {(event: string, data?: object) => void} [deps.pushLog]
 * @param {number|(() => number)} [deps.pollMs=30000]    Nachfrage-Takt (Zahl oder Getter)
 * @param {number} [deps.maxWaitMs=900000]                 Sicherheitsnetz: danach Boost zurueck, Wache aus
 * @param {number|(() => number)} [deps.boostIntervalSec=60]  0 = kein Boost, nur Nachpollen
 * @param {() => number} [deps.now]
 * @param {Function} [deps.setTimer]
 * @param {Function} [deps.clearTimer]
 */
/**
 * Ist `solution` (Rueckgabe von eosAdapter.getOptimizationSolution) eine
 * Loesung, die EOS nach `sinceMs` gerechnet hat? Ohne `sinceMs` genuegt, dass
 * es eine Loesung gibt. Ohne lesbares `generatedAt` gilt sie als veraltet —
 * lieber einmal zu lange warten als eine alte Loesung fuer den Plan halten.
 *
 * @param {{ generatedAt?: string|null }|null} solution
 * @param {number|null} [sinceMs]
 */
export function isFreshEosSolution(solution, sinceMs) {
  if (!solution) return false;
  if (sinceMs == null || !Number.isFinite(Number(sinceMs))) return true;
  const generatedMs = Date.parse(solution.generatedAt || '');
  return Number.isFinite(generatedMs) && generatedMs >= Number(sinceMs);
}

export function createEosFirstPlanWatch(deps) {
  const {
    hasFreshSolution,
    setEmsIntervalSec,
    triggerOptimization,
    pushLog = () => {},
    pollMs: pollMsOpt = 30_000,
    maxWaitMs = 900_000,
    boostIntervalSec: boostIntervalSecOpt = 60,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout
  } = deps;

  // Zahlen oder Getter: der Aufrufer darf die Werte aus der laufenden Config
  // lesen, ohne dass hier beim Erzeugen des Dienstes schon eine Config vorliegen
  // muss (der Optimizer-Dienst wird vor dem ersten Config-Zugriff gebaut).
  const zahl = (v, fallback) => {
    const n = Number(typeof v === 'function' ? v() : v);
    return Number.isFinite(n) ? n : fallback;
  };
  const pollMs = () => zahl(pollMsOpt, 30_000);
  const boostSec = () => zahl(boostIntervalSecOpt, 60);

  let timer = null;
  let armed = false;
  let armedAt = 0;
  let restoreSec = null;   // Soll-Wert von ems.interval, auf den wir zuruecksetzen
  let freshSince = 0;      // Loesungen vor diesem Zeitpunkt zaehlen als veraltet
  let boosted = false;     // haben WIR ems.interval gesenkt? Nur dann setzen wir zurueck.
  let ticking = false;     // kein zweiter tick, solange einer im Netz haengt

  function clear() {
    if (timer) clearTimer(timer);
    timer = null;
  }

  function schedule() {
    clear();
    // Das tick()-Promise wird bewusst durchgereicht (und hier abgefangen): so
    // ist der Ablauf im Test abwartbar, ohne dass eine Ausnahme im Tick als
    // unbehandelte Rejection endet.
    timer = setTimer(
      () => tick().catch(err => pushLog('eos_first_plan_tick_failed', { error: err?.message })),
      pollMs()
    );
    // Der Nachpoll-Timer darf einen Prozess-Exit nicht aufhalten.
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  /**
   * ems.interval auf den Soll-Wert zuruecksetzen. Nur wenn wir selbst geboostet
   * haben — sonst wuerden wir einen Wert ueberschreiben, den der Operator oder
   * der Config-Sync gerade gesetzt hat.
   */
  async function restore() {
    if (!boosted || !Number.isFinite(restoreSec)) return;
    boosted = false;
    try {
      await setEmsIntervalSec(restoreSec);
    } catch (err) {
      // Nicht schlimm: der Config-Sync setzt ems.interval beim naechsten
      // DVhub-Start ohnehin wieder auf den Soll-Wert (eos-config-sync.js:531).
      pushLog('eos_first_plan_restore_failed', { error: err?.message, restoreSec });
    }
  }

  async function tick() {
    if (!armed || ticking) return;
    ticking = true;
    try {
      let ready = false;
      try {
        ready = Boolean(await hasFreshSolution(freshSince));
      } catch (err) {
        pushLog('eos_first_plan_probe_failed', { error: err?.message });
      }

      const waitedMs = now() - armedAt;

      if (ready) {
        armed = false;
        clear();
        await restore();
        pushLog('eos_first_plan_ready', { waitedMs });
        try { triggerOptimization(); } catch (err) {
          pushLog('eos_first_plan_trigger_failed', { error: err?.message });
        }
        return;
      }

      if (waitedMs >= maxWaitMs) {
        armed = false;
        clear();
        await restore();
        pushLog('eos_first_plan_timeout', { waitedMs });
        return;
      }

      schedule();
    } finally {
      ticking = false;
    }
  }

  return {
    /**
     * Wache scharf machen. Idempotent — ein zweiter Aufruf, solange sie laeuft,
     * tut nichts (sonst wuerde jeder Optimizer-Lauf den Boost neu setzen und die
     * Wartezeit-Messung verfaelschen).
     *
     * @param {{ restoreIntervalSec?: number, freshSince?: number }} [opts]
     * @returns {Promise<boolean>} true, wenn dieser Aufruf die Wache gestartet hat
     */
    async arm(opts = {}) {
      if (armed) return false;
      armed = true;
      armedAt = now();
      // Ab welchem Zeitpunkt eine Loesung als frisch gilt: der Moment, in dem
      // DVhub die Prognosen gepusht hat. EOS stellt nach einem Neustart seine
      // LETZTE Loesung aus der eigenen Datenbank wieder her (autosave_interval_sec)
      // — die ist vorhanden, aber mit den neuen Prognosen nicht gerechnet, und
      // DVhub kann aus ihr keine stellbaren Slots ableiten. Auf prod hat genau
      // das die Wache zu frueh entschaerft (2026-09-21: armiert +76 s, aufgegeben
      // +92 s, Plan erst +10 min). Darum zaehlt nur eine Loesung, die NACH dem
      // Push entstanden ist.
      freshSince = Number.isFinite(Number(opts.freshSince)) ? Number(opts.freshSince) : armedAt;
      restoreSec = Number.isFinite(Number(opts.restoreIntervalSec))
        ? Number(opts.restoreIntervalSec) : null;

      // Boost nur, wenn er den Takt wirklich verkuerzt. Ist der Soll-Wert schon
      // kleiner (oder unbekannt), bleibt es beim reinen Nachpollen.
      const boost = boostSec();
      if (boost > 0 && Number.isFinite(restoreSec) && restoreSec > boost) {
        try {
          await setEmsIntervalSec(boost);
          boosted = true;
        } catch (err) {
          pushLog('eos_first_plan_boost_failed', { error: err?.message });
        }
      }

      pushLog('eos_first_plan_watch_armed', {
        boostIntervalSec: boosted ? boost : null,
        restoreIntervalSec: restoreSec,
        pollMs: pollMs(),
        freshSince: new Date(freshSince).toISOString()
      });
      schedule();
      return true;
    },

    /**
     * Wache entschaerfen, weil ein Plan da ist (regulaerer Weg) — Boost zurueck.
     */
    async disarm() {
      if (!armed && !boosted) return;
      armed = false;
      clear();
      await restore();
    },

    /**
     * Shutdown. Bewusst synchron und ohne await auf das Zuruecksetzen: ein
     * haengender HTTP-Call darf den Stop nicht verzoegern (Lehre aus dem
     * Shutdown-Haenger). Bleibt der Boost stehen, korrigiert ihn der
     * Config-Sync beim naechsten Start.
     */
    stop() {
      armed = false;
      clear();
      if (boosted) { restore().catch(() => {}); }
    },

    isArmed: () => armed,
    isBoosted: () => boosted,
    getState: () => ({
      armed, boosted, armedAt, restoreSec, freshSince,
      pollMs: pollMs(), maxWaitMs, boostIntervalSec: boostSec()
    })
  };
}
