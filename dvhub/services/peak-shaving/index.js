// services/peak-shaving/index.js — Peak Shaving: Netzbezug begrenzen (GitHub #28).
//
// Gewerbekunden mit Leistungsmessung (RLM) zahlen einen Leistungspreis
// (€/kW·a) auf die höchste Viertelstunden-Bezugsleistung im Jahr. Eine einzige
// Spitze verteuert die Netzentgelte für das ganze Jahr.
//
// v1 (Beta, nur Victron) — zwei Hebel, beide im Steuerpfad schedule-eval.js:
//
//   1. Sollwert-Deckel (applyControlTarget): ein POSITIVER gridSetpointW ist
//      bei Victron der gewünschte Netzbezug am Zähler. Liegt er über dem Ziel
//      (Grenze − Abstand), wird er gedeckelt. Damit lädt DVhub nie mehr aus dem
//      Netz, als die Grenze zulässt (Netzladen, EOS-„Akku halten“, manuelle
//      Werte), und bei „Akku halten“ deckt der Akku den Überschuss. Braucht der
//      Deckel den Akku (Ziel unter der gemessenen Netto-Last), muss der Ladestand
//      frisch und über dem Boden sein; sonst wird nur bis zur Netto-Last
//      gedeckelt (kein Entladen) bzw. bei unbekannter Last gar nicht.
//
//   2. Entlade-Freigabe (evaluateSchedule): ist die Akku-Entladung gesperrt
//      (maxDischargeW = 0, von DVhub geschrieben oder frisch zurückgelesen) und
//      liegt der gemessene Bezug über der Grenze, hebt DVhub die Sperre um den
//      Überschuss an; fällt der Bezug mit Abstand (Hysterese) wieder, wird die
//      Sperre (0) zurückgeschrieben.
//
// Alles andere bleibt unberührt: ohne `enabled`, ohne Beta-Kanal, ohne Grenze
// oder bei anderem Hersteller ist jeder Steuerwert bitgenau wie vorher.

import { betaGateOpen } from '../../beta-features.js';
import { localParts, zoneOffsetMs } from '../../tz-fast.js';

export const PEAK_SHAVING_DEFAULTS = Object.freeze({
  enabled: false,
  gridImportLimitW: null,
  marginW: 300,
  releaseHysteresisW: 500,
  minSocPct: null
});

// Unter 1 kW ist eine Bezugsgrenze kein Gewerbe-Leistungspreis mehr, sondern
// ein Tippfehler (z. B. kW statt W) — dann lieber gar nicht regeln.
export const MIN_LIMIT_W = 1000;
const MAX_LIMIT_W = 10_000_000;

const finite = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

/**
 * Wirksame Einstellungen. `enabled` = Schalter UND Beta-Gate (test/beta-gate.test.js),
 * `active` = DVhub regelt wirklich (zusätzlich Grenze gültig und Victron).
 * @param {object} cfg  effektive DVhub-Config
 */
export function resolvePeakShaving(cfg = {}) {
  const c = cfg?.peakShaving || {};
  const flagOn = c.enabled === true;
  const gateOpen = betaGateOpen(cfg, 'peakShaving');
  const enabled = flagOn && gateOpen;
  const rawLimit = Number(c.gridImportLimitW);
  const configured = finite(c.gridImportLimitW) && rawLimit >= MIN_LIMIT_W && rawLimit <= MAX_LIMIT_W;
  const limitW = configured ? Math.round(rawLimit) : null;
  const manufacturer = String(cfg?.manufacturer || 'victron');
  const supported = manufacturer === 'victron';
  const marginRaw = finite(c.marginW) ? Number(c.marginW) : PEAK_SHAVING_DEFAULTS.marginW;
  const marginW = limitW == null ? Math.max(0, Math.round(marginRaw))
    : Math.min(Math.round(limitW / 2), Math.max(0, Math.round(marginRaw)));
  const hystRaw = finite(c.releaseHysteresisW) ? Number(c.releaseHysteresisW) : PEAK_SHAVING_DEFAULTS.releaseHysteresisW;
  const releaseHysteresisW = Math.max(0, Math.round(hystRaw));
  const minSocPct = finite(c.minSocPct) && Number(c.minSocPct) >= 0 && Number(c.minSocPct) <= 100
    ? Number(c.minSocPct) : null;
  const reason = !flagOn ? 'disabled'
    : !gateOpen ? 'beta_gate_closed'
      : !configured ? 'limit_missing'
        : !supported ? 'manufacturer_unsupported'
          : null;
  return {
    enabled,
    configured,
    supported,
    active: reason === null,
    manufacturer,
    limitW,
    marginW,
    targetW: limitW == null ? null : limitW - marginW,
    releaseHysteresisW,
    minSocPct,
    reason
  };
}

const STATUS_TEXT = {
  disabled: 'Peak Shaving ist aus.',
  beta_gate_closed: 'Peak Shaving ist eine Beta-Funktion und wirkt nur im Bleeding-Edge-Kanal.',
  limit_missing: 'Keine gültige Bezugsgrenze eingetragen (mindestens 1000 W) — DVhub regelt nicht.',
  manufacturer_unsupported: 'Peak Shaving regelt bisher nur Victron-Anlagen. Bei diesem Hersteller zeigt DVhub die Spitzen nur an.'
};

/** Kurzer deutscher Statustext zum Ergebnis von resolvePeakShaving(). */
export function peakShavingStatusText(resolved) {
  if (!resolved) return STATUS_TEXT.disabled;
  if (resolved.reason) return STATUS_TEXT[resolved.reason] || STATUS_TEXT.disabled;
  return `Bezugsgrenze ${resolved.limitW} W aktiv (Regelziel ${resolved.targetW} W).`;
}

// Messwerte, auf denen eine Peak-Shaving-Entscheidung beruhen darf. Strenger als
// T-0075: ein Feld OHNE Erfolgs-Zeitstempel gilt als unbekannt, nicht als frisch.
const METER_MAX_AGE_MS = 15_000;
const PV_FIELDS = ['pvPowerW', 'acPvL1W', 'acPvL2W', 'acPvL3W', 'acPv2L1W', 'acPv2L2W', 'acPv2L3W'];

function fieldAgeMs(state, field, now) {
  const at = Number(state?.victron?.fieldUpdatedAt?.[field] ?? 0);
  return at > 0 ? now - at : null;
}

/**
 * Lagebild aus state.victron/state.meter (rein lesend).
 * @returns {{ socOk: boolean, socReason: string|null, soc: number|null, floorPct: number,
 *   loadKnown: boolean, loadW: number|null, pvW: number, netLoadW: number|null,
 *   meterFresh: boolean, importW: number|null, batteryDischargeW: number }}
 */
export function peakShavingTelemetry(state, cfg, resolved, now = Date.now()) {
  const v = state?.victron || {};
  const maxAgeMs = Number(cfg?.victron?.telemetryMaxAgeMs ?? 90000);
  const fresh = (field) => {
    const age = fieldAgeMs(state, field, now);
    return age !== null && age <= maxAgeMs && !v.errors?.[field];
  };
  const floorPct = Math.max(Number(cfg?.optimizer?.hardFloorSocPct ?? 5) || 0, Number(resolved?.minSocPct ?? 0) || 0);
  const socRaw = v.soc;
  const soc = Number(socRaw);
  const socKnown = socRaw != null && socRaw !== '' && Number.isFinite(soc) && fresh('soc');
  const socReason = !socKnown ? 'soc_unknown'
    : v.freeze?.active === true ? 'telemetry_frozen'
      : v.sourceMismatch?.active === true ? 'source_mismatch'
        : soc <= floorPct ? 'soc_floor' : null;

  // Zweite GX (multi-gx): polling.js zieht deren Akkuleistung von der Hauslast
  // ab und hebt die Messung in selfConsumptionMeasuredW auf. Für „entlädt der
  // Hauptakku?“ zählt die GEMESSENE Last am Hauptzähler — Ladung der zweiten
  // Anlage gehört dazu (Codex-Gegenprüfung 8b5a0a55, P1).
  const loadRaw = v.selfConsumptionMeasuredW ?? v.selfConsumptionW;
  const loadKnown = loadRaw != null && loadRaw !== '' && Number.isFinite(Number(loadRaw)) && fresh('selfConsumptionW')
    && v.freeze?.active !== true && v.sourceMismatch?.active !== true;
  const loadW = loadKnown ? Math.max(0, Number(loadRaw)) : null;
  // PV mindert die Netto-Last nur, wenn sie frisch ist — eine hängengebliebene
  // hohe PV würde die Netto-Last zu klein und den Deckel zu tief machen.
  // Frische aus den EINGESCHALTETEN PV-Punkten — bei reiner AC-Kopplung ist
  // pvPowerW abgeschaltet und hat nie einen Zeitstempel (Codex 8b5a0a55, P2).
  const pvPoints = PV_FIELDS.filter((f) => cfg?.points?.[f]?.enabled === true);
  const pvOk = pvPoints.length > 0 && pvPoints.every((f) => fresh(f)) && Number.isFinite(Number(v.pvTotalW));
  const pvW = pvOk ? Math.max(0, Number(v.pvTotalW)) : 0;

  const meter = state?.meter || {};
  const importRaw = v.gridImportW;
  const meterFresh = meter.ok === true && (now - Number(meter.updatedAt || 0)) < METER_MAX_AGE_MS
    && importRaw != null && Number.isFinite(Number(importRaw));
  return {
    socOk: socReason === null,
    socReason,
    soc: socKnown ? soc : null,
    floorPct,
    loadKnown,
    loadW,
    pvW,
    netLoadW: loadKnown ? Math.max(0, loadW - pvW) : null,
    meterFresh,
    importW: meterFresh ? Math.max(0, Number(importRaw)) : null,
    batteryDischargeW: Math.max(0, Number(v.batteryDischargeW) || 0)
  };
}

/**
 * Hebel 1 — Deckel auf einen positiven Netz-Sollwert (Victron: Netzbezug am Zähler).
 *   target    Ziel erreicht; ein Rest über der Netto-Last kommt aus dem Akku
 *             (Ladestand frisch und über dem Boden).
 *   net_load  Akku nicht nutzbar → nur bis zur Netto-Last: weniger Netzladen,
 *             aber kein Entladen.
 *   held      nichts Sicheres bekannt → Wert bleibt (Normalbetrieb).
 * Nie unter 0 (resolvePeakShaving hält das Ziel >= Grenze/2), nie nach oben.
 */
export function clampGridSetpoint(value, resolved, tel) {
  const v = Number(value);
  if (!resolved?.active || !Number.isFinite(v) || !(v > resolved.targetW)) {
    return { value, clamped: false, mode: null, reason: null };
  }
  if (tel?.socOk) return { value: resolved.targetW, clamped: true, mode: 'target', reason: null };
  if (tel?.loadKnown) {
    const floor = Math.max(resolved.targetW, Math.ceil(tel.netLoadW));
    if (floor < v) return { value: floor, clamped: true, mode: 'net_load', reason: tel.socReason };
    return { value, clamped: false, mode: 'held', reason: tel.socReason };
  }
  return { value, clamped: false, mode: 'held', reason: tel?.socReason || 'telemetry_unknown' };
}

// --- Hebel 2: Akku-Sperre (Victron 2704 MaxDischargePower = 0) aufheben -------
export const DISCHARGE_ENTER_TICKS = 2;   // Takte über der Grenze bis zur Freigabe (Entprellung)
export const DISCHARGE_RELEASE_TICKS = 6; // Takte unter Ziel − Hysterese bis zur Sperre (~30 s)
const LIFT_STEP_W = 100;
// Ein Rücklesewert zählt erst, wenn er sicher NACH dem eigenen Write gepollt wurde.
const READBACK_GRACE_MS = 10_000;
const READBACK_TOLERANCE_W = 50;

/**
 * Was DVhub über 2704 sicher weiß: ein frischer Rücklesewert (falls der Punkt
 * gepollt wird) schlägt den eigenen letzten Write. Sonst null = unbekannt —
 * dann hebt Peak Shaving keine Sperre auf (wir wüssten nicht, wohin zurück).
 */
export function knownMaxDischargeW(state, cfg, now = Date.now()) {
  const v = state?.victron || {};
  const maxAgeMs = Number(cfg?.victron?.telemetryMaxAgeMs ?? 90000);
  const age = fieldAgeMs(state, 'maxDischargeW', now);
  if (v.maxDischargeW != null && Number.isFinite(Number(v.maxDischargeW)) && age !== null && age <= maxAgeMs
      && !v.errors?.maxDischargeW) {
    return { value: Number(v.maxDischargeW), from: 'readback', at: now - age };
  }
  const lw = state?.schedule?.lastWrite?.maxDischargeW;
  if (lw && lw.value != null && Number.isFinite(Number(lw.value))) {
    return { value: Number(lw.value), from: 'own_write', at: Number(lw.at) || 0, source: lw.source };
  }
  return null;
}

function liftValueW(needW, capW) {
  const stepped = Math.ceil(Math.max(0, needW) / LIFT_STEP_W) * LIFT_STEP_W;
  return Math.max(LIFT_STEP_W, Math.min(capW, stepped));
}

function superseded(d, known) {
  if (!known) return false;
  // lastWrite ist immer der JÜNGSTE Write: stammt er nicht von Peak Shaving,
  // hat jemand nach unserer Freigabe selbst gesetzt.
  if (known.from === 'own_write') return !String(known.source || '').startsWith('peak_shaving');
  return known.at > (Number(d.lastWriteAt) || 0) + READBACK_GRACE_MS
    && Math.abs(known.value - Number(d.liftedW)) > READBACK_TOLERANCE_W;
}

/**
 * Ein Takt der Entlade-Freigabe (rein; ändert nur die Zähler in d).
 * d.phase 'idle' | 'lifted'. Rückgabe: was der Evaluator schreiben soll.
 * @returns {{ type: 'none'|'lift'|'raise'|'restore'|'superseded', valueW?: number, reason?: string }}
 */
export function dischargeStep(d, { ps, tel, known, paused, capW }) {
  if (d.phase === 'lifted') {
    if (superseded(d, known)) return { type: 'superseded' };
    const reason = paused ? 'emergency_stop'
      : !ps?.active ? (ps?.reason || 'disabled')
        : tel.socReason ? tel.socReason
          : !tel.meterFresh ? 'meter_stale' : null;
    if (reason) return { type: 'restore', reason };
    const demandW = tel.importW + tel.batteryDischargeW;
    if (tel.importW > ps.limitW) {
      d.under = 0;
      const next = liftValueW(demandW - ps.targetW, capW);
      return next > Number(d.liftedW) ? { type: 'raise', valueW: next } : { type: 'none' };
    }
    d.under = demandW < ps.targetW - ps.releaseHysteresisW ? (d.under || 0) + 1 : 0;
    if (d.under >= DISCHARGE_RELEASE_TICKS) return { type: 'restore', reason: 'below_limit' };
    return { type: 'none' };
  }
  const blocked = known != null && known.value === 0;
  const over = !paused && ps?.active === true && blocked && tel.socOk && tel.meterFresh && tel.importW > ps.limitW;
  d.over = over ? (d.over || 0) + 1 : 0;
  if (d.over >= DISCHARGE_ENTER_TICKS) {
    d.over = 0;
    return { type: 'lift', valueW: liftValueW(tel.importW + tel.batteryDischargeW - ps.targetW, capW) };
  }
  return { type: 'none' };
}

// --- Anzeige: Viertelstunden-Spitzen und Status --------------------------------
export const PEAK_REFRESH_MS = 5 * 60_000;
// Ein Deckel-Eintrag gilt als „greift gerade“, solange er jünger ist (der
// Sollwert-Pfad schreibt alle 5–15 s).
const CLAMP_FRESH_MS = 30_000;

/** UTC-Zeitpunkt (ms) von lokal y-m-d 00:00 in der Zone. */
function localMidnightUtcMs(year, month, day, timeZone) {
  const asUtc = Date.UTC(year, month - 1, day);
  const guess = asUtc - zoneOffsetMs(asUtc, timeZone);
  return asUtc - zoneOffsetMs(guess, timeZone);
}

/**
 * Abrechnungszeiträume in der Zeitzone der Anlage: laufender Monat und
 * laufendes Kalenderjahr, je [start, end) als ISO-Zeitpunkte.
 */
export function peakPeriods(nowMs = Date.now(), timeZone = 'Europe/Berlin') {
  const { year, month } = localParts(nowMs, timeZone);
  const iso = (ms) => new Date(ms).toISOString();
  const nextMonth = month === 12 ? [year + 1, 1] : [year, month + 1];
  return {
    month: { start: iso(localMidnightUtcMs(year, month, 1, timeZone)), end: iso(localMidnightUtcMs(nextMonth[0], nextMonth[1], 1, timeZone)) },
    year: { start: iso(localMidnightUtcMs(year, 1, 1, timeZone)), end: iso(localMidnightUtcMs(year + 1, 1, 1, timeZone)) }
  };
}

/**
 * Status-Dienst für Leitstand und /api/status. Läuft im Laufzeit-Prozess
 * (dort liegen Steuerzustand und Datenbank); die Spitzen kommen alle 5 min aus
 * energy_slots_15m. Ausgeschaltet: kein Status, keine Abfrage.
 */
export function createPeakShaving(ctx, deps = {}) {
  const now = deps.now || (() => Date.now());
  let peaks = { month: null, year: null, updatedAt: null, error: null };
  let timer = null;
  let busy = false;

  const cfg = () => ctx.getCfg?.() || {};

  async function refreshPeaks(nowMs = now()) {
    const c = cfg();
    if (!resolvePeakShaving(c).enabled || busy) return;
    const store = ctx.telemetryStore;
    if (typeof store?.getGridImportPeak !== 'function') {
      peaks = { ...peaks, error: 'no_database' };
      return;
    }
    busy = true;
    try {
      const p = peakPeriods(nowMs, c.schedule?.timezone || 'Europe/Berlin');
      const month = await store.getGridImportPeak(p.month);
      const year = await store.getGridImportPeak(p.year);
      const strip = (x) => (x ? { slotStart: x.slotStart, powerW: x.powerW } : null);
      peaks = { month: strip(month), year: strip(year), updatedAt: new Date(nowMs).toISOString(), error: null };
    } catch (e) {
      peaks = { ...peaks, error: e?.message || String(e) };
    } finally {
      busy = false;
    }
  }

  function summary() {
    const c = cfg();
    const r = resolvePeakShaving(c);
    if (!r.enabled) return null;
    const s = ctx.state || {};
    const t = now();
    const ctl = s.ctrl?._peakShaving || {};
    const clampFresh = ctl.clamp && (t - Number(ctl.clamp.at || 0)) <= CLAMP_FRESH_MS;
    const clamp = clampFresh
      ? { requestedW: ctl.clamp.requestedW, valueW: ctl.clamp.valueW, mode: ctl.clamp.mode, reason: ctl.clamp.reason ?? null, source: ctl.clamp.source }
      : null;
    const lift = ctl.discharge?.phase === 'lifted' ? { liftedW: ctl.discharge.liftedW, since: ctl.discharge.since } : null;
    const meterFresh = s.meter?.ok === true && (t - Number(s.meter.updatedAt || 0)) < METER_MAX_AGE_MS
      && Number.isFinite(Number(s.victron?.gridImportW));
    return {
      enabled: true,
      active: r.active,
      supported: r.supported,
      reason: r.reason,
      message: peakShavingStatusText(r),
      limitW: r.limitW,
      targetW: r.targetW,
      marginW: r.marginW,
      timezone: c.schedule?.timezone || 'Europe/Berlin',
      importW: meterFresh ? Math.max(0, Math.round(Number(s.victron.gridImportW))) : null,
      acting: Boolean((clamp && (clamp.mode === 'target' || clamp.mode === 'net_load')) || lift),
      clamp,
      lift,
      peaks: { ...peaks }
    };
  }

  function start() {
    if (timer) return;
    refreshPeaks().catch(() => {});
    timer = setInterval(() => { refreshPeaks().catch(() => {}); }, PEAK_REFRESH_MS);
    timer.unref?.();
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return { refreshPeaks, summary, start, stop };
}
