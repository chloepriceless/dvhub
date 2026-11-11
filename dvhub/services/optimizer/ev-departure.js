/**
 * E-Auto: Wochenplan (Abfahrten je Wochentag) und Ziel-Ladestand fuer EOS.
 *
 * EOS (ab 0.4) kennt am Fahrzeug `min_soc_deadline_datetime`: bis zu diesem
 * Zeitpunkt muss `min_soc_percentage` erreicht sein. EOS nimmt dort einen
 * EINZELNEN Zeitpunkt — den Wochenplan rollt DVhub selbst weiter. Einmalige
 * Abweichungen (Einmal-Ziel, heute spaeter heim) ersetzen hoechstens EINE
 * regulaere Abfahrt bzw. Ankunft; die uebrigen Abfahrten bleiben.
 *
 * Wochenplan seit T-0427 (1.0.10, Christin 11.11.2026): Zeile = Tag der
 * ABFAHRT (optimizer.evWeeklyDepartures). Je Zeile die Abfahrtszeit, ein
 * eigenes Mindestziel, der Verbrauch der Fahrt danach in % und optional
 * „zuhause ab“ (homeFrom + homeFromPrevDay: am Vortag oder am selben Tag vor
 * der Abfahrt) — das ist die Ankunft, ab der das Auto da ist. Ohne „zuhause
 * ab“ ist das Auto da, sobald es angesteckt ist. Mehrere Abfahrten an einem
 * Tag sind moeglich (aus alten Plaenen, siehe departuresFromLegacy).
 *
 * Bis dahin war die Zeile der Tag der ANKUNFT (optimizer.evWeeklyPlan:
 * Abfahrt nicht nach der Ankunft → Folgetag, ohne Ankunft am Tag selbst).
 * Fuer „Dienstag 08:30“ musste man in die Montagszeile eine Ankunft erfinden.
 * Alte Plaene werden beim Laden einmal umgerechnet (migrateWeeklyConfig);
 * evWeeklyPlan wird im alten Format weiter mitgeschrieben, damit ein
 * Rueckweg auf 1.0.9 denselben Plan liest (legacyFromDepartures). Fehlen
 * beide (alte Config), gilt evDepartureTime + evDepartureDays ohne Ankunft.
 *
 * Das Ziel kann in %, kWh (Energie im Fahrzeugakku bei Abfahrt) oder km
 * (Reichweite bei Abfahrt) angegeben werden; EOS rechnet nur in %. Ein
 * eigenes Ziel im Plan steht in %.
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
 * ALTES Format (bis T-0427, Zeile = Tag der Ankunft) in SoC-% (seit 1.0.10):
 * immer 7 Zeilen `{ day, arrival, departure, minSocPct, tripSocPct }`. Gebraucht
 * fuer die Umrechnung (departuresFromLegacy) und den Vergleich mit dem
 * mitgeschriebenen Format. Je Zeile `minSocPct` (Mindest-Ladestand
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
 * Der gueltige Wochenplan (seit T-0427): Abfahrten, Zeile = Tag der Abfahrt,
 * in fester Form (normalizeDepartureRows) — je Tag mindestens eine Zeile
 * `{ day, departure: 'HH:MM'|'', minSocPct, tripSocPct, homeFrom: 'HH:MM'|'', homeFromPrevDay }`.
 *   - evWeeklyDepartures (neu) gilt, wenn vorhanden;
 *   - sonst ein alter Plan evWeeklyPlan (Zeile = Ankunftstag), VERLUSTFREI
 *     umgerechnet (ohne die Bereinigung der Config-Migration) — so plant eine
 *     nie umgestellte Config genau wie bisher;
 *   - sonst evDepartureTime + evDepartureDays (ohne „zuhause ab“).
 */
export function effectiveWeeklyPlan(opt = {}) {
  if (Array.isArray(opt.evWeeklyDepartures)) return normalizeDepartureRows(opt.evWeeklyDepartures);
  if (Array.isArray(opt.evWeeklyPlan)) return departuresFromLegacy(opt.evWeeklyPlan, opt, { dropHelperArrivals: false, attachOrphanArrivals: false }).rows;
  const time = parseTime(opt.evDepartureTime ?? '07:00') ? pad5(String(opt.evDepartureTime ?? '07:00').trim()) : '';
  const days = normalizeDays(opt.evDepartureDays ?? [1, 2, 3, 4, 5]);
  // Ohne Ziele und Fahrten — der alte Heimweg (evCommuteKm) zählt nicht mehr
  // (Christin 10.11.2026).
  return WEEK_DAYS.map((d) => ({ ...emptyDeparture(d), departure: time && days.includes(d) ? time : '' }));
}

/** Der gueltige Plan im alten Format (Zeile = Ankunftstag) fuer aeltere Seiten und 1.0.9. */
export function effectiveLegacyWeeklyPlan(opt = {}) {
  return legacyFromDepartures(effectiveWeeklyPlan(opt)).rows;
}

const DAY_NAMES = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
const nextDayOf = (d) => (d % 7) + 1;
const prevDayOf = (d) => ((d + 5) % 7) + 1;
const minOfDay = (t) => { const p = parseTime(t); return p ? p.h * 60 + p.min : null; };

/** Hoechstens so viele Zeilen nimmt der Wochenplan an (7 Tage, je bis zu 2 Abfahrten). */
export const MAX_WEEKLY_DEPARTURES = 14;
export const emptyDeparture = (day) => ({ day, departure: '', minSocPct: null, tripSocPct: null, homeFrom: '', homeFromPrevDay: false });

/**
 * „zuhause ab“ ohne Angabe des Tages: am Vortag, wenn die Uhrzeit nicht vor
 * der Abfahrt liegt (19:15 bei Abfahrt 08:30), sonst am selben Tag — dieselbe
 * Regel wie frueher „Abfahrt nicht nach der Ankunft → Folgetag“.
 */
export function defaultHomeFromPrevDay(homeFrom, departure) {
  const h = minOfDay(homeFrom);
  const d = minOfDay(departure);
  if (h === null) return false;
  return d === null || h >= d;
}

function normalizeDeparture(e) {
  const day = Number(e?.day);
  if (!WEEK_DAYS.includes(day)) return null;
  const departure = parseTime(e.departure) ? pad5(String(e.departure).trim()) : '';
  const homeFrom = parseTime(e.homeFrom) ? pad5(String(e.homeFrom).trim()) : '';
  const homeFromPrevDay = homeFrom ? (typeof e.homeFromPrevDay === 'boolean' ? e.homeFromPrevDay : defaultHomeFromPrevDay(homeFrom, departure)) : false;
  return { day, departure, minSocPct: pctOrNull(e.minSocPct), tripSocPct: pctOrNull(e.tripSocPct), homeFrom, homeFromPrevDay };
}

/**
 * Abfahrten in fester Form: Mo..So, je Tag die Abfahrten nach Uhrzeit; ein
 * Tag ohne Abfahrt hat genau eine leere Zeile (die Oberflaeche zeigt jeden
 * Tag). Gleiche Uhrzeit am selben Tag: „zuhause ab Vortag“ zuerst — dieselbe
 * Reihenfolge wie im alten Format (Ankunftstag frueher), damit der Plan genau
 * gleich aufgeloest wird.
 */
export function normalizeDepartureRows(list) {
  const rows = (Array.isArray(list) ? list : []).map(normalizeDeparture).filter(Boolean);
  const out = [];
  for (const day of WEEK_DAYS) {
    const withDep = rows.filter((r) => r.day === day && r.departure)
      .map((r, i) => ({ r, i }))
      .sort((a, b) => minOfDay(a.r.departure) - minOfDay(b.r.departure)
        || Number(b.r.homeFromPrevDay) - Number(a.r.homeFromPrevDay) || a.i - b.i)
      .map((x) => x.r);
    if (withDep.length) out.push(...withDep);
    else out.push(emptyDeparture(day));
  }
  return out;
}

/**
 * Hilfs-Ankunft im alten Format: nur eingetragen, damit die Abfahrt auf den
 * Folgetag rutscht (Christin: Montag „Ankunft 09:56, Abfahrt 08:30“ fuer
 * „Dienstag 08:30“). Erkennbar: am Vormittag (vor 12:00) und weniger als 2 h
 * nach der Abfahrtszeit — oder genau gleich (so schreibt legacyFromDepartures
 * selbst eine Abfahrt ohne „zuhause ab“ in eine fremde Zeile). Abends
 * eingetragene Ankuenfte (20:00 → 05:00) sind echte und bleiben.
 */
export const HELPER_ARRIVAL_MAX_MIN = 120;
const HELPER_ARRIVAL_BEFORE_MIN = 12 * 60;
export function isHelperArrival(arrival, departure) {
  const a = minOfDay(arrival);
  const d = minOfDay(departure);
  if (a === null || d === null || a < d) return false;
  return a === d || (a - d < HELPER_ARRIVAL_MAX_MIN && a < HELPER_ARRIVAL_BEFORE_MIN);
}

const COUNT_WORDS = ['', 'eine', 'zwei', 'drei', 'vier'];

/**
 * Alter Plan (Zeile = Ankunftstag) → Abfahrten (Zeile = Abfahrtstag).
 *
 * Verlustfrei (beide Optionen false): jede Zeile mit Abfahrt wird eine
 * Abfahrt am Folgetag (Abfahrt nicht nach der Ankunft) bzw. am selben Tag;
 * die Ankunft wird ihr „zuhause ab“ (Vortag bzw. selber Tag), Ziel und Fahrt
 * wandern mit. Zwei Zeilen, die auf denselben Tag fallen, bleiben zwei
 * Abfahrten. Eine Ankunft ohne Abfahrt wirkte nie und faellt weg. So plant
 * DVhub danach genau dasselbe (test/ev-wochenplan-abfahrtstag.test.js).
 *
 * Bereinigung (Config-Migration, Eingaben aelterer Seiten):
 *   - dropHelperArrivals: Hilfs-Ankuenfte (isHelperArrival) fallen weg — das
 *     Auto gilt dann wie gemeint als da, sobald es angesteckt ist;
 *   - attachOrphanArrivals: eine Ankunft ohne Abfahrt wird „zuhause ab“ der
 *     naechsten Abfahrt binnen 24 h, wenn die noch keins hat — sonst Hinweis.
 *
 * @returns {{ rows: object[], notes: Array<{ kind: string, day: number, text: string }> }}
 *   notes: was sich geaendert hat bzw. zu pruefen ist (Hinweis im Editor).
 */
export function departuresFromLegacy(list, opt = {}, { dropHelperArrivals = true, attachOrphanArrivals = true } = {}) {
  const legacy = migrateWeeklyPlanRows(list, opt);
  const rows = [];
  const notes = [];
  const orphans = [];
  for (const e of legacy) {
    if (!e.departure) {
      if (e.arrival) orphans.push(e);
      continue;
    }
    let day = e.day;
    let homeFrom = '';
    let homeFromPrevDay = false;
    // Vorrang bei gleicher Abfahrt: die Zeile vom Vortag (Folgetag-Abfahrt)
    // kam in der alten Aufloesung zuerst — auch wenn ihre Hilfs-Ankunft wegfaellt.
    const rank = departsNextDay(e) ? 0 : 1;
    if (e.arrival) {
      if (departsNextDay(e)) { day = nextDayOf(e.day); homeFromPrevDay = true; }
      homeFrom = e.arrival;
      if (dropHelperArrivals && homeFromPrevDay && isHelperArrival(e.arrival, e.departure)) {
        notes.push({ kind: 'helper', day, text: `${DAY_NAMES[e.day - 1]}: Die Ankunft ${e.arrival} war nur dafür da, dass die Abfahrt auf ${DAY_NAMES[day - 1]} ${e.departure} fällt — entfernt. Die Abfahrt steht jetzt bei ${DAY_NAMES[day - 1]}.` });
        homeFrom = '';
        homeFromPrevDay = false;
      }
    }
    rows.push({ day, departure: e.departure, minSocPct: e.minSocPct, tripSocPct: e.tripSocPct, homeFrom, homeFromPrevDay, rank });
  }
  for (const o of orphans) {
    const a = minOfDay(o.arrival);
    const next = attachOrphanArrivals ? rows
      .filter((r) => (r.day === o.day && minOfDay(r.departure) > a) || (r.day === nextDayOf(o.day) && minOfDay(r.departure) <= a))
      .sort((x, y) => Number(x.day !== o.day) - Number(y.day !== o.day) || minOfDay(x.departure) - minOfDay(y.departure))[0] : null;
    if (next && !next.homeFrom) {
      next.homeFrom = o.arrival;
      next.homeFromPrevDay = next.day !== o.day;
      notes.push({ kind: 'orphan-attached', day: next.day, text: `${DAY_NAMES[o.day - 1]}: Ankunft ${o.arrival} ohne Abfahrt — jetzt „zuhause ab“ der Abfahrt ${DAY_NAMES[next.day - 1]} ${next.departure}.` });
    } else {
      notes.push({ kind: 'orphan-dropped', day: o.day, text: `${DAY_NAMES[o.day - 1]}: Ankunft ${o.arrival} ohne Abfahrt hat bisher nichts bewirkt und passt zu keiner Abfahrt — entfernt.` });
    }
  }
  // Bereinigung: dieselbe Abfahrt zweimal (Tag d „Ankunft, Abfahrt 07:00“ →
  // Folgetag, und Tag d+1 „07:00“) ist eine Abfahrt. Es gilt die, die die alte
  // Aufloesung zuerst nahm (Vortag zuerst) — mit ihrem Ziel und ihrer Fahrt; die
  // zweite wurde dort nie die naechste Abfahrt (Codex 4974135c). Verlustfrei
  // (ohne Bereinigung) bleiben beide, die Reihenfolge haelt homeFromPrevDay.
  if (dropHelperArrivals) {
    rows.sort((a, b) => a.rank - b.rank);
    const seen = new Map();
    for (let i = 0; i < rows.length; i += 1) {
      const key = `${rows[i].day} ${rows[i].departure}`;
      const first = seen.get(key);
      if (!first) { seen.set(key, rows[i]); continue; }
      notes.push({ kind: 'duplicate', day: rows[i].day, text: `${DAY_NAMES[rows[i].day - 1]} ${rows[i].departure} stand zweimal im Plan — es gilt wie bisher ${first.minSocPct !== null && first.minSocPct !== undefined ? `mindestens ${first.minSocPct} %` : 'der Standard-Ladestand'}${first.homeFrom ? ` (zuhause ab ${first.homeFrom})` : ''}; die zweite ist entfernt.` });
      if (!first.homeFrom && rows[i].homeFrom) { first.homeFrom = rows[i].homeFrom; first.homeFromPrevDay = rows[i].homeFromPrevDay; }
      rows.splice(i, 1);
      i -= 1;
    }
  }
  const normalized = normalizeDepartureRows(rows);
  for (const day of WEEK_DAYS) {
    const same = normalized.filter((r) => r.day === day && r.departure);
    if (same.length < 2) continue;
    notes.push({ kind: 'twice', day, text: `${DAY_NAMES[day - 1]}: ${COUNT_WORDS[same.length] || same.length} Abfahrten (${same.map((r) => r.departure).join(' und ')}) — sie kamen aus zwei Zeilen des alten Plans. Bitte prüfen, ob alle gemeint sind.` });
  }
  return { rows: normalized, notes };
}

/**
 * Abfahrten → altes Format (Zeile = Ankunftstag) fuer den Rueckweg auf 1.0.9
 * (liest evWeeklyPlan mit targetValue in %) und fuer aeltere offene Seiten.
 * Jede Abfahrt sucht eine freie alte Zeile, in dieser Reihenfolge:
 *   - ohne „zuhause ab“: Zeile des Abfahrtstags ohne Ankunft, sonst die
 *     Vortageszeile mit Ankunft = Abfahrtszeit (Folgetag, 24 h vorher);
 *   - „zuhause ab“ am selben Tag: Zeile des Tages mit dieser Ankunft, sonst wie oben;
 *   - „zuhause ab“ am Vortag: Vortageszeile mit dieser Ankunft (liegt sie vor
 *     der Abfahrtszeit — mehr als 24 h —, mit Ankunft = Abfahrtszeit), sonst
 *     die Zeile des Abfahrtstags ohne Ankunft.
 * Je alte Zeile eine Abfahrt; gesucht wird die Verteilung mit den meisten
 * untergebrachten Abfahrten und davon den meisten am ersten Platz (so bleibt
 * ein „zuhause ab“ erhalten, wo es geht). Was keinen Platz findet (mehr als 7
 * Abfahrten), steht in `lost`. Fuer jeden aus dem alten Format
 * umgerechneten Plan ist das genau der alte Plan zurueck.
 *
 * @returns {{ rows: object[], lost: object[] }}  rows: 7 Zeilen
 *   `{ day, arrival, departure, minSocPct, tripSocPct, targetValue, commuteKm }`
 */
export function legacyFromDepartures(list) {
  const items = normalizeDepartureRows(list).filter((r) => r.departure);
  const options = items.map((r) => {
    const own = r.day;
    const prev = prevDayOf(r.day);
    const h = minOfDay(r.homeFrom);
    const d = minOfDay(r.departure);
    const synthetic = { slot: prev, arrival: r.departure };
    if (h !== null && r.homeFromPrevDay) return [h >= d ? { slot: prev, arrival: r.homeFrom } : synthetic, { slot: own, arrival: '' }];
    if (h !== null && h < d) return [{ slot: own, arrival: r.homeFrom }, synthetic];
    return [{ slot: own, arrival: '' }, synthetic];
  });
  // Vollstaendige Suche (hoechstens 14 Abfahrten × 2 Plaetze): moeglichst
  // viele Abfahrten unterbringen, dann moeglichst viele echte „zuhause ab“
  // behalten (Codex 4974135c), dann moeglichst viele am ersten Platz; bei
  // Gleichstand gewinnt die fruehere Abfahrt der Woche (feste Reihenfolge).
  const keeps = (i, k) => !!items[i].homeFrom && options[i][k].arrival === items[i].homeFrom;
  let best = { score: -1, pick: [] };
  const used = new Set();
  const pick = [];
  const walk = (i, score) => {
    if (i === items.length) {
      if (score > best.score) best = { score, pick: pick.slice() };
      return;
    }
    // obere Schranke: alle restlichen untergebracht, mit Ankunft, am ersten Platz
    if (score + (items.length - i) * 111 <= best.score) return;
    let placed = false;
    for (let k = 0; k < options[i].length; k += 1) {
      const slot = options[i][k].slot;
      if (used.has(slot)) continue;
      placed = true;
      used.add(slot); pick.push(k);
      walk(i + 1, score + 100 + (keeps(i, k) ? 10 : 0) + (k === 0 ? 1 : 0));
      pick.pop(); used.delete(slot);
    }
    if (!placed) { pick.push(-1); walk(i + 1, score); pick.pop(); }
  };
  walk(0, 0);
  const lost = items.filter((_, i) => best.pick[i] === -1);
  const rows = WEEK_DAYS.map((day) => ({ day, arrival: '', departure: '', minSocPct: null, tripSocPct: null, targetValue: null, commuteKm: null }));
  items.forEach((r, i) => {
    const k = best.pick[i];
    if (k === -1) return;
    const { slot, arrival } = options[i][k];
    rows[slot - 1] = { day: slot, arrival, departure: r.departure, minSocPct: r.minSocPct, tripSocPct: r.tripSocPct, targetValue: r.minSocPct, commuteKm: null };
  });
  return { rows, lost };
}

/** Planen zwei alte Plaene dieselben Zeiten und Ziele? (Fahrt kennt 1.0.9 nicht.) */
function sameLegacyPlan(a, b, opt, { withTrip = false } = {}) {
  const x = migrateWeeklyPlanRows(a, opt);
  const y = migrateWeeklyPlanRows(b, opt);
  const pct = (v) => (v === null || v === undefined ? null : Math.round(Number(v)));
  return x.every((r, i) => r.arrival === y[i].arrival && r.departure === y[i].departure && pct(r.minSocPct) === pct(y[i].minSocPct)
    && (!withTrip || pct(r.tripSocPct) === pct(y[i].tripSocPct)));
}

/**
 * Config-Migration (config-model.js beim Laden und Speichern): liefert den
 * Patch fuer optimizer.*.
 *   - Neue Zeilen vorhanden und evWeeklyPlan passt dazu → nur normalisieren
 *     und das alte Format frisch mitschreiben.
 *   - evWeeklyPlan passt NICHT dazu → eine aeltere DVhub-Version (Rueckweg auf
 *     1.0.9) hat den Plan geaendert: deren Stand gilt, neu umgerechnet
 *     (reason 'older-version'). Unveraendert neu gespeichert (ohne die
 *     Fahrt-Werte, die 1.0.9 nicht kennt) zaehlt nicht als Aenderung.
 *   - evWeeklyPlan === null bei neuen Zeilen → eine aeltere Oberflaeche hat
 *     auf „gleiche Abfahrt an diesen Tagen“ zurueckgesetzt: neue Zeilen weg.
 *   - Nur der alte Plan → umrechnen mit Bereinigung (reason 'legacy').
 * Bei einer Umrechnung haelt evWeeklyMigration fest, was sich geaendert hat
 * (notes), und sichert den alten Plan (previous); seen = der Hinweis im
 * Editor ist gelesen.
 */
export function migrateWeeklyConfig(opt = {}, { nowMs = Date.now() } = {}) {
  const hasNew = Array.isArray(opt.evWeeklyDepartures);
  const hasOld = Array.isArray(opt.evWeeklyPlan);
  const fromLegacy = (reason) => {
    const conv = departuresFromLegacy(opt.evWeeklyPlan, opt);
    const patch = { evWeeklyDepartures: conv.rows, evWeeklyPlan: legacyFromDepartures(conv.rows).rows };
    if (migrateWeeklyPlanRows(opt.evWeeklyPlan, opt).some((r) => r.departure || r.arrival)) {
      patch.evWeeklyMigration = { at: new Date(nowMs).toISOString(), reason, seen: false, notes: conv.notes, previous: JSON.parse(JSON.stringify(opt.evWeeklyPlan)) };
    }
    return patch;
  };
  if (hasNew && opt.evWeeklyPlan === null) return { evWeeklyDepartures: null };
  if (hasNew) {
    const rows = normalizeDepartureRows(opt.evWeeklyDepartures);
    const mirror = legacyFromDepartures(rows).rows;
    if (!hasOld || sameLegacyPlan(opt.evWeeklyPlan, mirror, opt)) return { evWeeklyDepartures: rows, evWeeklyPlan: mirror };
    return fromLegacy('older-version');
  }
  if (hasOld) return fromLegacy('legacy');
  return {};
}

/**
 * Hinweis „Wochenplan umgestellt — bitte prüfen“ fuer die Oberflaeche (GET
 * /api/ev, /api/integrations/evcc): solange nicht gelesen, was sich geaendert
 * hat — ohne die Sicherung des alten Plans. null = nichts zu zeigen.
 */
export function weeklyMigrationNotice(opt = {}) {
  const m = opt.evWeeklyMigration;
  if (!m || typeof m !== 'object' || m.seen === true) return null;
  return { at: m.at || null, reason: m.reason || 'legacy', notes: Array.isArray(m.notes) ? m.notes : [] };
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
 * ALTES Format (Zeile = Ankunftstag): rutscht die Abfahrt dieser Zeile auf den
 * Folgetag? Nur mit Ankunft und wenn die Abfahrt nicht nach ihr liegt
 * (20:00 → 05:00). Gebraucht fuer die Umrechnung alter Plaene.
 */
export function departsNextDay(entry) {
  const dep = parseTime(entry?.departure);
  const arr = parseTime(entry?.arrival);
  return !!(dep && arr && dep.h * 60 + dep.min <= arr.h * 60 + arr.min);
}

/**
 * Abfahrt mitten in der Nacht (vor EARLY_DEPARTURE_HINT_BEFORE): die
 * Oberflaeche sagt dazu, welche Nacht gemeint ist („Mi 02:00 = Nacht von
 * Dienstag auf Mittwoch“). Frueher die Falle vom 29.10.2026 (Zeile =
 * Ankunftstag); seit T-0427 steht die Abfahrt beim Tag, an dem sie ist — der
 * Hinweis bleibt nur zur Sicherheit. Mit „zuhause ab“ ist es eindeutig.
 */
export const EARLY_DEPARTURE_HINT_BEFORE = '06:00';
export function earlyDepartureWithoutArrival(entry) {
  const dep = parseTime(entry?.departure);
  const limit = parseTime(EARLY_DEPARTURE_HINT_BEFORE);
  return !!(dep && !parseTime(entry?.homeFrom) && dep.h * 60 + dep.min < limit.h * 60 + limit.min);
}

/**
 * Alle Fenster des Plans rund um `nowMs`, nach Abfahrt sortiert:
 * { day (Abfahrtstag), arrivalMs|null, departureMs, minSocPct, tripSocPct }.
 * Ausschnitt wie vor T-0427 (Ankunftstage 8 zurueck bis 8 voraus, also
 * Abfahrten bis 9 Tage voraus) — so bleibt die Aufloesung genau gleich.
 */
function planWindows(plan, timeZone, nowMs) {
  const today = zonedDate(nowMs, timeZone);
  const out = [];
  for (let i = -8; i <= 9; i += 1) {
    const d = shiftDay(today, i);
    for (const e of plan) {
      if (Number(e?.day) !== d.isoWeekday) continue;
      const dep = parseTime(e.departure);
      if (!dep) continue;
      const home = parseTime(e.homeFrom);
      const prev = !!(home && e.homeFromPrevDay);
      const arrivalDay = prev ? i - 1 : i;
      if (arrivalDay < -8 || arrivalDay > 8) continue;
      const departureMs = zonedToUtcMs(d.year, d.month, d.day, dep.h, dep.min, timeZone);
      let arrivalMs = null;
      if (home) {
        const ad = prev ? shiftDay(d, -1) : d;
        arrivalMs = zonedToUtcMs(ad.year, ad.month, ad.day, home.h, home.min, timeZone);
        // „zuhause ab“ in der Luecke der Zeitumstellung (So 02:30 gibt es im
        // Maerz nicht, sie rutscht auf 03:30) kann hinter die Abfahrt fallen —
        // dann ohne.
        if (arrivalMs >= departureMs) arrivalMs = null;
      }
      out.push({ day: d.isoWeekday, arrivalMs, departureMs, minSocPct: e.minSocPct ?? null, tripSocPct: e.tripSocPct ?? null });
    }
  }
  return out.sort((a, b) => a.departureMs - b.departureMs);
}

const DAY_MS = 24 * 3600_000;

/**
 * Die Optionen, nach denen geplant wird: Wochenplan aus (evDepartureEnabled
 * nicht true) heisst „keine Wochenplan-Abfahrten“ — ein Einmal-Ziel wirkt
 * trotzdem und ist dann die einzige Abfahrt (Christin 11.11.2026). Die Zeilen
 * bleiben in der Config stehen, zaehlen aber nicht (auch nicht ihr „zuhause
 * ab“ oder ihr Ziel).
 */
function planningOpt(opt = {}) {
  return opt.evDepartureEnabled === true ? opt : { ...opt, evWeeklyPlan: [], evWeeklyDepartures: [] };
}

/**
 * Einmalige Abfahrt: eingetragener Termin (onceDep) und tatsaechliche Abfahrt
 * (onceAt) — frueher, wenn das Auto davor abgesteckt wurde
 * (optimizer.evDepartureOnceLeftAt), sonst gleich dem Termin. NaN = keine.
 */
function onceTimes(opt = {}) {
  const onceDep = Date.parse(opt.evDepartureOnce || '');
  const left = Date.parse(opt.evDepartureOnceLeftAt || '');
  const onceAt = Number.isFinite(onceDep) && Number.isFinite(left) && left < onceDep ? left : onceDep;
  return { onceDep, onceAt };
}

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
  // onceDep: der eingetragene Termin — er bestimmt, welche Abfahrt ersetzt ist.
  // onceAt: wann das Auto wirklich los ist (Abstecken davor, ev-watch.js
  // evOnceUnplugPatch), sonst der Termin.
  const { onceDep, onceAt } = onceTimes(opt);
  const onceArr = Date.parse(opt.evArrivalOnce || '');
  const onceActive = Number.isFinite(onceAt) && !gone(onceAt);
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
  if (Number.isFinite(onceDep) && (onceActive || nowMs - onceAt < 7 * DAY_MS)) {
    const pick = supersededWindow(plan, timeZone, onceDep);
    // Liegt die ersetzte Abfahrt ausserhalb der Fenster um jetzt, ist hier
    // nichts auszublenden.
    if (pick) superseded = windows.find((w) => w.departureMs === pick.departureMs) || null;
  }
  const candidates = windows.filter((w) => w !== superseded);
  const pastWindows = candidates.filter((w) => gone(w.departureMs));
  const past = pastWindows.map((w) => w.departureMs);
  if (Number.isFinite(onceAt) && gone(onceAt)) past.push(onceAt);
  const tripStartMs = past.length ? Math.max(...past) : null;
  // Fahrt, von der das Auto zur naechsten Ankunft heimkommt (in %).
  let prevTripSocPct = null;
  if (tripStartMs !== null) {
    if (Number.isFinite(onceAt) && tripStartMs === onceAt) prevTripSocPct = onceTrip ?? superseded?.tripSocPct ?? null;
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
  const opt = planningOpt(cfg?.optimizer || {});
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
  // Abfahrtsplanung an: Wochenplan an ODER ein Einmal-Ziel, das noch kommt
  // (das wirkt auch bei ausgeschaltetem Wochenplan, 11.11.2026).
  const weeklyEnabled = opt.evDepartureEnabled === true;
  const { onceAt } = onceTimes(opt);
  const onceComing = Number.isFinite(onceAt) && onceAt - DEPARTURE_LEAD_MS > nowMs;
  const base = {
    enabled: weeklyEnabled || onceComing, weeklyEnabled, departureAt: null, source: null,
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

  const { window: w, tripStartMs, prevTripSocPct } = resolveEvWindow(planningOpt(opt), timeZone, nowMs);
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
 * `effective`: aktiv — seit 11.11.2026 auch bei ausgeschaltetem Wochenplan
 * (`weeklyEnabled` false): dann ist das Einmal-Ziel die einzige Abfahrt und
 * ersetzt nichts (`replaces` null).
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
  const weeklyEnabled = opt.evDepartureEnabled === true;
  const popt = planningOpt(opt);
  const gone = (ms) => ms - DEPARTURE_LEAD_MS <= nowMs;
  const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
  // enabled: wie bisher der Wochenplan-Schalter (das Feld lesen aeltere Seiten).
  const out = { enabled: weeklyEnabled, weeklyEnabled, leadMinutes: DEPARTURE_LEAD_MS / 60_000, unplugWindowMinutes: ONCE_UNPLUG_WINDOW_MS / 60_000, departure: null, arrival: null };
  const { onceDep, onceAt } = onceTimes(opt);
  if (Number.isFinite(onceDep)) {
    const plan = effectiveWeeklyPlan(popt);
    const pick = supersededWindow(plan, timeZone, onceDep);
    const active = !gone(onceAt);
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
        const { window: w } = resolveEvWindow(popt, timeZone, t);
        if (!w || w.source === 'once' || w.departureMs >= onceDep) break;
        if (nextWeeklyAt === null) nextWeeklyAt = iso(w.departureMs);
        weeklyBefore += 1;
        t = w.departureMs - DEPARTURE_LEAD_MS + 1;
      }
    }
    out.departure = {
      at: iso(onceDep),
      // abgesteckt vor dem Termin: dann los (sonst null)
      leftAt: onceAt !== onceDep ? iso(onceAt) : null,
      state: active ? 'active' : 'ended',
      // wirkt immer, solange es kommt — auch bei ausgeschaltetem Wochenplan
      effective: active,
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
    const { window: w } = resolveEvWindow(popt, timeZone, nowMs);
    const active = !!w && w.arrivalSource === 'once' && w.arrivalMs === onceArr;
    out.arrival = { at: iso(onceArr), state: active ? 'active' : (onceArr <= nowMs ? 'ended' : 'pending'), effective: active };
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
  // Verglichen wird, wonach geplant wird: Wochenplan aus = keine Wochenplan-Abfahrten.
  const opt = planningOpt(cfg?.optimizer || {});
  const timeZone = cfg?.schedule?.timezone || 'Europe/Berlin';
  const gone = (ms) => ms - DEPARTURE_LEAD_MS <= nowMs;
  const same = (a, b) => JSON.stringify(resolveEvWindow(a, timeZone, nowMs)) === JSON.stringify(resolveEvWindow(b, timeZone, nowMs));
  const patch = {};
  const clearDep = { evDepartureOnce: '', evDepartureOnceMinSocPct: null, evDepartureOnceTripSocPct: null, evDepartureOnceLeftAt: '' };
  const depRaw = String(opt.evDepartureOnce || '').trim();
  const { onceDep, onceAt } = onceTimes(opt);
  const extras = pctOrNull(opt.evDepartureOnceMinSocPct) !== null || pctOrNull(opt.evDepartureOnceTripSocPct) !== null
    || String(opt.evDepartureOnceLeftAt || '').trim() !== '';
  if (depRaw && !Number.isFinite(onceDep)) Object.assign(patch, clearDep);
  else if (!depRaw && extras) Object.assign(patch, { evDepartureOnceMinSocPct: null, evDepartureOnceTripSocPct: null, evDepartureOnceLeftAt: '' });
  else if (Number.isFinite(onceAt) && gone(onceAt)) {
    const without = { ...opt, ...clearDep };
    const noWeekly = resolveEvWindow(without, timeZone, nowMs).window === null;
    if (noWeekly || nowMs - onceAt >= 7 * DAY_MS || same(opt, without)) Object.assign(patch, clearDep);
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
 * das die Abfahrt — evDepartureOnceLeftAt = jetzt, die einmalige Abfahrt ist
 * damit vorbei. Der Termin selbst bleibt stehen: er bestimmt weiter, welche
 * Wochenplan-Abfahrt ersetzt ist (aus der Abzieh-Zeit neu bestimmt, kaeme eine
 * andere zurueck — Codex 5fe74510). Frueher Abziehen (Auto umparken) laesst
 * das Einmal-Ziel stehen.
 */
export const ONCE_UNPLUG_WINDOW_MS = 30 * 60_000;
export function evOnceUnplugPatch(cfg, nowMs = Date.now()) {
  const { onceDep, onceAt } = onceTimes(cfg?.optimizer || {});
  if (!Number.isFinite(onceDep) || onceAt !== onceDep || onceDep - DEPARTURE_LEAD_MS <= nowMs) return {};
  if (onceDep - nowMs > ONCE_UNPLUG_WINDOW_MS) return {};
  return { evDepartureOnceLeftAt: new Date(Math.floor(nowMs / 60_000) * 60_000).toISOString() };
}

function parseIsoOrEmpty(v) {
  const s = String(v || '').trim();
  if (!s) return { ok: true, value: '' };
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? { ok: true, value: new Date(ms).toISOString() } : { ok: false };
}

/**
 * ALTER Wochenplan aus einer Eingabe pruefen (aeltere offene Seiten, Zeile =
 * Ankunftstag) → 7 Zeilen in SoC-%. Zeilen der Oberflaeche bis 1.0.9 (Ziel
 * `targetValue`) werden wie bei der Konfig-Uebernahme umgerechnet
 * (migrateWeeklyPlanRows); ein alter Heimweg (`commuteKm`) wird geprueft,
 * fliesst aber nicht mehr ein (10.11.2026).
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
 * Wochenplan (Zeile = Abfahrtstag, T-0427) aus einer Eingabe pruefen → feste
 * Form (normalizeDepartureRows). Bis zu MAX_WEEKLY_DEPARTURES Zeilen, ein Tag
 * darf mehrfach vorkommen. „zuhause ab“ braucht eine Abfahrt; am selben Tag
 * muss es vor der Abfahrt liegen. Ohne homeFromPrevDay gilt
 * defaultHomeFromPrevDay.
 */
function parseWeeklyDepartures(list, prefix) {
  // Gezaehlt werden Abfahrten; die feste Form hat dazu je leerem Tag eine
  // leere Zeile (hoechstens 7) — sie muss unveraendert wieder angenommen werden
  // (Codex 4974135c).
  const tooMany = () => ({ ok: false, error: `${prefix}.weeklyDepartures must be a list of up to ${MAX_WEEKLY_DEPARTURES} departures` });
  if (!Array.isArray(list) || list.length > MAX_WEEKLY_DEPARTURES + 7) return tooMany();
  if (list.filter((e) => e && typeof e === 'object' && String(e.departure ?? '').trim() !== '').length > MAX_WEEKLY_DEPARTURES) return tooMany();
  const present = (v) => v !== null && v !== undefined && v !== '';
  const rows = [];
  for (let i = 0; i < list.length; i += 1) {
    const e = list[i];
    const p = `${prefix}.weeklyDepartures[${i}]`;
    if (!e || typeof e !== 'object') return { ok: false, error: `${p} must be an object` };
    const day = Number(e.day);
    if (!WEEK_DAYS.includes(day)) return { ok: false, error: `${p}.day must be a weekday 1..7` };
    const times = {};
    for (const k of ['departure', 'homeFrom']) {
      const raw = e[k] === null || e[k] === undefined ? '' : String(e[k]).trim();
      if (raw && !HHMM_RE.test(raw)) return { ok: false, error: `${p}.${k} must be HH:MM or empty` };
      times[k] = raw ? pad5(raw) : '';
    }
    if (times.homeFrom && !times.departure) return { ok: false, error: `${p}.departure is required with homeFrom` };
    if (present(e.homeFromPrevDay) && typeof e.homeFromPrevDay !== 'boolean') return { ok: false, error: `${p}.homeFromPrevDay must be true, false or empty` };
    const prevDay = times.homeFrom ? (typeof e.homeFromPrevDay === 'boolean' ? e.homeFromPrevDay : defaultHomeFromPrevDay(times.homeFrom, times.departure)) : false;
    if (times.homeFrom && !prevDay && minOfDay(times.homeFrom) >= minOfDay(times.departure)) {
      return { ok: false, error: `${p}.homeFrom must be before the departure on the same day` };
    }
    const row = { day, departure: times.departure, homeFrom: times.homeFrom, homeFromPrevDay: prevDay };
    for (const k of ['minSocPct', 'tripSocPct']) {
      const v = numOrNull(e[k]);
      if (present(e[k]) && (v === null || v < 0 || v > 100)) return { ok: false, error: `${p}.${k} must be 0..100 or empty` };
      row[k] = v;
    }
    rows.push(row);
  }
  return { ok: true, rows: normalizeDepartureRows(rows) };
}

/**
 * Eingaben fuer Wochenplan, Abfahrt + Ziel pruefen (Integrationsseite und
 * Leitstand-Kachel). Nur Felder, die im Objekt stehen, landen im Patch.
 *
 * Wochenplan: `weeklyDepartures` (Zeile = Abfahrtstag, seit T-0427). Das
 * alte `weeklyPlan` (Zeile = Ankunftstag, aeltere offene Seiten) wird weiter
 * angenommen und umgerechnet wie bei der Config-Migration. Gespeichert werden
 * immer beide: evWeeklyDepartures und evWeeklyPlan im alten Format (Rueckweg
 * 1.0.9). Die ganz alten Felder `time`/`days` setzen beide auf null zurueck
 * (ausser im selben Aufruf kommt ein Plan): wer noch die alte Oberflaeche
 * offen hat, bekommt genau das, was er dort sieht. `migrationSeen: true`
 * markiert den Hinweis „Wochenplan umgestellt“ als gelesen.
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
  if ('weeklyDepartures' in d) {
    const wd = parseWeeklyDepartures(d.weeklyDepartures, prefix);
    if (!wd.ok) return wd;
    patch.evWeeklyDepartures = wd.rows;
    patch.evWeeklyPlan = legacyFromDepartures(wd.rows).rows;
  } else if ('weeklyPlan' in d) {
    // Umrechnung alter Zeilen mit den Werten, die im selben Aufruf kommen.
    const conv = { ...opt };
    for (const [k, key] of [['targetMode', 'evTargetMode'], ['capacityWh', 'evCapacityWh'], ['consumptionKwhPer100km', 'evConsumptionKwhPer100km']]) {
      if (k in d) conv[key] = d[k];
    }
    const wp = parseWeeklyPlan(d.weeklyPlan, prefix, conv);
    if (!wp.ok) return wp;
    // Eine aeltere offene Seite schickt das mitgelieferte alte Format
    // unveraendert zurueck: dann gilt der gespeicherte Plan weiter — das alte
    // Format kann nicht alles ausdruecken (zuhause ab > 24 h, zweite Abfahrt am
    // Tag) und wuerde es sonst loeschen (Codex 4974135c). Fahrt-Werte zaehlen
    // mit, wenn die Seite sie schickt.
    const stored = Array.isArray(opt.evWeeklyDepartures) ? normalizeDepartureRows(opt.evWeeklyDepartures) : null;
    if (stored && sameLegacyPlan(wp.plan, legacyFromDepartures(stored).rows, conv, { withTrip: d.weeklyPlan.some((e) => e && typeof e === 'object' && 'tripSocPct' in e) })) {
      patch.evWeeklyDepartures = stored;
      patch.evWeeklyPlan = legacyFromDepartures(stored).rows;
    } else {
    const rows = departuresFromLegacy(wp.plan, conv).rows;
    patch.evWeeklyDepartures = rows;
    patch.evWeeklyPlan = legacyFromDepartures(rows).rows;
    }
  } else if ('time' in d || 'days' in d) {
    patch.evWeeklyPlan = null;
    patch.evWeeklyDepartures = null;
  }
  if (d.migrationSeen === true && opt.evWeeklyMigration && typeof opt.evWeeklyMigration === 'object') {
    patch.evWeeklyMigration = { ...opt.evWeeklyMigration, seen: true };
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
    // Neuer Termin (oder geloescht): ein „schon abgefahren“ vom alten gilt nicht mehr.
    if (once.value !== stored(opt.evDepartureOnce)) patch.evDepartureOnceLeftAt = '';
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
