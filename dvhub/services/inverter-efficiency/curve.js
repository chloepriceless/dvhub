// services/inverter-efficiency/curve.js — lastabhängige Wirkungsgradkurve
// (Akku-DC → AC) autonom aus den eigenen Messdaten (Christin 2026-10-01).
//
// Eingabe sind die Tageszeilen je Lastbereich aus inverter_efficiency_bins_daily
// (Migration 022, befüllt von daily.js). Die Kurve entsteht aus einem festen
// Fenster ABGESCHLOSSENER Tage (Standard: die letzten 180 bis gestern). Je Bin:
//   x = mittlere AC-Leistung im Bin / Nennleistung   (energiegewichtet)
//   η = Σ AC-Wh / Σ DC-Wh
// Keine Glättung, kein Zufall, feste Rundung: dieselben Tageszeilen ergeben
// immer dieselbe Kurve — bitgenau, mit Prüfsumme (inputHash / curveHash).
//
// Freigabe erst nach einer echten Betriebsphase (MIN_DAYS Tage mit Daten,
// MIN_HOURS Stunden Entladung, mindestens MIN_POINTS Stützstellen, eine davon
// im Schwachlastbereich). Vorher status != 'ok' und DVhub schreibt EOS weiter
// den bisherigen Wert (1.0).

import { createHash } from 'node:crypto';

export const CURVE_WINDOW_DAYS = 180;
// Neu kalibriert wird in festen 30-Tage-Perioden ab diesem Stichtag. Das Fenster
// endet immer am letzten Tag der zuletzt ABGESCHLOSSENEN Periode — die Kurve
// ändert sich also höchstens alle 30 Tage, und das Ergebnis hängt nur am
// Kalender, nicht daran, wann DVhub zufällig rechnet.
export const CURVE_PERIOD_DAYS = 30;
export const CURVE_PERIOD_EPOCH = '2026-01-01';
export const CURVE_MIN_DAYS = 14;
export const CURVE_MIN_HOURS = 10;
export const CURVE_MIN_POINTS = 3;
export const CURVE_MIN_SECONDS_PER_BIN = 1800;
export const CURVE_LOW_LOAD_FRAC = 0.10;
const ETA_MIN = 0.5;
const ETA_MAX = 0.99;
// η ≥ 0,99 über alles: die Last wird aus dem Akku-DC abgeleitet statt gemessen
// (siehe daily.js summarizeEfficiencyRows) — dann ist nichts zu kalibrieren.
const NOT_MEASURABLE_ETA = 0.99;

const r = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function sha(obj) {
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}

const DAY = 86_400_000;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Fenster [from, to] (YYYY-MM-DD): to = letzter Tag der zuletzt abgeschlossenen
 * 30-Tage-Periode bis einschließlich `yesterday`, from = to − (days − 1).
 */
export function curveWindow(yesterday, { days = CURVE_WINDOW_DAYS, periodDays = CURVE_PERIOD_DAYS, epoch = CURVE_PERIOD_EPOCH } = {}) {
  const y = Date.parse(`${yesterday}T00:00:00Z`);
  const e = Date.parse(`${epoch}T00:00:00Z`);
  // Anzahl vollständig abgelaufener Perioden bis einschließlich `yesterday`.
  const completed = Math.floor((Math.round((y - e) / DAY) + 1) / periodDays);
  const toMs = e + (completed * periodDays - 1) * DAY;
  return { from: isoDay(toMs - (days - 1) * DAY), to: isoDay(toMs) };
}

/**
 * @param {Array<{day:string, bin:number, ac_wh:number, dc_wh:number, seconds:number}>} rows
 * @param {{ pnomW:number, window?:{from:string,to:string} }} opts
 */
export function fitInverterCurve(rows, { pnomW, window = null } = {}) {
  const pnom = num(pnomW);
  // Kanonische Reihenfolge + Rundung → Summen und Hash hängen nicht an der
  // Reihenfolge, in der die Datenbank liefert.
  const canon = (rows || [])
    .map((x) => ({
      day: String(x.day).slice(0, 10), bin: Math.trunc(num(x.bin)),
      ac: r(num(x.ac_wh), 3), dc: r(num(x.dc_wh), 3), s: r(num(x.seconds), 1),
    }))
    .filter((x) => !window || (x.day >= window.from && x.day <= window.to))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.bin - b.bin));
  const inputHash = sha({ pnom, canon });

  const bins = new Map();
  const days = new Set();
  let ac = 0; let dc = 0; let seconds = 0;
  for (const x of canon) {
    if (x.s <= 0 || x.dc <= 0) continue;
    days.add(x.day);
    ac += x.ac; dc += x.dc; seconds += x.s;
    const b = bins.get(x.bin) || { ac: 0, dc: 0, s: 0 };
    b.ac += x.ac; b.dc += x.dc; b.s += x.s;
    bins.set(x.bin, b);
  }

  const points = [];
  let fracDc = 0;
  for (const bin of [...bins.keys()].sort((a, b) => a - b)) {
    const b = bins.get(bin);
    if (b.s < CURVE_MIN_SECONDS_PER_BIN || b.dc <= 0 || !(pnom > 0)) continue;
    const frac = r((b.ac * 3600 / b.s) / pnom, 4);
    const eta = r(Math.min(ETA_MAX, Math.max(ETA_MIN, b.ac / b.dc)), 3);
    if (points.length && frac <= points[points.length - 1][0]) continue;
    points.push([frac, eta]);
    fracDc += frac * b.dc;
  }
  const usedDc = points.length ? [...bins.entries()]
    .filter(([, b]) => b.s >= CURVE_MIN_SECONDS_PER_BIN && b.dc > 0)
    .reduce((a, [, b]) => a + b.dc, 0) : 0;

  const referenceEta = dc > 0 ? r(ac / dc, 3) : null;
  const base = {
    pnomW: pnom,
    window,
    days: days.size,
    hours: r(seconds / 3600, 1),
    points,
    referenceEta,
    referenceFrac: usedDc > 0 ? r(fracDc / usedDc, 4) : null,
    inputHash,
  };

  let status = 'ok'; let reason = null;
  if (!(pnom > 0)) { status = 'insufficient_data'; reason = 'Nennleistung unbekannt'; }
  else if (days.size < CURVE_MIN_DAYS) { status = 'insufficient_data'; reason = `erst ${days.size} von ${CURVE_MIN_DAYS} Tagen mit Entladedaten`; }
  else if (seconds / 3600 < CURVE_MIN_HOURS) { status = 'insufficient_data'; reason = `erst ${r(seconds / 3600, 1)} von ${CURVE_MIN_HOURS} h Entladung`; }
  else if (referenceEta >= NOT_MEASURABLE_ETA) { status = 'not_measurable'; reason = 'Last wird aus dem Akku abgeleitet — Wirkungsgrad nicht messbar'; }
  else if (points.length < CURVE_MIN_POINTS) { status = 'insufficient_data'; reason = `erst ${points.length} von ${CURVE_MIN_POINTS} Lastbereichen mit genug Daten`; }
  else if (!(points[0][0] <= CURVE_LOW_LOAD_FRAC)) { status = 'insufficient_data'; reason = 'keine Daten im Schwachlastbereich'; }

  const out = { status, reason, ...base };
  out.curveHash = status === 'ok' ? sha({ points, referenceEta: base.referenceEta, referenceFrac: base.referenceFrac }) : null;
  return out;
}

/** η bei Lastanteil frac (linear interpoliert, an den Enden gehalten). */
export function etaAt(points, frac) {
  if (!Array.isArray(points) || !points.length) return null;
  if (frac <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x0, e0] = points[i - 1]; const [x1, e1] = points[i];
    if (frac <= x1) return e0 + ((frac - x0) / (x1 - x0)) * (e1 - e0);
  }
  return points[points.length - 1][1];
}
