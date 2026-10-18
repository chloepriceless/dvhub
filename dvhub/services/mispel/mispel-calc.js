// services/mispel/mispel-calc.js — MiSpeL-Abrechnung aus den Messwerten der Anlage.
//
// Grundlage: MiSpeL-Festlegung der Bundesnetzagentur, Beschluss 618-25-02 vom
// 01.10.2026 — Anlage 2 (Pauschaloption, P1–P15, Rumpfjahre Abschnitt 9) und
// Anlage 1 (Abgrenzungsoption, Basisfall A1, Formeln (1)–(33) je Kalendermonat).
// Die Formeln sind aus dem Rechenkern der Website übernommen
// (dvhub-website: assets/js/mispel-core.js limits()/yearEnd()/rumpfPerioden(),
// assets/js/abgrenzung-core.js sammle()/abschluss(), Stand 17.10.2026) — dort
// simuliert, hier auf die gemessenen Viertelstunden angewandt.
//
// Zähler: Z1 = Netzanschluss (Bezug/Einspeisung), Z2 = Speicher (Laden/Entladen).
// DVhub hat für Z2 nur die Akku-Leistung des Wechselrichters — eine Näherung,
// kein geeichter Speicherzähler. Die Abrechnung macht der Messstellenbetreiber.
//
// Rein: keine Datenbank, keine Uhr außer den übergebenen Werten.

export const FESTLEGUNG = 'BNetzA Beschluss 618-25-02 vom 01.10.2026';
export const PAUSCHAL_KWH_JE_KWP = 500;     // (P1) förderfähige Menge je kWp und Kalenderjahr
export const SOMMERTAGE = 183;              // (P17) Tage 01.04.–30.09., in jedem Jahr 183
export const PAUSCHAL_MAX_KWP = 30;         // darüber gibt es die Pauschaloption nicht

const DAY_MS = 86_400_000;
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const dayNo = (d) => Math.round(Date.parse(`${d}T00:00:00Z`) / DAY_MS);
const fromDayNo = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

export function daysInYear(year) {
  return dayNo(`${year + 1}-01-01`) - dayNo(`${year}-01-01`);
}

/** Tage von `von` bis `bis` (beide eingeschlossen), davon im Sommerhalbjahr 01.04.–30.09. */
export function periodDays(von, bis) {
  const a = dayNo(von), b = dayNo(bis);
  const year = Number(von.slice(0, 4));
  const s0 = dayNo(`${year}-04-01`), s1 = dayNo(`${year}-09-30`);
  return { tr: b - a + 1, trs: Math.max(0, Math.min(b, s1) - Math.max(a, s0) + 1) };
}

/**
 * Pauschalgrenzen (Anlage 2, Basisfall P1 Stromspeicher), für ein Rumpfjahr anteilig (Abschnitt 9.2):
 *   P1 = 500 · kWp, (P2) = 0,1 · kWp / SK_inst, P3 = P2 · P1, P4 = P1 + P3
 *   (P1)R = TRS · P1 / 183, (P3)R = TR · P3 / TK
 */
export function pauschalLimits({ kwp, storageKwh, tr = null, trs = null, tk = 365 }) {
  const P1Jahr = kwp * PAUSCHAL_KWH_JE_KWP;
  const P2 = storageKwh > 0 ? 0.1 * kwp / storageKwh : null;
  const P3Jahr = P2 === null ? 0 : P2 * P1Jahr;
  const rumpf = tr !== null && !(tr === tk && trs === SOMMERTAGE);
  const P1 = rumpf ? trs * P1Jahr / SOMMERTAGE : P1Jahr;
  const P3 = rumpf ? tr * P3Jahr / tk : P3Jahr;
  return { P1, P2, P3, P4: P1 + P3, P1Jahr, P3Jahr, rumpf, anwendbar: kwp <= PAUSCHAL_MAX_KWP };
}

/**
 * Abrechnungszeiträume eines Kalenderjahres. Die Option gilt ab `startDate`
 * (im ersten Jahr also ein Rumpfjahr ab diesem Tag). Jede bestimmungsrelevante
 * Änderung (`changes[].date`: Speicher, Solaranlage, Ladepunkt, Messkonzept,
 * Zuordnung) teilt das Jahr; der Tag der Änderung zählt zum Rumpfjahr davor.
 * Ergebnis: [{ von, bis, tr, trs, tk, rumpf, change }] — leer, wenn die Option
 * in diesem Jahr noch nicht galt.
 */
export function periodsForYear(year, { startDate = null, changes = [] } = {}) {
  const y0 = `${year}-01-01`, y1 = `${year}-12-31`;
  const tk = daysInYear(year);
  let von = y0;
  if (isDate(startDate)) {
    if (startDate > y1) return [];
    if (startDate > y0) von = startDate;
  }
  const cuts = [...new Set((Array.isArray(changes) ? changes : [])
    .map((c) => c?.date).filter((d) => isDate(d) && d >= von && d < y1))].sort();
  const out = [];
  for (const bis of [...cuts, y1]) {
    if (bis < von) continue;
    const { tr, trs } = periodDays(von, bis);
    const change = (changes || []).find((c) => c?.date === bis) || null;
    out.push({ von, bis, tr, trs, tk, rumpf: tr !== tk, change });
    von = fromDayNo(dayNo(bis) + 1);
  }
  return out;
}

/**
 * Anlagendaten, die in einem Zeitraum gelten: Grundwerte, überschrieben von der
 * letzten Änderung VOR dem Zeitraum (eine Änderung gilt ab dem Folgetag).
 * kWp leer = unverändert; Speicher leer = wieder aus den Akku-Ausbaustufen
 * (auch nach einer früheren Angabe — Codex 2026-10-18).
 */
export function plantForPeriod(period, { kwp, storageKwhAt = () => null, changes = [] }) {
  let k = num(kwp);
  let sk = null;
  for (const c of [...(changes || [])].filter((x) => isDate(x?.date) && x.date < period.von).sort((a, b) => a.date.localeCompare(b.date))) {
    if (num(c.kwp) !== null) k = num(c.kwp);
    sk = num(c.storageKwh);
  }
  if (sk === null) sk = num(storageKwhAt(period.von));
  return { kwp: k, storageKwh: sk };
}

// Anzulegender Wert in dieser Viertelstunde null? `awZero` setzt der Aufrufer
// nach der §51-Regel der Anlage (keine/15 min/4 h/6 h/gestaffelt, eeg-rules.js);
// ohne Angabe gilt die Regel für Neuanlagen: negativer Preis = kein Anspruch.
function awZeroOf(s, p) {
  if (typeof s?.awZero === 'boolean') return s.awZero;
  return p !== null && p < 0;
}

/**
 * Summen der Viertelstunden eines Zeitraums für die Pauschaloption.
 * slot: { importKwh, exportKwh, priceCtKwh, awZero? }. Ohne Preis zählt die
 * Einspeisung wie zu positivem Preis (und wird als `ohnePreis` gemeldet).
 *   P7  = Einspeisung in Viertelstunden mit Spotpreis ≥ 0
 *   P9  = gesamter Netzbezug
 *   P14 = Einspeisung in Viertelstunden mit anzulegendem Wert > 0 (§ 51 EEG je nach Anlage)
 */
export function sumPauschalSlots(slots) {
  let P7 = 0, P9 = 0, P14 = 0, ohnePreis = 0, n = 0;
  for (const s of slots || []) {
    const ne = Math.max(0, Number(s?.exportKwh) || 0);
    const nb = Math.max(0, Number(s?.importKwh) || 0);
    const p = num(s?.priceCtKwh);
    if (p === null) ohnePreis++;
    if (p === null || p >= 0) P7 += ne;
    if (!awZeroOf(s, p)) P14 += ne;
    P9 += nb;
    n++;
  }
  return { P7, P9, P14, slots: n, ohnePreis };
}

/** Jahresend-Einordnung (Anlage 2, Abschnitt 4.3) mit den Grenzen L. */
export function pauschalYearEnd(L, { P7, P9, P14 }) {
  const P8 = Math.max(P7 - L.P4, 0);       // grundsätzlich saldierungsfähig
  const P10 = Math.min(P8, P9);            // saldierungsfähige Netzeinspeisung
  const P11 = P9 - P10;                    // umlagebelasteter Netzbezug
  const P15 = Math.min(P14, L.P1);         // förderfähige Netzeinspeisung
  return { P1: L.P1, P2: L.P2, P3: L.P3, P4: L.P4, P7, P8, P9, P10, P11, P14, P15 };
}

// ── Abgrenzungsoption, Formelsatz A1 (Anlage 1, Abschnitt 4.2) je Kalendermonat ──

function emptyMonth(key) {
  return { monat: key, f3: 0, f4: 0, f5: 0, f6: 0, f9: 0, f11: 0, f26: 0, f29: 0, slots: 0, ohnePreis: 0 };
}

/** Eine Viertelstunde einsammeln: Z1NB/Z1NE = Netz Bezug/Einspeisung, Z2V/Z2E = Speicher lädt/gibt ab. */
function collect(m, s) {
  const nb = Math.max(0, Number(s?.importKwh) || 0), ne = Math.max(0, Number(s?.exportKwh) || 0);
  const v = Math.max(0, Number(s?.batteryChargeKwh) || 0), e = Math.max(0, Number(s?.batteryDischargeKwh) || 0);
  const p = num(s?.priceCtKwh);
  if (p === null) m.ohnePreis++;
  const f1 = Math.min(nb, v);                // (1) zeitgleicher Netzstromverbrauch im Speicher
  const f2 = Math.min(ne, e);                // (2) zeitgleiche Netzeinspeisung aus dem Speicher
  const aw = awZeroOf(s, p) ? 0 : 1;        // (24) AW>0-Zeiten (§ 51 EEG)
  m.f3 += nb; m.f4 += ne; m.f5 += v; m.f6 += e; m.f9 += f1; m.f11 += f2;
  m.f26 += aw * (ne - f2);                   // (23)–(26) EE-Strom direkt aus der Anlage
  m.f29 += aw * f2;                          // (27), (29)
  m.slots++;
}

function finish(m) {
  m.f10 = m.f5 - m.f9;                       // (10) zeitgleicher EE-Verbrauch im Speicher
  m.f12 = Math.max(m.f6 - m.f5, 0);          // (12) „Fremdtankstrom“ (Übertrag aus dem Vormonat)
  m.f13 = Math.max(m.f11 - m.f12, 0);        // (13)
  m.f14 = m.f5 > 0 ? m.f6 / m.f5 : 0;        // (14) gemessener Wirkungsgrad
  m.f15 = m.f14 * m.f10;                     // (15) EE-Speichererzeugung
  m.f16 = Math.max(m.f13 - m.f15, 0);        // (16) saldierungsfähige Netzeinspeisung
  m.f17 = Math.max(m.f5 - m.f6, 0);          // (17) Speicherverluste
  m.f18 = m.f6 > 0 ? m.f16 / m.f6 : 0;       // (18)
  m.f19 = m.f18 * m.f17;                     // (19) privilegierungsfähige Verluste
  m.f20 = Math.min(m.f16 + m.f19, m.f3);     // (20) umlagereduzierende Strommenge
  m.f21 = m.f3 - m.f20;                      // (21) umlagebelasteter Netzbezug
  m.f28 = Math.min(m.f13, m.f15);            // (28)
  m.f30 = m.f11 > 0 ? m.f29 / m.f11 : 0;     // (30)
  m.f31 = m.f30 * m.f28;                     // (31) förderfähige EE-Speichererzeugung
  m.f32 = m.f26 + m.f31;                     // (32) insgesamt förderfähig
  return m;
}

const YEAR_KEYS = ['f3', 'f4', 'f5', 'f6', 'f9', 'f10', 'f11', 'f12', 'f13', 'f15', 'f16', 'f17', 'f19', 'f20', 'f21', 'f26', 'f28', 'f31', 'f32'];

/** slots: [{ month: 'YYYY-MM', importKwh, exportKwh, batteryChargeKwh, batteryDischargeKwh, priceCtKwh }] */
export function abgrenzungMonths(slots) {
  const byKey = new Map();
  for (const s of slots || []) {
    const key = s?.month;
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, emptyMonth(key));
    collect(byKey.get(key), s);
  }
  const monate = [...byKey.values()].sort((a, b) => a.monat.localeCompare(b.monat)).map(finish);
  const jahr = {};
  for (const k of YEAR_KEYS) jahr[k] = monate.reduce((a, m) => a + m[k], 0);
  jahr.f22 = jahr.f21;                       // (22) umlagebelasteter Netzbezug im Jahr
  jahr.f33 = jahr.f32;                       // (33) förderfähige Netzeinspeisung im Jahr
  return { monate, jahr };
}
