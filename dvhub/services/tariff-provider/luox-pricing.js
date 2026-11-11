// services/tariff-provider/luox-pricing.js — Endkundenpreis des Tarifs
// „LUOX Dynamisch“ je Viertelstunde aus den Produktbestandteilen des Portals.
//
// VORBEREITET, UNGEPRÜFT: Die Belieferung beginnt erst Mitte November/Dezember
// 2026; ob die Rechnung genau so rechnet, ist erst mit der ersten Abrechnung
// prüfbar. Darum steht der Endpreis hinter luox.endCustomerPrice.enabled.
//
// Struktur belegt (products/{C…}/{tag}/{tag}, live 11.11.2026; gleiche Form wie
// die Partner-API /v3/customers/{c}/contracts/{c}/product_info/):
//   product_items  ct/kWh  „Börsenstrompreis“ (classification spot_working_price)
//                          — amount_* enthält einen Ø-Spot-Schätzwert; daran
//                          hängen associated_costs je kWh: Netzentgelt
//                          (Arbeitspreis), Konzessionsabgabe, KWK-, Offshore-,
//                          §19-StromNEV-Umlage, Stromsteuer, abLa-Umlage
//                  ct/kWh  „Herkunftsnachweise“ (additional_ct_kwh_price)
//                  ct/m    Netzentgelte (Grundpreis), LUOX Energy Gebühr
//   variable_costs 1/100   percentage_service_fee_on_spot_working_price = 3 %
//                  ct/m    Ausgleichskosten (Wert nur über eigenen Endpunkt)
//                  ct/kWh  spot_working_price (Wert: „dedizierter Endpunkt“ =
//                          der Day-Ahead je Viertelstunde)
//   totals ct/kWh enthält den Ø-Spot-Schätzwert → nicht verwendet.
// Laut Tarifinformation/AGB (Merkel „LUOX Dynamisch – Tarifprüfung“): 3 % auf
// den absoluten Börsenwert; negative Preise werden 1:1 gutgeschrieben.
//
// Endpreis brutto = (Spot + 3 % × |Spot|) × (1 + MwSt) + Σ feste Bestandteile
// je kWh brutto. Nicht enthalten: monatliche Posten, Ausgleichskosten
// (monatlich, Betrag erst nachträglich), §14a-Modul-3-Erstattung (laut LUOX
// rückwirkend).

const SPOT_CLASSIFICATION = 'spot_working_price';
const SPOT_PERCENT_TYPE = 'percentage_service_fee_on_spot_working_price';

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const validOn = (x, date) => (!x?.valid_from || String(x.valid_from) <= date) && (!x?.valid_until || String(x.valid_until) >= date);
const round = (v, d = 7) => Math.round(v * 10 ** d) / 10 ** d;

function empty(reason, extra = {}) {
  return { complete: false, displayName: null, productName: null, percentOfSpot: null, vatPct: null, perKwh: null, perKwhItems: [], monthlyItems: [], notes: [reason], ...extra };
}

/**
 * Bestandteile des Tarifs am Tag `date` (YYYY-MM-DD, Ortszeit).
 * @param {object} json  Antwort von products/{C…}/{von}/{bis}
 * @returns {{complete:boolean, displayName:string|null, productName:string|null, percentOfSpot:number|null, vatPct:number|null,
 *   perKwh:{net:number, gross:number}|null, perKwhItems:Array, monthlyItems:Array, notes:string[], periodStart?:string, periodEnd?:string}}
 */
export function extractLuoxTariff(json, { date } = {}) {
  const infos = Array.isArray(json?.product_infos) ? json.product_infos : [];
  if (!infos.length) return empty('Keine Produktangaben vom LUOX-Portal.');
  const info = infos.find((p) => (!p.product_valid_from || p.product_valid_from <= date) && (!p.product_valid_until || p.product_valid_until >= date)) || null;
  if (!info) return empty(`Kein gültiges Produkt am ${date}.`);
  const meta = { displayName: info.display_name || null, productName: info.product_name || null };
  const period = (info.periods || []).find((p) => (!p.period_start || p.period_start <= date) && (!p.period_end || p.period_end >= date));
  if (!period) return empty(`Keine Preisperiode am ${date} (das Portal kennt Preise nur bis heute).`, meta);

  const notes = [];
  const perKwhItems = [];
  const monthlyItems = [];
  let spotItem = null;
  let ratio = null;
  const addRatio = (net, gross) => { if (net > 0 && gross > 0 && ratio == null) ratio = gross / net; };

  for (const item of period.product_items || []) {
    if (!validOn(item, date)) continue;
    const name = item.display_name || item.internal_name || item.classification || '?';
    if (item.classification === SPOT_CLASSIFICATION && item.unit === 'ct/kWh') {
      spotItem = item;
      for (const c of item.associated_costs || []) {
        if (!validOn(c, date)) continue;
        if (c.unit !== 'ct/kWh') { notes.push(`Posten „${c.display_name || c.name}“ (${c.unit}) nicht je kWh — nicht im Viertelstundenpreis.`); continue; }
        const net = num(c.cost_per_unit_net);
        const gross = num(c.cost_per_unit_gross);
        if (net == null || gross == null) continue;
        addRatio(net, gross);
        perKwhItems.push({ name: c.display_name || c.name, net, gross });
      }
      continue;
    }
    const net = num(item.amount_net);
    const gross = num(item.amount_gross);
    if (item.unit === 'ct/kWh' && net != null && gross != null) {
      addRatio(net, gross);
      perKwhItems.push({ name, net, gross });
    } else if (item.unit === 'ct/m' || item.unit === 'ct/y') {
      monthlyItems.push({ name, unit: item.unit, net, gross });
    } else {
      notes.push(`Posten „${name}“ (${item.unit}) nicht verrechnet.`);
    }
  }

  let percentOfSpot = null;
  for (const v of period.variable_costs || []) {
    if (!validOn(v, date)) continue;
    const label = v.display_name || v.name || v.cost_type;
    if (v.cost_type === SPOT_PERCENT_TYPE && v.unit === '1/100' && num(v.value) != null) { percentOfSpot = num(v.value); continue; }
    if (v.cost_type === SPOT_CLASSIFICATION) continue; // der Spot selbst (je Viertelstunde)
    if (/distribution_cost/.test(String(v.cost_type))) {
      notes.push(`${label}: monatlich, Betrag erst nachträglich — nicht im Viertelstundenpreis.`);
      continue;
    }
    notes.push(`Unbekannter Posten „${label}“ (${v.unit}${num(v.value) != null ? `, ${v.value}` : ''}) — nicht verrechnet, bitte prüfen.`);
  }

  if (!spotItem) return { ...empty('Kein Börsen-Arbeitspreis im Produkt (kein dynamischer Tarif?).', meta), monthlyItems, notes: ['Kein Börsen-Arbeitspreis im Produkt (kein dynamischer Tarif?).', ...notes] };
  const vatPct = ratio ? Math.round((ratio - 1) * 1000) / 10 : 19;
  if (percentOfSpot == null) notes.push('Kein prozentualer Aufschlag auf den Spot gefunden — mit 0 % gerechnet.');
  return {
    complete: true,
    ...meta,
    periodStart: period.period_start || null,
    periodEnd: period.period_end || null,
    percentOfSpot: percentOfSpot ?? 0,
    vatPct,
    perKwh: {
      net: round(perKwhItems.reduce((s, i) => s + i.net, 0)),
      gross: round(perKwhItems.reduce((s, i) => s + i.gross, 0))
    },
    perKwhItems,
    monthlyItems,
    notes
  };
}

/** Endpreis brutto (ct/kWh) einer Viertelstunde aus dem Spot (ct/kWh netto). */
export function luoxEndCustomerGrossCtKwh(spotCtKwh, tariff) {
  const spot = Number(spotCtKwh);
  if (!tariff?.complete || !Number.isFinite(spot)) return null;
  const energyNet = spot + (Number(tariff.percentOfSpot) || 0) / 100 * Math.abs(spot);
  return round(energyNet * (1 + Number(tariff.vatPct) / 100) + Number(tariff.perKwh.gross), 4);
}
