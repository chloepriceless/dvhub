// services/paragraph14a/index.js — netzorientierte Steuerung nach § 14a EnWG.
//
// Führt die Vorgaben des Netzbetreibers zusammen und setzt sie um (Steuerung
// mittels EMS, BK6-22-300 Anlage 1 Ziffer 4.4.b):
//
//   Quellen   EEBUS-Steuerbox (LPC, Wert vom Netzbetreiber, services/eebus)
//             Relaiskontakt einer FNN-Steuerbox (nur „gedimmt ja/nein“) — dann
//             gilt die Mindestleistung Pmin,14a nach Ziffer 4.5.2
//   Budget    Grenze + PV-Überschuss (begrenzt ist nur der netzwirksame Bezug)
//   Geräte    Wallbox (Obergrenze über die EOS-evcc-Brücke), Stromspeicher
//             (Netzladen über den Grid-Setpoint, schedule-eval.js) und
//             EEBUS-Geräte (LPC-Grenze über dvhub-eebus)
//
// Die Geräteliste (für Pmin,14a) kommt aus dem, was DVhub kennt, plus Einträgen
// von Hand (paragraph14a.devices) für Anlagen, die DVhub nicht selbst steuert.

import { parseMqttPayload } from '../../transport-mqtt.js';
import { gridImportPositiveW } from '../eebus/index.js';
import { resolveEvccBridgeConfig } from '../optimizer/eos-evcc-bridge.js';
import {
  P14A_MIN_W, STEUVE_KINDS, DEFAULT_PRIORITY, computePmin14a, budgetW, allocateBudget,
} from './rules.js';

export const PRIORITY_PRESETS = Object.freeze({
  heat_first: ['waermepumpe', 'klima', 'ladepunkt', 'speicher'],
  ev_first: ['ladepunkt', 'waermepumpe', 'klima', 'speicher'],
  storage_first: ['speicher', 'waermepumpe', 'klima', 'ladepunkt'],
});

const TICK_MS = 5_000;
// Kleine Schwankungen des PV-Überschusses nicht an die Geräte weitergeben.
const SHARE_STEP_W = 100;
const SHARE_HYSTERESIS_W = 300;

/** Konfiguration mit Vorgaben; ungültige Geräte fallen raus. */
export function resolveParagraph14aConfig(cfg) {
  const p = cfg?.paragraph14a || {};
  const relay = p.relay || {};
  const devices = (Array.isArray(p.devices) ? p.devices : [])
    .filter((d) => d && STEUVE_KINDS.includes(d.kind) && Number(d.powerW) > 0)
    .map((d, i) => ({
      id: String(d.id || `manual-${i + 1}`),
      name: String(d.name || '').slice(0, 60),
      kind: d.kind,
      powerW: Math.round(Number(d.powerW)),
      control: d.control === 'direct' ? 'direct' : 'ems',
    }));
  return {
    autoDevices: p.autoDevices !== false,
    devices,
    allocation: p.allocation === 'proportional' ? 'proportional' : 'priority',
    priority: PRIORITY_PRESETS[p.priorityPreset] || DEFAULT_PRIORITY,
    priorityPreset: PRIORITY_PRESETS[p.priorityPreset] ? p.priorityPreset : 'heat_first',
    usePvSurplus: p.usePvSurplus !== false,
    relay: {
      enabled: relay.enabled === true && typeof relay.topic === 'string' && relay.topic.trim() !== '',
      topic: typeof relay.topic === 'string' ? relay.topic.trim() : '',
      activeWhen: relay.activeWhen === 'low' ? 'low' : 'high',
    },
  };
}

/**
 * Schaltzustand aus einer MQTT-Nachricht: 1/true/on/closed = high,
 * 0/false/off/open = low, sonst null (unbekannt).
 */
export function parseRelayPayload(payload) {
  const text = String(payload ?? '').trim().toLowerCase();
  if (['on', 'true', 'closed', 'high', 'yes'].includes(text)) return 'high';
  if (['off', 'false', 'open', 'low', 'no'].includes(text)) return 'low';
  let v = parseMqttPayload(payload);
  if (v === undefined) {
    try {
      const o = JSON.parse(text);
      if (typeof o?.value === 'boolean') v = o.value ? 1 : 0;
      if (typeof o === 'boolean') v = o ? 1 : 0;
    } catch { /* kein JSON */ }
  }
  if (v === undefined || v === null) return null;
  return Number(v) !== 0 ? 'high' : 'low';
}

export function createParagraph14aService(ctx, deps = {}) {
  const { state, getCfg, pushLog = () => {} } = ctx;
  const now = deps.now || (() => Date.now());
  const setIntervalFn = deps.setInterval || setInterval;
  const clearIntervalFn = deps.clearInterval || clearInterval;

  const relay = { level: null, at: null, subscribedTopic: null };
  let timer = null;
  let lastShares = {};
  let lastActiveKey = null;

  const ui = (state.p14a = {
    active: false,
    limitW: null,
    source: null,
    belowPmin: false,
    sources: { eebus: null, relay: null },
    pminW: 0,
    n: 0,
    gzf: 1,
    formula: 'none',
    devices: [],
    ignored: [],
    budgetW: null,
    shares: {},
    batteryGridW: null,
    wallboxCapW: null,
    relay: { enabled: false, topic: '', level: null, at: null },
  });

  const cfgNow = () => resolveParagraph14aConfig(getCfg());

  // --- Geräte ------------------------------------------------------------------

  function wallboxPowerW(cfg) {
    const bc = resolveEvccBridgeConfig(cfg);
    if (bc.charger === 'evcc') {
      const lp = ctx.evccIntegration?.getStatus?.()?.loadpoints?.[bc.loadpoint - 1];
      return Number(lp?.chargePowerW) || 0;
    }
    return Number(ctx.chargerStatus?.fresh?.()?.powerW) || 0;
  }

  /**
   * Alle SteuVE: was DVhub kennt (steuerbar) plus Einträge von Hand.
   * @returns {Array<{id,name,kind,powerW,control,controllable,currentW,source}>}
   */
  function devices() {
    const c = cfgNow();
    const cfg = getCfg() || {};
    const list = [];
    if (c.autoDevices) {
      const bc = resolveEvccBridgeConfig(cfg);
      // Eine direkt angebundene Wallbox (OpenEVSE, go-e) ist eine steuerbare
      // Verbrauchseinrichtung, sobald sie eingerichtet ist — auch wenn EOS sie
      // nicht plant. Über evcc nur, wenn DVhub evcc auch steuert.
      const direct = (bc.charger === 'openevse' && cfg.wallbox?.openevse?.url) || (bc.charger === 'goe' && cfg.wallbox?.goe?.url);
      if (bc.enabled || direct) {
        list.push({ id: 'wallbox', name: 'Wallbox', kind: 'ladepunkt', powerW: bc.maxChargeW, control: 'ems',
          controllable: true, currentW: wallboxPowerW(cfg), source: 'auto' });
      }
      const batW = Number(cfg.optimizer?.maxChargeW);
      if (batW > 0) {
        list.push({ id: 'speicher', name: 'Stromspeicher', kind: 'speicher', powerW: batW, control: 'ems',
          controllable: true, currentW: Math.max(0, Number(state.victron?.batteryPowerW) || 0), source: 'auto' });
      }
      for (const d of ctx.eebus?.consumptionDevices?.() || []) {
        list.push({ id: d.id, name: d.name || 'EEBUS-Gerät', kind: d.kind, powerW: d.maxW, control: 'ems',
          controllable: true, currentW: Math.max(0, Number(d.powerW) || 0), source: 'eebus' });
      }
    }
    for (const d of c.devices) {
      list.push({ ...d, controllable: false, currentW: 0, source: 'manual' });
    }
    return list;
  }

  // --- Relais ------------------------------------------------------------------

  function syncRelaySubscription(c) {
    const hub = ctx.mqttHub;
    const topic = c.relay.enabled ? c.relay.topic : null;
    if (topic === relay.subscribedTopic) return;
    relay.subscribedTopic = topic;
    relay.level = null;
    relay.at = null;
    if (!topic || !hub?.subscribe) return;
    hub.subscribe(topic, (t, payload) => {
      // Nachrichten eines inzwischen abbestellten Themas nicht mehr werten.
      if (relay.subscribedTopic !== topic) return;
      const level = parseRelayPayload(payload);
      if (level == null) return;
      const changed = level !== relay.level;
      relay.level = level;
      relay.at = now();
      if (changed) {
        pushLog('paragraph14a_relay', { topic: t, level });
        update();
      }
    });
  }

  function relayActive(c) {
    if (!c.relay.enabled || relay.level == null) return false;
    return relay.level === c.relay.activeWhen;
  }

  // --- Umsetzung ---------------------------------------------------------------

  function stable(next) {
    // Kleine Änderungen nicht weitergeben (PV-Überschuss schwankt ständig);
    // ein Wechsel auf/von 0 oder auf null geht immer durch.
    const out = {};
    for (const [id, w] of Object.entries(next)) {
      const prev = lastShares[id];
      const rounded = Math.floor(w / SHARE_STEP_W) * SHARE_STEP_W;
      out[id] = prev != null && rounded !== 0 && prev !== 0 && Math.abs(rounded - prev) < SHARE_HYSTERESIS_W ? prev : rounded;
    }
    return out;
  }

  function update() {
    const c = cfgNow();
    syncRelaySubscription(c);
    const list = devices();
    const pmin = computePmin14a(list);
    const eebusW = Number.isFinite(state.ctrl?.eebusConsumptionLimitW) ? state.ctrl.eebusConsumptionLimitW : null;
    // Relais meldet nur „gedimmt“: es gilt die Mindestleistung, mindestens 4,2 kW.
    const relayW = relayActive(c) ? Math.max(P14A_MIN_W, pmin.pminW) : null;
    const candidates = [['eebus', eebusW], ['relay', relayW]].filter(([, w]) => w != null);
    const [source, limitW] = candidates.length
      ? candidates.reduce((a, b) => (b[1] < a[1] ? b : a))
      : [null, null];
    const active = limitW != null;

    let budget = null;
    let shares = {};
    if (active) {
      const controllable = list.filter((d) => d.controllable);
      const steuveW = controllable.reduce((s, d) => s + d.currentW, 0);
      budget = budgetW({ limitW, gridImportW: gridImportPositiveW(state, getCfg()), steuveW, usePvSurplus: c.usePvSurplus });
      shares = stable(allocateBudget(budget, controllable.map((d) => ({ id: d.id, kind: d.kind, maxW: d.powerW })),
        { mode: c.allocation, priority: c.priority }));
    }
    lastShares = shares;

    // Der Netzbetreiber muss mindestens Pmin,14a gewähren (Ziffer 4.5). Eine
    // kleinere Vorgabe setzt DVhub trotzdem um (Ziffer 4.6), meldet sie aber.
    const belowPmin = active && pmin.pminW > 0 && limitW < pmin.pminW;
    const key = active ? `${source}:${limitW}` : 'off';
    if (key !== lastActiveKey) {
      lastActiveKey = key;
      pushLog(active ? 'paragraph14a_limited' : 'paragraph14a_released', active
        ? { source, limitW, pminW: pmin.pminW, budgetW: budget, shares }
        : {});
      if (belowPmin) pushLog('paragraph14a_below_minimum', { source, limitW, pminW: pmin.pminW }, 'warn');
    }

    Object.assign(ui, {
      active,
      limitW,
      source,
      belowPmin,
      sources: { eebus: eebusW, relay: relayW },
      pminW: pmin.pminW,
      n: pmin.n,
      gzf: pmin.gzf,
      formula: pmin.formula,
      devices: list.map(({ id, name, kind, powerW, control, controllable, source: src }) => ({ id, name, kind, powerW, control, controllable, source: src })),
      ignored: pmin.ignored,
      budgetW: budget,
      shares,
      batteryGridW: active ? (shares.speicher ?? 0) : null,
      wallboxCapW: active && shares.wallbox != null ? shares.wallbox : null,
      relay: { enabled: c.relay.enabled, topic: c.relay.topic, level: relay.level, at: relay.at, activeWhen: c.relay.activeWhen },
    });
    state.ctrl.p14aBatteryGridW = ui.batteryGridW;
    state.ctrl.p14aWallboxCapW = ui.wallboxCapW;

    const eebusShares = {};
    for (const d of list) if (d.source === 'eebus') eebusShares[d.id] = active ? (shares[d.id] ?? 0) : null;
    ctx.eebus?.applyConsumptionShares?.(eebusShares, state.ctrl?.eebusConsumptionLimitUntil ?? null);
  }

  function start() {
    if (timer) return;
    update();
    timer = setIntervalFn(update, TICK_MS);
  }

  function stop() {
    if (timer) clearIntervalFn(timer);
    timer = null;
  }

  /** Mindestleistung der aktuellen Geräteliste (für den Failsafe-Vorgabewert). */
  function pminW() {
    return computePmin14a(devices()).pminW;
  }

  /** Kurzfassung für Leitstand und Installateurportal. */
  function summary() {
    return {
      active: ui.active,
      limitW: ui.limitW,
      source: ui.source,
      belowPmin: ui.belowPmin,
      pminW: ui.pminW,
      n: ui.n,
      gzf: ui.gzf,
      formula: ui.formula,
      budgetW: ui.budgetW,
      shares: { ...ui.shares },
      devices: ui.devices.map((d) => ({ ...d })),
      relay: { ...ui.relay },
    };
  }

  return { start, stop, update, pminW, summary, _relay: relay };
}
