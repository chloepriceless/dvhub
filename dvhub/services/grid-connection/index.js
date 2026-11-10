// services/grid-connection/index.js — Netzanschluss: der gemessene Netzbezug
// darf die Leistung des Hausanschlusses nie überschreiten (Christin 06.11.2026).
//
// Anlass: EOS plante 34,4 kW Netzbezug (Akku 27 kW + E-Auto 11 kW + Haus − PV),
// der Anschluss gibt 29 kW her. EOS kennt keine Bezugsgrenze (geprüft in
// Akkudoktor-EOS v0.4.0rc3 und upstream/main). Deshalb sichert DVhub die Grenze
// im eigenen Steuer-Loop — stabil, für jede Anlage, nicht hinter Beta.
//
// Regelung (je Zählerabfrage, Prod alle 2 s, plus 5-s-Rückfalltakt):
//
//   1. Akku-Netzladung (Victron): jeder positive Netz-Sollwert — EOS, Kleine
//      Börsenautomatik, Zeitplan, Handeingabe, Netzladen, §14a — wird auf die
//      Decke gesenkt (schedule-eval.js, applyControlTarget). Der Sollwert ist bei
//      Victron der Netzbezug am Zähler; der Multi nimmt seine Ladung selbst
//      zurück, wenn Haus oder Wallbox mehr ziehen. Darum gibt der Akku immer
//      zuerst nach. Decke = Grenze − Sicherheitsabstand, mindestens aber die
//      Einregel-Toleranz des Multi (300 W) unter der harten Grenze (Victron-
//      Grenze ohne Abstand: der Bezug pendelt sonst um die Grenze), mit
//      Phasengrenze zusätzlich so tief, dass die stärkste Phase unter ihrer
//      Grenze bleibt. Einregeln um den Sollwert ist kein Akku-Versagen; „hängt“
//      erst bei größerer Abweichung über eine Frist (10 s über der harten
//      Grenze, 30 s darunter) und endet, sobald eine gekürzte Last nachweislich
//      in den Akku floss (Fable R1 P1-1).
//   2. Reicht das nicht (Akku lädt nicht mehr, Haus zieht viel), nimmt DVhub
//      die steuerbaren Lasten in der eingestellten Reihenfolge zurück: Wallbox
//      (Strom bis zum Mindeststrom, dann Pause), Heizstab (my-PV), EEBUS-Geräte
//      (Leistungsgrenze LPC). Kleinste Grenze gilt — §14a und Netzanschluss
//      werden je Gerät zusammengeführt (services/import-limit/core.js).
//   3. Freigabe mit Rückschalt-Abstand: erst wenn mindestens so viel Luft da
//      ist, 30 s lang (gemessene Zeit), frühestens 60 s nach dem letzten Eingriff, und
//      immer nur ein Gerät je Schritt — zuletzt gekürzt, zuerst wieder frei.
//   4. Fail-safe: Liefert der Zähler Fehler oder ist sein Wert älter als 90 s
//      (wie beim Netzstrom-Zähler), gibt DVhub keine NEUE Last frei: Geräte
//      bleiben höchstens bei ihrer letzten Leistung, der Akku-Sollwert höchstens
//      bei Grenze − Abstand − geschätzter Grundlast − diesen Geräten. Ein Gerät
//      ohne Leistungsmeldung behält seine Grenze bzw. bleibt frei und zählt mit
//      seiner Höchstleistung (kein Stopp, Fable R1 P2-6).
//   Ohne Leistungsmeldung zählt eine Kürzung nie als Entlastung — die nächste
//   Last wird im selben Takt mitgekürzt (Fable R1 P1-2).
//
// Akku zuerst bei Nicht-Victron-Anlagen (Christin 10.11.2026): Der Victron
// deckt über seiner AC-Eingangsgrenze selbst aus dem Akku. Andere Anlagen tun das
// nicht von sich aus — DVhub regelt es nativ, je nach dem, was das Profil
// steuern kann (resolveBatteryLever, nicht nach Herstellernamen):
//   - Netz-Sollwert (controlWrite.gridSetpointW): dieselbe Sollwert-Decke wie
//     bei Victron; der Speicher hält den Bezug auf dem Sollwert und entlädt den
//     Rest selbst.
//   - Entladegrenze (controlWrite.maxDischargeW): Begrenzt sie den Akku (z. B.
//     0 = „Akku halten“), hebt DVhub sie um den Überschuss + Regelabstand an,
//     höchstens bis zur Entladeleistung und nur bei frischem Ladestand über der
//     Untergrenze. Fällt der Überschuss, geht es in Stufen zurück, zuletzt auf
//     den Wert davor (bzw. den jüngsten Wunsch einer anderen Quelle).
//   Erst wenn der Akku nicht mehr kann (leer, Leistungsgrenze, folgt nicht
//   binnen BATTERY_OBEY_MS), drosselt DVhub die Lasten. Profile ohne beides
//   (Fronius, Deye) drosseln direkt — „Akku nicht steuerbar“.
//
// Grenze der Physik: Nicht steuerbare Verbraucher (Herd, Durchlauferhitzer,
// Sauna) kann DVhub nicht abschalten. Es nimmt alle steuerbaren schnell zurück
// und meldet, wenn nichts mehr übrig ist („grid_connection_exhausted“).

import { meterImport, capPositiveSetpoint, smallestLimit, NOMINAL_PHASE_VOLTAGE_V } from '../import-limit/core.js';
import { GRID_SHARE_FIELD_MAX_AGE_MS } from '../optimizer/grid-share.js';
import { resolveEvccBridgeConfig, minChargeW } from '../optimizer/eos-evcc-bridge.js';
import { directWallboxConfigured } from '../wallbox/types.js';
import { loadSchedulableDevices } from '../devices/schedulable.js';
import { safeInterval } from '../safe-async.js';
import { getPowerLimits } from '../power-limits.js';
import { MAX_BATTERY_DISCHARGE_W } from '../../server-utils.js';
import { atomicWriteControlState } from '../../control-state-io.js';
import fs from 'node:fs';

export const GRID_CONNECTION_DEFAULTS = Object.freeze({
  limitKw: null,
  marginW: null,
  phaseLimitA: null,
  releaseHysteresisW: 1000,
  baseLoadW: 1000,
  order: 'wallbox_first',
  // Wie der Akku-Wechselrichter am Anschluss hängt: '' unbekannt (keine
  // Gutschrift je Phase), 'three' dreiphasig, 'L1'/'L2'/'L3' einphasig.
  batteryPhases: ''
});

/** Reihenfolge, in der die steuerbaren Lasten nachgeben (der Akku immer zuerst). */
export const ORDER_PRESETS = Object.freeze({
  wallbox_first: Object.freeze(['wallbox', 'heater', 'eebus']),
  heater_first: Object.freeze(['heater', 'wallbox', 'eebus']),
  eebus_first: Object.freeze(['eebus', 'wallbox', 'heater'])
});

// Plausibel für einen Hausanschluss bis Mittelspannung; darunter/darüber ist
// es ein Tippfehler (W statt kW) — dann regelt DVhub nicht und sagt es.
export const MIN_LIMIT_W = 2000;
export const MAX_LIMIT_W = 2_000_000;
// Sicherheitsabstand ab Werk: 3 % der Grenze, mindestens 1 kW. Begründung:
// Der Zähler wird alle 2 s gelesen, der Multi folgt einem neuen Sollwert in
// wenigen Sekunden, eine Wallbox braucht 5–15 s zum Herunterregeln. In dieser
// Zeit springt ein Herd oder Durchlauferhitzer um mehrere kW — 1 kW Abstand
// fängt die üblichen Sprünge ab; bei großen Anschlüssen wächst er mit, weil
// dort auch die Sprünge größer sind. Schmelzsicherungen lösen bei leichter
// Überlast erst nach Minuten aus (träge Kennlinie), Sekunden darüber sind
// unkritisch — Dauerüberlast ist das Risiko.
export const AUTO_MARGIN_PCT = 3;
export const AUTO_MARGIN_MIN_W = 1000;

export const ENTER_TICKS = 2;            // Takte über dem Ziel, bis Geräte gekürzt werden
export const RELEASE_MS = 30_000;        // so lange Luft, bis ein Gerät wieder mehr darf — ZEIT, nicht Takte
// (Gesamtprüfung 4, P2: bei 1-s-Abfrage wären 15 Takte nur 14 s gewesen).
export const RELEASE_TICKS = 16;         // = 30 s bei 2-s-Abfrage (für Tests und Doku)
export const HOLD_AFTER_CUT_MS = 60_000; // nach einem Eingriff frühestens so spät freigeben
export const REASSERT_MS = 30_000;       // Ungehorsam: Befehl höchstens so oft erzwungen neu
export const DISOBEY_TICKS = 3;          // so viele Takte über dem Deckel, bis er erneut gesendet wird
const DISOBEY_TOL_W = 500;               // Toleranz über dem Deckel (Messung, Anlauf), mindestens 10 %
export const OBEY_MS = 20_000;           // so lange zählt ein Befehl als „unterwegs“
export const BATTERY_OBEY_MS = 10_000;   // so lange darf der Multi zum Senken seiner Ladung brauchen (über der harten Grenze)
// Unter der harten Grenze (nur im Sicherheitsabstand) bekommt der Multi mehr
// Zeit — z. B. beim Anlaufen einer Wallbox regelt er in 10–20 s nach (Fable R1 P1-1).
export const BATTERY_OBEY_SOFT_MS = 30_000;
export const BATTERY_TRACK_TOLERANCE_W = 300;   // übliches Einregeln des Multi um den Sollwert
export const BATTERY_STUCK_HOLD_MS = 15 * 60_000; // so lange gilt ein hängender Akku als hängend
// „Hängt“ endet vorzeitig, sobald der Akku nachweislich folgt: Seine Ladung
// stieg seit dem Hängen um mindestens so viel, während der Bezug auf dem
// Sollwert liegt — eine gekürzte Last floss also in den Akku (Fable R1 P1-1).
export const BATTERY_FOLLOW_EVIDENCE_W = 500;
export const FAILSAFE_TICKS = 2;         // Takte ohne frische Messung bis zum Fail-safe
export const METER_MAX_AGE_MS = GRID_SHARE_FIELD_MAX_AGE_MS; // 90 s wie beim Netzstrom-Zähler
const STEP_W = 100;
const FALLBACK_TICK_MS = 5000;
const CLAMP_FRESH_MS = 30_000;
const SETPOINT_MAX_AGE_MS = 120_000;

// Akku-Hilfe (Nicht-Victron): Regelabstand über dem Überschuss, damit der
// Bezug sicher unter dem Ziel landet und nicht am Rand pendelt.
export const ASSIST_MARGIN_W = 200;
// Ein Rücklesewert der Entladegrenze zählt erst so lange nach DVhubs eigenem
// Write — davor kann er noch den alten Stand zeigen.
const ASSIST_READBACK_GRACE_MS = 10_000;
// Eigene Quellen der Akku-Hilfe (kein „Wunsch“ einer anderen Quelle).
export const ASSIST_SOURCE = 'grid_connection_assist';
export const ASSIST_RESTORE_SOURCE = 'grid_connection_restore';
const ASSIST_RETRY_MS = 30_000;
// Anforderungen anderer Quellen (§14a, EOS-Schwelle) gelten so lange ohne
// Erneuerung — fällt eine Quelle aus, hält sie den Akku nicht ewig fest.
export const ASSIST_REQUEST_MAX_AGE_MS = 120_000;

const finite = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const down = (w) => Math.floor(Number(w) / STEP_W) * STEP_W;
const up = (w) => Math.ceil(Number(w) / STEP_W) * STEP_W;

/**
 * Akku-Hebel des Profils — nach dem, was es schreiben kann, nicht nach dem
 * Herstellernamen (eigene Profile zählen genauso):
 *   victron  Verhalten unverändert (Sollwert-Decke; der Multi deckt über der
 *            AC-Eingangsgrenze selbst aus dem Akku).
 *   native   Netz-Sollwert und/oder Entladegrenze schreibbar → „Akku zuerst“.
 *   none     nichts davon → DVhub drosselt direkt die Lasten.
 */
export function resolveBatteryLever(cfg = {}) {
  const manufacturer = String(cfg?.manufacturer || 'victron');
  if (manufacturer === 'victron') {
    return { kind: 'victron', setpoint: true, discharge: false, text: 'Akku zuerst — der Victron regelt selbst (Netz-Sollwert, AC-Eingangsgrenze)' };
  }
  const mqtt = String(cfg?.victron?.transport || '') === 'mqtt';
  const writable = (key) => {
    const c = cfg?.controlWrite?.[key];
    if (c?.enabled !== true) return false;
    return mqtt || c.address != null || c.sunspec != null;
  };
  const setpoint = writable('gridSetpointW');
  const discharge = writable('maxDischargeW');
  if (!setpoint && !discharge) {
    return { kind: 'none', setpoint: false, discharge: false, text: 'Akku nicht steuerbar — DVhub drosselt direkt die Lasten' };
  }
  const via = [setpoint && 'Netz-Sollwert', discharge && 'Entladegrenze'].filter(Boolean).join(' und ');
  return { kind: 'native', setpoint, discharge, text: `Akku zuerst über ${via}` };
}

/**
 * Entladegrenze, die den Überschuss über dem Ziel aus dem Akku deckt:
 * aktuelle Entladung + Überschuss + Regelabstand, auf 100 W aufgerundet,
 * höchstens maxW. Rein — auch der Anschluss für einen vom Plan gehaltenen
 * Akku („darf Überschuss über X W decken“, EOS-Schwellen-Peak-Shaving):
 * excessW = Bezug − X.
 */
export function assistValueW({ excessW, dischargeW = 0, maxW }) {
  const want = Math.max(0, Number(dischargeW) || 0) + Math.max(0, Number(excessW) || 0) + ASSIST_MARGIN_W;
  return Math.min(Math.max(0, Math.floor(Number(maxW) || 0)), up(want));
}

/**
 * Wirksame Einstellungen. Kein Beta-Gate: die Grenze schützt die Sicherungen.
 * active = Grenze gültig eingetragen.
 * @param {object} cfg effektive DVhub-Config
 */
export function resolveGridConnection(cfg = {}, { victronPhaseLimitA = null, victronReadError = false, phaseVoltagesV = null, victronLimitW = null, victronIgnoredA = null } = {}) {
  const c = cfg?.gridConnection || {};
  const dvSet = finite(c.limitKw) && Number(c.limitKw) > 0;
  const rawW = dvSet ? Number(c.limitKw) * 1000 : null;
  const dvValid = dvSet && rawW >= MIN_LIMIT_W && rawW <= MAX_LIMIT_W;
  const dvLimitW = dvValid ? Math.round(rawW) : null;
  // Spannung je Phase: gemessen (frisch, 150–300 V), sonst 230 V. Eine Grenze in
  // A gilt für den Strom — bei 220 V sind 40 A nur 8,8 kW (Christin 07.11.2026).
  const volts = [0, 1, 2].map((i) => {
    const v = Array.isArray(phaseVoltagesV) ? Number(phaseVoltagesV[i]) : NaN;
    return Number.isFinite(v) && v >= VOLTAGE_MIN_V && v <= VOLTAGE_MAX_V ? v : NOMINAL_PHASE_VOLTAGE_V;
  });
  // Victron (Punkt 7): Reg. 2714 AcInputLimit, A je Phase. kW-Grenze daraus =
  // A × Summe der Phasenspannungen (dreiphasig angenommen), auf 100 W
  // abgerundet (Fable R1 P2-4: sonst wandert sie mit jeder Spannungsschwankung).
  // Den stabilisierten Wert (Hysterese) liefert victronLimitExtra mit.
  const vA = finite(victronPhaseLimitA) && Number(victronPhaseLimitA) >= 6 && Number(victronPhaseLimitA) <= 4000
    ? Number(victronPhaseLimitA) : null;
  const vExact = vA != null ? vA * volts.slice(0, VICTRON_ASSUMED_PHASES).reduce((a, b) => a + b, 0) : null;
  const vLimitW = vA == null ? null
    : finite(victronLimitW) && Number(victronLimitW) > 0 && Number(victronLimitW) <= vExact ? Number(victronLimitW) : down(vExact);
  const set = dvSet || vA != null;
  const valid = dvValid || vA != null;
  const limitW = smallestLimit([dvLimitW, vLimitW]);
  const limitSource = limitW == null ? null : (vLimitW != null && limitW === vLimitW && (dvLimitW == null || vLimitW < dvLimitW) ? 'victron' : 'dvhub');
  // Abstand gehört zur DVhub-Einstellung und wird an ihr bemessen.
  const marginBase = dvLimitW ?? limitW;
  const autoMargin = marginBase == null ? AUTO_MARGIN_MIN_W
    : Math.max(AUTO_MARGIN_MIN_W, Math.round(marginBase * AUTO_MARGIN_PCT / 100));
  const marginRaw = finite(c.marginW) && Number(c.marginW) >= 0 ? Math.round(Number(c.marginW)) : autoMargin;
  const dvMarginW = marginBase == null ? marginRaw : Math.min(Math.round(marginBase / 2), marginRaw);
  // Ziel = das strengere aus Victron-Grenze OHNE Abstand (der GX hat schon
  // einen Puffer und kann bewusst unter dem Anschluss liegen, Christin
  // 07.11.2026) und DVhub-Grenze MIT ihrem Abstand. Liegt Victron knapp unter
  // der DVhub-Grenze, bleibt DVhubs Ziel (Fable R1 P2-3: 29 kW mit 1 kW Abstand
  // und 42 A Victron → 28 000 W, nicht 28 980 W).
  const targetW = limitW == null ? null : smallestLimit([dvLimitW != null ? dvLimitW - dvMarginW : null, vLimitW]);
  const marginW = limitW == null ? dvMarginW : limitW - targetW;

  const dvPhaseA = finite(c.phaseLimitA) && Number(c.phaseLimitA) >= 6 && Number(c.phaseLimitA) <= 4000
    ? Number(c.phaseLimitA) : null;
  const phaseA = smallestLimit([dvPhaseA, vA]);
  const phaseSource = phaseA == null ? null : (vA != null && phaseA === vA && (dvPhaseA == null || vA < dvPhaseA) ? 'victron' : 'dvhub');
  // Je Phase: A × Spannung dieser Phase; die strengste als Kennzahl. Ziel je
  // Phase wie gesamt: Victron ohne, DVhub mit Abstand (ein Drittel).
  const on = limitW != null && phaseA != null;
  const dvPhaseW = on && dvPhaseA != null ? volts.map((v) => Math.round(dvPhaseA * v)) : null;
  const vPhaseW = on && vA != null ? volts.map((v) => Math.round(vA * v)) : null;
  const phaseLimitsW = on ? volts.map((_, i) => smallestLimit([dvPhaseW?.[i], vPhaseW?.[i]])) : null;
  const phaseLimitW = phaseLimitsW ? Math.min(...phaseLimitsW) : null;
  const dvPhaseMarginW = dvPhaseW ? Math.min(Math.round(Math.min(...dvPhaseW) / 2), Math.round(dvMarginW / 3)) : 0;
  const phaseTargetsW = on ? volts.map((_, i) => smallestLimit([dvPhaseW ? dvPhaseW[i] - dvPhaseMarginW : null, vPhaseW?.[i]])) : null;
  const phaseTargetW = phaseTargetsW ? Math.min(...phaseTargetsW) : null;
  const phaseMarginW = phaseLimitW == null ? null : Math.max(0, ...phaseLimitsW.map((w, i) => w - phaseTargetsW[i]));

  const releaseHysteresisW = finite(c.releaseHysteresisW) && Number(c.releaseHysteresisW) >= 0
    ? Math.round(Number(c.releaseHysteresisW)) : GRID_CONNECTION_DEFAULTS.releaseHysteresisW;
  const baseRaw = finite(c.baseLoadW) && Number(c.baseLoadW) >= 0
    ? Math.round(Number(c.baseLoadW)) : GRID_CONNECTION_DEFAULTS.baseLoadW;
  const baseLoadW = targetW == null ? baseRaw : Math.min(baseRaw, targetW);
  // Decke für den Akku-Sollwert: Der Multi regelt den Bezug nur ungefähr auf
  // den Sollwert (± einige 100 W). Liegt das Ziel ohne Abstand an der harten
  // Grenze (Victron-Grenze, kleiner eigener Abstand), läge der Bezug sonst die
  // halbe Zeit darüber. Deshalb hält die Sollwert-Decke die Einregel-Toleranz
  // unter der harten Grenze — nur für die Akku-Ladung aus dem Netz; die Lasten
  // dürfen bis zum Ziel (Victron ohne Abzug, Fable R1 P1-1).
  const ceilingTargetW = targetW == null ? null : Math.max(0, Math.min(targetW, limitW - BATTERY_TRACK_TOLERANCE_W));
  const orderKey = ORDER_PRESETS[c.order] ? c.order : GRID_CONNECTION_DEFAULTS.order;
  const batteryPhases = ['three', 'L1', 'L2', 'L3'].includes(c.batteryPhases) ? c.batteryPhases : null;
  const manufacturer = String(cfg?.manufacturer || 'victron');
  const battery = resolveBatteryLever(cfg);
  const reason = !set ? 'not_set' : !valid ? 'limit_invalid' : null;
  const kw = (w) => (w / 1000).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const limitText = limitW == null ? null
    : limitSource === 'victron' ? `von Victron: ${vA} A je Phase ≈ ${kw(vLimitW)} kW${dvLimitW != null ? ` (DVhub-Einstellung ${kw(dvLimitW)} kW)` : ''}`
      : `DVhub-Einstellung: ${kw(dvLimitW)} kW${vA != null ? ` (Victron: ${vA} A je Phase ≈ ${kw(vLimitW)} kW)` : ''}`;
  return {
    active: reason === null,
    reason,
    limitW,
    limitSource,
    limitText,
    dvhubLimitW: dvLimitW,
    victronPhaseLimitA: vA,
    victronReadError: victronReadError === true,
    victronIgnoredA: finite(victronIgnoredA) ? Number(victronIgnoredA) : null,
    marginW,
    marginText: limitW == null ? null : limitSource === 'victron' && marginW === 0 ? 'kein Abstand (Victron-Grenze)' : null,
    targetW,
    ceilingTargetW,
    phaseLimitA: limitW != null ? phaseA : null,
    phaseSource: limitW != null ? phaseSource : null,
    phaseLimitW,
    phaseLimitsW,
    phaseMarginW,
    phaseTargetW,
    phaseTargetsW,
    releaseHysteresisW,
    baseLoadW,
    orderKey,
    order: ORDER_PRESETS[orderKey],
    batteryPhases,
    manufacturer,
    battery,
    // Sollwert-Decke = positiver Netz-Sollwert als Bezug am Zähler (Victron ESS
    // und jedes Profil mit schreibbarem Netz-Sollwert).
    batterySupported: battery.setpoint === true,
    // Akku zuerst nativ (Nicht-Victron): Akku-Hilfe und Wartezeit für den Akku.
    batteryNative: battery.kind === 'native'
  };
}

/**
 * Behelf für ein EOS ohne eigene Bezugsgrenze (Vanilla v0.4.0rc3 bei Kunden);
 * kennt EOS max_grid_import_power_w, entfällt er (eos-config-sync.js):
 * Höchste Akku-Ladeleistung AUS DEM NETZ, mit der EOS planen darf. Bewusst
 * konservativ — Grenze − Abstand − geschätzte Grundlast und, wenn EOS das
 * E-Auto gerade mitplant (angemeldet), dessen volle Ladeleistung (EOS darf
 * beides in denselben Slot legen). null = keine Grenze eingetragen. Wird durch eine EOS-eigene
 * Netzbezugs-Grenze ersetzt, sobald es die gibt.
 */
export function eosGridChargeCapW(cfg, extra = {}) {
  const r = resolveGridConnection(cfg, extra);
  if (!r.active) return null;
  const opt = cfg?.optimizer || {};
  // Das E-Auto nur abziehen, wenn EOS es gerade wirklich plant (angemeldet,
  // extra.evPlanned aus der Anmelde-Entscheidung des Abgleichs) — ohne
  // angemeldetes Auto legt EOS keine Auto-Ladung in den Slot (Fable R3 P3-3:
  // 3 × 16 A und 11-kW-Wallbox gaben sonst dauerhaft 0 W Netzladen).
  // Ohne Angabe wie bisher nach eosOptimizeEv.
  const evPlanned = extra?.evPlanned === undefined ? opt.eosOptimizeEv === true : extra.evPlanned === true;
  const evW = opt.eosOptimizeEv === true && evPlanned ? Math.max(0, Number(opt.evMaxChargeW) || 5000) : 0;
  return Math.max(0, r.targetW - r.baseLoadW - evW);
}

/**
 * „Aus“ für EOS' eigene Bezugsgrenze (devices.inverters.<id>.
 * max_grid_import_power_w, nur in unserem EOS, nicht in Vanilla v0.4.0rc3).
 * Ein null per PUT setzt den Wert dort NICHT zurück: ConfigEOS.set_nested_value
 * merkt die Laufzeit-Einstellung mit exclude_none, deep_merge behält den alten
 * Wert. Deshalb schickt DVhub zum Aufheben einen Wert weit über jedem
 * Anschluss (1 GW) — er begrenzt nie und kostet EOS keine Rechenzeit (die
 * Ladebudget-Rechnung entfällt, wenn die AC-Ladung unter die Grenze passt).
 */
export const EOS_GRID_IMPORT_OFF_W = 1_000_000_000;

/**
 * Bezugsgrenze für EOS (W): Grenze − Sicherheitsabstand, ohne Grenze der
 * Aus-Wert. Nur senden, wenn EOS den Schlüssel kennt (eos-capabilities.js).
 */
export function eosGridImportLimitW(cfg, extra = {}) {
  const r = resolveGridConnection(cfg, extra);
  return r.active ? r.targetW : EOS_GRID_IMPORT_OFF_W;
}

// Victron-Anlagen am Netzanschluss: dreiphasig angenommen (die Anlage meldet
// die Phasenzahl des Anschlusses nicht verlässlich).
export const VICTRON_ASSUMED_PHASES = 3;
// So lange gilt ein gelesener Wert von Reg. 2714 (gelesen wird alle 60 s).
export const VICTRON_LIMIT_MAX_AGE_MS = 5 * 60_000;
// Netzspannung je Phase (state.victron.gridVoltage, zentral vom Poller): nur
// frisch und plausibel, sonst gilt 230 V (wie services/grid-voltage.js).
export const PHASE_VOLTAGE_MAX_AGE_MS = 2 * 60_000;
const VOLTAGE_MIN_V = 150;
const VOLTAGE_MAX_V = 300;

/** Gemessene Phasenspannungen [l1, l2, l3] (unplausibel = null) oder null. */
export function phaseVoltagesFromState(state, now = Date.now()) {
  const gv = state?.victron?.gridVoltage;
  if (!gv || typeof gv !== 'object') return null;
  const at = Number(gv.updatedAt);
  if (!Number.isFinite(at) || at <= 0 || now - at > PHASE_VOLTAGE_MAX_AGE_MS) return null;
  const out = [gv.l1, gv.l2, gv.l3].map((v) => (typeof v === 'number' && v >= VOLTAGE_MIN_V && v <= VOLTAGE_MAX_V ? v : null));
  return out.some((v) => v != null) ? out : null;
}

// Hysterese der Victron-Grenze in W je Laufzeit-Zustand (Fable R1 P2-4, R3
// P2-2): Die Grenze aus Reg. 2714 hängt an der gemessenen Spannung. Ungerundet
// wanderte sie mit jeder Schwankung — Sollwert-Writes alle 30 s und ein PUT an
// EOS bei fast jedem Abgleich. Sie folgt deshalb sofort nach UNTEN, sobald der
// echte Wert unter den gehaltenen fällt (nie über der Grenze), und nach oben
// erst ab VICTRON_LIMIT_RAISE_W Zuwachs, jeweils auf 100 W abgerundet.
export const VICTRON_LIMIT_RAISE_W = 200;
const victronHeld = new WeakMap();

/**
 * Victron-Grenze aus dem Zustand: A je Phase oder null (aus, -1, veraltet).
 * Fail-safe (Fable R1 P1-3): Ein Lesefehler von Reg. 2714 hebt die Grenze
 * nicht auf — der zuletzt gelesene Wert gilt bis VICTRON_LIMIT_MAX_AGE_MS nach
 * der letzten erfolgreichen Lesung weiter (der Poller lässt ihn bei einem
 * Fehler stehen), danach gilt nur noch die DVhub-Einstellung.
 */
export function victronLimitExtra(state, now = Date.now(), cfg = null) {
  // Nur mit dem Victron-Profil (Standard) — ein gemerkter GX-Wert gilt nach
  // einem Profilwechsel nicht weiter.
  const phaseVoltagesV = phaseVoltagesFromState(state, now);
  if (cfg && String(cfg.manufacturer || 'victron') !== 'victron') return { victronPhaseLimitA: null, victronReadError: false, phaseVoltagesV, victronLimitW: null };
  const v = state?.victron || {};
  const at = Number(v.fieldUpdatedAt?.acInputLimitA) || 0;
  const a = Number(v.acInputLimitA);
  const fresh = at > 0 && now - at <= VICTRON_LIMIT_MAX_AGE_MS;
  const error = Boolean(v.errors?.acInputLimitA);
  const victronPhaseLimitA = fresh && a >= 6 && a <= 4000 ? a : null;
  let victronLimitW = null;
  if (victronPhaseLimitA != null) {
    const volts = [0, 1, 2].map((i) => (Array.isArray(phaseVoltagesV) && phaseVoltagesV[i] != null ? phaseVoltagesV[i] : NOMINAL_PHASE_VOLTAGE_V));
    const exact = victronPhaseLimitA * volts.slice(0, VICTRON_ASSUMED_PHASES).reduce((x, y) => x + y, 0);
    const floor = down(exact);
    const held = state && typeof state === 'object' ? victronHeld.get(state) : null;
    victronLimitW = held && held.a === victronPhaseLimitA && exact >= held.w && floor < held.w + VICTRON_LIMIT_RAISE_W
      ? held.w : floor;
    if (state && typeof state === 'object') victronHeld.set(state, { a: victronPhaseLimitA, w: victronLimitW });
  }
  return {
    victronPhaseLimitA,
    victronReadError: error,
    // Wie alt der gültige Wert ist (für die Meldung im Leitstand).
    victronLimitAgeMs: victronPhaseLimitA != null ? now - at : null,
    // Gelesener Wert unter 6 A (kein plausibler Anschluss): gilt nicht, wird
    // aber gemeldet statt still verworfen (Fable R1 P3-5).
    victronIgnoredA: fresh && !error && a > 0 && a < 6 ? a : null,
    phaseVoltagesV,
    victronLimitW,
  };
}

/** resolveGridConnection mit dem Victron-Wert aus dem Laufzeit-Zustand. */
export function gridConnectionFromState(cfg, state, now = Date.now()) {
  return resolveGridConnection(cfg, victronLimitExtra(state, now, cfg || {}));
}

export function createGuardState() {
  return {
    caps: {}, capAt: {}, ceilingW: null, ceilingUnderSince: null,
    over: 0, underSince: null, stale: 0, lastCutAt: 0, batteryPendingSince: null, batteryStuckAt: null,
    batteryStuckChargeW: null,
    failsafe: false, exhausted: false, phasesMissing: false,
    // Leistung vor dem ersten Eingriff je Gerät, Ungehorsam-Zähler und Zeit des
    // letzten erzwungenen Befehls — gehören zum Zustand und gehen mit ihm
    // (aus, Not-Halt; Fable R1 P3-1).
    cutFrom: {}, disobey: {}, reassertAt: {},
    // Akku-Hilfe (Nicht-Victron): { valueW, baseW, since, raisedAt, seq,
    // roomSince, lowerSince } oder null; assistRestore = { valueW } steht zum
    // Zurückschreiben an; disSince = Beginn der Chance für den Akku.
    assist: null, assistRestore: null, disSince: null
  };
}

/**
 * Ein Regeltakt (rein; ändert nur st).
 *
 * @param {object} st  createGuardState()
 * @param {object} p
 * @param {object} p.resolved  resolveGridConnection()
 * @param {object} p.meas      meterImport()
 * @param {Array<{id:string,kind:'wallbox'|'heater'|'eebus',name?:string,currentW:number|null,maxW:number|null,minW?:number}>} p.devices
 *   steuerbare Lasten mit aktueller Leistung
 * @param {{setpointW?:number|null, chargeW?:number|null, dischargeW?:number|null,
 *   socOk?:boolean, limit?:{value:number, from:string}|null, maxW?:number,
 *   request?:{requestedW:number, source:string, seq:number, clamped:boolean}|null,
 *   lastWrite?:{value:number, source:string}|null}} [p.battery]
 *   zuletzt geschriebener Netz-Sollwert und aktuelle Akku-Ladeleistung; für
 *   „Akku zuerst“ (Nicht-Victron) zusätzlich Entladung, Ladestand ok, bekannte
 *   Entladegrenze (-1 = unbegrenzt), höchste Entladeleistung und der jüngste
 *   Entladegrenzen-Wunsch einer anderen Quelle (schedule-eval.js).
 * @param {number} p.now
 * @param {number|null} [p.assistTargetW] strengstes Ziel der Akku-Hilfe aus
 *   anderen Quellen (höchster erlaubter Netzbezug in W, z. B. §14a), null = keins.
 *   Gilt zusätzlich zur Netzanschluss-Grenze und auch ohne sie.
 * @returns {{ events: object[], changed: Set<string>, ceilingTightened: boolean }}
 *   changed enthält die Gerätearten, deren Grenze sich geändert hat, 'ceiling'
 *   und 'battery_assist' (Akku-Hilfe angehoben, gesenkt oder beendet).
 */
export function guardStep(st, { resolved: r, meas, devices = [], battery = {}, now, assistTargetW = null }) {
  const events = [];
  const capsBefore = { ...st.caps };
  const ceilingBefore = st.ceilingW;
  const assistBefore = st.assist?.valueW ?? null;
  const assistBaseBefore = st.assist?.baseW ?? null;
  const restoreBefore = st.assistRestore ?? null;
  // Geräte, deren Deckel erzwungen neu gesendet werden soll (Ungehorsam).
  const forced = new Set();
  const finish = () => {
    const changed = new Set(forced);
    const ids = new Set([...Object.keys(capsBefore), ...Object.keys(st.caps)]);
    for (const id of ids) {
      if ((capsBefore[id] ?? null) !== (st.caps[id] ?? null)) changed.add(kindOf(id, devices));
    }
    if (ceilingBefore !== st.ceilingW) changed.add('ceiling');
    if ((st.assist?.valueW ?? null) !== assistBefore || (st.assist?.baseW ?? null) !== assistBaseBefore
      || (st.assistRestore != null && st.assistRestore !== restoreBefore)) {
      changed.add('battery_assist');
    }
    const ceilingTightened = st.ceilingW != null && (ceilingBefore == null || st.ceilingW < ceilingBefore);
    return { events, changed, ceilingTightened };
  };
  const setCap = (d, w) => { st.caps[d.id] = w; st.capAt[d.id] = now; };
  // Akku-Hilfe beenden: mit restore wird die Grenze davor zurückgeschrieben,
  // ohne (eine neuere Vorgabe steht schon im Gerät) bleibt sie stehen.
  const endAssist = (reason, restore = true) => {
    if (!st.assist) return;
    if (restore) {
      st.assistRestore = { valueW: st.assist.baseW };
      // Die Hilfe des Akkus fällt weg, die Messung zeigt sie aber noch: Lasten
      // erst mit frischen Werten wieder freigeben (Codex 4deab6d6, P1).
      st.lastCutAt = now;
      st.underSince = null;
    }
    events.push({ type: 'assist_end', reason, valueW: st.assist.valueW, restoreW: restore ? st.assist.baseW : null });
    st.assist = null;
  };

  const extTarget = finite(assistTargetW) ? Math.max(0, Number(assistTargetW)) : null;
  if (!r?.active) {
    if (Object.keys(st.caps).length || st.ceilingW != null || st.failsafe) {
      events.push({ type: 'off', reason: r?.reason ?? 'not_set' });
      const keep = { assist: st.assist, assistRestore: st.assistRestore, disSince: st.disSince };
      Object.assign(st, createGuardState(), keep);
    }
    // Ohne Netzanschluss-Grenze kann eine andere Quelle (§14a) Akku-Hilfe
    // anfordern — derselbe Regelkreis, nur auf ihr Ziel.
    if (extTarget != null && r?.batteryNative) {
      if (meas?.fresh) {
        const total = Number(meas.importW);
        nativeBatteryStep(st, { r, battery, total, excess: total - extTarget, targetW: extTarget, phases: null, phaseTargets: null, events, endAssist, now });
      } else {
        st.disSince = null;
        if (st.assist && battery.socOk !== true) endAssist('soc');
      }
      return finish();
    }
    endAssist(r?.reason ?? 'not_set');
    return finish();
  }
  // Geräte, die es nicht mehr gibt (abgemeldet, ausgeschaltet): Grenze vergessen.
  const ids = new Set(devices.map((d) => d.id));
  for (const id of Object.keys(st.caps)) {
    if (!ids.has(id)) { delete st.caps[id]; delete st.capAt[id]; }
  }
  // Gerät weg: auch seine Merker (Fable R1 P3-1).
  for (const m of [st.cutFrom, st.disobey, st.reassertAt]) {
    for (const id of Object.keys(m || {})) if (!ids.has(id)) delete m[id];
  }
  const cT = r.ceilingTargetW ?? r.targetW;
  if (st.ceilingW == null || st.ceilingW > cT) st.ceilingW = cT;

  // --- Fail-safe: Zähler gestört oder veraltet --------------------------------
  if (!meas?.fresh) {
    st.stale += 1;
    st.over = 0;
    st.underSince = null;
    st.ceilingUnderSince = null;
    if (st.stale < FAILSAFE_TICKS && !st.failsafe) return finish();
    if (!st.failsafe) {
      st.failsafe = true;
      events.push({ type: 'failsafe_on', reason: meas?.reason || 'meter_unknown' });
    }
    let frozenW = 0;
    for (const d of devices) {
      const cap = st.caps[d.id] ?? null;
      // Ohne Leistungsmeldung (Fable R1 P2-6): nicht stoppen — eine Grenze
      // bleibt, wie sie ist; ohne Grenze bleibt das Gerät frei (ein neuer
      // Deckel wäre an einer direkten Box ein Ladebefehl). Für die Akku-Decke
      // zählt vorsichtig seine Grenze bzw. Höchstleistung.
      if (!finite(d.currentW)) {
        frozenW += cap ?? Math.max(0, Number(d.maxW) || 0);
        continue;
      }
      const cur = Math.max(0, Number(d.currentW));
      // Auf 100 W aufrunden: ein laufendes Gerät soll durch das Einfrieren
      // nicht umgestellt werden (z. B. 16 A → 15,9 A), nur nicht mehr steigen.
      const curUp = Math.ceil(cur / STEP_W) * STEP_W;
      const next = cap == null ? curUp : Math.min(cap, curUp);
      // Leistung beim Einfrieren merken: ein Gerät, das dabei nichts zog, wird
      // später ganz freigegeben statt per Teil-Deckel gestartet.
      if (cap == null) st.cutFrom[d.id] = cur;
      if (cap == null || next < cap) setCap(d, next);
      frozenW += st.caps[d.id];
    }
    const fsCeiling = down(Math.max(0, r.targetW - r.baseLoadW - frozenW));
    if (fsCeiling < st.ceilingW) st.ceilingW = fsCeiling;
    // Akku-Hilfe im Fail-safe: stehen lassen (kein Anheben, kein Zurücknehmen —
    // ohne Messung gibt DVhub keine Last frei). Ist der Akku aber leer oder sein
    // Ladestand unbekannt, gilt die eigene Freigabe nicht weiter.
    st.disSince = null;
    if (st.assist && battery.socOk !== true) endAssist('soc');
    return finish();
  }
  st.stale = 0;
  if (st.failsafe) {
    st.failsafe = false;
    events.push({ type: 'failsafe_off' });
  }

  // --- Messung -----------------------------------------------------------------
  const total = Number(meas.importW);
  const phaseOn = r.phaseTargetW != null;
  const phases = phaseOn ? meas.phasesW : null;
  if (phaseOn && !phases && !st.phasesMissing) {
    st.phasesMissing = true;
    events.push({ type: 'phases_missing' });
  } else if (phases) st.phasesMissing = false;
  const maxPhase = phases ? Math.max(...phases) : null;
  // In Gesamt-Watt: eine dreiphasige Last um x senken senkt jede Phase um x/3.
  // Je Phase gegen ihre eigene Grenze (A × Spannung dieser Phase).
  const phaseTargets = r.phaseTargetsW || [r.phaseTargetW, r.phaseTargetW, r.phaseTargetW];
  const phaseLimits = r.phaseLimitsW || [r.phaseLimitW, r.phaseLimitW, r.phaseLimitW];
  const phaseExcess = phases ? 3 * Math.max(...phases.map((p, i) => p - phaseTargets[i])) : null;
  const excess = Math.max(total - r.targetW, phaseExcess ?? -Infinity);
  const hardPhase = phases != null && phases.some((p, i) => p > phaseLimits[i]);
  const hard = total > r.limitW || hardPhase;

  // --- Ungehorsam: Gerät zieht trotz Deckel deutlich mehr -------------------
  // (z. B. von Hand in evcc oder an der Box wieder gestartet). Nach der
  // Befolgungszeit und DISOBEY_TICKS Takten den Deckel erzwungen neu senden —
  // höchstens alle REASSERT_MS (Christin 07.11.2026: Grenze nie überschreiten).
  st.disobey ??= {};
  st.reassertAt ??= {};
  // Nur Wallboxen: ihre Brücke sendet erzwungen ohne Dubletten-Filter.
  for (const d of devices.filter((x) => x.kind === 'wallbox')) {
    const cap = st.caps[d.id];
    const cur = finite(d.currentW) ? Number(d.currentW) : null;
    if (cap == null || cur == null || now - (st.capAt[d.id] || 0) <= OBEY_MS
      || cur <= cap + Math.max(DISOBEY_TOL_W, cap * 0.1)) { delete st.disobey[d.id]; continue; }
    st.disobey[d.id] = (st.disobey[d.id] || 0) + 1;
    if (st.disobey[d.id] < DISOBEY_TICKS || now - (st.reassertAt[d.id] || 0) < REASSERT_MS) continue;
    st.reassertAt[d.id] = now;
    st.disobey[d.id] = 0;
    forced.add(d.kind);
    events.push({ type: 'reassert', id: d.id, kind: d.kind, name: d.name || null, capW: cap, currentW: Math.round(cur) });
  }

  // --- 1. Akku: Decke für positive Netz-Sollwerte ------------------------------
  // Je Phase dieselbe Einregel-Reserve wie gesamt (ein Drittel der Toleranz
  // unter der harten Phasengrenze), sonst pendelte die stärkste Phase bei
  // Victron-Grenze ohne Abstand um ihre Grenze (Codex 9cbcf92f, P2).
  const phaseCeilTargets = phases ? phaseTargets.map((t, i) => Math.min(t, phaseLimits[i] - Math.round(BATTERY_TRACK_TOLERANCE_W / 3))) : null;
  const phaseExcessCeil = phases ? 3 * Math.max(...phases.map((p, i) => p - phaseCeilTargets[i])) : null;
  const desired = phaseExcessCeil == null ? cT : Math.min(cT, total - phaseExcessCeil);
  if (desired < st.ceilingW) {
    st.ceilingW = down(Math.max(0, desired));
    st.ceilingUnderSince = null;
  } else if (st.ceilingW < cT) {
    // Luft: entweder Rückschalt-Abstand über der Decke, oder die volle Decke
    // (Ziel) ist erreichbar — sonst erholte sich eine kleine Absenkung nie
    // (Gesamtprüfung, P2).
    const roomy = desired >= st.ceilingW + r.releaseHysteresisW || desired >= cT;
    if (!roomy) st.ceilingUnderSince = null;
    else st.ceilingUnderSince ??= now;
    if (st.ceilingUnderSince != null && now - st.ceilingUnderSince >= RELEASE_MS) {
      // Begrenzt nur das Gesamtziel (keine Phase drückt), zurück aufs Ziel;
      // sonst mit Rückschalt-Abstand unter dem, was die Phase zulässt.
      const raised = desired >= cT ? cT : down(desired - r.releaseHysteresisW);
      st.ceilingW = Math.min(cT, Math.max(st.ceilingW, raised));
      st.ceilingUnderSince = null;
    }
  }

  // Was gleich ohnehin wegfällt: Geräte mit frischem Befehl, die noch über ihrer
  // Grenze liegen, und die Akku-Ladung, die der Multi auf den Sollwert senkt.
  let pending = 0;
  for (const d of devices) {
    const cap = st.caps[d.id];
    if (cap == null || now - (st.capAt[d.id] || 0) > OBEY_MS) continue;
    // Nur Gemessenes zählt als „unterwegs“ — eine angenommene Leistung ist
    // kein Puffer (Fable R1 P1-2).
    if (!finite(d.currentW)) continue;
    // Gemessene Leistung, wenn das Gerät sie getrennt von der steuerbaren
    // meldet (Heizstab: Messung hinkt dem neuen Sollwert hinterher) — höchstens
    // bis zur Leistung beim Eingriff, ein Eigenbetrieb darüber fällt nicht weg
    // (Codex 9cbcf92f, P2).
    const seen = finite(d.measuredW) ? Math.min(Number(d.measuredW), Number(st.cutFrom[d.id]) || Number(d.measuredW)) : Number(d.currentW);
    pending += Math.max(0, Math.max(Number(d.currentW), seen) - cap);
  }
  const chargeW = r.batterySupported ? Math.max(0, Number(battery.chargeW) || 0) : 0;
  const sp = r.batterySupported && finite(battery.setpointW) && Number(battery.setpointW) > 0
    ? Math.min(Number(battery.setpointW), st.ceilingW) : null;
  // Der Multi senkt seine Ladung binnen Sekunden auf den Sollwert.
  //  - Kleine Abweichung (≤ BATTERY_TRACK_TOLERANCE_W): normales Einregeln,
  //    zählt als „gleich weg“ — kein schleichendes Kürzen (Codex 74f9a362, P2).
  //  - Größere Abweichung länger als BATTERY_OBEY_MS: der Akku folgt nicht
  //    (Sollwert nicht angekommen, GX hängt). Dann gilt er als „hängt“: seine
  //    Ladung zählt weder als „gleich weg“ noch bei der Freigabe als Luft, bis
  //    er nicht mehr lädt, kein positiver Sollwert mehr steht oder
  //    BATTERY_STUCK_HOLD_MS vorbei sind — ein Bezug genau auf dem Sollwert
  //    nach dem Kürzen beweist nicht, dass er wieder folgt (Codex b2f1ccd und
  //    74f9a362, P1).
  const gap = sp != null ? Math.max(0, total - sp) : 0;
  const batteryPending = sp != null ? Math.min(chargeW, gap) : 0;
  if (sp == null || chargeW <= 0 || (st.batteryStuckAt != null && now - st.batteryStuckAt > BATTERY_STUCK_HOLD_MS)) {
    st.batteryStuckAt = null;
    st.batteryStuckChargeW = null;
  }
  // Folgt der Akku doch? Seine Ladung stieg seit dem Hängen deutlich, während
  // der Bezug auf dem Sollwert liegt: eine gekürzte Last floss in den Akku,
  // der Multi regelt also (Fable R1 P1-1). Ein Bezug auf dem Sollwert allein
  // beweist das nicht (die Kürzung selbst kann ihn gesenkt haben — Codex
  // b2f1ccd und 74f9a362, P1).
  if (st.batteryStuckAt != null && gap <= BATTERY_TRACK_TOLERANCE_W
    && chargeW >= (Number(st.batteryStuckChargeW) || 0) + BATTERY_FOLLOW_EVIDENCE_W) {
    events.push({ type: 'battery_follows', chargeW: Math.round(chargeW), stuckChargeW: Math.round(Number(st.batteryStuckChargeW) || 0) });
    st.batteryStuckAt = null;
    st.batteryStuckChargeW = null;
    st.batteryPendingSince = null;
  }
  // Einregeln des Multi um den Sollwert (≤ BATTERY_TRACK_TOLERANCE_W) ist kein
  // Akku-Versagen — auch über der harten Grenze nicht (Fable R1 P1-1; die
  // Sollwert-Decke hält die Toleranz unter der harten Grenze). Größere
  // Abweichung: über der harten Grenze nach BATTERY_OBEY_MS, darunter (nur im
  // Sicherheitsabstand) nach BATTERY_OBEY_SOFT_MS.
  // Eine harte PHASEN-Überschreitung zählt immer (die Gesamt-Toleranz sagt
  // über eine einzelne Phase nichts; Codex 9cbcf92f, P2).
  if ((gap > BATTERY_TRACK_TOLERANCE_W || hardPhase) && batteryPending > 0 && excess > 0) {
    st.batteryPendingSince ??= now;
    const obeyMs = hard ? BATTERY_OBEY_MS : BATTERY_OBEY_SOFT_MS;
    if (st.batteryStuckAt == null && now - st.batteryPendingSince > obeyMs) {
      st.batteryStuckAt = now;
      st.batteryStuckChargeW = chargeW;
    }
  } else {
    st.batteryPendingSince = null;
  }
  const batteryStuck = st.batteryStuckAt != null;
  if (!batteryStuck) pending += batteryPending;
  if (r.batteryNative) {
    const targetW = extTarget == null ? r.targetW : Math.min(r.targetW, extTarget);
    pending += nativeBatteryStep(st, { r, battery, total, excess, targetW, phases, phaseTargets, events, endAssist, now });
  }
  const predicted = excess - pending;

  // --- 2. Lasten zurücknehmen --------------------------------------------------
  st.over = predicted > 0 ? st.over + 1 : 0;
  if (predicted > 0 && (st.over >= ENTER_TICKS || hard)) {
    let rest = predicted;
    let cutUnknown = false;
    for (const kind of r.order) {
      for (const d of devices.filter((x) => x.kind === kind)) {
        if (rest <= 0) break;
        const cap = st.caps[d.id] ?? null;
        // Ohne Leistungsmeldung: vorsichtig annehmen, dass es seine Grenze bzw.
        // Höchstleistung zieht — sonst bliebe ein steuerbares Gerät bei
        // Überlast unbegrenzt (Gesamtprüfung 6, P1).
        const measured = finite(d.currentW);
        const cur = measured ? Math.max(0, Number(d.currentW)) : (cap ?? (Number(d.maxW) || 0));
        const draw = cap == null ? cur : Math.min(cur, cap);
        if (draw <= 0) continue;
        let next = Math.max(0, down(draw - rest));
        if (next < (Number(d.minW) || 0)) next = 0;
        if (cap != null && next >= cap) continue;
        setCap(d, next);
        // Leistung vor dem ersten Eingriff (für die volle Freigabe).
        st.cutFrom[d.id] = Math.max(Number(st.cutFrom[d.id]) || 0, draw);
        // Ohne Leistungsmeldung weiß DVhub nicht, ob die Kürzung wirkt: sie
        // zählt nicht gegen den Überschuss, die nächste Last wird im selben
        // Takt mitgekürzt (Fable R1 P1-2 — ein Gerät „ohne Messwert“ mit
        // angenommenen 22 kW schluckte sonst die Kürzung, Minuten über der Grenze).
        if (measured) rest -= draw - next;
        else cutUnknown = true;
        events.push({ type: 'cut', id: d.id, kind: d.kind, name: d.name || null, fromW: Math.round(draw), capW: next, importW: Math.round(total), maxPhaseW: maxPhase == null ? null : Math.round(maxPhase), excessW: Math.round(excess), ...(measured ? {} : { powerUnknown: true }) });
      }
    }
    st.over = 0;
    st.underSince = null;
    st.lastCutAt = now;
    // Erschöpft heißt: nichts Steuerbares mehr übrig. Wurde gerade ein Gerät
    // ohne Messwert gekürzt, ist das (noch) nicht sicher.
    if (rest > 0 && !cutUnknown && !st.exhausted) {
      st.exhausted = true;
      events.push({ type: 'exhausted', restW: Math.round(rest), importW: Math.round(total) });
    }
    return finish();
  }
  if (predicted <= 0) st.exhausted = false;

  // --- 3. Freigabe mit Rückschalt-Abstand ----------------------------------------
  const capped = devices.filter((d) => st.caps[d.id] != null);
  if (!capped.length) { st.underSince = null; return finish(); }
  // Gesamt-Luft: Lädt der Akku gerade aus dem Netz, ist seine Ladung freie
  // Leistung für die Geräte — er gibt zuerst nach, der Multi hält den Bezug
  // auf dem Sollwert. Die Phasen prüft phaseFits() je Gerät.
  let headroom = r.targetW - total;
  const batteryYields = sp != null && !batteryStuck ? chargeW : 0;
  headroom += batteryYields;
  // Passt zusätzliche Leistung x eines Geräts mit devPhases Phasen auf jede
  // Phase? Das Gerät belastet dreiphasig x/3 je Phase, einphasig x auf einer
  // UNBEKANNTEN Phase (jede wird geprüft). Der Akku gibt dabei höchstens x ab,
  // und zwar nur auf den Phasen, auf denen er lädt (Einstellung
  // batteryPhases; unbekannt = keine Entlastung) — Codex bb0e14cd.
  const phaseLimitEach = phases ? phaseTargets.map((t) => t - Math.round(r.releaseHysteresisW / 3)) : null;
  const phaseFits = (x, devPhases) => {
    if (!phases) return true;
    const relief = r.batteryPhases ? Math.min(batteryYields, x) : 0;
    const rel = r.batteryPhases === 'three' ? [relief / 3, relief / 3, relief / 3]
      : ['L1', 'L2', 'L3'].map((l) => (l === r.batteryPhases ? relief : 0));
    const placements = devPhases === 3 ? [[x / 3, x / 3, x / 3]] : [[x, 0, 0], [0, x, 0], [0, 0, x]];
    return placements.every((add) => phases.every((p, i) => p + add[i] - rel[i] <= phaseLimitEach[i]));
  };
  // Größtes x ≤ limit, das auf alle Phasen passt. Nicht monoton (mit dem Akku
  // auf einer Phase passt ein größeres x eher), daher in Schritten absuchen.
  const maxFit = (limit, devPhases) => {
    if (!phases) return limit;
    for (let k = Math.max(0, Math.floor(limit / STEP_W)); k > 0; k -= 1) {
      if (phaseFits(k * STEP_W, devPhases)) return k * STEP_W;
    }
    return 0;
  };
  // Luft zählt nur, wenn auch jede Phase ihren Rückschalt-Abstand hat (oder
  // der Akku dort genug abgibt) — sonst würde ein kurzer Einbruch die 30 s
  // Wartezeit umgehen (Codex 529a0121, P2).
  const giveNow = headroom - r.releaseHysteresisW;
  // Den Mindeststrom braucht nur ein pausiertes Gerät; ein laufendes darf in
  // kleinen Schritten wachsen (Abschluss-Gesamtrunde 2, P2).
  const needW = (d) => (finite(d.currentW) && Number(d.currentW) > 0 ? STEP_W : Math.max(STEP_W, Number(d.minW) || 0));
  const phasesRoomy = !phases || capped.some((d) => maxFit(giveNow, Number(d.phases) === 3 ? 3 : 1) >= needW(d));
  if (headroom >= r.releaseHysteresisW && phasesRoomy) st.underSince ??= now;
  else st.underSince = null;
  if (st.underSince == null || now - st.underSince < RELEASE_MS || now - st.lastCutAt < HOLD_AFTER_CUT_MS) return finish();
  st.underSince = null;
  const give = headroom - r.releaseHysteresisW;
  for (const kind of [...r.order].reverse()) {
    for (const d of capped.filter((x) => x.kind === kind)) {
      const cap = st.caps[d.id];
      // Grundlage ist, was das Gerät gerade WIRKLICH zieht — eine ungenutzte
      // Grenze darf nicht Schritt für Schritt über die Luft hinaus wachsen
      // (Gesamtprüfung 2, P1).
      // Ohne Leistungsmeldung vorsichtig 0 annehmen: die Grenze wächst dann
      // höchstens auf die Luft, nicht Schritt für Schritt darüber hinaus
      // (Codex bf1c2c23, P1).
      const drawNow = Math.min(cap, finite(d.currentW) ? Math.max(0, Number(d.currentW)) : 0);
      // Volle Freigabe erst, wenn die Leistung VOR dem ersten Eingriff Platz hat
      // — eine direkte Box zieht nach release() ihre eigene Höchstleistung,
      // nicht evMaxChargeW (Gesamtprüfung 7, P1).
      const fullW = Math.max(Number(d.maxW) || 0, Number(st.cutFrom[d.id]) || 0);
      // Phasen: ein einphasiges (oder unbekanntes) Gerät darf höchstens die Luft
      // EINER Phase nehmen, ein dreiphasiges das Dreifache (Gesamtprüfung 6, P1).
      const devPhases = Number(d.phases) === 3 ? 3 : 1;
      const giveDev = maxFit(give, devPhases);
      if (!(giveDev > 0)) continue;
      // Zog beim Deckeln nichts (z. B. Fail-safe an einer Leerlauf-Box): ganz
      // freigeben statt per Teil-Deckel einen Ladebefehl auszulösen — DVhub
      // startet keine Box, die es nicht selbst zum Laden geschickt hat.
      // Erst mit Luft für den Mindeststrom: die Box darf danach anlaufen, und
      // openWB bekommt beim Freigeben ihren Strom zurück (Codex a7aacda4, P1).
      if (drawNow === 0 && st.cutFrom[d.id] === 0 && giveDev >= (Number(d.minW) || 0)) {
        delete st.caps[d.id];
        delete st.capAt[d.id];
        delete st.cutFrom[d.id];
        events.push({ type: 'release', id: d.id, kind: d.kind, name: d.name || null, capW: null, importW: Math.round(total) });
        return finish();
      }
      // Pausiert und zu wenig Luft für den Mindeststrom: nicht anlaufen lassen.
      if (drawNow === 0 && giveDev < (Number(d.minW) || 0)) continue;
      const next = Math.max(cap, drawNow + giveDev);
      // Gerundet ohne Zuwachs: Schritt nicht verbrauchen, nächstes Gerät
      // (Codex 7055aa8c, P2).
      if (drawNow + giveDev < fullW && down(next) <= cap) continue;
      if (!(fullW > 0) || (drawNow + giveDev) >= fullW) {
        delete st.caps[d.id];
        delete st.capAt[d.id];
        delete st.cutFrom[d.id];
        events.push({ type: 'release', id: d.id, kind: d.kind, name: d.name || null, capW: null, importW: Math.round(total) });
      } else {
        setCap(d, down(next));
        events.push({ type: 'raise', id: d.id, kind: d.kind, name: d.name || null, capW: st.caps[d.id], importW: Math.round(total) });
      }
      return finish();
    }
  }
  return finish();
}

/**
 * Akku zuerst (Nicht-Victron), ein Takt mit frischer Messung — ändert st.assist
 * und liefert, wie viel Überschuss der Akku gleich übernimmt (W, für die
 * Entscheidung „Lasten drosseln“):
 *
 *  1. Wunsch einer anderen Quelle während der Hilfe: ein angehobener Wunsch
 *     (unter der Hilfe) wird der neue Rückkehrwert; eine geschriebene Vorgabe
 *     über der Hilfe beendet sie ohne Rückschreiben.
 *  2. Überschuss: Begrenzt eine bekannte Entladegrenze (≥ 0) den Akku, steigt
 *     sie auf Entladung + Überschuss + Regelabstand (assistValueW), höchstens
 *     auf die Entladeleistung. Nur mit frischem Ladestand über der Untergrenze.
 *  3. Der Akku bekommt BATTERY_OBEY_MS ab Beginn des Überschusses bzw. ab dem
 *     letzten Anheben; so lange zählt seine freie Leistung als „gleich weg“.
 *     Folgt er nicht, drosselt der Wächter danach die Lasten.
 *  4. Zurück in Stufen: Reicht weniger, sinkt die Grenze nach RELEASE_MS mit
 *     Rückschalt-Abstand; läge der Bezug auch ohne Hilfe mit Abstand unter dem
 *     Ziel, kommt nach RELEASE_MS (frühestens HOLD_AFTER_CUT_MS nach dem
 *     letzten Anheben) der Wert davor zurück.
 */
function nativeBatteryStep(st, { r, battery, total, excess, targetW, phases, phaseTargets, events, endAssist, now }) {
  // targetW: Ziel der Akku-Hilfe (Netzanschluss oder strengere Anforderung);
  // excess: Überschuss über der Netzanschluss-Grenze (für „gleich weg“ bei den Lasten).
  const T = finite(targetW) ? Number(targetW) : r.targetW;
  const lever = r.battery || {};
  const socOk = battery.socOk === true;
  const dis = Math.max(0, Number(battery.dischargeW) || 0);
  const maxW = Math.max(0, Math.min(MAX_BATTERY_DISCHARGE_W, Number(battery.maxW) || 0));
  const known = battery.limit && finite(battery.limit.value) ? Number(battery.limit.value) : null;

  // 1. Wunsch einer anderen Quelle (schedule-eval.js zählt mit): er ist der
  // neue Rückkehrwert. Eine Vorgabe auf oder über der Hilfe (bzw. -1) beendet
  // sie ohne Rückschreiben — aber erst, wenn sie im Gerät steht; ein gleicher
  // Wert, den der Evaluator als „unverändert“ überspringt, zählt auch
  // (Codex 4deab6d6, P2).
  const req = battery.request;
  if (st.assist && req && Number(req.seq) > Number(st.assist.seq || 0)) {
    st.assist.baseW = Number(req.requestedW);
    if (req.clamped) st.assist.seq = Number(req.seq);
    else {
      const lw = battery.lastWrite;
      if (lw && Number(lw.value) === Number(req.requestedW)) {
        st.assist.seq = Number(req.seq);
        endAssist('superseded', false);
      }
    }
  }
  if (st.assist && !socOk) endAssist('soc');

  // Bedarf je Phase: wie weit muss der Akku entladen, damit Gesamt- und
  // Phasenziel halten? Unbekannte Akku-Phasen: dreiphasig angenommen (für den
  // Bedarf); als „gleich weg“ zählt dann nur die Entlastung der Summe.
  const excessAfterT = (x, mode, target) => {
    const tot = total - x - target;
    if (!phases || !phaseTargets) return tot;
    const rel = mode === 'three' ? [x / 3, x / 3, x / 3]
      : ['L1', 'L2', 'L3'].map((l) => (l === mode ? x : 0));
    return Math.max(tot, 3 * Math.max(...phases.map((p, i) => p - rel[i] - phaseTargets[i])));
  };
  // Gegen das Ziel der Akku-Hilfe (Bedarf, Zurücknehmen) …
  const excessAfter = (x, mode) => excessAfterT(x, mode, T);
  // … und gegen die Netzanschluss-Grenze (was den Lasten erspart bleibt).
  const relief = (x) => Math.max(0, excess - excessAfterT(x, r.batteryPhases, r.targetW));
  const aExcess = excessAfter(0, 'three');
  // Überschuss, wenn der Akku x W WENIGER abgibt — bei unbekannten Akku-Phasen
  // der ungünstigste Fall (die Last fällt auf die stärkste Phase).
  const excessIfLess = (x) => (r.batteryPhases
    ? excessAfter(-x, r.batteryPhases)
    : Math.max(...['three', 'L1', 'L2', 'L3'].map((m) => excessAfter(-x, m))));

  // 2. Anheben.
  if (aExcess > 0) st.disSince ??= now;
  else st.disSince = null;
  if (aExcess > 0 && socOk && lever.discharge) {
    // Nach einem Neustart steht noch der Rückkehrwert aus dem Merker an: er
    // bleibt der Wert davor, nicht die angehobene Grenze im Gerät (Codex
    // 4deab6d6, P2).
    const pendingBase = !st.assist && st.assistRestore && finite(st.assistRestore.valueW) ? Number(st.assistRestore.valueW) : null;
    const knownCap = known != null && known >= 0 ? known : null;
    const base = st.assist ? st.assist.baseW : (pendingBase ?? knownCap);
    const current = st.assist ? st.assist.valueW : (known === -1 ? Infinity : (knownCap ?? base));
    if (base != null) {
      const room = Math.max(0, maxW - dis);
      // Kleinste Entladung, die das Ziel hält; reicht der Akku nicht (zu schwach
      // oder auf einer anderen Phase als die Überlast), die kleinste, die die
      // größte Entlastung bringt — Teilhilfe auf der eigenen Phase zählt, ein
      // Akku ohne Wirkung wird nicht angehoben (Codex 7ea58e63, P2).
      const mode = r.batteryPhases || 'three';
      let need = null;
      let best = excessAfter(0, mode);
      let bestX = 0;
      // In 100-W-Schritten, die Restleistung (auch unter 100 W) als letzter
      // Punkt (Codex b7f23382, P2).
      const steps = [];
      for (let x = 0; x < room; x += STEP_W) steps.push(x);
      steps.push(room);
      for (const x of steps) {
        const e = excessAfter(x, mode);
        if (e <= 0) { need = x; break; }
        if (e < best - 1e-9) { best = e; bestX = x; }
      }
      if (need == null) need = bestX;
      const want = need > 0 ? assistValueW({ excessW: need, dischargeW: dis, maxW }) : current;
      if (!st.assist && pendingBase != null && Number.isFinite(current)) {
        // Hilfe aus dem letzten Lauf weiterführen statt erst zurückzuschreiben.
        st.assist = { valueW: Math.max(want, current), baseW: pendingBase, since: now, raisedAt: now, seq: Number(battery.request?.seq) || 0, roomSince: null, lowerSince: null };
        st.assistRestore = null;
        st.disSince = now;
        if (want > current) events.push({ type: 'assist', valueW: want, baseW: pendingBase, dischargeW: Math.round(dis), excessW: Math.round(aExcess), importW: Math.round(total), targetW: Math.round(T) });
      } else if (want > current) {
        if (!st.assist) {
          st.assist = { valueW: want, baseW: base, since: now, raisedAt: now, seq: Number(battery.request?.seq) || 0, roomSince: null, lowerSince: null };
        } else {
          Object.assign(st.assist, { valueW: want, raisedAt: now, roomSince: null, lowerSince: null });
        }
        st.disSince = now; // neue Chance für den Akku
        events.push({ type: 'assist', valueW: want, baseW: base, dischargeW: Math.round(dis), excessW: Math.round(aExcess), importW: Math.round(total), targetW: Math.round(T) });
      }
    }
  }

  // 3. Was der Akku gleich übernimmt.
  let pendingW = 0;
  if (socOk && st.disSince != null && now - st.disSince <= BATTERY_OBEY_MS) {
    const cap = st.assist ? st.assist.valueW : (known != null && known >= 0 ? known : maxW);
    pendingW = relief(Math.max(0, Math.min(cap, maxW) - dis));
  }

  // 4. Zurücknehmen (in Stufen). Solange eine Last gedrosselt ist, hilft der
  // Akku weiter — erst kommen die Lasten zurück, dann geht der Akku auf seine
  // Grenze davor (umgekehrte Reihenfolge des Eingriffs; Codex 4deab6d6, P1).
  // Je Phase gerechnet (Codex 4deab6d6, P1): ein einphasiger Akku entlastet
  // nur seine Phase.
  const a = st.assist;
  const capped = Object.keys(st.caps).some((id) => st.caps[id] != null);
  if (a && aExcess <= 0 && !capped) {
    const hyst = r.releaseHysteresisW;
    const portion = Math.max(0, dis - Math.max(0, a.baseW));
    if (excessIfLess(portion) <= -hyst) {
      a.lowerSince = null;
      a.roomSince ??= now;
      if (now - a.roomSince >= RELEASE_MS && now - a.raisedAt >= HOLD_AFTER_CUT_MS) endAssist('below_limit');
    } else {
      a.roomSince = null;
      // Größte Rücknahme, nach der Gesamt- und Phasenziel noch den
      // Rückschalt-Abstand haben.
      let less = 0;
      for (let x = STEP_W; x <= portion; x += STEP_W) {
        if (excessIfLess(x) <= -hyst) less = x; else break;
      }
      const lowerTo = up(dis - less);
      if (less > 0 && lowerTo <= a.valueW - hyst) {
        a.lowerSince ??= now;
        if (now - a.lowerSince >= RELEASE_MS) {
          const next = Math.max(Math.max(0, a.baseW), lowerTo);
          a.lowerSince = null;
          if (next <= a.baseW) endAssist('below_limit');
          else {
            a.valueW = next;
            events.push({ type: 'assist_lower', valueW: next, baseW: a.baseW, importW: Math.round(total) });
          }
        }
      } else a.lowerSince = null;
    }
  } else if (a) {
    a.roomSince = null;
    a.lowerSince = null;
  }
  return pendingW;
}

function kindOf(id, devices) {
  const d = devices.find((x) => x.id === id);
  if (d) return d.kind;
  if (id === 'wallbox' || id.startsWith('wallbox:')) return 'wallbox';
  if (id.startsWith('heater:')) return 'heater';
  if (id.startsWith('eebus:')) return 'eebus';
  return 'other';
}

const kwText = (w) => `${(Number(w) / 1000).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kW`;
const KIND_LABEL = { wallbox: 'Wallbox', heater: 'Heizstab', eebus: 'EEBUS-Gerät' };

/**
 * Laufzeitdienst: misst, regelt, setzt die Grenzen an die Geräte durch und
 * liefert den Status für Leitstand und /api/status.
 *
 * Hebel, die andere Dienste abfragen:
 *   batteryCeilingW()   schedule-eval.js (applyControlTarget) — Sollwert-Decke
 *   capW('wallbox')     eos-evcc-bridge (getGridCapW, mit §14a: kleinste gilt)
 *   capW('heater:<id>') mypv-regulator
 *   eebusCaps()         paragraph14a → eebus.applyConsumptionShares
 */
export function createGridConnectionGuard(ctx, deps = {}) {
  const now = deps.now || (() => Date.now());
  const st = createGuardState();
  let lastTickAt = 0;
  let timer = null;
  let lastLimitKey = null;
  let lastSyncedKey = null;
  let lastEosSyncAt = 0;
  let lastVictronError = false;
  let lastVictronIgnored = null;
  let last = { meas: null, devices: [] };

  const cfg = () => ctx.getCfg?.() || {};
  const state = () => ctx.state || {};
  const log = (event, data, level) => { try { ctx.pushLog?.(event, data, level); } catch { /* Log darf nie stören */ } };
  const protocol = (eventType, meta, valueNum = null) => {
    try {
      ctx.telemetrySafeWrite?.(() => ctx.telemetryStore?.writeControlEvent?.({
        eventType, target: 'grid_connection', valueNum, reason: eventType, source: 'runtime', meta
      }));
    } catch { /* Protokoll darf nie stören */ }
  };

  function wallboxPowerW(c, bc) {
    if (bc.charger === 'evcc') {
      const st = ctx.evccIntegration?.getStatus?.();
      // Veraltete Abfrage (evcc nicht erreichbar): unbekannt, nicht 0 (Gesamtrunde 1, P1).
      if (st?.lastError || (st?.lastPolledAt != null && now() - Number(st.lastPolledAt) > 90_000)) return null;
      const lp = st?.loadpoints?.[bc.loadpoint - 1];
      return finite(lp?.chargePowerW) ? Number(lp.chargePowerW) : null;
    }
    const st2 = ctx.chargerStatus?.fresh?.();
    return finite(st2?.powerW) ? Number(st2.powerW) : null;
  }

  /** Steuerbare Lasten, die DVhub wirklich zurücknehmen kann. */
  function devices(c) {
    const list = [];
    const bc = resolveEvccBridgeConfig(c);
    // Wallbox: EINE Regel (Christin 07.11.2026) — solange eine Grenze gilt,
    // überwacht der Wächter die Wallbox immer: mit oder ohne EOS-Weitergabe,
    // „Sofort laden“, evcc im eigenen Modus oder Handstart. Die Brücke setzt den
    // Deckel durch (evcc maxcurrent bzw. Box-Strom, unter dem Mindeststrom Pause).
    const override = ctx.eosEvccBridge?.getOverride?.();
    const overrideCharging = override != null && override.kind !== 'stop';
    const viaBridge = (bc.enabled || overrideCharging) && ctx.licenseService?.isProActive?.() !== false;
    const evccSt = ctx.evccIntegration?.getStatus?.() || null;
    const evccOn = Boolean(evccSt?.url);
    const direct = bc.charger !== 'evcc' && directWallboxConfigured(c);
    if (((bc.charger === 'evcc' && (evccOn || viaBridge)) || direct) && ctx.eosEvccBridge) {
      // Höchstleistung nach der Freigabe: über die EOS-Brücke höchstens das, was
      // der Plan schickt (evMaxChargeW); sonst regelt die Wallbox selbst — bis
      // zu ihrem Nennstrom (vorsichtig 32 A je Phase).
      const releaseW = viaBridge ? bc.maxChargeW : Math.max(bc.maxChargeW, Math.round(32 * 230 * bc.phases));
      list.push({ id: 'wallbox', kind: 'wallbox', name: 'Wallbox', currentW: wallboxPowerW(c, bc), maxW: releaseW, minW: minChargeW(bc), phases: bc.phases });
    }
    // Weitere evcc-Ladepunkte: jeder, der gerade lädt (oder noch gedeckelt ist).
    if (evccOn && ctx.eosEvccBridge) {
      const fresh = !(evccSt.lastError || (evccSt.lastPolledAt != null && now() - Number(evccSt.lastPolledAt) > 90_000));
      for (const lp of Array.isArray(evccSt.loadpoints) ? evccSt.loadpoints : []) {
        const lpId = Number(lp?.id);
        if (!(lpId >= 1) || (bc.charger === 'evcc' && lpId === bc.loadpoint)) continue;
        const id = `wallbox:evcc:${lpId}`;
        const powerW = fresh && finite(lp.chargePowerW) ? Number(lp.chargePowerW) : null;
        // Veraltete Abfrage: zuletzt ladend bleibt überwacht, Leistung unbekannt
        // (vorsichtige Annahme im Wächter) — Gesamtrunde 2, P1.
        const charging = fresh ? powerW > 0 : (lp.charging === true || Number(lp.chargePowerW) > 0);
        if (!charging && st.caps[id] == null) continue;
        const ph = [3, 1, 2].includes(Number(lp.phasesActive)) ? Number(lp.phasesActive)
          : ([1, 2, 3].includes(Number(lp.phasesConfigured)) ? Number(lp.phasesConfigured) : 3);
        list.push({
          id, kind: 'wallbox', name: lp.title || `Ladepunkt ${lpId}`, currentW: powerW,
          maxW: Math.round(32 * 230 * ph), minW: Math.round((Number(lp.minCurrentA) || 6) * 230 * ph), phases: ph === 3 ? 3 : 1
        });
      }
    }
    if (ctx.mypvRegulator) {
      let heaters;
      try { heaters = loadSchedulableDevices(c).devices; } catch { heaters = []; }
      const status = ctx.mypvRegulator.getStatus?.() || {};
      for (const h of heaters) {
        if (h.enabled === false || h.kind !== 'modulating' || h.endpoint?.type !== 'mypv') continue;
        const s = status[h.id] || {};
        // Steuerbar ist nur, was DVhub gerade vorgibt: Der Deckel wirkt auf
        // DVhubs Vorgabe (mypv-regulator). Läuft der Stab von selbst über ihr
        // (eigener Thermostat, Boost), bringt ein Kürzen nichts und darf nicht
        // als Entlastung zählen (Fable R1 P2-8).
        const meas = finite(s.powerW) ? Math.max(0, Number(s.powerW)) : null;
        const own = finite(s.setpointW) ? Math.max(0, Number(s.setpointW)) : null;
        const cur = own != null ? (meas != null ? Math.min(meas, own) : own) : meas;
        list.push({ id: `heater:${h.id}`, kind: 'heater', name: h.name || 'Heizstab', currentW: cur, measuredW: meas, maxW: Number(h.plan?.maxPowerW) || null, minW: Number(h.plan?.minPowerW) || 0 });
      }
    }
    // Die Hauptwallbox über EEBUS steht schon als „wallbox“ in der Liste —
    // nicht noch einmal als EEBUS-Gerät zählen (Gesamtprüfung 3, P1).
    const wallboxSki = list.some((d) => d.id === 'wallbox') && c?.wallbox?.type === 'eebus'
      ? String(c.wallbox.eebus?.ski || '').trim().toLowerCase() : null;
    for (const d of ctx.eebus?.consumptionDevices?.() || []) {
      if (wallboxSki && String(d.ski || d.id?.replace(/^eebus:/, '') || '').toLowerCase() === wallboxSki) continue;
      list.push({ id: d.id, kind: 'eebus', name: d.name || 'EEBUS-Gerät', currentW: finite(d.powerW) ? Number(d.powerW) : null, maxW: Number(d.maxW) || null, minW: 0 });
    }
    return list;
  }

  function batteryInput(c, r = null) {
    const s = state();
    const lw = s.schedule?.lastWrite?.gridSetpointW;
    const t = now();
    // Ein dauerhafter Sollwert ohne Keepalive wird nicht neu geschrieben — der
    // aktive Eintrag der Auswertung (gleicher Wert) zeigt, dass er noch gilt
    // (Gesamtprüfung 6, P2).
    const act = s.schedule?.active?.gridSetpointW;
    const seenAt = Math.max(Number(lw?.at) || 0, act && lw && Number(act.value) === Number(lw.value) ? Number(act.at) || 0 : 0);
    const setpointW = lw && finite(lw.value) && t - seenAt <= SETPOINT_MAX_AGE_MS ? Number(lw.value) : null;
    const v = s.victron || {};
    const at = Number(v.fieldUpdatedAt?.batteryPowerW) || 0;
    const maxAge = Number(c?.victron?.telemetryMaxAgeMs ?? 90000);
    const chargeW = at > 0 && t - at <= maxAge ? Math.max(0, Number(v.batteryChargeW) || 0) : 0;
    if (!r?.batteryNative) {
      // Victron & Co.: gemessene Entladung nur für die Rückmeldung der Akku-Hilfe.
      const fresh = at > 0 && t - at <= maxAge && !v.errors?.batteryPowerW;
      return { setpointW, chargeW, dischargeW: fresh ? Math.max(0, Number(v.batteryDischargeW) || 0) : 0, batteryFresh: fresh };
    }
    // Akku zuerst (Nicht-Victron): Entladung, Ladestand, Entladegrenze.
    const batFresh = at > 0 && t - at <= maxAge && !v.errors?.batteryPowerW;
    const dischargeW = batFresh ? Math.max(0, Number(v.batteryDischargeW) || 0) : 0;
    const limits = getPowerLimits(c).limits;
    const maxW = Math.min(Number(limits.batteryMaxDischargeDcW) || 0, Number(limits.inverterMaxPowerW) || 0);
    const gc = s.ctrl?._gridConnection || {};
    return {
      setpointW, chargeW, dischargeW, batteryFresh: batFresh,
      // Ohne frische Akku-Leistung weiß DVhub nicht, was der Akku tut — dann
      // keine Akku-Hilfe (lieber drosseln als blind entladen).
      socOk: batFresh && socUsable(c, t),
      limit: knownDischargeLimit(c, t),
      maxW,
      request: gc.dischargeRequest || null,
      lastWrite: s.schedule?.lastWrite?.maxDischargeW || null
    };
  }

  // Ladestand für die Akku-Hilfe: frisch, kein Einfrieren/Widerspruch, über der
  // Untergrenze (Sicherheit bzw. Mindest-Ladestand im Wechselrichter, die
  // höhere) — wie der T-0075-Boden im Steuerpfad.
  function socUsable(c, t) {
    const v = state().victron || {};
    const maxAge = Number(c?.victron?.telemetryMaxAgeMs ?? 90000);
    const fresh = (f) => {
      const at = Number(v.fieldUpdatedAt?.[f]) || 0;
      return at > 0 && t - at <= maxAge && !v.errors?.[f];
    };
    const soc = Number(v.soc);
    if (v.soc == null || v.soc === '' || !Number.isFinite(soc) || !fresh('soc')) return false;
    if (v.freeze?.active === true || v.sourceMismatch?.active === true) return false;
    let floor = Number(getPowerLimits(c).limits.hardFloorSocPct) || 0;
    if (fresh('minSocPct') && Number.isFinite(Number(v.minSocPct))) floor = Math.max(floor, Number(v.minSocPct));
    return soc > floor;
  }

  // Entladegrenze, die gerade im Gerät steht: Rücklesung, sofern sie sicher
  // nach DVhubs letztem Write gelesen wurde, sonst DVhubs letzter Write.
  // null = unbekannt (dann hebt DVhub nichts an), -1 = unbegrenzt.
  function knownDischargeLimit(c, t) {
    const s = state();
    const v = s.victron || {};
    const maxAge = Number(c?.victron?.telemetryMaxAgeMs ?? 90000);
    const lw = s.schedule?.lastWrite?.maxDischargeW;
    const lwOk = lw && finite(lw.value);
    const rbAt = Number(v.fieldUpdatedAt?.maxDischargeW) || 0;
    const rbOk = c?.points?.maxDischargeW?.enabled === true && rbAt > 0 && t - rbAt <= maxAge
      && !v.errors?.maxDischargeW && finite(v.maxDischargeW);
    if (rbOk && (!lwOk || rbAt > (Number(lw.at) || 0) + ASSIST_READBACK_GRACE_MS)) return { value: Number(v.maxDischargeW), from: 'readback' };
    if (lwOk) return { value: Number(lw.value), from: 'own_write' };
    if (rbOk) return { value: Number(v.maxDischargeW), from: 'readback' };
    return null;
  }

  // Merker auf der Platte: eine angehobene Entladegrenze überlebt einen
  // Neustart im Gerät — der nächste Prozess schreibt den Wert davor zurück.
  function persistAssist() {
    const p = ctx.gridConnectionAssistPath;
    if (!p) return;
    try {
      if (st.assist) atomicWriteControlState(p, { valueW: st.assist.valueW, baseW: st.assist.baseW, since: st.assist.since });
      else if (!st.assistRestore) fs.rmSync(p, { force: true });
    } catch (e) {
      log('grid_connection_error', { phase: 'assist_persist', error: e?.message || String(e) }, 'warn');
    }
  }
  if (ctx.gridConnectionAssistPath) {
    try {
      const saved = JSON.parse(fs.readFileSync(ctx.gridConnectionAssistPath, 'utf8'));
      if (saved && finite(saved.baseW) && Number(saved.baseW) >= 0) {
        // fromDisk: Beleg für das Not-Halt-Tor, dass DVhub die Grenze angehoben
        // hatte — nach dem Neustart fehlt der eigene letzte Write (Fable R1 P2-7).
        st.assistRestore = { valueW: Number(saved.baseW), fromDisk: true };
        log('grid_connection_assist_restored', { valueW: saved.valueW ?? null, baseW: Number(saved.baseW), text: 'Netzanschluss: Akku-Hilfe aus dem letzten Lauf — die Entladegrenze davor wird zurückgeschrieben.' }, 'warn');
      }
    } catch { /* kein Merker → nichts angehoben */ }
  }

  // Rückkehrwert beim Not-Halt: ein Wunsch, den der Wächter noch nicht
  // verarbeitet hat, gilt schon (Codex 4deab6d6, P2); steht eine neuere
  // Vorgabe bereits im Gerät, bleibt sie.
  function stopRestore() {
    const req = state().ctrl?._gridConnection?.dischargeRequest;
    const lw = state().schedule?.lastWrite?.maxDischargeW;
    if (req && Number(req.seq) > Number(st.assist.seq || 0)) {
      if (!req.clamped && lw && Number(lw.value) === Number(req.requestedW)) return null;
      return { valueW: Number(req.requestedW) };
    }
    return { valueW: st.assist.baseW };
  }

  // Hat seit dem Ende der Hilfe eine andere Quelle die Entladegrenze
  // geschrieben, gilt deren Wert — nicht nachträglich überschreiben (Codex
  // 4deab6d6, P2). true = verworfen.
  function dropSupersededRestore() {
    if (!st.assistRestore || st.assist) return false;
    st.assistRestore.at ??= Date.now();
    const lw = state().schedule?.lastWrite?.maxDischargeW;
    if (!lw || String(lw.source || '').startsWith('grid_connection') || !(Number(lw.at) >= st.assistRestore.at)) return false;
    log('grid_connection_assist_superseded', { valueW: st.assistRestore.valueW, by: lw.source, text: 'Netzanschluss: Zurückschreiben der Entladegrenze entfällt — eine neuere Vorgabe gilt.' });
    st.assistRestore = null;
    persistAssist();
    return true;
  }

  let assistWriting = false;
  let assistDirty = false;
  let assistRestoreTriedAt = 0;
  // Akku-Hilfe durchsetzen: anheben/senken mit eigener Quelle, beenden mit dem
  // Wert davor. Alles über applyControlTarget — Grenzwerte, T-0075-Boden und
  // das Not-Halt-Tor gelten auch hier.
  function enforceAssist({ force = false } = {}) {
    if (typeof ctx.applyControlTarget !== 'function') return;
    // Läuft noch ein Write, den neuen Stand danach schreiben (sonst ginge ein
    // Anheben während des Writes verloren).
    if (assistWriting) { if (force) assistDirty = true; return; }
    let value; let source;
    if (st.assist) {
      value = st.assist.valueW; source = ASSIST_SOURCE;
    } else if (st.assistRestore) {
      if (dropSupersededRestore()) return;
      if (!force && now() - assistRestoreTriedAt < ASSIST_RETRY_MS) return;
      assistRestoreTriedAt = now();
      value = st.assistRestore.valueW; source = ASSIST_RESTORE_SOURCE;
    } else return;
    const restore = source === ASSIST_RESTORE_SOURCE;
    const wanted = st.assistRestore;
    assistWriting = true;
    Promise.resolve(ctx.applyControlTarget('maxDischargeW', value, source))
      .then((res) => {
        const lw = state().schedule?.lastWrite?.maxDischargeW;
        if (restore) {
          if (res?.ok && st.assistRestore === wanted) {
            st.assistRestore = null;
            log('grid_connection_assist_end', { valueW: value, text: `Netzanschluss: Akku-Hilfe beendet — Entladegrenze zurück auf ${value === -1 ? 'unbegrenzt' : kwText(value)}` });
            protocol('grid_connection_assist_end', { valueW: value }, value);
          } else if (!res?.ok) {
            log('grid_connection_assist_failed', { phase: 'restore', valueW: value, error: res?.error || 'unknown' }, 'warn');
          }
        } else if (!res?.ok || (lw && Number(lw.value) !== Number(value) && !res.skipped)) {
          // Nicht angekommen (Fehler, T-0075-Boden): laut melden; der Wächter
          // drosselt die Lasten, sobald der Akku nicht folgt.
          log('grid_connection_assist_failed', { phase: 'raise', valueW: value, written: lw ? Number(lw.value) : null, error: res?.error || null }, 'warn');
        }
        persistAssist();
      })
      .catch((e) => log('grid_connection_error', { phase: 'assist', error: e?.message || String(e) }, 'warn'))
      .finally(() => {
        assistWriting = false;
        if (assistDirty) { assistDirty = false; enforceAssist({ force: true }); }
      });
  }

  function report(r, events) {
    for (const e of events) {
      if (e.type === 'cut') {
        const text = e.capW === 0 ? `${KIND_LABEL[e.kind] || e.kind} pausiert` : `begrenzt ${KIND_LABEL[e.kind] || e.kind} auf ${kwText(e.capW)}`;
        log('grid_connection_limit', { ...e, limitW: r.limitW, targetW: r.targetW, text: `Netzanschluss: ${text}` }, 'warn');
        protocol('grid_connection_limit', { ...e, limitW: r.limitW }, e.capW);
      } else if (e.type === 'raise' || e.type === 'release') {
        log('grid_connection_release', { ...e, limitW: r.limitW });
        protocol('grid_connection_release', { ...e, limitW: r.limitW }, e.capW);
      } else if (e.type === 'failsafe_on') {
        log('grid_connection_failsafe', { reason: e.reason, limitW: r.limitW, ceilingW: st.ceilingW, caps: { ...st.caps } }, 'warn');
        protocol('grid_connection_failsafe', { reason: e.reason, ceilingW: st.ceilingW, caps: { ...st.caps } });
      } else if (e.type === 'failsafe_off') {
        log('grid_connection_failsafe_end', { limitW: r.limitW });
        protocol('grid_connection_failsafe_end', {});
      } else if (e.type === 'exhausted') {
        log('grid_connection_exhausted', { ...e, limitW: r.limitW, text: 'Netzanschluss: keine steuerbare Last mehr übrig — der Rest kommt von Verbrauchern, die DVhub nicht schalten kann.' }, 'warn');
        protocol('grid_connection_exhausted', e, e.restW);
      } else if (e.type === 'phases_missing') {
        log('grid_connection_phases_missing', { text: 'Phasengrenze eingetragen, aber der Zähler liefert keine Phasenwerte — DVhub regelt nur auf die Gesamtgrenze.' }, 'warn');
      } else if (e.type === 'off') {
        log('grid_connection_off', { reason: e.reason });
      } else if (e.type === 'assist' || e.type === 'assist_lower') {
        const text = e.type === 'assist'
          ? `Netzanschluss: Akku zuerst — Entladegrenze auf ${kwText(e.valueW)} angehoben (vorher ${e.baseW === -1 ? 'unbegrenzt' : kwText(e.baseW)})`
          : `Netzanschluss: Akku-Hilfe gesenkt auf ${kwText(e.valueW)}`;
        log('grid_connection_assist', { ...e, limitW: r.limitW, targetW: r.targetW, text });
        protocol('grid_connection_assist', { ...e, limitW: r.limitW }, e.valueW);
      } else if (e.type === 'assist_end' && e.restoreW == null) {
        log('grid_connection_assist_superseded', { ...e, text: 'Netzanschluss: Akku-Hilfe beendet — eine neuere Vorgabe für die Entladegrenze gilt.' });
      }
    }
  }

  // Sollwert-Decke gesenkt: den laufenden Netz-Sollwert sofort neu durch den
  // Steuerpfad schicken (dort greift die neue Decke), nicht erst im nächsten
  // Auswertungstakt (5–15 s).
  function reassertSetpoint() {
    const s = state();
    const lw = s.schedule?.lastWrite?.gridSetpointW;
    const req = s.ctrl?._gridConnection?.request;
    const ceiling = ceilingNow();
    if (!lw || ceiling == null || !(Number(lw.value) > ceiling)) return;
    if (req && req.source !== lw.source) return;
    if (now() - (Number(lw.at) || 0) > SETPOINT_MAX_AGE_MS) return;
    // Erste Decke (vorher keine): der Steuerpfad hat noch keinen angefragten
    // Wert gemerkt — dann ist der zuletzt geschriebene ungedeckelt (Codex
    // 7a44bb81, P2).
    const use = req || { requestedW: Number(lw.value), source: lw.source };
    Promise.resolve(ctx.applyControlTarget?.('gridSetpointW', use.requestedW, use.source))
      .catch((e) => log('grid_connection_error', { phase: 'reassert_setpoint', error: e?.message || String(e) }, 'warn'));
  }

  function enforce(changed, ceilingTightened) {
    if (changed.has('wallbox')) {
      Promise.resolve(ctx.eosEvccBridge?.apply?.())
        .then((r) => {
          // Grenze nicht angekommen: laut melden, statt eine Grenze anzuzeigen,
          // die an der Wallbox nicht gilt (Gesamtprüfung 2, P1).
          // Fehler, oder übersprungen, obwohl eine Grenze steht. „skipped“ nach
          // einer Freigabe (Weitergabe aus) ist kein Fehler (Codex 7055aa8c,
          // 6e42ee3e, P2).
          if (r && r.ok === false && (r.error || st.caps.wallbox != null)) {
            log('grid_connection_wallbox_failed', { capW: st.caps.wallbox ?? null, error: r.error || r.skipped || 'unknown' }, 'warn');
          }
        })
        .catch((e) => log('grid_connection_error', { phase: 'wallbox', error: e?.message || String(e) }, 'warn'));
    }
    if (changed.has('eebus')) {
      try { ctx.p14a?.update?.(); } catch (e) { log('grid_connection_error', { phase: 'eebus', error: e?.message || String(e) }, 'warn'); }
    }
    // Heizstab: der my-PV-Regler liest capW() in jedem Takt selbst.
    if (ceilingTightened) reassertSetpoint();
    if (changed.has('battery_assist')) {
      persistAssist();
      enforceAssist({ force: true });
    }
  }

  // Not-Halt: der Wächter bricht ihn nicht durch — keine Grenzen, keine
  // Befehle. Beim Aufheben beginnt er von vorn (Christin 06.11.2026).
  const paused = () => state()?.ctrl?.discretionaryWritesPaused === true;
  let pausedSeen = false;

  function tick() {
    lastTickAt = now();
    if (paused()) {
      if (!pausedSeen) {
        pausedSeen = true;
        // Eigene Vorgabe EINMAL zurücknehmen: eine angehobene Entladegrenze
        // geht auf den Wert davor (das Not-Halt-Tor lässt genau dieses Senken
        // durch). Sonst nichts — Wallbox & Co. neutralisiert der Not-Halt selbst.
        const restore = st.assist ? stopRestore() : st.assistRestore;
        Object.assign(st, createGuardState());
        log('grid_connection_paused', { text: 'Not-Halt aktiv — der Netzanschluss-Wächter greift nicht ein.' }, 'warn');
        if (restore) {
          st.assistRestore = restore;
          enforceAssist({ force: true });
        } else {
          // Nichts zurückzuschreiben (neuere Vorgabe steht): auch kein Merker
          // für den nächsten Start (Codex 7ea58e63, P2).
          persistAssist();
        }
      }
      return null;
    }
    pausedSeen = false;
    try {
      const c = cfg();
      const r = gridConnectionFromState(c, state(), now());
      // Wirksame Grenze geändert (z. B. Victron-Wert 2714 umgestellt): EOS neu
      // abgleichen, höchstens jede Minute. Victron-Wert nicht lesbar: melden.
      // Aus den Einstellungen, nicht aus Watt: Spannungsschwankung ist keine
      // Grenzänderung (EOS bekommt beim normalen Abgleich den aktuellen Wert).
      const limitKey = `${r.limitSource}|${r.dvhubLimitW}|${r.victronPhaseLimitA}|${r.phaseLimitA}|${r.marginW === 0}`;
      if (limitKey !== lastLimitKey) {
        if (lastLimitKey !== null) log('grid_connection_limit_changed', { limitW: r.limitW, phaseLimitA: r.phaseLimitA, source: r.limitSource, text: r.limitText });
        if (lastSyncedKey === null) lastSyncedKey = limitKey; // Start: der normale Abgleich läuft ohnehin
        lastLimitKey = limitKey;
      }
      // Geänderte Grenze an EOS — gedrosselt, aber nicht vergessen.
      if (limitKey !== lastSyncedKey && now() - lastEosSyncAt >= 60_000) {
        lastEosSyncAt = now();
        lastSyncedKey = limitKey;
        Promise.resolve(ctx.eosConfigSync?.sync?.()).catch(() => {});
      }
      if (r.victronIgnoredA !== lastVictronIgnored) {
        lastVictronIgnored = r.victronIgnoredA;
        if (r.victronIgnoredA != null) log('grid_connection_victron_ignored', { valueA: r.victronIgnoredA, text: `Victron-Bezugsgrenze (Reg. 2714) steht auf ${r.victronIgnoredA} A — unter 6 A ist das kein plausibler Anschluss, DVhub nimmt den Wert nicht als Grenze.` }, 'warn');
      }
      if (r.victronReadError !== lastVictronError) {
        lastVictronError = r.victronReadError;
        if (r.victronReadError) log('grid_connection_victron_unreadable', { text: `Victron-Bezugsgrenze (Reg. 2714) nicht lesbar — der zuletzt gelesene Wert gilt noch bis ${Math.round(VICTRON_LIMIT_MAX_AGE_MS / 60_000)} min nach der letzten Lesung, danach nur die DVhub-Werte.` }, 'warn');
      }
      const wantsAssist = (r.batteryNative || r.batterySupported) && liveRequests().length > 0;
      const meas = r.active || wantsAssist ? meterImport(state(), c, { now: lastTickAt, maxAgeMs: METER_MAX_AGE_MS }) : null;
      const list = r.active ? devices(c) : [];
      // Steht ein Zurückschreiben an, das eine neuere Vorgabe überholt hat, gilt
      // es nicht mehr — auch nicht als Rückkehrwert einer neuen Hilfe (Codex
      // 7ea58e63, P2).
      dropSupersededRestore();
      const battery = batteryInput(c, r);
      const assistTargetW = r.batteryNative ? externalTargetW(meas, battery) : null;
      if (!r.batteryNative && wantsAssist) last = { ...last, meas, battery };
      const res = guardStep(st, { resolved: r, meas, devices: list, battery, now: lastTickAt, assistTargetW });
      last = { meas, devices: list, battery };
      report(r, res.events);
      if (res.changed.size || res.ceilingTightened) enforce(res.changed, res.ceilingTightened);
      // Offenes Zurückschreiben (Fehlschlag, Merker aus dem letzten Lauf)
      // höchstens alle ASSIST_RETRY_MS neu versuchen.
      if (st.assistRestore && !st.assist && !res.changed.has('battery_assist')) enforceAssist();
      return res;
    } catch (e) {
      log('grid_connection_error', { error: e?.message || String(e) }, 'warn');
      return null;
    }
  }

  function active() { return !paused() && gridConnectionFromState(cfg(), state(), now()).active; }

  // --- Akku zuerst für mehrere Quellen (Christin 10.11.2026) -----------------
  // Nicht nur die Netzanschluss-Grenze (intern, Quelle 'grid-connection'), auch
  // §14a ('p14a') und das EOS-Schwellen-Peak-Shaving ('eos-threshold', services/optimizer/eos-threshold-assist.js)
  // können Akku-Hilfe anfordern: request({ source, maxImportW }) = höchster
  // erlaubter Netzbezug, oder request({ source, coverW }) = so viel Last soll der
  // Akku zusätzlich übernehmen. Das strengste Ziel gewinnt. Nicht-Victron: der
  // Regelkreis oben (Entladegrenze, Sollwert-Decke); Victron: Decke des positiven
  // Netz-Sollwerts. Not-Halt: keine Hilfe. Anforderungen verfallen nach
  // ASSIST_REQUEST_MAX_AGE_MS ohne Erneuerung.
  const requests = new Map();
  const liveRequests = () => {
    const t = now();
    for (const [k, q] of requests) if (t > q.expiresAt) requests.delete(k);
    return paused() ? [] : [...requests.values()];
  };
  // Strengstes Ziel (W) der Anforderungen, null = keins. coverW wird gegen den
  // Bezug OHNE die eigene Akku-Hilfe gerechnet, damit das Ziel nicht wandert.
  function externalTargetW(meas = last.meas, battery = last.battery) {
    const list = liveRequests();
    if (!list.length) return null;
    const fresh = meas?.fresh === true && finite(meas.importW);
    // coverW = GESAMTE Abgabe des Akkus (wie §14a sie rechnet). Bezug ohne
    // Akku = Bezug + gemessene Entladung − gemessene Ladung — aus Messwerten,
    // nicht aus dem angefragten Sollwert (keine Phantom-Hilfe, Codex deefd37f, P2).
    const dis = Math.max(0, Number(battery?.dischargeW) || 0);
    const chg = Math.max(0, Number(battery?.chargeW) || 0);
    // Nur mit frischer Zähler- UND Akku-Messung neu rechnen; sonst das letzte
    // Ziel halten (eine fehlende Akku-Leistung als 0 ließe das Ziel wandern,
    // Codex a0118785, P2).
    const demand = fresh && battery?.batteryFresh === true ? Number(meas.importW) + dis - chg : null;
    const targets = list.map((q) => {
      if (q.maxImportW != null) return q.maxImportW;
      // Ohne frische Messung das letzte Ziel halten — die Hilfe bleibt stehen
      // statt zurückzufallen (Codex 7a44bb81, P2).
      if (demand != null) q.lastTargetW = Math.max(0, demand - q.coverW);
      return q.lastTargetW ?? null;
    });
    return smallestLimit(targets);
  }
  // Wirksame Decke für positive Netz-Sollwerte: Netzanschluss und Anforderungen.
  function ceilingNow() {
    if (paused()) return null;
    const r = gridConnectionFromState(cfg(), state(), now());
    if (!r.batterySupported) return null;
    const grid = r.active ? st.ceilingW ?? r.ceilingTargetW ?? r.targetW : null;
    const ext = externalTargetW();
    const ceiling = smallestLimit([grid, ext == null ? null : down(ext)]);
    return ceiling == null ? null : Math.max(0, ceiling);
  }
  const SOURCE_LABEL = { p14a: '§14a', 'eos-threshold': 'EOS-Schwelle' };
  // Schwellen-Peak-Shaving aus dem EOS-Plan (schedule-eval →
  // services/optimizer/eos-threshold-assist.js, state.ctrl.eosThreshold) für die
  // Kachel: „EOS: Akku deckt über X kW“. Im Not-Halt nichts.
  function eosThresholdInfo() {
    const e = state()?.ctrl?.eosThreshold;
    if (paused() || !e || !finite(e.thresholdW)) return null;
    return { thresholdW: e.thresholdW, requested: e.requested === true, coveredBy: e.coveredBy ?? null, reason: e.reason ?? null };
  }
  // Kachel ohne Netzanschluss-Grenze, solange eine andere Quelle (§14a)
  // Akku-Hilfe anfordert; sonst keine Kachel.
  function assistOnlySummary(r) {
    const list = liveRequests();
    if (!list.length && !st.assist) return null;
    const meas = last.meas;
    const bat = last.battery || {};
    const disW = Math.max(0, Math.round(Number(bat.dischargeW) || 0));
    const assist = paused() ? null
      : st.assist ? { valueW: st.assist.valueW, baseW: st.assist.baseW, since: st.assist.since, helpW: Math.max(0, disW - Math.max(0, st.assist.baseW)) }
        : (r.battery.kind !== 'none' && disW > 0 ? { valueW: null, baseW: null, since: null, helpW: disW } : null);
    const names = list.map((q) => SOURCE_LABEL[q.source] || q.source);
    const who = names.join(', ') || 'Akku-Hilfe';
    const text = paused() ? 'Not-Halt aktiv — DVhub greift nicht ein.'
      : assist ? `${who}: Akku hilft mit ${kwText(assist.helpW)}${assist.valueW != null ? ` (Entladegrenze ${kwText(assist.valueW)} statt ${assist.baseW === -1 ? 'unbegrenzt' : kwText(assist.baseW)})` : ' (über den Netz-Sollwert)'}`
        : `${who}: Akku-Hilfe angefordert`;
    return {
      enabled: true, active: false, reason: r.reason, assistOnly: true,
      limitW: null, limitSource: null, limitText: null, victronReadError: false,
      marginW: null, marginText: null, targetW: externalTargetW(), phaseLimitA: null, phaseLimitW: null,
      importW: meas?.fresh ? Math.max(0, Math.round(meas.importW)) : null, phasesW: null,
      failsafe: false, paused: paused(), exhausted: false,
      batterySupported: r.batterySupported, battery: r.battery, assist, assistSources: list.map((q) => q.source),
      eosThreshold: eosThresholdInfo(),
      ceilingW: null, clamp: null, caps: [], acting: Boolean(assist), text
    };
  }

  const batteryAssist = {
    /**
     * Akku-Hilfe anfordern bzw. erneuern.
     * @param {{source:string, maxImportW?:number, coverW?:number}} q
     * @returns {{ok:boolean, kind?:string, reason?:string}}
     */
    request(q = {}) {
      const source = typeof q.source === 'string' ? q.source.trim() : '';
      if (!source || source === 'grid-connection') return { ok: false, reason: 'invalid_source', acceptedW: 0 };
      // coverW 0 = Freigabe (Vertrag §14a) — gilt immer, auch im Not-Halt.
      if (q.coverW !== undefined && q.coverW !== null && Number(q.coverW) === 0 && q.maxImportW == null) {
        requests.delete(source);
        return { ok: true, acceptedW: 0 };
      }
      const hasMax = finite(q.maxImportW) && Number(q.maxImportW) >= 0;
      const hasCover = finite(q.coverW) && Number(q.coverW) > 0;
      if (hasMax === hasCover) return { ok: false, reason: 'invalid_request', acceptedW: 0 };
      // untilMs (Ablauf der Vorgabe, ms seit 1970) ersetzt die feste Frist.
      const until = finite(q.untilMs) && Number(q.untilMs) > 0 ? Number(q.untilMs) : null;
      if (until != null && until <= now()) return { ok: false, reason: 'expired', acceptedW: 0 };
      if (paused()) return { ok: false, reason: 'emergency_stop', acceptedW: 0 };
      const c = cfg();
      const r = gridConnectionFromState(c, state(), now());
      if (r.battery.kind === 'none') return { ok: false, kind: 'none', reason: 'battery_not_steerable', acceptedW: 0 };
      const before = ceilingNow();
      const t = now();
      requests.set(source, {
        source, maxImportW: hasMax ? Math.round(Number(q.maxImportW)) : null,
        coverW: hasCover ? Math.round(Number(q.coverW)) : null, at: t,
        expiresAt: until ?? t + ASSIST_REQUEST_MAX_AGE_MS,
        lastTargetW: requests.get(source)?.lastTargetW ?? null
      });
      // Decke gesunken: laufenden Sollwert sofort neu durch den Steuerpfad.
      const after = ceilingNow();
      if (after != null && (before == null || after < before)) reassertSetpoint();
      // Zusage: höchstens die Entladeleistung (Akku bzw. Wechselrichter).
      const limits = getPowerLimits(c).limits;
      const maxW = Math.min(Number(limits.batteryMaxDischargeDcW) || 0, Number(limits.inverterMaxPowerW) || 0, MAX_BATTERY_DISCHARGE_W);
      return { ok: true, kind: r.battery.kind, acceptedW: hasCover ? Math.min(Math.round(Number(q.coverW)), maxW) : null };
    },
    /** Anforderung zurücknehmen; der Regelkreis senkt die Hilfe in Stufen. */
    release(source) {
      return { ok: requests.delete(String(source || '').trim()) };
    },
    /**
     * Rückmeldung für die Kürzungslogik der Quellen: targetW = strengstes Ziel
     * (inkl. Netzanschluss), helpW = gemessene Entladung des Akkus (W).
     */
    status(source = null) {
      const r = gridConnectionFromState(cfg(), state(), now());
      const list = liveRequests();
      const own = source ? list.find((q) => q.source === source) || null : null;
      const ext = externalTargetW();
      const targetW = smallestLimit([r.active ? r.targetW : null, ext]);
      const bat = last.battery || {};
      const helpW = paused() ? 0 : Math.max(0, Math.round(Number(bat.dischargeW) || 0));
      return {
        kind: r.battery.kind,
        paused: paused(),
        // Mit Quelle: ihre Anforderung gilt. Ohne: irgendeine Anforderung gilt
        // oder die Entladegrenze ist gerade angehoben.
        active: !paused() && r.battery.kind !== 'none' && (source ? own != null : (st.assist != null || list.length > 0)),
        targetW,
        // Ziel des Netzanschluss-Wächters allein (null = keine Grenze): Quellen
        // mit derselben Grenze (EOS-Schwelle) sparen sich dann die Anforderung.
        gridTargetW: r.active && !paused() ? r.targetW : null,
        sourceTargetW: own ? (own.maxImportW ?? null) : null,
        helpW,
        valueW: st.assist?.valueW ?? null,
        sources: list.map((q) => ({ source: q.source, maxImportW: q.maxImportW, coverW: q.coverW, at: q.at, expiresAt: q.expiresAt }))
      };
    }
  };

  return {
    /** Je Zählerabfrage (polling.js). */
    pollTick: tick,
    tick,
    start() {
      if (timer) return;
      // Rückfalltakt: hängt die Zählerabfrage selbst, greift der Fail-safe trotzdem.
      timer = safeInterval('grid-connection.fallback', () => {
        if (now() - lastTickAt >= FALLBACK_TICK_MS - 500) tick();
      }, FALLBACK_TICK_MS);
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    /** Decke für positive Netz-Sollwerte (W) oder null (keine Grenze / kein Victron). */
    batteryCeilingW() {
      return ceilingNow();
    },
    /** Akku zuerst für mehrere Quellen (ctx.batteryAssist, server.js). */
    batteryAssist,
    /**
     * Untergrenze für die Entladegrenze (W) während der Akku-Hilfe, sonst null.
     * schedule-eval.js hebt Vorgaben anderer Quellen darunter auf diesen Wert.
     */
    dischargeFloorW() {
      if (paused() || !st.assist) return null;
      return st.assist.valueW;
    },
    /**
     * Rückkehrwert der Entladegrenze aus dem Merker des letzten Laufs (W), so
     * lange er aussteht — sonst null. Beleg für das Not-Halt-Tor nach einem
     * Neustart (schedule-eval.js, Fable R1 P2-7).
     */
    persistedRestoreW() {
      return st.assistRestore?.fromDisk === true && !st.assist ? st.assistRestore.valueW : null;
    },
    /** Grenze eines Geräts (W), null = frei. */
    capW(id) {
      if (!active()) return null;
      const w = st.caps[id];
      return w == null ? null : w;
    },
    /** Grenzen aller EEBUS-Geräte (id → W). */
    eebusCaps() {
      if (!active()) return {};
      return Object.fromEntries(Object.entries(st.caps).filter(([id]) => id.startsWith('eebus:')));
    },
    summary() {
      const c = cfg();
      const r = gridConnectionFromState(c, state(), now());
      if (r.reason === 'not_set' && !r.victronReadError) return assistOnlySummary(r);
      const s = state();
      const t = now();
      const meas = last.meas;
      const clampRaw = s.ctrl?._gridConnection?.clamp;
      const clamp = clampRaw && t - Number(clampRaw.at || 0) <= CLAMP_FRESH_MS
        ? { requestedW: clampRaw.requestedW, valueW: clampRaw.valueW, source: clampRaw.source } : null;
      const caps = last.devices
        .filter((d) => st.caps[d.id] != null)
        .map((d) => ({ id: d.id, kind: d.kind, name: d.name || null, capW: st.caps[d.id], currentW: finite(d.currentW) ? Math.round(d.currentW) : null }));
      const parts = [];
      // Akku-Hilfe: was der Akku gerade über die Grenze davor hinaus abgibt.
      const bat = last.battery || {};
      const assist = st.assist && !paused()
        ? {
          valueW: st.assist.valueW, baseW: st.assist.baseW, since: st.assist.since,
          helpW: Math.max(0, Math.round((Number(bat.dischargeW) || 0) - Math.max(0, st.assist.baseW)))
        }
        : null;
      if (assist) parts.push(`Akku hilft mit ${kwText(assist.helpW)} (Entladegrenze ${kwText(assist.valueW)} statt ${assist.baseW === -1 ? 'unbegrenzt' : kwText(assist.baseW)})`);
      if (clamp) parts.push(`begrenzt Akku-Ladung auf ${kwText(clamp.valueW)}`);
      for (const cp of caps) parts.push(cp.capW === 0 ? `${cp.name || KIND_LABEL[cp.kind]} pausiert` : `begrenzt ${cp.name || KIND_LABEL[cp.kind]} auf ${kwText(cp.capW)}`);
      const text = paused() ? 'Netzanschluss: Not-Halt aktiv — DVhub greift nicht ein.'
        : !r.active && r.reason === 'not_set' && r.victronReadError ? 'Netzanschluss: Victron-Grenze (Reg. 2714) nicht lesbar — DVhub regelt nicht.'
        : !r.active ? 'Netzanschluss: Grenze ungültig (2 kW bis 2 000 kW) — DVhub regelt nicht.'
        : st.failsafe ? 'Netzanschluss: Zähler gestört oder veraltet — DVhub gibt keine neue Last frei.'
          : parts.length ? `Netzanschluss: ${parts.join(' · ')}` : null;
      return {
        enabled: true,
        active: r.active,
        reason: r.reason,
        limitW: r.limitW,
        limitSource: r.limitSource,
        limitText: r.limitText,
        victronReadError: r.victronReadError,
        marginW: r.marginW,
        marginText: r.marginText,
        targetW: r.targetW,
        phaseLimitA: r.phaseLimitA,
        phaseLimitW: r.phaseLimitW,
        importW: meas?.fresh ? Math.max(0, Math.round(meas.importW)) : null,
        phasesW: meas?.fresh && meas.phasesW ? meas.phasesW.map((w) => Math.round(w)) : null,
        failsafe: st.failsafe,
        paused: paused(),
        exhausted: st.exhausted,
        batterySupported: r.batterySupported,
        battery: r.battery,
        assist,
        assistSources: liveRequests().map((q) => q.source),
        eosThreshold: eosThresholdInfo(),
        ceilingW: r.active && r.batterySupported ? st.ceilingW ?? r.ceilingTargetW ?? r.targetW : null,
        clamp,
        caps,
        acting: Boolean(clamp || caps.length || st.failsafe || assist),
        text
      };
    },
    _state: st
  };
}

/**
 * Grenze für die Wallbox (EOS-Brücke getGridCapW): §14a-Anteil und
 * Netzanschluss — die kleinste gilt, null = frei.
 */
export function wallboxGridCapW(p14aCapW, gridConnectionCapW) {
  return smallestLimit([p14aCapW, gridConnectionCapW]);
}

/** Deckel für applyControlTarget (schedule-eval.js): senkt nur positive Sollwerte. */
export function capSetpointToGridConnection(value, ceilingW) {
  return capPositiveSetpoint(value, ceilingW);
}
