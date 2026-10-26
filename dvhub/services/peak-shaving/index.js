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
