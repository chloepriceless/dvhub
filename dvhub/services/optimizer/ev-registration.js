/**
 * Meldet DVhub das E-Auto bei EOS an — und mit welchem Ladestand?
 *
 * Bisher (evPlanOnlyWhenPlugged, Standard): nur angesteckt, mit dem echten
 * Ladestand. Ohne Auto an der Wallbox wuerde EOS Energie fuers Auto
 * einplanen, das gar nicht laden kann.
 *
 * Neu — Vorplanung: Steht im Wochenplan eine Ankunft bevor und steckt das
 * Auto noch nicht, darf DVhub es schon vorher anmelden, mit dem erwarteten
 * Ladestand bei Ankunft (ev-arrival.js) als Start-Ladestand und der Ankunft
 * als fruehestem Ladestart (EOS_EV_CHARGE_START_FIELD). Das ist nur korrekt,
 * wenn EOS den Ladestart kennt — sonst plante EOS Ladung, bevor das Auto da
 * ist. Ohne die Faehigkeit bleibt alles wie bisher; der Grund steht dann in
 * `preplanBlocked`.
 *
 * Kommt das Auto spaet (Ankunft vorbei, noch nicht angesteckt), bleibt die
 * Vorplanung PREPLAN_GRACE_MS lang stehen (Ladestart null = ab sofort); danach
 * gilt wieder „nur angesteckt“. Sobald es steckt, gewinnt der echte
 * Ladestand; nach der Abfahrt rollt alles aufs naechste Fenster.
 */
import { resolveEvDeparture } from './ev-departure.js';
import { resolveEvArrival } from './ev-arrival.js';
import { resolveEvSocPct, resolveEvPlugged } from './ev-soc.js';

export const PREPLAN_GRACE_MS = 30 * 60_000;
export const PREPLAN_NEEDS_CHARGE_START = 'Vorplanung braucht EOS mit Ladestart';
export const PREPLAN_NO_EXPECTED_SOC = 'kein erwarteter Ladestand bei Ankunft';

/**
 * @param {object} ctx
 * @param {object} cfg
 * @param {{ chargeStartSupported?: boolean, plugged?: boolean|null, nowMs?: number }} [opts]
 *   plugged: undefined = resolveEvPlugged(ctx) (die Minuten-Wache gibt den
 *   entprellten Wert mit).
 * @returns {{ wanted: boolean, register: boolean, reason: string|null,
 *   mode: 'preplan'|'plugged'|'always'|null, onlyWhenPlugged: boolean,
 *   plugged: boolean|null, socPct: number|null, socSource: string|null,
 *   chargeStartAt: string|null, arrivalAt: string|null, departureAt: string|null,
 *   expectedSocPct: number|null, expectedSource: string|null,
 *   preplanBlocked: string|null }}
 */
export function computeEvRegistration(ctx, cfg, { chargeStartSupported = false, plugged, nowMs = Date.now() } = {}) {
  const opt = cfg?.optimizer || {};
  const wanted = opt.eosOptimizeEv === true;
  const onlyWhenPlugged = opt.evPlanOnlyWhenPlugged !== false;
  const base = {
    wanted, register: false, reason: null, mode: null, onlyWhenPlugged, plugged: null,
    socPct: null, socSource: null, chargeStartAt: null, arrivalAt: null, departureAt: null,
    expectedSocPct: null, expectedSource: null, preplanBlocked: null,
  };
  if (!wanted) return { ...base, reason: 'eosOptimizeEv=false' };

  const isPlugged = plugged === undefined ? resolveEvPlugged(ctx) : plugged;
  const soc = resolveEvSocPct(ctx);
  const departure = resolveEvDeparture(cfg, nowMs);
  const arrival = resolveEvArrival(ctx, cfg, { plugged: isPlugged, nowMs, departure });
  const arrivalMs = Date.parse(departure.arrivalAt || '');
  const out = {
    ...base, plugged: isPlugged, socPct: soc?.pct ?? null, socSource: soc?.source ?? null,
    arrivalAt: departure.arrivalAt, departureAt: departure.departureAt,
    expectedSocPct: arrival.pct, expectedSource: arrival.source,
  };

  // Vorplanung: Ankunft steht bevor (oder ist hoechstens die Kulanz her) und
  // das Auto steckt noch nicht.
  const preplanWindow = departure.enabled && isPlugged !== true
    && Number.isFinite(arrivalMs) && nowMs < arrivalMs + PREPLAN_GRACE_MS;
  if (preplanWindow) {
    if (!chargeStartSupported) out.preplanBlocked = PREPLAN_NEEDS_CHARGE_START;
    else if (arrival.pct === null) out.preplanBlocked = PREPLAN_NO_EXPECTED_SOC;
    else {
      return {
        ...out, register: true, mode: 'preplan',
        socPct: arrival.pct, socSource: arrival.source,
        chargeStartAt: arrivalMs > nowMs ? departure.arrivalAt : null,
      };
    }
  }

  if (onlyWhenPlugged && isPlugged !== true) {
    return { ...out, reason: isPlugged === false ? 'nicht angesteckt' : 'Steckzustand unbekannt (Wallbox/evcc nicht erreichbar)' };
  }
  if (!soc) {
    return { ...out, reason: 'kein Ladestand des Autos (TeslaMate/evcc) — EOS 0.4 wuerde sonst gar nicht rechnen' };
  }
  return { ...out, register: true, mode: isPlugged === true ? 'plugged' : 'always' };
}

/**
 * Ladestand des Autos fuer den EOS-Lauf (eos-forecast-bridge socForRun /
 * pushSoc). In der Vorplanung der erwartete Ladestand bei Ankunft — frisch
 * gerechnet, sonst der beim Abgleich festgehaltene —, angesteckt immer der
 * echte. Sonst wie bisher resolveEvSocPct.
 * @returns {{ pct: number, source: string } | null}
 */
export function evSocForEos(ctx, nowMs = Date.now()) {
  const reg = ctx?.state?.optimizer?.eosEv;
  if (reg?.register === true && reg.mode === 'preplan' && resolveEvPlugged(ctx) !== true) {
    const arrival = resolveEvArrival(ctx, ctx?.getCfg?.() || {}, { plugged: false, nowMs });
    if (arrival.pct !== null) return { pct: arrival.pct, source: `arrival-${arrival.source}` };
    if (Number.isFinite(Number(reg.socPct))) return { pct: Number(reg.socPct), source: `arrival-${reg.socSource || 'estimate'}` };
  }
  return resolveEvSocPct(ctx);
}
