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
 * Beschreiben die konfigurierten Strings bereits die GANZE Anlage (beide WR)?
 *
 * M13 (Feld 16.11.): Im Detail-Modus (forecast.pv.configLevel === 'detailed' mit nicht-leerem
 * forecast.pv.strings) sind die Strings über BEIDE WR erfasst — totalKwp = String-Summe (von
 * migratePvTotalKwp synchron gehalten). Dann darf sungrow.secondInverter.pvKwp NICHT zusätzlich
 * addiert werden, sonst zählt der zweite WR doppelt (z. B. 24,2 + 11,88 = 36,08 statt 24,2).
 * Ohne Strings (simple/standard) beschreibt totalKwp nur den Master-WR → Zweit-WR addieren.
 */
export function stringsCoverWholePlant(cfg) {
  const pv = cfg?.forecast?.pv || {};
  return pv.configLevel === 'detailed' && Array.isArray(pv.strings) && pv.strings.length > 0;
}

/**
 * Effektive PV-Gesamtgröße (kWp) = Basis + PV des zweiten WR. baseKwp: schon berechnete Basis des Aufrufers
 * (z. B. totalKwp oder pvPlants-Summe); fehlt sie, leitet die Funktion sie aus forecast.pv ab.
 *
 * M13: Decken die Strings die ganze Anlage (beide WR) ab, ist die Basis die String-Summe und der
 * zweite WR wird NICHT addiert — unabhängig davon, ob der Aufrufer totalKwp als Basis durchreicht.
 */
export function effectivePvKwp(cfg, baseKwp = null) {
  const pv = cfg?.forecast?.pv || {};
  const wholePlant = stringsCoverWholePlant(cfg);
  let base = Number(baseKwp);
  if (!(Number.isFinite(base) && base > 0)) {
    if (wholePlant) {
      // Detail-Modus: Basis = String-Summe (ganze Anlage, beide WR).
      base = pv.strings.reduce((s, x) => s + (Number(x?.kwp) || 0), 0);
    } else {
      base = Number(pv.totalKwp);
      if (!(Number.isFinite(base) && base > 0) && Array.isArray(pv.strings)) base = pv.strings.reduce((s, x) => s + (Number(x?.kwp) || 0), 0);
      if (!(Number.isFinite(base) && base > 0) && Array.isArray(cfg?.userEnergyPricing?.pvPlants)) base = cfg.userEnergyPricing.pvPlants.reduce((s, p) => s + (Number(p?.kwp) || 0), 0);
    }
  }
  base = Number.isFinite(base) && base > 0 ? base : 0;
  // Zweit-WR nur addieren, wenn die Strings NICHT schon beide WR abdecken.
  const second = wholePlant ? 0 : secondInverterPvKwp(cfg);
  const total = Math.round((base + second) * 100) / 100;
  return total > 0 ? total : null;
}
