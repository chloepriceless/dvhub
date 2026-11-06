/**
 * EOS → evcc: reicht EOS' E-Auto-Plan an einen evcc-Ladepunkt weiter.
 *
 * EOS plant das Fahrzeug (optimizer.eosOptimizeEv) als zweiten Speicher mit und
 * gibt je Slot `genetic_ev_charge_factor` aus — den Anteil an der maximalen
 * Ladeleistung (optimizer.evMaxChargeW), gerastert auf die `charge_rates` des
 * Fahrzeugs. Diese Bruecke uebersetzt den Faktor des laufenden Slots in einen
 * evcc-Befehl fuer den gewaehlten Ladepunkt:
 *
 *   Faktor > 0  → Laden:  mode=now + maxcurrent = W ÷ (Spannung × Phasen)
 *   Faktor = 0  → Stopp:  mode=optimizer.evStopMode (Standard 'off')
 *
 *   kein E-Auto-Wert → Stopp (evcc hoert nur auf DVhub, laedt nie selbst los)
 *
 * Geschrieben wird bei einem Wechsel des Befehls (Slotgrenze oder neuer Plan)
 * und wenn evcc von aussen auf einen anderen Modus gestellt wurde — dann setzt
 * der naechste Takt unseren Modus erneut (Log `eos_evcc_mode_corrected`).
 *
 * Sofort laden (Override): „jetzt mit X kW laden, egal was EOS plant“. Gilt
 * bis zur gewaehlten Uhrzeit, bis zum Abstecken oder bis zum Beenden — auch
 * wenn EOS nicht laeuft oder die EOS-Weitergabe aus ist (der Plan wird dann
 * gar nicht gelesen). Der Override wird gespeichert und ueberlebt einen
 * DVhub-Neustart.
 */
import { safeInterval } from '../safe-async.js';
import { WALLBOX_TYPES } from '../wallbox/types.js';

const DEFAULT_VOLTAGE_V = 230;
const STOP_MODES = ['off', 'pv', 'minpv'];
export const CHARGER_TYPES = WALLBOX_TYPES;

/**
 * Nennleistungen meinen ganze Ampere: 11 kW an 3 × 230 V sind rechnerisch
 * 15,94 A, gemeint ist die 16-A-Stufe (3,7 kW einphasig: 16,09 A). Liegt der
 * Wert knapp (< 0,1 A) unter einer ganzen Zahl, gilt die ganze Zahl — sonst
 * schnitt die Wallbox auf 15 A ab und lud 10,35 statt 11 kW.
 */
export function snapToWholeAmps(amps) {
  const up = Math.ceil(amps);
  return up - amps < 0.1 ? up : amps;
}

/** Einstellungen der Bruecke aus der Config, mit Standardwerten. */
export function resolveEvccBridgeConfig(cfg) {
  const opt = cfg?.optimizer || {};
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  const phases = Number(opt.evPhases) === 1 ? 1 : 3;
  const minCurrentA = num(opt.evMinCurrentA, 6);
  const maxChargeW = num(opt.evMaxChargeW, 5000);
  return {
    enabled: opt.eosOptimizeEv === true && opt.evEvccControl === true,
    loadpoint: Number.isInteger(Number(opt.evEvccLoadpoint)) && Number(opt.evEvccLoadpoint) >= 1
      ? Number(opt.evEvccLoadpoint) : 1,
    phases,
    voltageV: DEFAULT_VOLTAGE_V,
    minCurrentA,
    // Die Obergrenze folgt aus der Ladeleistung, die EOS kennt — sonst koennte
    // evcc mehr ziehen, als EOS eingeplant hat.
    maxCurrentA: Math.max(minCurrentA, snapToWholeAmps(maxChargeW / (DEFAULT_VOLTAGE_V * phases))),
    maxChargeW,
    stopMode: STOP_MODES.includes(opt.evStopMode) ? opt.evStopMode : 'off',
    // Wohin der Befehl geht: evcc (Standard) oder direkt an die Wallbox.
    charger: CHARGER_TYPES.includes(cfg?.wallbox?.type) ? cfg.wallbox.type : 'evcc'
  };
}

/**
 * Ladeleistung → Ladestrom je Phase. evcc kann nicht unter den Mindeststrom
 * regeln: plant EOS weniger, laedt der Ladepunkt mit dem Mindeststrom (EOS will
 * laden; ganz auszulassen waere die groessere Abweichung vom Plan).
 */
export function powerToCurrentA(powerW, bc) {
  const raw = snapToWholeAmps(powerW / (bc.voltageV * bc.phases));
  const clamped = Math.min(bc.maxCurrentA, Math.max(bc.minCurrentA, raw));
  return Math.round(clamped * 10) / 10;
}

/**
 * Plan je Slot aus den Zeilen von eosAdapter.getOptimizationSolution.
 * @returns {Array<{ts:number,endTs:number,chargeFactor:number|null,chargePowerW:number|null,currentA:number|null,action:'charge'|'stop'|null,evSocPct:number|null}>}
 */
export function buildEvPlan(solution, bc) {
  const rows = Array.isArray(solution?.rows) ? solution.rows : [];
  const slotMs = (Number(solution?.slotMinutes) > 0 ? Number(solution.slotMinutes) : 15) * 60_000;
  return rows.map((row) => {
    const ts = Date.parse(row.ts_utc);
    const factor = typeof row.evChargeFactor === 'number' && Number.isFinite(row.evChargeFactor)
      ? row.evChargeFactor : null;
    const chargePowerW = factor === null ? null : Math.round(factor * bc.maxChargeW);
    let action = null;
    if (factor !== null) action = factor > 0 ? 'charge' : 'stop';
    return {
      ts,
      endTs: ts + slotMs,
      chargeFactor: factor,
      chargePowerW,
      currentA: action === 'charge' ? powerToCurrentA(chargePowerW, bc) : null,
      action,
      evSocPct: typeof row.evSocPct === 'number' ? row.evSocPct : null
    };
  }).filter((slot) => Number.isFinite(slot.ts));
}

/**
 * §14a EnWG: Leistungsgrenze der Steuerbox (EEBUS LPC) auf den Ladebefehl
 * anwenden. capW = für die Wallbox freigegebene Leistung oder null (keine
 * Grenze). Liegt die Grenze unter dem Mindeststrom, wird nicht geladen — ein
 * Laden mit Mindeststrom würde sie überschreiten.
 */
export function applyGridCap(slot, bc, capW) {
  if (capW == null || !Number.isFinite(Number(capW)) || slot?.action !== 'charge') return slot;
  const capA = Number(capW) / (bc.voltageV * bc.phases);
  if (capA < bc.minCurrentA) {
    return { ...slot, action: 'stop', currentA: null, gridCapW: Number(capW) };
  }
  const currentA = Math.min(Number(slot.currentA), Math.floor(capA * 10) / 10);
  return currentA === slot.currentA ? slot : { ...slot, currentA, gridCapW: Number(capW) };
}

/** Kleinste Ladeleistung, die der Ladepunkt kann (Mindeststrom × Phasen). */
export function minChargeW(bc) {
  return Math.ceil(bc.minCurrentA * bc.voltageV * bc.phases);
}

/**
 * Erlaubte Override-Leistung. Liegt der Mindeststrom ueber evMaxChargeW (z.B.
 * 32 A bei 5 kW), laedt die Box trotzdem mit dem Mindeststrom — dann ist das
 * auch die Obergrenze, damit Anzeige und Wirklichkeit uebereinstimmen.
 */
export function overrideLimits(bc) {
  const minPowerW = minChargeW(bc);
  return { minPowerW, maxPowerW: Math.max(minPowerW, bc.maxChargeW) };
}

/**
 * Override-Anfrage pruefen. Zwei Arten:
 *   kind 'charge' (Standard, „Sofort laden“): `powerW` wird auf
 *     [Mindestleistung, evMaxChargeW] begrenzt;
 *   kind 'stop' („Laden stoppen“, 2026-10-15): die Wallbox laedt nicht, egal
 *     was EOS plant — fuer jede angebundene Wallbox.
 * `untilMs` null = bis zum Abstecken bzw. Beenden.
 * @returns {{ok:true, override:object}|{ok:false, error:string}}
 */
export const OVERRIDE_KINDS = Object.freeze(['charge', 'stop']);
export function normalizeOverride({ kind = 'charge', powerW, untilMs = null }, bc, nowMs) {
  if (!OVERRIDE_KINDS.includes(kind)) return { ok: false, error: `kind must be ${OVERRIDE_KINDS.join('|')}` };
  if (untilMs != null && (!Number.isFinite(Number(untilMs)) || Number(untilMs) <= nowMs)) {
    return { ok: false, error: 'until must lie in the future' };
  }
  if (untilMs != null && Number(untilMs) > nowMs + 48 * 3600_000) {
    return { ok: false, error: 'until must be within 48 h' };
  }
  const until = untilMs == null ? null : new Date(Number(untilMs)).toISOString();
  if (kind === 'stop') {
    return { ok: true, override: { kind: 'stop', powerW: 0, requestedW: 0, startedAt: new Date(nowMs).toISOString(), until, seenConnected: false } };
  }
  const p = Number(powerW);
  if (!Number.isFinite(p) || p <= 0) return { ok: false, error: 'powerW must be > 0' };
  const lim = overrideLimits(bc);
  const clampedW = Math.round(Math.min(lim.maxPowerW, Math.max(lim.minPowerW, p)));
  return {
    ok: true,
    override: {
      kind: 'charge',
      powerW: clampedW,
      requestedW: Math.round(p),
      startedAt: new Date(nowMs).toISOString(),
      until,
      seenConnected: false
    }
  };
}

// Ist die EOS-Loesung voruebergehend nicht abrufbar (EOS rechnet gerade und
// antwortet nicht binnen Timeout), gilt der zuletzt abgerufene Plan weiter —
// hoechstens so lange nach dem letzten erfolgreichen Abruf. EOS rechnet alle
// 15 min (ein Lauf 2–5 min); 60 min sind reichlich Puffer, ohne einem
// stundenalten Plan zu folgen, falls EOS wirklich weg ist.
export const PLAN_GRACE_MS = 60 * 60_000;

/** Slot, der `nowMs` enthaelt — oder null (Plan veraltet / noch keiner). */
export function slotAt(plan, nowMs) {
  return plan.find((slot) => slot.ts <= nowMs && nowMs < slot.endTs) || null;
}

/**
 * @param {object} deps
 * @param {() => object} deps.getCfg
 * @param {(limit:number) => Promise<object|null>} deps.getSolution   eosAdapter.getOptimizationSolution
 * @param {(cfg:object, bc:object) => object} deps.getCharger  Adapter (services/wallbox/adapters.js)
 * @param {() => boolean} [deps.isProActive]
 * @param {() => number|null} [deps.getGridCapW]  §14a-Grenze für die Wallbox (EEBUS), null = keine
 * @param {() => boolean} [deps.isPaused]  Not-Halt aktiv (state.ctrl.discretionaryWritesPaused)
 * @param {(event:string, data?:object) => void} [deps.pushLog]
 * @param {() => number} [deps.now]
 * @param {() => object|null} [deps.loadOverride]  gespeicherter Override (Neustart)
 * @param {(ov:object|null) => void} [deps.saveOverride]
 */
// Wallboxen, deren release() nichts am Ladestrom ändert.
const RELEASE_NOOP_TYPES = Object.freeze(['evcc', 'openwb']);

export function createEosEvccBridge(deps) {
  const {
    getCfg, getSolution, getCharger: rawGetCharger,
    getGridCapW = () => null,
    isProActive = () => true,
    isPaused = () => false,
    pushLog = () => {},
    now = () => Date.now(),
    loadOverride = () => null,
    saveOverride = () => {}
  } = deps;

  let timer = null;
  let lastSent = null;       // { key, action, currentA, loadpoint, mode, at }
  let override = null;       // { kind, powerW, requestedW, startedAt, until, seenConnected, prevMode? }

  // Ladebefehle, die ohne Quittung blieben (Timeout) — sie können trotzdem
  // gewirkt haben. Je Ziel (Wallbox + Ladepunkt); jeder später bestätigte
  // Befehl an dasselbe Ziel löscht den Eintrag. Der Not-Halt prüft solche
  // Ziele frisch (Codex 4bf1eb18 und 8bf189b7, P1/P2).
  const unconfirmedCharges = new Map(); // targetKey → { charger, loadpoint, action, mode, override, at }
  const targetKey = (bc) => `${bc.charger}:${bc.loadpoint}`;
  // Jeder Weg zur Wallbox geht hierdurch: Ergebnis von charge/stop/release je
  // Ziel festhalten. release() an evcc tut nichts — es bestätigt keinen Stopp.
  function getCharger(cfg, bc) {
    const c = rawGetCharger(cfg, bc);
    if (!c || typeof c !== 'object') return c;
    const key = targetKey({ charger: bc?.charger ?? c.type, loadpoint: bc?.loadpoint });
    const wrapped = Object.create(c);
    if (typeof c.charge === 'function') {
      wrapped.charge = async (...a) => {
        const r = await c.charge(...a);
        if (r?.ok) unconfirmedCharges.delete(key);
        else {
          unconfirmedCharges.set(key, {
            charger: bc?.charger ?? c.type, loadpoint: bc?.loadpoint, action: 'charge', mode: 'now',
            override: override != null && override.kind !== 'stop', at: new Date(now()).toISOString()
          });
        }
        return r;
      };
    }
    if (typeof c.stop === 'function') {
      wrapped.stop = async (...a) => { const r = await c.stop(...a); if (r?.ok) unconfirmedCharges.delete(key); return r; };
    }
    // release() gibt die Box an ihre eigene Regelung zurück. Bei evcc und
    // openWB ändert es nichts am Strom — dort bleibt eine unquittierte Ladung
    // stehen (Codex 180dbd00, P1); bei den übrigen Boxen nimmt es DVhubs
    // Vorgabe wirklich weg — dann ist die Ladung nicht mehr DVhubs (Codex 009826e9, P2).
    if (typeof c.release === 'function') {
      wrapped.release = async (...a) => {
        const r = await c.release(...a);
        if (r?.ok && !RELEASE_NOOP_TYPES.includes(c.type)) unconfirmedCharges.delete(key);
        return r;
      };
    }
    return wrapped;
  }
  let lastError = null;
  let lastPlan = [];
  let lastGeneratedAt = null;
  let lastPlanFetchedAt = 0;  // letzter ERFOLGREICHER Abruf der EOS-Loesung
  let usingStalePlan = false; // gerade Rueckfall auf den letzten Plan (fuer Log/Status)
  let lastTickAt = 0;
  // Ein Takt bzw. eine Override-Aenderung zur Zeit. Der 30-s-Takt ueberspringt,
  // wenn schon etwas laeuft; Knopfdruck und erzwungene Takte warten.
  let inflight = null;
  // evcc-Modus, der nach dem Ende eines pausierten „Sofort laden“ (Grenze oder
  // Not-Halt) noch zurückgestellt werden muss. Liegt ohne Override in derselben
  // Datei ({ kind: 'restore', mode }), damit er einen Neustart übersteht.
  let pendingRestore = null;
  try {
    const saved = loadOverride();
    if (saved && (saved.kind === 'stop' || Number(saved.powerW) > 0)) override = saved;
    // Unbestätigter Stopp bleibt unbestätigt (Codex 148df991, P2).
    else if (saved?.kind === 'restore' && typeof saved.mode === 'string') {
      pendingRestore = {
        mode: saved.mode, stopped: saved.stopped === true,
        loadpoint: Number.isInteger(Number(saved.loadpoint)) && Number(saved.loadpoint) >= 1 ? Number(saved.loadpoint) : null,
      };
    }
  } catch { /* kaputte Datei: ohne Override weiter */ }
  const isStopOverride = () => override?.kind === 'stop';

  function persistOverride() {
    const value = override ?? (pendingRestore
      ? { kind: 'restore', mode: pendingRestore.mode, stopped: pendingRestore.stopped === true, loadpoint: pendingRestore.loadpoint ?? null }
      : null);
    try { saveOverride(value); } catch (e) { pushLog('ev_override_persist_error', { error: e?.message || String(e) }); }
  }
  function setPendingRestore(value) {
    pendingRestore = value;
    persistOverride();
  }

  const commandKey = (bc, slot) => (slot.action === 'charge'
    ? `${bc.charger}:${bc.loadpoint}:charge:${slot.currentA}`
    : `${bc.charger}:${bc.loadpoint}:stop:${bc.stopMode}`);

  // Direkt angesteuerte Wallboxen kennen keine evcc-Modi: "Stopp = Aus" heisst
  // nicht laden, "Stopp = PV/Min+PV" heisst Vorgabe zuruecknehmen — dann
  // regelt die Box selbst (z.B. OpenEVSE-PV-Divert).
  async function send(charger, bc, slot) {
    if (slot.action === 'charge') return charger.charge(slot.currentA);
    if (charger.type !== 'evcc' && bc.stopMode !== 'off') return charger.release();
    return charger.stop();
  }

  // Ein Override hat einen Befehl durchgebracht: er trägt den vorgemerkten
  // Modus jetzt als prevMode und stellt ihn bei seinem Ende her.
  function handOff() {
    if (pendingRestore && override?.inheritsRestore === true) setPendingRestore(null);
  }

  // Sicherheits-Pause (§14a oder Netzanschluss: Grenze unter dem Mindeststrom):
  // wirklich nicht laden — evcc im Modus „aus“, eine direkte Box mit stop(),
  // egal welcher Stopp-Modus eingestellt ist. „pv“/„minpv“ lüde sonst weiter
  // bzw. gäbe die Box an ihre eigene Regelung zurück (Codex b2f1ccd, P1).
  function hardStopper(cfg, bc, charger) {
    return charger.type === 'evcc' ? getCharger(cfg, { ...bc, stopMode: 'off' }) : charger;
  }

  // Beim Abschalten die eigene Vorgabe zuruecknehmen — sonst bliebe z.B. ein
  // "disabled"-Claim in der OpenEVSE stehen und das Auto laedt nie wieder.
  async function releaseIfNeeded(cfg, bc) {
    if (!lastSent) return null;
    const charger = getCharger(cfg, { ...bc, charger: lastSent.charger || bc.charger });
    const res = await charger.release();
    if (res?.ok) {
      pushLog('eos_wallbox_released', { charger: charger.type });
      lastSent = null;
    }
    return res;
  }

  // Aktueller evcc-Modus weicht von unserem letzten Befehl ab? Unbekannte
  // Modi (evcc „smart“ u.a.) kommen als null an und zaehlen als Abweichung.
  async function modeDrift(charger, expectedMode) {
    try {
      const st = await charger.status();
      if (!st?.ok) return null;
      const found = st.raw?.mode ?? null;
      return found === expectedMode ? null : { found };
    } catch {
      return null;
    }
  }

  // Override zu Ende (Uhrzeit, Abstecken, Beenden). Laeuft die EOS-Weitergabe,
  // setzt der naechste Befehl den Plan wieder durch; ist sie aus, bekommt die
  // Wallbox ihre eigene Regelung zurueck (evcc: der Modus von vor dem Override).
  // Rueckgabe: Ergebnis des Rueckstell-Befehls (null = keiner noetig).
  async function endOverride(reason, cfg, bc) {
    const ended = override;
    override = null;
    persistOverride();
    pushLog('ev_override_end', { reason, powerW: ended?.powerW ?? null, startedAt: ended?.startedAt ?? null });
    // Im Not-Halt nichts schreiben: der evcc-Modus von vorher wird vorgemerkt
    // und nach dem Aufheben hergestellt (runTick); eine direkte Box gibt
    // runTick dann über releaseIfNeeded frei.
    if (!lastSent?.override) return null;
    if (isPaused()) {
      if (lastSent.charger === 'evcc') {
        setPendingRestore({ mode: ended?.prevMode || bc.stopMode, stopped: lastSent.mode === 'off', loadpoint: lastSent.loadpoint ?? bc.loadpoint });
      }
      lastSent = { ...lastSent, override: false };
      return { ok: true, deferred: true, paused: true };
    }
    // Ohne Pro regelt die Bruecke nichts mehr — also auch die Weitergabe nicht.
    if (bc.enabled && isProActive() !== false) { lastSent = { ...lastSent, key: null }; return null; }
    if (lastSent.charger === 'evcc') {
      // evcc kennt kein „Vorgabe zuruecknehmen“ (release() tut nichts): ohne
      // bekannten Vorher-Modus bliebe es in „now“ und luede weiter. Dann gilt
      // der Stopp-Modus der Bruecke.
      const mode = ended?.prevMode || bc.stopMode;
      // Pausiert eine Grenze (§14a/Netzanschluss) gerade das Laden, bleibt evcc
      // aus, bis sie es erlaubt — sonst liefe z. B. „minpv“ trotz Pause wieder
      // an (Codex 184bcdcf, P1). runTick holt den Modus danach nach.
      // Steht irgendein Deckel, bleibt evcc aus: ein eigener evcc-Modus hielte
      // auch eine Teil-Grenze nicht ein (Gesamtprüfung, P1).
      if (getGridCapW() != null) {
        // Erst sicher aus (die Grenze kann im selben Takt gekommen sein, in dem
        // der Override endet), dann den Modus vormerken (Codex bf805c50, P1).
        const lp = lastSent.loadpoint ?? bc.loadpoint;
        const res = await hardStopper(cfg, { ...bc, charger: 'evcc', loadpoint: lp }, { type: 'evcc' }).stop();
        setPendingRestore({ mode, stopped: res?.ok === true, loadpoint: lp });
        lastSent = { ...lastSent, override: false };
        pushLog('ev_override_restore_deferred', { mode, reason, stopped: res?.ok === true });
        return res?.ok ? { ok: true, deferred: true } : res;
      }
      const res = await getCharger(cfg, { ...bc, charger: 'evcc', stopMode: mode }).stop();
      if (res?.ok) lastSent = null;
      else pushLog('ev_override_error', { charger: 'evcc', error: res?.error || 'stop failed', reason });
      return res;
    }
    return releaseIfNeeded(cfg, bc);
  }

  // Ein Takt im Override: laden mit der gewaehlten Leistung bzw. nicht laden,
  // EOS-Plan egal. Rueckgabe null = Override ist gerade zu Ende gegangen,
  // normaler Takt folgt. `paused`: Not-Halt — ein Stopp wird gehalten, aber
  // nicht beendet (Ende hiesse: Laden wieder erlauben).
  async function overrideTick(cfg, bc, force, { paused = false } = {}) {
    if (!paused && override.until && Date.parse(override.until) <= now()) {
      await endOverride('expired', cfg, bc);
      return null;
    }
    const charger = getCharger(cfg, bc);
    if (!charger.isConfigured()) return { ok: false, skipped: `${bc.charger} not configured` };
    // Lizenz weg: Override beenden statt ihn endlos stehen zu lassen.
    if (isProActive() === false) {
      await endOverride('pro required', cfg, bc);
      return { ok: false, skipped: 'pro required' };
    }

    let st;
    try { st = await charger.status(); } catch { st = null; }
    if (st?.ok && st.connected === true && !override.seenConnected) {
      override.seenConnected = true;
      persistOverride();
    }
    // Erst nach dem Anstecken zaehlt Abziehen als Ende — so kann man den
    // Knopf druecken und danach einstecken.
    if (!paused && st?.ok && st.connected === false && override.seenConnected) {
      await endOverride('unplugged', cfg, bc);
      return null;
    }

    if (override.kind === 'stop') {
      // „Laden stoppen“: wirklich nicht laden — evcc im Modus off (nicht der
      // eingestellte Stopp-Modus, der bei pv/minpv weiter mit PV laedt), eine
      // direkte Box mit stop() (nicht release()).
      const key = `${bc.charger}:${bc.loadpoint}:override:stop`;
      if (!force && lastSent?.key === key) {
        const drift = charger.type === 'evcc' && st?.ok && (st.raw?.mode ?? null) !== 'off';
        if (!drift) { lastError = null; return { ok: true, unchanged: true, override: true }; }
        pushLog('eos_evcc_mode_corrected', { loadpoint: bc.loadpoint, found: st.raw?.mode ?? null, expected: 'off', override: true });
      }
      const stopper = charger.type === 'evcc' ? getCharger(cfg, { ...bc, stopMode: 'off' }) : charger;
      const res = await stopper.stop();
      if (!res?.ok) {
        lastError = res?.error || 'wallbox write failed';
        pushLog('ev_override_error', { charger: charger.type, error: lastError, kind: 'stop' });
        return { ok: false, error: lastError, override: true };
      }
      lastError = null;
      lastSent = {
        key, charger: bc.charger, action: 'stop', currentA: null, chargePowerW: 0, loadpoint: bc.loadpoint,
        mode: 'off', released: false, override: true, slotTs: null, at: new Date(now()).toISOString()
      };
      handOff();
      pushLog('ev_override_command', lastSent);
      return { ok: true, sent: lastSent, override: true };
    }

    const capped = applyGridCap({ action: 'charge', currentA: powerToCurrentA(override.powerW, bc) }, bc, getGridCapW());
    if (capped.action === 'stop') {
      // §14a-Grenze unter dem Mindeststrom: „Sofort laden“ pausiert, bis die
      // Steuerbox die Grenze aufhebt.
      const key = `${bc.charger}:${bc.loadpoint}:override:grid-cap`;
      if (force || lastSent?.key !== key) {
        const res = await hardStopper(cfg, bc, charger).stop();
        if (!res?.ok) return { ok: false, error: res?.error || 'wallbox write failed', override: true };
        // override: true — sonst stellte endOverride() den evcc-Modus von
        // vorher nicht wieder her (Codex 74f9a362, P2).
        lastSent = {
          key, charger: bc.charger, action: 'stop', currentA: null, loadpoint: bc.loadpoint,
          mode: charger.type === 'evcc' ? 'off' : null, released: false, override: true,
          gridCapW: capped.gridCapW, at: new Date(now()).toISOString()
        };
        handOff();
        pushLog('ev_override_grid_cap', { capW: capped.gridCapW });
      }
      return { ok: true, override: true, gridCapW: capped.gridCapW };
    }
    const currentA = capped.currentA;
    const key = `${bc.charger}:${bc.loadpoint}:override:${currentA}`;
    if (!force && lastSent?.key === key) {
      const drift = charger.type === 'evcc' && st?.ok && (st.raw?.mode ?? null) !== 'now';
      if (!drift) { lastError = null; return { ok: true, unchanged: true, override: true }; }
      pushLog('eos_evcc_mode_corrected', { loadpoint: bc.loadpoint, found: st.raw?.mode ?? null, expected: 'now', override: true });
    }
    const result = await charger.charge(currentA);
    if (!result?.ok) {
      lastError = result?.error || 'wallbox write failed';
      pushLog('ev_override_error', { charger: charger.type, error: lastError });
      return { ok: false, error: lastError, override: true };
    }
    lastError = null;
    // Ein fremder Auftrag an der Box, der weniger erlaubt als wir wollen?
    const foreign = st?.foreignClaim;
    if (foreign && (foreign.state === 'disabled' || (foreign.chargeCurrentA != null && foreign.chargeCurrentA < currentA))) {
      lastError = `Ein anderer Regler hält an der Wallbox einen eigenen Auftrag (${foreign.state === 'disabled' ? 'gesperrt' : foreign.chargeCurrentA + ' A'}) — der Ladestrom lässt sich nicht erhöhen.`;
      pushLog('wallbox_foreign_claim', { charger: charger.type, wantedA: currentA, foreign });
    }
    lastSent = {
      key,
      charger: bc.charger,
      action: 'charge',
      currentA,
      chargePowerW: override.powerW,
      loadpoint: bc.loadpoint,
      mode: 'now',
      released: false,
      override: true,
      slotTs: null,
      at: new Date(now()).toISOString()
    };
    handOff();
    pushLog('ev_override_command', lastSent);
    return { ok: true, sent: lastSent, override: true };
  }

  async function locked(fn) {
    while (inflight) { try { await inflight; } catch { /* egal */ } }
    const run = (async () => fn())();
    inflight = run;
    try { return await run; } finally { if (inflight === run) inflight = null; }
  }

  // Nur die §14a-Grenze durchsetzen (keine EOS-Steuerung, kein „Sofort laden“).
  async function gridCapOnlyTick(cfg, bc) {
    const capW = getGridCapW();
    if (capW == null || !Number.isFinite(Number(capW)) || bc.charger === 'evcc') return null;
    const charger = getCharger(cfg, bc);
    if (!charger.isConfigured()) return null;
    // Ohne Grenze lädt die Box mit ihrem Höchststrom; mit Grenze höchstens der Anteil.
    const slot = applyGridCap({ action: 'charge', currentA: bc.maxCurrentA }, bc, capW);
    const key = `${bc.charger}:${bc.loadpoint}:p14a:${slot.action}:${slot.currentA ?? ''}`;
    if (lastSent?.key === key) return { ok: true, unchanged: true, gridCapW: Number(capW) };
    const res = slot.action === 'stop' ? await charger.stop() : await charger.charge(slot.currentA);
    if (!res?.ok) {
      lastError = res?.error || 'wallbox write failed';
      pushLog('paragraph14a_wallbox_error', { charger: charger.type, error: lastError });
      return { ok: false, error: lastError };
    }
    lastSent = { key, charger: bc.charger, action: slot.action, currentA: slot.currentA ?? null, loadpoint: bc.loadpoint, at: new Date(now()).toISOString(), gridCap: true };
    pushLog('paragraph14a_wallbox_capped', { charger: charger.type, capW: Number(capW), action: slot.action, currentA: slot.currentA ?? null });
    return { ok: true, sent: lastSent, gridCapW: Number(capW) };
  }

  function tick({ force = false } = {}) {
    if (inflight && !force) return Promise.resolve({ ok: false, error: 'busy' });
    return locked(() => runTick(force));
  }

  async function runTick(force) {
    try {
      lastTickAt = now();
      const cfg = getCfg() || {};
      const bc = resolveEvccBridgeConfig(cfg);
      // Not-Halt friert ein wie ueberall: kein Befehl an die Wallbox, auch kein
      // Override. Ein gesetzter Override bleibt stehen und greift nach dem
      // Aufheben. Seit 06.11.2026 (Christin) gilt das auch für „Laden stoppen“
      // — DVhub hält nicht gegen eine von Hand gestartete Ladung. Die einmalige
      // Neutralisierung beim Aktivieren macht emergencyStop().
      if (isPaused()) return { ok: false, skipped: 'paused' };
      if (override) {
        const res = await overrideTick(cfg, bc, force);
        if (res) return res;
        force = true;
      }
      // Der Plan übernimmt nur, wenn er auch steuern darf (Pro) — Codex bf805c50, P2.
      if (pendingRestore && bc.enabled && isProActive() !== false) setPendingRestore(null);
      if (pendingRestore) {
        const pr = pendingRestore; // fest für diesen Takt, auch über awaits hinweg
        // Der Ladepunkt, an dem der Modus vorgemerkt wurde — nicht der jetzt
        // eingestellte (Codex 4bf1eb18, P2).
        const prBc = { ...bc, charger: 'evcc', loadpoint: pr.loadpoint ?? bc.loadpoint };
        // Erst ohne jeden Deckel zurück in den eigenen evcc-Modus — der hielte
        // auch eine Teil-Grenze (z. B. 0 → 5 kW) nicht ein; bis dahin bleibt die
        // Wallbox im Netzanschluss-Wächter eingeschrieben (Gesamtprüfung, P1).
        if (getGridCapW() != null) {
          if (!pr.stopped) {
            const res = await hardStopper(cfg, prBc, { type: 'evcc' }).stop();
            pr.stopped = res?.ok === true;
            if (pendingRestore === pr) persistOverride();
            if (!res?.ok) return { ok: false, error: res?.error || 'evcc stop failed' };
          }
          return { ok: true, deferred: true };
        }
        const res = await getCharger(cfg, { ...prBc, stopMode: pr.mode }).stop();
        if (!res?.ok) return { ok: false, error: res?.error || 'evcc mode restore failed' };
        pushLog('ev_override_restored', { mode: pr.mode });
        if (pendingRestore === pr) setPendingRestore(null);
        lastSent = null;
        return { ok: true, restored: true };
      }
      if (!bc.enabled) {
        // §14a EnWG gilt für die Wallbox auch dann, wenn EOS sie nicht steuert:
        // begrenzt der Netzbetreiber, deckelt DVhub eine direkt angebundene
        // Wallbox (OpenEVSE, go-e) auf ihren Anteil und gibt sie danach wieder frei.
        const capped = await gridCapOnlyTick(cfg, bc);
        if (capped) return capped;
        await releaseIfNeeded(cfg, bc);
        return { ok: false, skipped: 'disabled' };
      }
      // Wallbox gewechselt: die alte gibt ihre Vorgabe zurueck.
      if (lastSent && lastSent.charger && lastSent.charger !== bc.charger) await releaseIfNeeded(cfg, bc);
      const charger = getCharger(cfg, bc);
      if (!charger.isConfigured()) return { ok: false, skipped: `${bc.charger} not configured` };
      if (isProActive() === false) {
        // Ohne Pro kein Plan — eine Grenze (§14a/Netzanschluss) setzt DVhub an
        // einer direkt angebundenen Box trotzdem durch (Gesamtprüfung 2, P1).
        const capped = await gridCapOnlyTick(cfg, bc);
        if (capped) return capped;
        return { ok: false, skipped: 'pro required' };
      }

      let solution = null;
      try { solution = await getSolution(8 * 24 * 4); } catch { solution = null; }
      let planNote = null;
      // Leere Loesung (z. B. direkt nach EOS-Neustart vor dem ersten Lauf) gilt
      // ebenfalls als „nicht abrufbar“, nicht als „EOS will stoppen“.
      const fetched = !!(solution && Array.isArray(solution.rows) && solution.rows.length);
      if (fetched) {
        lastGeneratedAt = solution.generatedAt || null;
        lastPlan = buildEvPlan(solution, bc);
        lastPlanFetchedAt = now();
        usingStalePlan = false;
      } else if (lastPlan.length && now() - lastPlanFetchedAt <= PLAN_GRACE_MS) {
        // Abruf gescheitert (Timeout waehrend EOS rechnet) — das ist KEIN
        // „EOS will stoppen“. Gueltige Slots des letzten Plans nicht verwerfen,
        // sonst schaltet die Wallbox im Minutentakt an/aus (schadet dem Auto).
        planNote = 'EOS-Plan gerade nicht abrufbar — letzter Plan gilt weiter';
        if (!usingStalePlan) pushLog('eos_evcc_plan_fallback', { planGeneratedAt: lastGeneratedAt, fetchedAt: new Date(lastPlanFetchedAt).toISOString() });
        usingStalePlan = true;
      } else {
        lastPlan = [];
        usingStalePlan = false;
      }
      let slot = slotAt(lastPlan, now());
      if (!slot || !slot.action) {
        planNote = slot ? 'EOS-Plan ohne E-Auto-Werte (E-Auto in EOS angemeldet?)' : 'kein EOS-Slot fuer jetzt';
        // evcc hoert nur auf uns: ohne E-Auto-Plan gilt Stopp — sonst laedt
        // evcc im eigenen Modus (z.B. „smart“) los, sobald das Auto steckt.
        if (lastSent?.action === 'charge') pushLog('eos_evcc_plan_lost', { reason: planNote });
        slot = { ts: now(), endTs: now(), action: 'stop', currentA: null, chargePowerW: null };
      }

      slot = applyGridCap(slot, bc, getGridCapW());
      // Sicherheits-Stopp aus dem wirksamen Deckel, egal ob der Plan laden
      // wollte: auch ein geplanter Stopp-Slot geht bei Deckel unter dem
      // Mindeststrom hart auf „aus“ (Codex 4bf1eb18, P1).
      // Steht irgendein Deckel, heißt ein Stopp-Slot „aus“: ein eigener Modus
      // (pv/minpv, release()) hielte auch eine Teil-Grenze nicht ein
      // (Gesamtprüfung 2, P1).
      const capStop = slot.action === 'stop' && (slot.gridCapW != null || getGridCapW() != null);
      const key = capStop ? `${bc.charger}:${bc.loadpoint}:grid-cap-stop` : commandKey(bc, slot);
      if (!force && lastSent?.key === key) {
        // Unveraendert — aber wurde evcc inzwischen von aussen umgestellt
        // (evcc-App, Anstecken im Standardmodus)? Dann unseren Modus erneut setzen.
        const drift = charger.type === 'evcc' ? await modeDrift(charger, lastSent.mode) : null;
        if (!drift) {
          lastError = planNote;
          return { ok: true, unchanged: true };
        }
        pushLog('eos_evcc_mode_corrected', { loadpoint: bc.loadpoint, found: drift.found, expected: lastSent.mode });
      }

      const result = capStop ? await hardStopper(cfg, bc, charger).stop() : await send(charger, bc, slot);
      if (!result?.ok) {
        lastError = result?.error || 'evcc write failed';
        pushLog('eos_evcc_error', { loadpoint: bc.loadpoint, action: slot.action, error: lastError });
        return { ok: false, error: lastError };
      }
      lastError = planNote;
      lastSent = {
        key,
        charger: bc.charger,
        action: slot.action,
        currentA: slot.currentA,
        chargePowerW: slot.chargePowerW,
        loadpoint: bc.loadpoint,
        mode: slot.action === 'charge' ? 'now' : (capStop ? 'off' : bc.stopMode),
        released: slot.action !== 'charge' && !capStop && bc.charger !== 'evcc' && bc.stopMode !== 'off',
        ...(capStop ? { gridCapW: slot.gridCapW ?? getGridCapW() } : {}),
        slotTs: new Date(slot.ts).toISOString(),
        at: new Date(now()).toISOString()
      };
      pushLog('eos_evcc_command', lastSent);
      return { ok: true, sent: lastSent };
    } catch (err) {
      lastError = err?.message || String(err);
      pushLog('eos_evcc_error', { error: lastError });
      return { ok: false, error: lastError };
    }
  }

  return {
    start(intervalMs = 30_000) {
      if (timer) return;
      timer = safeInterval('eos-evcc-bridge.tick', () => tick(), intervalMs);
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },
    tick,
    /**
     * Not-Halt: EINMAL „aus“ — nur, wenn DVhub die Wallbox gerade laden lässt
     * (letzter eigener Befehl „laden“) und bei evcc der Modus noch DVhubs „now“
     * ist. Von Hand umgestellt, unbekannt oder schon gestoppt: nichts senden.
     */
    emergencyStop() {
      return locked(async () => {
        const cfg = getCfg() || {};
        const bc0 = resolveEvccBridgeConfig(cfg);
        // Ziele: der letzte bestätigte eigene Ladebefehl und jeder Ladebefehl
        // ohne Quittung (kann gewirkt haben) — jedes für sich geprüft
        // (Codex 4bf1eb18 und 8bf189b7).
        const targets = new Map();
        if (lastSent?.action === 'charge') {
          targets.set(targetKey({ charger: lastSent.charger || bc0.charger, loadpoint: lastSent.loadpoint ?? bc0.loadpoint }),
            { ...lastSent, override: lastSent.override === true });
        }
        for (const [key, t] of unconfirmedCharges) if (!targets.has(key)) targets.set(key, t);
        if (!targets.size) return { ok: true, skipped: lastSent ? 'not_charging' : 'not_controlled' };
        const stopped = [];
        const skipped = [];
        const errors = [];
        const failed = [];
        for (const ref of targets.values()) {
          // Ladepunkt und Wallbox des jeweiligen Befehls — nicht ein inzwischen
          // anders eingestellter (Codex 45b7c40b, P2).
          const bc = {
            ...bc0,
            charger: ref.charger || bc0.charger,
            loadpoint: Number.isInteger(Number(ref.loadpoint)) && Number(ref.loadpoint) >= 1 ? Number(ref.loadpoint) : bc0.loadpoint
          };
          const charger = getCharger(cfg, bc);
          if (!charger?.isConfigured?.()) { skipped.push('not_configured'); continue; }
          if (charger.type === 'evcc') {
            let st;
            // Frisch gelesen, nicht aus dem Abfrage-Puffer (Codex 45b7c40b, P2).
            try { st = await charger.status({ fresh: true }); } catch { st = null; }
            // Im Zweifel nicht senden: nur wenn evcc nachweislich noch in DVhubs Modus steht.
            if (!st?.ok || (st.raw?.mode ?? null) !== (ref.mode || 'now')) { skipped.push('not_dvhub_state'); continue; }
          }
          const res = await hardStopper(cfg, bc, charger).stop();
          if (!res?.ok) { errors.push(res?.error || 'wallbox write failed'); failed.push({ ...ref, charger: bc.charger, loadpoint: bc.loadpoint }); continue; }
          stopped.push({ bc, type: charger.type, override: ref.override === true });
        }
        // Gescheiterte Ziele bleiben als „kann laden“ für den nächsten Not-Halt
        // stehen — auch der letzte bestätigte (Codex 180dbd00, P1).
        for (const f of failed) unconfirmedCharges.set(targetKey(f), { ...f, action: 'charge', mode: f.mode || 'now' });
        if (stopped.length) {
          // Neuer Merker: das gestoppte Ziel mit „Sofort laden“ hat Vorrang
          // (sein Ende — im Not-Halt, per Knopf oder Ablauf — stellt dort den
          // Modus von vorher her; Codex 8bf189b7/180dbd00/009826e9, P2), sonst
          // das Ziel des bisherigen Merkers, sonst das erste. Der Schlüssel
          // ändert sich immer — nach dem Aufheben gilt kein Befehl als
          // „unverändert“ (Codex 009826e9, P2).
          const lastKey = lastSent ? targetKey({ charger: lastSent.charger || bc0.charger, loadpoint: lastSent.loadpoint ?? bc0.loadpoint }) : null;
          const pick = stopped.find((x) => x.override) || stopped.find((x) => targetKey(x.bc) === lastKey) || stopped[0];
          const sameAsLast = targetKey(pick.bc) === lastKey;
          lastSent = {
            ...(sameAsLast ? lastSent : {}),
            key: `${pick.bc.charger}:${pick.bc.loadpoint}:emergency-stop`, charger: pick.bc.charger, loadpoint: pick.bc.loadpoint,
            action: 'stop', currentA: null,
            override: pick.override || (sameAsLast && lastSent?.override === true),
            mode: pick.type === 'evcc' ? 'off' : null, released: false, at: new Date(now()).toISOString()
          };
          pushLog('ev_emergency_stop', { targets: stopped.map((x) => `${x.bc.charger}:${x.bc.loadpoint}`), override: lastSent.override === true });
        }
        if (errors.length) {
          lastError = errors.join('; ');
          return { ok: false, error: lastError, stopped: stopped.length };
        }
        return stopped.length ? { ok: true, stopped: true } : { ok: true, skipped: skipped[0] || 'not_dvhub_state' };
      });
    },
    /** Befehl sofort erneut senden, auch wenn er sich nicht geaendert hat. */
    apply: () => tick({ force: true }),
    /**
     * Sofort laden mit `powerW`, bis `untilMs` (null = bis Abstecken/Beenden).
     * Wartet einen laufenden Takt ab und sendet den Befehl dann sofort.
     */
    async setOverride({ kind = 'charge', powerW, untilMs = null } = {}) {
      const cfg = getCfg() || {};
      const bc = resolveEvccBridgeConfig(cfg);
      const norm = normalizeOverride({ kind, powerW, untilMs }, bc, now());
      if (!norm.ok) return norm;
      const next = norm.override;
      // evcc-Modus von vorher merken (fuer das Ende bei ausgeschalteter
      // Weitergabe). Laeuft schon ein Override, bleibt dessen Herkunft.
      // Steht noch ein vorgemerkter Modus aus einer Pause an, ist DAS der Modus
      // von vorher — nicht das erzwungene „aus“ (Codex bf805c50, P2).
      // Der Modus von vorher wird im Lock bestimmt: ein laufender Takt kann
      // gerade eine vorgemerkte Rückkehr abschließen (Codex 9ac450c4, ea036ff7).
      return locked(async () => {
        if (!override && pendingRestore && (pendingRestore.loadpoint ?? bc.loadpoint) === bc.loadpoint) {
          // Abgegeben wird die Vormerkung erst, wenn ein Befehl des Overrides
          // ankommt (handOff) — scheitert er oder endet der Override vorher,
          // stellt runTick den Modus weiter her.
          next.prevMode = pendingRestore.mode;
          next.inheritsRestore = true;
        } else if (!override && bc.charger === 'evcc') {
          try {
            const st = await getCharger(cfg, bc).status();
            const own = next.kind === 'stop' ? 'off' : 'now';
            if (st?.ok && typeof st.raw?.mode === 'string' && st.raw.mode !== own) next.prevMode = st.raw.mode;
          } catch { /* ohne Vorher-Modus: Ende = Stopp-Modus */ }
        }
        // Beim Wechsel der Leistung bleibt die Herkunft (Startzeit, Modus) erhalten.
        if (override) {
          next.startedAt = override.startedAt;
          next.seenConnected = override.seenConnected;
          if (override.prevMode) next.prevMode = override.prevMode;
        }
        override = next;
        persistOverride();
        pushLog('ev_override_start', { kind: next.kind, powerW: next.powerW, requestedW: next.requestedW, until: next.until });
        const result = await runTick(true);
        return { ok: true, override: override ? { ...override } : null, result };
      });
    },
    /** Override beenden; danach gilt wieder der EOS-Plan (bzw. die Wallbox selbst). */
    // `error`: die Wallbox hat das Zuruecksetzen nicht angenommen — der
    // Override ist trotzdem weg, die Anzeige soll den Fehler aber zeigen.
    async clearOverride() {
      return locked(async () => {
        if (!override) return { ok: true, override: null, result: null, error: null };
        // Im Not-Halt bleibt „Laden stoppen“ stehen: Beenden hiesse Laden wieder
        // erlauben — eine Steuerhandlung, die der Not-Halt gerade unterbindet.
        if (isPaused() && isStopOverride()) {
          return { ok: false, error: 'emergency_stop_active', override: { ...override } };
        }
        const cfg = getCfg() || {};
        const bc = resolveEvccBridgeConfig(cfg);
        const ended = await endOverride('cleared', cfg, bc);
        const result = await runTick(true);
        let error = null;
        if (ended && ended.ok === false) error = ended.error || 'Wallbox hat nicht geantwortet';
        else if (result?.ok === false && !result.skipped) error = result.error || null;
        return { ok: true, override: null, result, error };
      });
    },
    getOverride: () => (override ? { ...override } : null),
    /** Steht eine vorgemerkte evcc-Rückkehr aus (Netzanschluss-Wächter: Wallbox bleibt eingeschrieben)? */
    hasPendingRestore: () => pendingRestore != null,
    getStatus() {
      const cfg = getCfg() || {};
      const bc = resolveEvccBridgeConfig(cfg);
      const t = now();
      const current = slotAt(lastPlan, t);
      return {
        enabled: bc.enabled,
        charger: bc.charger,
        chargerConfigured: (() => { try { return getCharger(cfg, bc).isConfigured(); } catch { return false; } })(),
        evccUrlSet: Boolean(cfg.evcc?.url),
        loadpoint: bc.loadpoint,
        phases: bc.phases,
        minCurrentA: bc.minCurrentA,
        maxCurrentA: Math.round(bc.maxCurrentA * 10) / 10,
        stopMode: bc.stopMode,
        solutionGeneratedAt: lastGeneratedAt,
        override: override ? { ...override, ...overrideLimits(bc) } : null,
        overrideLimits: overrideLimits(bc),
        current: current ? { ...current, ts: new Date(current.ts).toISOString(), endTs: new Date(current.endTs).toISOString() } : null,
        lastSent,
        lastError,
        lastTickAt: lastTickAt ? new Date(lastTickAt).toISOString() : null,
        // Die naechsten 24 h fuer die Anzeige.
        plan: lastPlan
          .filter((slot) => slot.endTs > t && slot.ts < t + 24 * 3600_000)
          .map((slot) => ({ ...slot, ts: new Date(slot.ts).toISOString(), endTs: new Date(slot.endTs).toISOString() }))
      };
    }
  };
}
