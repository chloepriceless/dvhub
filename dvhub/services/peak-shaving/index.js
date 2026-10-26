// services/peak-shaving/index.js — Peak Shaving: Netzbezug begrenzen (GitHub #28).
//
// Gewerbekunden mit Leistungsmessung (RLM) zahlen einen Leistungspreis
// (€/kW·a) auf die höchste Viertelstunden-Bezugsleistung im Jahr. Eine einzige
// Spitze verteuert die Netzentgelte für das ganze Jahr.
//
// v1 (Beta, nur Victron) — zwei Hebel, beide im Steuerpfad schedule-eval.js:
//
//   1. Sollwert-Deckel (applyControlTarget): ein POSITIVER gridSetpointW ist
//      bei Victron der gewünschte Netzbezug am Zähler. Liegt er über dem Ziel
//      (Grenze − Abstand), wird er gedeckelt. Damit lädt DVhub nie mehr aus dem
//      Netz, als die Grenze zulässt (Netzladen, EOS-„Akku halten“, manuelle
//      Werte), und bei „Akku halten“ deckt der Akku den Überschuss. Braucht der
//      Deckel den Akku (Ziel unter der gemessenen Netto-Last), muss der Ladestand
//      frisch und über dem Boden sein; sonst wird nur bis zur Netto-Last
//      gedeckelt (kein Entladen) bzw. bei unbekannter Last gar nicht.
//
//   2. Entlade-Freigabe (evaluateSchedule): ist die Akku-Entladung gesperrt
//      (maxDischargeW = 0, von DVhub geschrieben oder frisch zurückgelesen) und
//      liegt der gemessene Bezug über der Grenze, hebt DVhub die Sperre um den
//      Überschuss an; fällt der Bezug mit Abstand (Hysterese) wieder, wird die
//      Sperre (0) zurückgeschrieben.
//
// Alles andere bleibt unberührt: ohne `enabled`, ohne Beta-Kanal, ohne Grenze
// oder bei anderem Hersteller ist jeder Steuerwert bitgenau wie vorher.

import { betaGateOpen } from '../../beta-features.js';

export const PEAK_SHAVING_DEFAULTS = Object.freeze({
  enabled: false,
  gridImportLimitW: null,
  marginW: 300,
  releaseHysteresisW: 500,
  minSocPct: null
});

// Unter 1 kW ist eine Bezugsgrenze kein Gewerbe-Leistungspreis mehr, sondern
// ein Tippfehler (z. B. kW statt W) — dann lieber gar nicht regeln.
export const MIN_LIMIT_W = 1000;
const MAX_LIMIT_W = 10_000_000;

const finite = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

/**
 * Wirksame Einstellungen. `enabled` = Schalter UND Beta-Gate (test/beta-gate.test.js),
 * `active` = DVhub regelt wirklich (zusätzlich Grenze gültig und Victron).
 * @param {object} cfg  effektive DVhub-Config
 */
export function resolvePeakShaving(cfg = {}) {
  const c = cfg?.peakShaving || {};
  const flagOn = c.enabled === true;
  const gateOpen = betaGateOpen(cfg, 'peakShaving');
  const enabled = flagOn && gateOpen;
  const rawLimit = Number(c.gridImportLimitW);
  const configured = finite(c.gridImportLimitW) && rawLimit >= MIN_LIMIT_W && rawLimit <= MAX_LIMIT_W;
  const limitW = configured ? Math.round(rawLimit) : null;
  const manufacturer = String(cfg?.manufacturer || 'victron');
  const supported = manufacturer === 'victron';
  const marginRaw = finite(c.marginW) ? Number(c.marginW) : PEAK_SHAVING_DEFAULTS.marginW;
  const marginW = limitW == null ? Math.max(0, Math.round(marginRaw))
    : Math.min(Math.round(limitW / 2), Math.max(0, Math.round(marginRaw)));
  const hystRaw = finite(c.releaseHysteresisW) ? Number(c.releaseHysteresisW) : PEAK_SHAVING_DEFAULTS.releaseHysteresisW;
  const releaseHysteresisW = Math.max(0, Math.round(hystRaw));
  const minSocPct = finite(c.minSocPct) && Number(c.minSocPct) >= 0 && Number(c.minSocPct) <= 100
    ? Number(c.minSocPct) : null;
  const reason = !flagOn ? 'disabled'
    : !gateOpen ? 'beta_gate_closed'
      : !configured ? 'limit_missing'
        : !supported ? 'manufacturer_unsupported'
          : null;
  return {
    enabled,
    configured,
    supported,
    active: reason === null,
    manufacturer,
    limitW,
    marginW,
    targetW: limitW == null ? null : limitW - marginW,
    releaseHysteresisW,
    minSocPct,
    reason
  };
}

const STATUS_TEXT = {
  disabled: 'Peak Shaving ist aus.',
  beta_gate_closed: 'Peak Shaving ist eine Beta-Funktion und wirkt nur im Bleeding-Edge-Kanal.',
  limit_missing: 'Keine gültige Bezugsgrenze eingetragen (mindestens 1000 W) — DVhub regelt nicht.',
  manufacturer_unsupported: 'Peak Shaving regelt bisher nur Victron-Anlagen. Bei diesem Hersteller zeigt DVhub die Spitzen nur an.'
};

/** Kurzer deutscher Statustext zum Ergebnis von resolvePeakShaving(). */
export function peakShavingStatusText(resolved) {
  if (!resolved) return STATUS_TEXT.disabled;
  if (resolved.reason) return STATUS_TEXT[resolved.reason] || STATUS_TEXT.disabled;
  return `Bezugsgrenze ${resolved.limitW} W aktiv (Regelziel ${resolved.targetW} W).`;
}

// Messwerte, auf denen eine Peak-Shaving-Entscheidung beruhen darf. Strenger als
// T-0075: ein Feld OHNE Erfolgs-Zeitstempel gilt als unbekannt, nicht als frisch.
const METER_MAX_AGE_MS = 15_000;
const PV_FIELDS = ['pvPowerW', 'acPvL1W', 'acPvL2W', 'acPvL3W', 'acPv2L1W', 'acPv2L2W', 'acPv2L3W'];

function fieldAgeMs(state, field, now) {
  const at = Number(state?.victron?.fieldUpdatedAt?.[field] ?? 0);
  return at > 0 ? now - at : null;
}

/**
 * Lagebild aus state.victron/state.meter (rein lesend).
 * @returns {{ socOk: boolean, socReason: string|null, soc: number|null, floorPct: number,
 *   loadKnown: boolean, loadW: number|null, pvW: number, netLoadW: number|null,
 *   meterFresh: boolean, importW: number|null, batteryDischargeW: number }}
 */
export function peakShavingTelemetry(state, cfg, resolved, now = Date.now()) {
  const v = state?.victron || {};
  const maxAgeMs = Number(cfg?.victron?.telemetryMaxAgeMs ?? 90000);
  const fresh = (field) => {
    const age = fieldAgeMs(state, field, now);
    return age !== null && age <= maxAgeMs && !v.errors?.[field];
  };
  const floorPct = Math.max(Number(cfg?.optimizer?.hardFloorSocPct ?? 5) || 0, Number(resolved?.minSocPct ?? 0) || 0);
  const socRaw = v.soc;
  const soc = Number(socRaw);
  const socKnown = socRaw != null && socRaw !== '' && Number.isFinite(soc) && fresh('soc');
  const socReason = !socKnown ? 'soc_unknown'
    : v.freeze?.active === true ? 'telemetry_frozen'
      : v.sourceMismatch?.active === true ? 'source_mismatch'
        : soc <= floorPct ? 'soc_floor' : null;

  const loadRaw = v.selfConsumptionW;
  const loadKnown = loadRaw != null && loadRaw !== '' && Number.isFinite(Number(loadRaw)) && fresh('selfConsumptionW')
    && v.freeze?.active !== true && v.sourceMismatch?.active !== true;
  const loadW = loadKnown ? Math.max(0, Number(loadRaw)) : null;
  // PV mindert die Netto-Last nur, wenn sie frisch ist — eine hängengebliebene
  // hohe PV würde die Netto-Last zu klein und den Deckel zu tief machen.
  const pvOk = fresh('pvPowerW') && PV_FIELDS.every((f) => !v.errors?.[f]) && Number.isFinite(Number(v.pvTotalW));
  const pvW = pvOk ? Math.max(0, Number(v.pvTotalW)) : 0;

  const meter = state?.meter || {};
  const importRaw = v.gridImportW;
  const meterFresh = meter.ok === true && (now - Number(meter.updatedAt || 0)) < METER_MAX_AGE_MS
    && importRaw != null && Number.isFinite(Number(importRaw));
  return {
    socOk: socReason === null,
    socReason,
    soc: socKnown ? soc : null,
    floorPct,
    loadKnown,
    loadW,
    pvW,
    netLoadW: loadKnown ? Math.max(0, loadW - pvW) : null,
    meterFresh,
    importW: meterFresh ? Math.max(0, Number(importRaw)) : null,
    batteryDischargeW: Math.max(0, Number(v.batteryDischargeW) || 0)
  };
}

/**
 * Hebel 1 — Deckel auf einen positiven Netz-Sollwert (Victron: Netzbezug am Zähler).
 *   target    Ziel erreicht; ein Rest über der Netto-Last kommt aus dem Akku
 *             (Ladestand frisch und über dem Boden).
 *   net_load  Akku nicht nutzbar → nur bis zur Netto-Last: weniger Netzladen,
 *             aber kein Entladen.
 *   held      nichts Sicheres bekannt → Wert bleibt (Normalbetrieb).
 * Nie unter 0 (resolvePeakShaving hält das Ziel >= Grenze/2), nie nach oben.
 */
export function clampGridSetpoint(value, resolved, tel) {
  const v = Number(value);
  if (!resolved?.active || !Number.isFinite(v) || !(v > resolved.targetW)) {
    return { value, clamped: false, mode: null, reason: null };
  }
  if (tel?.socOk) return { value: resolved.targetW, clamped: true, mode: 'target', reason: null };
  if (tel?.loadKnown) {
    const floor = Math.max(resolved.targetW, Math.ceil(tel.netLoadW));
    if (floor < v) return { value: floor, clamped: true, mode: 'net_load', reason: tel.socReason };
    return { value, clamped: false, mode: 'held', reason: tel.socReason };
  }
  return { value, clamped: false, mode: 'held', reason: tel?.socReason || 'telemetry_unknown' };
}
