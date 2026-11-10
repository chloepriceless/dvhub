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
import { directWallboxConfigured } from '../wallbox/types.js';
import { mergeDeviceCaps, meterImport } from '../import-limit/core.js';
import {
  P14A_MIN_W, STEUVE_KINDS, DEFAULT_PRIORITY, computePmin14a, budgetW, allocateBudget, demandW,
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
// Sinkender Bedarf wird erst nach dieser Zeit weitergegeben: eine Wärmepumpe,
// die kurz abtaut oder taktet, behält ihren Anteil (kein Flattern).
const DEMAND_HOLD_MS = 60_000;
// „Läuft an der Grenze“: Messwert höchstens so weit unter dem letzten Anteil.
const AT_CAP_TOL_MIN_W = 200;
const AT_CAP_TOL_SHARE = 0.1;
// Akku-Hilfe nur mit gültigem Zählerwert, höchstens so alt (Rückkopplung).
const ASSIST_METER_MAX_AGE_MS = 30_000;
// Geplanter Netzbezug des Speichers (schedule-eval) gilt so lange als aktuell.
const BATTERY_WANT_MAX_AGE_MS = 120_000;

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
    // Zuerst nach aktuellem Bedarf (ab 1.0.10 Standard; ältere Konfigurationen
    // ohne den Schlüssel bekommen ihn damit automatisch).
    demandFirst: p.demandFirst !== false,
    priority: PRIORITY_PRESETS[p.priorityPreset] || DEFAULT_PRIORITY,
    priorityPreset: PRIORITY_PRESETS[p.priorityPreset] ? p.priorityPreset : 'heat_first',
    usePvSurplus: p.usePvSurplus !== false,
    // Hausspeicher deckt zuerst (Akku-Hilfe über ctx.batteryAssist), gekürzt wird nur der Rest.
    batteryAssist: p.batteryAssist !== false,
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
  // Gehaltener Bedarf je Gerät: id → { w, at }
  const heldNeed = new Map();
  // Akku-Hilfe: zuletzt gewünscht (W), zuletzt vom Anbieter bestätigt (W,
  // null = unbekannt/gescheitert), laufende Anfrage und die danach fällige.
  let assistRequestedW = 0;
  let assistAckedW = 0;
  let assistReply = null;
  let assistInflight = false;
  let assistQueued = null;

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
    reserved: {},
    batteryAssist: { neededW: 0, requestedW: 0, acceptedW: null, reason: null },
    batteryGridW: null,
    wallboxCapW: null,
    relay: { enabled: false, topic: '', level: null, at: null },
  });

  const cfgNow = () => resolveParagraph14aConfig(getCfg());

  // --- Geräte ------------------------------------------------------------------

  // Messwert der Wallbox (null = unbekannt) und ob ein Auto steckt (false = sicher keins).
  function wallboxState(cfg, bc) {
    const fin = (v) => (v != null && Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : null);
    if (bc.charger === 'evcc') {
      const lp = ctx.evccIntegration?.getStatus?.()?.loadpoints?.[bc.loadpoint - 1];
      return { measuredW: fin(lp?.chargePowerW), available: lp?.connected !== false };
    }
    const st = ctx.chargerStatus?.fresh?.();
    return { measuredW: fin(st?.powerW), available: st?.connected !== false };
  }

  /** SKI der EEBUS-Hauptwallbox, wenn sie oben schon als „wallbox“ steht. */
  function mainEebusWallboxSki(cfg, bc, list) {
    return bc.charger === 'eebus' && list.some((d) => d.id === 'wallbox')
      ? String(cfg.wallbox?.eebus?.ski || '').trim().toLowerCase() : '';
  }

  /**
   * Alle SteuVE: was DVhub kennt (steuerbar) plus Einträge von Hand.
   * currentW: Leistung fürs Budget (unbekannt = 0); measuredW: Messwert für den
   * Bedarf (null = unbekannt → volle Leistung); startW: Anlaufstufe; available:
   * false, wenn das Gerät sicher nichts braucht (kein Auto an der Wallbox).
   * @returns {Array<{id,name,kind,powerW,control,controllable,currentW,measuredW,startW,available,source}>}
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
      const direct = bc.charger !== 'evcc' && directWallboxConfigured(cfg);
      if (bc.enabled || direct) {
        const wb = wallboxState(cfg, bc);
        list.push({ id: 'wallbox', name: 'Wallbox', kind: 'ladepunkt', powerW: bc.maxChargeW, control: 'ems',
          controllable: true, currentW: wb.measuredW ?? 0, measuredW: wb.measuredW, available: wb.available,
          // Anlaufstufe: Mindeststrom (6 A) auf allen Phasen
          startW: Math.round(bc.minCurrentA * bc.phases * bc.voltageV), source: 'auto' });
      }
      const batW = Number(cfg.optimizer?.maxChargeW);
      if (batW > 0) {
        const bp = state.victron?.batteryPowerW;
        const measuredW = bp != null && Number.isFinite(Number(bp)) ? Math.max(0, Number(bp)) : null;
        // Bedarf des Speichers = was der Plan gerade aus dem Netz laden will, als
        // Sollwert am Anschlusspunkt — dieselbe Größe, die sein Anteil in
        // schedule-eval deckelt (nicht die Akkuleistung: sonst bliebe ein
        // gedeckelter Akku bei 0 W stehen und sein Bedarf stiege nie).
        // Ohne aktuellen Planwert: unbekannt → volle Leistung.
        const want = state.ctrl?.p14aBatteryWantW;
        const wantFresh = want && Number.isFinite(Number(want.w)) && now() - Number(want.at) <= BATTERY_WANT_MAX_AGE_MS;
        list.push({ id: 'speicher', name: 'Stromspeicher', kind: 'speicher', powerW: batW, control: 'ems',
          controllable: true, currentW: measuredW ?? 0, measuredW,
          fixedNeedW: wantFresh ? Math.max(0, Number(want.w)) : null, fixedNeedKnown: true, source: 'auto' });
      }
      // Die EEBUS-Hauptwallbox steht oben schon als „wallbox“ (ihr Anteil geht
      // über die Wallbox-Steuerung an dieselbe Box): nicht doppelt zählen —
      // sonst zählte sie zweimal für Pmin,14a und bekäme zweimal Budget.
      const mainEebusSki = mainEebusWallboxSki(cfg, bc, list);
      for (const d of ctx.eebus?.consumptionDevices?.() || []) {
        if (mainEebusSki && d.ski === mainEebusSki) {
          // Nennleistung laut Gerät zählt (Pmin, Höchstleistung), auch wenn EOS weniger plant.
          const wb = list.find((x) => x.id === 'wallbox');
          wb.powerW = Math.max(Number(wb.powerW) || 0, Number(d.maxW) || 0);
          wb.lpcId = d.id;
          continue;
        }
        const measuredW = d.powerW != null && Number.isFinite(Number(d.powerW)) ? Math.max(0, Number(d.powerW)) : null;
        list.push({ id: d.id, name: d.name || 'EEBUS-Gerät', kind: d.kind, powerW: d.maxW, control: 'ems',
          controllable: true, currentW: measuredW ?? 0, measuredW,
          startW: Number.isFinite(Number(d.startW)) && d.startW != null ? Number(d.startW) : null,
          available: d.available !== false, source: 'eebus' });
      }
      // Gesteuerte EEBUS-Geräte, die DVhub gerade nicht erreicht: sie ziehen bis
      // zu ihrem eigenen Failsafe-Wert (ohne Angabe: Nennleistung). Sie zählen
      // weiter für Pmin,14a, bekommen keinen Anteil, und ihr Wert ist im Budget
      // belegt — sonst könnten die übrigen Geräte die ganze Grenze ausschöpfen.
      for (const d of ctx.eebus?.lostConsumptionDevices?.() || []) {
        if (mainEebusSki && d.ski === mainEebusSki) continue;
        if (list.some((x) => x.id === d.id)) continue;
        list.push({ id: d.id, name: d.name || 'EEBUS-Gerät', kind: d.kind, powerW: d.maxW, control: 'ems',
          controllable: false, unreachable: true, reserveW: Math.min(d.maxW, d.failsafeW ?? d.maxW),
          currentW: 0, measuredW: null, source: 'eebus' });
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

  function stable(next, budget) {
    // Kleine Änderungen nicht weitergeben (PV-Überschuss schwankt ständig);
    // ein Wechsel auf/von 0 oder auf null geht immer durch.
    const out = {};
    const rounded = {};
    for (const [id, w] of Object.entries(next)) {
      const prev = lastShares[id];
      rounded[id] = Math.floor(w / SHARE_STEP_W) * SHARE_STEP_W;
      const r = rounded[id];
      out[id] = prev != null && r !== 0 && prev !== 0 && Math.abs(r - prev) < SHARE_HYSTERESIS_W ? prev : r;
    }
    // Die Summe darf nie über dem Budget liegen (Vorgabe des Netzbetreibers):
    // sonst gilt für alle, die über ihrem neuen Anteil gehalten würden, der neue.
    const sum = Object.values(out).reduce((a, w) => a + w, 0);
    if (Number.isFinite(budget) && sum > budget) {
      for (const id of Object.keys(out)) if (out[id] > rounded[id]) out[id] = rounded[id];
    }
    return out;
  }

  // Bedarf mit Halten: steigt er, gilt er sofort; sinkt er, erst nach DEMAND_HOLD_MS.
  function heldDemand(id, w) {
    const t = now();
    const h = heldNeed.get(id);
    if (!h || w >= h.w || t - h.at >= DEMAND_HOLD_MS) {
      heldNeed.set(id, { w, at: t });
      return w;
    }
    return h.w;
  }

  function consumersFor(controllable, c) {
    return controllable.map((d) => {
      const base = { id: d.id, kind: d.kind, maxW: d.powerW };
      if (!c.demandFirst) return base;
      const raw = d.fixedNeedKnown
        ? Math.min(d.powerW, d.fixedNeedW ?? d.powerW)
        : demandW({ kind: d.kind, maxW: d.powerW, currentW: d.measuredW, startW: d.startW, available: d.available });
      // Auf den 100-W-Schritt aufrunden: stable() rundet die Anteile ab — ein
      // Bedarf von genau 4140 W (6 A × 3) würde sonst 4100 W und reichte nicht
      // zum Anlaufen (Codex e2877dc9).
      const need = heldDemand(d.id, Math.min(d.powerW, Math.ceil(raw / SHARE_STEP_W) * SHARE_STEP_W));
      const prev = lastShares[d.id];
      const atCap = d.measuredW != null && prev != null && prev > 0
        && d.measuredW >= prev - Math.max(AT_CAP_TOL_MIN_W, AT_CAP_TOL_SHARE * prev);
      return { ...base, needW: need, atCap };
    });
  }

  // --- Akku-Hilfe ---------------------------------------------------------------
  //
  // Rechtsgrundlage: BK6-22-300 Anlage 1 — begrenzt ist der netzwirksame
  // Leistungsbezug der SteuVE (Ziffer 2.3); bei Steuerung mittels EMS gilt die
  // Vorgabe für ihren gemeinsamen Bezug, gemessen am Netzanschlusspunkt, und der
  // Betreiber teilt sie nach eigener Maßgabe auf (Ziffer 4.5.2). Deckt der
  // Hausspeicher die Last der SteuVE, sinkt deren netzwirksamer Bezug — DVhub
  // lässt den Speicher deshalb zuerst entladen und kürzt nur den Rest.
  // Gekürzt wird weiter nach dem GEMESSENEN Netzbezug (budgetW rechnet laufende
  // Entladung und PV als Überschuss mit), nicht nach der Zusage des Speichers.
  //
  // Benötigte Akku-Hilfe = Bedarf der SteuVE − (Grenze − belegt) + Haushalt
  // ohne Speicher (Bezug − SteuVE + laufende Entladung; negativ = PV-Überschuss).
  // Die laufende Entladung wird herausgerechnet: sonst sänke die Anforderung,
  // sobald der Speicher liefert, und die Hilfe schwänge.
  //
  // Schnittstelle (die Akku-Steuerung baut der Netzanschluss-Akku-Zweig bzw.
  // bei Victron der positive Netz-Sollwert):
  //   ctx.batteryAssist.request({ source: 'p14a', coverW, untilMs })
  //     → { ok: boolean, acceptedW?: number, reason?: string } (auch als Promise)
  //   coverW = 0 gibt die Anforderung frei.
  function assistNeededW({ consumers, limitW, reservedW, gridImportW, steuveW }) {
    const bp = Number(state.victron?.batteryPowerW);
    const dischargeW = Number.isFinite(bp) ? Math.max(0, -bp) : 0;
    const houseW = gridImportW - steuveW + dischargeW;
    const needSum = consumers.filter((x) => x.kind !== 'speicher')
      .reduce((a, x) => a + (x.needW ?? x.maxW), 0);
    const w = needSum - (limitW - reservedW) + houseW;
    return w > 0 ? Math.ceil(w / SHARE_STEP_W) * SHARE_STEP_W : 0;
  }

  // Anfragen nacheinander: eine ältere Anforderung darf eine spätere Freigabe
  // nicht überholen (asynchrone Anbieter); während einer laufenden Anfrage zählt
  // nur der jeweils neueste Wunsch. Eine Freigabe gilt erst als erledigt, wenn
  // der Anbieter sie bestätigt — sonst wird sie wiederholt (Codex 0fc9c779).
  function requestAssist(coverW, untilMs) {
    if (typeof ctx.batteryAssist?.request !== 'function') return;
    assistRequestedW = coverW;
    if (coverW === 0 && assistAckedW === 0 && !assistInflight && assistQueued == null) return;
    if (assistInflight) { assistQueued = { coverW, untilMs }; return; }
    sendAssist(coverW, untilMs);
  }

  function sendAssist(coverW, untilMs) {
    const done = (r) => {
      assistReply = r || null;
      assistAckedW = r?.ok === true ? coverW : null;
      assistInflight = false;
      const next = assistQueued;
      assistQueued = null;
      if (next) sendAssist(next.coverW, next.untilMs);
    };
    let res;
    try {
      res = ctx.batteryAssist.request({ source: 'p14a', coverW, untilMs });
    } catch (e) {
      done({ ok: false, reason: e?.message || String(e) });
      return;
    }
    if (res && typeof res.then === 'function') {
      assistInflight = true;
      res.then(done, (e) => done({ ok: false, reason: e?.message || String(e) }));
    } else {
      done(res);
    }
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
    let consumers = [];
    const reserved = {};
    const assist = { neededW: 0, requestedW: 0, acceptedW: null, reason: null };
    if (active) {
      const controllable = list.filter((d) => d.controllable);
      const steuveW = controllable.reduce((s, d) => s + d.currentW, 0);
      budget = budgetW({ limitW, gridImportW: gridImportPositiveW(state, getCfg()), steuveW, usePvSurplus: c.usePvSurplus });
      let free = budget;
      for (const d of list.filter((x) => x.unreachable)) {
        reserved[d.id] = Math.min(free, d.reserveW);
        free -= reserved[d.id];
      }
      consumers = consumersFor(controllable, c);
      // Akku-Hilfe: nur mit Messwert am Anschlusspunkt (Rückkopplung) und mit
      // PV-Überschuss-Rechnung, nie im Not-Halt (dort nur die Pflicht-Reduzierung).
      // Rückkopplung nur über einen gültigen, frischen Zählerwert (beim Start
      // steht grid_total_w schon auf einer Zahl, meter.ok aber auf false).
      const meter = meterImport(state, getCfg(), { now: now(), maxAgeMs: ASSIST_METER_MAX_AGE_MS });
      const gridImportW = meter.fresh ? meter.importW : null;
      const provider = typeof ctx.batteryAssist?.request === 'function';
      const reservedW = Object.values(reserved).reduce((a, w) => a + w, 0);
      assist.neededW = Number.isFinite(gridImportW)
        ? assistNeededW({ consumers, limitW, reservedW, gridImportW, steuveW }) : 0;
      if (!c.batteryAssist) assist.reason = 'off';
      else if (!provider) assist.reason = 'no_provider';
      else if (state.ctrl?.discretionaryWritesPaused === true) assist.reason = 'not_halt';
      else if (!c.usePvSurplus || !Number.isFinite(gridImportW)) assist.reason = 'no_measurement';
      else assist.reason = null;
      const assisting = assist.reason == null && assist.neededW > 0;
      requestAssist(assist.reason == null ? assist.neededW : 0, state.ctrl?.eebusConsumptionLimitUntil ?? null);
      // Solange der Speicher hilft, lädt er nicht aus dem Netz (Anteil 0).
      const allocConsumers = assisting ? consumers.filter((x) => x.kind !== 'speicher') : consumers;
      shares = stable(allocateBudget(free, allocConsumers,
        { mode: c.allocation, priority: c.priority, demand: c.demandFirst }), free);
      if (assisting) for (const x of consumers) if (x.kind === 'speicher') shares[x.id] = 0;
    } else {
      heldNeed.clear();
      requestAssist(0, null);
      assist.reason = null;
    }
    assist.requestedW = assistRequestedW;
    assist.acceptedW = assistRequestedW > 0 && assistAckedW === assistRequestedW && assistReply?.ok === true
      && Number.isFinite(Number(assistReply.acceptedW))
      ? Number(assistReply.acceptedW) : null;
    lastShares = shares;
    const needById = Object.fromEntries(consumers.filter((x) => x.needW != null).map((x) => [x.id, x.needW]));

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
      devices: list.map(({ id, name, kind, powerW, control, controllable, measuredW, unreachable, source: src }) => ({
        id, name, kind, powerW, control, controllable, source: src, unreachable: unreachable === true,
        currentW: controllable ? measuredW ?? null : null,
        needW: needById[id] ?? null,
      })),
      ignored: pmin.ignored,
      budgetW: budget,
      shares,
      reserved,
      batteryAssist: assist,
      batteryGridW: active ? (shares.speicher ?? 0) : null,
      wallboxCapW: active && shares.wallbox != null ? shares.wallbox : null,
      relay: { enabled: c.relay.enabled, topic: c.relay.topic, level: relay.level, at: relay.at, activeWhen: c.relay.activeWhen },
    });
    state.ctrl.p14aBatteryGridW = ui.batteryGridW;
    state.ctrl.p14aWallboxCapW = ui.wallboxCapW;

    const eebusShares = {};
    for (const d of list) if (d.source === 'eebus' && !d.unreachable) eebusShares[d.id] = active ? (shares[d.id] ?? 0) : null;
    // EEBUS-Hauptwallbox: ihr Anteil geht über die Wallbox-Steuerung (Ampere)
    // und zusätzlich direkt als LPC-Grenze in Watt ans Gerät — die Umrechnung
    // über Phasen und Spannung kann sonst mehr erlauben (Codex e579fc30).
    const wbEntry = list.find((d) => d.id === 'wallbox' && d.lpcId);
    if (wbEntry) eebusShares[wbEntry.lpcId] = active ? (shares.wallbox ?? 0) : null;
    // Netzanschluss (services/grid-connection): dessen Grenzen je EEBUS-Gerät
    // kommen dazu — je Gerät gilt die kleinste (auch ohne §14a-Vorgabe).
    const gcCaps = ctx.gridConnection?.eebusCaps?.() || null;
    const merged = mergeDeviceCaps(eebusShares, gcCaps);
    // Eine Netzanschluss-Grenze hat keine Ablaufzeit — DVhub nimmt sie selbst
    // zurück. Bestimmt sie ein Gerät, geht die Grenze ohne §14a-Dauer raus.
    // Je Gerät: nur wo sie bindet, sonst gilt die §14a-Dauer (Codex fb52348a, P2).
    const untilById = {};
    for (const [id, w] of Object.entries(gcCaps || {})) {
      if (w != null && merged[id] === w) untilById[id] = null;
    }
    ctx.eebus?.applyConsumptionShares?.(merged, state.ctrl?.eebusConsumptionLimitUntil ?? null, untilById);
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
      allocation: cfgNow().allocation,
      demandFirst: cfgNow().demandFirst,
      budgetW: ui.budgetW,
      shares: { ...ui.shares },
      reserved: { ...ui.reserved },
      batteryAssist: { ...ui.batteryAssist },
      // Störungen der Gerätesteuerung (nicht erreichbar, nicht umgesetzt …)
      issues: ctx.eebus?.controlIssues?.() || [],
      devices: ui.devices.map((d) => ({ ...d })),
      relay: { ...ui.relay },
    };
  }

  return { start, stop, update, pminW, summary, _relay: relay };
}
