// services/paragraph14a/rules.js — Rechenregeln der netzorientierten Steuerung
// nach § 14a EnWG (BNetzA-Festlegung BK6-22-300, Anlage 1; bestätigt durch den
// VDE FNN Hinweis „Berechnung der Mindestleistung“, Tenorziffer 2f, April 2025).
//
// Rein funktional, ohne Zustand: services/paragraph14a/index.js füttert die
// Geräteliste, die Vorgabe des Netzbetreibers und die Messwerte ein.

/** Mindestleistung je steuerbarer Verbrauchseinrichtung (Ziffer 4.5.1). */
export const P14A_MIN_W = 4200;

/** Ab dieser Netzanschlussleistung gilt der Skalierungsfaktor (Ziffer 4.5.1 Satz 2, 4.5.2). */
export const P14A_LARGE_W = 11000;

/** Skalierungsfaktor für Wärmepumpen/Klimaanlagen über 11 kW (Ziffer 4.5.1 Satz 3). */
export const P14A_SCALING = 0.4;

/** Fallgruppen nach Ziffer 2.4.1. */
export const STEUVE_KINDS = Object.freeze(['ladepunkt', 'waermepumpe', 'klima', 'speicher']);

export const STEUVE_KIND_LABELS = Object.freeze({
  ladepunkt: 'Ladepunkt',
  waermepumpe: 'Wärmepumpe',
  klima: 'Raumkühlung',
  speicher: 'Stromspeicher',
});

/** Standard-Vorrang bei der Aufteilung: Wärme vor Mobilität vor Netzladen des Speichers. */
export const DEFAULT_PRIORITY = Object.freeze(['waermepumpe', 'klima', 'ladepunkt', 'speicher']);

/**
 * Gleichzeitigkeitsfaktor nach Ziffer 4.5.2: 0,8 bei zwei SteuVE, je weitere
 * 0,05 weniger, ab neun konstant 0,45.
 */
export function simultaneityFactor(n) {
  if (!(n >= 2)) return 1;
  return Math.max(0.45, Math.round((0.8 - (Math.min(n, 9) - 2) * 0.05) * 100) / 100);
}

/**
 * Bildet aus der Geräteliste die steuerbaren Verbrauchseinrichtungen im Sinne
 * der Festlegung:
 *  - Nur Anlagen über 4,2 kW sind SteuVE (Ziffer 2.4.1).
 *  - Mehrere Wärmepumpen bzw. mehrere Klimaanlagen zählen je Fallgruppe als
 *    eine SteuVE, sobald ihre Summe 4,2 kW überschreitet (Ziffer 2.4.2).
 *
 * @param {Array<{id:string,name?:string,kind:string,powerW:number,control?:'ems'|'direct'}>} devices
 * @returns {{ steuve: Array<{key:string,kind:string,powerW:number,control:string,members:string[]}>,
 *             ignored: Array<{id:string,reason:string}> }}
 */
export function groupSteuve(devices) {
  const steuve = [];
  const ignored = [];
  const groups = new Map(); // `${kind}:${control}` → Gruppe (nur WP/Klima)
  for (const d of devices || []) {
    const kind = String(d?.kind || '');
    const powerW = Number(d?.powerW);
    const control = d?.control === 'direct' ? 'direct' : 'ems';
    if (!STEUVE_KINDS.includes(kind) || !(powerW > 0)) {
      ignored.push({ id: d?.id ?? null, reason: 'unknown_kind_or_power' });
      continue;
    }
    if (kind === 'waermepumpe' || kind === 'klima') {
      const key = `${kind}:${control}`;
      const g = groups.get(key) || { key, kind, powerW: 0, control, members: [] };
      g.powerW += powerW;
      g.members.push(d.id);
      groups.set(key, g);
      continue;
    }
    if (powerW <= P14A_MIN_W) {
      ignored.push({ id: d.id, reason: 'not_above_4200w' });
      continue;
    }
    steuve.push({ key: String(d.id), kind, powerW, control, members: [d.id] });
  }
  for (const g of groups.values()) {
    if (g.powerW > P14A_MIN_W) steuve.push(g);
    else for (const id of g.members) ignored.push({ id, reason: 'group_not_above_4200w' });
  }
  return { steuve, ignored };
}

/**
 * Mindestleistung (netzwirksamer Leistungsbezug, der auch während der Steuerung
 * gewährt werden muss) für die über das EMS gesteuerten SteuVE, Ziffer 4.5.2:
 *
 *   mit WP/Klima über 11 kW:  max(0,4·ΣP_WP ; 0,4·ΣP_Klima) + (n−1)·GZF·4,2 kW
 *   sonst:                    4,2 kW + (n−1)·GZF·4,2 kW
 *
 * Direkt angesteuerte SteuVE (Ziffer 4.4.a) haben je eigene Mindestleistung
 * (4,2 kW bzw. 0,4·P über 11 kW) und gehen nicht in die EMS-Formel ein.
 *
 * @returns {{ pminW:number, n:number, gzf:number, formula:'none'|'single'|'standard'|'large_hp_ac',
 *             steuve:Array, ignored:Array, direct:Array<{key:string,kind:string,powerW:number,pminW:number}> }}
 */
export function computePmin14a(devices) {
  const { steuve, ignored } = groupSteuve(devices);
  const ems = steuve.filter((s) => s.control === 'ems');
  const direct = steuve.filter((s) => s.control === 'direct').map((s) => ({
    key: s.key,
    kind: s.kind,
    powerW: s.powerW,
    pminW: (s.kind === 'waermepumpe' || s.kind === 'klima') && s.powerW > P14A_LARGE_W
      ? Math.round(P14A_SCALING * s.powerW)
      : P14A_MIN_W,
  }));
  const n = ems.length;
  if (n === 0) return { pminW: 0, n, gzf: 1, formula: 'none', steuve, ignored, direct };
  const gzf = simultaneityFactor(n);
  const sumKind = (kind) => ems.filter((s) => s.kind === kind).reduce((a, s) => a + s.powerW, 0);
  const large = ems.some((s) => (s.kind === 'waermepumpe' || s.kind === 'klima') && s.powerW > P14A_LARGE_W);
  const base = large ? Math.max(P14A_SCALING * sumKind('waermepumpe'), P14A_SCALING * sumKind('klima')) : P14A_MIN_W;
  const pminW = Math.round(base + (n - 1) * gzf * P14A_MIN_W);
  return { pminW, n, gzf, formula: large ? 'large_hp_ac' : n === 1 ? 'single' : 'standard', steuve, ignored, direct };
}

/**
 * Budget für die SteuVE während einer Begrenzung. Begrenzt wird nur der
 * netzwirksame Bezug (Ziffer 2.3): der Netzbezug, den die SteuVE zusätzlich
 * verursachen. PV-Überschuss darf zusätzlich genutzt werden.
 *
 *   baseW = Netzbezug − Leistung der SteuVE   (negativ = Überschuss ohne SteuVE)
 *   Budget = Grenze + max(0, −baseW)
 *
 * @param {object} p
 * @param {number} p.limitW           Vorgabe des Netzbetreibers (W)
 * @param {number|null} p.gridImportW Netzbezug am Anschlusspunkt, Bezug positiv
 * @param {number} p.steuveW          aktuelle Leistung aller gesteuerten SteuVE
 * @param {boolean} [p.usePvSurplus=true]
 */
export function budgetW({ limitW, gridImportW, steuveW, usePvSurplus = true }) {
  const limit = Math.max(0, Number(limitW) || 0);
  if (!usePvSurplus || !Number.isFinite(Number(gridImportW))) return limit;
  const baseW = Number(gridImportW) - Math.max(0, Number(steuveW) || 0);
  return limit + Math.max(0, -baseW);
}

// --- Bedarf ---------------------------------------------------------------------
//
// Die Vorgabe des Netzbetreibers darf der Betreiber über das EMS „nach eigener
// Maßgabe“ aufteilen (Ziffer 4.5.2 Satz 6; BNetzA BK6 am 02.11.2026: „Dabei legt
// der Betreiber fest, in welcher Reihenfolge die verfügbare Bezugsleistung auf
// seine Geräte aufgeteilt wird.“). Nach Bedarf heißt: jedes Gerät bekommt zuerst,
// was es gerade braucht, der Rest geht an Geräte, die mehr nutzen können.

/** Reserve zum Hochfahren über der gemessenen Leistung: max(500 W, 10 % der Höchstleistung). */
export const DEMAND_RAMP_MIN_W = 500;
export const DEMAND_RAMP_SHARE = 0.1;
/** Anlaufreserve stehender Wärmepumpen/Klimaanlagen: max(1 kW, 30 % der Höchstleistung). */
export const DEMAND_START_MIN_W = 1000;
export const DEMAND_START_SHARE = 0.3;

/**
 * Aktueller Bedarf eines Geräts (W, höchstens seine Höchstleistung):
 *   gemessene Leistung + Reserve zum Hochfahren, mindestens die Anlaufstufe
 *   (Wallbox: Mindeststrom, vom Aufrufer als startW; Wärmepumpe/Klima ohne
 *   eigene Angabe: Anlaufreserve; Speicher: keine).
 * Ohne Messwert ist der Bedarf unbekannt → volle Höchstleistung (wie bisher).
 * available === false (z. B. kein Auto an der Wallbox) → kein Bedarf.
 *
 * @param {{kind:string, maxW:number, currentW:number|null, startW?:number|null, available?:boolean}} d
 */
export function demandW({ kind, maxW, currentW, startW = null, available = true }) {
  const max = Math.max(0, Number(maxW) || 0);
  if (available === false) return 0;
  if (currentW == null || !Number.isFinite(Number(currentW))) return max;
  const cur = Math.max(0, Number(currentW));
  const ramp = Math.max(DEMAND_RAMP_MIN_W, DEMAND_RAMP_SHARE * max);
  let start = Number.isFinite(Number(startW)) && startW != null ? Math.max(0, Number(startW)) : 0;
  if (startW == null && (kind === 'waermepumpe' || kind === 'klima')) {
    start = Math.max(DEMAND_START_MIN_W, DEMAND_START_SHARE * max);
  }
  return Math.round(Math.min(max, Math.max(cur + ramp, start)));
}

/**
 * Teilt das Budget auf die steuerbaren Geräte auf (Ziffer 4.5.2 Satz 6: nach
 * eigener Maßgabe des Betreibers).
 *
 *  - 'priority':     in der Reihenfolge der Fallgruppen, jedes Gerät bis zu
 *                    seiner Höchstleistung, bis das Budget verbraucht ist.
 *  - 'proportional': anteilig nach Höchstleistung.
 *
 * Mit demand: true zuerst nach Bedarf (needW, ohne Angabe = Höchstleistung):
 *   1. jedes Gerät bis zu seinem Bedarf — nach Vorrang bzw. anteilig zum Bedarf,
 *   2. der Rest an Geräte, die an ihrer Grenze laufen (atCap), bis zur
 *      Höchstleistung — nach Vorrang bzw. anteilig zum freien Spielraum,
 *   3. was dann noch übrig ist, an alle übrigen bis zur Höchstleistung.
 * Es verfällt also nichts, und die Summe bleibt immer im Budget.
 *
 * @param {number} budget
 * @param {Array<{id:string,kind:string,maxW:number,needW?:number|null,atCap?:boolean}>} consumers
 * @param {{mode?:'priority'|'proportional', priority?:string[], demand?:boolean}} [opts]
 * @returns {Record<string, number>} Watt je Gerät (abgerundet)
 */
export function allocateBudget(budget, consumers, { mode = 'priority', priority = DEFAULT_PRIORITY, demand = false } = {}) {
  const list = (consumers || []).filter((c) => c && Number(c.maxW) > 0);
  const out = {};
  const total = list.reduce((s, c) => s + Number(c.maxW), 0);
  if (!list.length || !(budget >= 0)) return out;
  if (total <= budget) {
    for (const c of list) out[c.id] = Math.floor(Number(c.maxW));
    return out;
  }
  const prio = priority || DEFAULT_PRIORITY;
  const rank = (kind) => {
    const i = prio.indexOf(kind);
    return i < 0 ? prio.length : i;
  };
  const ordered = [...list].sort((a, b) => rank(a.kind) - rank(b.kind));
  const maxOf = (c) => Number(c.maxW);
  const got = Object.fromEntries(list.map((c) => [c.id, 0]));
  let rest = budget;

  // Füllt die Geräte bis zur Obergrenze cap(c): nach Vorrang oder anteilig zum
  // jeweils freien Spielraum (anteilig: rest·h/Σh ≤ h, solange rest < Σh).
  const fill = (items, cap) => {
    if (!(rest > 0) || !items.length) return;
    if (mode === 'proportional') {
      const room = items.map((c) => Math.max(0, cap(c) - got[c.id]));
      const sum = room.reduce((a, h) => a + h, 0);
      if (!(sum > 0)) return;
      const f = Math.min(1, rest / sum);
      let used = 0;
      items.forEach((c, i) => { const w = room[i] * f; got[c.id] += w; used += w; });
      rest -= used;
      return;
    }
    for (const c of items) {
      const w = Math.max(0, Math.min(cap(c) - got[c.id], rest));
      got[c.id] += w;
      rest -= w;
    }
  };

  if (demand) {
    const need = (c) => Math.min(maxOf(c), c.needW == null || !Number.isFinite(Number(c.needW)) ? maxOf(c) : Math.max(0, Number(c.needW)));
    fill(ordered, need);
    fill(ordered.filter((c) => c.atCap === true), maxOf);
  }
  fill(ordered, maxOf);
  for (const c of list) out[c.id] = Math.max(0, Math.floor(got[c.id]));
  return out;
}
