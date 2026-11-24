// services/peak-shaving/budget.js — Viertelstunden-Budget für Peak Shaving (Christin 24.11.2026, P1).
//
// RLM rechnet den Leistungspreis auf den höchsten 15-Minuten-MITTELWERT des Netzbezugs, nicht auf einen
// Augenblickswert. Eine kurze Spitze über der Grenze kostet nichts, solange die Viertelstunde im Mittel darunter
// bleibt. Darum führt DVhub je Viertelstunde (lokal ganzzahlig :00/:15/:30/:45) ein Energiebudget:
//
//   Budget   = Grenze × 15 min
//   verbraucht = Σ Netzbezug × gemessener Abstand (monotone Uhr), Einspeisung zählt 0
//   erlaubt  = (Budget − Abstand × 15 min − verbraucht) / Restzeit der Viertelstunde
//
// „erlaubt“ ist die Bezugsleistung, die DVhub ab jetzt bis zum Ende der Viertelstunde halten muss, damit der
// Mittelwert unter Grenze − Abstand bleibt. Liegt der Bezug darunter, würde die Hochrechnung das Budget nicht
// reißen — DVhub greift nicht ein. Liegt er darüber, greift DVhub mit genau dieser Restleistung ein.
//
// Harte Absicherung (Christin: „nur wenn wir sicher eingreifen/entladen können“): Sobald einer der Punkte unten
// nicht sicher ist, gilt sofort das heutige Verhalten — Deckel auf den Augenblickswert (Grenze − Abstand):
//   - Einstellung „Abrechnung nach 15-min-Mittelwert“ aus,
//   - Viertelstunde nicht lückenlos gemessen (Lücken > 60 s, Uhrsprung, Neustart mitten in der Viertelstunde),
//   - Zählerwert jetzt nicht frisch,
//   - Rest der Viertelstunde kürzer als 60 s (der Akku braucht Sekunden zum Folgen),
//   - Ladestand unbekannt, eingefroren, am Boden oder weniger als 5 Prozentpunkte darüber; Akku-Leistung nicht frisch,
//   - Entladeleistung unbekannt oder ausgeschöpft — der Akku muss den Bezug JEDERZEIT auf den Augenblickswert
//     zurückholen können; deshalb darf das Budget den Bezug nie weiter über Grenze − Abstand lassen, als der Akku
//     noch zusätzlich entladen kann (Rückfall ist damit immer machbar),
//   - die Energie im Akku reicht nicht für den Rest der Viertelstunde (nur mit eingetragener Kapazität),
//   - Budget schon verbraucht.
// Lücken zählen konservativ als Bezug mindestens an der Grenze (oder höher, wenn ein Messwert daneben höher lag).
// Rein: keine Uhr, kein Zustand außer dem übergebenen Objekt.

import { zoneOffsetMs } from '../../tz-fast.js';

export const SLOT_MS = 15 * 60_000;
// Zwei Messwerte, die weiter auseinander liegen, gelten als Lücke (Zähler alle 2 s, Rückfalltakt 5 s).
export const SAMPLE_MAX_GAP_MS = 10_000;
// Mehr Lücke je Viertelstunde → Messwerte unsicher → Augenblickswert.
export const BUDGET_MAX_GAP_MS = 60_000;
// Kürzerer Rest → Augenblickswert (der Akku braucht Sekunden, bis er einer neuen Vorgabe folgt).
export const BUDGET_MIN_REMAINING_MS = 60_000;
// Ladestand muss mindestens so viele Prozentpunkte über dem Boden liegen.
export const BUDGET_SOC_HEADROOM_PCT = 5;
// Reserve der Entladeleistung: mindestens 500 W bzw. 10 % der Entladeleistung bleiben ungenutzt.
export const BUDGET_DISCHARGE_RESERVE_MIN_W = 500;
export const BUDGET_DISCHARGE_RESERVE_PCT = 10;
// Wanduhr und monotone Uhr laufen um mehr auseinander → Uhrsprung (NTP, Hand-Einstellung).
export const CLOCK_JUMP_TOL_MS = 5_000;
const STEP_W = 100;

const finite = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

/**
 * Viertelstunde, in der wallMs liegt — ganzzahlig in Ortszeit (:00/:15/:30/:45). Bei der Zeitumstellung ist jede
 * Viertelstunde trotzdem 15 min lang (die doppelte Stunde im Oktober hat zwei eigene Viertelstunden-Folgen).
 * @returns {{ startMs: number, endMs: number }}
 */
export function quarterHourSlot(wallMs, timeZone = 'Europe/Berlin') {
  const off = zoneOffsetMs(wallMs, timeZone);
  const local = wallMs + off;
  const startLocal = Math.floor(local / SLOT_MS) * SLOT_MS;
  const startMs = startLocal - off;
  return { startMs, endMs: startMs + SLOT_MS };
}

export function createBudgetState() {
  return { slotStartMs: null, slotEndMs: null, usedWs: 0, gapMs: 0, lastMono: null, lastWall: null, lastW: null, uncertain: null, samples: 0 };
}

function resetSlot(st, slot) {
  Object.assign(st, { slotStartMs: slot.startMs, slotEndMs: slot.endMs, usedWs: 0, gapMs: 0, uncertain: null, samples: 0 });
}

// Ein Abschnitt dt (ms) zwischen zwei Beobachtungen. Normal: der größere der beiden Messwerte (konservativ).
// Lücke (zu lang oder ein Wert fehlt): mindestens die Grenze.
function integrate(st, dtMs, prevW, nowW, limitW) {
  if (!(dtMs > 0)) return;
  const gap = dtMs > SAMPLE_MAX_GAP_MS || prevW == null || nowW == null;
  const w = gap ? Math.max(Number(limitW) || 0, prevW ?? 0, nowW ?? 0) : Math.max(prevW, nowW);
  st.usedWs += (w * dtMs) / 1000;
  if (gap) st.gapMs += dtMs;
}

/**
 * Eine Zählerbeobachtung einrechnen (je Zählerabfrage).
 * @param {object} st  createBudgetState()
 * @param {{ wallMs: number, monoMs: number, importW: number|null, limitW: number, timeZone?: string }} obs
 *   importW: frischer Netzbezug (W, Einspeisung negativ oder 0) oder null, wenn kein frischer Wert da ist.
 */
export function observeBudget(st, { wallMs, monoMs, importW, limitW, timeZone = 'Europe/Berlin' }) {
  const w = finite(importW) ? Math.max(0, Number(importW)) : null;
  const slot = quarterHourSlot(wallMs, timeZone);
  if (st.lastMono == null || st.slotStartMs == null) {
    // Erste Beobachtung (Start, Einschalten): was vor ihr in dieser Viertelstunde lag, ist unbekannt.
    resetSlot(st, slot);
    integrate(st, wallMs - slot.startMs, null, w, limitW);
  } else {
    const dtMono = Math.max(0, monoMs - st.lastMono);
    const dtWall = wallMs - st.lastWall;
    const jumped = Math.abs(dtWall - dtMono) > CLOCK_JUMP_TOL_MS;
    if (slot.startMs !== st.slotStartMs) {
      // Neue Viertelstunde: nur der Teil des Abstands NACH der Grenze gehört zu ihr. Nach einem Uhrsprung ist
      // unklar, wo die Grenze lag — dann ist die Viertelstunde unsicher.
      resetSlot(st, slot);
      if (jumped) {
        st.uncertain = 'clock_jump';
        integrate(st, wallMs - slot.startMs, null, w, limitW);
      } else {
        integrate(st, Math.min(dtMono, wallMs - slot.startMs), st.lastW, w, limitW);
      }
    } else {
      if (jumped) st.uncertain = 'clock_jump';
      integrate(st, dtMono, st.lastW, w, limitW);
    }
  }
  st.lastMono = monoMs;
  st.lastWall = wallMs;
  st.lastW = w;
  st.samples += 1;
  return st;
}

/**
 * Entscheidung für den Augenblick: Budget-Ziel oder Augenblickswert.
 * @param {object} st
 * @param {object} p
 * @param {boolean} p.enabled        Einstellung „Abrechnung nach 15-min-Mittelwert“
 * @param {number}  p.wallMs
 * @param {number}  p.limitW         wirksame Grenze (W)
 * @param {number}  p.marginW        Abstand (W)
 * @param {number}  p.targetW        Augenblickswert-Ziel (Grenze − Abstand)
 * @param {number|null} p.importW    frischer Netzbezug jetzt, sonst null
 * @param {object}  p.battery        { socOk, socReason, soc, floorPct, dischargeW, maxDischargeW, capacityWh|null }
 * @returns {{ mode: 'budget'|'instant', reason: string|null, targetW: number, allowedW: number|null,
 *   budgetWh: number, usedWh: number, remainingS: number|null, intervening: boolean, gapS: number }}
 */
export function decideBudget(st, { enabled, wallMs, limitW, marginW, targetW, importW, battery = {} }) {
  const budgetWh = (Number(limitW) * SLOT_MS) / 3_600_000;
  const usedWh = st.usedWs / 3600;
  const inSlot = st.slotStartMs != null && wallMs >= st.slotStartMs && wallMs < st.slotEndMs;
  const remainingMs = inSlot ? st.slotEndMs - wallMs : null;
  const base = {
    budgetWh: Math.round(budgetWh), usedWh: Math.round(usedWh), remainingS: remainingMs == null ? null : Math.round(remainingMs / 1000),
    gapS: Math.round(st.gapMs / 1000), slotStartMs: st.slotStartMs
  };
  const instant = (reason) => ({ ...base, mode: 'instant', reason, targetW, allowedW: null, intervening: false });
  if (enabled !== true) return instant('billing_instant');
  if (!inSlot || !st.samples) return instant('no_data');
  if (st.uncertain) return instant(st.uncertain);
  if (st.gapMs > BUDGET_MAX_GAP_MS) return instant('measurements_uncertain');
  if (!finite(importW)) return instant('meter_stale');
  if (remainingMs < BUDGET_MIN_REMAINING_MS) return instant('slot_ending');
  const b = battery || {};
  if (b.socOk !== true) return instant(b.socReason || 'soc_unknown');
  if (!(Number(b.soc) >= Number(b.floorPct || 0) + BUDGET_SOC_HEADROOM_PCT)) return instant('soc_near_floor');
  const maxDis = Number(b.maxDischargeW);
  if (!(maxDis > 0)) return instant('discharge_unknown');
  if (!finite(b.dischargeW)) return instant('battery_power_unknown');
  const reserveW = Math.max(BUDGET_DISCHARGE_RESERVE_MIN_W, (maxDis * BUDGET_DISCHARGE_RESERVE_PCT) / 100);
  const headroomW = maxDis - Math.max(0, Number(b.dischargeW) || 0) - reserveW;
  const nowW = Math.max(0, Number(importW));
  // Der Akku muss den Bezug jederzeit auf den Augenblickswert zurückholen können.
  if (headroomW <= 0 || nowW - targetW > headroomW) return instant('discharge_limited');
  const remainingS = remainingMs / 1000;
  const allowedRaw = ((Number(limitW) - Number(marginW)) * SLOT_MS / 1000 - st.usedWs) / remainingS;
  if (!(allowedRaw > 0)) return instant('budget_exceeded');
  // Nie weiter über dem Augenblickswert, als der Akku zusätzlich entladen kann (Rückfall bleibt machbar).
  const allowedW = Math.max(0, Math.floor(Math.min(allowedRaw, targetW + headroomW) / STEP_W) * STEP_W);
  // Energie im Akku: reicht sie, um den Rest der Viertelstunde auf dem kleineren Ziel zu halten?
  const capWh = Number(b.capacityWh);
  if (capWh > 0) {
    const availWh = Math.max(0, ((Number(b.soc) - Number(b.floorPct || 0) - BUDGET_SOC_HEADROOM_PCT) / 100) * capWh);
    // GESAMTE Akku-Abgabe bis zum Ende: was er schon entlädt plus was er zusätzlich übernehmen müsste
    // (Codex d7dcce9c P2).
    const needWh = (Math.max(0, Number(b.dischargeW) || 0) + Math.max(0, nowW - Math.min(allowedW, targetW))) * remainingS / 3600;
    if (needWh > availWh) return instant('soc_energy');
  }
  return { ...base, mode: 'budget', reason: null, targetW: allowedW, allowedW, intervening: nowW > allowedW };
}
