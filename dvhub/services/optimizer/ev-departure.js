/**
 * E-Auto: Abfahrtszeit und Ziel-Ladestand fuer EOS.
 *
 * EOS (ab 0.4) kennt am Fahrzeug `min_soc_deadline_datetime`: bis zu diesem
 * Zeitpunkt muss `min_soc_percentage` erreicht sein. EOS nimmt dort einen
 * EINZELNEN Zeitpunkt — die wiederkehrende Abfahrt ("Mo–Fr 07:00") rollt DVhub
 * selbst weiter, und die einmalige ("naechste Fahrt Sa 09:30") geht vor.
 *
 * Das Ziel kann in %, kWh (Energie im Fahrzeugakku bei Abfahrt) oder km
 * (Reichweite bei Abfahrt) angegeben werden; EOS rechnet nur in %.
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

/** Offset der Zeitzone zu UTC in ms fuer einen Zeitpunkt (positiv = oestlich). */
function tzOffsetMs(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(utcMs));
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
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short'
  }).formatToParts(new Date(utcMs));
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
    const noonUtc = Date.UTC(today.year, today.month - 1, today.day + i, 12);
    const d = zonedDate(noonUtc, timeZone);
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

/**
 * Die gerade gueltige Abfahrt aus der Config.
 *
 * @returns {{
 *   enabled: boolean, departureAt: string|null, source: 'once'|'weekly'|null,
 *   targetSocPct: number|null, mode: string, value: number|null,
 *   timeZone: string, reason?: string
 * }}
 */
export function resolveEvDeparture(cfg, nowMs = Date.now()) {
  const opt = cfg?.optimizer || {};
  const timeZone = cfg?.schedule?.timezone || 'Europe/Berlin';
  const mode = TARGET_MODES.includes(opt.evTargetMode) ? opt.evTargetMode : 'percent';
  const value = Number.isFinite(Number(opt.evTargetValue)) ? Number(opt.evTargetValue) : null;
  const base = { enabled: opt.evDepartureEnabled === true, departureAt: null, source: null, targetSocPct: null, mode, value, timeZone };
  if (!base.enabled) return { ...base, reason: 'aus' };

  const pct = targetSocPct({
    mode, value,
    capacityWh: Number(opt.evCapacityWh) || 50000,
    consumptionKwhPer100km: opt.evConsumptionKwhPer100km
  });
  if (pct === null) return { ...base, reason: 'Ziel nicht berechenbar' };

  // Einmalige Abfahrt geht vor, solange sie noch kommt.
  const onceMs = Date.parse(opt.evDepartureOnce || '');
  if (Number.isFinite(onceMs) && onceMs - DEPARTURE_LEAD_MS > nowMs) {
    return { ...base, departureAt: new Date(onceMs).toISOString(), source: 'once', targetSocPct: pct };
  }
  const weekly = nextWeeklyDeparture({ time: opt.evDepartureTime, days: opt.evDepartureDays, timeZone, nowMs });
  if (weekly === null) return { ...base, targetSocPct: pct, reason: 'keine Abfahrt geplant' };
  return { ...base, departureAt: new Date(weekly).toISOString(), source: 'weekly', targetSocPct: pct };
}

/**
 * Eingaben fuer Abfahrt + Ziel pruefen (Integrationsseite und Leitstand-Kachel).
 * Nur Felder, die im Objekt stehen, landen im Patch.
 *
 * @returns {{ ok: true, patch: object } | { ok: false, error: string }}
 */
export function parseEvDeparturePatch(d, prefix = 'departure') {
  if (!d || typeof d !== 'object') return { ok: false, error: `${prefix} must be an object` };
  const patch = {};
  if ('enabled' in d) patch.evDepartureEnabled = d.enabled === true;
  if ('time' in d) {
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(d.time))) return { ok: false, error: `${prefix}.time must be HH:MM` };
    patch.evDepartureTime = String(d.time).padStart(5, '0');
  }
  if ('days' in d) {
    const days = Array.isArray(d.days) ? [...new Set(d.days.map(Number))].filter((x) => Number.isInteger(x) && x >= 1 && x <= 7).sort() : null;
    if (!days) return { ok: false, error: `${prefix}.days must be a list of 1..7` };
    patch.evDepartureDays = days;
  }
  if ('once' in d) {
    const once = String(d.once || '').trim();
    if (once && !Number.isFinite(Date.parse(once))) return { ok: false, error: `${prefix}.once must be an ISO date time or empty` };
    patch.evDepartureOnce = once ? new Date(Date.parse(once)).toISOString() : '';
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
      const f = Number(r.evChargeFactor);
      return {
        ts,
        powerW: Number.isFinite(f) ? Math.max(0, Math.round(f * (Number(maxChargeW) || 0))) : null,
        socPct: Number.isFinite(Number(r.evSocPct)) ? Number(r.evSocPct) : null
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
