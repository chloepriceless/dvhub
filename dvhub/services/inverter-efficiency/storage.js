// services/inverter-efficiency/storage.js — Speicherweg mit Wandlung (T12,
// Christin 23.11.2026: „Akku-Wirkungsgrad (DC rein und raus wie bisher) und
// einen Systemwirkungsgrad, wo auch AC mit rein genommen wird“).
//
// Die Karte „Eigenverbrauch bewertet“ rechnet den Akku mit den Flüssen aus
// polling.js. Deren Akku-Mengen sind die Leistung AM AKKU (Victron Register 842
// /Dc/Battery/Power, Hybrid-WR: Batterieleistung) — also DC. Die Wandlung
// AC ↔ DC steckt dort nirgends sauber: der Ladeverlust landet im „Netz direkt“,
// der Entladeverlust zählt als ans Haus geliefert. Den Speicherweg mit Wandlung
// misst dieser Tagesjob aus den ~5-s-Rohwerten, wie daily.js:
//
//   AC aus dem Wandler  ac  = Last + Einspeisung − Netzbezug − AC-PV   (+ liefert, − nimmt auf)
//   Akku                bp  (+ Laden, − Entladen), DC am Akku
//   DC-PV               pdc (MPPT-Ausgang bzw. PV-DC-Eingang des Hybrid-WR)
//
// Je Probe (nur |bp| ≥ STORAGE_MIN_BATTERY_W, sonst ruht der Akku):
//   Laden    PV→Akku (DC)    = min(pdc, bp)            geht ohne Wandlung in den Akku
//            Lader→Akku (DC) = bp − PV→Akku
//            AC rein         = max(−ac, 0), nur wenn der Lader tatsächlich lädt
//   Entladen AC raus vom Akku = max(ac, 0) × Entladen ÷ (Entladen + pdc)
//            (der Wandler setzt Akku- und DC-PV-Strom gemeinsam um; anteilig)
//
// Daraus über den Zeitraum (energiegewichtet, Tage addieren sich exakt):
//   η Laden    = Σ Akku geladen ÷ Σ (PV→Akku + AC rein)    — DC-PV zählt 1:1
//   η Akku DC  = Σ entladen ÷ (Σ geladen − ΔSoC)            — alle Proben, ΔSoC je Tag
//   η Entladen = Σ AC raus vom Akku ÷ Σ Akku entladen
// Alles aus denselben Rohwerten: die 15-min-Werte der Karte können für ältere
// Viertelstunden aus dem VRM-Import stammen (energy-source-rule.js), dessen
// Akku-Mengen nicht DC am Akku sind — das würde den Speicherweg verfälschen.
// Der Eigenverbrauch des Wechselrichters WÄHREND Laden/Entladen gehört dazu;
// Leerlauf bei ruhendem Akku und das Wandeln von PV-Strom ins Haus nicht —
// die stecken nur im Wandlerverlust gesamt (converter_loss_wh, alle Proben).

import { EFFICIENCY_SAMPLES_CTE, EFFICIENCY_SERIES_KEYS, localDateString } from './daily.js';

// Unter dieser Akku-Leistung gilt der Akku als ruhend (Regelrauschen, Halten
// am Mindest-SoC): sonst zählte der Leerlauf des Wechselrichters stundenlang
// als Ladeverlust (100 W × 8 h Nacht = 0,8 kWh je Tag).
export const STORAGE_MIN_BATTERY_W = 100;
// Größte Probenlücke, die noch als durchgehend gilt (wie energy-source-rule.js
// LOCAL_SAMPLE_MAX_GAP_SECONDS: 60-s-Abfrage plus Abfragedauer).
export const STORAGE_MAX_GAP_SECONDS = 90;
// Ein Wirkungsgrad braucht mindestens so viel Energie in seiner Richtung.
export const STORAGE_MIN_KWH = 1;
// Entladen ≥ 99,5 %: die Last wird aus der Akku-Leistung abgeleitet statt
// gemessen (wie daily.js) — dann ist die Wandlung nicht messbar.
const NOT_MEASURABLE_ETA = 0.995;
const ETA_MIN = 0.5;
const ETA_MAX = 1.02;

export const STORAGE_EFFICIENCY_SQL = `
WITH ${EFFICIENCY_SAMPLES_CTE},
q AS (
  SELECT *, lag(t) OVER (ORDER BY t) AS t_prev FROM p
),
r AS (
  SELECT extract(epoch FROM (t - t_prev)) AS dt,
         greatest(bp, 0) AS ch,
         greatest(-bp, 0) AS dis,
         greatest(pdc, 0) AS pdc,
         (ld + ge - gi - pac) AS ac
  FROM q
  WHERE t_prev IS NOT NULL
    AND t > t_prev
    AND t - t_prev <= make_interval(secs => $5::float8)
    AND bp IS NOT NULL AND ld IS NOT NULL AND gi IS NOT NULL AND ge IS NOT NULL
),
s AS (
  SELECT dt, ch, dis, pdc, ac,
    CASE WHEN ch >= $4::float8 THEN ch ELSE 0 END AS ch_used,
    CASE WHEN ch >= $4::float8 THEN least(pdc, ch) ELSE 0 END AS pv_to_batt,
    CASE WHEN ch >= $4::float8 THEN ch - least(pdc, ch) ELSE 0 END AS conv_to_batt,
    CASE WHEN ch >= $4::float8 AND ch > pdc THEN greatest(-ac, 0) ELSE 0 END AS ac_in,
    CASE WHEN dis >= $4::float8 THEN dis ELSE 0 END AS dis_used,
    CASE WHEN dis >= $4::float8 THEN greatest(ac, 0) * dis / (dis + pdc) ELSE 0 END AS ac_out
  FROM r
),
soc AS (
  SELECT (array_agg(soc ORDER BY t) FILTER (WHERE soc IS NOT NULL))[1] AS soc_first_pct,
         (array_agg(soc ORDER BY t DESC) FILTER (WHERE soc IS NOT NULL))[1] AS soc_last_pct
  FROM p
)
SELECT coalesce(sum(ch_used * dt), 0) / 3600.0 AS charge_dc_wh,
       coalesce(sum(pv_to_batt * dt), 0) / 3600.0 AS pv_to_batt_wh,
       coalesce(sum(conv_to_batt * dt), 0) / 3600.0 AS conv_to_batt_wh,
       coalesce(sum(ac_in * dt), 0) / 3600.0 AS ac_in_wh,
       coalesce(sum(dis_used * dt), 0) / 3600.0 AS discharge_dc_wh,
       coalesce(sum(ac_out * dt), 0) / 3600.0 AS ac_out_wh,
       coalesce(sum(ch * dt), 0) / 3600.0 AS charge_all_wh,
       coalesce(sum(dis * dt), 0) / 3600.0 AS discharge_all_wh,
       coalesce(sum((pdc + dis - ch - ac) * dt), 0) / 3600.0 AS converter_loss_wh,
       max(soc.soc_first_pct) AS soc_first_pct,
       max(soc.soc_last_pct) AS soc_last_pct,
       coalesce(sum(dt), 0) AS seconds,
       count(dt)::int AS samples
FROM soc LEFT JOIN s ON true`;

export const UPSERT_STORAGE_SQL = `
INSERT INTO storage_efficiency_daily (day, charge_dc_wh, pv_to_batt_wh, conv_to_batt_wh, ac_in_wh,
  discharge_dc_wh, ac_out_wh, charge_all_wh, discharge_all_wh, converter_loss_wh,
  soc_first_pct, soc_last_pct, seconds, samples, computed_at)
VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())
ON CONFLICT (day) DO UPDATE SET
  charge_dc_wh = EXCLUDED.charge_dc_wh,
  pv_to_batt_wh = EXCLUDED.pv_to_batt_wh,
  conv_to_batt_wh = EXCLUDED.conv_to_batt_wh,
  ac_in_wh = EXCLUDED.ac_in_wh,
  discharge_dc_wh = EXCLUDED.discharge_dc_wh,
  ac_out_wh = EXCLUDED.ac_out_wh,
  charge_all_wh = EXCLUDED.charge_all_wh,
  discharge_all_wh = EXCLUDED.discharge_all_wh,
  converter_loss_wh = EXCLUDED.converter_loss_wh,
  soc_first_pct = EXCLUDED.soc_first_pct,
  soc_last_pct = EXCLUDED.soc_last_pct,
  seconds = EXCLUDED.seconds,
  samples = EXCLUDED.samples,
  computed_at = now()`;

export const STORAGE_ROWS_SQL = `
SELECT to_char(day, 'YYYY-MM-DD') AS day, charge_dc_wh, pv_to_batt_wh, conv_to_batt_wh, ac_in_wh,
       discharge_dc_wh, ac_out_wh, charge_all_wh, discharge_all_wh, converter_loss_wh,
       soc_first_pct, soc_last_pct, seconds, samples
FROM storage_efficiency_daily
WHERE day >= $1::date AND day < $2::date
ORDER BY day`;

const FIRST_RAW_DAY_SQL = `
SELECT to_char(min(ts_utc) AT TIME ZONE $1::text, 'YYYY-MM-DD') AS first_day
FROM timeseries_samples
WHERE series_key = 'battery_power_w' AND scope = 'live'
  AND ts_utc > now() - interval '400 days'`;

export const MISSING_STORAGE_DAYS_SQL = `
SELECT to_char(d, 'YYYY-MM-DD') AS day
FROM generate_series($1::date, $2::date, interval '1 day') AS d
WHERE NOT EXISTS (SELECT 1 FROM storage_efficiency_daily e WHERE e.day = d::date)
ORDER BY d DESC
LIMIT $3`;

const DAY_MS = 86_400_000;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round = (v, d = 3) => {
  const f = 10 ** d;
  const r = Math.round((Number(v) + Number.EPSILON) * f) / f;
  return r === 0 ? 0 : r;
};

// ── Messbarkeit je Herstellerprofil ──────────────────────────────────────────
//
// Messbar ist der Speicherweg nur, wenn (a) die Akku-Leistung DC am Akku ist,
// (b) die Hauslast GEMESSEN ist (nicht aus der Akku-Leistung abgeleitet — dann
// heben sich die Verluste rechnerisch auf) und (c) DC-PV und AC-PV getrennt
// vorliegen (sonst lässt sich der Wandler-Durchsatz nicht vom PV-Strom trennen).
// verified = am echten Gerät gegengeprüft.
const PROFILE_LABELS = Object.freeze({
  victron: 'Victron',
  sungrow: 'Sungrow',
  'deye-lv': 'Deye LV',
  'deye-lp1': 'Deye LP1',
  'deye-hp3': 'Deye HP3',
  fronius: 'Fronius',
  'bridge-mqtt': 'Universal (MQTT-Bridge)',
  'dvhub-mqtt': 'Universal (DVhub-MQTT)',
});

const MEASURABLE_PROFILES = Object.freeze({
  // GX: /Dc/Battery/Power (842, DC), /Ac/Consumption (817–819, gemessen),
  // /Dc/Pv/Power (850, MPPT-Ausgang), AC-PV getrennt (808 ff.). Prod geprüft.
  victron: { verified: true, note: null },
  // 5214 Battery power (DC), 13008 Load power (vom WR aus AC-Leistung und Zähler),
  // 5017 Total DC power (PV-Eingang). Vorzeichen Akku am Gerät noch ungeprüft.
  sungrow: { verified: false, note: 'Sungrow: am Gerät noch nicht gegengeprüft; die DC/DC-Wandlung PV→Akku im Hybrid-WR ist nicht einzeln erfasst' },
  // 590 Batterie (DC), 653 Hauslast (vom WR), 672 PV1+PV2 (DC). Beta, @sim-assumption.
  'deye-lv': { verified: false, note: 'Deye: am Gerät noch nicht gegengeprüft; die DC/DC-Wandlung PV→Akku im Hybrid-WR ist nicht einzeln erfasst' },
  'deye-lp1': { verified: false, note: 'Deye: am Gerät noch nicht gegengeprüft; die DC/DC-Wandlung PV→Akku im Hybrid-WR ist nicht einzeln erfasst' },
  'deye-hp3': { verified: false, note: 'Deye: am Gerät noch nicht gegengeprüft; die DC/DC-Wandlung PV→Akku im Hybrid-WR ist nicht einzeln erfasst' },
});

const NOT_MEASURABLE_REASONS = Object.freeze({
  fronius: 'die PV-Leistung ist der AC-Ausgang des Wechselrichters (SunSpec 113, mit Akku-Anteil); die DC-PV-Leistung liest DVhub nicht',
  'bridge-mqtt': 'ob Akku-Leistung (DC) und Hausverbrauch gemessen sind, hängt an der Bridge und ist nicht prüfbar',
  'dvhub-mqtt': 'ob Akku-Leistung (DC) und Hausverbrauch gemessen sind, hängt an der Quelle und ist nicht prüfbar',
});

/**
 * Ist der Speicherweg mit Wandlung für die Anlage messbar?
 * @returns {{ measurable:boolean, verified:boolean, manufacturer:string, label:string, reason:string|null, note:string|null }}
 */
export function storageEfficiencyCapability(cfg) {
  const manufacturer = String(cfg?.manufacturer || 'victron');
  const label = PROFILE_LABELS[manufacturer] || manufacturer;
  const out = (measurable, reason = null, extra = {}) => ({
    measurable, verified: false, manufacturer, label, reason, note: null, ...extra,
  });
  const load = cfg?.points?.selfConsumptionW;
  if (load && load.enabled === false) {
    return out(false, `nicht messbar bei ${label}: der Hausverbrauch wird abgeleitet statt gemessen — Wandlerverluste heben sich in der Rechnung auf`);
  }
  if (NOT_MEASURABLE_REASONS[manufacturer]) {
    return out(false, `nicht messbar bei ${label}: ${NOT_MEASURABLE_REASONS[manufacturer]}`);
  }
  const profile = MEASURABLE_PROFILES[manufacturer];
  if (!profile) {
    return out(false, `nicht messbar bei ${label}: Bedeutung der Register (DC/AC, gemessen/abgeleitet) nicht geprüft`);
  }
  // Zweiter WR aktiv wie services/inverter/sungrow.js resolveSecondInverter (enabled = Host gesetzt);
  // bewusst nicht importiert, damit die Auswertung kein Schreibpfad-Modul lädt.
  if (manufacturer === 'sungrow' && String(cfg?.sungrow?.secondInverter?.host || '').trim().length > 0) {
    return out(false, `nicht messbar bei ${label} mit zweitem Wechselrichter: die Hauslast wird mit dessen DC-Werten korrigiert`);
  }
  return out(true, null, { verified: profile.verified, note: profile.note });
}

// ── Summen ───────────────────────────────────────────────────────────────────

const numOrNull = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * Tageszeilen → Summen und Wirkungsgrade des Zeitraums (energiegewichtet).
 * capacityKwhForDay(day) liefert die Nennkapazität des Tages (Akku-Ausbaustufen);
 * ΔSoC = Σ je Tag (letzter − erster Ladestand) × Kapazität.
 */
export function summarizeStorageRows(rows, { capacityKwhForDay = null } = {}) {
  const t = {
    charge: 0, pvToBatt: 0, convToBatt: 0, acIn: 0, discharge: 0, acOut: 0,
    chargeAll: 0, dischargeAll: 0, converterLoss: 0, seconds: 0, samples: 0
  };
  const days = [];
  let deltaKwh = 0;
  let deltaKnown = true;
  for (const r of rows || []) {
    if (!r) continue;
    t.charge += num(r.charge_dc_wh);
    t.pvToBatt += num(r.pv_to_batt_wh);
    t.convToBatt += num(r.conv_to_batt_wh);
    t.acIn += num(r.ac_in_wh);
    t.discharge += num(r.discharge_dc_wh);
    t.acOut += num(r.ac_out_wh);
    t.chargeAll += num(r.charge_all_wh);
    t.dischargeAll += num(r.discharge_all_wh);
    t.converterLoss += num(r.converter_loss_wh);
    t.seconds += num(r.seconds);
    t.samples += num(r.samples);
    if (!(num(r.seconds) > 0) || !r.day) continue;
    const day = String(r.day).slice(0, 10);
    days.push(day);
    const first = numOrNull(r.soc_first_pct);
    const last = numOrNull(r.soc_last_pct);
    const cap = typeof capacityKwhForDay === 'function' ? numOrNull(capacityKwhForDay(day)) : null;
    if (first == null || last == null || !(cap > 0)) deltaKnown = false;
    else deltaKwh += ((last - first) / 100) * cap;
  }
  days.sort();
  const storedDeltaKwh = deltaKnown && days.length ? deltaKwh : null;
  const input = t.pvToBatt + t.acIn;
  const chargeOk = t.charge / 1000 >= STORAGE_MIN_KWH && input > 0;
  const dischargeOk = t.discharge / 1000 >= STORAGE_MIN_KWH;
  const chargeEta = chargeOk ? t.charge / input : null;
  const dischargeEta = dischargeOk ? t.acOut / t.discharge : null;
  const chargerEta = t.acIn / 1000 >= STORAGE_MIN_KWH ? t.convToBatt / t.acIn : null;
  const netChargeWh = storedDeltaKwh == null ? null : t.chargeAll - storedDeltaKwh * 1000;
  const dcEta = netChargeWh != null && netChargeWh > 0 && t.dischargeAll / 1000 >= STORAGE_MIN_KWH
    ? t.dischargeAll / netChargeWh
    : null;
  let status = 'ok';
  let reason = null;
  if (chargeEta == null || dischargeEta == null) {
    status = 'insufficient_data';
    reason = days.length === 0
      ? 'noch keine Messwerte (Tagesjob läuft stündlich)'
      : `zu wenig Lade-/Entlademenge (mindestens je ${STORAGE_MIN_KWH} kWh)`;
  } else if (storedDeltaKwh == null) {
    status = 'insufficient_data';
    reason = 'Ladestand oder Akku-Kapazität fehlt — ohne sie ist der Akku-Anteil nicht bestimmbar';
  } else if (dischargeEta >= NOT_MEASURABLE_ETA) {
    status = 'not_measurable';
    reason = 'Entladen ohne Wandlerverlust: der Hausverbrauch wird offenbar aus der Akku-Leistung abgeleitet';
  } else if ([chargeEta, dischargeEta, dcEta].some((eta) => eta == null || eta < ETA_MIN || eta > ETA_MAX)) {
    status = 'implausible';
    reason = 'Messwerte nicht plausibel (Vorzeichen oder Bedeutung der Register prüfen)';
  }
  return {
    status,
    reason,
    days: days.length,
    firstDay: days[0] || null,
    lastDay: days[days.length - 1] || null,
    hours: round(t.seconds / 3600, 1),
    chargeDcKwh: round(t.charge / 1000),
    pvToBatteryKwh: round(t.pvToBatt / 1000),
    chargerToBatteryKwh: round(t.convToBatt / 1000),
    acInKwh: round(t.acIn / 1000),
    dischargeDcKwh: round(t.discharge / 1000),
    acOutKwh: round(t.acOut / 1000),
    chargeAllKwh: round(t.chargeAll / 1000),
    dischargeAllKwh: round(t.dischargeAll / 1000),
    storedDeltaKwh: storedDeltaKwh == null ? null : round(storedDeltaKwh),
    converterLossKwh: round(t.converterLoss / 1000),
    // Ungerundet für die Rechnung (history-tariff.js), gerundet für die Anzeige.
    raw: {
      chargeKwh: t.charge / 1000,
      inputKwh: input / 1000,
      dischargeKwh: t.discharge / 1000,
      acOutKwh: t.acOut / 1000,
      chargeAllKwh: t.chargeAll / 1000,
      dischargeAllKwh: t.dischargeAll / 1000,
      storedDeltaKwh
    },
    chargeEta,
    dischargeEta,
    chargerEta,
    dcEta,
  };
}

/** Summen eines Zeitraums [from, toExclusive) aus der Tagestabelle. */
export async function loadStorageEfficiency(db, { from, toExclusive, capacityKwhForDay = null }) {
  if (!db || typeof db.query !== 'function' || !from || !toExclusive) return null;
  const res = await db.query(STORAGE_ROWS_SQL, [from, toExclusive]);
  return summarizeStorageRows(res.rows || [], { capacityKwhForDay });
}

// ── Tagesjob ─────────────────────────────────────────────────────────────────

export function createStorageEfficiencyDaily({ getDb, getCfg, pushLog, maxBackfillDays = 31 } = {}) {
  let running = false;
  let firstRawDay = null;
  let finalizedDay = null;
  const timeZone = () => getCfg?.()?.timeZone || 'Europe/Berlin';
  const log = (event, data) => { if (typeof pushLog === 'function') pushLog(event, data); };

  async function computeDay(db, day) {
    const res = await db.query(STORAGE_EFFICIENCY_SQL, [
      day, timeZone(), EFFICIENCY_SERIES_KEYS, STORAGE_MIN_BATTERY_W, STORAGE_MAX_GAP_SECONDS,
    ]);
    const r = res.rows?.[0] || {};
    // Auch ein Tag ohne Proben bekommt eine Zeile (0) — daran erkennt der Job
    // „schon berechnet“.
    await db.query(UPSERT_STORAGE_SQL, [
      day, num(r.charge_dc_wh), num(r.pv_to_batt_wh), num(r.conv_to_batt_wh), num(r.ac_in_wh),
      num(r.discharge_dc_wh), num(r.ac_out_wh), num(r.charge_all_wh), num(r.discharge_all_wh),
      num(r.converter_loss_wh), numOrNull(r.soc_first_pct), numOrNull(r.soc_last_pct), num(r.seconds), num(r.samples),
    ]);
  }

  // Wie daily.js: heute laufend, den Vortag einmal je Tag final, dann fehlende
  // ältere Tage nachholen (höchstens maxBackfillDays je Lauf).
  async function runOnce({ now = new Date() } = {}) {
    if (running) return { skipped: 'already running' };
    const db = getDb?.();
    if (!db || typeof db.query !== 'function') return { skipped: 'no database' };
    if (!storageEfficiencyCapability(getCfg?.() || {}).measurable) return { skipped: 'not measurable' };
    running = true;
    const computed = [];
    try {
      const tz = timeZone();
      const today = localDateString(now, tz);
      const yesterday = localDateString(new Date(now.getTime() - DAY_MS), tz);
      await computeDay(db, today);
      computed.push(today);
      if (finalizedDay !== yesterday) {
        await computeDay(db, yesterday);
        computed.push(yesterday);
        finalizedDay = yesterday;
      }
      if (!firstRawDay) {
        const first = await db.query(FIRST_RAW_DAY_SQL, [tz]);
        firstRawDay = first.rows?.[0]?.first_day || null;
      }
      if (firstRawDay && firstRawDay < yesterday) {
        const missing = await db.query(MISSING_STORAGE_DAYS_SQL, [firstRawDay, yesterday, maxBackfillDays]);
        for (const row of missing.rows || []) {
          await computeDay(db, row.day);
          computed.push(row.day);
        }
      }
      log('storage_efficiency_daily', { days: computed.length, newest: computed[0], oldest: computed[computed.length - 1] });
      return { computed };
    } catch (e) {
      log('storage_efficiency_daily_error', { error: e.message, computed: computed.length });
      return { error: e.message, computed };
    } finally {
      running = false;
    }
  }

  return { runOnce, computeDay };
}
