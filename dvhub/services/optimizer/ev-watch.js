/**
 * Minuten-Wache fuers E-Auto (aus server.js herausgeloest, damit testbar).
 *
 * Jede Minute:
 *   1. Ladestand merken (ev-arrival.js createEvSocMemory) — Schaetzbasis fuer
 *      den erwarteten Ladestand bei Ankunft, auch nach dem Abstecken.
 *   2. Steck-Wache (optimizer.evPlanOnlyWhenPlugged): aendert sich der
 *      entprellte Steck-Zustand, meldet der volle Abgleich das Auto an bzw. ab
 *      und EOS rechnet sofort neu.
 *   3. Vorplanung (ev-registration.js): beginnt oder endet sie ohne
 *      Steckwechsel (Ankunft rueckt naeher, EOS kann neu Ladestart, Kulanz
 *      vorbei), ebenso voller Abgleich + Neuplan.
 *   4. Sonst nur das Fahrzeug an EOS schicken, wenn sich Abfahrt, Ziel,
 *      Ladestart, Max-Ladestand oder Wertstufen (ev-targets.js) geaendert
 *      haben — der volle Abgleich alle 15 min waere zu spaet: ein vergangener
 *      Termin heisst fuer EOS „sofort laden“.
 *   0. Davor (immer, auch ohne EOS-Planung): Einmal-Ziel beenden — beim
 *      Abstecken kurz vor der einmaligen Abfahrt (evOnceUnplugPatch) und
 *      abgelaufene Einmal-Ziele aus der Config raeumen (evOnceCleanupPatch).
 *      Ein vergangenes Einmal-Ziel wirkt so nie still weiter.
 */
import { resolveEvDeparture, evOnceCleanupPatch, evOnceUnplugPatch } from './ev-departure.js';
import { createEvPlugTracker, resolveEvPlugged, resolveEvSocReading } from './ev-soc.js';
import { computeEvRegistration } from './ev-registration.js';
import { resolveEvTargets } from './ev-targets.js';

export function createEvWatch({ ctx, eosConfigSync, requestReplan, pushLog = () => {}, stableTicks = 2 }) {
  const plugTracker = createEvPlugTracker({ stableTicks });
  // Anmeldung (angemeldet? vorgeplant?) ebenso entprellt: erst wenn sie zwei
  // Minuten gleich anders ist, voller Abgleich + Neuplan. Ein einzelner
  // Wackler (Ladestand kurz weg) loest so nichts aus, ein bleibender Wechsel
  // (Ladestand kommt nach dem Anstecken, Vorplanung beginnt) schon.
  let regTracker = createEvPlugTracker({ stableTicks });
  let lastKey = null;
  let syncPending = 0;
  let pendingReason = null;
  const lastOnceKey = new Map();   // je Ereignis der zuletzt gespeicherte Patch

  // Einmal-Ziel-Felder in optimizer.* speichern (wie POST /api/ev). Ohne
  // Speicherweg (Tests, alte ctx) nichts tun.
  function saveOncePatch(patch, event) {
    if (!patch || !Object.keys(patch).length) { lastOnceKey.delete(event); return false; }
    if (typeof ctx.getRawCfg !== 'function' || typeof ctx.saveAndApplyConfig !== 'function') return false;
    const raw = ctx.getRawCfg() || {};
    const next = JSON.parse(JSON.stringify(raw));
    next.optimizer = (next.optimizer && typeof next.optimizer === 'object') ? next.optimizer : {};
    const before = {};
    for (const k of Object.keys(patch)) before[k] = next.optimizer[k] ?? null;
    // Derselbe Patch auf denselben Stand schon einmal gespeichert und trotzdem
    // wieder faellig (Config wehrt sich): nicht jede Minute neu schreiben.
    const key = JSON.stringify([before, patch]);
    if (key === lastOnceKey.get(event)) return false;
    lastOnceKey.set(event, key);
    Object.assign(next.optimizer, patch);
    try {
      ctx.saveAndApplyConfig(next);
    } catch (e) {
      // naechste Minute erneut (ein vergangenes Ziel soll nicht stehen bleiben)
      lastOnceKey.delete(event);
      pushLog('ev_once_save_error', { event, error: e?.message || String(e) });
      return false;
    }
    pushLog(event, { before, patch });
    return true;
  }

  async function tick(nowMs = Date.now()) {
    ctx.evSocMemory?.observe?.(resolveEvSocReading(ctx, nowMs));
    // Abgelaufenes Einmal-Ziel abraeumen — unabhaengig von der EOS-Planung.
    saveOncePatch(evOnceCleanupPatch(ctx.getCfg(), nowMs), 'ev_once_expired');
    let cfg = ctx.getCfg();
    const opt = cfg?.optimizer || {};
    if (opt.eosOptimizeEv !== true || !opt.eosProxy?.enabled) { lastKey = null; regTracker = createEvPlugTracker({ stableTicks }); return { action: 'off' }; }

    const plug = plugTracker.update(resolveEvPlugged(ctx));
    // Abgesteckt kurz vor der einmaligen Abfahrt: das ist die Abfahrt.
    if (plug.changed && plug.from === true && plug.stable === false) {
      if (saveOncePatch(evOnceUnplugPatch(cfg, nowMs), 'ev_once_departed')) cfg = ctx.getCfg();
    }

    const reg = computeEvRegistration(ctx, cfg, {
      chargeStartSupported: ctx.state?.optimizer?.eos?.evChargeStart === true,
      plugged: plugTracker.stable,
      nowMs,
    });
    const regKey = `${reg.register}|${reg.mode === 'preplan'}`;
    const regPrev = regTracker.stable;
    if (plug.changed) {
      // Steckwechsel (schon entprellt): EIN Abgleich + Neuplan — mit „nur
      // angesteckt planen“ immer, sonst nur, wenn sich die Anmeldung aendert.
      // Die Anmeldungs-Wache bekommt den neuen Stand gleich mit, sonst feuerte
      // sie denselben Wechsel eine Minute spaeter ein zweites Mal.
      if (opt.evPlanOnlyWhenPlugged !== false || (regPrev !== undefined && regPrev !== regKey)) {
        pushLog('ev_plug_change', { from: plug.from, plugged: plug.stable });
        syncPending = 5;
        pendingReason = plug.stable ? 'ev_plugged' : 'ev_unplugged';
      }
      regTracker = createEvPlugTracker({ stableTicks });
      regTracker.update(regKey);
    } else if (regTracker.update(regKey).changed && syncPending === 0) {
      const wasPreplan = String(regPrev).endsWith('|true');
      const isPreplan = reg.mode === 'preplan';
      pushLog('ev_registration_change', { mode: reg.mode, register: reg.register, arrivalAt: reg.arrivalAt, preplanBlocked: reg.preplanBlocked, reason: reg.reason });
      syncPending = 5;
      pendingReason = isPreplan && !wasPreplan ? 'ev_preplan' : (!isPreplan && wasPreplan ? 'ev_preplan_end' : 'ev_registration');
    }

    // Scheitert der Abgleich (EOS gerade weg), naechste Minute erneut —
    // hoechstens 5x, dann trotzdem neu planen (ein dauerhafter Teilfehler
    // darf den Neuplan nicht blockieren).
    if (syncPending > 0) {
      const res = await eosConfigSync.sync();
      syncPending -= 1;
      if (res?.ok === false && syncPending > 0) return { action: 'retry' };
      if (res?.ok === false) pushLog('ev_plug_sync_failed', { errors: res?.errors || null });
      syncPending = 0;
      requestReplan(pendingReason);
      lastKey = null;
      return { action: 'full', reason: pendingReason };
    }

    const d = resolveEvDeparture(cfg, nowMs);
    let t;
    try { t = resolveEvTargets(ctx, cfg, { decision: reg, valueSupported: ctx.state?.optimizer?.eos?.evSocValue === true, nowMs }); } catch { t = null; }
    const key = `${d.enabled}|${d.departureAt}|${d.targetSocPct}|${reg.chargeStartAt}|${t?.minSocPct}|${t?.maxSocPct}|${JSON.stringify(t?.steps ?? null)}`;
    if (key === lastKey) return { action: 'none' };
    const res = await eosConfigSync.syncEv();
    if (res?.ok) lastKey = key; // bei Fehler naechste Minute erneut
    return { action: 'ev', ok: res?.ok === true };
  }

  return { tick };
}
