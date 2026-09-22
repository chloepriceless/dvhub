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
 * Geschrieben wird nur bei einem Wechsel des Befehls (Slotgrenze oder neuer
 * Plan), nicht in jedem Takt — ein manueller Eingriff in evcc bleibt bis zum
 * naechsten Wechsel stehen, wie beim Akku-Schutz in evcc-integration.js.
 */
import { safeInterval } from '../safe-async.js';

const DEFAULT_VOLTAGE_V = 230;
const STOP_MODES = ['off', 'pv', 'minpv'];

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
    maxCurrentA: Math.max(minCurrentA, maxChargeW / (DEFAULT_VOLTAGE_V * phases)),
    maxChargeW,
    stopMode: STOP_MODES.includes(opt.evStopMode) ? opt.evStopMode : 'off'
  };
}

/**
 * Ladeleistung → Ladestrom je Phase. evcc kann nicht unter den Mindeststrom
 * regeln: plant EOS weniger, laedt der Ladepunkt mit dem Mindeststrom (EOS will
 * laden; ganz auszulassen waere die groessere Abweichung vom Plan).
 */
export function powerToCurrentA(powerW, bc) {
  const raw = powerW / (bc.voltageV * bc.phases);
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

/** Slot, der `nowMs` enthaelt — oder null (Plan veraltet / noch keiner). */
export function slotAt(plan, nowMs) {
  return plan.find((slot) => slot.ts <= nowMs && nowMs < slot.endTs) || null;
}

/**
 * @param {object} deps
 * @param {() => object} deps.getCfg
 * @param {(limit:number) => Promise<object|null>} deps.getSolution   eosAdapter.getOptimizationSolution
 * @param {{ setMode:Function, setMaxCurrent:Function }} deps.evcc
 * @param {() => boolean} [deps.isProActive]
 * @param {(event:string, data?:object) => void} [deps.pushLog]
 * @param {() => number} [deps.now]
 */
export function createEosEvccBridge(deps) {
  const {
    getCfg, getSolution, evcc,
    isProActive = () => true,
    pushLog = () => {},
    now = () => Date.now()
  } = deps;

  let timer = null;
  let lastSent = null;       // { key, action, currentA, loadpoint, mode, at }
  let lastError = null;
  let lastPlan = [];
  let lastGeneratedAt = null;
  let lastTickAt = 0;
  let ticking = false;

  const commandKey = (bc, slot) => (slot.action === 'charge'
    ? `${bc.loadpoint}:charge:${slot.currentA}`
    : `${bc.loadpoint}:stop:${bc.stopMode}`);

  async function send(bc, slot) {
    if (slot.action === 'charge') {
      // Erst den Strom, dann den Modus: sonst startet evcc mit dem alten
      // (evtl. hoeheren) Strom und regelt erst danach herunter.
      const cur = await evcc.setMaxCurrent(bc.loadpoint, slot.currentA);
      if (!cur?.ok) return cur || { ok: false, error: 'maxcurrent failed' };
      return evcc.setMode(bc.loadpoint, 'now');
    }
    return evcc.setMode(bc.loadpoint, bc.stopMode);
  }

  async function tick({ force = false } = {}) {
    if (ticking) return { ok: false, error: 'busy' };
    ticking = true;
    try {
      lastTickAt = now();
      const cfg = getCfg() || {};
      const bc = resolveEvccBridgeConfig(cfg);
      if (!bc.enabled) return { ok: false, skipped: 'disabled' };
      if (!cfg.evcc?.url) return { ok: false, skipped: 'no evcc url' };
      if (isProActive() === false) return { ok: false, skipped: 'pro required' };

      const solution = await getSolution(8 * 24 * 4);
      lastGeneratedAt = solution?.generatedAt || null;
      lastPlan = buildEvPlan(solution, bc);
      let slot = slotAt(lastPlan, now());
      if (!slot || !slot.action) {
        lastError = slot ? 'EOS-Plan ohne E-Auto-Werte (E-Auto in EOS angemeldet?)' : 'kein EOS-Slot fuer jetzt';
        // Haben WIR zuletzt Laden befohlen, darf ein fehlender Plan (EOS weg,
        // Loesung abgelaufen) das Auto nicht ungebremst weiterladen lassen.
        if (lastSent?.action !== 'charge') return { ok: false, skipped: lastError };
        pushLog('eos_evcc_plan_lost', { reason: lastError });
        slot = { ts: now(), endTs: now(), action: 'stop', currentA: null, chargePowerW: null };
      }

      const key = commandKey(bc, slot);
      if (!force && lastSent?.key === key) return { ok: true, unchanged: true };

      const result = await send(bc, slot);
      if (!result?.ok) {
        lastError = result?.error || 'evcc write failed';
        pushLog('eos_evcc_error', { loadpoint: bc.loadpoint, action: slot.action, error: lastError });
        return { ok: false, error: lastError };
      }
      lastError = null;
      lastSent = {
        key,
        action: slot.action,
        currentA: slot.currentA,
        chargePowerW: slot.chargePowerW,
        loadpoint: bc.loadpoint,
        mode: slot.action === 'charge' ? 'now' : bc.stopMode,
        slotTs: new Date(slot.ts).toISOString(),
        at: new Date(now()).toISOString()
      };
      pushLog('eos_evcc_command', lastSent);
      return { ok: true, sent: lastSent };
    } catch (err) {
      lastError = err?.message || String(err);
      pushLog('eos_evcc_error', { error: lastError });
      return { ok: false, error: lastError };
    } finally {
      ticking = false;
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
    getStatus() {
      const cfg = getCfg() || {};
      const bc = resolveEvccBridgeConfig(cfg);
      const t = now();
      const current = slotAt(lastPlan, t);
      return {
        enabled: bc.enabled,
        evccUrlSet: Boolean(cfg.evcc?.url),
        loadpoint: bc.loadpoint,
        phases: bc.phases,
        minCurrentA: bc.minCurrentA,
        maxCurrentA: Math.round(bc.maxCurrentA * 10) / 10,
        stopMode: bc.stopMode,
        solutionGeneratedAt: lastGeneratedAt,
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
