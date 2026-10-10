// services/wallbox/main-wallbox.js — die eine Hauptwallbox.
//
// Unter Integrationen → Wallbox wählt man, WELCHE Wallbox DVhub hat: evcc
// (mit Ladepunkt), eine OpenEVSE, einen go-e Charger oder einen Fronius
// Wattpilot. Diese Wahl gilt überall — Anzeige, Abfrage und Steuerung:
// Leitstand und Familien-Dashboard, Lademodus, MQTT/Home Assistant, Ladestand
// und Steckzustand für EOS, Datenspende, §14a und der Auto-Vorrang des
// Heizstabs. Vorher fragten einige Stellen evcc, obwohl eine Box direkt
// angebunden war (2026-10-10).
//
// Ist eine Box direkt gewählt, wird evcc nicht mehr gefragt — auch nicht
// ersatzweise, wenn die Box schweigt. Dann ist der Zustand „unbekannt“.

import { resolveEvccBridgeConfig } from '../optimizer/eos-evcc-bridge.js';

export const WALLBOX_TYPES = Object.freeze(['evcc', 'openevse', 'goe', 'wattpilot']);
export const WALLBOX_LABELS = Object.freeze({
  evcc: 'evcc',
  openevse: 'OpenEVSE',
  goe: 'go-e Charger',
  wattpilot: 'Fronius Wattpilot'
});

// Lademodi. evcc kennt vier; eine direkt angebundene Box drei — „PV“ heißt
// dort: DVhub gibt die Vorgabe zurück, die Box (bzw. der EOS-Plan) entscheidet.
export const EVCC_MODES = Object.freeze([
  { mode: 'off', label: 'Aus' },
  { mode: 'pv', label: 'PV' },
  { mode: 'minpv', label: 'Min+PV' },
  { mode: 'now', label: 'Schnell' }
]);
export const DIRECT_MODES = Object.freeze([
  { mode: 'off', label: 'Aus' },
  { mode: 'pv', label: 'Automatisch' },
  { mode: 'now', label: 'Schnell' }
]);

export function wallboxType(cfg) {
  const t = cfg?.wallbox?.type;
  return WALLBOX_TYPES.includes(t) ? t : 'evcc';
}

/** Lademodus einer direkten Box aus ihrem Rohzustand (go-e/Wattpilot: frc). */
export function directModeFromRaw(raw) {
  const frc = Number(raw?.frc);
  if (frc === 1) return 'off';
  if (frc === 2) return 'now';
  if (frc === 0) return 'pv';
  return null;
}

/**
 * @param {object} deps
 * @param {()=>object} deps.getCfg
 * @param {object} [deps.evccIntegration]   getStatus()/getLoadpoints()/setMode()
 * @param {object} [deps.chargerStatus]     fresh()/raw() (charger-status.js)
 * @param {(type:string)=>object|null} deps.getAdapter  direkte Box (adapters.js)
 */
export function createMainWallbox({ getCfg, evccIntegration, chargerStatus, getAdapter }) {
  const type = () => wallboxType(getCfg());
  const isDirect = () => type() !== 'evcc';

  function evccLoadpoints() {
    try { return evccIntegration?.getLoadpoints?.() || []; } catch { return []; }
  }

  function selectedLoadpointId() {
    const cfg = getCfg() || {};
    return Number(cfg.optimizer?.evEvccLoadpoint) || Number(cfg.evcc?.dashboardLoadpoint) || null;
  }

  function evccLoadpoint() {
    const lps = evccLoadpoints();
    const id = selectedLoadpointId();
    return lps.find((l) => Number(l.id) === id) || lps[0] || null;
  }

  /**
   * Einheitlicher Zustand (ohne Netzabfrage, aus den Caches).
   * @returns {{type:string,label:string,available:boolean,title:string|null,connected:boolean|null,
   *   charging:boolean|null,carState:string|null,powerW:number|null,currentA:number|null,
   *   vehicleSocPct:number|null,vehicleTitle:string|null,rangeKm:number|null,mode:string|null,
   *   modes:Array, loadpointId:number|null, source:string}}
   */
  function state() {
    const t = type();
    const label = WALLBOX_LABELS[t];
    if (t !== 'evcc') {
      const d = chargerStatus?.fresh?.() || null;
      const last = chargerStatus?.raw?.() || null;
      return {
        type: t, label, available: Boolean(d), title: label,
        connected: d ? d.connected === true : null,
        charging: d ? d.charging === true : null,
        carState: d?.carState || null,
        powerW: d?.powerW ?? null,
        currentA: d?.currentA ?? null,
        vehicleSocPct: d?.vehicleSocPct ?? null,
        vehicleTitle: null,
        rangeKm: null,
        mode: d ? directModeFromRaw(d.raw) : null,
        modes: DIRECT_MODES,
        loadpointId: 1,
        source: t,
        error: d ? null : (last?.error || null)
      };
    }
    const lp = evccLoadpoint();
    return {
      type: 'evcc', label, available: Boolean(lp), title: lp?.title || null,
      connected: lp ? lp.connected === true : null,
      charging: lp ? lp.charging === true : null,
      carState: null,
      powerW: Number.isFinite(Number(lp?.chargePowerW)) ? Math.round(Number(lp.chargePowerW)) : null,
      currentA: null,
      vehicleSocPct: lp?.connected === true && Number.isFinite(Number(lp?.vehicleSocPct)) ? Number(lp.vehicleSocPct) : null,
      vehicleTitle: lp?.vehicleTitle || null,
      rangeKm: Number.isFinite(Number(lp?.vehicleRangeKm)) ? Math.round(Number(lp.vehicleRangeKm)) : null,
      mode: lp?.mode || null,
      modes: EVCC_MODES,
      loadpointId: lp ? Number(lp.id) : null,
      source: 'evcc',
      error: null
    };
  }

  /**
   * Ladepunkte im Format der evcc-Integration — das Familien-Dashboard und die
   * Datenspende arbeiten damit. Eine direkte Box ist genau ein Ladepunkt.
   */
  function loadpoints() {
    if (!isDirect()) return evccLoadpoints();
    const s = state();
    if (!s.available) return [];
    return [{
      id: 1, title: s.label, connected: s.connected, charging: s.charging,
      chargePowerW: s.powerW, vehicleSocPct: s.vehicleSocPct, vehicleTitle: null, mode: s.mode
    }];
  }

  /** Lademodus setzen. evcc: wie bisher; direkte Box: Aus / Automatisch / Schnell. */
  async function setMode(mode, loadpoint) {
    const m = String(mode || '').trim().toLowerCase();
    if (!isDirect()) {
      if (!evccIntegration || typeof evccIntegration.setMode !== 'function') return { ok: false, error: 'evcc not available' };
      const lp = Number(loadpoint) || state().loadpointId || 1;
      return evccIntegration.setMode(lp, m);
    }
    const adapter = getAdapter?.(type());
    if (!adapter || adapter.isConfigured?.() === false) return { ok: false, error: 'Wallbox nicht eingerichtet' };
    if (m === 'off') return adapter.stop();
    if (m === 'pv' || m === 'minpv') return adapter.release();
    if (m === 'now') {
      // Schnell: mit dem höchsten Strom, den die E-Auto-Einstellungen erlauben.
      return adapter.charge(resolveEvccBridgeConfig(getCfg()).maxCurrentA);
    }
    return { ok: false, error: `mode must be one of ${DIRECT_MODES.map((x) => x.mode).join('|')}` };
  }

  return { type, isDirect, state, loadpoints, setMode, label: () => WALLBOX_LABELS[type()] };
}
