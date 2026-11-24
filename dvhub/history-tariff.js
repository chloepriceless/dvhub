// history-tariff.js — Auswertung „dynamischer Tarif in der Historie“
// (Christin 23.11.2026; Konzept .planning/konzept/2026-11-23-dynamischer-tarif-historie.md).
//
// Reine Rechenfunktionen. history-runtime.js bewertet jede Viertelstunde
// (Endpreis p, Börse s, Mengen, Tarif) und füttert sie hier in Summen. Alle
// Summen sind addierbar und JSON-fest (kein Infinity/NaN), damit sie in der
// vorberechneten Jahres-Historie (Ablage) Monat für Monat weiterlaufen.
//
// Entscheidungen 23.11.2026:
//   T2   Prozent-Aufschlag aus den Daten: Fit p = a + b·s (kleinste Quadrate,
//        ungewichtet über die Viertelstunden), je Tarif/Zeitraum.
//   T10  … je §14a-Modul-3-Fenster, nur über s ≥ 0; negative Börse getrennt.
//   T3   Geschätzte Anbieter-Endpreise (Anbieterpreis fehlte, DVhub schätzte)
//        zählen mit; ihr Anteil wird gezeigt. Mit excludeEstimated lassen sich
//        Ø, Vergleich und Formel ohne sie rechnen (Schalter in der Historie).
//   T4   Einspeisewert X = Börse; die Marktprämie bleibt getrennt (kpis.marketPremiumEur).
//   T5   Grundgebühren tageweise, getrennt vom Ø-Arbeitspreis.
//   T6   Festpreis-Vergleich mit denselben Mengen.
//   T7   Karte „Eigenverbrauch bewertet“ zusätzlich zum Schalter „Marktwert“.

export const TARIFF_FIT_MIN_PAIRS = 16; // wie STATS_MIN_PAIRS (price-stats.js)
export const SCATTER_BIN_MIN_CT = -50;  // Klasse −50 = alles unter −49 ct
export const SCATTER_BIN_MAX_CT = 100;  // Klasse 100 = alles ab 100 ct
export const SCATTER_MAX_POINTS = 3000;

const round = (value, digits) => {
  const f = 10 ** digits;
  const r = Math.round((Number(value) + Number.EPSILON) * f) / f;
  return r === 0 ? 0 : r; // kein −0 in der Antwort
};
const round2 = (value) => round(value, 2);
const finite = (value) => value != null && value !== '' && Number.isFinite(Number(value));
const kwhOf = (value) => Math.max(Number(value) || 0, 0);
const ratio = (num, den, digits = 2) => (den > 0 ? round(num / den, digits) : null);

// ── Summen ────────────────────────────────────────────────────────────────

function createPart() {
  return {
    slots: 0,
    importKwh: 0,
    importCt: 0,      // Σ Bezug·p
    priceCtSum: 0,    // Σ p (zeitlicher Ø)
    spotKwh: 0,       // Bezug in Viertelstunden mit Börsenpreis
    spotCt: 0,        // Σ Bezug·s
    spotPriceCt: 0,   // Σ Bezug·p in denselben Viertelstunden
    houseKwh: 0,      // Netz direkt ins Haus
    houseCt: 0,
    batteryKwh: 0,    // Netz in den Akku (Akku 1 + 2)
    batteryCt: 0,
    cmpSlots: 0,
    cmpKwh: 0,
    cmpActualCt: 0,
    cmpFixedCt: 0,     // Σ Bezug·(F + δ): Festpreis mit §14a-Fenstern (T11)
    cmpBaseCt: 0,      // Σ Bezug·F: Festpreis ohne §14a
    cmpM3DeltaCt: 0,   // Σ Bezug·δ in verglichenen Viertelstunden
    // §14a Modul 3 (T11): Viertelstunden in einem aktiven Fenster.
    m3Slots: 0,
    m3Kwh: 0,
    m3DeltaCt: 0,      // Σ Bezug·δ (δ < 0 = Fenster günstiger)
    m3UnknownSlots: 0
  };
}

function createFee() {
  return {
    lastDate: null,
    days: 0, eur: 0, missingDays: 0,
    varDays: 0, varEur: 0, varMissingDays: 0,
    cmpDays: 0, cmpFixedEur: 0, cmpActualEur: 0, cmpMissingDays: 0
  };
}

function createFit() {
  return { n: 0, sx: 0, sy: 0, sxx: 0, sxy: 0, syy: 0, kwh: 0, mkMin: null, mkMax: null };
}

function createBin() {
  return { n: 0, kwh: 0, sumS: 0, sumP: 0, minP: null, maxP: null };
}

function createSelfUse() {
  return {
    slots: 0, skippedNoPriceSlots: 0, skippedNoFlowSlots: 0,
    loadKwh: 0, loadCt: 0, gridKwh: 0, gridCt: 0,
    loadMeasuredKwh: 0, loadMeasuredCt: 0,
    // T13 (Codex a7e86f28): nur eigene DC-Flüsse wandeln (VRM ist schon AC-normiert),
    // Akku→Netz bleibt gemessen; Kosten mit gemessener PV und getrennten Exporten.
    chargeGridLocalKwh: 0, chargeGridLocalCt: 0,
    pvMeasuredCt: 0, solarExportCt: 0, batteryExportCt: 0,
    // Eigene Entladung je Anteil Akku→Netz an der DC-Entladung (1-%-Klassen, Codex 013298c7):
    // ob der Entladeverlust dem Haus oder der Einspeisung fehlt, hängt an η Entladen.
    dischargeBins: {},
    pvDirectKwh: 0, pvDirectGainCt: 0,
    chargePvKwh: 0, chargeGridKwh: 0, chargeCostCt: 0, chargeGridCt: 0,
    dischargeHouseKwh: 0, dischargeGridKwh: 0, dischargeValueCt: 0,
    exportKwh: 0, exportCt: 0, pvKwh: 0, pvCt: 0
  };
}

/**
 * Laufende Summen. detail = true zusätzlich Formel-Gruppen, Klassen für das
 * Streudiagramm und die Eigenverbrauchs-Bewertung (nur für den ganzen
 * Zeitraum, nicht je Zeile).
 */
export function createTariffSums({ detail = false, withFee = true } = {}) {
  const sums = {
    variableSlots: 0,
    unpricedSlots: 0,
    allImportKwh: 0,  // alle Tarife, bekannter Preis
    allImportCt: 0,
    real: createPart(),
    est: createPart(),
    // Viertelstunden-Zeilen (Tagesansicht) tragen keine Tagesgebühr (Codex 39d05c79).
    fee: withFee ? createFee() : null
  };
  if (detail) {
    sums.groups = {};
    sums.bins = {};
    sums.selfUse = createSelfUse();
  }
  return sums;
}

function addFit(fit, s, p, kwh) {
  fit.n += 1;
  fit.sx += s;
  fit.sy += p;
  fit.sxx += s * s;
  fit.sxy += s * p;
  fit.syy += p * p;
  fit.kwh += kwh;
  const markup = p - s;
  fit.mkMin = fit.mkMin == null ? markup : Math.min(fit.mkMin, markup);
  fit.mkMax = fit.mkMax == null ? markup : Math.max(fit.mkMax, markup);
}

export function scatterBinIndex(spotCt) {
  return Math.min(SCATTER_BIN_MAX_CT, Math.max(SCATTER_BIN_MIN_CT, Math.floor(spotCt)));
}

function addBin(bin, s, p, kwh) {
  bin.n += 1;
  bin.kwh += kwh;
  bin.sumS += s;
  bin.sumP += p;
  bin.minP = bin.minP == null ? p : Math.min(bin.minP, p);
  bin.maxP = bin.maxP == null ? p : Math.max(bin.maxP, p);
}

function addFee(fee, slot) {
  const date = slot.tariffDate;
  if (!date || fee.lastDate === date) return;
  // Viertelstunden kommen zeitlich sortiert; ein neuer lokaler Tag zählt
  // einmal mit seiner Tagesgebühr (Monatsgebühr ÷ Tage des Monats).
  fee.lastDate = date;
  const dayFee = finite(slot.tariffFeeEurDay) ? Number(slot.tariffFeeEurDay) : null;
  fee.days += 1;
  if (dayFee == null) fee.missingDays += 1; else fee.eur += dayFee;
  if (slot.tariffVariable) {
    fee.varDays += 1;
    if (dayFee == null) fee.varMissingDays += 1; else fee.varEur += dayFee;
  }
  if (slot.tariffCompareDay) {
    const cmpFee = finite(slot.tariffCompareFeeEurDay) ? Number(slot.tariffCompareFeeEurDay) : null;
    if (cmpFee == null || dayFee == null) {
      fee.cmpMissingDays += 1;
    } else {
      fee.cmpDays += 1;
      fee.cmpFixedEur += cmpFee;
      fee.cmpActualEur += dayFee;
    }
  }
}

// Flüsse einer Viertelstunde, Akku 1 + 2 zusammen:
// [PV direkt, Netz direkt, Akku→Haus, PV→Akku, Netz→Akku, Akku→Netz, PV→Netz].
// history-runtime legt sie UNGERUNDET als slot.tariffFlows an (die Slot-Felder
// sind dort schon auf 2 Stellen gerundet, Codex 39d05c79); sonst aus den Feldern.
export function tariffFlowsOf(slot) {
  if (Array.isArray(slot?.tariffFlows)) return slot.tariffFlows.map(kwhOf);
  return [
    kwhOf(slot.solarDirectUseKwh),
    kwhOf(slot.gridDirectUseKwh),
    kwhOf(slot.batteryDirectUseKwh) + kwhOf(slot.secondBatteryDirectUseKwh),
    kwhOf(slot.solarToBatteryKwh) + kwhOf(slot.secondSolarToBatteryKwh),
    kwhOf(slot.gridToBatteryKwh) + kwhOf(slot.secondGridToBatteryKwh),
    kwhOf(slot.batteryToGridKwh) + kwhOf(slot.secondBatteryToGridKwh),
    kwhOf(slot.solarToGridKwh)
  ];
}

function addSelfUse(selfUse, slot, flows) {
  const p = Number(slot.userImportPriceCtKwh);
  const s = Number(slot.marketPriceCtKwh);
  const [solarDirect, gridDirect, battDirect, solarToBatt, gridToBatt, battToGrid, solarToGrid] = flows;
  const load = solarDirect + gridDirect + battDirect;
  const anyFlow = load + solarToBatt + gridToBatt + battToGrid + solarToGrid > 0;
  if (!slot.importPriceKnown || !Number.isFinite(p) || !finite(slot.marketPriceCtKwh)) {
    if (anyFlow || kwhOf(slot.loadKwh) > 0) selfUse.skippedNoPriceSlots += 1;
    return;
  }
  if (!anyFlow) {
    // Hauslast ohne Flussreihen (alte Importe): nicht anteilig raten.
    if (kwhOf(slot.loadKwh) > 0.001) selfUse.skippedNoFlowSlots += 1;
    return;
  }
  selfUse.slots += 1;
  selfUse.loadKwh += load;
  selfUse.loadCt += load * p;
  // T13: gemessene Hauslast (load_power_w) — die Flusssumme enthält die Wandlerverluste.
  selfUse.loadMeasuredKwh += kwhOf(slot.loadKwh);
  selfUse.loadMeasuredCt += kwhOf(slot.loadKwh) * p;
  // Herkunft der Akku-Flüsse (Codex 013298c7): VRM-Akkumengen sind schon AC.
  // slot.batteryFlowsVrm kommt aus der Quellwahl je Reihe; ohne das Feld (ältere
  // Pfade) wie history-runtime nach dem Slot (vrmFlows / sourceKind).
  const fromVrm = typeof slot.batteryFlowsVrm === 'boolean'
    ? slot.batteryFlowsVrm
    : (slot.vrmFlows === true || slot.sourceKind === 'vrm_import');
  if (!fromVrm) {
    selfUse.chargeGridLocalKwh += gridToBatt;
    selfUse.chargeGridLocalCt += gridToBatt * p;
    const dc = battDirect + battToGrid;
    if (dc > 0) {
      const k = Math.min(100, Math.max(0, Math.floor((battToGrid / dc) * 100 + 1e-9)));
      const bins = selfUse.dischargeBins || (selfUse.dischargeBins = {});
      const bin = bins[k] || (bins[k] = { dc: 0, btg: 0, valueCt: 0, dcPCt: 0, dcSCt: 0 });
      bin.dc += dc;
      bin.btg += battToGrid;
      bin.valueCt += battDirect * p + battToGrid * s;
      bin.dcPCt += dc * p;
      bin.dcSCt += dc * s;
    }
  }
  selfUse.pvMeasuredCt += kwhOf(slot.pvKwh) * s;
  selfUse.solarExportCt += solarToGrid * s;
  selfUse.batteryExportCt += battToGrid * s;
  selfUse.gridKwh += gridDirect + gridToBatt;
  selfUse.gridCt += (gridDirect + gridToBatt) * p;
  selfUse.pvDirectKwh += solarDirect;
  selfUse.pvDirectGainCt += solarDirect * (p - s);
  selfUse.chargePvKwh += solarToBatt;
  selfUse.chargeGridKwh += gridToBatt;
  selfUse.chargeCostCt += solarToBatt * s + gridToBatt * p;
  selfUse.chargeGridCt += gridToBatt * p;
  selfUse.dischargeHouseKwh += battDirect;
  selfUse.dischargeGridKwh += battToGrid;
  selfUse.dischargeValueCt += battDirect * p + battToGrid * s;
  selfUse.exportKwh += solarToGrid + battToGrid;
  selfUse.exportCt += (solarToGrid + battToGrid) * s;
  selfUse.pvKwh += solarDirect + solarToBatt + solarToGrid;
  selfUse.pvCt += (solarDirect + solarToBatt + solarToGrid) * s;
}

/**
 * Eine bewertete Viertelstunde in die Summen. Erwartete Felder (enrichSlot):
 * tariffVariable, tariffPriced, priceSource, userImportPriceCtKwh,
 * marketPriceCtKwh, importKwh, gridDirectUseKwh, gridToBatteryKwh,
 * secondGridToBatteryKwh, tariffCompareCtKwh, tariffGroupKey + Gruppen-Felder,
 * tariffDate/tariffFeeEurDay/tariffCompareDay/tariffCompareFeeEurDay, Flüsse.
 */
export function addSlotToTariffSums(sums, slot) {
  if (sums.fee) addFee(sums.fee, slot);
  const flows = tariffFlowsOf(slot);
  const p = Number(slot.userImportPriceCtKwh);
  const imp = kwhOf(slot.importKwh);
  if (slot.importPriceKnown && Number.isFinite(p)) {
    sums.allImportKwh += imp;
    sums.allImportCt += imp * p;
  }
  if (slot.tariffVariable) {
    sums.variableSlots += 1;
    if (!slot.tariffPriced) {
      sums.unpricedSlots += 1;
    } else {
      const estimated = slot.priceSource === 'estimate';
      const part = estimated ? sums.est : sums.real;
      part.slots += 1;
      part.importKwh += imp;
      part.importCt += imp * p;
      part.priceCtSum += p;
      const spotKnown = finite(slot.marketPriceCtKwh);
      const s = spotKnown ? Number(slot.marketPriceCtKwh) : null;
      if (spotKnown) {
        part.spotKwh += imp;
        part.spotCt += imp * s;
        part.spotPriceCt += imp * p;
      }
      const house = flows[1];
      const battery = flows[4];
      part.houseKwh += house;
      part.houseCt += house * p;
      part.batteryKwh += battery;
      part.batteryCt += battery * p;
      // T11: §14a-Fenster — Abweichung δ vom Standard-Netzentgelt.
      const m3Delta = slot.tariffM3Active && finite(slot.tariffM3DeltaCtKwh) ? Number(slot.tariffM3DeltaCtKwh) : 0;
      if (slot.tariffM3Active) {
        if (finite(slot.tariffM3DeltaCtKwh)) {
          part.m3Slots += 1;
          part.m3Kwh += imp;
          part.m3DeltaCt += imp * m3Delta;
        } else {
          part.m3UnknownSlots += 1;
        }
      }
      if (finite(slot.tariffCompareCtKwh)) {
        const fixedCt = Number(slot.tariffCompareCtKwh);
        part.cmpSlots += 1;
        part.cmpKwh += imp;
        part.cmpActualCt += imp * p;
        part.cmpFixedCt += imp * (fixedCt + m3Delta);
        part.cmpBaseCt += imp * fixedCt;
        part.cmpM3DeltaCt += imp * m3Delta;
      }
      if (sums.groups && spotKnown) {
        const key = slot.tariffGroupKey || 'base|std';
        let group = sums.groups[key];
        if (!group) {
          group = {
            tariffKey: slot.tariffKey ?? null,
            tariffLabel: slot.tariffLabel ?? null,
            mode: slot.tariffMode ?? null,
            windowId: slot.tariffWindowId ?? null,
            windowLabel: slot.tariffWindowLabel ?? null,
            vatPct: finite(slot.tariffVatPct) ? Number(slot.tariffVatPct) : 19,
            pos: { real: createFit(), est: createFit() },
            neg: { real: createFit(), est: createFit() }
          };
          sums.groups[key] = group;
        }
        addFit(group[s >= 0 ? 'pos' : 'neg'][estimated ? 'est' : 'real'], s, p, imp);
        const idx = scatterBinIndex(s);
        const bin = sums.bins[idx] || (sums.bins[idx] = { real: createBin(), est: createBin() });
        addBin(bin[estimated ? 'est' : 'real'], s, p, imp);
      }
    }
  }
  if (sums.selfUse) addSelfUse(sums.selfUse, slot, flows);
  return sums;
}

// ── Zusammenführen ────────────────────────────────────────────────────────

function mergeNumbers(a, b) {
  const out = {};
  for (const key of Object.keys(a)) out[key] = Number(a[key] || 0) + Number(b?.[key] || 0);
  return out;
}

function mergeFit(a, b) {
  const out = mergeNumbers(a, b);
  const mins = [a.mkMin, b?.mkMin].filter((v) => v != null);
  const maxs = [a.mkMax, b?.mkMax].filter((v) => v != null);
  out.mkMin = mins.length ? Math.min(...mins) : null;
  out.mkMax = maxs.length ? Math.max(...maxs) : null;
  return out;
}

function mergeBin(a, b) {
  const out = mergeNumbers(a, b);
  const mins = [a.minP, b?.minP].filter((v) => v != null);
  const maxs = [a.maxP, b?.maxP].filter((v) => v != null);
  out.minP = mins.length ? Math.min(...mins) : null;
  out.maxP = maxs.length ? Math.max(...maxs) : null;
  return out;
}

const pick = (pair, excludeEstimated, merge) => (excludeEstimated ? pair.real : merge(pair.real, pair.est));

// ── Formel p = a + b·s ────────────────────────────────────────────────────

/** Kleinste Quadrate aus den Summen; null bei < 16 Paaren oder Börse ohne Streuung. */
export function computeTariffFit(fit, vatPct = 19) {
  const n = Number(fit?.n || 0);
  if (n < TARIFF_FIT_MIN_PAIRS) return null;
  const sxxC = fit.sxx - (fit.sx * fit.sx) / n;
  if (sxxC / n < 1e-6) return null;
  const sxyC = fit.sxy - (fit.sx * fit.sy) / n;
  const syyC = fit.syy - (fit.sy * fit.sy) / n;
  const b = sxyC / sxxC;
  const a = (fit.sy - b * fit.sx) / n;
  const r2 = syyC > 1e-9 ? Math.min(1, Math.max(0, (b * sxyC) / syyC)) : 1;
  const toNet = 1 / (1 + (Number.isFinite(Number(vatPct)) ? Number(vatPct) : 19) / 100);
  return {
    gross: { interceptCtKwh: round(a, 3), slope: round(b, 4) },
    net: { interceptCtKwh: round(a * toNet, 3), slope: round(b * toNet, 4) },
    // Prozent auf die Börse: brutto (mit MwSt) und netto (ohne MwSt).
    markupPctGross: round((b - 1) * 100, 2),
    markupPctNet: round((b * toNet - 1) * 100, 2),
    r2: round(r2, 4)
  };
}

function fitSummary(fit) {
  const n = Number(fit.n || 0);
  return {
    n,
    importKwh: round2(fit.kwh),
    avgMarkupCtKwh: n > 0 ? round2((fit.sy - fit.sx) / n) : null,
    markupMinCtKwh: fit.mkMin == null ? null : round2(fit.mkMin),
    markupMaxCtKwh: fit.mkMax == null ? null : round2(fit.mkMax)
  };
}

// Börsen-Perzentil aus den 1-ct-Klassen (nur s ≥ 0), Wert = Ø Börse der Klasse.
function spotPercentile(binList, q) {
  const positive = binList.filter((bin) => bin.idx >= 0 && bin.n > 0);
  const total = positive.reduce((sum, bin) => sum + bin.n, 0);
  if (total === 0) return null;
  const target = q * total;
  let cum = 0;
  for (const bin of positive) {
    cum += bin.n;
    if (cum >= target) return round2(bin.sumS / bin.n);
  }
  const last = positive[positive.length - 1];
  return round2(last.sumS / last.n);
}

function mergedBins(sums, excludeEstimated) {
  return Object.entries(sums.bins || {})
    .map(([idx, pair]) => ({ idx: Number(idx), ...pick(pair, excludeEstimated, mergeBin), estimatedN: pair.est.n }))
    .sort((a, b) => a.idx - b.idx);
}

function markupAt(fit, spot) {
  if (!fit || spot == null) return null;
  return { spotCtKwh: spot, markupCtKwh: round2(fit.gross.interceptCtKwh + (fit.gross.slope - 1) * spot) };
}

export function finalizeTariffFits(sums, { excludeEstimated = false } = {}) {
  const binList = mergedBins(sums, excludeEstimated);
  const p10 = spotPercentile(binList, 0.1);
  const p90 = spotPercentile(binList, 0.9);
  let overallPos = createFit();
  const fits = Object.entries(sums.groups || {}).map(([key, group]) => {
    const pos = pick(group.pos, excludeEstimated, mergeFit);
    const neg = pick(group.neg, excludeEstimated, mergeFit);
    overallPos = mergeFit(overallPos, pos);
    const fit = computeTariffFit(pos, group.vatPct);
    return {
      key,
      tariffKey: group.tariffKey,
      tariffLabel: group.tariffLabel,
      mode: group.mode,
      windowId: group.windowId,
      windowLabel: group.windowLabel,
      vatPct: group.vatPct,
      ...fitSummary(pos),
      fit,
      atP10: markupAt(fit, p10),
      atP90: markupAt(fit, p90),
      negative: neg.n > 0 ? { ...fitSummary(neg), fit: computeTariffFit(neg, group.vatPct) } : null
    };
  }).filter((entry) => entry.n > 0 || entry.negative)
    .sort((a, b) => b.n - a.n);
  const vat = fits.length ? fits[0].vatPct : 19;
  return {
    fits,
    overall: overallPos.n > 0 ? { ...fitSummary(overallPos), fit: computeTariffFit(overallPos, vat) } : null,
    spotP10CtKwh: p10,
    spotP90CtKwh: p90,
    binList
  };
}

// ── Zeile / Zeitraum ──────────────────────────────────────────────────────

/** Kennzahlen je Zeile (Tag, Monat, Jahr) und für den Zeitraum. */
export function finalizeTariffRow(sums, { excludeEstimated = false } = {}) {
  const part = excludeEstimated ? sums.real : mergeNumbers(sums.real, sums.est);
  const allEstKwh = sums.est.importKwh;
  const allKwh = sums.real.importKwh + sums.est.importKwh;
  const fee = sums.fee;
  const importCostEur = round2(part.importCt / 100);
  const compared = part.cmpSlots > 0;
  const hasP14a = part.m3Slots > 0;
  const fixedCompare = compared ? (() => {
    // T11: der Festpreis-Tarif hätte dieselben §14a-Fenster gehabt (F + δ).
    const actualEur = round2(part.cmpActualCt / 100);
    const fixedEur = round2(part.cmpFixedCt / 100);
    let withoutP14a = null;
    if (hasP14a && part.cmpM3DeltaCt !== 0) {
      const actualWithout = round2((part.cmpActualCt - part.cmpM3DeltaCt) / 100);
      const fixedWithout = round2(part.cmpBaseCt / 100);
      withoutP14a = { actualEur: actualWithout, fixedEur: fixedWithout, savingsEur: round2(fixedWithout - actualWithout) };
    }
    return {
      slots: part.cmpSlots,
      importKwh: round2(part.cmpKwh),
      ctKwh: ratio(part.cmpBaseCt, part.cmpKwh),
      ctKwhWithP14a: ratio(part.cmpFixedCt, part.cmpKwh),
      actualEur,
      fixedEur,
      savingsEur: round2(fixedEur - actualEur),
      withoutP14a
    };
  })() : null;
  // §14a-Effekt (T11): was die Fenster gegenüber dem Standard-Netzentgelt
  // gespart haben — dynamisch über alle Fenster-Viertelstunden, beim Festpreis
  // über die verglichenen (gleiche Mengen).
  const p14a = part.m3Slots > 0 || part.m3UnknownSlots > 0 ? {
    slots: part.m3Slots,
    importKwh: round2(part.m3Kwh),
    unknownSlots: part.m3UnknownSlots,
    savedDynamicEur: round2(-part.m3DeltaCt / 100),
    savedFixedEur: compared ? round2(-part.cmpM3DeltaCt / 100) : null,
    avgImportCtKwhWithout: ratio(part.importCt - part.m3DeltaCt, part.importKwh)
  } : null;
  const baseFee = fee ? {
    eur: round2(fee.eur),
    days: fee.days,
    missingDays: fee.missingDays,
    variableEur: round2(fee.varEur),
    variableDays: fee.varDays,
    variableMissingDays: fee.varMissingDays
  } : null;
  // Mit Grundgebühr: nur wenn sie für alle betroffenen Tage bekannt ist.
  const variableCostWithFeeEur = fee && fee.varDays > 0 && fee.varMissingDays === 0 && part.slots > 0
    ? round2(importCostEur + fee.varEur)
    : null;
  const allCostWithFeeEur = fee && fee.days > 0 && fee.missingDays === 0
    ? round2(sums.allImportCt / 100 + fee.eur)
    : null;
  let fixedCompareWithFee = null;
  if (fee && fixedCompare && fee.cmpDays > 0 && fee.cmpMissingDays === 0) {
    const feeFixedEur = round2(fee.cmpFixedEur);
    const feeActualEur = round2(fee.cmpActualEur);
    const fixedEur = round2(fixedCompare.fixedEur + feeFixedEur);
    const actualEur = round2(fixedCompare.actualEur + feeActualEur);
    // „Ohne §14a“ auf derselben Basis (mit Grundgebühr), Codex 3cbbdef3.
    const w = fixedCompare.withoutP14a;
    const withoutP14a = w ? (() => {
      const wFixed = round2(w.fixedEur + feeFixedEur);
      const wActual = round2(w.actualEur + feeActualEur);
      return { actualEur: wActual, fixedEur: wFixed, savingsEur: round2(wFixed - wActual) };
    })() : null;
    fixedCompareWithFee = { days: fee.cmpDays, feeFixedEur, feeActualEur, fixedEur, actualEur, savingsEur: round2(fixedEur - actualEur), withoutP14a };
  }
  return {
    excludeEstimated: Boolean(excludeEstimated),
    variableSlots: sums.variableSlots,
    unpricedSlots: sums.unpricedSlots,
    pricedSlots: part.slots,
    estimatedSlots: sums.est.slots,
    estimatedImportKwh: round2(allEstKwh),
    estimatedSharePct: allKwh > 0 ? round2((allEstKwh / allKwh) * 100) : null,
    importKwh: round2(part.importKwh),
    importCostEur,
    avgImportCtKwh: ratio(part.importCt, part.importKwh),
    avgSlotCtKwh: ratio(part.priceCtSum, part.slots),
    avgSpotWeightedCtKwh: ratio(part.spotCt, part.spotKwh),
    avgMarkupCtKwh: ratio(part.spotPriceCt - part.spotCt, part.spotKwh),
    house: { importKwh: round2(part.houseKwh), avgCtKwh: ratio(part.houseCt, part.houseKwh) },
    battery: { importKwh: round2(part.batteryKwh), avgCtKwh: ratio(part.batteryCt, part.batteryKwh) },
    fixedCompare,
    p14a,
    baseFee,
    variableCostWithFeeEur,
    allImportKwh: round2(sums.allImportKwh),
    allImportCostEur: round2(sums.allImportCt / 100),
    allCostWithFeeEur,
    fixedCompareWithFee,
    compareFeeMissingDays: fee ? fee.cmpMissingDays : null
  };
}

// ── Eigenverbrauch bewertet (T4/T7) ───────────────────────────────────────

/**
 * Bewertung je Viertelstunde, X = Börse (Marktprämie getrennt):
 *   PV direkt   Σ solarDirect·(p − s)
 *   Akku        Σ [battDirect·p + battToGrid·s − solarToBatt·s − gridToBatt·p]
 *               + ΔSoC × Einstandspreis (Ladestand am Rand, kein Scheingewinn)
 *   p_eff       (Σ Last·p − Vorteil) ÷ Σ Last
 * Die Verluste stecken in den Mengen (rein 1 kWh, raus η kWh).
 *
 * storage (T12): Speicherweg mit Wandlung aus dem Tagesjob
 * services/inverter-efficiency/storage.js — { capability, totals, secondBattery }.
 * Fehlt er (ohne Datenbank), entfällt battery.system.
 */
export function finalizeSelfUse(selfUse, { storedDeltaKwh = null, storage = null } = {}) {
  if (!selfUse) return null;
  const discharge = selfUse.dischargeHouseKwh + selfUse.dischargeGridKwh;
  const charge = selfUse.chargePvKwh + selfUse.chargeGridKwh;
  const delta = finite(storedDeltaKwh) ? Number(storedDeltaKwh) : null;
  const netCharge = charge - (delta ?? 0);
  // Ladestand am Rand zum Einstandspreis je GELADENER kWh (Codex 39d05c79):
  // je entladener kWh blähte ein voller Akku am Ende das Ergebnis auf und fiel
  // ohne Entladung ganz weg. Ohne Ladung im Zeitraum ist der Einstand
  // unbekannt; dann neutral zum Nutzwert je entladener kWh.
  const value = (v) => {
    const storedCt = charge > 0 ? v.chargeCostCt / charge : (discharge > 0 ? v.dischargeValueCt / discharge : null);
    const socCorrectionCt = delta != null && storedCt != null ? delta * storedCt : 0;
    const batteryResultCt = v.dischargeValueCt - v.chargeCostCt + socCorrectionCt;
    return { ...v, storedCt, socCorrectionCt, batteryResultCt, advantageCt: selfUse.pvDirectGainCt + batteryResultCt };
  };
  // Bisher (Flüsse, DC als AC gezählt): Akku-Mengen DC am Akku, Last = Flusssumme.
  const flows = value({
    chargeCostCt: selfUse.chargeCostCt, dischargeValueCt: selfUse.dischargeValueCt,
    chargeGridKwh: selfUse.chargeGridKwh, dischargeHouseKwh: selfUse.dischargeHouseKwh,
    dischargeGridKwh: selfUse.dischargeGridKwh, loadKwh: selfUse.loadKwh, loadCt: selfUse.loadCt
  });
  // T13 = B (Christin 24.11.2026): wo der Speicherweg gemessen ist, bewertet die
  // Karte den Akku AC-korrekt — Entladung × η Entladen, Netzladung ÷ η Lader
  // (Tagesjob), Hausverbrauch gemessen. Die Flüsse in der Datenbank bleiben.
  // Codex a7e86f28:
  //  - nur eigene DC-Flüsse wandeln; VRM-Flüsse sind schon an AC-Werten normiert,
  //  - Akku→Netz ist die gemessene Einspeisung (polling.js): der Entladeverlust
  //    fehlt dem Haus-Anteil (Endpreis), wo die Einspeisung die AC-Abgabe des
  //    Akkus übersteigt, der Einspeisung (Börse) — Codex 013298c7,
  //  - der effektive Preis rechnet mit den echten Kosten (Netz + gemessene PV,
  //    soweit nicht eingespeist, zur Börse − Akku-Einspeisung − Ladestand am Rand):
  //    so zählen auch Leerlauf und PV-Wandlung des Wechselrichters mit.
  const t = storageUsable(storage) ? storage.totals : null;
  const ac = t && (selfUse.loadMeasuredKwh || 0) > 0 ? (() => {
    const etaD = t.dischargeEta;
    const etaCh = t.chargerEta ?? 1;
    const lossD = 1 - etaD;
    const extraCh = 1 / etaCh - 1;
    // Entladeverlust je Klasse (Anteil q = Akku→Netz ÷ DC-Entladung der Klasse,
    // aus den echten Mengen, nicht der Klassenmitte — Codex 97d4003f):
    //   q ≤ η: der Akku liefert genug AC für die gemessene Einspeisung — der Verlust
    //          fehlt dem Haus-Anteil (zum Endpreis p);
    //   q > η: die Einspeisung ist größer als die AC-Abgabe des Akkus — das Haus
    //          bekommt nichts, der Akku speist η·DC ein (zur Börse), den Rest der
    //          Einspeisung lieferte die PV. Die Gesamteinspeisung bleibt gemessen.
    let houseKwh = selfUse.dischargeHouseKwh;
    let gridKwh = selfUse.dischargeGridKwh;
    let dischargeValueCt = selfUse.dischargeValueCt;
    for (const b of Object.values(selfUse.dischargeBins || {})) {
      if (!(b.dc > 0)) continue;
      const q = b.btg / b.dc;
      if (q <= etaD) {
        houseKwh -= lossD * b.dc;
        dischargeValueCt -= lossD * b.dcPCt;
      } else {
        houseKwh -= b.dc - b.btg;
        gridKwh -= b.btg - etaD * b.dc;
        dischargeValueCt += etaD * b.dcSCt - b.valueCt;
      }
    }
    const valued = value({
      chargeCostCt: selfUse.chargeCostCt + (selfUse.chargeGridLocalCt || 0) * extraCh,
      dischargeValueCt,
      chargeGridKwh: selfUse.chargeGridKwh + (selfUse.chargeGridLocalKwh || 0) * extraCh,
      dischargeHouseKwh: Math.max(0, houseKwh),
      dischargeGridKwh: Math.max(0, gridKwh),
      loadKwh: selfUse.loadMeasuredKwh,
      loadCt: selfUse.loadMeasuredCt,
      etaD,
      etaCh: t.chargerEta ?? null
    });
    const costCt = selfUse.gridCt + (selfUse.pvMeasuredCt || 0) - (selfUse.solarExportCt || 0)
      - (selfUse.batteryExportCt || 0) - valued.socCorrectionCt;
    const componentsCt = valued.advantageCt;
    // Vorteil = was die Last zum Endpreis gekostet hätte − was sie wirklich kostete.
    return { ...valued, costCt, advantageCt: valued.loadCt - costCt, otherCt: componentsCt - (valued.loadCt - costCt) };
  })() : null;
  const v = ac || flows;
  const out = v.dischargeHouseKwh + v.dischargeGridKwh;
  return {
    exportValueBasis: 'spot',
    // 'ac' = mit Wandlung (T13 B), 'flows' = wie bisher aus den Flüssen.
    valuation: ac ? 'ac' : 'flows',
    slots: selfUse.slots,
    skippedNoPriceSlots: selfUse.skippedNoPriceSlots,
    skippedNoFlowSlots: selfUse.skippedNoFlowSlots,
    loadKwh: round2(v.loadKwh),
    loadCostAtPriceEur: round2(v.loadCt / 100),
    loadAvgCtKwh: ratio(v.loadCt, v.loadKwh),
    gridImportKwh: round2(selfUse.gridKwh),
    gridCostEur: round2(selfUse.gridCt / 100),
    pvDirectKwh: round2(selfUse.pvDirectKwh),
    pvDirectGainEur: round2(selfUse.pvDirectGainCt / 100),
    pvDirectGainCtKwh: ratio(selfUse.pvDirectGainCt, selfUse.pvDirectKwh),
    battery: {
      chargedPvKwh: round2(selfUse.chargePvKwh),
      chargedGridKwh: round2(v.chargeGridKwh),
      dischargedHouseKwh: round2(v.dischargeHouseKwh),
      dischargedGridKwh: round2(v.dischargeGridKwh),
      chargeCostEur: round2(v.chargeCostCt / 100),
      dischargeValueEur: round2(v.dischargeValueCt / 100),
      inCtKwh: out > 0 ? round2(v.chargeCostCt / out) : null,
      outCtKwh: ratio(v.dischargeValueCt, out),
      // Akku-Wirkungsgrad (DC): DC am Akku rein → DC raus, Ladestand am Rand abgezogen.
      etaPct: discharge > 0 && netCharge > 0 ? round2((discharge / netCharge) * 100) : null,
      storedDeltaKwh: delta == null ? null : round2(delta),
      storedValueCtKwh: v.storedCt == null ? null : round2(v.storedCt),
      socCorrectionEur: round2(v.socCorrectionCt / 100),
      resultEur: round2(v.batteryResultCt / 100),
      // Mit Wandlung: welche Wirkungsgrade angewandt wurden (η Lader fehlt → Netzladung unkorrigiert).
      acBasis: ac ? {
        dischargeEtaPct: round2(ac.etaD * 100),
        chargerEtaPct: ac.etaCh == null ? null : round2(ac.etaCh * 100)
      } : null,
      system: storage ? finalizeStorageSystem(selfUse, storage, { storedCt: v.storedCt }) : null
    },
    exportKwh: round2(selfUse.exportKwh),
    exportValueEur: round2(selfUse.exportCt / 100),
    advantageEur: round2(v.advantageCt / 100),
    // Mit Wandlung: Wechselrichter-Verbrauch außerhalb des Akku-Wegs (Leerlauf, PV-Wandlung),
    // den der Vorteil schon abzieht — PV direkt + Akku-Ergebnis − Vorteil.
    otherConversionCostEur: ac ? round2(ac.otherCt / 100) : null,
    peffCtKwh: ratio(v.loadCt - v.advantageCt, v.loadKwh),
    peffWithoutOpportunityCtKwh: ratio(selfUse.gridCt, v.loadKwh),
    // Zum Vergleich immer die bisherige Bewertung aus den Flüssen.
    flowsValuation: {
      loadKwh: round2(flows.loadKwh),
      advantageEur: round2(flows.advantageCt / 100),
      batteryResultEur: round2(flows.batteryResultCt / 100),
      peffCtKwh: ratio(flows.loadCt - flows.advantageCt, flows.loadKwh),
      peffWithoutOpportunityCtKwh: ratio(selfUse.gridCt, flows.loadKwh)
    }
  };
}

/** Speicherweg gemessen und verwendbar (messbar, ohne Akku 2, Job-Status ok). */
function storageUsable(storage) {
  return Boolean(storage && storage.capability?.measurable && !storage.secondBattery
    && storage.totals && storage.totals.status === 'ok');
}

// ── Systemwirkungsgrad (AC) und Verluste im Speicherweg (T12) ─────────────

/**
 * Speicherweg mit Wandlung, Christin 23.11.2026 (T12). Alle Mengen aus dem
 * Tagesjob services/inverter-efficiency/storage.js (dieselben Rohwerte):
 *   η Laden     Akku geladen (DC) ÷ eingesetzte Energie;
 *               eingesetzt = AC am Lader (Netz/AC-PV) + DC-PV direkt (1:1, ungewandelt)
 *   η Akku DC   Akku entladen ÷ (geladen − ΔSoC), DC am Akku
 *   η Entladen  AC aus dem Akku ÷ Akku entladen (DC)
 *   η System    η Laden × η Akku DC × η Entladen
 *               = nutzbare AC-Energie ÷ eingesetzte Energie (Rest im Akku abgezogen)
 * Verluste in kWh (gemessen):
 *   Akku (DC)          geladen − ΔSoC − entladen
 *   Wandler Laden      eingesetzt − geladen
 *   Wandler Entladen   entladen − AC aus dem Akku
 * In € mit den Preisen der Karte: Laden-Verlust zum Ø Bezugspreis der
 * Netzladung (ohne Netzladung: Ø Börse der PV — AC-PV), die anderen beiden zum
 * Einstandspreis je geladener kWh (wie der Ladestand am Rand).
 * Die DC-Werte der Karte selbst (battery.etaPct) bleiben wie bisher aus den
 * 15-min-Flüssen — die können für ältere Zeiträume VRM-Werte enthalten.
 */
function finalizeStorageSystem(selfUse, storage, { storedCt }) {
  const cap = storage.capability || {};
  const base = {
    measurable: Boolean(cap.measurable),
    verified: Boolean(cap.verified),
    label: cap.label ?? null,
    note: cap.note ?? null,
    reason: cap.reason ?? null,
    status: null,
    basis: null
  };
  if (!cap.measurable) return { ...base, status: 'not_measurable' };
  if (storage.secondBattery) {
    return {
      ...base, measurable: false, status: 'not_measurable',
      reason: 'nicht messbar mit Akku der zweiten GX-Anlage: deren Wechselrichter misst DVhub nicht'
    };
  }
  const t = storage.totals;
  if (!t) return { ...base, status: 'insufficient_data', reason: 'noch keine Messwerte (Tagesjob läuft stündlich)' };
  const basis = { days: t.days, firstDay: t.firstDay, lastDay: t.lastDay, hours: t.hours };
  if (t.status !== 'ok') return { ...base, status: t.status, reason: t.reason, basis };
  const raw = t.raw;
  const dcLoss = raw.chargeAllKwh - raw.storedDeltaKwh - raw.dischargeAllKwh;
  const chargeLoss = raw.inputKwh - raw.chargeKwh;
  const dischargeLoss = raw.dischargeKwh - raw.acOutKwh;
  const chargeCt = selfUse.chargeGridKwh > 0
    ? (selfUse.chargeGridCt || 0) / selfUse.chargeGridKwh
    : (selfUse.pvKwh > 0 ? selfUse.pvCt / selfUse.pvKwh : null);
  const stored = storedCt ?? null;
  const eur = (kwh, ct) => (ct == null ? null : (kwh * ct) / 100);
  const eurOut = (value) => (value == null ? null : round2(value));
  const dcEur = eur(dcLoss, stored);
  const chargeEur = eur(chargeLoss, chargeCt);
  const dischargeEur = eur(dischargeLoss, stored);
  // Akku (DC) nur über Abstände mit Ladestand (Codex 3be47b54): fehlte er zeitweise,
  // deckt die Summe nicht die ganze Messzeit ab — kenntlich machen, nicht hochrechnen.
  const dcCoveragePct = t.socCoveragePct ?? null;
  const complete = t.socComplete !== false;
  return {
    ...base,
    status: 'ok',
    basis,
    dcEtaPct: round2(t.dcEta * 100),
    chargeEtaPct: round2(t.chargeEta * 100),
    dischargeEtaPct: round2(t.dischargeEta * 100),
    chargerEtaPct: t.chargerEta == null ? null : round2(t.chargerEta * 100),
    systemEtaPct: round2(t.chargeEta * t.dcEta * t.dischargeEta * 100),
    energy: {
      inputKwh: round2(raw.inputKwh),
      chargedKwh: round2(raw.chargeAllKwh),
      dischargedKwh: round2(raw.dischargeAllKwh),
      acOutKwh: round2(raw.acOutKwh),
      storedDeltaKwh: round2(raw.storedDeltaKwh)
    },
    losses: {
      dcKwh: round2(dcLoss),
      dcEur: eurOut(dcEur),
      chargeKwh: round2(chargeLoss),
      chargeEur: eurOut(chargeEur),
      dischargeKwh: round2(dischargeLoss),
      dischargeEur: eurOut(dischargeEur),
      totalKwh: round2(dcLoss + chargeLoss + dischargeLoss),
      totalEur: dcEur == null || chargeEur == null || dischargeEur == null ? null : round2(dcEur + chargeEur + dischargeEur),
      complete,
      dcCoveragePct
    },
    prices: {
      storedCtKwh: stored == null ? null : round2(stored),
      chargeCtKwh: chargeCt == null ? null : round2(chargeCt),
      chargeBasis: selfUse.chargeGridKwh > 0 ? 'grid' : 'pv'
    },
    // Wechselrichter gesamt laut Tagesjob (mit Leerlauf und PV-Wandlung), nur Messzeit.
    converterLossKwh: t.converterLossKwh
  };
}

// ── Streudiagramm ─────────────────────────────────────────────────────────

export function buildScatterBins(binList) {
  return binList.filter((bin) => bin.n > 0).map((bin) => ({
    spotFromCt: bin.idx === SCATTER_BIN_MIN_CT ? null : bin.idx,
    spotToCt: bin.idx === SCATTER_BIN_MAX_CT ? null : bin.idx + 1,
    n: bin.n,
    estimatedN: bin.estimatedN || 0,
    importKwh: round2(bin.kwh),
    avgSpotCt: round2(bin.sumS / bin.n),
    avgCt: round2(bin.sumP / bin.n),
    minCt: round2(bin.minP),
    maxCt: round2(bin.maxP)
  }));
}

/** Rohpunkte [Börse, Endpreis, kWh, geschätzt 0/1], höchstens SCATTER_MAX_POINTS (gleichmäßig ausgedünnt). */
export function buildScatterPoints(slots, { excludeEstimated = false } = {}) {
  const points = [];
  for (const slot of slots) {
    if (!slot?.tariffVariable || !slot.tariffPriced || !finite(slot.marketPriceCtKwh)) continue;
    const estimated = slot.priceSource === 'estimate';
    if (excludeEstimated && estimated) continue;
    points.push([round2(slot.marketPriceCtKwh), round2(slot.userImportPriceCtKwh), round(kwhOf(slot.importKwh), 3), estimated ? 1 : 0]);
  }
  if (points.length <= SCATTER_MAX_POINTS) return { points, thinned: false };
  const step = points.length / SCATTER_MAX_POINTS;
  const thinned = [];
  for (let i = 0; i < SCATTER_MAX_POINTS; i += 1) thinned.push(points[Math.floor(i * step)]);
  return { points: thinned, thinned: true };
}
