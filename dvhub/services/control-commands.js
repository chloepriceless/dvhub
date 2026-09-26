// services/control-commands.js -- gemeinsame Steuer-Primitiven (2026-09-26).
//
// Anlass (Christin): "MQTT-Steuerung auf Bidirektionalität ausbauen, sodass die
// Regler in Home Assistant bedienbar werden." Damit HTTP-Route UND MQTT-Command-
// Handler denselben, geprüften Steuerpfad nutzen (keine Divergenz auf dem
// sicherheitskritischen Pfad), liegt die Kernlogik der drei Steuer-Endpunkte
// hier statt inline in routes-api.js:
//   - POST /api/control/write            -> applyManualControlWrite
//   - POST /api/control/stop | /resume   -> setEmergencyStop
//   - POST /api/ev                       -> applyEvConfigPatch
//
// Jede Funktion nimmt den DI-`ctx` (state, pushLog, applyControlTarget,
// assertValidRuntimeCommand, telemetryStore, persistControlState, getRawCfg,
// saveAndApplyConfig, optimizerService) und liefert ein Ergebnis-Objekt mit
// `status` (HTTP-Code, den die Route 1:1 durchreicht). Bounds/Gates bleiben
// unverändert: controlWriteBoundsError + applyControlTarget-Chokepoint
// (schedule-eval.js) mit Not-Halt-Gate, Min-SoC-Clamp und enabled-Gate.

import { controlWriteBoundsError, MAX_MINSOC_PCT } from '../server-utils.js';
import { parseEvDeparturePatch } from './optimizer/ev-departure.js';

// Identisch zu routes-api.js: die generischen Steuerziele, die manuell
// geschrieben werden dürfen. feedExcessDcPv bleibt Victron-spezifisch.
export const VALID_CONTROL_TARGETS = Object.freeze(new Set([
  'gridSetpointW', 'chargeCurrentA', 'feedExcessDcPv', 'minSocPct', 'maxDischargeW',
]));

/**
 * Manuellen Sollwert schreiben (oder Override löschen). Spiegelt POST
 * /api/control/write. `assertValidRuntimeCommand` wirft bei ungültigem Kommando
 * (statusCode 400) — bewusst wie bisher; die Route fängt es im Top-Level-Handler,
 * der MQTT-Subscriber in seinem try/catch.
 *
 * @param {object} ctx
 * @param {{target:string, value?:number, persist?:boolean, clear?:boolean, actor?:object, reason?:string}} opts
 * @returns {Promise<object>} { ok, status, ... }
 */
export async function applyManualControlWrite(ctx, opts) {
  const { target, value, persist = false, clear = false, actor = null, reason = 'api_manual_write' } = opts || {};
  const state = ctx.state;
  if (!VALID_CONTROL_TARGETS.has(target)) return { ok: false, status: 400, error: 'invalid target' };

  // Override explizit löschen -> Zeitplan fällt beim nächsten Eval auf
  // Default/Regel zurück.
  if (clear === true) {
    delete state.schedule.manualOverride[target];
    ctx.pushLog('control_override_cleared', { target }, actor || undefined);
    return { ok: true, status: 200, cleared: true, target };
  }

  const num = Number(value);
  const boundsErr = controlWriteBoundsError(target, num);
  if (boundsErr) return { ok: false, status: 400, ...boundsErr };
  if (target === 'minSocPct' && (num < 0 || num > MAX_MINSOC_PCT)) {
    return { ok: false, status: 400, error: 'minsoc_out_of_range', max: MAX_MINSOC_PCT };
  }
  ctx.assertValidRuntimeCommand('control_write', { target, value: num });
  state.schedule.manualOverride[target] = persist === true
    ? { value: num, at: Date.now(), persistent: true }
    : { value: num, at: Date.now() };
  const result = await ctx.applyControlTarget(target, num, reason);
  ctx.pushLog('control_write', {
    target,
    value: num,
    result: result.ok ? 'applied' : 'rejected',
    error: result.error || null,
  }, actor || undefined);
  if (result.ok && ctx.telemetryStore?.writeManualOverride) {
    // Fire-and-forget — ein Persist-Fehler darf einen angewandten Schreibvorgang
    // nie zu einem 500 machen.
    ctx.telemetryStore.writeManualOverride({
      target,
      value_num: num,
      ts_utc: new Date(),
      ...(actor || {}),
      reason,
    }).catch((err) => ctx.pushLog('manual_override_persist_error', { error: err?.message ?? String(err) }, actor || undefined));
  }
  return { ...result, status: result.ok ? 200 : 500 };
}

/**
 * Not-Halt setzen/aufheben. Spiegelt POST /api/control/stop bzw. /resume.
 * on=true pausiert alle diskretionären Hardware-Schreibvorgänge und neutralisiert
 * einmalig gridSetpointW=0; on=false nimmt die Pause zurück (nächster Eval-Takt
 * ~15 s re-appliziert Regeln/Default).
 *
 * @param {object} ctx
 * @param {{on:boolean, actor?:object}} opts
 * @returns {Promise<object>} { ok, status, ... }
 */
export async function setEmergencyStop(ctx, opts) {
  const { on, actor = null } = opts || {};
  const state = ctx.state;

  if (on) {
    if (state.ctrl.discretionaryWritesPaused) {
      return { ok: true, status: 200, alreadyStopped: true, pausedAt: state.ctrl.pausedAt };
    }
    // Reihenfolge: erst Flag setzen (kein diskretionärer Write kann dazwischen),
    // dann EINE aktive Neutralisierung.
    state.ctrl.discretionaryWritesPaused = true;
    state.ctrl.pausedAt = Date.now();
    state.ctrl.pausedBy = actor?.actor_ip || 'unknown';
    state.ctrl._stopBlockLogged = {};
    ctx.persistControlState?.();
    ctx.pushLog('emergency_stop_activated', { by: state.ctrl.pausedBy }, { ...(actor || {}), severity: 'warn' });
    let neutralize = null;
    try {
      neutralize = await ctx.applyControlTarget('gridSetpointW', 0, 'emergency_stop');
    } catch (e) {
      neutralize = { ok: false, error: e.message };
    }
    // Kein Setpoint-Stellpfad aktiviert (z. B. Fronius M124) -> nichts zu
    // neutralisieren, kein Fehler.
    if (!neutralize?.ok && neutralize?.error === 'write target not enabled in config') {
      neutralize = { ok: true, skipped: true, reason: 'target_not_enabled' };
    }
    if (!neutralize?.ok && !neutralize?.skipped) {
      ctx.pushLog('emergency_stop_neutralize_failed', { error: neutralize?.error || 'unknown' }, { ...(actor || {}), severity: 'error' });
    }
    return { ok: true, status: 200, paused: true, pausedAt: state.ctrl.pausedAt, neutralize };
  }

  // Resume
  if (!state.ctrl.discretionaryWritesPaused) {
    return { ok: true, status: 200, alreadyRunning: true };
  }
  state.ctrl.discretionaryWritesPaused = false;
  state.ctrl.pausedAt = 0;
  state.ctrl.pausedBy = null;
  state.ctrl._stopBlockLogged = {};
  ctx.persistControlState?.();
  ctx.pushLog('emergency_stop_resumed', {}, { ...(actor || {}), severity: 'warn' });
  return { ok: true, status: 200, resumed: true };
}

/**
 * E-Auto-Konfiguration patchen. Spiegelt POST /api/ev: nur optimizer.*-Felder
 * (eosOptimizeEv, evPlanOnlyWhenPlugged, Abfahrt/Ziel-SoC), niemals evcc/Wallbox
 * direkt. Bei geänderter Mitplanung sofort neu planen statt bis zum nächsten Takt.
 *
 * @param {object} ctx
 * @param {{body:object, actor?:object}} opts  body: { optimizeEv?, onlyWhenPlugged?, departure? }
 * @returns {object} { ok, status, ... }
 */
export function applyEvConfigPatch(ctx, opts) {
  const { body = {}, actor = null } = opts || {};
  const patch = {};
  if ('optimizeEv' in body) patch.eosOptimizeEv = body.optimizeEv === true;
  if ('onlyWhenPlugged' in body) patch.evPlanOnlyWhenPlugged = body.onlyWhenPlugged === true;
  if (body.departure != null) {
    const dep = parseEvDeparturePatch(body.departure);
    if (!dep.ok) return { ok: false, status: 400, error: dep.error };
    Object.assign(patch, dep.patch);
  }
  if (!Object.keys(patch).length) return { ok: false, status: 400, error: 'nothing to change' };
  const next = JSON.parse(JSON.stringify(ctx.getRawCfg() || {}));
  next.optimizer = (next.optimizer && typeof next.optimizer === 'object') ? next.optimizer : {};
  Object.assign(next.optimizer, patch);
  try {
    ctx.saveAndApplyConfig(next);
  } catch (e) {
    ctx.pushLog('ev_config_save_error', { error: e.message });
    return { ok: false, status: 500, error: 'save failed' };
  }
  ctx.pushLog('ev_config_saved', patch, actor || undefined);
  if ('eosOptimizeEv' in patch || 'evPlanOnlyWhenPlugged' in patch) {
    ctx.optimizerService?.requestEosReplan?.('ev_config');
  }
  return { ok: true, status: 200, patch };
}
