/**
 * E-Auto: Wochenplan (Ankunft + Abfahrt je Wochentag) und Ziel-Ladestand fuer EOS.
 *
 * EOS (ab 0.4) kennt am Fahrzeug `min_soc_deadline_datetime`: bis zu diesem
 * Zeitpunkt muss `min_soc_percentage` erreicht sein. EOS nimmt dort einen
 * EINZELNEN Zeitpunkt — den Wochenplan rollt DVhub selbst weiter, und die
 * einmaligen Abweichungen (naechste Fahrt, heute spaeter heim) gehen vor.
 *
 * Wochenplan (optimizer.evWeeklyPlan, 7 Eintraege Mo..So): je Tag optional
 * eine Ankunft (Anstecken), eine Abfahrt und ein eigenes Ziel/Heimweg. Liegt
 * die Abfahrtszeit nicht nach der Ankunftszeit, ist sie am Folgetag (Ankunft
 * Mo 20:00, Abfahrt 05:00 → Di 05:00). Ohne Ankunft gilt die Abfahrt am Tag
 * selbst (so wie frueher „Mo–Fr 07:00“). Fehlt evWeeklyPlan (alte Config),
 * wird er aus evDepartureTime + evDepartureDays abgeleitet — gleiche Abfahrt
 * an diesen Tagen, keine Ankunft, also genau das alte Verhalten.
 *
 * Das Ziel kann in %, kWh (Energie im Fahrzeugakku bei Abfahrt) oder km
 * (Reichweite bei Abfahrt) angegeben werden; EOS rechnet nur in %. Ein
 * eigenes Ziel im Plan steht in derselben Einheit (optimizer.evTargetMode).
 *
 * Wichtig — der Vorlauf: Liegt die Abfahrt in der Vergangenheit, behandelt
 * EOS das Ziel als SOFORT faellig (genetic.py `_ev_deadline_slot`:
 * `max(deadline_slot, start_slot)`) und laedt mit voller Leistung. Eine
 * Abfahrt gilt deshalb schon DEPARTURE_LEAD_MS vorher als vorbei und wird auf
 * die naechste weitergeschoben — so sieht kein EOS-Lauf je einen vergangenen
 * Termin.
 */

export const DEPARTURE_LEAD_MS = 10 * 60_000;
const WEEK_DAYS = [1, 2, 3, 4, 5, 6, 7]; // ISO: 1 = Montag … 7 = Sonntag
const TARGET_MODES = ['percent', 'kwh', 'km'];

// Intl.DateTimeFormat anzulegen ist teuer; der Wochenplan rechnet je Aufruf
// gut 50 Termine — Formatierer je Zeitzone merken.
const FMT_CACHE = new Map();
function fmt(kind, timeZone) {
  const key = `${kind}|${timeZone}`;
  let f = FMT_CACHE.get(key);
  if (!f) {
    f = kind === 'offset'
      ? new Intl.DateTimeFormat('en-US', {
        timeZone, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      })
      : new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
    FMT_CACHE.set(key, f);
  }
  return f;
}

/** Offset der Zeitzone zu UTC in ms fuer einen Zeitpunkt (positiv = oestlich). */
function tzOffsetMs(utcMs, timeZone) {
  const parts = fmt('offset', timeZone).formatToParts(new Date(utcMs));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Lokale Wanduhrzeit (Jahr, Monat 1–12, Tag, Stunde, Minute) → UTC-Millisekunden. */
export function zonedToUtcMs(year, month, day, hour, minute, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let utc = guess - tzOffsetMs(guess, timeZone);
  // Zweiter Schritt fuer Termine direkt an einer Zeitumstellung.
  utc = guess - tzOffsetMs(utc, timeZone);
  return utc;
}

/** Kalenderdatum + ISO-Wochentag eines Zeitpunkts in der Zeitzone. */
function zonedDate(utcMs, timeZone) {
  const parts = fmt('date', timeZone).formatToParts(new Date(utcMs));
  const get = (t) => parts.find((p) => p.type === t).value;
  const wd = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[get('weekday')];
  return { year: Number(get('year')), month: Number(get('month')), day: Number(get('day')), isoWeekday: wd };
}

function parseTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const h = Number(m[1]); const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { h, min };
}

function normalizeDays(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[,\s]+/);
  const days = [...new Set(list.map(Number).filter((d) => WEEK_DAYS.includes(d)))].sort();
  return days;
}

/**
 * Naechste woechentliche Abfahrt nach `nowMs + leadMs`.
 * @returns {number|null} UTC-ms
 */
export function nextWeeklyDeparture({ time, days, timeZone, nowMs, leadMs = DEPARTURE_LEAD_MS }) {
  const t = parseTime(time);
  const wanted = normalizeDays(days);
  if (!t || !wanted.length) return null;
  const today = zonedDate(nowMs, timeZone);
  // Bis zu 8 Tage voraus: heute (falls noch nicht vorbei) plus eine volle Woche.
  for (let i = 0; i <= 7; i += 1) {
    const d = shiftDay(today, i);
    if (!wanted.includes(d.isoWeekday)) continue;
    const at = zonedToUtcMs(d.year, d.month, d.day, t.h, t.min, timeZone);
    if (at - leadMs > nowMs) return at;
  }
  return null;
}

/** Ziel in % Ladestand aus %, kWh oder km. null = nicht berechenbar. */
export function targetSocPct({ mode, value, capacityWh, consumptionKwhPer100km }) {
  const v = Number(value);
  if (!Number.isFinite(v) || v < 0) return null;
  let pct = null;
  if (mode === 'percent') pct = v;
  else if (mode === 'kwh') pct = capacityWh > 0 ? (v * 1000 / capacityWh) * 100 : null;
  else if (mode === 'km') {
    const c = Number(consumptionKwhPer100km);
    pct = (capacityWh > 0 && c > 0) ? ((v * c / 100) * 1000 / capacityWh) * 100 : null;
  }
  if (pct === null) return null;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

const HHMM_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;
const pad5 = (t) => String(t).padStart(5, '0');
const numOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * Der gueltige Wochenplan: immer 7 Eintraege Mo..So
 * `{ day, arrival: 'HH:MM'|'', departure: 'HH:MM'|'', targetValue: number|null, commuteKm: number|null }`.
 * Ohne evWeeklyPlan (alte Config) aus evDepartureTime + evDepartureDays.
 */
export function effectiveWeeklyPlan(opt = {}) {
  const empty = (day) => ({ day, arrival: '', departure: '', targetValue: null, commuteKm: null });
  if (Array.isArray(opt.evWeeklyPlan)) {
    const byDay = new Map();
    for (const e of opt.evWeeklyPlan) {
      const day = Number(e?.day);
      if (!WEEK_DAYS.includes(day) || byDay.has(day)) continue;
      const arrival = parseTime(e.arrival) ? pad5(String(e.arrival).trim()) : '';
      const departure = parseTime(e.departure) ? pad5(String(e.departure).trim()) : '';
      byDay.set(day, { day, arrival, departure, targetValue: numOrNull(e.targetValue), commuteKm: numOrNull(e.commuteKm) });
    }
    return WEEK_DAYS.map((d) => byDay.get(d) || empty(d));
  }
  const time = parseTime(opt.evDepartureTime ?? '07:00') ? pad5(String(opt.evDepartureTime ?? '07:00').trim()) : '';
  const days = normalizeDays(opt.evDepartureDays ?? [1, 2, 3, 4, 5]);
  return WEEK_DAYS.map((d) => ({ ...empty(d), departure: time && days.includes(d) ? time : '' }));
}

/**
 * Kalendertag + Offset → { year, month, day, isoWeekday } (ueber Monats-/
 * Jahresgrenzen). Reine Kalenderrechnung, OHNE Zeitzone: ueber 12:00 UTC
 * zurueckzurechnen ergaebe oestlich von UTC+12 schon den Folgetag.
 */
function shiftDay(d, offset) {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + offset));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate(), isoWeekday: ((t.getUTCDay() + 6) % 7) + 1 };
}

/**
 * Alle Fenster des Plans rund um `nowMs` (8 Tage zurueck, 8 voraus), nach
 * Abfahrt sortiert: { day, arrivalMs|null, departureMs, targetValue, commuteKm }.
 */
function planWindows(plan, timeZone, nowMs) {
  const today = zonedDate(nowMs, timeZone);
  const out = [];
  for (let i = -8; i <= 8; i += 1) {
    const d = shiftDay(today, i);
    const e = plan[d.isoWeekday - 1];
    const dep = parseTime(e?.departure);
    if (!dep) continue;
    const arr = parseTime(e.arrival);
    let arrivalMs = null;
    let depDay = d;
    if (arr) {
      arrivalMs = zonedToUtcMs(d.year, d.month, d.day, arr.h, arr.min, timeZone);
      // Abfahrt nicht nach der Ankunft → am Folgetag (20:00 → 05:00).
      if (dep.h * 60 + dep.min <= arr.h * 60 + arr.min) depDay = shiftDay(d, 1);
    }
    const departureMs = zonedToUtcMs(depDay.year, depDay.month, depDay.day, dep.h, dep.min, timeZone);
    // Ankunft in der Luecke der Zeitumstellung (So 02:30 gibt es im Maerz
    // nicht, sie rutscht auf 03:30) kann hinter die Abfahrt fallen — dann
    // ohne Ankunft.
    if (arrivalMs !== null && arrivalMs >= departureMs) arrivalMs = null;
    out.push({ day: d.isoWeekday, arrivalMs, departureMs, targetValue: e.targetValue, commuteKm: e.commuteKm });
  }
  return out.sort((a, b) => a.departureMs - b.departureMs);
}

/**
 * Das naechste Fenster (Ankunft → Abfahrt) aus Wochenplan + einmaligen
 * Abweichungen. Regeln:
 *   - Eine Abfahrt gilt DEPARTURE_LEAD_MS vorher als vorbei.
 *   - Einmalige Abfahrt (evDepartureOnce) geht vor, solange sie kommt; die
 *     Ankunft (und Ziel/Heimweg) des naechsten Wochenfensters bleibt, wenn sie
 *     davor liegt — „morgen erst 06:30 statt 05:00“.
 *   - Einmalige Ankunft (evArrivalOnce) ersetzt die Ankunft des Fensters, in
 *     dessen Luecke sie faellt: nach der letzten Abfahrt, vor dessen Abfahrt.
 *     Danach rollt alles von selbst weiter.
 *   - tripStartMs = letzte vergangene Abfahrt (Beginn der Fahrt, nach der das
 *     Auto zur Ankunft wieder heimkommt); null, wenn keine bekannt.
 */
export function resolveEvWindow(opt = {}, timeZone = 'Europe/Berlin', nowMs = Date.now()) {
  const gone = (ms) => ms - DEPARTURE_LEAD_MS <= nowMs;
  const windows = planWindows(effectiveWeeklyPlan(opt), timeZone, nowMs);
  const onceDep = Date.parse(opt.evDepartureOnce || '');
  const onceArr = Date.parse(opt.evArrivalOnce || '');
  const onceActive = Number.isFinite(onceDep) && !gone(onceDep);
  // Die einmalige Abfahrt ersetzt die Abfahrt EINES regulaeren Fensters
  // (hoechstens 24 h entfernt): dieses behaelt Ankunft, Ziel und Heimweg, und
  // seine eigene Abfahrt zaehlt nicht als Fahrt — auch nachdem sie verstrichen
  // ist. Welches Fenster:
  //   1. das naechste noch kommende, wenn es eine Ankunft VOR der einmaligen
  //      Abfahrt hat — das Auto ist dann da, die Abfahrt wird vorgezogen
  //      oder verschoben (Fr mittags: „heute 17:00 statt Sa 09:00“);
  //   2. sonst das naechstgelegene (Abfahrt bis 24 h entfernt, Ankunft —
  //      falls eingetragen — vor der einmaligen Abfahrt). Ohne Ankunftszeiten
  //      (alte Config, reiner Abfahrtsplan) ist das die verschobene Fahrt von
  //      eben, nicht die von morgen.
  let superseded = null;
  if (onceActive) {
    const DAY = 24 * 3600_000;
    const arrivedBefore = (w) => w.arrivalMs === null || w.arrivalMs < onceDep;
    const next = windows.find((w) => !gone(w.departureMs));
    if (next && next.arrivalMs !== null && next.arrivalMs < onceDep && Math.abs(next.departureMs - onceDep) < DAY) superseded = next;
    else {
      for (const w of windows) {
        const diff = Math.abs(w.departureMs - onceDep);
        if (diff >= DAY || !arrivedBefore(w)) continue;
        if (!superseded || diff < Math.abs(superseded.departureMs - onceDep)) superseded = w;
      }
    }
  }
  const past = windows.filter((w) => w !== superseded && gone(w.departureMs)).map((w) => w.departureMs);
  if (Number.isFinite(onceDep) && gone(onceDep)) past.push(onceDep);
  const tripStartMs = past.length ? Math.max(...past) : null;
  const afterTripStart = (ms) => tripStartMs === null || ms > tripStartMs;
  const nextWeekly = windows.find((w) => !gone(w.departureMs)) || null;

  let win = null;
  if (onceActive) {
    win = { day: null, arrivalMs: null, departureMs: onceDep, targetValue: null, commuteKm: null, source: 'once', arrivalSource: null };
    const inGap = (w) => w && w.arrivalMs !== null && afterTripStart(w.arrivalMs) && w.arrivalMs < onceDep;
    const base = superseded || (inGap(nextWeekly) ? nextWeekly : null);
    if (base) {
      Object.assign(win, { day: base.day, targetValue: base.targetValue, commuteKm: base.commuteKm });
      if (base.arrivalMs !== null && afterTripStart(base.arrivalMs) && base.arrivalMs < onceDep) {
        Object.assign(win, { arrivalMs: base.arrivalMs, arrivalSource: 'weekly' });
      }
    }
  } else if (nextWeekly) {
    win = { ...nextWeekly, source: 'weekly', arrivalSource: nextWeekly.arrivalMs !== null ? 'weekly' : null };
    // Widerspruechlicher Plan (Ankunft vor einer spaeteren Abfahrt): keine Ankunft.
    if (win.arrivalMs !== null && !afterTripStart(win.arrivalMs)) { win.arrivalMs = null; win.arrivalSource = null; }
  }
  if (win && Number.isFinite(onceArr) && onceArr < win.departureMs && afterTripStart(onceArr)) {
    win.arrivalMs = onceArr;
    win.arrivalSource = 'once';
  }
  return { window: win, tripStartMs };
}

/**
 * Die gerade gueltige Abfahrt (und Ankunft) aus der Config.
 *
 * @returns {{
 *   enabled: boolean, departureAt: string|null, source: 'once'|'weekly'|null,
 *   arrivalAt: string|null, arrivalSource: 'once'|'weekly'|null,
 *   tripStartAt: string|null, day: number|null, commuteKm: number,
 *   targetSocPct: number|null, mode: string, value: number|null,
 *   timeZone: string, reason?: string
 * }}
 */
export function resolveEvDeparture(cfg, nowMs = Date.now()) {
  const opt = cfg?.optimizer || {};
  const timeZone = cfg?.schedule?.timezone || 'Europe/Berlin';
  const mode = TARGET_MODES.includes(opt.evTargetMode) ? opt.evTargetMode : 'percent';
  const value = Number.isFinite(Number(opt.evTargetValue)) ? Number(opt.evTargetValue) : null;
  const base = {
    enabled: opt.evDepartureEnabled === true, departureAt: null, source: null,
    arrivalAt: null, arrivalSource: null, tripStartAt: null, day: null,
    commuteKm: Math.max(0, Number(opt.evCommuteKm) || 0),
    targetSocPct: null, mode, value, timeZone
  };
  if (!base.enabled) return { ...base, reason: 'aus' };

  const pctFor = (v) => targetSocPct({
    mode, value: v,
    capacityWh: Number(opt.evCapacityWh) || 50000,
    consumptionKwhPer100km: opt.evConsumptionKwhPer100km
  });
  const pct = pctFor(value);
  if (pct === null) return { ...base, reason: 'Ziel nicht berechenbar' };

  const { window: w, tripStartMs } = resolveEvWindow(opt, timeZone, nowMs);
  const tripStartAt = tripStartMs !== null ? new Date(tripStartMs).toISOString() : null;
  if (!w) return { ...base, tripStartAt, targetSocPct: pct, reason: 'keine Abfahrt geplant' };
  const own = w.targetValue !== null && w.targetValue !== undefined ? pctFor(w.targetValue) : null;
  return {
    ...base,
    departureAt: new Date(w.departureMs).toISOString(),
    source: w.source,
    arrivalAt: w.arrivalMs !== null ? new Date(w.arrivalMs).toISOString() : null,
    arrivalSource: w.arrivalSource,
    tripStartAt,
    day: w.day,
    commuteKm: w.commuteKm !== null && w.commuteKm !== undefined ? Math.max(0, Number(w.commuteKm)) : base.commuteKm,
    value: own !== null ? Number(w.targetValue) : value,
    targetSocPct: own !== null ? own : pct
  };
}

function parseIsoOrEmpty(v) {
  const s = String(v || '').trim();
  if (!s) return { ok: true, value: '' };
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? { ok: true, value: new Date(ms).toISOString() } : { ok: false };
}

/** Wochenplan aus einer Eingabe pruefen → 7 Eintraege Mo..So. */
function parseWeeklyPlan(list, prefix) {
  if (!Array.isArray(list) || list.length > 7) return { ok: false, error: `${prefix}.weeklyPlan must be a list of up to 7 days` };
  const byDay = new Map();
  for (let i = 0; i < list.length; i += 1) {
    const e = list[i];
    const p = `${prefix}.weeklyPlan[${i}]`;
    if (!e || typeof e !== 'object') return { ok: false, error: `${p} must be an object` };
    const day = Number(e.day);
    if (!WEEK_DAYS.includes(day) || byDay.has(day)) return { ok: false, error: `${p}.day must be a unique weekday 1..7` };
    const times = {};
    for (const k of ['arrival', 'departure']) {
      const raw = e[k] === null || e[k] === undefined ? '' : String(e[k]).trim();
      if (raw && !HHMM_RE.test(raw)) return { ok: false, error: `${p}.${k} must be HH:MM or empty` };
      times[k] = raw ? pad5(raw) : '';
    }
    if (times.arrival && !times.departure) return { ok: false, error: `${p}.departure is required with an arrival` };
    const targetValue = numOrNull(e.targetValue);
    if (e.targetValue !== null && e.targetValue !== undefined && e.targetValue !== ''
      && (targetValue === null || targetValue < 0 || targetValue > 2000)) return { ok: false, error: `${p}.targetValue must be 0..2000 or empty` };
    const commuteKm = numOrNull(e.commuteKm);
    if (e.commuteKm !== null && e.commuteKm !== undefined && e.commuteKm !== ''
      && (commuteKm === null || commuteKm < 0 || commuteKm > 1000)) return { ok: false, error: `${p}.commuteKm must be 0..1000 or empty` };
    byDay.set(day, { day, arrival: times.arrival, departure: times.departure, targetValue, commuteKm });
  }
  return { ok: true, plan: WEEK_DAYS.map((d) => byDay.get(d) || { day: d, arrival: '', departure: '', targetValue: null, commuteKm: null }) };
}

/**
 * Eingaben fuer Wochenplan, Abfahrt + Ziel pruefen (Integrationsseite und
 * Leitstand-Kachel). Nur Felder, die im Objekt stehen, landen im Patch.
 *
 * Die alten Felder `time`/`days` setzen evWeeklyPlan auf null zurueck (ausser
 * im selben Aufruf kommt ein Plan): wer noch die alte Oberflaeche offen hat,
 * bekommt genau das, was er dort sieht.
 *
 * @returns {{ ok: true, patch: object } | { ok: false, error: string }}
 */
export function parseEvDeparturePatch(d, prefix = 'departure') {
  if (!d || typeof d !== 'object') return { ok: false, error: `${prefix} must be an object` };
  const patch = {};
  if ('enabled' in d) patch.evDepartureEnabled = d.enabled === true;
  if ('time' in d) {
    if (!HHMM_RE.test(String(d.time))) return { ok: false, error: `${prefix}.time must be HH:MM` };
    patch.evDepartureTime = pad5(d.time);
  }
  if ('days' in d) {
    const days = Array.isArray(d.days) ? [...new Set(d.days.map(Number))].filter((x) => Number.isInteger(x) && x >= 1 && x <= 7).sort() : null;
    if (!days) return { ok: false, error: `${prefix}.days must be a list of 1..7` };
    patch.evDepartureDays = days;
  }
  if ('weeklyPlan' in d) {
    const wp = parseWeeklyPlan(d.weeklyPlan, prefix);
    if (!wp.ok) return wp;
    patch.evWeeklyPlan = wp.plan;
  } else if ('time' in d || 'days' in d) {
    patch.evWeeklyPlan = null;
  }
  if ('once' in d) {
    const once = parseIsoOrEmpty(d.once);
    if (!once.ok) return { ok: false, error: `${prefix}.once must be an ISO date time or empty` };
    patch.evDepartureOnce = once.value;
  }
  if ('arrivalOnce' in d) {
    const once = parseIsoOrEmpty(d.arrivalOnce);
    if (!once.ok) return { ok: false, error: `${prefix}.arrivalOnce must be an ISO date time or empty` };
    patch.evArrivalOnce = once.value;
  }
  if ('commuteKm' in d) {
    const v = Number(d.commuteKm);
    if (d.commuteKm === null || d.commuteKm === '' || !Number.isFinite(v) || v < 0 || v > 1000) return { ok: false, error: `${prefix}.commuteKm must be 0..1000` };
    patch.evCommuteKm = v;
  }
  if ('targetMode' in d) {
    if (!TARGET_MODES.includes(d.targetMode)) return { ok: false, error: `${prefix}.targetMode must be percent|kwh|km` };
    patch.evTargetMode = d.targetMode;
  }
  if ('targetValue' in d) {
    const v = Number(d.targetValue);
    if (!Number.isFinite(v) || v < 0 || v > 2000) return { ok: false, error: `${prefix}.targetValue must be 0..2000` };
    patch.evTargetValue = v;
  }
  if ('consumptionKwhPer100km' in d) {
    const v = Number(d.consumptionKwhPer100km);
    if (!Number.isFinite(v) || v < 5 || v > 60) return { ok: false, error: `${prefix}.consumptionKwhPer100km must be 5..60` };
    patch.evConsumptionKwhPer100km = v;
  }
  return { ok: true, patch };
}

/**
 * E-Auto-Plan aus den EOS-Slots (Inspector-Zeilen: ts_utc, evChargeFactor,
 * evSocPct) fuer die Leitstand-Kachel: Slots im Fenster plus Kennzahlen bis zur
 * Abfahrt — geplante Energie, Ladestand bei Abfahrt, ab wann das Ziel steht.
 * evSocPct ist der Ladestand zu BEGINN des Slots (EOS-Ausgabe).
 */
export function summarizeEvPlan(rows, { maxChargeW, slotMinutes = 15, nowMs = Date.now(), departureAt = null, targetSocPct = null, horizonMs = 24 * 3600_000 } = {}) {
  const slotMs = slotMinutes * 60_000;
  const depMs = Date.parse(departureAt || '');
  const endMs = Number.isFinite(depMs) ? Math.max(nowMs + horizonMs, depMs + 3600_000) : nowMs + horizonMs;
  const slots = (Array.isArray(rows) ? rows : [])
    .map((r) => {
      const ts = Date.parse(r.ts_utc);
      // null = EOS plant kein Auto (nicht angemeldet) — nicht als 0 W lesen.
      const f = r.evChargeFactor === null || r.evChargeFactor === undefined ? NaN : Number(r.evChargeFactor);
      return {
        ts,
        powerW: Number.isFinite(f) ? Math.max(0, Math.round(f * (Number(maxChargeW) || 0))) : null,
        socPct: r.evSocPct !== null && r.evSocPct !== undefined && Number.isFinite(Number(r.evSocPct)) ? Number(r.evSocPct) : null
      };
    })
    .filter((s) => Number.isFinite(s.ts) && s.ts + slotMs > nowMs && s.ts < endMs)
    .sort((a, b) => a.ts - b.ts);
  const hasEv = slots.some((s) => s.powerW !== null || s.socPct !== null);
  const untilDep = Number.isFinite(depMs) ? slots.filter((s) => s.ts < depMs) : slots;
  const energyWh = untilDep.reduce((a, s) => a + (s.powerW || 0) * slotMinutes / 60, 0);
  // Ladestand bei Abfahrt: Start-SoC des Slots, in dem die Abfahrt liegt.
  let socAtDeparture = null;
  if (Number.isFinite(depMs)) {
    const at = slots.find((s) => s.ts <= depMs && depMs < s.ts + slotMs) || null;
    socAtDeparture = at?.socPct ?? null;
  }
  let targetReachedAt = null;
  if (Number.isFinite(Number(targetSocPct))) {
    const hit = untilDep.find((s) => s.socPct !== null && s.socPct >= Number(targetSocPct));
    if (hit) targetReachedAt = new Date(hit.ts).toISOString();
  }
  // Zusammenhaengende Ladefenster fuer die Textzeile.
  const windows = [];
  for (const s of untilDep) {
    if (!(s.powerW > 0)) continue;
    const last = windows[windows.length - 1];
    if (last && last.endMs === s.ts) { last.endMs = s.ts + slotMs; last.maxW = Math.max(last.maxW, s.powerW); last.wh += s.powerW * slotMinutes / 60; }
    else windows.push({ startMs: s.ts, endMs: s.ts + slotMs, maxW: s.powerW, wh: s.powerW * slotMinutes / 60 });
  }
  return {
    hasEv,
    slotMinutes,
    slots: slots.map((s) => ({ ts: new Date(s.ts).toISOString(), powerW: s.powerW, socPct: s.socPct })),
    energyKwh: Math.round(energyWh / 100) / 10,
    socAtDeparture,
    targetReachedAt,
    windows: windows.map((w) => ({ start: new Date(w.startMs).toISOString(), end: new Date(w.endMs).toISOString(), maxW: w.maxW, kwh: Math.round(w.wh / 100) / 10 }))
  };
}
