/**
 * E-Auto: Wochenplan (Ankunft + Abfahrt je Wochentag) und Ziel-Ladestand fuer EOS.
 *
 * EOS (ab 0.4) kennt am Fahrzeug `min_soc_deadline_datetime`: bis zu diesem
 * Zeitpunkt muss `min_soc_percentage` erreicht sein. EOS nimmt dort einen
 * EINZELNEN Zeitpunkt — den Wochenplan rollt DVhub selbst weiter. Einmalige
 * Abweichungen (Einmal-Ziel, heute spaeter heim) ersetzen hoechstens EINE
 * regulaere Abfahrt bzw. Ankunft; die uebrigen Abfahrten bleiben.
 *
 * Wochenplan (optimizer.evWeeklyPlan, 7 Eintraege Mo..So): je Tag optional
 * eine Ankunft (Anstecken), eine Abfahrt, ein eigenes Mindestziel und der
 * Verbrauch der Fahrt danach in % (seit 1.0.10; ein alter Heimweg in km
 * zaehlt seit 10.11.2026 nicht mehr). Liegt
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
// Nur echte Zahlen bzw. Zahlen als Text: Number([]) = 0, Number(' ') = 0 und
// Number(true) = 1 hießen sonst „Mindest-Ladestand 0 %“ (Restbefund Codex P2).
const numOrNull = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Zahl in [0, 100] oder null (leer / ungültig). */
const pctOrNull = (v) => {
  const n = numOrNull(v);
  return n === null || n < 0 || n > 100 ? null : n;
};
const emptyRow = (day) => ({ day, arrival: '', departure: '', minSocPct: null, tripSocPct: null });

/**
 * Wochenplan in SoC-% (seit 1.0.10): je Zeile `minSocPct` (Mindest-Ladestand
 * bei dieser Abfahrt, leer = allgemeiner Ziel-Ladestand) und `tripSocPct`
 * (erwarteter Verbrauch der Fahrt ab dieser Abfahrt bis zur nächsten Ankunft).
 *
 * Übernahme alter Zeilen (bis 1.0.9: `targetValue` in der Einheit von
 * evTargetMode, `commuteKm` = Heimweg zur Ankunft DIESER Zeile):
 *   - targetValue → minSocPct (kWh/km einmalig über Kapazität und Verbrauch in %);
 *   - der Heimweg (je Zeile `commuteKm`, allgemein evCommuteKm) wird NICHT in
 *     Fahrten umgerechnet und fließt nirgends mehr in die Planung ein
 *     (Christin 10.11.2026: „Der Heimweg ist ja immer anders … woher weiß man,
 *     ob man auf dem Heimweg ist oder noch woanders hinfährt?“). Geplant wird
 *     nur mit dem je Abfahrt eingetragenen Fahrtverbrauch (tripSocPct); die
 *     Oberfläche weist auf einen alten allgemeinen Heimweg hin.
 * Zeilen mit den neuen Feldern bleiben, wie sie sind.
 */
export function migrateWeeklyPlanRows(list, opt = {}) {
  const rows = Array.isArray(list) ? list : [];
  const byDay = new Map();
  for (const e of rows) {
    const day = Number(e?.day);
    if (!WEEK_DAYS.includes(day) || byDay.has(day)) continue;
    byDay.set(day, e);
  }
  const mode = TARGET_MODES.includes(opt.evTargetMode) ? opt.evTargetMode : 'percent';
  const capacityWh = Number(opt.evCapacityWh) || 50000;
  const cons = Number(opt.evConsumptionKwhPer100km) || 18;
  return WEEK_DAYS.map((day) => {
    const e = byDay.get(day);
    if (!e) return emptyRow(day);
    const arrival = parseTime(e.arrival) ? pad5(String(e.arrival).trim()) : '';
    const departure = parseTime(e.departure) ? pad5(String(e.departure).trim()) : '';
    let minSocPct;
    if (Object.prototype.hasOwnProperty.call(e, 'minSocPct')) minSocPct = pctOrNull(e.minSocPct);
    else if (numOrNull(e.targetValue) !== null) minSocPct = targetSocPct({ mode, value: e.targetValue, capacityWh, consumptionKwhPer100km: cons });
    else minSocPct = null;
    return { day, arrival, departure, minSocPct, tripSocPct: pctOrNull(e.tripSocPct) };
  });
}

/**
 * Der gueltige Wochenplan: immer 7 Eintraege Mo..So
 * `{ day, arrival: 'HH:MM'|'', departure: 'HH:MM'|'', minSocPct: number|null, tripSocPct: number|null }`.
 * Ohne evWeeklyPlan (alte Config) aus evDepartureTime + evDepartureDays.
 */
export function effectiveWeeklyPlan(opt = {}) {
  if (Array.isArray(opt.evWeeklyPlan)) return migrateWeeklyPlanRows(opt.evWeeklyPlan, opt);
  const time = parseTime(opt.evDepartureTime ?? '07:00') ? pad5(String(opt.evDepartureTime ?? '07:00').trim()) : '';
  const days = normalizeDays(opt.evDepartureDays ?? [1, 2, 3, 4, 5]);
  // Ohne Ziele und Fahrten — der alte Heimweg (evCommuteKm) zählt nicht mehr
  // (Christin 10.11.2026).
  return WEEK_DAYS.map((d) => ({ ...emptyRow(d), departure: time && days.includes(d) ? time : '' }));
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
 * Rutscht die Abfahrt dieser Zeile auf den Folgetag? Nur mit Ankunft und
 * wenn die Abfahrt nicht nach ihr liegt (20:00 → 05:00). Ohne Ankunft gilt
 * die Abfahrt am Tag der Zeile. Die Oberflaeche (public/ev-weekly-editor.js
 * rowInfo) zeigt dieselbe Regel; test/ev-plan-visibility.test.js haelt beide
 * gleich.
 */
export function departsNextDay(entry) {
  const dep = parseTime(entry?.departure);
  const arr = parseTime(entry?.arrival);
  return !!(dep && arr && dep.h * 60 + dep.min <= arr.h * 60 + arr.min);
}

/**
 * Falle im Wochenplan (Prod 29.10.2026): „Mittwoch, Abfahrt 02:00“ ohne
 * Ankunft gilt Mittwoch 02:00 — gemeint ist oft die Nacht danach. Bei einer
 * Abfahrt vor EARLY_DEPARTURE_HINT_BEFORE ohne Ankunft zeigt die Oberflaeche
 * deshalb, welcher Tag gilt und wie man die Nacht danach eintraegt. Nur ein
 * Hinweis: an der Bedeutung bestehender Plaene aendert sich nichts.
 *
 * Warum 06:00: Bis dahin ist es fuer viele noch „die Nacht“ des Vortags;
 * die uebliche Abfahrt zur Arbeit (alter Standard Mo–Fr 07:00) liegt danach
 * und bekommt keinen Hinweis.
 */
export const EARLY_DEPARTURE_HINT_BEFORE = '06:00';
export function earlyDepartureWithoutArrival(entry) {
  const dep = parseTime(entry?.departure);
  const limit = parseTime(EARLY_DEPARTURE_HINT_BEFORE);
  return !!(dep && !parseTime(entry?.arrival) && dep.h * 60 + dep.min < limit.h * 60 + limit.min);
}

/**
 * Alle Fenster des Plans rund um `nowMs` (8 Tage zurueck, 8 voraus), nach
 * Abfahrt sortiert: { day, arrivalMs|null, departureMs, minSocPct, tripSocPct }.
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
      if (departsNextDay(e)) depDay = shiftDay(d, 1);
    }
    const departureMs = zonedToUtcMs(depDay.year, depDay.month, depDay.day, dep.h, dep.min, timeZone);
    // Ankunft in der Luecke der Zeitumstellung (So 02:30 gibt es im Maerz
    // nicht, sie rutscht auf 03:30) kann hinter die Abfahrt fallen — dann
    // ohne Ankunft.
    if (arrivalMs !== null && arrivalMs >= departureMs) arrivalMs = null;
    out.push({ day: d.isoWeekday, arrivalMs, departureMs, minSocPct: e.minSocPct ?? null, tripSocPct: e.tripSocPct ?? null });
  }
  return out.sort((a, b) => a.departureMs - b.departureMs);
}

const DAY_MS = 24 * 3600_000;

/**
 * Das Wochenplan-Fenster, dessen Abfahrt die einmalige Abfahrt `onceDep`
 * ersetzt (Regeln bei resolveEvWindow), oder null. Bestimmt immer von kurz vor
 * der einmaligen Abfahrt aus — unabhaengig davon, wann gefragt wird.
 */
function supersededWindow(plan, timeZone, onceDep) {
  const refNow = onceDep - DEPARTURE_LEAD_MS - 1;
  const goneAt = (ms) => ms - DEPARTURE_LEAD_MS <= refNow;
  const arrivedBefore = (w) => w.arrivalMs === null || w.arrivalMs < onceDep;
  const around = planWindows(plan, timeZone, refNow);
  let pick = null;
  const next = around.find((w) => !goneAt(w.departureMs));
  if (next && next.arrivalMs !== null && next.arrivalMs < onceDep && Math.abs(next.departureMs - onceDep) < DAY_MS) pick = next;
  else {
    for (const w of around) {
      const diff = Math.abs(w.departureMs - onceDep);
      if (diff >= DAY_MS || !arrivedBefore(w)) continue;
      if (!pick || diff < Math.abs(pick.departureMs - onceDep)) pick = w;
    }
  }
  return pick;
}

/**
 * Das naechste Fenster (Ankunft → Abfahrt) aus Wochenplan + einmaligen
 * Abweichungen. Regeln:
 *   - Eine Abfahrt gilt DEPARTURE_LEAD_MS vorher als vorbei.
 *   - Einmalige Abfahrt (evDepartureOnce) ersetzt hoechstens EINE regulaere
 *     Abfahrt (siehe unten); die Ankunft (und Ziel/Fahrt) dieses Fensters
 *     bleibt, wenn sie davor liegt — „morgen erst 06:30 statt 05:00“.
 *     Wochenplan-Abfahrten VOR der einmaligen bleiben mit Mindestziel und
 *     Frist und kommen zuerst; die einmalige ist dran, wenn sie vorbei sind
 *     (Fable R5 P2-1: „Do 09:00 einmalig 100 %“ am Montag liess sonst Di und
 *     Mi 07:00 fallen, ein Ziel in drei Wochen den ganzen Plan).
 *   - Einmalige Ankunft (evArrivalOnce) ersetzt die Ankunft des Fensters, in
 *     dessen Luecke sie faellt: nach der letzten Abfahrt, vor dessen Abfahrt.
 *     Danach rollt alles von selbst weiter.
 *   - tripStartMs = letzte vergangene Abfahrt (Beginn der Fahrt, nach der das
 *     Auto zur Ankunft wieder heimkommt); null, wenn keine bekannt.
 */
export function resolveEvWindow(opt = {}, timeZone = 'Europe/Berlin', nowMs = Date.now()) {
  const gone = (ms) => ms - DEPARTURE_LEAD_MS <= nowMs;
  const plan = effectiveWeeklyPlan(opt);
  const windows = planWindows(plan, timeZone, nowMs);
  const onceDep = Date.parse(opt.evDepartureOnce || '');
  const onceArr = Date.parse(opt.evArrivalOnce || '');
  const onceActive = Number.isFinite(onceDep) && !gone(onceDep);
  const onceMin = pctOrNull(opt.evDepartureOnceMinSocPct);
  const onceTrip = pctOrNull(opt.evDepartureOnceTripSocPct);
  // Die einmalige Abfahrt ersetzt die Abfahrt EINES regulaeren Fensters
  // (hoechstens 24 h entfernt): dieses behaelt Ankunft, Ziel und Fahrt, und
  // seine eigene Abfahrt zaehlt nicht als Fahrt — auch nachdem sie verstrichen
  // ist, und auch nachdem die einmalige Abfahrt selbst vorbei ist (sonst kaeme
  // eine ersetzte spaetere Abfahrt danach als Phantom-Fahrt zurueck: „Mi 06:00
  // statt 07:30“ — um 06:30 ist das Auto weg, 07:30 gibt es nicht). Welches
  // Fenster (bewertet, solange die einmalige Abfahrt noch kam):
  //   1. das naechste noch kommende, wenn es eine Ankunft VOR der einmaligen
  //      Abfahrt hat — das Auto ist dann da, die Abfahrt wird vorgezogen
  //      oder verschoben (Fr mittags: „heute 17:00 statt Sa 09:00“);
  //   2. sonst das naechstgelegene (Abfahrt bis 24 h entfernt, Ankunft —
  //      falls eingetragen — vor der einmaligen Abfahrt). Ohne Ankunftszeiten
  //      (alte Config, reiner Abfahrtsplan) ist das die verschobene Fahrt von
  //      eben, nicht die von morgen.
  // „Das naechste noch kommende“ zaehlt immer von kurz vor der einmaligen
  // Abfahrt aus, nicht von jetzt: welche Abfahrt ersetzt ist, haengt sonst von
  // der Uhrzeit ab (einmalig Do 20:00 bei Ankunft 18:00 → Abfahrt 07:00: am
  // Montag ersetzt Fr 07:00, am Mittwochabend Do 07:00 — Fable R5 P2-1). Die
  // Fenster dafuer rund um die einmalige Abfahrt, damit auch ein Ziel in
  // Wochen dieselbe Abfahrt ersetzt.
  let superseded = null;
  // Auch nach der einmaligen Abfahrt (so weit planWindows zurückreicht): die
  // ersetzte Abfahrt wird nie zur Fahrt, die Einmal-Fahrt bleibt bis zur
  // nächsten echten Abfahrt die laufende (Codex 52c5ee20).
  if (Number.isFinite(onceDep) && (onceActive || nowMs - onceDep < 7 * DAY_MS)) {
    const pick = supersededWindow(plan, timeZone, onceDep);
    // Liegt die ersetzte Abfahrt ausserhalb der Fenster um jetzt, ist hier
    // nichts auszublenden.
    if (pick) superseded = windows.find((w) => w.departureMs === pick.departureMs) || null;
  }
  const candidates = windows.filter((w) => w !== superseded);
  const pastWindows = candidates.filter((w) => gone(w.departureMs));
  const past = pastWindows.map((w) => w.departureMs);
  if (Number.isFinite(onceDep) && gone(onceDep)) past.push(onceDep);
  const tripStartMs = past.length ? Math.max(...past) : null;
  // Fahrt, von der das Auto zur naechsten Ankunft heimkommt (in %).
  let prevTripSocPct = null;
  if (tripStartMs !== null) {
    if (Number.isFinite(onceDep) && tripStartMs === onceDep) prevTripSocPct = onceTrip ?? superseded?.tripSocPct ?? null;
    else prevTripSocPct = pastWindows.find((w) => w.departureMs === tripStartMs)?.tripSocPct ?? null;
  }
  const afterTripStart = (ms) => tripStartMs === null || ms > tripStartMs;
  const nextWeekly = candidates.find((w) => !gone(w.departureMs)) || null;

  // Eine nicht ersetzte Wochenplan-Abfahrt vor der einmaligen kommt zuerst.
  const onceNext = onceActive && !(nextWeekly && nextWeekly.departureMs < onceDep);
  let win = null;
  if (onceNext) {
    win = { day: null, arrivalMs: null, departureMs: onceDep, minSocPct: onceMin, tripSocPct: onceTrip, source: 'once', arrivalSource: null };
    const inGap = (w) => w && w.arrivalMs !== null && afterTripStart(w.arrivalMs) && w.arrivalMs < onceDep;
    const base = superseded || (inGap(nextWeekly) ? nextWeekly : null);
    if (base) {
      Object.assign(win, { day: base.day, minSocPct: onceMin ?? base.minSocPct, tripSocPct: onceTrip ?? base.tripSocPct });
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
  return { window: win, tripStartMs, prevTripSocPct };
}

/**
 * Fahrten fuer die Vorausschau (ev-minmax.js): ab der laufenden Fahrt bzw. der
 * naechsten Abfahrt `days` Tage voraus, je Fahrt
 * `{ depMs, retMs, tripPct, minPct, src }`. Die Fenster kommen aus
 * resolveEvWindow, das in der Zeit vorgerueckt wird — dieselben Regeln, nach
 * denen DVhub spaeter wirklich plant (einmalige Abfahrt/Ankunft eingeschlossen).
 * Rueckkehr = Ankunft des naechsten Fensters; ohne Ankunftszeit ist sie
 * unbekannt und gilt als sofort (DVhub laedt ohnehin nur angesteckt).
 * minPct: Mindest-Ladestand der Zeile bzw. des Einmal-Ziels, sonst der
 * allgemeine Ziel-Ladestand.
 *
 * @returns {{ trips: Array, current: object|null }}  current = laufende Fahrt (Auto unterwegs)
 */
export function buildEvTrips(cfg, nowMs = Date.now(), { days = 8 } = {}) {
  const opt = cfg?.optimizer || {};
  const timeZone = cfg?.schedule?.timezone || 'Europe/Berlin';
  const mode = TARGET_MODES.includes(opt.evTargetMode) ? opt.evTargetMode : 'percent';
  const fallbackMin = targetSocPct({
    mode, value: Number.isFinite(Number(opt.evTargetValue)) ? Number(opt.evTargetValue) : 80,
    capacityWh: Number(opt.evCapacityWh) || 50000, consumptionKwhPer100km: opt.evConsumptionKwhPer100km
  }) ?? 80;
  const minOf = (w) => (w.minSocPct ?? null) !== null ? Number(w.minSocPct) : fallbackMin;
  const untilMs = nowMs + days * 24 * 3600_000;
  const wins = [];
  let t = nowMs;
  for (let guard = 0; guard < 64; guard += 1) {
    const { window: w } = resolveEvWindow(opt, timeZone, t);
    if (!w) break;
    if (wins.length && w.departureMs <= wins[wins.length - 1].departureMs) break;
    wins.push(w);
    // eine Abfahrt NACH der Vorausschau genuegt (sie liefert die Rueckkehr der letzten)
    if (w.departureMs > untilMs) break;
    t = w.departureMs - DEPARTURE_LEAD_MS + 1;
  }
  const trips = [];
  for (let k = 0; k < wins.length; k += 1) {
    const w = wins[k];
    if (w.departureMs > untilMs) break;
    const next = wins[k + 1];
    const retMs = next && next.arrivalMs !== null && next.arrivalMs > w.departureMs ? next.arrivalMs : w.departureMs;
    trips.push({ depMs: w.departureMs, retMs, tripPct: Number(w.tripSocPct) || 0, minPct: minOf(w), src: w.source });
  }
  // Laufende Fahrt: Auto weg seit der letzten Abfahrt, zurueck zur Ankunft des naechsten Fensters.
  const { tripStartMs, prevTripSocPct } = resolveEvWindow(opt, timeZone, nowMs);
  let current = null;
  const first = wins[0];
  if (tripStartMs !== null && first && first.arrivalMs !== null && first.arrivalMs > nowMs && first.arrivalMs > tripStartMs) {
    current = { depMs: tripStartMs, retMs: first.arrivalMs, tripPct: Number(prevTripSocPct) || 0, minPct: 0, src: 'current' };
    trips.unshift(current);
  }
  return { trips, current };
}

/**
 * Die gerade gueltige Abfahrt (und Ankunft) aus der Config.
 *
 * targetSocPct: Mindest-Ladestand bei dieser Abfahrt (Zeile bzw. Einmal-Ziel,
 * sonst der allgemeine Ziel-Ladestand). tripSocPct: Verbrauch der Fahrt ab
 * dieser Abfahrt; prevTripSocPct: der Fahrt, von der das Auto zur Ankunft
 * heimkommt (Ankunftsschaetzung, ev-arrival.js).
 *
 * @returns {{
 *   enabled: boolean, departureAt: string|null, source: 'once'|'weekly'|null,
 *   arrivalAt: string|null, arrivalSource: 'once'|'weekly'|null,
 *   tripStartAt: string|null, day: number|null, tripSocPct: number, prevTripSocPct: number,
 *   targetSocPct: number|null, ownTarget: boolean, mode: string, value: number|null,
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
    tripSocPct: 0, prevTripSocPct: 0,
    targetSocPct: null, ownTarget: false, mode, value, timeZone
  };
  if (!base.enabled) return { ...base, reason: 'aus' };

  const pct = targetSocPct({
    mode, value,
    capacityWh: Number(opt.evCapacityWh) || 50000,
    consumptionKwhPer100km: opt.evConsumptionKwhPer100km
  });
  if (pct === null) return { ...base, reason: 'Ziel nicht berechenbar' };

  const { window: w, tripStartMs, prevTripSocPct } = resolveEvWindow(opt, timeZone, nowMs);
  const tripStartAt = tripStartMs !== null ? new Date(tripStartMs).toISOString() : null;
  const prevTrip = Math.max(0, Number(prevTripSocPct) || 0);
  if (!w) return { ...base, tripStartAt, prevTripSocPct: prevTrip, targetSocPct: pct, reason: 'keine Abfahrt geplant' };
  const own = w.minSocPct !== null && w.minSocPct !== undefined ? Math.max(0, Math.min(100, Math.round(Number(w.minSocPct)))) : null;
  return {
    ...base,
    departureAt: new Date(w.departureMs).toISOString(),
    source: w.source,
    arrivalAt: w.arrivalMs !== null ? new Date(w.arrivalMs).toISOString() : null,
    arrivalSource: w.arrivalSource,
    tripStartAt,
    day: w.day,
    tripSocPct: Math.max(0, Number(w.tripSocPct) || 0),
    prevTripSocPct: prevTrip,
    ownTarget: own !== null,
    targetSocPct: own !== null ? own : pct
  };
}

/**
 * Einmalige Abfahrt bzw. Ankunft (Einmal-Ziel) fuer die Oberflaeche: ob sie
 * gerade wirkt, was sie ersetzt und was vorher noch kommt.
 *
 * Abfahrt `state`:
 *   'active' — die Abfahrt kommt noch (gilt bis DEPARTURE_LEAD_MS vorher);
 *   'ended'  — vorbei. Sie wirkt dann nur noch so nach, dass die ersetzte
 *              Wochenplan-Abfahrt nicht als Phantom-Fahrt zurueckkommt, bis die
 *              naechste echte Abfahrt vorbei ist; danach raeumt die
 *              Minuten-Wache sie ab (evOnceCleanupPatch).
 * `effective`: aktiv UND die Abfahrtsplanung (evDepartureEnabled) ist an —
 * sonst plant DVhub gar keine Abfahrt, auch keine einmalige.
 * `replaces`: die eine Wochenplan-Abfahrt, die sie ersetzt (Ankunft und —
 * ohne eigenen Wert — Ziel und Fahrt kommen von dort); `weeklyBefore`: wie
 * viele Wochenplan-Abfahrten vorher noch mit ihrem eigenen Ziel kommen.
 *
 * Ankunft `state`: 'active' (ersetzt gerade die Ankunft des naechsten
 * Fensters), 'pending' (kommt, wirkt erst nach der Abfahrt davor), 'ended'.
 */
export function describeEvOnce(cfg, nowMs = Date.now()) {
  const opt = cfg?.optimizer || {};
  const timeZone = cfg?.schedule?.timezone || 'Europe/Berlin';
  const enabled = opt.evDepartureEnabled === true;
  const gone = (ms) => ms - DEPARTURE_LEAD_MS <= nowMs;
  const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
  const out = { enabled, leadMinutes: DEPARTURE_LEAD_MS / 60_000, unplugWindowMinutes: ONCE_UNPLUG_WINDOW_MS / 60_000, departure: null, arrival: null };
  const onceDep = Date.parse(opt.evDepartureOnce || '');
  if (Number.isFinite(onceDep)) {
    const plan = effectiveWeeklyPlan(opt);
    const pick = supersededWindow(plan, timeZone, onceDep);
    const active = !gone(onceDep);
    const onceMin = pctOrNull(opt.evDepartureOnceMinSocPct);
    const onceTrip = pctOrNull(opt.evDepartureOnceTripSocPct);
    const mode = TARGET_MODES.includes(opt.evTargetMode) ? opt.evTargetMode : 'percent';
    const fallback = targetSocPct({
      mode, value: Number.isFinite(Number(opt.evTargetValue)) ? Number(opt.evTargetValue) : 80,
      capacityWh: Number(opt.evCapacityWh) || 50000, consumptionKwhPer100km: opt.evConsumptionKwhPer100km,
    });
    // Wochenplan-Abfahrten vor der einmaligen — genau so, wie DVhub sie
    // nacheinander plant (resolveEvWindow in der Zeit vorgerueckt).
    let weeklyBefore = 0;
    let nextWeeklyAt = null;
    if (active) {
      let t = nowMs;
      for (let guard = 0; guard < 64; guard += 1) {
        const { window: w } = resolveEvWindow(opt, timeZone, t);
        if (!w || w.source === 'once' || w.departureMs >= onceDep) break;
        if (nextWeeklyAt === null) nextWeeklyAt = iso(w.departureMs);
        weeklyBefore += 1;
        t = w.departureMs - DEPARTURE_LEAD_MS + 1;
      }
    }
    out.departure = {
      at: iso(onceDep),
      state: active ? 'active' : 'ended',
      effective: active && enabled,
      minSocPct: onceMin,
      tripSocPct: onceTrip,
      // Was bei dieser Abfahrt gilt: eigenes Ziel, sonst das der ersetzten Zeile, sonst das allgemeine.
      targetSocPct: onceMin ?? pick?.minSocPct ?? fallback,
      targetFrom: onceMin !== null ? 'once' : (pick && pick.minSocPct !== null && pick.minSocPct !== undefined ? 'weekly' : 'default'),
      replaces: pick ? { day: pick.day, departureAt: iso(pick.departureMs), arrivalAt: iso(pick.arrivalMs ?? NaN) } : null,
      weeklyBefore,
      nextWeeklyAt,
    };
  }
  const onceArr = Date.parse(opt.evArrivalOnce || '');
  if (Number.isFinite(onceArr)) {
    const { window: w } = resolveEvWindow(opt, timeZone, nowMs);
    const active = !!w && w.arrivalSource === 'once' && w.arrivalMs === onceArr;
    out.arrival = { at: iso(onceArr), state: active ? 'active' : (onceArr <= nowMs ? 'ended' : 'pending'), effective: active && enabled };
  }
  return out;
}

/**
 * Abgelaufene Einmal-Ziele abraeumen (Minuten-Wache, ev-watch.js). Liefert den
 * Patch fuer optimizer.* — leer, wenn nichts zu tun ist.
 *
 * Abgeraeumt wird erst, wenn es an der Planung nichts mehr aendert: dieselbe
 * Aufloesung (resolveEvWindow) mit und ohne das Einmal-Ziel. So kommt eine
 * ersetzte Wochenplan-Abfahrt nach dem Abraeumen nicht doch als Fahrt zurueck
 * (ersetzt war z. B. „Mi 07:30“ durch „Mi 06:00“ — erst nach der naechsten
 * echten Abfahrt ist das egal). Spaetestens nach 7 Tagen (so weit wirkt eine
 * einmalige Abfahrt hoechstens nach) oder sofort, wenn es gar keine
 * Wochenplan-Abfahrt gibt. Kaputte Zeitangaben und ein Ziel/Fahrt ohne Abfahrt
 * fliegen gleich raus.
 */
export function evOnceCleanupPatch(cfg, nowMs = Date.now()) {
  const opt = cfg?.optimizer || {};
  const timeZone = cfg?.schedule?.timezone || 'Europe/Berlin';
  const gone = (ms) => ms - DEPARTURE_LEAD_MS <= nowMs;
  const same = (a, b) => JSON.stringify(resolveEvWindow(a, timeZone, nowMs)) === JSON.stringify(resolveEvWindow(b, timeZone, nowMs));
  const patch = {};
  const clearDep = { evDepartureOnce: '', evDepartureOnceMinSocPct: null, evDepartureOnceTripSocPct: null };
  const depRaw = String(opt.evDepartureOnce || '').trim();
  const onceDep = Date.parse(depRaw);
  const extras = pctOrNull(opt.evDepartureOnceMinSocPct) !== null || pctOrNull(opt.evDepartureOnceTripSocPct) !== null;
  if (depRaw && !Number.isFinite(onceDep)) Object.assign(patch, clearDep);
  else if (!depRaw && extras) Object.assign(patch, { evDepartureOnceMinSocPct: null, evDepartureOnceTripSocPct: null });
  else if (Number.isFinite(onceDep) && gone(onceDep)) {
    const without = { ...opt, ...clearDep };
    const noWeekly = resolveEvWindow(without, timeZone, nowMs).window === null;
    if (noWeekly || nowMs - onceDep >= 7 * DAY_MS || same(opt, without)) Object.assign(patch, clearDep);
  }
  const cur = { ...opt, ...patch };
  const arrRaw = String(opt.evArrivalOnce || '').trim();
  const onceArr = Date.parse(arrRaw);
  if (arrRaw && !Number.isFinite(onceArr)) patch.evArrivalOnce = '';
  else if (Number.isFinite(onceArr) && onceArr <= nowMs && same(cur, { ...cur, evArrivalOnce: '' })) patch.evArrivalOnce = '';
  return patch;
}

/**
 * Abstecken zur Abfahrt (Minuten-Wache): wird das Auto in den letzten
 * ONCE_UNPLUG_WINDOW_MS vor einer aktiven einmaligen Abfahrt abgezogen, ist
 * das die Abfahrt — sie wird auf jetzt gesetzt und ist damit vorbei. Frueher
 * Abziehen (Auto umparken) laesst das Einmal-Ziel stehen.
 */
export const ONCE_UNPLUG_WINDOW_MS = 30 * 60_000;
export function evOnceUnplugPatch(cfg, nowMs = Date.now()) {
  const onceDep = Date.parse(cfg?.optimizer?.evDepartureOnce || '');
  if (!Number.isFinite(onceDep) || onceDep - DEPARTURE_LEAD_MS <= nowMs) return {};
  if (onceDep - nowMs > ONCE_UNPLUG_WINDOW_MS) return {};
  return { evDepartureOnce: new Date(Math.floor(nowMs / 60_000) * 60_000).toISOString() };
}

function parseIsoOrEmpty(v) {
  const s = String(v || '').trim();
  if (!s) return { ok: true, value: '' };
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? { ok: true, value: new Date(ms).toISOString() } : { ok: false };
}

/**
 * Wochenplan aus einer Eingabe pruefen → 7 Eintraege Mo..So in SoC-%.
 * Zeilen der alten Oberflaeche (Ziel `targetValue`) werden wie bei der
 * Konfig-Uebernahme umgerechnet (migrateWeeklyPlanRows); ein alter Heimweg
 * (`commuteKm`) wird geprueft, fliesst aber nicht mehr ein (10.11.2026).
 */
function parseWeeklyPlan(list, prefix, opt = {}) {
  if (!Array.isArray(list) || list.length > 7) return { ok: false, error: `${prefix}.weeklyPlan must be a list of up to 7 days` };
  const byDay = new Map();
  const rows = [];
  const present = (v) => v !== null && v !== undefined && v !== '';
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
    const row = { day, arrival: times.arrival, departure: times.departure };
    for (const k of ['minSocPct', 'tripSocPct']) {
      if (!(k in e)) continue;
      const v = numOrNull(e[k]);
      if (present(e[k]) && (v === null || v < 0 || v > 100)) return { ok: false, error: `${p}.${k} must be 0..100 or empty` };
      row[k] = v;
    }
    const targetValue = numOrNull(e.targetValue);
    if (present(e.targetValue) && (targetValue === null || targetValue < 0 || targetValue > 2000)) return { ok: false, error: `${p}.targetValue must be 0..2000 or empty` };
    const commuteKm = numOrNull(e.commuteKm);
    if (present(e.commuteKm) && (commuteKm === null || commuteKm < 0 || commuteKm > 1000)) return { ok: false, error: `${p}.commuteKm must be 0..1000 or empty` };
    if (!('minSocPct' in row) && targetValue !== null) row.targetValue = targetValue;
    // Heimweg der alten Oberfläche: geprüft, aber nicht mehr übernommen.
    // Neue Oberflaeche ohne Wert: leer = null (nicht „alte Zeile“).
    if (!('minSocPct' in row) && !('targetValue' in row)) row.minSocPct = null;
    if (!('tripSocPct' in row)) row.tripSocPct = null;
    byDay.set(day, row);
    rows.push(row);
  }
  return { ok: true, plan: migrateWeeklyPlanRows(rows, opt) };
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
export function parseEvDeparturePatch(d, prefix = 'departure', { opt = {}, nowMs = null } = {}) {
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
    // Umrechnung alter Zeilen mit den Werten, die im selben Aufruf kommen.
    const conv = { ...opt };
    for (const [k, key] of [['targetMode', 'evTargetMode'], ['capacityWh', 'evCapacityWh'], ['consumptionKwhPer100km', 'evConsumptionKwhPer100km']]) {
      if (k in d) conv[key] = d[k];
    }
    const wp = parseWeeklyPlan(d.weeklyPlan, prefix, conv);
    if (!wp.ok) return wp;
    patch.evWeeklyPlan = wp.plan;
  } else if ('time' in d || 'days' in d) {
    patch.evWeeklyPlan = null;
  }
  // Mit nowMs (Speichern, Vorschau): eine NEUE einmalige Abfahrt muss nach
  // jetzt + Vorlauf liegen, eine neue einmalige Ankunft nach jetzt — ein
  // vergangener Termin wirkte nie (bzw. hiesse fuer EOS „sofort laden“). Der
  // schon gespeicherte Wert darf unveraendert zurueckkommen (eine Seite, die
  // ihn noch im Formular hat); abgeraeumt wird er von der Minuten-Wache.
  const checkPast = Number.isFinite(nowMs);
  const stored = (v) => { const p = parseIsoOrEmpty(v); return p.ok ? p.value : ''; };
  if ('once' in d) {
    const once = parseIsoOrEmpty(d.once);
    if (!once.ok) return { ok: false, error: `${prefix}.once must be an ISO date time or empty` };
    if (checkPast && once.value && once.value !== stored(opt.evDepartureOnce) && Date.parse(once.value) - DEPARTURE_LEAD_MS <= nowMs) {
      return { ok: false, error: `${prefix}.once must be more than ${DEPARTURE_LEAD_MS / 60_000} min in the future`, code: 'once_in_past' };
    }
    patch.evDepartureOnce = once.value;
  }
  if ('arrivalOnce' in d) {
    const once = parseIsoOrEmpty(d.arrivalOnce);
    if (!once.ok) return { ok: false, error: `${prefix}.arrivalOnce must be an ISO date time or empty` };
    if (checkPast && once.value && once.value !== stored(opt.evArrivalOnce) && Date.parse(once.value) <= nowMs) {
      return { ok: false, error: `${prefix}.arrivalOnce must be in the future`, code: 'arrival_once_in_past' };
    }
    patch.evArrivalOnce = once.value;
  }
  // Einmal-Ziel „y % bis x Uhr“ (zusammen mit evDepartureOnce) und die
  // erwartete Fahrt danach; leer = Ziel/Fahrt des ersetzten Fensters.
  for (const [k, key] of [['onceMinSocPct', 'evDepartureOnceMinSocPct'], ['onceTripSocPct', 'evDepartureOnceTripSocPct']]) {
    if (!(k in d)) continue;
    const v = numOrNull(d[k]);
    if (d[k] !== null && d[k] !== undefined && d[k] !== '' && (v === null || v < 0 || v > 100)) return { ok: false, error: `${prefix}.${k} must be 0..100 or empty` };
    patch[key] = v;
  }
  // Max-Ladestand „wenn günstig“; leer = aus (Verhalten wie bis 1.0.9).
  if ('maxSocPct' in d) {
    const v = numOrNull(d.maxSocPct);
    if (d.maxSocPct !== null && d.maxSocPct !== undefined && d.maxSocPct !== '' && (v === null || v < 10 || v > 100)) return { ok: false, error: `${prefix}.maxSocPct must be 10..100 or empty` };
    patch.evMaxSocPct = v === null ? null : Math.round(v);
  }
  if ('valueMarginCt' in d) {
    const v = Number(d.valueMarginCt);
    if (d.valueMarginCt === null || d.valueMarginCt === '' || !Number.isFinite(v) || v < 0 || v > 50) return { ok: false, error: `${prefix}.valueMarginCt must be 0..50` };
    patch.evValueMarginCt = v;
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
 * Vorschau: was DVhub aus einem noch nicht gespeicherten Entwurf machte
 * (Integrationsseite und Leitstand-Kachel, POST /api/ev/preview). Dieselbe
 * Pruefung wie beim Speichern (parseEvDeparturePatch) und dieselbe Aufloesung
 * (resolveEvDeparture) — die Config bleibt unberuehrt.
 *
 * @param {object} cfg  aktuelle Config
 * @param {object} departure  Eingabe wie `departure` bei POST /api/ev
 * @param {{ nowMs?: number, capacityWh?: number }} [opts]  capacityWh: Wert
 *   aus dem Formular (Ziel in kWh/km haengt davon ab)
 * @returns {{ ok: true, resolved: object, capacityWh: number } | { ok: false, error: string }}
 */
export function previewEvDeparture(cfg, departure, { nowMs = Date.now(), capacityWh } = {}) {
  const parsed = parseEvDeparturePatch(departure, 'departure', { opt: cfg?.optimizer || {}, nowMs });
  if (!parsed.ok) return parsed;
  const optimizer = { ...(cfg?.optimizer || {}), ...parsed.patch };
  const cap = Number(capacityWh);
  if (Number.isFinite(cap) && cap > 0) optimizer.evCapacityWh = cap;
  // capacityWh: womit das Ziel-% gerechnet ist — die Oberflaeche zeigt „≈ kWh“
  // genau damit, nicht mit einem inzwischen anderen Wert.
  // once: was das Einmal-Ziel des Entwurfs bewirkte (Dialog „Einmalige Abfahrt planen“).
  const next = { ...cfg, optimizer };
  return { ok: true, resolved: resolveEvDeparture(next, nowMs), once: describeEvOnce(next, nowMs), capacityWh: Number(optimizer.evCapacityWh) || 50000 };
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
