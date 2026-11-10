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
 * Seit 1.0.10 (Merge 10.11.2026):
 *  - Not-Halt (Christin 06.11.2026: DVhubs eigene Steuersignale EINMAL
 *    zuruecknehmen, danach keine Writes): die Sperre gilt als DVhubs Signal.
 *    Im Not-Halt schreibt DVhub den gesicherten Wert genau einmal zurueck,
 *    und zwar nur im ersten Takt des Not-Halts, wenn der Entlade-Boden es dann
 *    zulaesst (Ladestand frisch ueber dem harten Boden — darunter hielte er
 *    2704 ohnehin auf 0), ohne Wiederholung. Laesst der Boden es beim Eintritt
 *    nicht zu, schreibt DVhub im Not-Halt gar nicht (als ob aus, Christin
 *    10.11.2026) und nimmt die Sperre erst nach dem Not-Halt zurueck. Eine
 *    Rueckmeldung beendet die Uebergabe (nur lesen). Bleibt sie aus,
 *    schreibt DVhub erst nach dem Not-Halt wieder.
 *  - Netzanschluss-Waechter / Akku-Hilfe: braucht der Anschluss den Akku
 *    (Lasten gekuerzt, Akku-Hilfe angefordert), sperrt DVhub Akku 1 nicht und
 *    nimmt eine stehende Sperre ohne die 3-Punkte-Schwelle zurueck.
 *  - Nur Victron (2704 ist die ESS-Entladegrenze; bei anderen Herstellern
 *    hebt der Netzanschluss dieselbe Grenze an, „Akku zuerst“) und nicht,
 *    solange Peak Shaving eine Sperre aufgehoben hat (sonst sicherte DVhub
 *    seinen eigenen Freigabewert statt der Sperre des Betreibers).
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
export function createFloorHandoff({ getCfg, state, pushLog = () => {}, now = Date.now, store = null, transportType = () => 'modbus', batteryNeeded = () => false, readExactMaxDischargeW = null } = {}) {
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
  // Hat DVhub seit dem Sichern 0 zu schreiben versucht? Nur dann gibt es im
  // Not-Halt etwas zurueckzunehmen (nach einem Neustart: ja).
  let zeroTried = false;
  // Not-Halt: der eine Rueckschreibversuch ist verbraucht (bis zum Aufheben).
  let stopRestoreUsed = false;
  // Waehrend genau dieses Writes laesst das Not-Halt-Tor den Wert durch.
  let stopRestoreValue = null;
  // Modbus: eindeutige Ruecklesung der Entladegrenze (Victron 2720, int32 in W;
  // Codex db0b6c2d P1). 2704 zeigt „unbegrenzt“ (−1) als 0 — eine Sperre gilt
  // ueber Modbus erst, wenn 2720 nach DVhubs Schreiben 0 meldet.
  // exact = { value, at } | null; exactUnsupported = GX kennt 2720 nicht.
  let exact = null;
  let exactUnsupported = false;
  let exactWantedAt = 0;

  try {
    const persisted = store?.load?.();
    if (persisted && finite(persisted.savedMaxDischargeW)) {
      saved = Number(persisted.savedMaxDischargeW);
      phase = 'restoring';
      zeroTried = true;
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
  const isMqtt = () => transportType() === 'mqtt';
  // Ein gescheiterter Leseversuch macht auch die alte Lesung ungueltig (Codex d7f58676, P1).
  const exactFresh = (cfg, after = 0) => exact != null && exact.error !== true && exact.at > after && now() - exact.at <= maxAgeMs(cfg);
  const lockConfirmed = (cfg) => zeroWritten
    && mainMaxDischargeW(cfg) === 0
    && sentAt() > zeroWrittenAt
    && (isMqtt() || (exactFresh(cfg, zeroWrittenAt) && exact.value === 0));
  // Zuletzt geschriebene Entladegrenze (gleich welche Quelle): ein Messwert von
  // davor zeigt womoeglich noch einen alten Wert (z. B. die Freigabe von Peak
  // Shaving, Codex db0b6c2d P1).
  const lastWriteAt = () => Number(state.schedule?.lastWrite?.maxDischargeW?.at) || 0;
  publish();

  // Braucht der Netzanschluss den Akku? Ein Fehler der Abfrage zaehlt als ja —
  // im Zweifel nicht sperren.
  const needsBattery = () => { try { return batteryNeeded() === true; } catch { return true; } };

  /** Warum die Uebergabe gerade nicht erlaubt ist, sonst null. */
  function blocker(cfg) {
    if (cfg.multiGx?.exportHandoffAtFloor !== true) return 'disabled';
    if (!resolveMultiGxOptions(cfg).enabled) return 'multi_gx_off';
    if (String(cfg.manufacturer || 'victron') !== 'victron') return 'manufacturer_unsupported';
    if (!cfg.controlWrite?.maxDischargeW?.enabled) return 'max_discharge_not_writable';
    const ctrl = state.ctrl || {};
    if (ctrl.discretionaryWritesPaused === true) return 'emergency_stop';
    if (ctrl.forcedOff === true || ctrl.negativePriceActive === true) return 'export_blocked';
    if (needsBattery()) return 'grid_needs_battery';
    if (!isMqtt() && exactUnsupported) return 'max_discharge_not_verifiable';
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
  function onFloorHold({ target, requested, original = requested, source }) {
    if (target !== 'gridSetpointW' || !finite(requested) || Number(requested) >= 0) return null;
    if (!isHandoffRequest(source, original)) return null;
    const cfg = getCfg() || {};
    const why = blocker(cfg);
    if (why) return null;
    // Dauerhafte Handvorgabe: unter schedule.manualOverrideMinSocPct haelt der
    // Auswertungstakt sie selbst auf 0 (T-0002, manual_override_soc_floor) —
    // die Anfrage kaeme nie wieder, Akku 1 bliebe gesperrt (Codex db0b6c2d P2).
    if ((source === 'manual_override_persistent' || source === 'api_manual_write')
        && state.schedule?.manualOverride?.gridSetpointW?.persistent === true) {
      const persistFloor = Number(cfg.schedule?.manualOverrideMinSocPct ?? 10);
      const soc = Number(state.victron?.soc);
      if (!Number.isFinite(soc) || soc <= persistFloor) return null;
    }
    lastRequestAt = now();
    const current = mainMaxDischargeW(cfg);
    if (phase === 'off') {
      // Peak Shaving hat eine Sperre des Betreibers gerade aufgehoben: an der GX
      // steht DVhubs Freigabewert, nicht der des Betreibers — den zu sichern
      // und spaeter zurueckzuschreiben hoebe die Sperre dauerhaft auf.
      if (state.ctrl?._peakShaving?.discharge?.phase === 'lifted') return null;
      // Ohne frisch gelesenen Ausgangswert kein Sperren — sonst wuesste DVhub
      // nicht, was es spaeter zuruecksetzen soll.
      if (current == null) {
        if (!unknownLogged) { unknownLogged = true; pushLog('multi_gx_handoff_skipped', { reason: 'max_discharge_unknown' }, 'warn'); }
        return null;
      }
      // Messwert muss nach dem letzten Schreiben der Entladegrenze liegen.
      if (!(sentAt() > lastWriteAt())) return null;
      let base = current;
      if (!isMqtt()) {
        // Ohne eindeutige Ruecklesung (alter GX ohne 2720) kann DVhub die
        // Sperre nie bestaetigen — dann gar nicht erst sichern.
        if (exactUnsupported) {
          if (!unknownLogged) { unknownLogged = true; pushLog('multi_gx_handoff_skipped', { reason: 'max_discharge_not_verifiable' }, 'warn'); }
          return null;
        }
        // 2704 = 0: erst 2720 sagt, ob gesperrt (0) oder unbegrenzt (−1); der
        // naechste Takt liest es (maintain), bis dahin haelt der Boden.
        if (current === 0) {
          exactWantedAt = now();
          if (!exactFresh(cfg, lastWriteAt())) return null;
          base = exact.value < 0 ? -1 : exact.value;
        }
      }
      unknownLogged = false;
      // Negative Werte heissen unbegrenzt: spaeter kommt -1 (raw 32767) zurueck.
      // Gesperrt gilt erst nach DVhubs eigenem Schreiben von 0 (zeroWritten).
      // Ueber MQTT kommt der Wert in Watt, 0 heisst dort eindeutig gesperrt und
      // bleibt 0 (Codex Runde 2). Ueber Modbus ist eine aus 2704 gelesene 0
      // mehrdeutig: bewusste Sperre oder die Werkseinstellung „unbegrenzt“ —
      // Victron rundet −1 W × 0,1 auf 0 (mappings.cpp convertFromDbus). Oben
      // entscheidet 2720; meldet auch 2720 eine 0, ist es eine Sperre des
      // Betreibers — keine Uebergabe, DVhub wuerde sie sonst aufheben (Codex Runde 4).
      if (base === 0 && !isMqtt()) {
        if (!unknownLogged) { unknownLogged = true; pushLog('multi_gx_handoff_skipped', { reason: 'max_discharge_locked' }, 'warn'); }
        return null;
      }
      const snapshot = base >= 0 ? base : -1;
      // Nur sperren, was DVhub auch zurueckschreiben kann (Grenzpruefung des
      // Schreibpfads, z. B. > 30 kW an der GX eingestellt; Codex 22.10.).
      const bounds = controlWriteBoundsError('maxDischargeW', snapshot);
      if (bounds) {
        if (!unknownLogged) { unknownLogged = true; pushLog('multi_gx_handoff_skipped', { reason: 'saved_value_not_restorable', maxDischargeW: snapshot, error: bounds.error }, 'warn'); }
        return null;
      }
      saved = snapshot;
      zeroWritten = false;
      zeroTried = false;
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
  async function readExact() {
    if (isMqtt() || typeof readExactMaxDischargeW !== 'function') {
      if (!isMqtt()) exactUnsupported = true;
      return;
    }
    try {
      const r = await readExactMaxDischargeW();
      if (r?.unsupported) { exactUnsupported = true; exact = null; return; }
      if (r && finite(r.value)) exact = { value: Number(r.value), at: now() };
    } catch (e) {
      // Lesefehler: alter Wert veraltet von selbst, die Sperre gilt dann nicht.
      if (!exact?.error) pushLog('multi_gx_handoff_read_error', { error: e?.message || String(e) }, 'warn');
      exact = exact ? { ...exact, error: true } : null;
    }
  }

  async function maintain(applyControlTarget) {
    const cfg = getCfg() || {};
    // 2720 nur lesen, solange die Uebergabe laeuft oder gerade angefragt ist.
    if (!exactUnsupported && (phase === 'arming' || phase === 'active'
        || (phase === 'off' && exactWantedAt > 0 && now() - exactWantedAt <= requestGraceMs(cfg)))) {
      await readExact();
    }
    if (phase === 'arming' || phase === 'active') {
      const why = blocker(cfg);
      if (why) setPhase('restoring', why);
      else if (now() - lastRequestAt > requestGraceMs(cfg)) setPhase('restoring', 'no_export_request');
    }
    if (phase === 'arming') {
      const current = mainMaxDischargeW(cfg);
      // Meldet die GX nach dem Schreiben etwas anderes als 0, gilt die Sperre nicht.
      if (zeroWritten && current != null && current !== 0 && sentAt() > zeroWrittenAt) zeroWritten = false;
      // Modbus: 2720 nach dem Schreiben ungleich 0 (z. B. an der GX auf
      // „unbegrenzt“ gestellt, 2704 zeigt weiter 0) — die Sperre gilt nicht.
      if (zeroWritten && !isMqtt() && exactFresh(cfg, zeroWrittenAt) && exact.value !== 0) zeroWritten = false;
      if (!zeroWritten && now() - lastZeroAt >= retryDelayMs(cfg, zeroAttempts)) {
        lastZeroAt = now();
        zeroAttempts += 1;
        // Der Schreibpfad ueberspringt einen unveraenderten Wert (2704 ohne
        // Nachfuehren) — die gemerkte 0 verwerfen, damit wirklich geschrieben
        // wird (Codex 22.10., P2). Ein uebersprungener Schreibvorgang zaehlt nicht.
        if (state.schedule?.lastWrite) delete state.schedule.lastWrite.maxDischargeW;
        zeroTried = true;
        const res = await applyControlTarget('maxDischargeW', 0, 'multi_gx_handoff');
        if (res?.ok && !res.skipped) { zeroWritten = true; zeroWrittenAt = now(); }
      }
    }
    const paused = state.ctrl?.discretionaryWritesPaused === true;
    if (!paused) stopRestoreUsed = false;
    if (phase === 'restoring') {
      if (!finite(saved)) { finish(); return; }
      // Nie eine 0 zu schreiben versucht (z. B. alter GX ohne 2720, Bedingung
      // schon vorher weggefallen): nichts zurueckzunehmen — die Sicherung
      // verwerfen, sonst ueberschriebe sie spaeter eine neue Einstellung des
      // Betreibers (Codex d7f58676, P2).
      if (!zeroTried) { finish('not_locked'); return; }
      const floorPct = Number(cfg.optimizer?.hardFloorSocPct ?? 5);
      const soc = state.victron?.soc;
      const socOk = fieldFresh('soc', cfg) && finite(soc)
        && state.victron?.freeze?.active !== true && state.victron?.sourceMismatch?.active !== true;
      // Ueber dem harten Boden laesst T-0075 den Wert durch (darunter haelt er 0).
      const aboveHardFloor = socOk && Number(soc) > floorPct;
      // Schwelle immer zwischen Boden und 100 % (Boden bis 99 % erlaubt; Codex Runde 5).
      const restoreAbovePct = Math.min(floorPct + RESTORE_HYSTERESIS_PCT, (floorPct + 100) / 2);
      // Braucht der Netzanschluss den Akku, gilt die Schwelle nicht.
      const aboveFloor = socOk && (Number(soc) > restoreAbovePct || (aboveHardFloor && needsBattery()));
      const confirmed = restoreWrittenAt > 0 && mainMaxDischargeW(cfg) === saved && sentAt() > restoreWrittenAt;
      if (paused) {
        // Not-Halt: nur lesen — ausser dem einen Rueckschreibversuch.
        if (confirmed) { finish(); return; }
        // Die eine Entscheidung faellt im ersten Takt des Not-Halts („als ob die
        // Kiste aus ist“, Christin 10.11.2026): darf T-0075 den Wert jetzt
        // durchlassen (frischer Ladestand ueber dem harten Boden), genau einmal
        // zurueckschreiben. Sonst gar nicht im Not-Halt — Akku 1 bleibt gesperrt,
        // wie bei ausgeschaltetem DVhub (sicher: er entlaedt nicht unter den
        // Boden), und das normale Zurueckschreiben nach dem Not-Halt nimmt die
        // Sperre zurueck. Kein spaeterer Write mitten im Not-Halt.
        if (!stopRestoreUsed) {
          stopRestoreUsed = true;
          if (!aboveHardFloor) {
            pushLog('multi_gx_handoff_stop_deferred', { savedMaxDischargeW: saved, soc: finite(soc) ? Number(soc) : null, floorPct, reason: socOk ? 'below_hard_floor' : 'soc_unknown' }, 'warn');
            publish(cfg);
            return;
          }
          if (state.schedule?.lastWrite) delete state.schedule.lastWrite.maxDischargeW;
          stopRestoreValue = saved;
          let res;
          try { res = await applyControlTarget('maxDischargeW', saved, 'multi_gx_handoff_stop'); } finally { stopRestoreValue = null; }
          const lw = state.schedule?.lastWrite?.maxDischargeW;
          if (res?.ok && !res.skipped && lw && Number(lw.value) === saved) restoreWrittenAt = now();
          pushLog('multi_gx_handoff_stop_restore', { savedMaxDischargeW: saved, ok: res?.ok === true, error: res?.error || null }, res?.ok ? 'info' : 'warn');
        }
        publish(cfg);
        return;
      }
      if (aboveFloor) {
        // Fertig erst, wenn die GX den alten Wert NACH dem Zurueckschreiben
        // meldet — sonst bliebe Akku 1 bei verlorenem Befehl gesperrt und die
        // Sicherung waere weg (Codex Runde 2, P2).
        if (confirmed) { finish(); return; }
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

  // reason 'restored' = GX meldet den alten Wert; 'not_locked' = vor dem ersten
  // Sperrversuch beendet, es gab nichts zurueckzunehmen.
  function finish(reason = 'restored') {
    try { store?.clear?.(); } catch (e) { pushLog('multi_gx_handoff_store_error', { error: e?.message || String(e) }, 'error'); }
    const restored = saved;
    saved = null;
    zeroWritten = false;
    zeroWrittenAt = 0;
    zeroTried = false;
    restoreWrittenAt = 0; lastRestoreAt = 0; restoreAttempts = 0; zeroAttempts = 0;
    setPhase('off', reason);
    if (reason === 'restored') pushLog('multi_gx_handoff_restored', { maxDischargeW: restored });
  }

  /**
   * Not-Halt-Tor (schedule-eval applyControlTarget): true nur waehrend des
   * einen Rueckschreibversuchs und nur fuer genau den gesicherten Wert.
   */
  function isStopRestore(value) {
    return stopRestoreValue != null && finite(value) && Number(value) === stopRestoreValue;
  }

  return { onFloorHold, maintain, isStopRestore, status: () => ({ phase, savedMaxDischargeW: saved, since, reason: lastReason }) };
}
