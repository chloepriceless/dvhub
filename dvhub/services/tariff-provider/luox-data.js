// services/tariff-provider/luox-data.js — Antworten des LUOX-Portals in
// DVhub-Formate bringen (rein, ohne Netz; Tests: test/luox-data.test.js).
//
// Zeiten: Das Portal liefert Ortszeit (ENDPOINTS.md). Ob mit Versatz
// (+01:00), in UTC oder ohne Versatz, ist nicht zugesichert — alle drei Formen
// werden gelesen. Ohne Versatz ist eine Ortszeit am Tag der Zeitumstellung im
// Oktober doppelt (02:00–02:59 zweimal, 100 Viertelstunden): Die Liste ist
// zeitlich geordnet, also gilt die erste Lesart, die nach dem Vorgänger liegt.
// Im März fehlt 02:00–02:59 (92 Viertelstunden); eine solche Zeit gibt es
// nicht und wird verworfen.

import { zoneOffsetMs } from '../../tz-fast.js';
import { TariffProviderError, QUARTER_MS, localDateOf, addDaysToDate } from './common.js';
import { readXlsxRows } from './xlsx-lite.js';

const TIME_ZONE = 'Europe/Berlin';
const HOUR_MS = 3_600_000;

const ABSOLUTE_RX = /^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[zZ]|[+-]\d{2}:?\d{2})$/;
const NAIVE_ISO_RX = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;
const NAIVE_DE_RX = /^(\d{1,2})\.(\d{1,2})\.(\d{4})[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const TIME_ONLY_RX = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/** Mögliche UTC-Zeitpunkte einer Ortszeit (0 = gibt es nicht, 2 = doppelt). */
function localCandidates(y, mo, d, h, mi, s, timeZone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  if (!Number.isFinite(guess)) return [];
  const offsets = new Set([zoneOffsetMs(guess - 3 * HOUR_MS, timeZone), zoneOffsetMs(guess + 3 * HOUR_MS, timeZone)]);
  const out = [];
  for (const off of offsets) {
    const ms = guess - off;
    if (zoneOffsetMs(ms, timeZone) === off) out.push(ms);
  }
  return out.sort((a, b) => a - b);
}

function partsOf(value, defaultDate) {
  const s = String(value ?? '').trim();
  let m = s.match(NAIVE_ISO_RX);
  if (m) return [+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0)];
  m = s.match(NAIVE_DE_RX);
  if (m) return [+m[3], +m[2], +m[1], +m[4], +m[5], +(m[6] || 0)];
  m = s.match(TIME_ONLY_RX);
  if (m && defaultDate) {
    const [y, mo, d] = defaultDate.split('-').map(Number);
    return [y, mo, d, +m[1], +m[2], +(m[3] || 0)];
  }
  return null;
}

/**
 * Eine Folge von Zeitangaben (zeitlich geordnet) in ms; unlesbare = null.
 * @param {Array<string|number|null>} values
 * @param {{defaultDate?:string, timeZone?:string}} [opts]
 */
export function parseLuoxLocalTimes(values, { defaultDate = null, timeZone = TIME_ZONE } = {}) {
  let prev = null;
  return values.map((value) => {
    let ms = null;
    if (typeof value === 'number' && Number.isFinite(value)) {
      ms = value;
    } else {
      const s = String(value ?? '').trim();
      if (ABSOLUTE_RX.test(s)) {
        const t = Date.parse(s.replace(' ', 'T'));
        ms = Number.isFinite(t) ? t : null;
      } else {
        const p = partsOf(s, defaultDate);
        const cands = p ? localCandidates(...p, timeZone) : [];
        if (cands.length) ms = prev == null ? cands[0] : (cands.find((c) => c > prev) ?? cands[cands.length - 1]);
      }
    }
    if (ms != null) prev = ms;
    return ms;
  });
}

const finitePrice = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const round4 = (v) => Math.round(v * 10000) / 10000;

/**
 * epex_price_today/ → Day-Ahead-Viertelstunden.
 * @param {{today_data?:Array, tomorrow_data?:Array}} json  Portal-Antwort (€/MWh)
 * @returns {{rows:Array<{ts:number, eurMwh:number, ctKwh:number, durationMs:number}>, todayCount:number, tomorrowCount:number, today:string, tomorrow:string}}
 */
export function luoxDayAheadRows(json, { now = Date.now(), timeZone = TIME_ZONE } = {}) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new TariffProviderError('format', 'Unerwartete Preis-Antwort vom LUOX-Portal.');
  }
  const today = localDateOf(now, timeZone);
  const tomorrow = addDaysToDate(today, 1);
  const byTs = new Map();
  for (const [key, date] of [['today_data', today], ['tomorrow_data', tomorrow]]) {
    const list = Array.isArray(json[key]) ? json[key].filter((p) => p && typeof p === 'object') : [];
    const starts = parseLuoxLocalTimes(list.map((p) => p.start_time), { defaultDate: date, timeZone });
    const ends = parseLuoxLocalTimes(list.map((p) => p.end_time), { defaultDate: date, timeZone });
    list.forEach((p, i) => {
      const eur = finitePrice(p.price);
      const ts = starts[i];
      if (eur == null || ts == null) return;
      const d = ends[i] != null ? ends[i] - ts : NaN;
      const durationMs = d > 0 && d <= HOUR_MS ? d : QUARTER_MS;
      byTs.set(ts, { ts, eurMwh: eur, ctKwh: round4(eur / 10), durationMs });
    });
  }
  const rows = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  const count = (date) => rows.filter((r) => localDateOf(r.ts, timeZone) === date).length;
  return { rows, todayCount: count(today), tomorrowCount: count(tomorrow), today, tomorrow };
}

/**
 * energy_data/… (eigene Erzeugung/Einspeisung bzw. Verbrauch) → Abschnitte in Wh.
 * @returns {Array<{ts:number, durationMs:number, wh:number}>}
 */
export function parseEnergyData(list, { timeZone = TIME_ZONE } = {}) {
  if (!Array.isArray(list)) throw new TariffProviderError('format', 'Unerwartete Energiedaten vom LUOX-Portal.');
  const items = list.filter((x) => x && typeof x === 'object');
  const starts = parseLuoxLocalTimes(items.map((x) => x.start), { timeZone });
  const ends = parseLuoxLocalTimes(items.map((x) => x.end), { timeZone });
  const out = [];
  items.forEach((x, i) => {
    const wh = finitePrice(x.feed ?? x.supply ?? x.value);
    if (wh == null || starts[i] == null || ends[i] == null || !(ends[i] > starts[i])) return;
    out.push({ ts: starts[i], durationMs: ends[i] - starts[i], wh });
  });
  return out.sort((a, b) => a.ts - b.ts);
}

const str = (v) => (v == null || v === '' ? null : String(v));

/**
 * contracts → Übersicht ohne personenbezogene Daten (kein Name, keine
 * Adresse, kein Zähler, keine Marktlokation, keine Bankdaten).
 */
export function summarizeContracts(json) {
  const pick = (list, kind) => (Array.isArray(list) ? list : [])
    .filter((c) => c && typeof c === 'object' && c.saas_contract_id)
    .map((c) => ({
      id: String(c.saas_contract_id),
      kind,
      tariffType: str(c.tariff_type),
      status: str(c.deliv_status),
      regStatus: str(c.reg_status),
      deliveryStart: str(c.delivery_start),
      deliveryEnd: str(c.delivery_end),
      timeseriesCategory: str(c.timeseries_category)
    }));
  return {
    customerId: str(json?.saas_customer_id),
    contracts: [...pick(json?.consumer_delivering_points, 'consumer'), ...pick(json?.producer_delivering_points, 'producer')]
  };
}

/** Vertrag einer Art: die eingetragene Nummer, sonst ein liefernder, sonst der erste. */
export function pickContract(summary, kind, wantedId = '') {
  const list = (summary?.contracts || []).filter((c) => c.kind === kind);
  const label = kind === 'producer' ? 'Erzeuger-/Direktvermarktungsvertrag (P…)' : 'Stromliefervertrag (C…)';
  if (wantedId) {
    const hit = list.find((c) => c.id === wantedId);
    if (!hit) throw new TariffProviderError('no_contract', `Der eingetragene ${label} ist in diesem LUOX-Konto nicht zu finden.`);
    return hit;
  }
  const chosen = list.find((c) => c.status === 'delivering') || list[0];
  if (!chosen) throw new TariffProviderError('no_contract', `Kein ${label} im LUOX-Konto.`);
  return chosen;
}

// ── Abrechnungsschein der Direktvermarktung (XLSX) ────────────────────────
// epex_price/{P…}/{von}/{bis}/producer/ liefert je Viertelstunde Zeitstempel,
// Einspeisung (Wh), Day-Ahead-Preis (€/MWh) und Vergütung (EUR). Ob der
// Zeitstempel Beginn oder Ende der Viertelstunde ist, steht nirgends; gelesen
// wird er wie alle LUOX-Zeiten als Beginn (ungeprüft bis zum ersten Vergleich
// mit energy_data).

const EXCEL_EPOCH_DAYS = 25569; // 1970-01-01 als Excel-Datumszahl

function excelSerialToNaive(serial) {
  const ms = Math.round(((serial - EXCEL_EPOCH_DAYS) * 86_400_000) / 60_000) * 60_000;
  return new Date(ms).toISOString().slice(0, 19);
}

function findColumns(row) {
  const cells = (row || []).map((c) => String(c ?? '').toLowerCase());
  const find = (rx) => cells.findIndex((c) => rx.test(c));
  return {
    ts: find(/zeit|datum|timestamp/),
    feed: find(/einspeis|feed|messwert/),
    price: find(/preis|price|€\/mwh|eur\/mwh/),
    revenue: find(/vergütung|verguetung|erlös|erloes|revenue|\(eur\)/)
  };
}

/**
 * Tabelle des Abrechnungsscheins → Viertelstunden.
 * @param {Array<Array>} table  Zeilen (z. B. aus readXlsxRows)
 * @returns {{rows:Array<{ts:number,durationMs:number,feedWh:number|null,priceEurMwh:number|null,revenueEur:number|null}>, totals:{feedKwh:number, revenueEur:number}}}
 */
export function parseSettlementRows(table, { timeZone = TIME_ZONE } = {}) {
  const rowsIn = Array.isArray(table) ? table : [];
  let headerIdx = -1;
  let cols = null;
  for (let i = 0; i < Math.min(rowsIn.length, 30); i += 1) {
    const c = findColumns(rowsIn[i]);
    if (c.ts >= 0 && c.feed >= 0 && c.ts !== c.feed) { headerIdx = i; cols = c; break; }
  }
  if (!cols) throw new TariffProviderError('format', 'Abrechnungsschein ohne erkennbare Kopfzeile (Zeitstempel/Einspeisung).');
  const body = rowsIn.slice(headerIdx + 1).filter((r) => Array.isArray(r) && r.length);
  const tsValues = body.map((r) => {
    const v = r[cols.ts];
    if (typeof v === 'number' && Number.isFinite(v)) return excelSerialToNaive(v);
    // „01.11.2026 00:00 - 00:15“: Beginn nehmen
    return typeof v === 'string' ? v.split(/\s+-\s+/)[0].trim() : null;
  });
  const times = parseLuoxLocalTimes(tsValues, { timeZone });
  const num = (r, idx) => (idx >= 0 ? finitePrice(r[idx]) : null);
  const rows = [];
  body.forEach((r, i) => {
    if (times[i] == null) return;
    rows.push({
      ts: times[i],
      durationMs: QUARTER_MS,
      feedWh: num(r, cols.feed),
      priceEurMwh: num(r, cols.price),
      revenueEur: num(r, cols.revenue)
    });
  });
  rows.sort((a, b) => a.ts - b.ts);
  const sum = (key) => rows.reduce((s, r) => s + (r[key] ?? 0), 0);
  return {
    rows,
    totals: {
      feedKwh: Math.round(sum('feedWh')) / 1000,
      revenueEur: Math.round(sum('revenueEur') * 1e7) / 1e7
    }
  };
}

/** Abrechnungsschein direkt aus der XLSX-Datei. */
export function parseSettlementXlsx(buf, opts = {}) {
  return parseSettlementRows(readXlsxRows(buf), opts);
}
