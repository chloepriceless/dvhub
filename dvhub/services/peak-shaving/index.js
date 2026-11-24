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
//
// Die physikalische Grenze des Hausanschlusses regelt services/grid-connection
// (stabil, für alle). Beide nutzen denselben Kern (services/import-limit/core.js:
// Sollwert-Deckel, „kleinste gilt“) und sitzen an derselben Stelle im
// Steuerpfad; die Viertelstunden-Spitzen und die Entlade-Freigabe bleiben
// Gewerbe-Logik hier.

import { betaGateOpen } from '../../beta-features.js';
import { localParts, zoneOffsetMs } from '../../tz-fast.js';
import { capPositiveSetpoint, meterImport } from '../import-limit/core.js';
// A24 (Erzeuger-Stempel monoton) und P1 (Viertelstunden-Budget) teilen dieselbe monotone Uhr.
import { monoNow as sharedMonoNow, monoNow as defaultMonoNow, monoStampOf, monoStampAge } from '../mono-clock.js';
import { resolveBatteryLever } from '../grid-connection/index.js';
import { sungrowDischargeFloorPct, sungrowSocFloorBufferPct, sungrowRealSocPct, resolveSecondInverter, secondInverterTelemetry } from '../inverter/sungrow.js';
import { createBudgetState, observeBudget, decideBudget, quarterHourSlot } from './budget.js';
import { resolveTariff, computeYearBilling } from './billing.js';

export const PEAK_SHAVING_DEFAULTS = Object.freeze({
  enabled: false,
  gridImportLimitW: null,
  marginW: 300,
  releaseHysteresisW: 500,
  minSocPct: null,
  // Abrechnung nach 15-min-Mittelwert (P1, Christin 24.11.2026): DVhub führt je
  // Viertelstunde ein Energiebudget und greift erst ein, wenn die Hochrechnung
  // es reißen würde. Aus = Deckel auf den Augenblickswert (Verhalten bis 1.0.10).
  billing15min: true,
  // Grenze an erreichte Jahresspitze (bei Monatsleistungspreis: Monatsspitze)
  // anpassen (P3, Christin 24.11.2026). Ab Werk aus.
  adaptToReachedPeak: false
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
  // Hebel (P5, Christin 24.11.2026) — nach dem, was das Profil kann, nicht nach
  // dem Herstellernamen (wie der Netzanschluss, resolveBatteryLever):
  //   victron  Sollwert-Deckel + Entlade-Freigabe im Steuerpfad (schedule-eval)
  //   native   Netz-Sollwert und/oder Entladegrenze schreibbar (Sungrow-EMS,
  //            MQTT-Bridge, DVhub-MQTT …) → Akku-Hilfe des Netzanschluss-Wächters
  //            (ctx.batteryAssist, Quelle 'peak-shaving')
  //   builtin  eingebaute Peak-Shaving-Funktion des Wechselrichters
  //            (Profilblock peakShavingBuiltin, ungetestet, nur mit Schalter)
  //   none     nichts davon → nur Anzeige
  const batteryLever = resolveBatteryLever(cfg);
  const builtinAvailable = builtinSpecValid(cfg?.peakShavingBuiltin);
  const lever = batteryLever.kind !== 'none' ? batteryLever.kind
    : builtinAvailable ? (c.builtin?.enabled === true ? 'builtin' : 'builtin_off')
      : 'none';
  const supported = lever === 'victron' || lever === 'native' || lever === 'builtin';
  const marginRaw = finite(c.marginW) ? Number(c.marginW) : PEAK_SHAVING_DEFAULTS.marginW;
  const marginW = limitW == null ? Math.max(0, Math.round(marginRaw))
    : Math.min(Math.round(limitW / 2), Math.max(0, Math.round(marginRaw)));
  const hystRaw = finite(c.releaseHysteresisW) ? Number(c.releaseHysteresisW) : PEAK_SHAVING_DEFAULTS.releaseHysteresisW;
  const releaseHysteresisW = Math.max(0, Math.round(hystRaw));
  const minSocPct = finite(c.minSocPct) && Number(c.minSocPct) >= 0 && Number(c.minSocPct) <= 100
    ? Number(c.minSocPct) : null;
  // Ab Werk an; nur ein ausdrückliches false schaltet auf den Augenblickswert.
  const billing15min = c.billing15min !== false;
  const adaptToReachedPeak = c.adaptToReachedPeak === true;
  const reason = !flagOn ? 'disabled'
    : !gateOpen ? 'beta_gate_closed'
      : !configured ? 'limit_missing'
        : !supported ? (lever === 'builtin_off' ? 'builtin_disabled' : 'manufacturer_unsupported')
          : null;
  return {
    enabled,
    configured,
    supported,
    active: reason === null,
    manufacturer,
    lever,
    leverText: lever === 'builtin' || lever === 'builtin_off' ? 'eingebaute Peak-Shaving-Funktion des Wechselrichters (ungetestet)' : batteryLever.text,
    builtinAvailable,
    limitW,
    marginW,
    targetW: limitW == null ? null : limitW - marginW,
    releaseHysteresisW,
    minSocPct,
    billing15min,
    adaptToReachedPeak,
    reason
  };
}

const STATUS_TEXT = {
  disabled: 'Peak Shaving ist aus.',
  beta_gate_closed: 'Peak Shaving ist eine Beta-Funktion und wirkt nur im Bleeding-Edge-Kanal.',
  limit_missing: 'Keine gültige Bezugsgrenze eingetragen (mindestens 1000 W) — DVhub regelt nicht.',
  manufacturer_unsupported: 'Peak Shaving braucht einen steuerbaren Akku: Victron, ein Profil mit schreibbarem Netz-Sollwert oder Entladegrenze (z. B. Sungrow, MQTT-Bridge) oder eine eingebaute Peak-Shaving-Funktion des Wechselrichters. Bei diesem Hersteller zeigt DVhub die Spitzen nur an.',
  builtin_disabled: 'Der Wechselrichter hat eine eingebaute Peak-Shaving-Funktion (im Profil hinterlegt, ungetestet). DVhub nutzt sie erst, wenn „Eingebaute Peak-Shaving-Funktion nutzen“ eingeschaltet ist — bis dahin nur Anzeige.'
};

/**
 * Profilblock peakShavingBuiltin (P5): mindestens ein Schreibpunkt `limit` oder
 * `mode` mit ganzzahliger Adresse. Genauer geprüft wird beim Schreiben
 * (services/peak-shaving/builtin.js).
 */
export function builtinSpecValid(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return false;
  const ok = (p) => p && typeof p === 'object' && Number.isInteger(Number(p.address)) && Number(p.address) >= 0 && Number(p.address) <= 0xffff;
  return ok(spec.limit) || ok(spec.mode);
}

/** Kurzer deutscher Statustext zum Ergebnis von resolvePeakShaving(). */
export function peakShavingStatusText(resolved) {
  if (!resolved) return STATUS_TEXT.disabled;
  if (resolved.reason) return STATUS_TEXT[resolved.reason] || STATUS_TEXT.disabled;
  return `Bezugsgrenze ${resolved.limitW} W aktiv (Regelziel ${resolved.targetW} W).`;
}

// Messwerte, auf denen eine Peak-Shaving-Entscheidung beruhen darf. Strenger als
// T-0075: ein Feld OHNE Erfolgs-Zeitstempel gilt als unbekannt, nicht als frisch.
const METER_MAX_AGE_MS = 15_000;
// Akku-Leistung fürs Viertelstunden-Budget: höchstens so alt (Abfrage alle 2–5 s).
const BATTERY_POWER_MAX_AGE_MS = 30_000;
const PV_FIELDS = ['pvPowerW', 'acPvL1W', 'acPvL2W', 'acPvL3W', 'acPv2L1W', 'acPv2L2W', 'acPv2L3W'];

// A24: Alter monoton, wenn der Poller den Stempel monoton markiert hat (gleiche Uhr), sonst Wanduhr wie bisher.
function fieldAgeMs(state, field, now, clock = sharedMonoNow) {
  const stamps = state?.victron?.fieldUpdatedAt;
  const at = Number(stamps?.[field] ?? 0);
  if (!(at > 0)) return null;
  const m = monoStampOf(stamps, field, clock);
  return m != null ? clock() - m : now - at;
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
  // extraFloorPct: herstellerabhängiger Boden (Sungrow: Geräte-Minimum + Puffer, als echter SoC).
  const floorPct = Math.max(Number(cfg?.optimizer?.hardFloorSocPct ?? 5) || 0, Number(resolved?.minSocPct ?? 0) || 0,
    Number(resolved?.extraFloorPct ?? 0) || 0);
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
  // Summiert wird NUR über diese Punkte, nicht v.pvTotalW: ein abgeschalteter
  // Punkt behält bis zum Neustart seinen letzten Wert, und pvTotalW zählt ihn
  // weiter mit (Gegenprüfung 6d58f509, P3).
  const pvPoints = PV_FIELDS.filter((f) => cfg?.points?.[f]?.enabled === true);
  const pvOk = pvPoints.length > 0
    && pvPoints.every((f) => fresh(f) && v[f] != null && v[f] !== '' && Number.isFinite(Number(v[f])));
  const pvW = pvOk ? Math.max(0, pvPoints.reduce((sum, f) => sum + Number(v[f]), 0)) : 0;

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
    batteryDischargeW: Math.max(0, Number(v.batteryDischargeW) || 0),
    // Akku-Leistung frisch gelesen (fürs Viertelstunden-Budget: eine
    // hängengebliebene 0 hieße sonst „entlädt nicht“, Codex d7dcce9c P2).
    batteryFresh: (() => {
      const age = fieldAgeMs(state, 'batteryPowerW', now);
      return age !== null && age <= BATTERY_POWER_MAX_AGE_MS && !v.errors?.batteryPowerW
        && v.freeze?.active !== true && v.batteryPowerW != null && Number.isFinite(Number(v.batteryPowerW));
    })()
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
  // Der Deckel selbst ist derselbe Kern wie beim Netzanschluss
  // (services/import-limit/core.js): nur senken, nie unter 0.
  if (tel?.socOk) return { value: capPositiveSetpoint(v, resolved.targetW).value, clamped: true, mode: 'target', reason: null };
  if (tel?.loadKnown) {
    const cap = capPositiveSetpoint(v, Math.max(resolved.targetW, Math.ceil(tel.netLoadW)));
    if (cap.clamped) return { value: cap.value, clamped: true, mode: 'net_load', reason: tel.socReason };
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

// com.victronenergy.settings /Settings/CGwacs/MaxDischargePower als int32 in W
// (dbus_modbustcp attributes.csv: 2720, int32, Skala 1; Venus ≥ 3.50). Anders
// als 2704 (int16, Skala 0,1) zeigt 2720 die Werkseinstellung −1 (unbegrenzt)
// eindeutig: 2704 rundet −1 × 0,1 auf 0 (mappings.cpp convertFromDbus) und
// liest sich wie eine Sperre.
export const MAX_DISCHARGE_INT32_ADDR = 2720;
export const MAX_DISCHARGE_INT16_ADDR = 2704;

/**
 * Was DVhub über die Entladegrenze sicher weiß, in dieser Reihenfolge:
 *   1. Poll-Punkt points.maxDischargeW (seit 1.0.10 im ausgelieferten
 *      Victron-Profil auf 2704 — Einspeisung aus Akku 2, multi-gx/floor-handoff.js),
 *   2. die eigene Rücklesung von Peak Shaving (state.ctrl._peakShaving.readback;
 *      ohne Poll-Punkt bzw. bei mehrdeutiger 0 — Gegenprüfung eb2f1a26),
 *   3. der eigene letzte Write.
 * Sonst null = unbekannt — dann hebt Peak Shaving keine Sperre auf.
 * ambiguousZero: die 0 stammt aus 2704 und kann auch −1 (unbegrenzt) heißen.
 * Eine mehrdeutige 0 aus dem Poll-Punkt weicht einer eindeutigen eigenen
 * Rücklesung (2720 bzw. MQTT).
 */
// A24 (Christin 23.11.2026): jede Quelle trägt neben `at` (Wanduhr) `mono` — die monotone Zeit des Erzeugers
// (Poller, Rücklesung von Peak Shaving, Schreibpfad) mit der Uhr `clock`, oder null ohne Marke. Verbraucher, die zwei
// Quellen nach „neuer als“ ordnen (Entlade-Wächter), vergleichen damit; Frische hier ebenso monoton, sonst Wanduhr.
export function knownMaxDischargeW(state, cfg, now = Date.now(), clock = sharedMonoNow) {
  const v = state?.victron || {};
  const maxAgeMs = Number(cfg?.victron?.telemetryMaxAgeMs ?? 90000);
  const rb = state?.ctrl?._peakShaving?.readback;
  const rbMono = rb ? monoStampOf(rb, 'at', clock) : null;
  const rbAge = rbMono != null ? clock() - rbMono : now - Number(rb?.at);
  // Ist der letzte Leseversuch gescheitert, gilt auch der alte Wert nicht mehr.
  const own = (rb && !rb.error && Number.isFinite(Number(rb.value)) && Number(rb.at) > 0 && rbAge <= maxAgeMs)
    ? { value: Number(rb.value), from: 'own_readback', at: Number(rb.at), mono: rbMono, tick: rb.tick ?? null, ambiguousZero: Number(rb.value) === 0 && rb.ambiguousZero === true }
    : null;
  const age = fieldAgeMs(state, 'maxDischargeW', now, clock);
  if (v.maxDischargeW != null && Number.isFinite(Number(v.maxDischargeW)) && age !== null && age <= maxAgeMs
      && !v.errors?.maxDischargeW) {
    const value = Number(v.maxDischargeW);
    // Eindeutig nur, wenn der Punkt 2720 wirklich als int32 über zwei Register
    // liest — mit quantity 1 käme nur das obere Wort an, jede Grenze unter
    // 65 536 W läse sich als 0 (Gegenprüfung c093f4b7, P3).
    const pt = cfg?.points?.maxDischargeW || {};
    const reads2720AsInt32 = Number(pt.address) === MAX_DISCHARGE_INT32_ADDR
      && String(pt.readType || '').toLowerCase() === 'int32' && Number(pt.quantity) >= 2;
    const ambiguousZero = value === 0 && cfg?.victron?.transport !== 'mqtt' && !reads2720AsInt32;
    if (ambiguousZero && own && !own.ambiguousZero) return own;
    // `at` bleibt der Wanduhr-Stempel des Pollers (superseded() vergleicht ihn mit dem Wanduhr-Write lastWriteAt);
    // aus dem monotonen Alter zurückgerechnet läge eine alte Lesung nach einem Sprung vorwärts „nach“ dem eigenen
    // Write (Codex 3018ff4d P2). Die monotone Reihenfolge trägt `mono`.
    return { value, from: 'readback', at: Number(v.fieldUpdatedAt.maxDischargeW), mono: monoStampOf(v.fieldUpdatedAt, 'maxDischargeW', clock), ambiguousZero };
  }
  if (own) return own;
  const lw = state?.schedule?.lastWrite?.maxDischargeW;
  if (lw && lw.value != null && Number.isFinite(Number(lw.value))) {
    return { value: Number(lw.value), from: 'own_write', at: Number(lw.at) || 0, mono: monoStampOf(lw, 'at', clock), source: lw.source };
  }
  return null;
}

/**
 * Rohwert von 2704 (int16, Victron: 10-W-Schritte) → Watt. Sentinels wie beim
 * Schreiben: rawSentinels unskaliert (0 = gesperrt), rawSentinelMap rückwärts
 * (32767 → -1 = unbegrenzt); 0xFFFF (-1) gilt ebenfalls als unbegrenzt.
 */
export function decodeMaxDischargeRaw(raw, conf = {}) {
  let r = Number(raw);
  if (!Number.isFinite(r)) return null;
  if (r > 0x7fff) r -= 0x10000;
  const map = conf.rawSentinelMap && typeof conf.rawSentinelMap === 'object' ? conf.rawSentinelMap : {};
  for (const [eng, mapped] of Object.entries(map)) if (Number(mapped) === r) return Number(eng);
  if ((Array.isArray(conf.rawSentinels) ? conf.rawSentinels.map(Number) : []).includes(r)) return r;
  if (r === -1) return -1;
  return r * Number(conf.scale ?? 1) + Number(conf.offset ?? 0);
}

function liftValueW(needW, capW) {
  const stepped = Math.ceil(Math.max(0, needW) / LIFT_STEP_W) * LIFT_STEP_W;
  return Math.max(LIFT_STEP_W, Math.min(capW, stepped));
}

function superseded(d, known, lastWrite) {
  // lastWrite ist immer DVhubs JÜNGSTER Write: stammt er nicht von Peak
  // Shaving, hat jemand (API, Leitstand, MQTT) nach unserer Freigabe gesetzt.
  if (lastWrite && !String(lastWrite.source || '').startsWith('peak_shaving')) return true;
  if (!known || (known.from !== 'readback' && known.from !== 'own_readback')) return false;
  // Eigene Rücklesung (Registerlesen am Anfang des Takts): keine Karenz — jede
  // Lesung NACH unserem Write, die weder unseren Wert noch den Wert davor zeigt
  // (Gerät hat noch nicht übernommen), ist eine Änderung von außen (Gegenprüfung
  // 563da829). Ein Poll-Punkt hinkt dagegen hinterher → 10 s Karenz.
  // Reihenfolge über die Taktnummer statt der Uhr: Lesen und Schreiben können in
  // derselben Millisekunde liegen. Nach einem Neustart (keine Taktnummer im
  // Merker) liegt jede neue Lesung hinter dem Write.
  if (known.from === 'own_readback') {
    const writeTick = Number.isFinite(Number(d.lastWriteTick)) ? Number(d.lastWriteTick) : -Infinity;
    if (!(Number(known.tick) > writeTick)) return false;
  } else {
    // A24 (Codex 243a25d4 P2): Poll-Lesung gegen den eigenen Write monoton, wenn beide eine monotone Zeit haben
    // (known.mono vom Poller, d.lastWriteAt beim Write gestempelt; gemeinsame Uhr) — sonst Wanduhr wie bisher.
    // Nach einem Rücksprung zwischen Poll und Write läge die alte Lesung per Wanduhr sonst „danach“.
    const writeMono = monoStampOf(d, 'lastWriteAt');
    const notAfter = known.mono != null && writeMono != null
      ? known.mono <= writeMono + READBACK_GRACE_MS
      : known.at <= (Number(d.lastWriteAt) || 0) + READBACK_GRACE_MS;
    if (notAfter) return false;
  }
  // Der Wert VOR unserem Write zählt nur in der ersten eigenen Lesung danach
  // (Gerät hat noch nicht übernommen) — danach ist er eine Änderung von außen
  // bzw. ein nie übernommener Write (Gegenprüfung fa328b3a, P2).
  const prevCounts = known.from === 'own_readback' && Number(known.tick) === Number(d.lastWriteTick) + 1;
  const ours = [Number(d.liftedW), prevCounts ? Number(d.prevW) : NaN].filter((w) => Number.isFinite(w));
  // -1 (unbegrenzt) ist eine Betriebsart, keine Zahl nahe 0: nur exakt vergleichen.
  const same = (a, w) => ((a === -1 || w === -1) ? a === w : Math.abs(a - w) <= READBACK_TOLERANCE_W);
  return !ours.some((w) => same(known.value, w));
}

/**
 * Ein Takt der Entlade-Freigabe (rein; ändert nur die Zähler in d).
 * d.phase 'idle' | 'lifted'. Rückgabe: was der Evaluator schreiben soll.
 * @returns {{ type: 'none'|'lift'|'raise'|'restore'|'superseded', valueW?: number, reason?: string }}
 */
export function dischargeStep(d, { ps, tel, known, paused, capW, lastWrite = null, readbackSupported = false }) {
  if (d.phase === 'lifted') {
    if (superseded(d, known, lastWrite)) return { type: 'superseded' };
    // Zurück zur Sperre nur, wenn sicher ist, dass im GX noch DVhubs Freigabe
    // steht: eine Rücklesung (Abweichung wäre oben „superseded“) — oder, wo das
    // Gerät gar nicht rücklesbar ist, der eigene letzte Write. Sonst warten
    // statt blind 0 zu schreiben (Gegenprüfung eb2f1a26).
    d.waiting = null;
    const confirmed = known?.from === 'readback' || known?.from === 'own_readback'
      || (!readbackSupported && known?.from === 'own_write');
    const restore = (why) => {
      if (confirmed) { d.waiting = null; return { type: 'restore', reason: why }; }
      d.waiting = 'readback';
      return { type: 'none' };
    };
    const reason = paused ? 'emergency_stop'
      : !ps?.active ? (ps?.reason || 'disabled')
        : tel.socReason ? tel.socReason
          : !tel.meterFresh ? 'meter_stale' : null;
    if (reason) return restore(reason);
    const demandW = tel.importW + tel.batteryDischargeW;
    if (tel.importW > ps.limitW) {
      d.under = 0;
      const next = liftValueW(demandW - ps.targetW, capW);
      return next > Number(d.liftedW) ? { type: 'raise', valueW: next } : { type: 'none' };
    }
    d.under = demandW < ps.targetW - ps.releaseHysteresisW ? (d.under || 0) + 1 : 0;
    if (d.under >= DISCHARGE_RELEASE_TICKS) return restore('below_limit');
    return { type: 'none' };
  }
  // Eine 0 aus 2704 (ambiguousZero) zählt nur, wenn DVhub selbst zuletzt 0
  // geschrieben hat — sonst kann es die Werkseinstellung −1 (unbegrenzt) sein:
  // eine „Freigabe“ deckelte dann den Akku, und die Rückkehr schriebe eine
  // echte Sperre (0) ins GX (Entlade-Wächter-Befund 02.11.2026).
  const ownZero = lastWrite != null && lastWrite.value != null && Number(lastWrite.value) === 0;
  const blocked = known != null && known.value === 0 && (known.ambiguousZero !== true || ownZero);
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
 * Regelziel für EOS (P2): aktiv → Grenze − Abstand, sonst null. EOS plant in
 * Viertelstunden-Energie — das Ziel ist zugleich das Budget-Mittel.
 */
export function eosPeakShavingTargetW(cfg) {
  const r = resolvePeakShaving(cfg);
  return r.active ? r.targetW : null;
}

/**
 * Leistungsentgelt für die Historie (P4, GET /api/history/peak-billing): Jahr
 * bzw. Monat des Datums `date` (YYYY-MM-DD, Ortszeit). Gerechnet wird immer
 * über das ganze Kalenderjahr (Stufe nach Benutzungsdauer); die Monatsansicht
 * zeigt dazu die Zeile des Monats. enabled=false: Peak Shaving ist aus (die
 * Historie blendet die Karte dann aus).
 */
export async function peakBillingReport(store, cfg, { view = 'year', date = null, nowMs = Date.now() } = {}) {
  const r = resolvePeakShaving(cfg);
  if (!r.enabled) return { status: 200, body: { ok: true, enabled: false } };
  if (typeof store?.getPeakBillingMonths !== 'function') return { status: 503, body: { ok: false, error: 'internal telemetry store disabled' } };
  const tz = cfg?.schedule?.timezone || 'Europe/Berlin';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  const at = m ? localMidnightUtcMs(Number(m[1]), Number(m[2]), Number(m[3]), tz) + 12 * 3_600_000 : nowMs;
  if (!Number.isFinite(at)) return { status: 400, body: { ok: false, error: 'invalid date' } };
  const p = peakPeriods(at, tz);
  const months = await store.getPeakBillingMonths({ ...p.year, timeZone: tz });
  const tariff = resolveTariff(cfg);
  const year = computeYearBilling({ months, tariff, period: { startMs: Date.parse(p.year.start), endMs: Date.parse(p.year.end) }, nowMs });
  const lp = localParts(at, tz);
  const ym = `${lp.year}-${String(lp.month).padStart(2, '0')}`;
  return {
    status: 200,
    body: {
      ok: true, enabled: true, view: view === 'month' ? 'month' : 'year', year: lp.year, ym,
      limitW: r.limitW, model: tariff.model, tariffComplete: tariff.complete, tariffMissing: tariff.missing,
      billing: year,
      month: view === 'month' ? (year.months.find((x) => x.ym === ym) || { ym, energyKwh: 0, peakW: null }) : null
    }
  };
}

/** Deutsche Kurztexte, warum DVhub gerade auf den Augenblickswert deckelt. */
export const BUDGET_REASON_TEXT = Object.freeze({
  billing_instant: 'Abrechnung nach Augenblickswert eingestellt',
  no_data: 'Viertelstunde noch ohne Messwerte',
  clock_jump: 'Uhrzeit gesprungen',
  measurements_uncertain: 'Messlücken in dieser Viertelstunde',
  meter_stale: 'Zählerwert nicht frisch',
  slot_ending: 'Viertelstunde endet gleich',
  soc_unknown: 'Ladestand unbekannt',
  telemetry_frozen: 'Messwerte eingefroren',
  source_mismatch: 'Messquellen widersprechen sich',
  soc_floor: 'Akku am Mindest-Ladestand',
  soc_near_floor: 'Akku nahe am Mindest-Ladestand',
  discharge_unknown: 'Entladeleistung des Akkus nicht eingetragen',
  discharge_limited: 'Akku entlädt schon nahe seiner Höchstleistung',
  battery_power_unknown: 'Akku-Leistung nicht frisch gemessen',
  soc_energy: 'Energie im Akku reicht nicht für den Rest der Viertelstunde',
  budget_exceeded: 'Budget der Viertelstunde verbraucht'
});

/**
 * Akku-Lage für das Viertelstunden-Budget. Die Entladeleistung zählt nur, wenn
 * der Betreiber sie eingetragen hat (Akku-Grenzen: „Max. Entladeleistung“ bzw.
 * „Wechselrichter-Nennleistung“, oder system.power) — nicht die Werks-Vorgaben
 * und nicht die Vorgabe der Kleinen Börsenautomatik. Sonst weiß DVhub nicht, ob
 * der Akku den Bezug zurückholen kann, und bleibt beim Augenblickswert.
 * Kapazität ebenso (ohne Eintrag entfällt nur die Energie-Prüfung).
 */
export function budgetBatteryInput(cfg, tel, { liveLimitW = null } = {}) {
  const pos = (v) => (finite(v) && Math.abs(Number(v)) > 0 ? Math.abs(Number(v)) : null);
  const sp = cfg?.system?.power || {};
  const opt = cfg?.optimizer || {};
  const rated = [pos(sp.batteryMaxDischargeDcW) ?? pos(opt.maxDischargeW), pos(sp.inverterMaxPowerW) ?? pos(opt.inverterMaxPowerW)]
    .filter((w) => w != null);
  // Eine gerade im Gerät stehende Entladegrenze unter der Nennleistung zählt mit
  // (Codex d7dcce9c P1) — nur, wenn es überhaupt eine Nennleistung gibt.
  const caps = rated.length && finite(liveLimitW) && Number(liveLimitW) > 0 ? [...rated, Number(liveLimitW)] : rated;
  return {
    socOk: tel?.socOk === true,
    socReason: tel?.socReason ?? null,
    soc: tel?.soc ?? null,
    floorPct: tel?.floorPct ?? 0,
    dischargeW: tel?.batteryFresh === true ? Math.max(0, Number(tel?.batteryDischargeW) || 0) : null,
    maxDischargeW: caps.length ? Math.min(...caps) : null,
    capacityWh: pos(sp.batteryCapacityWh) ?? pos(opt.batteryCapacityWh)
  };
}

/**
 * Status-Dienst für Leitstand und /api/status. Läuft im Laufzeit-Prozess
 * (dort liegen Steuerzustand und Datenbank); die Spitzen kommen alle 5 min aus
 * energy_slots_15m. Ausgeschaltet: kein Status, keine Abfrage.
 */
export function createPeakShaving(ctx, deps = {}) {
  const now = deps.now || (() => Date.now());
  const mono = deps.monoNow || (deps.now ? deps.now : defaultMonoNow);
  let peaks = { month: null, year: null, updatedAt: null, error: null };
  let timer = null;
  let busy = false;
  // Viertelstunden-Budget (P1): je Zählerabfrage fortgeschrieben (pollTick).
  const budget = createBudgetState();
  let budgetLogKey = null;

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
      // P3: angepasst wird nur an ABGESCHLOSSENE Viertelstunden — die laufende
      // wächst noch; ein Deckel auf ihren Zwischenstand höbe die Spitze weiter
      // an (Codex ac14daee P1).
      const tz = c.schedule?.timezone || 'Europe/Berlin';
      const openStart = new Date(quarterHourSlot(nowMs, tz).startMs).toISOString();
      const closedEnd = (per) => (Date.parse(per.end) > Date.parse(openStart) ? openStart : per.end);
      const adaptOn = resolvePeakShaving(c).adaptToReachedPeak;
      const adaptMonth = adaptOn ? await store.getGridImportPeak({ start: p.month.start, end: closedEnd(p.month) }) : null;
      const adaptYear = adaptOn ? await store.getGridImportPeak({ start: p.year.start, end: closedEnd(p.year) }) : null;
      const strip = (x) => (x ? { slotStart: x.slotStart, powerW: x.powerW } : null);
      // P4: Monatswerte des laufenden Jahres fürs Leistungsentgelt (ohne
      // Datenbank-Funktion: keine €-Anzeige, die Spitzen bleiben).
      let months = null;
      if (typeof store.getPeakBillingMonths === 'function') {
        months = await store.getPeakBillingMonths({ ...p.year, timeZone: c.schedule?.timezone || 'Europe/Berlin' });
      }
      peaks = {
        month: strip(month), year: strip(year), periods: p, months,
        adapt: { month: strip(adaptMonth), year: strip(adaptYear) },
        updatedAt: new Date(nowMs).toISOString(), error: null
      };
    } catch (e) {
      peaks = { ...peaks, error: e?.message || String(e) };
    } finally {
      busy = false;
    }
  }

  // Entladegrenze, die gerade im Gerät steht und Peak Shaving bzw. die
  // Akku-Hilfe NICHT selbst gesetzt hat (eine eigene Freigabe kann DVhub weiter
  // anheben; 0 = Sperre hebt Peak Shaving selbst auf; −1 = unbegrenzt).
  function liveDischargeLimitW(c, t) {
    const k = knownMaxDischargeW(ctx.state, c, t);
    if (!k || !Number.isFinite(k.value) || k.value <= 0) return null;
    if (ctx.state?.ctrl?._peakShaving?.discharge?.phase === 'lifted') return null;
    const lw = ctx.state?.schedule?.lastWrite?.maxDischargeW;
    if (lw && /^(peak_shaving|grid_connection)/.test(String(lw.source || '')) && Number(lw.value) === k.value) return null;
    return k.value;
  }

  // Sungrow meldet den Ladestand relativ zum Geräte-Fenster: verglichen wird der
  // echte Ladestand gegen den Boden aus hartem Boden und Geräte-Minimum + Puffer
  // (wie der Sungrow-Aktor, sungrowDischargeFloorPct) — JE Wechselrichter gegen
  // seinen eigenen Boden. Mit zweitem WR (aggregateTelemetry) zählt der WR mit
  // dem KLEINSTEN Abstand zu seinem Boden (inkl. peakShaving.minSocPct): der
  // Sungrow-Split prüft den Peak-Shaving-Boden nicht je WR, und die Kapazität im
  // Budget ist die des Systems — mit dem kleinsten Abstand ist beides eine
  // sichere Untergrenze (Codex d6916ada P1/P2). Hat nur ein WR Luft, bleibt es
  // beim heutigen Verhalten (Christin: im Zweifel Augenblickswert/kein Eingriff;
  // offene Entscheidung zu Codex 57c5dc10). Frische/Fehler bleiben die des
  // gemeldeten Felds (Codex e5a25ac1/65c52509).
  function sungrowSocView(c) {
    if (String(c?.manufacturer || '') !== 'sungrow') return null;
    const st = ctx.state || {};
    const v = st.victron || {};
    const hard = Number(c?.optimizer?.hardFloorSocPct ?? 5);
    let buf;
    try { buf = sungrowSocFloorBufferPct(c); } catch { buf = 0; }
    const dev = v.device || {};
    const masterReported = finite(v.sungrowMasterSocPct) ? Number(v.sungrowMasterSocPct) : v.soc;
    const cands = [];
    const add = (reported, devMin, devMax) => {
      const real = sungrowRealSocPct(reported, devMin, devMax);
      if (real == null || !Number.isFinite(Number(real))) return;
      const psMin = Number(c?.peakShaving?.minSocPct);
      const floor = Math.max(sungrowDischargeFloorPct(hard, devMin, buf), Number.isFinite(psMin) && c?.peakShaving?.minSocPct != null && c.peakShaving.minSocPct !== '' ? psMin : 0);
      cands.push({ soc: Number(real), floor });
    };
    add(masterReported, dev.minSocPctDevice, dev.maxSocPctDevice);
    try {
      if (resolveSecondInverter(c).aggregateTelemetry === true) {
        const t2 = secondInverterTelemetry(st, c, {});
        if (t2) add(t2.socPct, t2.minSocPctDevice, t2.maxSocPctDevice);
      }
    } catch { /* ohne zweiten WR */ }
    if (!cands.length) return null;
    return cands.reduce((a, b) => (b.soc - b.floor < a.soc - a.floor ? b : a));
  }
  function realSocState(c) {
    const view = sungrowSocView(c);
    const st = ctx.state || {};
    if (!view) return st;
    return { ...st, victron: { ...st.victron, soc: view.soc } };
  }
  function withDeviceFloor(c, r) {
    const view = sungrowSocView(c);
    return view ? { ...r, extraFloorPct: view.floor } : r;
  }

  function budgetBattery(c, r, t) {
    const tel = peakShavingTelemetry(realSocState(c), c, withDeviceFloor(c, r), t);
    return { tel, battery: budgetBatteryInput(c, tel, { liveLimitW: liveDischargeLimitW(c, t) }) };
  }

  /**
   * Wirksame Regelwerte für den Steuerpfad: wie resolvePeakShaving, im
   * Budget-Modus mit limitW = targetW = erlaubte Restleistung der Viertelstunde
   * (configuredLimitW/configuredTargetW bleiben die Einstellung). Ohne aktives
   * Peak Shaving unverändert.
   */
  /**
   * P3: Grenze an die erreichte Spitze des Abrechnungszeitraums anpassen (Jahr,
   * bei Monatsleistungspreis Monat). Nur mit Schalter, nur mit einer Spitze aus
   * DEM laufenden Zeitraum (nach dem Jahres-/Monatswechsel gilt bis zum nächsten
   * Lesen wieder die Einstellung), auf 100 W abgerundet. Liefert die Auflösung
   * mit angepasster limitW/targetW sowie adaptedFrom/reachedPeakW.
   */
  function adapted(c, r, t = now()) {
    const scope = c?.peakShaving?.tariff?.model === 'month' ? 'month' : 'year';
    // Mit Schalter nur abgeschlossene Viertelstunden; für den Hinweis (Schalter
    // aus) reicht die angezeigte Spitze.
    const pk = r.adaptToReachedPeak ? peaks.adapt?.[scope] : peaks[scope];
    const per = peaks.periods?.[scope];
    const cur = per ? peakPeriods(t, c.schedule?.timezone || 'Europe/Berlin')[scope] : null;
    const current = Boolean(pk && per && cur && per.start === cur.start && finite(pk.powerW));
    const reachedPeakW = current ? Math.round(Number(pk.powerW)) : null;
    const info = { configuredLimitW: r.limitW, configuredTargetW: r.targetW, adaptScope: scope, reachedPeakW, adaptedFrom: null };
    if (!r.active || !r.adaptToReachedPeak || reachedPeakW == null) return { ...r, ...info };
    const w = Math.min(MAX_LIMIT_W, Math.floor(reachedPeakW / 100) * 100);
    if (!(w > r.limitW)) return { ...r, ...info };
    return { ...r, ...info, limitW: w, targetW: w - r.marginW, adaptedFrom: scope };
  }

  function control(c = cfg(), t = now()) {
    const r0 = resolvePeakShaving(c);
    if (!r0.active) return r0;
    const r = adapted(c, r0, t);
    const base = r;
    const { battery } = budgetBattery(c, r, t);
    const meas = meterImport(ctx.state, c, { now: t, maxAgeMs: METER_MAX_AGE_MS });
    const dec = decideBudget(budget, {
      enabled: r.billing15min, wallMs: t, limitW: r.limitW, marginW: r.marginW, targetW: r.targetW,
      importW: meas.fresh ? meas.importW : null, battery
    });
    if (dec.mode === 'budget') return { ...base, limitW: dec.targetW, targetW: dec.targetW, budget: dec };
    return { ...base, budget: dec };
  }

  // P5: Profile mit eigenem Netz-Sollwert bzw. Entladegrenze (Sungrow-EMS,
  // MQTT-Bridge, DVhub-MQTT): Akku-Hilfe beim Netzanschluss-Wächter anfordern —
  // höchster Netzbezug = Regelziel (im Budget-Modus die erlaubte Restleistung).
  // Gilt 30 s und wird je Zählerabfrage erneuert; fällt der Dienst aus, läuft
  // sie ab. Not-Halt: der Wächter nimmt keine an (und gibt eine stehende frei).
  const ASSIST_SOURCE = 'peak-shaving';
  let assistHeld = false;
  let assistLogKey = null;
  function nativeAssist(ctl, t, c = null) {
    const assist = ctx.batteryAssist || ctx.gridConnection?.batteryAssist || null;
    const want = ctl && ctl.active && ctl.lever === 'native' && Number.isFinite(Number(ctl.targetW));
    if (!want || typeof assist?.request !== 'function') {
      if (assistHeld) assist?.release?.(ASSIST_SOURCE);
      assistHeld = false;
      if (ctx.state?.ctrl?._peakShaving?.assist) ctx.state.ctrl._peakShaving.assist = null;
      assistLogKey = null;
      return;
    }
    // Ladestand-Schutz wie beim Victron-Hebel (Codex 2be66554 P1): der Wächter
    // prüft beim Sollwert-Deckel keinen Ladestand und bei der Entladegrenze nur
    // seine eigenen Böden. Ladestand unbekannt, veraltet, eingefroren oder am
    // Boden (inkl. peakShaving.minSocPct) → keine Anforderung, eine stehende zurück.
    const tel = peakShavingTelemetry(realSocState(c || cfg()), c || cfg(), withDeviceFloor(c || cfg(), ctl), t);
    const res = tel.socOk
      ? (assist.request({ source: ASSIST_SOURCE, maxImportW: Math.max(0, Math.round(ctl.targetW)), untilMs: t + 30_000 }) || {})
      : { ok: false, reason: tel.socReason || 'soc_unknown' };
    // Abgelehnt (Not-Halt, Ladestand, …): eine früher angenommene Anforderung
    // nicht stehen lassen — der Wächter behält sie sonst bis zum Ablauf
    // (Codex 2be66554 P2).
    if (res.ok !== true) assist.release?.(ASSIST_SOURCE);
    assistHeld = res.ok === true;
    if (ctx.state) {
      ctx.state.ctrl ??= {};
      (ctx.state.ctrl._peakShaving ??= {}).assist = {
        requested: assistHeld, maxImportW: Math.round(ctl.targetW), reason: assistHeld ? null : (res.reason || 'rejected'), at: t
      };
    }
    const key = `${assistHeld}|${res.reason || ''}`;
    if (key !== assistLogKey) {
      assistLogKey = key;
      ctx.pushLog?.('peak_shaving_assist', {
        requested: assistHeld, maxImportW: Math.round(ctl.targetW), reason: res.reason || null, lever: ctl.leverText,
        text: assistHeld ? `Peak Shaving: Akku-Hilfe angefordert (${ctl.leverText})` : `Peak Shaving: Akku-Hilfe nicht möglich (${res.reason || 'abgelehnt'})`
      }, assistHeld ? 'info' : 'warn');
    }
  }

  /** Je Zählerabfrage (polling.js): Netzbezug ins Viertelstunden-Budget. */
  function pollTick() {
    try { syncEosOnChange(); } catch { /* nur Abgleich */ }
    const c = cfg();
    const r = resolvePeakShaving(c);
    if (!r.active) {
      if (budget.lastMono != null) Object.assign(budget, createBudgetState());
      budgetLogKey = null;
      nativeAssist(null, now());
      return null;
    }
    const t = now();
    const meas = meterImport(ctx.state, c, { now: t, maxAgeMs: METER_MAX_AGE_MS });
    observeBudget(budget, {
      wallMs: t, monoMs: mono(), importW: meas.fresh ? meas.importW : null, limitW: adapted(c, r, t).limitW,
      timeZone: c.schedule?.timezone || 'Europe/Berlin'
    });
    const ctl = control(c, t);
    nativeAssist(ctl, t, c);
    const dec = ctl.budget;
    const key = dec ? `${dec.mode}|${dec.reason}` : null;
    if (key !== budgetLogKey) {
      budgetLogKey = key;
      if (dec) ctx.pushLog?.('peak_shaving_budget', {
        mode: dec.mode, reason: dec.reason, targetW: ctl.targetW, limitW: r.limitW, usedWh: dec.usedWh, budgetWh: dec.budgetWh,
        remainingS: dec.remainingS,
        text: dec.mode === 'budget'
          ? 'Peak Shaving: regelt nach Viertelstunden-Budget (15-min-Mittelwert)'
          : `Peak Shaving: Deckel auf den Augenblickswert (${BUDGET_REASON_TEXT[dec.reason] || dec.reason})`
      });
    }
    return ctl;
  }

  // P4: Leistungsentgelt des laufenden Jahres (bzw. Monats beim
  // Monatsleistungspreis) für die Leitstand-Kachel.
  function billingSummary(c, t) {
    const per = peaks.periods?.year;
    if (!Array.isArray(peaks.months) || !per) return null;
    const cur = peakPeriods(t, c.schedule?.timezone || 'Europe/Berlin').year;
    if (cur.start !== per.start) return null;
    const tariff = resolveTariff(c);
    const y = computeYearBilling({ months: peaks.months, tariff, period: { startMs: Date.parse(per.start), endMs: Date.parse(per.end) }, nowMs: t });
    const ym = peaks.periods?.month?.start ? localParts(Date.parse(peaks.periods.month.start), c.schedule?.timezone || 'Europe/Berlin') : null;
    const ymKey = ym ? `${ym.year}-${String(ym.month).padStart(2, '0')}` : null;
    const month = ymKey ? (y.months || []).find((m) => m.ym === ymKey) || null : null;
    const year = { ...y };
    delete year.months;
    return { year, month, tariffComplete: tariff.complete, tariffMissing: tariff.missing, model: tariff.model };
  }

  function summary() {
    const c = cfg();
    const r = resolvePeakShaving(c);
    if (!r.enabled) return null;
    const s = ctx.state || {};
    const t = now();
    const ctl = s.ctrl?._peakShaving || {};
    // A26: Alter des Deckel-Signals monoton (Marke aus schedule-eval), ohne Marke Wanduhr.
    const clampFresh = ctl.clamp && (monoStampAge(ctl.clamp, 'at') ?? (t - Number(ctl.clamp.at || 0))) <= CLAMP_FRESH_MS;
    const clamp = clampFresh
      ? { requestedW: ctl.clamp.requestedW, valueW: ctl.clamp.valueW, mode: ctl.clamp.mode, reason: ctl.clamp.reason ?? null, source: ctl.clamp.source }
      : null;
    const lift = ctl.discharge?.phase === 'lifted'
      ? { liftedW: ctl.discharge.liftedW, since: ctl.discharge.since, waiting: ctl.discharge.waiting || null } : null;
    const meterFresh = s.meter?.ok === true && (t - Number(s.meter.updatedAt || 0)) < METER_MAX_AGE_MS
      && Number.isFinite(Number(s.victron?.gridImportW));
    const ctlNow = r.active ? control(c, t) : null;
    const b = ctlNow?.budget || null;
    const ad = adapted(c, r, t);
    const adapt = {
      on: r.adaptToReachedPeak,
      scope: ad.adaptScope,
      reachedPeakW: ad.reachedPeakW,
      active: ad.adaptedFrom != null,
      effectiveLimitW: ad.limitW,
      effectiveTargetW: ad.targetW,
      // Hinweis (P3): Spitze schon über der Grenze, Schalter aus → jede weitere
      // Kappung unter die Spitze spart in diesem Zeitraum nichts.
      suggest: !r.adaptToReachedPeak && r.limitW != null && ad.reachedPeakW != null && ad.reachedPeakW > r.limitW
    };
    return {
      enabled: true,
      active: r.active,
      supported: r.supported,
      reason: r.reason,
      message: peakShavingStatusText(r),
      limitW: r.limitW,
      targetW: r.targetW,
      marginW: r.marginW,
      billing15min: r.billing15min,
      lever: r.lever,
      leverText: r.leverText,
      assist: r.lever === 'native' && ctl.assist ? { ...ctl.assist, helpW: nativeHelpW() } : null,
      // P5: eingebaute Funktion des Wechselrichters (ungetestet) — Zustand des Aktors.
      builtin: r.lever === 'builtin' || r.lever === 'builtin_off' ? { status: 'ungetestet', ...(ctl.builtin || {}) } : null,
      adapt,
      // Viertelstunden-Budget (P1): mode 'budget' = Regelziel ist die erlaubte
      // Restleistung, 'instant' = Augenblickswert (reason sagt warum).
      budget: b ? {
        mode: b.mode, reason: b.reason, reasonText: b.reason ? (BUDGET_REASON_TEXT[b.reason] || b.reason) : null,
        controlTargetW: ctlNow.targetW, allowedW: b.allowedW, usedWh: b.usedWh, budgetWh: b.budgetWh,
        remainingS: b.remainingS, gapS: b.gapS, intervening: b.intervening,
        slotStart: b.slotStartMs != null ? new Date(b.slotStartMs).toISOString() : null
      } : null,
      billing: billingSummary(c, t),
      timezone: c.schedule?.timezone || 'Europe/Berlin',
      importW: meterFresh ? Math.max(0, Math.round(Number(s.victron.gridImportW))) : null,
      acting: Boolean((clamp && (clamp.mode === 'target' || clamp.mode === 'net_load')) || lift
        || (r.lever === 'native' && ctl.assist?.requested && nativeHelpW() > 0 && meterFresh && Number(s.victron.gridImportW) >= Number(ctlNow?.targetW) - 500)),
      clamp,
      lift,
      peaks: { month: peaks.month, year: peaks.year, updatedAt: peaks.updatedAt, error: peaks.error }
    };
  }

  function start() {
    if (timer) return;
    refreshPeaks().catch(() => {});
    timer = setInterval(() => { refreshPeaks().catch(() => {}); }, PEAK_REFRESH_MS);
    timer.unref?.();
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  /** Regelziel für EOS (P2): eingestellt bzw. angepasst (P3), ohne Budget; null = aus. */
  function eosTargetW(c = cfg()) {
    const r = resolvePeakShaving(c);
    return r.active ? adapted(c, r).targetW : null;
  }

  // Wirksames EOS-Ziel geändert (Grenze an die Spitze angepasst, neuer
  // Zeitraum, Peak Shaving ein/aus): EOS neu abgleichen, höchstens jede Minute,
  // aber nicht vergessen. Der erste Wert nach dem Start löst nichts aus (der
  // normale Abgleich läuft ohnehin).
  // Erst eine erfolgreiche Übertragung quittiert den Wert; scheitert sie, wird
  // nach der Minute erneut versucht (Codex ac14daee P2).
  let eosKey;
  let eosSyncedKey;
  let eosSyncBusy = false;
  let lastEosSyncAt = -Infinity;
  function syncEosOnChange() {
    const key = String(eosTargetW());
    if (eosKey === undefined) { eosKey = key; eosSyncedKey = key; return; }
    eosKey = key;
    if (eosKey === eosSyncedKey || eosSyncBusy || mono() - lastEosSyncAt < 60_000) return;
    if (typeof ctx.eosConfigSync?.sync !== 'function') return;
    lastEosSyncAt = mono();
    const sent = eosKey;
    eosSyncBusy = true;
    Promise.resolve(ctx.eosConfigSync.sync())
      .then((res) => {
        // Quittiert ist, was im Wechselrichter-Abschnitt angekommen ist (oder dort
        // schon stand) — auch wenn ein anderer Abschnitt scheiterte. Sonst gilt
        // der alte Stand als unbekannt, damit auch eine Rückkehr zum früheren
        // Wert neu geschickt wird (Codex 4638c207 P2).
        const inv = 'devices/inverters';
        const delivered = res && !res.errors?.[inv]
          && ((Array.isArray(res.applied) && res.applied.includes(inv)) || (Array.isArray(res.unchanged) && res.unchanged.includes(inv)));
        eosSyncedKey = delivered ? sent : null;
      })
      .catch(() => { eosSyncedKey = null; })
      .finally(() => { eosSyncBusy = false; });
  }

  function nativeHelpW() {
    try {
      const st = (ctx.batteryAssist || ctx.gridConnection?.batteryAssist)?.status?.(ASSIST_SOURCE);
      return Math.max(0, Number(st?.helpW) || 0);
    } catch { return 0; }
  }

  function stopAll() {
    stop();
    nativeAssist(null, now());
  }

  return { refreshPeaks, summary, start, stop: stopAll, control, pollTick, eosTargetW, _budget: budget };
}
