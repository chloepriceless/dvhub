/**
 * multi-gx/floor-handoff.js — Einspeisung aus Akku 2, wenn Akku 1 am harten
 * Boden steht (Chrissi 22.10.2026: „entscheidung b richtiger … muss man es
 * explizit in den einstellungen aktivieren“).
 *
 * Ohne diesen Schalter setzt der Entlade-Boden (schedule-eval, T-0075) jeden
 * Einspeise-Sollwert der Hauptanlage auf 0, sobald ihr Ladestand den harten
 * Boden erreicht. Die zweite Anlage sieht dann keinen Bedarf und speist nichts
 * ein, obwohl EOS mit ihrer Energie plant (Codex Runde 3, P2).
 *
 * Mit Schalter (multiGx.exportHandoffAtFloor):
 *  1. arming — DVhub sichert die maximale Entladeleistung der Hauptanlage
 *     (Register 2704, Datei) und schreibt 0: Akku 1 entlaedt nicht mehr, egal
 *     welcher Netz-Sollwert anliegt. Der Sollwert bleibt bis dahin 0.
 *  2. active — erst wenn die Hauptanlage 0 frisch zurueckmeldet, geht der
 *     geplante Einspeise-Sollwert durch. Die zweite Anlage traegt den ganzen
 *     Bedarf (multi-gx/index.js: Hauptanlage gilt als leer, Entladegrenze 0).
 *  3. restoring — faellt eine Bedingung weg, greift sofort wieder der normale
 *     Boden (Sollwert 0). Den gesicherten Wert schreibt DVhub zurueck, sobald
 *     Akku 1 frisch 3 Punkte ueber dem Boden liegt (darunter haelt der Boden
 *     ihn ohnehin auf 0). Bis dahin bleibt Akku 1 gesperrt, und die zweite
 *     Anlage deckt weiter, was sie kann. Die Datei uebersteht einen Neustart.
 *
 * Jeder Fehler (zweite Anlage weg, DVhub haengt, Datei fehlt) laesst Akku 1
 * gesperrt statt ihn zu entladen — das Haus bezieht dann aus dem Netz.
 *
 * @module services/multi-gx/floor-handoff
 */
import { resolveMultiGxOptions } from './index.js';
import { controlWriteBoundsError } from '../../server-utils.js';

const FOLLOWER_MAX_AGE_MS = 15000;
// Ohne neue Einspeise-Anfrage → beenden; Fristen mindestens drei bzw. ein
// Auswertungstakt (schedule.evaluateMs bis 30 s, Codex 22.10.): maintain laeuft
// VOR der Anfrage des laufenden Takts.
const evalMs = (cfg) => Math.max(5000, Number(cfg.schedule?.evaluateMs) || 15000);
const requestGraceMs = (cfg) => Math.max(20000, 3 * evalMs(cfg));
const zeroRetryMs = (cfg) => Math.max(10000, evalMs(cfg));
// 2704 ist eine dauerhafte Einstellung (Flash der GX): Wiederholungen ohne
// Bestaetigung werden immer seltener, hoechstens alle 10 min.
const retryDelayMs = (cfg, attempts) => Math.min(600000, zeroRetryMs(cfg) * 2 ** Math.max(0, attempts - 1));
// Zurueckschreiben erst 3 Prozentpunkte ueber dem Boden: sonst pendelt Akku 1 um
// den Boden, und jede Runde schreibt 2704 zweimal (Flash der GX).
const RESTORE_HYSTERESIS_PCT = 3;

const finite = (v) => v != null && v !== '' && Number.isFinite(Number(v));

// Nur echte, geplante Akku-Einspeisung (Codex Runde 4): Zeitplan-/EOS-Regeln und
// Handvorgaben, ab derselben Schwelle, ab der schedule-eval eine erzwungene
// Netzentladung erkennt (FORCED_EXPORT_THRESHOLD_W). Nicht: DC-PV-Export (soll
// PV einspeisen, nicht Akku 2; schreibt zudem nur alle 60 s), Standard-Puffer,
// Schutz bei negativem Preis, Mindestverkaufspreis.
const HANDOFF_SOURCE = /^(rule:|manual_override$|manual_override_persistent$|api_manual_write$)/;
export const HANDOFF_MIN_EXPORT_W = 1000;
export function isHandoffRequest(source, requestedW) {
  return HANDOFF_SOURCE.test(String(source || '')) && finite(requestedW) && Number(requestedW) <= -HANDOFF_MIN_EXPORT_W;
}

/**
 * @param {object} deps
 * @param {() => object} deps.getCfg
 * @param {object} deps.state       Laufzeit-Zustand (state.victron, state.multiGx, state.ctrl)
 * @param {Function} [deps.pushLog]
 * @param {() => number} [deps.now]
 * @param {{load: () => any, save: (v: object) => void, clear: () => void}} [deps.store]
 */
export function createFloorHandoff({ getCfg, state, pushLog = () => {}, now = Date.now, store = null, transportType = () => 'modbus' } = {}) {
  let phase = 'off';
  let saved = null;
  let since = 0;
  let lastRequestAt = 0;
  let lastZeroAt = 0;
  let lastReason = null;
  let unknownLogged = false;
  let zeroWritten = false;
  let zeroWrittenAt = 0;
  let restoreWrittenAt = 0;
  let lastRestoreAt = 0;
  let zeroAttempts = 0;
  let restoreAttempts = 0;

  try {
    const persisted = store?.load?.();
    if (persisted && finite(persisted.savedMaxDischargeW)) {
      saved = Number(persisted.savedMaxDischargeW);
      phase = 'restoring';
      since = now();
      lastReason = 'restart';
      pushLog('multi_gx_handoff_restore_pending', { savedMaxDischargeW: saved, reason: 'restart' }, 'warn');
    }
  } catch (e) {
    pushLog('multi_gx_handoff_store_error', { error: e?.message || String(e) }, 'error');
  }

  // mainDischargeBlocked: Akku 1 ist von DVhub gesperrt (2704 = 0 frisch
  // gelesen) — die zweite Anlage rechnet dann ohne ihn (multi-gx/index.js).
  function publish(cfg = getCfg() || {}) {
    // restoring (auch nach Neustart): gesperrt, solange die GX nach dem letzten
    // Zurueckschreiben frisch 0 meldet — nur fuer die Aufteilung, nie als
    // Freigabe der Einspeisung (Codex Runde 3, P2).
    const blocked = phase === 'active'
      ? lockConfirmed(cfg)
      : phase === 'restoring' && mainMaxDischargeW(cfg) === 0 && sentAt() > restoreWrittenAt;
    state.multiGxHandoff = { phase, savedMaxDischargeW: saved, since, reason: lastReason, mainDischargeBlocked: blocked };
  }

  function setPhase(next, reason) {
    if (next === phase) return;
    pushLog('multi_gx_handoff', { from: phase, to: next, reason, savedMaxDischargeW: saved });
    phase = next;
    since = now();
    lastReason = reason;
    publish();
  }

  const maxAgeMs = (cfg) => Number(cfg.victron?.telemetryMaxAgeMs ?? 90000);
  const fieldFresh = (name, cfg) => {
    const at = state.victron?.fieldUpdatedAt?.[name];
    return finite(at) && now() - Number(at) <= maxAgeMs(cfg);
  };
  const mainMaxDischargeW = (cfg) => (fieldFresh('maxDischargeW', cfg) && finite(state.victron?.maxDischargeW)
    ? Number(state.victron.maxDischargeW) : null);
  // Wann die GX den gelesenen Wert gesendet hat (MQTT: Nachricht, nicht Poll;
  // Codex 22.10. Runde 2, P1) — Rueckfall auf den Poll-Zeitpunkt.
  const sentAt = () => Number(state.victron?.fieldSourceAt?.maxDischargeW ?? state.victron?.fieldUpdatedAt?.maxDischargeW) || 0;
  // Gesperrt = DVhub hat 0 geschrieben UND die GX meldet danach 0 — ein
  // Ruecklesen von vor dem Schreiben zaehlt nicht (MQTT: „ok“ heisst nur
  // veroeffentlicht; Codex 22.10., P1).
  const lockConfirmed = (cfg) => zeroWritten
    && mainMaxDischargeW(cfg) === 0
    && sentAt() > zeroWrittenAt;
  publish();

  /** Warum die Uebergabe gerade nicht erlaubt ist, sonst null. */
  function blocker(cfg) {
    if (cfg.multiGx?.exportHandoffAtFloor !== true) return 'disabled';
    if (!resolveMultiGxOptions(cfg).enabled) return 'multi_gx_off';
    if (!cfg.controlWrite?.maxDischargeW?.enabled) return 'max_discharge_not_writable';
    const ctrl = state.ctrl || {};
    if (ctrl.discretionaryWritesPaused === true) return 'emergency_stop';
    if (ctrl.forcedOff === true || ctrl.negativePriceActive === true) return 'export_blocked';
    const mg = state.multiGx || {};
    if (mg.online !== true) return 'follower_offline';
    if (!finite(mg.updatedAt) || now() - Number(mg.updatedAt) > FOLLOWER_MAX_AGE_MS) return 'follower_stale';
    const minSoc = finite(mg.minSocPct) ? Number(mg.minSocPct) : (finite(cfg.multiGx?.minSocPct) ? Number(cfg.multiGx.minSocPct) : 10);
    if (!finite(mg.socPct) || Number(mg.socPct) <= minSoc + 1) return 'follower_empty';
    return null;
  }

  /**
   * Vom Entlade-Boden gerufen, wenn er einen Einspeise-Sollwert der
   * Hauptanlage wegen „below_hard_floor“ auf 0 setzen wuerde. Liefert den
   * Sollwert, der stattdessen durchgehen darf, oder null (= Boden haelt).
   */
  function onFloorHold({ target, requested, source }) {
    if (target !== 'gridSetpointW' || !isHandoffRequest(source, requested)) return null;
    const cfg = getCfg() || {};
    const why = blocker(cfg);
    if (why) return null;
    lastRequestAt = now();
    const current = mainMaxDischargeW(cfg);
    if (phase === 'off') {
      // Ohne frisch gelesenen Ausgangswert kein Sperren — sonst wuesste DVhub
      // nicht, was es spaeter zuruecksetzen soll.
      if (current == null) {
        if (!unknownLogged) { unknownLogged = true; pushLog('multi_gx_handoff_skipped', { reason: 'max_discharge_unknown' }, 'warn'); }
        return null;
      }
      unknownLogged = false;
      // Gelesene 0 ist nicht eindeutig (ob die GX „unbegrenzt“ als 0 meldet,
      // ist ungeprueft), negative Werte heissen unbegrenzt: in beiden Faellen
      // kommt spaeter -1 (raw 32767) zurueck. Gesperrt gilt erst nach DVhubs
      // eigenem Schreiben von 0 (zeroWritten).
      // Ueber MQTT kommt der Wert in Watt, 0 heisst dort eindeutig gesperrt und
      // bleibt 0 (Codex Runde 2). Ueber Modbus ist eine gelesene 0 mehrdeutig:
      // bewusste Sperre oder „unbegrenzt“ (-1 bei Skala 0,1, ungeprueft). Dann
      // keine Uebergabe — DVhub wuerde sonst womoeglich eine Sperre des Betreibers
      // aufheben (Codex Runde 4).
      if (current === 0 && transportType() !== 'mqtt') {
        if (!unknownLogged) { unknownLogged = true; pushLog('multi_gx_handoff_skipped', { reason: 'max_discharge_zero_ambiguous' }, 'warn'); }
        return null;
      }
      const snapshot = current >= 0 ? current : -1;
      // Nur sperren, was DVhub auch zurueckschreiben kann (Grenzpruefung des
      // Schreibpfads, z. B. > 30 kW an der GX eingestellt; Codex 22.10.).
      const bounds = controlWriteBoundsError('maxDischargeW', snapshot);
      if (bounds) {
        if (!unknownLogged) { unknownLogged = true; pushLog('multi_gx_handoff_skipped', { reason: 'saved_value_not_restorable', maxDischargeW: snapshot, error: bounds.error }, 'warn'); }
        return null;
      }
      saved = snapshot;
      zeroWritten = false;
      try { store?.save?.({ savedMaxDischargeW: saved, at: now() }); } catch (e) {
        pushLog('multi_gx_handoff_store_error', { error: e?.message || String(e) }, 'error');
        saved = null;
        return null;
      }
      lastZeroAt = 0; zeroAttempts = 0;
      setPhase('arming', 'floor_export_request');
      return null;
    }
    if (phase === 'restoring') {
      // Alte Sperr-Bestaetigung verwerfen: ein laufendes Zurueckschreiben kann
      // Akku 1 schon freigegeben haben, waehrend die GX noch die alte 0 meldet
      // (Codex Runde 3, P1). Also neu sperren und neu bestaetigen.
      zeroWritten = false; zeroWrittenAt = 0;
      lastZeroAt = 0; zeroAttempts = 0; restoreWrittenAt = 0; lastRestoreAt = 0; restoreAttempts = 0;
      setPhase('arming', 'floor_export_request');
      return null;
    }
    if (lockConfirmed(cfg)) {
      if (phase === 'arming') setPhase('active', 'main_discharge_blocked');
      return Math.round(Number(requested));
    }
    // 2704 nicht (mehr) 0 bestaetigt → zurueck auf arming, Boden haelt.
    if (phase === 'active') {
      if (current != null && current !== 0) zeroWritten = false;
      setPhase('arming', 'main_discharge_not_blocked');
    }
    return null;
  }

  /**
   * Jeden Auswertungstakt: Sperre schreiben (arming), beenden, wenn eine
   * Bedingung wegfaellt oder keine Anfrage mehr kommt, und den gesicherten
   * Wert zurueckschreiben, sobald Akku 1 frisch ueber dem Boden liegt.
   * @param {(target: string, value: number, source: string) => Promise<object>} applyControlTarget
   */
  async function maintain(applyControlTarget) {
    const cfg = getCfg() || {};
    if (phase === 'arming' || phase === 'active') {
      const why = blocker(cfg);
      if (why) setPhase('restoring', why);
      else if (now() - lastRequestAt > requestGraceMs(cfg)) setPhase('restoring', 'no_export_request');
    }
    if (phase === 'arming') {
      const current = mainMaxDischargeW(cfg);
      // Meldet die GX nach dem Schreiben etwas anderes als 0, gilt die Sperre nicht.
      if (zeroWritten && current != null && current !== 0 && sentAt() > zeroWrittenAt) zeroWritten = false;
      if (!zeroWritten && now() - lastZeroAt >= retryDelayMs(cfg, zeroAttempts)) {
        lastZeroAt = now();
        zeroAttempts += 1;
        // Der Schreibpfad ueberspringt einen unveraenderten Wert (2704 ohne
        // Nachfuehren) — die gemerkte 0 verwerfen, damit wirklich geschrieben
        // wird (Codex 22.10., P2). Ein uebersprungener Schreibvorgang zaehlt nicht.
        if (state.schedule?.lastWrite) delete state.schedule.lastWrite.maxDischargeW;
        const res = await applyControlTarget('maxDischargeW', 0, 'multi_gx_handoff');
        if (res?.ok && !res.skipped) { zeroWritten = true; zeroWrittenAt = now(); }
      }
    }
    if (phase === 'restoring') {
      if (!finite(saved)) { finish(); return; }
      const floorPct = Number(cfg.optimizer?.hardFloorSocPct ?? 5);
      const soc = state.victron?.soc;
      const aboveFloor = fieldFresh('soc', cfg) && finite(soc) && Number(soc) > floorPct + RESTORE_HYSTERESIS_PCT;
      if (aboveFloor) {
        // Fertig erst, wenn die GX den alten Wert NACH dem Zurueckschreiben
        // meldet — sonst bliebe Akku 1 bei verlorenem Befehl gesperrt und die
        // Sicherung waere weg (Codex Runde 2, P2).
        if (restoreWrittenAt > 0 && mainMaxDischargeW(cfg) === saved && sentAt() > restoreWrittenAt) { finish(); return; }
        if (now() - lastRestoreAt >= retryDelayMs(cfg, restoreAttempts)) {
          lastRestoreAt = now();
          restoreAttempts += 1;
          if (restoreAttempts === 4) pushLog('multi_gx_handoff_restore_unconfirmed', { savedMaxDischargeW: saved, attempts: restoreAttempts }, 'warn');
          if (state.schedule?.lastWrite) delete state.schedule.lastWrite.maxDischargeW;
          const res = await applyControlTarget('maxDischargeW', saved, 'multi_gx_handoff_restore');
          const lw = state.schedule?.lastWrite?.maxDischargeW;
          if (res?.ok && !res.skipped && lw && Number(lw.value) === saved) restoreWrittenAt = now();
        }
      }
    }
    publish(cfg);
  }

  function finish() {
    try { store?.clear?.(); } catch (e) { pushLog('multi_gx_handoff_store_error', { error: e?.message || String(e) }, 'error'); }
    const restored = saved;
    saved = null;
    zeroWritten = false;
    zeroWrittenAt = 0;
    restoreWrittenAt = 0; lastRestoreAt = 0; restoreAttempts = 0; zeroAttempts = 0;
    setPhase('off', 'restored');
    pushLog('multi_gx_handoff_restored', { maxDischargeW: restored });
  }

  return { onFloorHold, maintain, status: () => ({ phase, savedMaxDischargeW: saved, since, reason: lastReason }) };
}
