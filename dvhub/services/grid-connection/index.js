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
//      zuerst nach. Decke = Grenze − Sicherheitsabstand, mit Phasengrenze
//      zusätzlich so tief, dass die stärkste Phase unter ihrer Grenze bleibt.
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
//      bei Grenze − Abstand − geschätzter Grundlast − diesen Geräten.
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
export const OBEY_MS = 20_000;           // so lange zählt ein Befehl als „unterwegs“
export const BATTERY_OBEY_MS = 10_000;   // so lange darf der Multi zum Senken seiner Ladung brauchen
export const BATTERY_TRACK_TOLERANCE_W = 300;   // übliches Einregeln des Multi um den Sollwert
export const BATTERY_STUCK_HOLD_MS = 15 * 60_000; // so lange gilt ein hängender Akku als hängend
export const FAILSAFE_TICKS = 2;         // Takte ohne frische Messung bis zum Fail-safe
export const METER_MAX_AGE_MS = GRID_SHARE_FIELD_MAX_AGE_MS; // 90 s wie beim Netzstrom-Zähler
const STEP_W = 100;
const FALLBACK_TICK_MS = 5000;
const CLAMP_FRESH_MS = 30_000;
const SETPOINT_MAX_AGE_MS = 120_000;

const finite = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const down = (w) => Math.floor(Number(w) / STEP_W) * STEP_W;

/**
 * Wirksame Einstellungen. Kein Beta-Gate: die Grenze schützt die Sicherungen.
 * active = Grenze gültig eingetragen.
 * @param {object} cfg effektive DVhub-Config
 */
export function resolveGridConnection(cfg = {}, { victronPhaseLimitA = null, victronReadError = false } = {}) {
  const c = cfg?.gridConnection || {};
  const dvSet = finite(c.limitKw) && Number(c.limitKw) > 0;
  const rawW = dvSet ? Number(c.limitKw) * 1000 : null;
  const dvValid = dvSet && rawW >= MIN_LIMIT_W && rawW <= MAX_LIMIT_W;
  const dvLimitW = dvValid ? Math.round(rawW) : null;
  // Victron (Punkt 7): Reg. 2714 AcInputLimit, A je Phase. kW-Grenze daraus =
  // Phasen × 230 V × A (dreiphasig angenommen). Es gilt die strengere.
  const vA = finite(victronPhaseLimitA) && Number(victronPhaseLimitA) >= 6 && Number(victronPhaseLimitA) <= 4000
    ? Number(victronPhaseLimitA) : null;
  const vLimitW = vA != null ? Math.round(VICTRON_ASSUMED_PHASES * NOMINAL_PHASE_VOLTAGE_V * vA) : null;
  const set = dvSet || vA != null;
  const valid = dvValid || vA != null;
  const limitW = smallestLimit([dvLimitW, vLimitW]);
  const limitSource = limitW == null ? null : (vLimitW != null && limitW === vLimitW && (dvLimitW == null || vLimitW < dvLimitW) ? 'victron' : 'dvhub');
  const autoMargin = limitW == null ? AUTO_MARGIN_MIN_W
    : Math.max(AUTO_MARGIN_MIN_W, Math.round(limitW * AUTO_MARGIN_PCT / 100));
  const marginRaw = finite(c.marginW) && Number(c.marginW) >= 0 ? Math.round(Number(c.marginW)) : autoMargin;
  const marginW = limitW == null ? marginRaw : Math.min(Math.round(limitW / 2), marginRaw);
  const targetW = limitW == null ? null : limitW - marginW;

  const dvPhaseA = finite(c.phaseLimitA) && Number(c.phaseLimitA) >= 6 && Number(c.phaseLimitA) <= 4000
    ? Number(c.phaseLimitA) : null;
  const phaseA = smallestLimit([dvPhaseA, vA]);
  const phaseLimitW = limitW != null && phaseA != null ? Math.round(phaseA * NOMINAL_PHASE_VOLTAGE_V) : null;
  const phaseMarginW = phaseLimitW == null ? null : Math.min(Math.round(phaseLimitW / 2), Math.round(marginW / 3));
  const phaseTargetW = phaseLimitW == null ? null : phaseLimitW - phaseMarginW;

  const releaseHysteresisW = finite(c.releaseHysteresisW) && Number(c.releaseHysteresisW) >= 0
    ? Math.round(Number(c.releaseHysteresisW)) : GRID_CONNECTION_DEFAULTS.releaseHysteresisW;
  const baseRaw = finite(c.baseLoadW) && Number(c.baseLoadW) >= 0
    ? Math.round(Number(c.baseLoadW)) : GRID_CONNECTION_DEFAULTS.baseLoadW;
  const baseLoadW = targetW == null ? baseRaw : Math.min(baseRaw, targetW);
  const orderKey = ORDER_PRESETS[c.order] ? c.order : GRID_CONNECTION_DEFAULTS.order;
  const batteryPhases = ['three', 'L1', 'L2', 'L3'].includes(c.batteryPhases) ? c.batteryPhases : null;
  const manufacturer = String(cfg?.manufacturer || 'victron');
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
    marginW,
    targetW,
    phaseLimitA: limitW != null ? phaseA : null,
    phaseLimitW,
    phaseMarginW,
    phaseTargetW,
    releaseHysteresisW,
    baseLoadW,
    orderKey,
    order: ORDER_PRESETS[orderKey],
    batteryPhases,
    manufacturer,
    // Akku-Hebel = positiver Netz-Sollwert als Bezug am Zähler (Victron ESS).
    batterySupported: manufacturer === 'victron'
  };
}

/**
 * Behelf für ein EOS ohne eigene Bezugsgrenze (Vanilla v0.4.0rc3 bei Kunden);
 * kennt EOS max_grid_import_power_w, entfällt er (eos-config-sync.js):
 * Höchste Akku-Ladeleistung AUS DEM NETZ, mit der EOS planen darf. Bewusst
 * konservativ — Grenze − Abstand − geschätzte Grundlast und, wenn EOS das
 * E-Auto mitplant, dessen volle Ladeleistung (EOS darf beides in denselben
 * Slot legen). null = keine Grenze eingetragen. Wird durch eine EOS-eigene
 * Netzbezugs-Grenze ersetzt, sobald es die gibt.
 */
export function eosGridChargeCapW(cfg, extra = {}) {
  const r = resolveGridConnection(cfg, extra);
  if (!r.active) return null;
  const opt = cfg?.optimizer || {};
  const evW = opt.eosOptimizeEv === true ? Math.max(0, Number(opt.evMaxChargeW) || 5000) : 0;
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

/** Victron-Grenze aus dem Zustand: A je Phase oder null (aus, -1, veraltet). */
export function victronLimitExtra(state, now = Date.now(), cfg = null) {
  // Nur mit dem Victron-Profil (Standard) — ein gemerkter GX-Wert gilt nach
  // einem Profilwechsel nicht weiter.
  if (cfg && String(cfg.manufacturer || 'victron') !== 'victron') return { victronPhaseLimitA: null, victronReadError: false };
  const v = state?.victron || {};
  const at = Number(v.fieldUpdatedAt?.acInputLimitA) || 0;
  const a = Number(v.acInputLimitA);
  const fresh = at > 0 && now - at <= VICTRON_LIMIT_MAX_AGE_MS;
  const error = Boolean(v.errors?.acInputLimitA);
  return {
    // Letzte Lesung gescheitert: der gemerkte Wert gilt nicht weiter.
    victronPhaseLimitA: fresh && !error && a > 0 ? a : null,
    victronReadError: error,
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
    failsafe: false, exhausted: false, phasesMissing: false
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
 * @param {{setpointW?:number|null, chargeW?:number|null}} [p.battery]
 *   zuletzt geschriebener Netz-Sollwert und aktuelle Akku-Ladeleistung
 * @param {number} p.now
 * @returns {{ events: object[], changed: Set<string>, ceilingTightened: boolean }}
 *   changed enthält die Gerätearten, deren Grenze sich geändert hat, und 'ceiling'.
 */
export function guardStep(st, { resolved: r, meas, devices = [], battery = {}, now }) {
  const events = [];
  const capsBefore = { ...st.caps };
  const ceilingBefore = st.ceilingW;
  const finish = () => {
    const changed = new Set();
    const ids = new Set([...Object.keys(capsBefore), ...Object.keys(st.caps)]);
    for (const id of ids) {
      if ((capsBefore[id] ?? null) !== (st.caps[id] ?? null)) changed.add(kindOf(id, devices));
    }
    if (ceilingBefore !== st.ceilingW) changed.add('ceiling');
    const ceilingTightened = st.ceilingW != null && (ceilingBefore == null || st.ceilingW < ceilingBefore);
    return { events, changed, ceilingTightened };
  };
  const setCap = (d, w) => { st.caps[d.id] = w; st.capAt[d.id] = now; };

  if (!r?.active) {
    if (Object.keys(st.caps).length || st.ceilingW != null || st.failsafe) events.push({ type: 'off', reason: r?.reason ?? 'not_set' });
    Object.assign(st, createGuardState());
    return finish();
  }
  // Geräte, die es nicht mehr gibt (abgemeldet, ausgeschaltet): Grenze vergessen.
  const ids = new Set(devices.map((d) => d.id));
  for (const id of Object.keys(st.caps)) {
    if (!ids.has(id)) { delete st.caps[id]; delete st.capAt[id]; }
  }
  if (st.ceilingW == null || st.ceilingW > r.targetW) st.ceilingW = r.targetW;

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
      const cur = finite(d.currentW) ? Math.max(0, Number(d.currentW)) : 0;
      const cap = st.caps[d.id] ?? null;
      // Auf 100 W aufrunden: ein laufendes Gerät soll durch das Einfrieren
      // nicht umgestellt werden (z. B. 16 A → 15,9 A), nur nicht mehr steigen.
      const curUp = Math.ceil(cur / STEP_W) * STEP_W;
      const next = cap == null ? curUp : Math.min(cap, curUp);
      if (cap == null || next < cap) setCap(d, next);
      frozenW += st.caps[d.id];
    }
    const fsCeiling = down(Math.max(0, r.targetW - r.baseLoadW - frozenW));
    if (fsCeiling < st.ceilingW) st.ceilingW = fsCeiling;
    return finish();
  }
  st.stale = 0;
  if (st.failsafe) {
    st.failsafe = false;
    events.push({ type: 'failsafe_off' });
  }

  // Geräte, die gehalten werden müssen, bis Luft für ihre volle Leistung ist
  // (ausstehende evcc-Rückkehr: evcc regelt danach selbst) — Grenze 0, einmal
  // je Halten; freigegeben wird über die normale Freigabe (Codex b6ebd4b4, P1).
  st.holdReleased ??= {};
  for (const d of devices) {
    if (!d.hold) { delete st.holdReleased[d.id]; continue; }
    if (st.caps[d.id] == null && !st.holdReleased[d.id]) {
      setCap(d, 0);
      events.push({ type: 'hold', id: d.id, kind: d.kind, name: d.name || null });
    }
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
  const phaseExcess = phases ? 3 * (maxPhase - r.phaseTargetW) : null;
  const excess = Math.max(total - r.targetW, phaseExcess ?? -Infinity);
  const hard = total > r.limitW || (phases != null && maxPhase > r.phaseLimitW);

  // --- 1. Akku: Decke für positive Netz-Sollwerte ------------------------------
  const desired = phaseExcess == null ? r.targetW : Math.min(r.targetW, total - phaseExcess);
  if (desired < st.ceilingW) {
    st.ceilingW = down(Math.max(0, desired));
    st.ceilingUnderSince = null;
  } else if (st.ceilingW < r.targetW) {
    // Luft: entweder Rückschalt-Abstand über der Decke, oder die volle Decke
    // (Ziel) ist erreichbar — sonst erholte sich eine kleine Absenkung nie
    // (Gesamtprüfung, P2).
    const roomy = desired >= st.ceilingW + r.releaseHysteresisW || desired >= r.targetW;
    if (!roomy) st.ceilingUnderSince = null;
    else st.ceilingUnderSince ??= now;
    if (st.ceilingUnderSince != null && now - st.ceilingUnderSince >= RELEASE_MS) {
      // Begrenzt nur das Gesamtziel (keine Phase drückt), zurück aufs Ziel;
      // sonst mit Rückschalt-Abstand unter dem, was die Phase zulässt.
      const raised = desired >= r.targetW ? r.targetW : down(desired - r.releaseHysteresisW);
      st.ceilingW = Math.min(r.targetW, Math.max(st.ceilingW, raised));
      st.ceilingUnderSince = null;
    }
  }

  // Was gleich ohnehin wegfällt: Geräte mit frischem Befehl, die noch über ihrer
  // Grenze liegen, und die Akku-Ladung, die der Multi auf den Sollwert senkt.
  let pending = 0;
  for (const d of devices) {
    const cap = st.caps[d.id];
    if (cap == null || now - (st.capAt[d.id] || 0) > OBEY_MS) continue;
    // Ohne Leistungsmeldung: die beim Kürzen angenommene Leistung zählt.
    const cur = finite(d.currentW) ? Number(d.currentW) : Number(st.assumed?.[d.id] ?? cap);
    pending += Math.max(0, cur - cap);
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
  }
  // Über der harten Grenze zählt die Frist immer — auch innerhalb der
  // Einregel-Toleranz (kleiner Sicherheitsabstand; Codex 184bcdcf, P2).
  if ((gap > BATTERY_TRACK_TOLERANCE_W || hard) && batteryPending > 0 && excess > 0) {
    st.batteryPendingSince ??= now;
    if (st.batteryStuckAt == null && now - st.batteryPendingSince > BATTERY_OBEY_MS) st.batteryStuckAt = now;
  } else {
    st.batteryPendingSince = null;
  }
  const batteryStuck = st.batteryStuckAt != null;
  if (!batteryStuck) pending += batteryPending;
  const predicted = excess - pending;

  // --- 2. Lasten zurücknehmen --------------------------------------------------
  st.over = predicted > 0 ? st.over + 1 : 0;
  if (predicted > 0 && (st.over >= ENTER_TICKS || hard)) {
    let rest = predicted;
    for (const kind of r.order) {
      for (const d of devices.filter((x) => x.kind === kind)) {
        if (rest <= 0) break;
        const cap = st.caps[d.id] ?? null;
        // Ohne Leistungsmeldung: vorsichtig annehmen, dass es seine Grenze bzw.
        // Höchstleistung zieht — sonst bliebe ein steuerbares Gerät bei
        // Überlast unbegrenzt (Gesamtprüfung 6, P1).
        const cur = finite(d.currentW) ? Math.max(0, Number(d.currentW)) : (cap ?? (Number(d.maxW) || 0));
        const draw = cap == null ? cur : Math.min(cur, cap);
        if (draw <= 0) continue;
        let next = Math.max(0, down(draw - rest));
        if (next < (Number(d.minW) || 0)) next = 0;
        if (cap != null && next >= cap) continue;
        setCap(d, next);
        if (!finite(d.currentW)) (st.assumed ??= {})[d.id] = draw;
        // Leistung vor dem ersten Eingriff (für die volle Freigabe).
        (st.cutFrom ??= {})[d.id] = Math.max(Number(st.cutFrom[d.id]) || 0, draw);
        rest -= draw - next;
        events.push({ type: 'cut', id: d.id, kind: d.kind, name: d.name || null, fromW: Math.round(draw), capW: next, importW: Math.round(total), maxPhaseW: maxPhase == null ? null : Math.round(maxPhase), excessW: Math.round(excess) });
      }
    }
    st.over = 0;
    st.underSince = null;
    st.lastCutAt = now;
    if (rest > 0 && !st.exhausted) {
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
  const phaseLimitEach = phases ? r.phaseTargetW - Math.round(r.releaseHysteresisW / 3) : null;
  const phaseFits = (x, devPhases) => {
    if (!phases) return true;
    const relief = r.batteryPhases ? Math.min(batteryYields, x) : 0;
    const rel = r.batteryPhases === 'three' ? [relief / 3, relief / 3, relief / 3]
      : ['L1', 'L2', 'L3'].map((l) => (l === r.batteryPhases ? relief : 0));
    const placements = devPhases === 3 ? [[x / 3, x / 3, x / 3]] : [[x, 0, 0], [0, x, 0], [0, 0, x]];
    return placements.every((add) => phases.every((p, i) => p + add[i] - rel[i] <= phaseLimitEach));
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
  const phasesRoomy = !phases || capped.some((d) => maxFit(giveNow, Number(d.phases) === 3 ? 3 : 1) >= Math.max(STEP_W, Number(d.minW) || 0));
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
      const fullW = Math.max(Number(d.maxW) || 0, Number(st.cutFrom?.[d.id]) || 0);
      // Phasen: ein einphasiges (oder unbekanntes) Gerät darf höchstens die Luft
      // EINER Phase nehmen, ein dreiphasiges das Dreifache (Gesamtprüfung 6, P1).
      const devPhases = Number(d.phases) === 3 ? 3 : 1;
      const giveDev = maxFit(give, devPhases);
      if (!(giveDev > 0)) continue;
      // Pausiert und zu wenig Luft für den Mindeststrom: nicht anlaufen lassen.
      if (drawNow === 0 && giveDev < (Number(d.minW) || 0)) continue;
      const next = Math.max(cap, drawNow + giveDev);
      // Gerundet ohne Zuwachs: Schritt nicht verbrauchen, nächstes Gerät
      // (Codex 7055aa8c, P2).
      if (drawNow + giveDev < fullW && down(next) <= cap) continue;
      if (st.assumed) delete st.assumed[d.id];
      if (!(fullW > 0) || (drawNow + giveDev) >= fullW) {
        delete st.caps[d.id];
        delete st.capAt[d.id];
        if (st.cutFrom) delete st.cutFrom[d.id];
        if (d.hold) (st.holdReleased ??= {})[d.id] = true;
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

function kindOf(id, devices) {
  const d = devices.find((x) => x.id === id);
  if (d) return d.kind;
  if (id === 'wallbox') return 'wallbox';
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
    // Wallbox: über die EOS-Brücke (evcc oder direkt, mit Pro) oder eine direkt
    // angebundene Box. evcc ohne EOS-Steuerung steuert DVhub nicht.
    // „Sofort laden“ läuft auch ohne EOS-Weitergabe über die Brücke und hält
    // deren Grenze ein (Codex b2f1ccd, P1).
    const override = ctx.eosEvccBridge?.getOverride?.();
    const overrideCharging = override != null && override.kind !== 'stop';
    const viaBridge = (bc.enabled || overrideCharging) && ctx.licenseService?.isProActive?.() !== false;
    // Steht eine evcc-Rückkehr aus, bleibt die Wallbox eingeschrieben: zurück
    // erst, wenn der Wächter sie über Abstand und Rückschalt-Prüfung ganz
    // freigibt (danach regelt evcc selbst — bis zu 32 A je Phase angenommen).
    const restorePending = ctx.eosEvccBridge?.hasPendingRestore?.() === true;
    const direct = bc.charger !== 'evcc' && directWallboxConfigured(c);
    if ((viaBridge || direct || restorePending) && ctx.eosEvccBridge) {
      // Höchstleistung nach der Freigabe: über die EOS-Brücke höchstens das, was
      // der Plan schickt (evMaxChargeW); eine direkte Box ohne Weitergabe regelt
      // danach selbst — bis zu ihrem Nennstrom (vorsichtig 32 A je Phase).
      const releaseW = viaBridge ? bc.maxChargeW : Math.max(bc.maxChargeW, Math.round(32 * 230 * bc.phases));
      list.push({ id: 'wallbox', kind: 'wallbox', name: 'Wallbox', currentW: wallboxPowerW(c, bc), maxW: releaseW, minW: minChargeW(bc), phases: bc.phases, hold: restorePending && !viaBridge });
    }
    if (ctx.mypvRegulator) {
      let heaters;
      try { heaters = loadSchedulableDevices(c).devices; } catch { heaters = []; }
      const status = ctx.mypvRegulator.getStatus?.() || {};
      for (const h of heaters) {
        if (h.enabled === false || h.kind !== 'modulating' || h.endpoint?.type !== 'mypv') continue;
        const s = status[h.id] || {};
        const cur = finite(s.powerW) ? Number(s.powerW) : (finite(s.setpointW) ? Number(s.setpointW) : null);
        list.push({ id: `heater:${h.id}`, kind: 'heater', name: h.name || 'Heizstab', currentW: cur, maxW: Number(h.plan?.maxPowerW) || null, minW: Number(h.plan?.minPowerW) || 0 });
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

  function batteryInput(c) {
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
    return { setpointW, chargeW };
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
    if (!lw || !req || !(Number(lw.value) > st.ceilingW) || req.source !== lw.source) return;
    if (now() - (Number(lw.at) || 0) > SETPOINT_MAX_AGE_MS) return;
    Promise.resolve(ctx.applyControlTarget?.('gridSetpointW', req.requestedW, req.source))
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
        Object.assign(st, createGuardState());
        log('grid_connection_paused', { text: 'Not-Halt aktiv — der Netzanschluss-Wächter greift nicht ein.' }, 'warn');
      }
      return null;
    }
    pausedSeen = false;
    try {
      const c = cfg();
      const r = gridConnectionFromState(c, state(), now());
      // Wirksame Grenze geändert (z. B. Victron-Wert 2714 umgestellt): EOS neu
      // abgleichen, höchstens jede Minute. Victron-Wert nicht lesbar: melden.
      const limitKey = `${r.limitW}|${r.phaseLimitA}`;
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
      if (r.victronReadError !== lastVictronError) {
        lastVictronError = r.victronReadError;
        if (r.victronReadError) log('grid_connection_victron_unreadable', { text: 'Victron-Bezugsgrenze (Reg. 2714) nicht lesbar — es gelten nur die DVhub-Werte.' }, 'warn');
      }
      const meas = r.active ? meterImport(state(), c, { now: lastTickAt, maxAgeMs: METER_MAX_AGE_MS }) : null;
      const list = r.active ? devices(c) : [];
      const res = guardStep(st, { resolved: r, meas, devices: list, battery: batteryInput(c), now: lastTickAt });
      last = { meas, devices: list };
      report(r, res.events);
      if (res.changed.size || res.ceilingTightened) enforce(res.changed, res.ceilingTightened);
      return res;
    } catch (e) {
      log('grid_connection_error', { error: e?.message || String(e) }, 'warn');
      return null;
    }
  }

  function active() { return !paused() && gridConnectionFromState(cfg(), state(), now()).active; }

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
      if (paused()) return null;
      const r = gridConnectionFromState(cfg(), state(), now());
      if (!r.active || !r.batterySupported) return null;
      return st.ceilingW ?? r.targetW;
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
      if (r.reason === 'not_set' && !r.victronReadError) return null;
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
      if (clamp) parts.push(`begrenzt Akku-Ladung auf ${kwText(clamp.valueW)}`);
      for (const cp of caps) parts.push(cp.capW === 0 ? `${cp.name || KIND_LABEL[cp.kind]} pausiert` : `begrenzt ${cp.name || KIND_LABEL[cp.kind]} auf ${kwText(cp.capW)}`);
      const text = paused() ? 'Netzanschluss: Not-Halt aktiv — DVhub greift nicht ein.'
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
        targetW: r.targetW,
        phaseLimitA: r.phaseLimitA,
        phaseLimitW: r.phaseLimitW,
        importW: meas?.fresh ? Math.max(0, Math.round(meas.importW)) : null,
        phasesW: meas?.fresh && meas.phasesW ? meas.phasesW.map((w) => Math.round(w)) : null,
        failsafe: st.failsafe,
        paused: paused(),
        exhausted: st.exhausted,
        batterySupported: r.batterySupported,
        ceilingW: r.active && r.batterySupported ? st.ceilingW ?? r.targetW : null,
        clamp,
        caps,
        acting: Boolean(clamp || caps.length || st.failsafe),
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
