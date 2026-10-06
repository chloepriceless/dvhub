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

const DEFAULT_VOLTAGE_V = 230;
const STOP_MODES = ['off', 'pv', 'minpv'];
export const CHARGER_TYPES = ['evcc', 'openevse', 'goe'];

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
 * Override-Anfrage pruefen. `powerW` wird auf [Mindestleistung, evMaxChargeW]
 * begrenzt; `untilMs` null = bis zum Abstecken bzw. Beenden.
 * @returns {{ok:true, override:object}|{ok:false, error:string}}
 */
export function normalizeOverride({ powerW, untilMs = null }, bc, nowMs) {
  const p = Number(powerW);
  if (!Number.isFinite(p) || p <= 0) return { ok: false, error: 'powerW must be > 0' };
  if (untilMs != null && (!Number.isFinite(Number(untilMs)) || Number(untilMs) <= nowMs)) {
    return { ok: false, error: 'until must lie in the future' };
  }
  if (untilMs != null && Number(untilMs) > nowMs + 48 * 3600_000) {
    return { ok: false, error: 'until must be within 48 h' };
  }
  const lim = overrideLimits(bc);
  const clampedW = Math.round(Math.min(lim.maxPowerW, Math.max(lim.minPowerW, p)));
  return {
    ok: true,
    override: {
      powerW: clampedW,
      requestedW: Math.round(p),
      startedAt: new Date(nowMs).toISOString(),
      until: untilMs == null ? null : new Date(Number(untilMs)).toISOString(),
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
export function createEosEvccBridge(deps) {
  const {
    getCfg, getSolution, getCharger,
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
  let lastError = null;
  let lastPlan = [];
  let lastGeneratedAt = null;
  let lastPlanFetchedAt = 0;  // letzter ERFOLGREICHER Abruf der EOS-Loesung
  let usingStalePlan = false; // gerade Rueckfall auf den letzten Plan (fuer Log/Status)
  let lastTickAt = 0;
  // Ein Takt bzw. eine Override-Aenderung zur Zeit. Der 30-s-Takt ueberspringt,
  // wenn schon etwas laeuft; Knopfdruck und erzwungene Takte warten.
  let inflight = null;
  let override = null;       // { powerW, requestedW, startedAt, until, seenConnected, prevMode? }
  try {
    const saved = loadOverride();
    if (saved && Number(saved.powerW) > 0) override = saved;
  } catch { /* kaputte Datei: ohne Override weiter */ }

  function persistOverride() {
    try { saveOverride(override); } catch (e) { pushLog('ev_override_persist_error', { error: e?.message || String(e) }); }
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
    if (!lastSent?.override) return null;
    // Ohne Pro regelt die Bruecke nichts mehr — also auch die Weitergabe nicht.
    if (bc.enabled && isProActive() !== false) { lastSent = { ...lastSent, key: null }; return null; }
    if (lastSent.charger === 'evcc') {
      // evcc kennt kein „Vorgabe zuruecknehmen“ (release() tut nichts): ohne
      // bekannten Vorher-Modus bliebe es in „now“ und luede weiter. Dann gilt
      // der Stopp-Modus der Bruecke.
      const mode = ended?.prevMode || bc.stopMode;
      const res = await getCharger(cfg, { ...bc, charger: 'evcc', stopMode: mode }).stop();
      if (res?.ok) lastSent = null;
      else pushLog('ev_override_error', { charger: 'evcc', error: res?.error || 'stop failed', reason });
      return res;
    }
    return releaseIfNeeded(cfg, bc);
  }

  // Ein Takt im Override: laden mit der gewaehlten Leistung, EOS-Plan egal.
  // Rueckgabe null = Override ist gerade zu Ende gegangen, normaler Takt folgt.
  async function overrideTick(cfg, bc, force) {
    if (override.until && Date.parse(override.until) <= now()) {
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

    let st = null;
    try { st = await charger.status(); } catch { st = null; }
    if (st?.ok && st.connected === true && !override.seenConnected) {
      override.seenConnected = true;
      persistOverride();
    }
    // Erst nach dem Anstecken zaehlt Abziehen als Ende — so kann man den
    // Knopf druecken und danach einstecken.
    if (st?.ok && st.connected === false && override.seenConnected) {
      await endOverride('unplugged', cfg, bc);
      return null;
    }

    const capped = applyGridCap({ action: 'charge', currentA: powerToCurrentA(override.powerW, bc) }, bc, getGridCapW());
    if (capped.action === 'stop') {
      // §14a-Grenze unter dem Mindeststrom: „Sofort laden“ pausiert, bis die
      // Steuerbox die Grenze aufhebt.
      const key = `${bc.charger}:${bc.loadpoint}:override:grid-cap`;
      if (force || lastSent?.key !== key) {
        const res = await charger.stop();
        if (!res?.ok) return { ok: false, error: res?.error || 'wallbox write failed', override: true };
        lastSent = { key, charger: bc.charger, action: 'stop', currentA: null, loadpoint: bc.loadpoint, at: new Date(now()).toISOString() };
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
      // Override. Ein gesetzter Override bleibt stehen und greift nach dem Aufheben.
      if (isPaused()) return { ok: false, skipped: 'paused' };
      if (override) {
        const res = await overrideTick(cfg, bc, force);
        if (res) return res;
        force = true;
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
      if (isProActive() === false) return { ok: false, skipped: 'pro required' };

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
      const key = commandKey(bc, slot);
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

      const result = await send(charger, bc, slot);
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
        mode: slot.action === 'charge' ? 'now' : bc.stopMode,
        released: slot.action !== 'charge' && bc.charger !== 'evcc' && bc.stopMode !== 'off',
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
    /** Befehl sofort erneut senden, auch wenn er sich nicht geaendert hat. */
    apply: () => tick({ force: true }),
    /**
     * Sofort laden mit `powerW`, bis `untilMs` (null = bis Abstecken/Beenden).
     * Wartet einen laufenden Takt ab und sendet den Befehl dann sofort.
     */
    async setOverride({ powerW, untilMs = null } = {}) {
      const cfg = getCfg() || {};
      const bc = resolveEvccBridgeConfig(cfg);
      const norm = normalizeOverride({ powerW, untilMs }, bc, now());
      if (!norm.ok) return norm;
      const next = norm.override;
      // evcc-Modus von vorher merken (fuer das Ende bei ausgeschalteter
      // Weitergabe). Laeuft schon ein Override, bleibt dessen Herkunft.
      if (!override && bc.charger === 'evcc') {
        try {
          const st = await getCharger(cfg, bc).status();
          if (st?.ok && typeof st.raw?.mode === 'string' && st.raw.mode !== 'now') next.prevMode = st.raw.mode;
        } catch { /* ohne Vorher-Modus: Ende = Stopp-Modus */ }
      }
      return locked(async () => {
        // Beim Wechsel der Leistung bleibt die Herkunft (Startzeit, Modus) erhalten.
        if (override) {
          next.startedAt = override.startedAt;
          next.seenConnected = override.seenConnected;
          if (override.prevMode) next.prevMode = override.prevMode;
        }
        override = next;
        persistOverride();
        pushLog('ev_override_start', { powerW: next.powerW, requestedW: next.requestedW, until: next.until });
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
