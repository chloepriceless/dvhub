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
    // Einphasig laden, wenn die Wallbox umschalten kann (evcc meldet es je
    // Ladepunkt): kleine Leistungen 1,4–3,7 kW statt erst ab 4,1 kW
    // dreiphasig. Abschaltbar (optimizer.evPhaseSwitch = false).
    phaseSwitch: phases === 3 && opt.evPhaseSwitch !== false,
    // Wohin der Befehl geht: evcc (Standard) oder direkt an die Wallbox.
    charger: CHARGER_TYPES.includes(cfg?.wallbox?.type) ? cfg.wallbox.type : 'evcc'
  };
}

const round2 = (v) => Math.round(v * 100) / 100;
/**
 * Ladestufen fürs Auto in EOS (Anteile der max. Ladeleistung): nur, was die
 * Wallbox wirklich fahren kann. Dreiphasig ab Mindeststrom × 3 × 230 V (6 A:
 * 4,14 kW), mit Phasenumschaltung zusätzlich einphasig vom Mindeststrom bis
 * zum Höchststrom je Phase (6–16 A: 1,38–3,68 kW). Vorher plante EOS auch
 * 1,1 kW, die Wallbox lud dann mit 4,1 kW.
 */
export function evChargeRates({ maxChargeW, minCurrentA = 6, maxCurrentA = 16, phases = 3, onePhase = false, voltageV = DEFAULT_VOLTAGE_V }) {
  const maxW = Number(maxChargeW) > 0 ? Number(maxChargeW) : 5000;
  const minA = Number(minCurrentA) > 0 ? Number(minCurrentA) : 6;
  const ph = Number(phases) === 1 ? 1 : 3;
  const minW = minA * voltageV * ph;
  const out = new Set([0]);
  for (let k = 1; k <= 10; k += 1) if (k / 10 * maxW >= minW - 1e-6) out.add(round2(k / 10));
  if (onePhase && ph === 3) {
    const lo = Math.ceil(minA * voltageV / maxW * 100 - 1e-9) / 100;
    const hi = Math.floor(Math.min(Number(maxCurrentA) * voltageV, minW - 1) / maxW * 100 + 1e-9) / 100;
    if (hi >= lo) {
      out.add(lo);
      for (let r = Math.ceil(lo * 20 + 1e-9) / 20; r < hi - 1e-9; r += 0.05) out.add(round2(r));
      out.add(hi);
    }
  }
  // Liegt der Mindeststrom über der eingestellten Leistung, lädt die Box
  // trotzdem mit ihm (powerToCurrentA) — EOS darf dann wenigstens „voll“ planen.
  if (out.size === 1) out.add(1);
  return [...out].sort((a, b) => a - b);
}

/** Kann der eingestellte Ladepunkt gerade einphasig laden? (evcc: chargerPhases1p3p) */
export function onePhaseChargingAvailable(cfg, loadpoints = []) {
  const bc = resolveEvccBridgeConfig(cfg);
  if (!bc.phaseSwitch || bc.charger !== 'evcc') return false;
  const lp = (Array.isArray(loadpoints) ? loadpoints : []).find((l) => Number(l?.id) === bc.loadpoint);
  return lp?.phases1p3p === true;
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
/** Nach dem Stopp am Max-Ladestand erst wieder laden, wenn er so weit darunter liegt (Prozentpunkte). */
export const MAX_STOP_HOLD_PCT = 1;

/**
 * Max-Ladestand erreicht? Mit Haltebereich: einmal gestoppt, bleibt es aus,
 * bis der Ladestand MAX_STOP_HOLD_PCT darunter liegt (oder das Max steigt).
 * @returns {{ stop: boolean, hold: object|null }}
 */
export function evaluateMaxStop(limit, hold, nowMs) {
  const max = Number(limit?.maxSocPct);
  const soc = limit?.socPct === null || limit?.socPct === undefined ? NaN : Number(limit.socPct);
  if (!Number.isFinite(max) || !Number.isFinite(soc)) return { stop: false, hold: null };
  if (soc >= max) return { stop: true, hold: hold && hold.maxSocPct === max ? hold : { maxSocPct: max, since: new Date(nowMs).toISOString() } };
  if (hold && hold.maxSocPct === max && soc > max - MAX_STOP_HOLD_PCT) return { stop: true, hold };
  return { stop: false, hold: null };
}

// Geräte-Identität: welches physische Gerät DVhub angesprochen hat. Ändert
// sich die Einstellung (Adresse, Connector, evcc-Adresse), gehört das neue
// Gerät nicht DVhub, und das alte lässt sich nicht mehr adressieren.
const IDENTITY_KEYS = ['url', 'host', 'baseUrl', 'ip', 'port', 'unitId', 'ski', 'chargePointId', 'connectorId', 'chargepoint', 'serial'];
export function wallboxIdentity(cfg, charger) {
  if (charger === 'evcc') return `evcc|${String(cfg?.evcc?.url || '').trim()}`;
  if (charger === 'victron') return `victron|${String(cfg?.victron?.host || '').trim()}|${cfg?.wallbox?.victron?.unitId ?? ''}`;
  const s = cfg?.wallbox?.[charger] || {};
  return [charger, ...IDENTITY_KEYS.filter((k) => s[k] != null && s[k] !== '').map((k) => `${k}=${String(s[k]).trim()}`)].join('|');
}

export function createEosEvccBridge(deps) {
  const {
    getCfg, getSolution, getCharger: rawGetCharger,
    getGridCapW = () => null,
    // Netzanschluss-Wächter: Deckel je Gerät ('wallbox' = eingestellter
    // Ladepunkt bzw. Box, 'wallbox:evcc:<n>' = weitere evcc-Ladepunkte).
    getDeviceCapW = () => null,
    // evcc-Ladepunkte (evcc-integration getLoadpoints): Modus, Strom, Phasen.
    getEvccLoadpoints = () => [],
    isProActive = () => true,
    isPaused = () => false,
    // Max-Ladestand „wenn günstig“ (ev-targets.js evMaxStopSocPct): { maxSocPct,
    // socPct } oder null (keine Grenze — Vanilla-EOS, Max aus).
    getEvMaxStop = () => null,
    pushLog = () => {},
    now = () => Date.now(),
    loadOverride = () => null,
    saveOverride = () => {},
    // Eigentums-Datensätze je Ziel (eigene Datei, übersteht einen Neustart).
    loadOwned = () => null,
    saveOwned = () => {}
  } = deps;

  let timer = null;
  let lastSent = null;       // { key, action, currentA, loadpoint, mode, at }
  let override = null;       // { kind, powerW, requestedW, startedAt, until, seenConnected, prevMode? }

  // ── Eigentum je Ziel (vereinfacht nach der Gesamtprüfung, 06.11.2026) ──────
  // EIN Datensatz je Ziel (direkte Box bzw. evcc-Ladepunkt): welchen Befehl
  // DVhub dort zuletzt geschickt hat (charge/stop), ob er quittiert wurde und
  // ob er von einer Grenze kam. Jeder Weg zur Wallbox läuft durch den Wrapper
  // um getCharger, alle Übergänge also an EINER Stelle; gespeichert wird er
  // in ev_owned.json (übersteht einen Neustart).
  //   charge (auch ohne Quittung — kann gewirkt haben) → cmd 'charge'
  //   stop ok                                          → cmd 'stop'
  //   release ok an einer Box, deren release() wirkt   → Datensatz weg
  // Dazu die Geräte-Identität (Adresse, Connector …) und für evcc das Feld
  // restore (ausstehende Rückkehr des Modus nach „Sofort laden“).
  // Der Not-Halt prüft jedes Ziel mit cmd 'charge' frisch und stoppt es nur,
  // wenn es nachweislich noch in DVhubs Zustand steht.
  const owned = new Map(); // targetKey → { charger, loadpoint, identity, cmd, currentA, confirmed, gridCap, restore, at }
  // Direkte Boxen sind EIN Ziel, egal welcher evcc-Ladepunkt eingestellt ist;
  // nur evcc unterscheidet Ladepunkte.
  const targetKey = (bc) => (bc.charger === 'evcc' ? `evcc:${bc.loadpoint}` : String(bc.charger));
  // Rückkehr des evcc-Modus (Punkt 4): Feld restore im Datensatz des
  // Ladepunkts — { mode, reason, at }: „zurückstellen auf mode, sobald keine
  // Grenze mehr steht und kein Not-Halt“. Ausgeführt in GENAU einem Übergang
  // (applyPendingRestore, im Lock), nur wenn evcc frisch abgefragt noch auf
  // DVhubs „aus“ steht — sonst hat der Kunde selbst umgestellt.
  const pendingRestores = () => [...owned.values()].filter((e) => e.charger === 'evcc' && e.restore);

  function setOwned(key, entry) {
    if (entry) owned.set(key, entry); else owned.delete(key);
    if (loading) return;
    try { saveOwned(owned.size ? [...owned.values()] : null); } catch (e) { pushLog('ev_owned_persist_error', { error: e?.message || String(e) }); }
  }

  // Felder des Netzanschluss-Deckels an evcc (evccCapTick) überleben jeden
  // Befehl am selben Gerät: Ursprungsstrom, gesetzter Deckel, Pause.
  const capFields = (prev, ident) => (prev && prev.identity === ident
    ? { limitA: prev.limitA ?? null, limitTried: prev.limitTried === true, limitOff: prev.limitOff === true, origMaxCurrentA: prev.origMaxCurrentA ?? null, dvhubModes: Array.isArray(prev.dvhubModes) ? prev.dvhubModes : [] }
    : {});

  function getCharger(cfg, bc) {
    const c = rawGetCharger(cfg, bc);
    if (!c || typeof c !== 'object') return c;
    const tgt = { charger: bc?.charger ?? c.type, loadpoint: bc?.loadpoint ?? null };
    // Identität des wirklich angesprochenen Geräts (Adapter löst sie auf, z. B.
    // Victron-Unit, OCPP-Station); sonst aus der Einstellung.
    let ident;
    try { ident = typeof c.identity === 'function' ? c.identity() : wallboxIdentity(cfg, tgt.charger); } catch { ident = null; }
    tgt.identity = ident;
    tgt.maxCurrentA = Number.isFinite(Number(bc?.maxCurrentA)) ? Number(bc.maxCurrentA) : null;
    const key = targetKey(tgt);
    const wrapped = Object.create(c);
    // evcc: jeden Modus, den DVhub in der laufenden Eigentums-Phase setzt
    // oder zu setzen versucht, in die Menge dvhubModes (ev_owned.json) —
    // unmittelbar vor dem echten setMode (Adapter-Haken beforeSetMode), nicht
    // vor maxcurrent. „Vom Kunden geändert“ heißt nur: frisch gelesener Modus
    // ∉ Menge (Codex 0e351b52, P2 1–3).
    const addMode = (mode) => {
      if (!mode) return;
      const prev = owned.get(key);
      const same = prev && prev.identity === tgt.identity;
      const base = same ? prev : { ...tgt, cmd: 'limit', confirmed: true, gridCap: false };
      const modes = Array.isArray(base.dvhubModes) ? base.dvhubModes : [];
      if (!modes.includes(mode)) setOwned(key, { ...base, dvhubModes: [...modes, mode] });
      else if (!same) setOwned(key, base);
    };
    const hooked = c.type === 'evcc' && c.modeHook === true;
    if (hooked) c.beforeSetMode = addMode;
    // Adapter ohne Haken (Test-Attrappen): vor dem Befehl merken.
    const noteAttempt = (mode) => { if (c.type === 'evcc' && !hooked) addMode(mode); };
    // Phasen, die DVhub an DIESEM Gerät gesetzt hat (je Ziel und Identität).
    // Hat DVhub auf eine Phase geschaltet, stellt jeder andere Ladebefehl
    // (Override, Umschaltung aus, Grenze) zuerst drei Phasen her — sonst lüde
    // „Sofort laden“ mit 11 kW nur 3,7 kW (Codex 52c5ee20).
    const dvhubPhases = () => { const e = owned.get(key); return e && e.identity === tgt.identity ? e.phases ?? null : null; };
    const notePhases = (n) => {
      const prev = owned.get(key);
      const same = prev && prev.identity === tgt.identity;
      setOwned(key, { ...(same ? prev : { ...tgt, cmd: 'limit', confirmed: true, gridCap: false }), phases: n });
    };
    if (typeof c.setPhases === 'function') {
      wrapped.setPhases = async (n) => {
        const r = await c.setPhases(n);
        if (r?.ok) notePhases(n);
        return r;
      };
      wrapped.dvhubPhases = dvhubPhases;
    }
    if (typeof c.charge === 'function') {
      wrapped.charge = async (...a) => {
        // a[1]?.phases: Phasen dieses Befehls (Plan einphasig). Sonst gilt dreiphasig.
        const want = Number(a[1]?.phases) === 1 ? 1 : 3;
        if (typeof c.setPhases === 'function' && dvhubPhases() === 1 && want === 3) {
          const ph = await c.setPhases(3);
          if (!ph?.ok) return ph || { ok: false, error: 'phases failed' };
          notePhases(3);
        }
        noteAttempt('now');
        const r = await c.charge(a[0]);
        // Eine Grenz-Herkunft bleibt, bis ein quittierter normaler Befehl sie
        // ablöst (auch eine unquittierte Grenz-Aktualisierung kann wirken).
        const prev = owned.get(key);
        const prevCap = prev?.gridCap === true;
        const amps = Number.isFinite(Number(a[0])) ? Number(a[0]) : null;
        // Zuletzt BESTÄTIGTER Strom bleibt neben dem versuchten erhalten — beide
        // können an der Box stehen (Codex 7b3273db, P1).
        const confirmedCurrentA = r?.ok === true ? amps
          : (prev?.cmd === 'charge' && prev.identity === tgt.identity ? prev.confirmedCurrentA ?? null : null);
        setOwned(key, { ...tgt, ...capFields(prev, tgt.identity), cmd: 'charge', currentA: amps, confirmedCurrentA, confirmed: r?.ok === true, gridCap: prevCap, phases: dvhubPhases(), at: new Date(now()).toISOString() });
        return r;
      };
    }
    if (typeof c.stop === 'function') {
      wrapped.stop = async (...a) => {
        noteAttempt(bc?.stopMode || null);
        const r = await c.stop(...a);
        if (r?.ok) {
          const prev = owned.get(key);
          // Eine ausstehende evcc-Rückkehr überlebt einen Stopp (z. B. Not-Halt).
          setOwned(key, { ...tgt, ...capFields(prev, tgt.identity), cmd: 'stop', confirmed: true, gridCap: prev?.gridCap === true, restore: prev?.restore ?? null, phases: dvhubPhases(), at: new Date(now()).toISOString() });
        }
        return r;
      };
    }
    // release() gibt die Box an ihre eigene Regelung zurück. Bei evcc und
    // openWB ändert es nichts am Strom — dort bleibt der Datensatz.
    if (typeof c.release === 'function') {
      wrapped.release = async (...a) => {
        const r = await c.release(...a);
        if (r?.ok && !RELEASE_NOOP_TYPES.includes(c.type)) setOwned(key, null);
        return r;
      };
    }
    return wrapped;
  }
  function markGridCap(bc, value) {
    const key = targetKey(bc);
    const e = owned.get(key);
    if (e && e.gridCap !== value) setOwned(key, { ...e, gridCap: value });
  }
  // Max erreicht (Laden beendet): { maxSocPct, since } oder null. Haltebereich
  // MAX_STOP_HOLD_PCT, damit eine kleine Schwankung des gemeldeten Ladestands
  // die Wallbox nicht wieder anlaufen lässt.
  let maxHold = null;
  let lastError = null;
  let lastPlan = [];
  let lastGeneratedAt = null;
  let lastPlanFetchedAt = 0;  // letzter ERFOLGREICHER Abruf der EOS-Loesung
  let usingStalePlan = false; // gerade Rueckfall auf den letzten Plan (fuer Log/Status)
  let lastTickAt = 0;
  // Ein Takt bzw. eine Override-Aenderung zur Zeit. Der 30-s-Takt ueberspringt,
  // wenn schon etwas laeuft; Knopfdruck und erzwungene Takte warten.
  let inflight = null;
  let loading = true;
  try {
    const saved = loadOverride();
    if (saved && (saved.kind === 'stop' || Number(saved.powerW) > 0)) override = saved;
  } catch { /* kaputte Datei: ohne Override weiter */ }
  try {
    const list = loadOwned();
    for (const e of Array.isArray(list) ? list : []) {
      if (e && typeof e.charger === 'string' && ['charge', 'stop', 'limit'].includes(e.cmd)) {
        const rec = { ...e };
        // Altbestand ohne Menge: aus restore.expect / attemptedMode befüllen,
        // sonst wie früher „aus“ (Codex 0e351b52, P2 3).
        if (rec.charger === 'evcc' && !Array.isArray(rec.dvhubModes)) {
          const seed = [rec.restore?.expect, rec.attemptedMode].filter((m) => typeof m === 'string' && m);
          // Ohne Hinweis wie früher „off“ (Codex 1abbd9d7, P2).
          rec.dvhubModes = seed.length ? [...new Set(seed)] : ['off'];
        }
        owned.set(targetKey(rec), rec);
      }
    }
    // Eine Grenz-Vorgabe an einer direkten Box bleibt dort stehen (z. B.
    // OpenEVSE ohne auto_release): als letzten Befehl übernehmen, damit sie
    // nach dem Neustart wieder freigegeben werden kann.
    if (!override) {
      const cap = [...owned.values()].find((e) => e.gridCap && e.charger !== 'evcc');
      if (cap) lastSent = { key: null, charger: cap.charger, loadpoint: cap.loadpoint, identity: cap.identity ?? null, action: cap.cmd, currentA: null, gridCap: true, at: null };
    }
  } catch { /* kaputte Datei: ohne Override weiter */ }
  loading = false;
  const isStopOverride = () => override?.kind === 'stop';

  function persistOverride() {
    try { saveOverride(override); } catch (e) { pushLog('ev_override_persist_error', { error: e?.message || String(e) }); }
  }

  const commandKey = (bc, slot) => (slot.action === 'charge'
    ? `${bc.charger}:${bc.loadpoint}:charge:${slot.currentA}${slot.phases ? `:${slot.phases}p` : ''}`
    : `${bc.charger}:${bc.loadpoint}:stop:${bc.stopMode}`);

  // Direkt angesteuerte Wallboxen kennen keine evcc-Modi: "Stopp = Aus" heisst
  // nicht laden, "Stopp = PV/Min+PV" heisst Vorgabe zuruecknehmen — dann
  // regelt die Box selbst (z.B. OpenEVSE-PV-Divert).
  async function send(charger, bc, slot) {
    if (slot.action === 'charge') {
      // Phasen nur umschalten, wenn sie sich ändern (jede Umschaltung unterbricht die Ladung kurz).
      // Gemerkt wird je Ladepunkt und Gerät (nicht der letzte Befehl
      // überhaupt — nach einem Ladepunkt-Wechsel gälte sonst der alte).
      if (slot.phases) {
        const lp = (getEvccLoadpoints() || []).find((l) => Number(l?.id) === bc.loadpoint);
        const cur = charger.dvhubPhases?.() ?? (Number(lp?.phasesActive) || null);
        if (cur !== slot.phases) {
          const ph = await charger.setPhases(slot.phases);
          if (!ph?.ok) return ph || { ok: false, error: 'phases failed' };
        }
      }
      return charger.charge(slot.currentA, { phases: slot.phases || 3 });
    }
    if (charger.type !== 'evcc' && bc.stopMode !== 'off') return charger.release();
    return charger.stop();
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
    const target = { ...bc, charger: lastSent.charger || bc.charger, loadpoint: lastSent.loadpoint ?? bc.loadpoint };
    const charger = getCharger(cfg, target);
    // Gespeicherter Befehl an ein Gerät, das nicht mehr eingetragen ist: das neue
    // nicht anfassen (Gesamtrunde 1, P1).
    if (lastSent.identity) {
      let curIdent;
      try { curIdent = typeof charger.identity === 'function' ? charger.identity() : wallboxIdentity(cfg, target.charger); } catch { curIdent = null; }
      if (curIdent == null) return { ok: false, skipped: 'identity_unknown' };
      if (curIdent !== lastSent.identity) {
        pushLog('ev_owned_identity_changed', { charger: target.charger }, 'warn');
        setOwned(targetKey(target), null);
        lastSent = null;
        return { ok: true, skipped: 'identity_changed' };
      }
    }
    // openWB ohne übergeordneten Regler: release() tut nichts, die letzte
    // Vorgabe bliebe stehen. Nach einer Grenz-Vorgabe bekommt die Box ihren
    // vollen Strom zurück (Gesamtprüfung 5, P2).
    const wasGridCap = lastSent.gridCap === true || owned.get(targetKey(target))?.gridCap === true;
    // openWB unter einer noch aktiven Grenze: nicht auf vollen Strom — die
    // Grenze setzt danach gridCapOnlyTick (Codex 9d293571, P1).
    if (charger.type === 'openwb' && getGridCapW() != null) {
      // Alten Befehl ungültig machen, damit die Grenz-Vorgabe wirklich neu
      // rausgeht (Codex f42f6217, P2).
      lastSent = { ...lastSent, key: null };
      return { ok: true, held: true };
    }
    const res = charger.type === 'openwb' && wasGridCap
      ? await charger.charge(bc.maxCurrentA)
      : await charger.release();
    if (res?.ok) {
      pushLog('eos_wallbox_released', { charger: charger.type });
      lastSent = null;
      // openWB: Strom zurückgegeben — DVhub gibt dort nichts mehr vor.
      if (charger.type === 'openwb' && wasGridCap) setOwned(targetKey(target), null);
    }
    return res;
  }

  // Wallbox gewechselt (Punkt 3): direkte Boxen, die nicht mehr eingestellt
  // sind, an denen DVhub aber noch etwas vorgibt. Solange eine Grenze steht,
  // bleibt die alte Box, wie sie ist (also auch gedeckelt); die Grenze gilt an
  // der neuen. Ohne Grenze gibt DVhub sie frei (openWB: voller Strom zurück).
  // Ist dort inzwischen ein anderes Gerät eingetragen: nicht anfassen.
  async function releaseOrphans(cfg, bc) {
    const curKey = targetKey(bc);
    for (const e of [...owned.values()]) {
      const key = targetKey(e);
      if (e.charger === 'evcc' || key === curKey) continue;
      if (getGridCapW() != null) continue;
      const ch = getCharger(cfg, { ...bc, charger: e.charger, loadpoint: e.loadpoint });
      // Vorübergehend nicht erreichbar: Datensatz behalten (Codex a2686af7, P1).
      if (!ch?.isConfigured?.()) continue;
      let curIdent;
      try { curIdent = typeof ch.identity === 'function' ? ch.identity() : wallboxIdentity(cfg, e.charger); } catch { curIdent = null; }
      if (e.identity && curIdent == null) continue; // gerade nicht auflösbar
      if (e.identity && e.identity !== curIdent) {
        pushLog('ev_owned_identity_changed', { charger: e.charger }, 'warn');
        setOwned(key, null);
        continue;
      }
      // openWB: voller Strom der damaligen Einstellung (Codex a2686af7, P2).
      const res = e.charger === 'openwb' ? await ch.charge(e.maxCurrentA ?? bc.maxCurrentA) : await ch.release();
      if (res?.ok) {
        setOwned(key, null);
        if (lastSent && targetKey({ charger: lastSent.charger, loadpoint: lastSent.loadpoint }) === key) lastSent = null;
        pushLog('ev_previous_wallbox_released', { charger: e.charger });
      }
    }
  }

  // Wirksamer Deckel eines evcc-Ladepunkts: am eingestellten der gemeinsame
  // (§14a und Netzanschluss, kleinster gilt), an weiteren der des Wächters.
  function loadpointCapW(lpId, bc) {
    const sel = bc.charger === 'evcc' && Number(lpId) === bc.loadpoint;
    const cap = sel ? getGridCapW() : getDeviceCapW(`wallbox:evcc:${lpId}`);
    return cap != null && Number.isFinite(Number(cap)) ? Number(cap) : null;
  }

  // Phasen und Mindeststrom eines evcc-Ladepunkts (seine eigenen Werte).
  function loadpointParams(lp, bc) {
    const ph = [1, 2, 3].includes(Number(lp?.phasesActive)) ? Number(lp.phasesActive)
      : ([1, 2, 3].includes(Number(lp?.phasesConfigured)) ? Number(lp.phasesConfigured) : bc.phases);
    const minA = Number(lp?.minCurrentA) >= 6 ? Number(lp.minCurrentA) : bc.minCurrentA;
    return { ph, minA };
  }
  function findLoadpoint(lpId) {
    try { return (getEvccLoadpoints() || []).find((l) => Number(l?.id) === Number(lpId)) || null; } catch { return null; }
  }

  // Rückkehr des Modus erst, wenn ein stehender Deckel als maxcurrent quittiert
  // ist (evccCapTick) — nie mit dem alten Strom (Codex a7aacda4, P1). Unter dem
  // Mindeststrom bleibt der Ladepunkt aus.
  function restoreBlocked(key, lpId, bc) {
    const e = owned.get(key);
    if (e?.limitOff === true) return true;
    const cap = loadpointCapW(lpId, bc);
    if (cap == null) return false;
    if (!(e?.gridCap === true && e.limitA != null)) return true;
    // Gegen den Deckel von JETZT prüfen — er kann sich während der Abfrage
    // verschärft haben (Codex b18d6c54, P1).
    const { ph, minA } = loadpointParams(findLoadpoint(lpId), bc);
    const capA = Math.floor(cap / (bc.voltageV * ph));
    return capA < minA || e.limitA > capA;
  }

  // Der eine Übergang der evcc-Rückkehr (Punkt 4). Läuft in runTick, also im
  // Lock und nie im Not-Halt.
  async function applyPendingRestore(cfg, bc) {
    for (const e of pendingRestores()) {
      const key = targetKey(e);
      // Rückkehr verworfen: DVhubs Eigentums-Phase an den Modi ist vorbei.
      const drop = (why) => { setOwned(key, { ...(owned.get(key) || e), restore: null, dvhubModes: [] }); pushLog('ev_override_restore_dropped', { loadpoint: e.loadpoint, mode: e.restore.mode, reason: why }); };
      // Rückkehr erfolgreich (frisch gelesen bestätigt): Menge leeren.
      const done = () => {
        const cur = owned.get(key);
        // Auch das Lade-Eigentum endet: DVhub hat die Kontrolle zurückgegeben
        // (Codex 1abbd9d7, P2) — Deckel-Felder bleiben.
        if (cur) setOwned(key, { ...cur, restore: null, dvhubModes: [], ...(cur.cmd === 'charge' ? { cmd: 'stop', confirmed: true } : {}) });
        pushLog('ev_override_restored', { loadpoint: e.loadpoint, mode: e.restore.mode });
        if (lastSent && targetKey({ charger: lastSent.charger, loadpoint: lastSent.loadpoint }) === key) lastSent = null;
      };
      if (e.identity && e.identity !== wallboxIdentity(cfg, 'evcc')) { drop('identity_changed'); continue; }
      // Steuert der Plan diesen Ladepunkt (Weitergabe mit Pro), gehört er dem Plan.
      if (bc.enabled && isProActive() !== false && bc.charger === 'evcc' && bc.loadpoint === e.loadpoint) { drop('plan'); continue; }
      // Der Wächter hält den Ladepunkt unter dem Mindeststrom: aus lassen. Sonst
      // sofort zurück — den Strom begrenzt danach evccCapTick über maxcurrent
      // (Christin 07.11.2026: kein Warten auf Luft für die volle Leistung).
      if (restoreBlocked(key, e.loadpoint, bc)) continue;
      const tgt = { ...bc, charger: 'evcc', loadpoint: e.loadpoint };
      const charger = getCharger(cfg, tgt);
      let st;
      try { st = await charger.status({ fresh: true }); } catch { st = null; }
      if (!st?.ok) continue; // unbekannt: nächster Takt
      const found = st.raw?.mode ?? null;
      // Ein früherer Rückkehr-Befehl hat gewirkt (Quittung fehlte): fertig.
      if (found === e.restore.mode && (owned.get(key)?.dvhubModes || []).includes(found)) { done(); continue; }
      // Vom Kunden geändert = frisch gelesener Modus ∉ DVhubs Menge.
      const modes = owned.get(key)?.dvhubModes || [];
      if (!modes.includes(found)) { drop('changed_by_user'); continue; }
      // Während der Abfrage kann der Not-Halt oder eine Pause gekommen sein.
      if (isPaused() || restoreBlocked(key, e.loadpoint, bc)) continue;
      const res = await getCharger(cfg, { ...tgt, stopMode: e.restore.mode }).stop();
      if (!res?.ok) continue; // Menge enthält jetzt auch den Rückkehr-Modus: nächster Takt prüft
      // Frisch gelesen bestätigen; sonst bleibt die Rückkehr offen.
      let ok2;
      try { ok2 = await charger.status({ fresh: true }); } catch { ok2 = null; }
      if (ok2?.ok && (ok2.raw?.mode ?? null) === e.restore.mode) done();
    }
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
    // Ziel des Overrides: dorthin gingen seine Befehle. Zurückgestellt wird
    // nur, wo DVhub wirklich etwas geschickt hat (auch ohne Quittung).
    const tgt = ended?.target
      || (lastSent?.override ? { charger: lastSent.charger || bc.charger, loadpoint: lastSent.loadpoint ?? bc.loadpoint } : null);
    if (!tgt || !(owned.has(targetKey(tgt)) || lastSent?.override)) return null;
    const mode = ended?.prevMode || bc.stopMode;
    // Rückkehr vormerken. Ob evcc dann noch in DVhubs Zustand steht, prüft
    // applyPendingRestore gegen die Menge der DVhub-Modi (dvhubModes).
    const hint = (why) => {
      const key = targetKey({ charger: 'evcc', loadpoint: tgt.loadpoint ?? bc.loadpoint });
      const e = owned.get(key) || { charger: 'evcc', loadpoint: tgt.loadpoint ?? bc.loadpoint, identity: wallboxIdentity(cfg, 'evcc'), cmd: 'stop', confirmed: false, gridCap: false };
      setOwned(key, { ...e, restore: { mode, reason: why, at: new Date(now()).toISOString() } });
      pushLog('ev_override_restore_deferred', { mode, loadpoint: tgt.loadpoint ?? null, reason: why });
    };
    // Im Not-Halt nichts schreiben. evcc: Modus von vorher NICHT nachholen
    // (Hinweis statt Automatik); eine direkte Box gibt runTick nach dem
    // Aufheben über releaseIfNeeded frei.
    // Läuft die EOS-Weitergabe (mit Pro), übernimmt der Plan — nach einem
    // Not-Halt eben erst nach dem Aufheben; kein Hinweis nötig.
    if (bc.enabled && isProActive() !== false) { if (lastSent) lastSent = { ...lastSent, key: null, override: false }; return null; }
    if (isPaused()) {
      if (tgt.charger === 'evcc') hint('paused');
      if (lastSent) lastSent = { ...lastSent, override: false };
      return { ok: true, paused: true };
    }
    if (tgt.charger === 'evcc') {
      const evccTgt = { ...bc, charger: 'evcc', loadpoint: tgt.loadpoint ?? bc.loadpoint };
      // Steht eine Leistungsgrenze, bleibt evcc aus: ein eigener evcc-Modus
      // (pv/minpv) hielte sie nicht ein. Den Modus von vorher stellt DVhub dann
      // nicht automatisch her — Hinweis statt aufgeschobener Rückkehr.
      // Nur ein Deckel UNTER dem Mindeststrom hält evcc aus (Rückkehr, sobald
      // der Wächter wieder Luft gibt); darüber kehrt der Modus sofort zurück und
      // evccCapTick begrenzt den Strom über maxcurrent.
      const capNow = getGridCapW();
      if (capNow != null && Number.isFinite(Number(capNow))
        && applyGridCap({ action: 'charge', currentA: evccTgt.maxCurrentA }, evccTgt, capNow).action === 'stop') {
        const res = await hardStopper(cfg, evccTgt, { type: 'evcc' }).stop();
        if (!res?.ok) {
          // Sicherheits-Stopp nicht angekommen: aus dem „Sofort laden“ wird ein
          // „Laden stoppen“ — das wiederholt den harten Stopp in jedem Takt und
          // lässt das Laden nicht wieder aufleben (Codex bcbfaff1/fa219ab7, P1).
          // Es endet wie jedes „Laden stoppen“ (Knopf, Abstecken).
          override = {
            kind: 'stop', powerW: null, requestedW: null, startedAt: ended?.startedAt ?? new Date(now()).toISOString(), until: null,
            seenConnected: ended?.seenConnected === true, prevMode: ended?.prevMode, target: ended?.target, auto: 'grid_cap_stop_failed'
          };
          persistOverride();
          pushLog('ev_override_error', { charger: 'evcc', error: res?.error || 'stop failed', reason, keptAs: 'stop' }, 'warn');
          return res;
        }
        if (lastSent) lastSent = { ...lastSent, override: false, key: null };
        hint('grid_cap');
        return res;
      }
      if (capNow != null && Number.isFinite(Number(capNow))) {
        // Deckel über dem Mindeststrom: Rückkehr im folgenden Takt, sobald
        // evccCapTick den Strom als maxcurrent gesetzt hat (Codex a7aacda4, P1).
        if (lastSent) lastSent = { ...lastSent, override: false, key: null };
        hint('grid_cap');
        return { ok: true, deferred: true };
      }
      // evcc kennt kein „Vorgabe zuruecknehmen“ (release() tut nichts): ohne
      // bekannten Vorher-Modus bliebe es in „now“ und luede weiter. Dann gilt
      // der Stopp-Modus der Bruecke.
      const res = await getCharger(cfg, { ...evccTgt, stopMode: mode }).stop();
      if (res?.ok) {
        lastSent = null;
        // Direkt zurückgegeben: die Modus-Phase von DVhub ist vorbei (Codex 1abbd9d7, P2).
        const k = targetKey(evccTgt);
        const cur = owned.get(k);
        if (cur) setOwned(k, { ...cur, dvhubModes: [] });
      }
      else pushLog('ev_override_error', { charger: 'evcc', error: res?.error || 'stop failed', reason });
      return res;
    }
    // Direkte Box: deren Vorgabe zurücknehmen (auch wenn der Befehl ohne
    // Quittung blieb und es deshalb keinen letzten Befehl gibt).
    if (!lastSent) {
      const e = owned.get(targetKey(tgt));
      if (e) lastSent = { key: null, charger: e.charger, loadpoint: e.loadpoint, action: e.cmd, currentA: null, at: null };
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

    // Ziel dieses Overrides merken: der Not-Halt erkennt daran, welcher
    // Merker zum laufenden „Sofort laden“ gehört (Codex bad876b1).
    override.target = { charger: bc.charger, loadpoint: bc.loadpoint };

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
    // Herkunft: gedeckelt (Grenze) oder normal — ein quittierter normaler
    // Befehl löst eine alte Grenz-Herkunft ab (Codex fa219ab7, P2).
    markGridCap(bc, capped.gridCapW != null);
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
  async function gridCapOnlyTick(cfg, bc, force = false) {
    const capW = getGridCapW();
    if (capW == null || !Number.isFinite(Number(capW)) || bc.charger === 'evcc') return null;
    const charger = getCharger(cfg, bc);
    if (!charger.isConfigured()) return null;
    // Ohne Grenze lädt die Box mit ihrem Höchststrom; mit Grenze höchstens der Anteil.
    const slot = applyGridCap({ action: 'charge', currentA: bc.maxCurrentA }, bc, capW);
    const key = `${bc.charger}:${bc.loadpoint}:p14a:${slot.action}:${slot.currentA ?? ''}`;
    // Erzwungen (Wächter: Deckel geändert oder nicht befolgt): ohne Dubletten-Filter.
    if (!force && lastSent?.key === key) return { ok: true, unchanged: true, gridCapW: Number(capW) };
    const res = slot.action === 'stop' ? await charger.stop() : await charger.charge(slot.currentA);
    if (!res?.ok) {
      lastError = res?.error || 'wallbox write failed';
      pushLog('paragraph14a_wallbox_error', { charger: charger.type, error: lastError });
      return { ok: false, error: lastError };
    }
    lastSent = { key, charger: bc.charger, action: slot.action, currentA: slot.currentA ?? null, loadpoint: bc.loadpoint, at: new Date(now()).toISOString(), gridCap: true };
    markGridCap(bc, true);
    pushLog('paragraph14a_wallbox_capped', { charger: charger.type, capW: Number(capW), action: slot.action, currentA: slot.currentA ?? null });
    return { ok: true, sent: lastSent, gridCapW: Number(capW) };
  }

  // Netzanschluss-Deckel an evcc-Ladepunkten, die DVhub gerade NICHT selbst
  // steuert (kein Plan, kein „Sofort laden“ dort): evcc im eigenen Modus, von
  // Hand gestartet oder ein weiterer Ladepunkt. Deckel ≥ Mindeststrom →
  // maxcurrent (Modus bleibt); darunter Modus „aus“ mit Rückkehr. Ohne Deckel
  // → Ursprungsstrom zurück, den Modus stellt applyPendingRestore zurück.
  // force (Wächter: geändert oder nicht befolgt) sendet ohne Dubletten-Filter.
  async function evccCapTick(cfg, bc, force) {
    let lps;
    try { lps = getEvccLoadpoints() || []; } catch { lps = []; }
    const commanded = bc.charger === 'evcc' && (override != null || (bc.enabled && isProActive() !== false)) ? bc.loadpoint : null;
    const ident = wallboxIdentity(cfg, 'evcc');
    for (const lp of lps) {
      const id = Number(lp?.id);
      if (!(id >= 1) || id === commanded) continue;
      if (isPaused()) return;
      const capW = loadpointCapW(id, bc);
      const key = `evcc:${id}`;
      const e = owned.get(key);
      const tgt = { ...bc, charger: 'evcc', loadpoint: id };
      if (e && e.identity && e.identity !== ident) { setOwned(key, null); continue; }
      const base = e || { charger: 'evcc', loadpoint: id, identity: ident, cmd: 'limit', confirmed: true, gridCap: false };
      if (capW == null) {
        // Auch ein unquittierter Versuch (Ursprungsstrom gemerkt) wird
        // abgeglichen: Strom zurück, Merker weg (Codex b18d6c54, P2).
        if (!e?.gridCap && e?.origMaxCurrentA == null) continue;
        // Strom nur zurück, wenn DVhub ihn (vielleicht) gesenkt hat.
        if (e.origMaxCurrentA != null && (e.limitA != null || e.limitTried === true)) {
          const r = await getCharger(cfg, tgt).limit(e.origMaxCurrentA);
          if (!r?.ok) { pushLog('grid_connection_evcc_error', { loadpoint: id, error: r?.error || 'maxcurrent failed' }); continue; }
        }
        const next = { ...owned.get(key), gridCap: false, limitA: null, limitTried: false, limitOff: false, origMaxCurrentA: null };
        setOwned(key, next.cmd === 'limit' && !next.restore ? null : next);
        pushLog('grid_connection_evcc_released', { loadpoint: id, currentA: e.origMaxCurrentA ?? null });
        continue;
      }
      const { ph, minA } = loadpointParams(lp, bc);
      const orig = e?.origMaxCurrentA ?? (Number(lp.maxCurrentA) >= 6 ? Number(lp.maxCurrentA) : bc.maxCurrentA);
      const capA = Math.min(orig, Math.floor(capW / (bc.voltageV * ph)));
      // Ursprungsstrom VOR dem ersten Befehl merken — eine verlorene Quittung
      // darf ihn nicht durch den schon gesenkten ersetzen (Codex Gesamtrunde, P2).
      if (e?.origMaxCurrentA == null) setOwned(key, { ...(owned.get(key) || base), origMaxCurrentA: orig });
      if (capA < minA) {
        if (!force && e?.limitOff === true) continue;
        const mode = e?.restore?.mode ?? (lp.mode && lp.mode !== 'off' ? lp.mode : null);
        // Rückkehr-Modus VOR dem Befehl merken — eine verlorene Quittung darf
        // ihn nicht verlieren (Gesamtrunde 2, P2).
        if (mode && !e?.restore) {
          setOwned(key, { ...(owned.get(key) || base), restore: { mode, reason: 'grid_cap', at: new Date(now()).toISOString() } });
        }
        const r = await hardStopper(cfg, tgt, { type: 'evcc' }).stop();
        if (!r?.ok) { pushLog('grid_connection_evcc_error', { loadpoint: id, error: r?.error || 'mode off failed' }); continue; }
        const cur = owned.get(key) || base;
        setOwned(key, { ...cur, gridCap: true, limitOff: true, origMaxCurrentA: orig });
        pushLog('grid_connection_evcc_paused', { loadpoint: id, capW, restoreMode: mode });
        continue;
      }
      if (!force && e?.limitA === capA && e?.limitOff !== true) continue;
      if (owned.get(key)?.limitTried !== true) setOwned(key, { ...(owned.get(key) || base), limitTried: true });
      const r = await getCharger(cfg, tgt).limit(capA);
      if (!r?.ok) { pushLog('grid_connection_evcc_error', { loadpoint: id, error: r?.error || 'maxcurrent failed' }); continue; }
      setOwned(key, { ...(owned.get(key) || base), gridCap: true, limitA: capA, limitOff: false, origMaxCurrentA: orig });
      pushLog('grid_connection_evcc_limited', { loadpoint: id, capW, currentA: capA });
    }
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
      let overrideRes = null;
      if (override) {
        overrideRes = await overrideTick(cfg, bc, force);
        if (!overrideRes) force = true;
      }
      if (isPaused()) return overrideRes || { ok: false, skipped: 'paused' };
      // Netzanschluss-Deckel an allen evcc-Ladepunkten, die DVhub gerade nicht
      // selbst steuert; danach ausstehende Rückkehr (auch während eines
      // laufenden Overrides an einem anderen Ladepunkt).
      await evccCapTick(cfg, bc, force);
      await applyPendingRestore(cfg, bc);
      if (overrideRes) return overrideRes;
      if (isPaused()) return { ok: false, skipped: 'paused' };
      await releaseOrphans(cfg, bc);
      if (!bc.enabled) {
        // §14a EnWG gilt für die Wallbox auch dann, wenn EOS sie nicht steuert:
        // begrenzt der Netzbetreiber, deckelt DVhub eine direkt angebundene
        // Wallbox (OpenEVSE, go-e) auf ihren Anteil und gibt sie danach wieder frei.
        const capped = await gridCapOnlyTick(cfg, bc, force);
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
        const capped = await gridCapOnlyTick(cfg, bc, force);
        if (capped) return capped;
        // Grenze weg: die eigene Grenz-Vorgabe zurücknehmen (Gesamtprüfung 3, P2).
        if (lastSent?.gridCap === true) await releaseIfNeeded(cfg, bc);
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
      // Max-Ladestand erreicht: Laden endet — hart (wie „aus“), auch wenn der
      // Plan noch laden will oder der Stopp-Modus PV-Laden erlaubte. Nur DVhubs
      // eigener Plan; „Sofort laden“ von Hand ist oben schon durch.
      let maxLimit;
      try { maxLimit = getEvMaxStop(); } catch { maxLimit = null; }
      const maxEval = evaluateMaxStop(maxLimit, maxHold, now());
      if (maxEval.stop && !maxHold) pushLog('ev_max_soc_reached', { maxSocPct: maxEval.hold.maxSocPct, socPct: maxLimit.socPct, planned: slot.action });
      if (!maxEval.stop && maxHold) pushLog('ev_max_soc_released', { maxSocPct: maxHold.maxSocPct, socPct: maxLimit?.socPct ?? null });
      maxHold = maxEval.hold;
      const maxStop = maxEval.stop;
      if (maxStop) slot = { ...slot, action: 'stop', currentA: null, chargePowerW: null, maxStop: true };
      // Sicherheits-Stopp aus dem wirksamen Deckel, egal ob der Plan laden
      // wollte: auch ein geplanter Stopp-Slot geht bei Deckel unter dem
      // Mindeststrom hart auf „aus“ (Codex 4bf1eb18, P1).
      // Steht irgendein Deckel, heißt ein Stopp-Slot „aus“: ein eigener Modus
      // (pv/minpv, release()) hielte auch eine Teil-Grenze nicht ein
      // (Gesamtprüfung 2, P1).
      // Einphasig, wenn die geplante Leistung unter dreiphasigem Mindeststrom
      // liegt und der Ladepunkt umschalten kann — nicht unter einer
      // Leistungsgrenze (der Netzanschluss-Wächter rechnet die Wallbox dreiphasig).
      if (slot.action === 'charge' && typeof charger.setPhases === 'function' && getGridCapW() == null
        && onePhaseChargingAvailable(cfg, getEvccLoadpoints())) {
        if (Number(slot.chargePowerW) < minChargeW(bc)) {
          const one = { ...bc, phases: 1 };
          slot = { ...slot, phases: 1, currentA: powerToCurrentA(slot.chargePowerW, one) };
        } else slot = { ...slot, phases: 3 };
      }
      const capStop = slot.action === 'stop' && (slot.gridCapW != null || getGridCapW() != null);
      const hardStop = capStop || maxStop;
      const key = capStop ? `${bc.charger}:${bc.loadpoint}:grid-cap-stop`
        : (maxStop ? `${bc.charger}:${bc.loadpoint}:max-soc-stop` : commandKey(bc, slot));
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

      const result = hardStop ? await hardStopper(cfg, bc, charger).stop() : await send(charger, bc, slot);
      if (!result?.ok) {
        lastError = result?.error || 'evcc write failed';
        pushLog('eos_evcc_error', { loadpoint: bc.loadpoint, action: slot.action, error: lastError });
        return { ok: false, error: lastError };
      }
      lastError = planNote;
      const hadGridCap = owned.get(targetKey(bc))?.gridCap === true;
      lastSent = {
        key,
        charger: bc.charger,
        action: slot.action,
        currentA: slot.currentA,
        chargePowerW: slot.chargePowerW,
        ...(slot.phases ? { phases: slot.phases } : {}),
        loadpoint: bc.loadpoint,
        mode: slot.action === 'charge' ? 'now' : (hardStop ? 'off' : bc.stopMode),
        released: slot.action !== 'charge' && !hardStop && bc.charger !== 'evcc' && bc.stopMode !== 'off',
        ...(capStop ? { gridCapW: slot.gridCapW ?? getGridCapW() } : {}),
        ...(maxStop ? { maxSocPct: maxHold?.maxSocPct ?? null } : {}),
        slotTs: new Date(slot.ts).toISOString(),
        at: new Date(now()).toISOString()
      };
      // Der Plan ersetzt eine gespeicherte Grenz-Vorgabe — Vermerk löschen
      // (Codex c45418be, P2).
      if (hadGridCap) markGridCap(bc, false);

      if (capStop) markGridCap(bc, true);
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
        // Jedes Ziel, an dem DVhubs letzter Befehl „laden“ war (quittiert oder
        // nicht), für sich: frisch prüfen, dann einmal hart aus.
        const targets = [...owned.values()].filter((e) => e.cmd === 'charge');
        if (!targets.length) return { ok: true, skipped: lastSent || owned.size ? 'not_charging' : 'not_controlled' };
        const stopped = [];
        const skipped = [];
        const errors = [];
        for (const ref of targets) {
          const bc = { ...bc0, charger: ref.charger || bc0.charger, loadpoint: Number(ref.loadpoint) >= 1 ? Number(ref.loadpoint) : bc0.loadpoint };
          const charger = getCharger(cfg, bc);
          if (!charger?.isConfigured?.()) { skipped.push('not_configured'); continue; }
          // Eingestelltes Gerät ist nicht mehr das, dem DVhub den Befehl gab:
          // das neue nicht anfassen, das alte ist nicht mehr adressierbar (Punkt 1).
          // Identität gerade nicht auflösbar: unbekannt — nichts senden, behalten.
          let curIdent;
          try { curIdent = typeof charger.identity === 'function' ? charger.identity() : wallboxIdentity(cfg, bc.charger); } catch { curIdent = null; }
          if (ref.identity && curIdent == null) { skipped.push('state_unknown'); continue; }
          if (ref.identity && ref.identity !== curIdent) {
            pushLog('ev_emergency_stop_identity_changed', { charger: bc.charger, loadpoint: bc.loadpoint }, 'warn');
            setOwned(targetKey(bc), null);
            skipped.push('identity_changed');
            continue;
          }
          const refState = { ...ref, currentAs: [ref.currentA, ref.confirmedCurrentA].filter((c) => c != null && Number.isFinite(Number(c))) };
          if (charger.type !== 'evcc') {
            // Direkte Box: frisch lesen, ob DVhubs Befehl noch steht (Punkt 2).
            // Kann der Adapter das nicht: nicht senden („im Zweifel nicht“).
            let ds = null;
            if (typeof charger.dvhubState === 'function') {
              try { ds = await charger.dvhubState(refState); } catch { ds = null; }
            }
            if (!ds?.known) {
              pushLog('ev_emergency_stop_state_unknown', { charger: bc.charger }, 'warn');
              skipped.push('state_unknown');
              continue;
            }
            if (!ds.active) {
              setOwned(targetKey(bc), null);
              skipped.push('not_dvhub_state');
              continue;
            }
          }
          if (charger.type === 'evcc') {
            let st;
            // Frisch gelesen, nicht aus dem Abfrage-Puffer. Im Zweifel nichts senden.
            try { st = await charger.status({ fresh: true }); } catch { st = null; }
            if (!st?.ok) { skipped.push('state_unknown'); continue; } // Datensatz bleibt für den nächsten Not-Halt
            if ((st.raw?.mode ?? null) !== 'now') {
              // Nachweislich von Hand umgestellt: DVhubs Anspruch erlischt.
              setOwned(targetKey(bc), null);
              skipped.push('not_dvhub_state');
              continue;
            }
          }
          const res = await hardStopper(cfg, bc, charger).stop();
          if (!res?.ok) { errors.push(res?.error || 'wallbox write failed'); continue; } // Datensatz bleibt „charge“
          stopped.push(`${bc.charger}:${bc.loadpoint}`);
        }
        if (stopped.length) {
          // Nach dem Aufheben gilt kein früherer Befehl als „unverändert“. Gab
          // es noch keinen quittierten Befehl, merkt der neue Merker das Ziel —
          // sonst gäbe die Brücke eine direkte Box nie wieder frei (bcbfaff1, P2).
          if (lastSent) lastSent = { ...lastSent, key: null };
          else {
            const [charger, lp] = stopped[0].split(':');
            lastSent = { key: null, charger, loadpoint: Number(lp) || null, action: 'stop', currentA: null, override: override != null, at: new Date(now()).toISOString() };
          }
          pushLog('ev_emergency_stop', { targets: stopped });
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
      // Weitergabe), im Lock bestimmt. Laeuft schon ein Override, bleibt dessen
      // Herkunft.
      return locked(async () => {
        // Offener Hinweis zu diesem Ladepunkt: DAS war der Modus von vorher —
        // nicht das von DVhub gesetzte „aus“.
        const pending = bc.charger === 'evcc' ? owned.get(targetKey(bc)) : null;
        if (!override && pending?.restore) {
          // Ausstehende Rückkehr an diesem Ladepunkt: DAS ist der Modus von
          // vorher; das Ende dieses Overrides stellt ihn her.
          next.prevMode = pending.restore.mode;
          setOwned(targetKey(bc), { ...pending, restore: null });
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
    /** Steht eine evcc-Rückkehr aus? (Netzanschluss-Wächter: Wallbox bleibt eingeschrieben.) */
    hasPendingRestore: () => pendingRestores().length > 0,
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
        onePhaseCharging: (() => { try { return onePhaseChargingAvailable(cfg, getEvccLoadpoints()); } catch { return false; } })(),
        // Max-Ladestand: Grenze, Ladestand und ob DVhub gerade deshalb nicht lädt.
        maxStop: (() => {
          let l;
          try { l = getEvMaxStop(); } catch { l = null; }
          return l ? { maxSocPct: l.maxSocPct, socPct: l.socPct ?? null, active: !!maxHold, since: maxHold?.since ?? null } : null;
        })(),
        solutionGeneratedAt: lastGeneratedAt,
        override: override ? { ...override, ...overrideLimits(bc) } : null,
        overrideLimits: overrideLimits(bc),
        current: current ? { ...current, ts: new Date(current.ts).toISOString(), endTs: new Date(current.endTs).toISOString() } : null,
        lastSent,
        lastError: lastError || (pendingRestores()[0]
          ? `evcc stand vor „Sofort laden“ auf „${pendingRestores()[0].restore.mode}“ — DVhub stellt es zurück, sobald ${pendingRestores()[0].restore.reason === 'paused' ? 'der Not-Halt aufgehoben ist' : 'keine Leistungsgrenze mehr gilt'}.`
          : null),
        restoreHint: pendingRestores()[0] ? { ...pendingRestores()[0].restore, loadpoint: pendingRestores()[0].loadpoint } : null,
        lastTickAt: lastTickAt ? new Date(lastTickAt).toISOString() : null,
        // Die naechsten 24 h fuer die Anzeige.
        plan: lastPlan
          .filter((slot) => slot.endTs > t && slot.ts < t + 24 * 3600_000)
          .map((slot) => ({ ...slot, ts: new Date(slot.ts).toISOString(), endTs: new Date(slot.endTs).toISOString() }))
      };
    }
  };
}
