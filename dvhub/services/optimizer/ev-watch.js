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
 *   4. Sonst nur das Fahrzeug an EOS schicken, wenn sich Abfahrt, Ziel oder
 *      Ladestart geaendert haben — der volle Abgleich alle 15 min waere zu
 *      spaet: ein vergangener Termin heisst fuer EOS „sofort laden“.
 */
import { resolveEvDeparture } from './ev-departure.js';
import { createEvPlugTracker, resolveEvPlugged, resolveEvSocReading } from './ev-soc.js';
import { computeEvRegistration } from './ev-registration.js';

export function createEvWatch({ ctx, eosConfigSync, requestReplan, pushLog = () => {}, stableTicks = 2 }) {
  const plugTracker = createEvPlugTracker({ stableTicks });
  let lastKey = null;
  let lastRegKey = null;
  let syncPending = 0;
  let pendingReason = null;

  async function tick(nowMs = Date.now()) {
    ctx.evSocMemory?.observe?.(resolveEvSocReading(ctx, nowMs));
    const cfg = ctx.getCfg();
    const opt = cfg?.optimizer || {};
    if (opt.eosOptimizeEv !== true || !opt.eosProxy?.enabled) { lastKey = null; lastRegKey = null; return { action: 'off' }; }

    const plug = plugTracker.update(resolveEvPlugged(ctx));
    if (opt.evPlanOnlyWhenPlugged !== false && plug.changed) {
      pushLog('ev_plug_change', { from: plug.from, plugged: plug.stable });
      syncPending = 5;
      pendingReason = plug.stable ? 'ev_plugged' : 'ev_unplugged';
    }

    const reg = computeEvRegistration(ctx, cfg, {
      chargeStartSupported: ctx.state?.optimizer?.eos?.evChargeStart === true,
      plugged: plugTracker.stable,
      nowMs,
    });
    // Nur Beginn/Ende der Vorplanung — An-/Abmelden wegen Stecker oder
    // fehlendem Ladestand regeln die (entprellte) Steck-Wache und der
    // 15-min-Abgleich; ein einzelner Wackler loeste sonst zwei Neuplaene aus.
    const regKey = String(reg.mode === 'preplan');
    if (lastRegKey !== null && regKey !== lastRegKey && syncPending === 0) {
      pushLog('ev_preplan_change', { mode: reg.mode, register: reg.register, arrivalAt: reg.arrivalAt, preplanBlocked: reg.preplanBlocked });
      syncPending = 5;
      pendingReason = reg.mode === 'preplan' ? 'ev_preplan' : 'ev_preplan_end';
    }
    lastRegKey = regKey;

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
    const key = `${d.enabled}|${d.departureAt}|${d.targetSocPct}|${reg.chargeStartAt}`;
    if (key === lastKey) return { action: 'none' };
    const res = await eosConfigSync.syncEv();
    if (res?.ok) lastKey = key; // bei Fehler naechste Minute erneut
    return { action: 'ev', ok: res?.ok === true };
  }

  return { tick };
}
