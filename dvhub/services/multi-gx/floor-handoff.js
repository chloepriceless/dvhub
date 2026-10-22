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

const FOLLOWER_MAX_AGE_MS = 15000;
const REQUEST_GRACE_MS = 20000;   // ohne neue Einspeise-Anfrage → beenden
const ZERO_RETRY_MS = 10000;
// Zurueckschreiben erst 3 Prozentpunkte ueber dem Boden: sonst pendelt Akku 1 um
// den Boden, und jede Runde schreibt 2704 zweimal (Flash der GX).
const RESTORE_HYSTERESIS_PCT = 3;

const finite = (v) => v != null && v !== '' && Number.isFinite(Number(v));

/**
 * @param {object} deps
 * @param {() => object} deps.getCfg
 * @param {object} deps.state       Laufzeit-Zustand (state.victron, state.multiGx, state.ctrl)
 * @param {Function} [deps.pushLog]
 * @param {() => number} [deps.now]
 * @param {{load: () => any, save: (v: object) => void, clear: () => void}} [deps.store]
 */
export function createFloorHandoff({ getCfg, state, pushLog = () => {}, now = Date.now, store = null } = {}) {
  let phase = 'off';
  let saved = null;
  let since = 0;
  let lastRequestAt = 0;
  let lastZeroAt = 0;
  let lastReason = null;
  let unknownLogged = false;
  let zeroWritten = false;

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
    const blocked = (phase === 'active' || phase === 'restoring') && zeroWritten && mainMaxDischargeW(cfg) === 0;
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
  function onFloorHold({ target, requested }) {
    if (target !== 'gridSetpointW' || !finite(requested) || Number(requested) >= 0) return null;
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
      saved = current > 0 ? current : -1;
      zeroWritten = false;
      try { store?.save?.({ savedMaxDischargeW: saved, at: now() }); } catch (e) {
        pushLog('multi_gx_handoff_store_error', { error: e?.message || String(e) }, 'error');
        saved = null;
        return null;
      }
      lastZeroAt = 0;
      setPhase('arming', 'floor_export_request');
      return null;
    }
    if (phase === 'restoring') { lastZeroAt = 0; setPhase('arming', 'floor_export_request'); return null; }
    if (current === 0 && zeroWritten) {
      if (phase === 'arming') setPhase('active', 'main_discharge_blocked');
      return Math.round(Number(requested));
    }
    // 2704 nicht (mehr) 0 bestaetigt → zurueck auf arming, Boden haelt.
    if (phase === 'active') setPhase('arming', 'main_discharge_not_blocked');
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
      else if (now() - lastRequestAt > REQUEST_GRACE_MS) setPhase('restoring', 'no_export_request');
    }
    if (phase === 'arming' && (!zeroWritten || mainMaxDischargeW(cfg) !== 0) && now() - lastZeroAt >= ZERO_RETRY_MS) {
      lastZeroAt = now();
      const res = await applyControlTarget('maxDischargeW', 0, 'multi_gx_handoff');
      if (res?.ok) zeroWritten = true;
    }
    if (phase === 'restoring') {
      if (!finite(saved)) { finish(); return; }
      const floorPct = Number(cfg.optimizer?.hardFloorSocPct ?? 5);
      const soc = state.victron?.soc;
      const aboveFloor = fieldFresh('soc', cfg) && finite(soc) && Number(soc) > floorPct + RESTORE_HYSTERESIS_PCT;
      if (aboveFloor) {
        const res = await applyControlTarget('maxDischargeW', saved, 'multi_gx_handoff_restore');
        const lw = state.schedule?.lastWrite?.maxDischargeW;
        if (res?.ok && lw && Number(lw.value) === saved) { finish(); return; }
      }
    }
    publish(cfg);
  }

  function finish() {
    try { store?.clear?.(); } catch (e) { pushLog('multi_gx_handoff_store_error', { error: e?.message || String(e) }, 'error'); }
    const restored = saved;
    saved = null;
    zeroWritten = false;
    setPhase('off', 'restored');
    pushLog('multi_gx_handoff_restored', { maxDischargeW: restored });
  }

  return { onFloorHold, maintain, status: () => ({ phase, savedMaxDischargeW: saved, since, reason: lastReason }) };
}
