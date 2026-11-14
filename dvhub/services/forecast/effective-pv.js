// services/forecast/effective-pv.js — effektive PV-Gesamtgröße (kWp) über BEIDE WR.
//
// Bei zwei Sungrow-WR im Parallelbetrieb trägt auch der zweite WR PV (sungrow.secondInverter.pvKwp). Diese EINE
// Funktion bündelt: die konfigurierte Gesamtgröße (forecast.pv.totalKwp bzw. String-/pvPlants-Summe) plus die
// PV am zweiten WR. Prognose, MiSpeL-kWp und Plausibilitätsprüfung nutzen sie, damit die Hilfe des Feldes
// „PV-Größe zweiter WR" auch im Code greift (Punkt 5).

/** PV am zweiten Sungrow-WR (kWp), wenn ein zweiter WR konfiguriert ist; sonst 0. */
export function secondInverterPvKwp(cfg) {
  if (cfg?.manufacturer !== 'sungrow') return 0;
  const si = cfg?.sungrow?.secondInverter;
  if (!si || !String(si.host || '').trim()) return 0;
  const k = Number(si.pvKwp);
  return Number.isFinite(k) && k > 0 ? k : 0;
}

/**
 * Effektive PV-Gesamtgröße (kWp) = Basis + PV des zweiten WR. baseKwp: schon berechnete Basis des Aufrufers
 * (z. B. totalKwp oder pvPlants-Summe); fehlt sie, leitet die Funktion sie aus forecast.pv ab.
 */
export function effectivePvKwp(cfg, baseKwp = null) {
  const pv = cfg?.forecast?.pv || {};
  let base = Number(baseKwp);
  if (!(Number.isFinite(base) && base > 0)) {
    base = Number(pv.totalKwp);
    if (!(Number.isFinite(base) && base > 0) && Array.isArray(pv.strings)) base = pv.strings.reduce((s, x) => s + (Number(x?.kwp) || 0), 0);
    if (!(Number.isFinite(base) && base > 0) && Array.isArray(cfg?.userEnergyPricing?.pvPlants)) base = cfg.userEnergyPricing.pvPlants.reduce((s, p) => s + (Number(p?.kwp) || 0), 0);
  }
  base = Number.isFinite(base) && base > 0 ? base : 0;
  const total = Math.round((base + secondInverterPvKwp(cfg)) * 100) / 100;
  return total > 0 ? total : null;
}
