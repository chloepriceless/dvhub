// services/optimizer/eos-forecast-bridge.js — Phase 22.1 (2026-05-24).
//
// Bridges DVhub's native 15-min forecasts (PV ensemble, EnergyCharts spot
// cache, hour-of-day load model) into EOS via PUT /v1/prediction/import/
// {provider_id} so the genetic optimizer sees the same data DVhub's own
// optimizer consumes. Without this, EOS pulls VRM independently — VRM only
// surfaces hourly forecasts AND lacks the Solcast+pvnode+OpenMeteo+ML
// ensemble DVhub already runs, so EOS plans on inferior inputs.
//
// Push contract:
//   - Format: PydanticDateTimeDataFrame, DATETIME-FIRST
//       { data: {<iso8601>: {<key>: <value>}}, dtypes: {<key>: 'float64'},
//         tz: 'Europe/Berlin', datetime_columns: [] }
//     (Die Zeitstempel sind der Index, NICHT die Spalte — s. buildDataFrameBody
//     und die Warnung dort. Column-first wird von EOS mit HTTP 200 quittiert
//     und still verworfen; gegen 0.3.0 wie gegen 0.4.0rc1 nachgemessen
//     2026-09-20.)
//   - Keys (EOS-canonical):
//       pvforecast_ac_power     [W]      from forecastService.buildForecastResponse().pv
//       loadforecast_power_w    [W]      from .load (hourly, forward-filled 4x)
//       elecprice_marketprice_wh [€/Wh]  from .price (ct/kWh ÷ 100000)
//   - Horizon: as many slots as available; EOS extends with last value via
//     fill_method='ffill' on its side if needed.
//
// Triggered:
//   - On boot (after eos-config-sync runs, before first ems.interval tick).
//   - On every saveAndApplyConfig() (config change may flip slot resolution).
//   - On the hourly EMS-tick offset (60s before ems.interval fires) via
//     setInterval started from createEosForecastBridge.start().
//
// Defensive: never throws, mirrors eos-adapter.js / eos-config-sync.js
// contract — { ok, pushed: string[], errors: object } per call.

import { isGridStorageOnly, createStandbyEstimator, resolveStandbyW, buildGridStorageSeries, gridImportW } from './grid-storage.js';
// Ladestand des Autos fuer EOS: angesteckt der echte, in der Vorplanung der
// erwartete bei Ankunft (ev-registration.js).
import { evSocForEos } from './ev-registration.js';
import { dvhubTriggersEosRuns } from './eos-run-trigger.js';
import { buildEosOptimization } from './eos-config-sync.js';
import { eosTargetKey, resolveEosProxy } from './eos-adapter.js';
import http from 'node:http';
import { summarizeWeightedApplicableValue } from '../../history-runtime.js';
import { resolveUserImportPriceCtKwhForSlot } from '../../config-model.js';
import { loadSchedulableDevices } from '../devices/schedulable.js';
import { reserveHeaterLoad } from '../devices/heater-load-reservation.js';
import { localDate } from '../../tz-fast.js';
// Zweite GX am selben Anschluss: Ladestand beider Akkus, nach Kapazitaet gewichtet.
import { planningSocPct } from '../multi-gx/planning.js';
// Preisschwanz hinter den bekannten Day-Ahead-Preisen: Residuallast-Prognose
// von dvhub.online (1.0.11, price-outlook.js). Holt-Winters (price-estimate.js)
// nur noch für die Wertgrundlage des E-Autos (bis 9,5 Tage voraus).
import { fillPriceSlotsFromOutlook, realPriceCoverage, SLOT_MS as PRICE_SLOT_MS } from './price-outlook.js';
import { fillPriceSlots, HISTORY_DAYS } from './price-estimate.js';
import { requestHostname } from '../host-address.js';
import { eosRemoteActive, REMOTE_EOS_PREDICTION_HOURS } from './eos-remote.js';
// Fristen für den Steuerzeitraum „automatisch“ (05.11.2026): Abfahrt des
// Autos, Fensterende planbarer Geräte — wie eos-config-sync sie EOS schickt.
import { resolveEvDeparture } from './ev-departure.js';
import { buildEvValueInputs, configuredMaxSocPct, EV_VALUE_INPUTS_DAYS } from './ev-targets.js';
import { buildEosHomeAppliances } from './eos-devices.js';

/**
 * Frist der Wache je Push (siehe push()): jede EOS-Anfrage hat 15 s, ein Push
 * macht höchstens gut ein Dutzend davon — 5 min lassen reichlich Luft.
 */
export const PUSH_TIMEOUT_MS = 5 * 60_000;
/**
 * Höchstens so lange wartet ein Push auf die gespeicherten echten Preise aus
 * der Datenbank — sie werden seit Befund 9 bei jedem Push gelesen. Hängt die
 * Datenbank, geht der Push mit den Preisen im Speicher weiter, statt bis zur
 * Wache (PUSH_TIMEOUT_MS) zu warten (Gegenprüfung 1c7d8b2c, P3).
 */
export const STORED_PRICES_TIMEOUT_MS = 10_000;
/**
 * Spätester Laufbeginn nach prepareRun: Ladestand holen (≤ 15 s) und
 * Aufruf. EOS rundet den Beginn auf den Slot ab; mit dieser Zugabe zählt ein
 * Anstoß kurz vor der Slotgrenze schon zum nächsten Slot.
 */
export const RUN_START_MARGIN_MS = 60_000;
const TIMEOUT_MS = 15_000; // bigger than config-sync because 192 rows × 3 keys
const SLOT_MS_15MIN = 15 * 60 * 1000;

/**
 * Convert a DVhub 15-min slot array into the {iso8601: value} map EOS expects
 * for a single dataframe column. Empty/null power values get skipped — EOS
 * tolerates sparse columns and fills with ffill.
 *
 * @param {Array<{start: string, powerW: number}>} slots
 * @returns {Object<string, number>}
 */
function slotsToTimeMap(slots) {
  const out = {};
  for (const s of slots) {
    if (!s?.start) continue;
    // Skip nullable values explicitly — Number(null) === 0 would silently
    // turn an "unknown" slot into a "0 W" data point, biasing the optimizer.
    if (s.powerW === null || s.powerW === undefined) continue;
    const v = Number(s.powerW);
    if (!Number.isFinite(v)) continue;
    // EOS accepts plain "YYYY-MM-DD HH:MM:SS" or ISO8601. Use ISO with
    // millisecond precision stripped (EOS' pendulum parser is strict).
    const iso = new Date(s.start).toISOString().replace('.000Z', 'Z');
    out[iso] = v;
  }
  return out;
}

/**
 * Ende (ms, exklusiv) der lückenlosen Abdeckung ab `nowMs`: der Slot, der zu
 * diesem Zeitpunkt läuft, und alle direkt anschließenden. Slots
 * `{start, ctKwh}`, Schrittweite aus den Daten. -Infinity, wenn zu diesem
 * Zeitpunkt kein Slot läuft.
 */
export function contiguousPriceEndMs(slots, nowMs) {
  const starts = [...new Set((Array.isArray(slots) ? slots : [])
    .filter((s) => s && Number.isFinite(Number(s.ctKwh)))
    .map((s) => Date.parse(s.start))
    .filter(Number.isFinite))].sort((a, b) => a - b);
  let stepMs = Infinity;
  for (let i = 1; i < starts.length; i += 1) stepMs = Math.min(stepMs, starts[i] - starts[i - 1]);
  if (!Number.isFinite(stepMs) || stepMs <= 0) stepMs = 15 * 60_000;
  let end = -Infinity;
  for (const t of starts) {
    if (t + stepMs <= nowMs) continue;
    if (!Number.isFinite(end)) { if (t > nowMs) break; end = t + stepMs; continue; }
    if (t > end) break; // Lücke
    end = Math.max(end, t + stepMs);
  }
  return end;
}

/**
 * Reihe `{start, powerW}` in ihrer eigenen Schrittweite (kleinster Abstand,
 * sonst 15 min) mit dem ersten Wert bis zum Slot zurückfüllen, der jetzt
 * läuft — für die Berechnung des Steuerzeitraums, wenn eine Prognose (PV aus
 * VRM) erst zur nächsten vollen Stunde beginnt (Gegenprüfung 7e99580c).
 */
export function padSeriesBackToNow(slots, nowMs) {
  const list = (Array.isArray(slots) ? slots : []).filter((s) => Number.isFinite(Date.parse(s?.start)));
  if (!list.length) return Array.isArray(slots) ? slots : [];
  const starts = [...new Set(list.map((s) => Date.parse(s.start)))].sort((a, b) => a - b);
  let stepMs = Infinity;
  for (let i = 1; i < starts.length; i += 1) stepMs = Math.min(stepMs, starts[i] - starts[i - 1]);
  if (!Number.isFinite(stepMs) || stepMs <= 0) stepMs = 15 * 60_000;
  const first = list.find((s) => Date.parse(s.start) === starts[0]);
  if (starts[0] <= nowMs) return slots;
  const pad = [];
  for (let t = starts[0] - stepMs; ; t -= stepMs) {
    pad.unshift({ ...first, start: new Date(t).toISOString(), padded: true });
    if (t <= nowMs) break;
  }
  return [...pad, ...slots];
}

/**
 * Lastprognose bis zum Beginn der laufenden Stunde (minus padHours) zurück
 * auffüllen (2026-10-02). Die Prognose beginnt erst zur NÄCHSTEN vollen Stunde;
 * EOS braucht aber Last ab dem laufenden Slot, sonst bricht jeder Lauf mit
 * „Missing or invalid load within the control horizon“ ab. Früher füllte EOS
 * die Lücke aus älteren, auf Platte gespeicherten Pushes — seit dem
 * Autosave-aus (SD-Schonung) fehlte nach jedem EOS-Neustart bis zu 1 h der Plan.
 * Aufgefüllt wird mit dem ersten Prognosewert (für die laufende Stunde gut genug).
 */
export function padSlotsBackToNow(slots, nowMs, { padHours = 2 } = {}) {
  if (!Array.isArray(slots) || !slots.length) return slots || [];
  const HOUR = 3_600_000;
  const startOf = (sl) => {
    const v = sl?.start ?? sl?.ts;
    const t = v instanceof Date ? v.getTime() : (typeof v === 'number' ? v : Date.parse(v));
    return Number.isFinite(t) ? t : null;
  };
  const first = slots[0];
  const firstMs = startOf(first);
  if (firstMs == null) return slots;
  const target = Math.floor(nowMs / HOUR) * HOUR - padHours * HOUR;
  const pad = [];
  for (let t = firstMs - HOUR; t >= target; t -= HOUR) {
    pad.unshift({ ...first, start: new Date(t).toISOString(), padded: true });
  }
  return pad.length ? [...pad, ...slots] : slots;
}

/**
 * Forward-fill a 1-hour load slot grid into 15-minute granularity. EOS sees
 * 4× the row count with the same watt-value repeated per quarter — equivalent
 * to a step function. Acceptable because DVhub's load-forecast is itself a
 * hour-of-day SQL rollup; no real sub-hourly information exists upstream.
 *
 * @param {Array<{start: string, powerW: number}>} hourlySlots
 * @returns {Array<{start: string, powerW: number}>}
 */
function expandHourlyToQuarterHourly(hourlySlots) {
  const out = [];
  for (const s of hourlySlots) {
    if (!s?.start) continue;
    const baseMs = new Date(s.start).getTime();
    for (let q = 0; q < 4; q++) {
      out.push({
        start: new Date(baseMs + q * SLOT_MS_15MIN).toISOString(),
        powerW: s.powerW,
      });
    }
  }
  return out;
}

/**
 * Convert a DVhub price slot ({ctKwh}) to EOS' EUR/Wh format. EOS' canonical
 * unit for elecprice_marketprice_wh is EUR per watt-hour, NOT ct/kWh — divide
 * by 100 (ct→€) then by 1000 (kWh→Wh).
 *
 * @param {Array<{start: string, ctKwh: number}>} slots
 * @returns {Array<{start: string, powerW: number}>}  reused powerW field
 */
function priceSlotsToEosFormat(slots) {
  return slots
    .filter((s) => s?.start && Number.isFinite(Number(s.ctKwh)))
    .map((s) => ({
      start: s.start,
      powerW: Number(s.ctKwh) / 100 / 1000, // EUR/Wh
    }));
}

/**
 * Build the DataFrame payload for a single EOS *Import provider.
 *
 * EOS' PydanticDateTimeDataFrame schema (core/pydantic.py:995) is keyed
 * datetime-first, then column:
 *   data: { "<iso8601>": { "<column>": <value>, ... }, ... }
 * NOT column-first. A column-first shape ("data: {<column>: {<datetime>:
 * value}}") deserializes silently as 0 rows — the field_validator treats the
 * datetime strings as "columns" and the cross-check `next(iter(values))`
 * sees them as the column-set; the dataframe then has zero rows because the
 * inner dicts are empty after column-stripping.
 *
 * @param {string} columnKey   - EOS canonical series key (e.g. "pvforecast_ac_power")
 * @param {Array<{start: string, powerW: number}>} slots
 * @param {string} tz          - default "Europe/Berlin"
 * @returns {object}             PydanticDateTimeDataFrame body
 */
function buildDataFrameBody(columnKey, slots, tz = 'Europe/Berlin') {
  const timeMap = slotsToTimeMap(slots);
  const data = {};
  for (const [iso, value] of Object.entries(timeMap)) {
    data[iso] = { [columnKey]: value };
  }
  return {
    data,
    dtypes: { [columnKey]: 'float64' },
    tz,
    datetime_columns: [],
  };
}

/**
 * Feste Einspeisevergütung als Reihe für EOS (FeedInTariffImport, €/Wh).
 *
 * EOS 0.4 bricht jeden Lauf ab, wenn im Steuerzeitraum keine Einspeisevergütung
 * vorliegt ("Missing or invalid feed-in tariff within the control horizon",
 * Pi 2026-10-02). Bisher bekam EOS sie nur im Spot-Modus — Boxen mit fester
 * EEG-Vergütung planten unter 0.4 gar nicht. Gleiche Regel wie der interne
 * Optimierer (cost-model.js computeSlotCosts): optimizer.tariff.feedInCtKwh
 * (Standard 7,78 ct), bei negativem Spot 0. Zeitachse = die der Preise.
 */
export function fixedFeedInSlots(priceSlotsCt, tariff = {}) {
  const fixedCt = Number.isFinite(Number(tariff.feedInCtKwh)) ? Number(tariff.feedInCtKwh) : 7.78;
  return (Array.isArray(priceSlotsCt) ? priceSlotsCt : [])
    .filter((s) => s && s.start)
    .map((s) => {
      const spotCt = Number(s.ctKwh);
      const ct = Number.isFinite(spotCt) && spotCt < 0 ? 0 : fixedCt;
      return s.estimated ? { start: s.start, powerW: ct / 100 / 1000, estimated: true } : { start: s.start, powerW: ct / 100 / 1000 };
    });
}

/**
 * Womit EOS die eingespeiste kWh bewertet — dieselbe Regel wie push() unten:
 * Einspeise-Modus „spot“ mit eingeschalteter Marktprämie → 'spot_premium',
 * „spot“ ohne → 'spot', sonst die feste Vergütung → 'fixed'. Für die Anzeige
 * „niedrigster Einspeisewert … (Börse + Marktprämie)“ im Leitstand
 * (eos-plan-summary.js, Christin 02.11.2026). Fehlen anzulegender Wert oder
 * Marktwert, rechnet push() ohne Prämie; die Anzeige folgt der Einstellung.
 */
export function eosFeedInBasis(cfg) {
  const tariff = cfg?.optimizer?.tariff || {};
  if (String(tariff.feedInMode || 'fixed').toLowerCase() !== 'spot') return 'fixed';
  return tariff.feedInIncludeMarketPremium === true ? 'spot_premium' : 'spot';
}

const fixedFeedInCt = (tariff) => (Number.isFinite(Number(tariff?.feedInCtKwh)) ? Number(tariff.feedInCtKwh) : 7.78);

/**
 * Grundlage des Einspeisewerts für die Anzeige zum gezeigten Plan
 * (/api/eos/plan priceBasis, Gegenprüfungen 63b36983/d22f5a4d/18f41bac):
 * - vor dem ersten Push aus der Einstellung (mit festem Satz);
 * - sonst die beim Push abgelegte (state.optimizer.eosFeedInBasis, `since` =
 *   ab wann sie gilt). Maßgeblich ist der Laufbeginn des Plans (generatedAt −
 *   Laufdauer): galt die aktuelle da schon → sie; wechselte sie während des
 *   Laufs → unbekannt; ist der Plan älter → die vorige, wenn die bei
 *   Laufbeginn galt. Unbekannt → null, die Anzeige lässt den Zusatz weg.
 * @param {object} opt   state.optimizer
 * @param {object} cfg
 * @param {number} planGeneratedMs  generatedAt des gezeigten Plans (NaN = unbekannt)
 * @param {number} [runMs]          Dauer des Laufs, der ihn gerechnet hat (unbekannt: 60 min)
 */
/** Laufdauer, wenn DVhub sie nicht kennt (EOS nach eigenem Takt, Lauf aus dem
 *  alten Prozess): großzügig 60 min — eHive mit Auto 24 h ≈ 30–42 min. */
export const ASSUMED_EOS_RUN_MS = 60 * 60_000;

export function eosPlanFeedInBasis(opt, cfg, planGeneratedMs, runMs = NaN) {
  const strip = (b) => (b ? { feedIn: b.feedIn, ...(b.fixedCtKwh !== undefined ? { fixedCtKwh: b.fixedCtKwh } : {}) } : null);
  const cur = opt?.eosFeedInBasis;
  if (!cur) {
    const feedIn = eosFeedInBasis(cfg);
    return feedIn === 'fixed' ? { feedIn, fixedCtKwh: fixedFeedInCt(cfg?.optimizer?.tariff) } : { feedIn };
  }
  if (!Number.isFinite(planGeneratedMs)) return strip(cur);
  // Laufdauer unbekannt → ASSUMED_EOS_RUN_MS (Gegenprüfung 27a172cb).
  const planStart = planGeneratedMs - (Number(runMs) > 0 ? Number(runMs) : ASSUMED_EOS_RUN_MS);
  const heldAt = (b) => b && (!(b.since > 0) || b.since <= planStart);
  if (heldAt(cur)) return strip(cur);
  if (cur.since < planGeneratedMs) return null; // Wechsel während des Laufs
  const prev = opt.eosFeedInBasisPrev;
  return heldAt(prev) ? strip(prev) : null;
}

/**
 * Nur Stempel auf dem Slot-Raster an EOS geben.
 *
 * forecast.solar liefert neben den Rasterwerten Punkte zu Sonnenauf- und
 * -untergang (07:22:57, 19:00:15 …). EOS 0.4 leitet die Kadenz einer Reihe aus
 * dem KLEINSTEN Abstand zweier Stempel ab (optimization/genetic/forecast.py
 * bounded_forecast_array): 19:00:00 neben 19:00:15 ergibt 15 s, kein Wert
 * deckt dann einen 15-min-Slot ganz ab, die Reihe gilt als leer und JEDER Lauf
 * bricht ab ("Missing or invalid PV within the control horizon", Container
 * auf prod 2026-10-02). Einmal in EOS, lässt sich so ein Datensatz über die
 * API nicht mehr entfernen — DELETE /v1/prediction/range leert nur den Wert,
 * der leere Datensatz bleibt. Deshalb hier filtern, bevor er EOS erreicht.
 *
 * @param {Array<{start: string}>} slots
 * @param {number} slotMs - Rasterweite, Standard 15 min
 */
export function keepOnGridSlots(slots, slotMs = 15 * 60_000) {
  if (!Array.isArray(slots)) return [];
  return slots.filter((sl) => {
    const ms = Date.parse(sl?.start ?? sl?.ts);
    return Number.isFinite(ms) && ms % slotMs === 0;
  });
}

/**
 * Internal HTTP helper. Mirrors eos-config-sync.js — never throws,
 * returns { ok, data?, error? }.
 */
function eosHttpRequest(baseUrl, method, path, body) {
  return new Promise((resolve) => {
    try {
      const url = new URL(path, baseUrl);
      const headers = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const req = http.request({
        hostname: requestHostname(url.hostname),
        port: url.port || 8503,
        // Include url.search — the SoC measurement PUT passes datetime/key/
        // value entirely on the query string. The forecast import PUTs carry
        // no query string, so url.search is '' for them (unchanged behaviour).
        path: url.pathname + url.search,
        method,
        headers,
        timeout: TIMEOUT_MS,
      }, (res) => {
        let chunks = '';
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            resolve({ ok: false, error: `EOS HTTP ${res.statusCode}: ${chunks.slice(0, 300)}` });
            return;
          }
          try {
            resolve({ ok: true, data: chunks ? JSON.parse(chunks) : null });
          } catch {
            resolve({ ok: true, data: null });
          }
        });
      });
      req.on('error', (err) => resolve({ ok: false, error: err.message || 'EOS connect error' }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'EOS timeout' }); });
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    } catch (err) {
      resolve({ ok: false, error: err.message || 'EOS request failed' });
    }
  });
}

/**
 * Create the bridge agent. Returns { push, start, stop }.
 *
 * @param {object} ctx - DI: { getCfg, pushLog, forecastService }
 * @returns {{
 *   push: () => Promise<{ok: boolean, pushed: string[], errors: object}>,
 *   start: () => void,
 *   stop: () => void,
 * }}
 */
/**
 * Steuerzeitraum höchstens 48 h, auch ohne eingestellte Grenze: Der
 * EOS-Rechendienst nimmt horizon_hours 1..48; echte Day-Ahead-Preise reichen
 * ohnehin höchstens ~35 h (nach 13 Uhr bis Mitternacht des Folgetags).
 */
export const CONTROL_HORIZON_ABS_MAX_H = 48;
/**
 * Steuerzeitraum „bis in die Preisprognose“ (1.0.11): höchstens 120 h — so weit
 * reicht die Residuallast-Prognose mindestens (5 Tage hinter dem letzten
 * bekannten Börsentag). Rechenzeit Rust-Kern (eos-bench/preisschwanz,
 * 12.11.2026): 30 → 72 / 96 / 120 h ×2,2 / ×3,1 / ×3,6–4; auf dem A7S
 * hochgerechnet ~16–23 / 22–32 / 28–41 s je Lauf statt 7–10 s.
 */
export const CONTROL_HORIZON_FORECAST_MAX_H = 120;
/** EOS-Schwanz hinter dem Steuerzeitraum (EOS tail_horizon_hours, Standard 48 h). */
export const EOS_TAIL_HOURS = 48;
/** Längster automatischer EOS-Prognosehorizont (prediction.hours). */
export const EOS_PREDICTION_HOURS_MAX = 72;
/**
 * Längster wählbarer EOS-Prognosehorizont (1.0.11): Die Residuallast-Prognose
 * reicht fünf Tage hinter den letzten bekannten Börsentag, also bis gut 150 h
 * voraus. Darüber hinaus gäbe es keine Preise mehr.
 */
export const EOS_PREDICTION_HOURS_LIMIT = 168;
/**
 * Mindestens so viel Schwanz bleibt hinter dem Steuerzeitraum: Ohne Schwanz
 * bewertet EOS die Restladung fast nur zum Einspeisewert und speist mittags
 * PV ein, statt sie für Nacht und Morgen zu speichern (Tail-Fix 01.11.2026,
 * Gegenprüfung ae4e76f6).
 */
export const EOS_MIN_TAIL_HOURS = 12;

const positiveInt = (v) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * EOS-Prognosehorizont (prediction.hours, bisher EOS' fester Standard 48 h —
 * Christin 02.11.2026). optimizer.eosPredictionHours > 0 = fest (höchstens
 * 72 h); sonst automatisch: Steuerzeitraum-Grenze + 48 h Schwanz, höchstens
 * 72 h — ohne Grenze also 72 h. Der Schwanz wird je Lauf nur einmal rückwärts
 * gelöst (EOS tailvalue.build_tail_value_curve) und kostet kaum Rechenzeit.
 * Fernbetrieb: der Rechendienst nimmt prediction.hours nicht an und rechnet mit
 * dem EOS-Standard (REMOTE_EOS_PREDICTION_HOURS) — damit planen, damit der
 * Steuerzeitraum seinen Schwanz behält (Gegenprüfung Release 1.0.9).
 */
export function resolveEosPredictionHours(cfg) {
  if (eosRemoteActive(cfg)) return REMOTE_EOS_PREDICTION_HOURS;
  const fixed = positiveInt(cfg?.optimizer?.eosPredictionHours);
  // Fest gewählt: bis 168 h (1.0.11, Preisschwanz aus der Residuallast-
  // Prognose); EOS kürzt den Schwanz selbst an der kürzesten Reihe (PV, Last,
  // Preise) — DVhub zeigt, woran (eosPriceTail.limitedBy).
  if (fixed !== null) return Math.min(fixed, EOS_PREDICTION_HOURS_LIMIT);
  // Steuerzeitraum bis in die Preisprognose: automatisch so weit wie möglich
  // (Steuerzeitraum höchstens 120 h + 48 h Schwanz = 168 h).
  if (controlHorizonMode(cfg) === 'forecast') return EOS_PREDICTION_HOURS_LIMIT;
  const ctrl = Math.min(positiveInt(cfg?.optimizer?.eosControlHorizonMaxHours) ?? CONTROL_HORIZON_ABS_MAX_H, CONTROL_HORIZON_ABS_MAX_H);
  return Math.min(ctrl + EOS_TAIL_HOURS, EOS_PREDICTION_HOURS_MAX);
}

/**
 * Obergrenze des Steuerzeitraums: optimizer.eosControlHorizonMaxHours > 0
 * (z. B. 6/12/24 h für kleine Boards), sonst der ganze bekannte
 * Preiszeitraum (bis 48 h). Höchstens Prognosehorizont − 12 h: länger bricht
 * EOS jeden Lauf ab („prediction.hours covers the control horizon“), ohne
 * Schwanz bewertet es die Restladung falsch.
 */
export function resolveControlHorizonMaxHours(cfg) {
  const user = positiveInt(cfg?.optimizer?.eosControlHorizonMaxHours);
  const withTail = Math.max(1, resolveEosPredictionHours(cfg) - EOS_MIN_TAIL_HOURS);
  // Bis in die Preisprognose (1.0.11): bis 120 h — nur mit lokalem EOS (der
  // Rechendienst nimmt horizon_hours nur bis 48 h).
  if (controlHorizonMode(cfg) === 'forecast' && !eosRemoteActive(cfg)) return Math.min(CONTROL_HORIZON_FORECAST_MAX_H, withTail);
  return Math.min(user ?? CONTROL_HORIZON_ABS_MAX_H, CONTROL_HORIZON_ABS_MAX_H, withTail);
}

/**
 * Wie viele volle Stunden ab `nowMs` sind in ALLEN Preisreihen lueckenlos
 * belegt? Slots `{start, powerW}` (15 min). Minus 15 min Puffer, begrenzt auf
 * 1..maxHours (Standard 48 h; bis 02.11.2026 fest 24 h — jetzt der ganze
 * bekannte Preiszeitraum, Grenze per resolveControlHorizonMaxHours). Reihen
 * ohne einen einzigen Wert zaehlen nicht mit. null, wenn keine Reihe Werte hat
 * oder eine Reihe den laufenden Slot nicht abdeckt.
 */
export function computeControlHorizonHours(slotLists, nowMs, { slotMs = 15 * 60_000, maxHours = CONTROL_HORIZON_ABS_MAX_H } = {}) {
  let coveredUntil = Infinity;
  let any = false;
  for (const list of slotLists) {
    const starts = [...new Set(list
      .filter((s) => s && Number.isFinite(Number(s.powerW)))
      .map((s) => Date.parse(s.start))
      .filter(Number.isFinite))].sort((a, b) => a - b);
    // Reihe ganz ohne Werte (z. B. Einspeisetarif nicht konfiguriert): sie
    // wird gar nicht an EOS geschickt und darf den Zeitraum nicht kippen.
    if (starts.length === 0) continue;
    // Slot-Laenge je Reihe aus den Daten (PV kann stuendlich kommen) — sonst
    // saehe eine Stundenreihe nach 15 min wie eine Luecke aus.
    let stepMs = slotMs;
    for (let i = 1; i < starts.length; i += 1) {
      const d = starts[i] - starts[i - 1];
      if (d > 0 && (i === 1 || d < stepMs)) stepMs = d;
    }
    // Luecke ab "jetzt" suchen: der Slot, der jetzt laeuft, muss da sein.
    let end = null;
    for (const t of starts) {
      if (t + stepMs <= nowMs) continue;
      if (end === null) { if (t > nowMs) break; end = t + stepMs; continue; }
      if (t > end) break; // Luecke
      end = Math.max(end, t + stepMs);
    }
    if (end === null) return null; // keine Abdeckung fuer jetzt
    any = true;
    coveredUntil = Math.min(coveredUntil, end);
  }
  if (!any) return null;
  const hours = Math.floor((coveredUntil - nowMs - slotMs) / 3_600_000);
  return Math.max(1, Math.min(maxHours, hours));
}

/**
 * Steuerzeitraum „automatisch“ (optimizer.eosControlHorizonMaxHours = 'auto',
 * Christin 05.11.2026): mindestens so viele Stunden, sonst bis zur spätesten
 * Frist. Gemessen (eos-bench HORIZONT-MESSUNG.md, Variante V3): Hausakku mit
 * 6 h + Schwanz verliert gegen den ganzen Preiszeitraum 0–0,2 €/Tag, das Auto
 * lädt gleich, solange seine Abfahrt im Steuerzeitraum liegt; auf 305 Tagen
 * (JAHRESRECHNUNG-2026.md) gleichauf bei etwa einem Viertel der Rechenzeit.
 */
export const AUTO_CONTROL_MIN_HOURS = 6;
export const CONTROL_HORIZON_AUTO = 'auto';
export const CONTROL_HORIZON_FORECAST = 'forecast';

/**
 * Wie der Steuerzeitraum bestimmt wird: 'full' = ganzer bekannter
 * Preiszeitraum (Standard), 'cap' = feste Grenze (6/12/24 h), 'auto' =
 * mindestens 6 h und bis zur Frist.
 */
export function controlHorizonMode(cfg) {
  const v = cfg?.optimizer?.eosControlHorizonMaxHours;
  const t = String(v).trim().toLowerCase();
  if (t === CONTROL_HORIZON_AUTO) return 'auto';
  if (t === CONTROL_HORIZON_FORECAST) return 'forecast';
  return positiveInt(v) !== null ? 'cap' : 'full';
}

/**
 * Steuerzeitraum über die echten Preise hinaus bis in die Preisprognose
 * (optimizer.eosControlHorizonMaxHours = 'forecast', 1.0.11, optional): EOS
 * plant Tage im Voraus Slot für Slot. Umgesetzt wird weiter nur, was auf
 * echten Preisen liegt — aus Slots mit Prognosepreisen setzt DVhub keine
 * Akku-Regeln (eos-adapter estimatedPriceCutoffMs, wie bei der E-Auto-Frist);
 * EOS rechnet ohnehin alle 15 min neu, und bis ein Prognose-Slot dran ist,
 * liegen dort echte Preise. Ohne Prognose: wie „ganzer Preiszeitraum“.
 *
 * @param {object} decision  decideControlHorizon / extendForEvDeadline
 * @param {object} p
 * @param {number|null} p.fullHours     volle Stunden in echten + Prognosepreisen (und PV/Last), mit der Grenze
 * @param {string|null} p.estimatedFrom erster Prognose-Slot (null = kein Schwanz)
 */
export function extendIntoForecast(decision, { fullHours, estimatedFrom }) {
  if (decision?.hours == null || decision.mode !== 'forecast' || !estimatedFrom) return decision;
  if (!Number.isFinite(fullHours) || fullHours <= decision.hours) return decision;
  return { ...decision, hours: fullHours, reason: 'price_forecast', estimatedFrom };
}

/**
 * Fristen der steuerbaren Verbraucher, die EOS im Steuerzeitraum sehen muss:
 *   - Abfahrt des Autos (min_soc_deadline_datetime) — nur, solange es bei EOS
 *     angemeldet ist (angesteckt oder Vorplanung, eos-config-sync
 *     decideEvRegistration → state.optimizer.eosEv). Liegt sie hinter dem
 *     Steuerzeitraum, verlangt EOS das Ziel schon an dessen Ende
 *     (genetic.py `_ev_deadline_slot`, v0.4.0rc3).
 *   - Fensterende planbarer Geräte (deadline_datetime), die heute noch nicht
 *     gelaufen sind — ein Gerät muss im Steuerzeitraum fertig werden, sonst
 *     findet EOS keinen Start (genetic.py `_build_appliance_layout`); ohne
 *     Fensterende frühester Start + Laufzeit.
 * Gleiche Auflösung wie eos-config-sync (resolveEvDeparture,
 * buildEosHomeAppliances).
 * @returns {Array<{kind:'ev'|'appliance', id?:string, atMs:number}>}
 */
export function collectPlanningDeadlines(cfg, state, nowMs = Date.now()) {
  const out = [];
  const opt = cfg?.optimizer || {};
  if (opt.eosOptimizeEv === true && state?.optimizer?.eosEv?.register === true) {
    const dep = resolveEvDeparture(cfg, nowMs);
    const at = Date.parse(dep.departureAt || '');
    if (dep.enabled && Number.isFinite(at) && at > nowMs) out.push({ kind: 'ev', atMs: at });
  }
  try {
    const sched = loadSchedulableDevices(cfg).devices.filter((d) => d.kind === 'deferrable' && d.enabled !== false);
    if (sched.length) {
      // Zeitzone wie eos-config-sync (dort cfg.timeZone) — dieselbe Frist, die EOS hat.
      const { appliances } = buildEosHomeAppliances(sched, { timeZone: cfg?.timeZone || 'Europe/Berlin', nowMs });
      const done = state?.optimizer?.applianceCyclesToday || {};
      for (const a of appliances) {
        if (Number(done[a.device_id]) >= 1) continue; // heute schon gelaufen
        // Mit Frist: das Fensterende (EOS wählt den Start im ganzen Fenster).
        // Ohne Frist (Codex-Gegenprüfung 6510846b): frühester möglicher
        // Start + Laufzeit — der ganze Lauf muss in den Steuerzeitraum passen,
        // sonst findet EOS keinen Start und verwirft den ganzen Lauf.
        let at = Date.parse(a.deadline_datetime || '');
        if (!Number.isFinite(at)) {
          const earliest = Date.parse(a.earliest_start_datetime || '');
          at = Math.max(nowMs, Number.isFinite(earliest) ? earliest : nowMs) + Number(a.duration_h || 1) * 3_600_000;
        }
        if (!Number.isFinite(at) || at <= nowMs) continue;
        out.push({ kind: 'appliance', id: a.device_id, atMs: at });
      }
    }
  } catch { /* Gerätekonfiguration unlesbar: keine Frist (eos-config-sync meldet das selbst) */ }
  return out;
}

/**
 * Steuerzeitraum dieses Pushs.
 *
 * @param {object} p
 * @param {number|null} p.realHours   volle Stunden in echten Preisen (und PV/Last), computeControlHorizonHours mit der Grenze
 * @param {'full'|'cap'|'auto'} p.mode  controlHorizonMode
 * @param {Array<{kind:string, id?:string, atMs:number}>} [p.deadlines]  collectPlanningDeadlines
 * @param {number} p.windowStartMs  frühester Laufbeginn (auf den EOS-Slot abgerundet): von dort zählen die Stunden bis zur Frist
 * @returns {{hours:number|null, realHours:number|null, mode:string,
 *   reason:'prices'|'min'|'deadline'|null, deadline:{kind:string, at:string, id?:string}|null}}
 */
export function decideControlHorizon({ realHours, mode = 'full', deadlines = [], windowStartMs }) {
  const base = { hours: realHours ?? null, realHours: realHours ?? null, mode, reason: realHours == null ? null : 'prices', deadline: null };
  if (realHours == null || mode !== 'auto') return base;
  // Bis zur spätesten Frist, aufgerundet auf volle Stunden ab dem frühesten
  // Laufbeginn: das Ende des Steuerzeitraums liegt so nie vor der Frist.
  let latest = null;
  for (const d of Array.isArray(deadlines) ? deadlines : []) {
    if (Number.isFinite(d?.atMs) && d.atMs > windowStartMs && (!latest || d.atMs > latest.atMs)) latest = d;
  }
  const toDeadline = latest ? Math.ceil((latest.atMs - windowStartMs) / 3_600_000) : 0;
  const want = Math.max(AUTO_CONTROL_MIN_HOURS, toDeadline);
  const hours = Math.min(realHours, want);
  let reason = 'min';
  if (want > realHours) reason = 'prices';
  else if (toDeadline > AUTO_CONTROL_MIN_HOURS) reason = 'deadline';
  const deadline = latest && reason !== 'min'
    ? { kind: latest.kind, at: new Date(latest.atMs).toISOString(), ...(latest.id ? { id: latest.id } : {}) }
    : null;
  return { ...base, hours, reason, deadline };
}

/**
 * E-Auto-Frist hinter den echten Preisen (Christin 05.11.2026): Steckt das
 * Auto vor ~13 Uhr an, enden die echten Preise um Mitternacht. Liegt die
 * Abfahrt dahinter, verlangt EOS das Ladeziel schon am Ende des
 * Steuerzeitraums (genetic.py `_ev_deadline_slot`, v0.4.0rc3: „Beyond the
 * horizon: the end-of-horizon requirement already covers it“) und lädt am
 * Abend teuer statt nachts. Dann — und nur dann — darf der Steuerzeitraum bis
 * zur Abfahrt in die geschätzten Preise reichen.
 *
 * Warum so und nicht ein anteiliges Zwischenziel am Ende des
 * Steuerzeitraums: Ein Zwischenziel muss raten, wie viel vor Mitternacht
 * geladen werden soll — zu hoch erzwingt teures Laden am Abend (der Fehler
 * selbst), zu niedrig lässt EOS die Kosten der Nacht nicht sehen, weil der
 * Schwanz kein Auto kennt. Mit der Frist im Steuerzeitraum wägt EOS Abend
 * gegen Nacht selbst ab, auf der besten verfügbaren Preisschätzung — und
 * sobald gegen 13 Uhr die echten Preise für morgen kommen, rechnet der nächste
 * Lauf mit ihnen (im 15-min-Takt ohnehin, bei seltenerem Takt stoßen neue
 * Day-Ahead-Preise einen Lauf an, eos-replan-triggers.js). Vorsicht für
 * den Akku bleibt: DVhub setzt aus Slots mit geschätzten Preisen keine
 * Akku-Regeln um (eos-adapter pullGridSetpoints, eosControl.estimatedFrom);
 * bis die Slots dran sind, ist längst mit echten Preisen neu gerechnet.
 *
 * @param {object} decision  decideControlHorizon
 * @param {object} p
 * @param {number|null} p.evAtMs        Abfahrt des angemeldeten Autos (collectPlanningDeadlines)
 * @param {number|null} p.fullHours     volle Stunden in echten + geschätzten Preisen (und PV/Last), mit der Grenze
 * @param {number} p.windowStartMs      frühester Laufbeginn
 * @param {number} p.realCoveredEndMs   Ende der lückenlosen echten Preise ab windowStartMs
 * @param {string|null} p.estimatedFrom erster geschätzter Slot (null = keine Schätzung)
 * @returns {object} decision, ggf. mit hours, reason 'ev_deadline', estimatedFrom, deadlineCovered
 */
export function extendForEvDeadline(decision, { evAtMs, fullHours, windowStartMs, realCoveredEndMs, estimatedFrom }) {
  if (decision?.hours == null || !Number.isFinite(evAtMs) || !estimatedFrom) return decision;
  if (!Number.isFinite(realCoveredEndMs) || evAtMs <= realCoveredEndMs) return decision;
  if (!Number.isFinite(fullHours) || fullHours <= decision.hours) return decision;
  const toDeparture = Math.ceil((evAtMs - windowStartMs) / 3_600_000);
  const hours = Math.min(toDeparture, fullHours);
  if (hours <= decision.hours) return decision;
  return {
    ...decision,
    hours,
    reason: 'ev_deadline',
    deadline: { kind: 'ev', at: new Date(evAtMs).toISOString() },
    estimatedFrom,
    deadlineCovered: hours >= toDeparture,
  };
}

/**
 * Höchstens so weit (ab jetzt) reicht der Preisschwanz: der längste wählbare
 * EOS-Prognosehorizont. Auch das Löschen alter Schwanzwerte in EOS
 * (clearStaleEstimates) reicht so weit.
 */
export const PRICE_FILL_MAX_MS = EOS_PREDICTION_HOURS_LIMIT * 3_600_000;

/**
 * Schwanz, den DVhub bei EOS anfordert (genetic.tail_horizon_hours, 1.0.11):
 * null = EOS-Standard (48 h) lassen. Erst bei einem Prognosehorizont über 72 h
 * nötig — EOS nimmt dann min(angefordert, prediction.hours − Steuerzeitraum).
 * Im Fernbetrieb nie (der Rechendienst nimmt den Pfad nicht an).
 */
export function resolveEosTailHours(cfg) {
  if (eosRemoteActive(cfg)) return null;
  const p = resolveEosPredictionHours(cfg);
  return p > EOS_PREDICTION_HOURS_MAX ? p : null;
}
/** EOS-Standard für tail_horizon_hours (geneticsettings.py). */
export const EOS_DEFAULT_TAIL_HOURS = 48;

/**
 * Bis wohin die Preisreihen reichen sollen: so weit wie PV- oder Lastprognose
 * (der EOS-Schwanz endet ohnehin an der kürzesten Reihe), höchstens maxMs —
 * der EOS-Prognosehorizont (resolveEosPredictionHours, Standard 72 h); weiter
 * liest EOS nicht. Ohne beide Prognosen (z. B. Nur Netzspeicher) 48 h.
 */
export function priceFillUntilMs(pvSlots, loadSlots, nowMs, maxMs = PRICE_FILL_MAX_MS) {
  let end = -Infinity;
  for (const [list, stepMs] of [[pvSlots, PRICE_SLOT_MS], [loadSlots, 3_600_000]]) {
    for (const s of Array.isArray(list) ? list : []) {
      const ms = Date.parse(s?.start);
      if (Number.isFinite(ms) && Number.isFinite(Number(s?.powerW))) end = Math.max(end, ms + stepMs);
    }
  }
  if (!Number.isFinite(end)) end = nowMs + 48 * 3_600_000;
  return Math.min(end, nowMs + Math.min(maxMs, PRICE_FILL_MAX_MS));
}

export function createEosForecastBridge(ctx) {
  const {
    getCfg,
    pushLog,
    forecastService,
    state,
    // Optional (Marktprämien-Modulation, 2026-06-21). Lazy accessors wired in
    // server.js; absent in tests/older builds → premium silently disabled.
    getSolarMarketValueSummary,
    getApplicableValueSummary,
  } = ctx;

  let tickHandle = null;
  let watchdogHandle = null;
  // Nur Netzspeicher: Ruhebedarf aus dem Netzzähler, ein Wert je Minute.
  const standbyEstimator = createStandbyEstimator();
  let standbyHandle = null;
  function sampleStandby() {
    const cfg = getCfg?.();
    if (!isGridStorageOnly(cfg) || !state?.meter?.ok) return;
    standbyEstimator.sample({
      importW: gridImportW(state.meter.grid_total_w, cfg.gridPositiveMeans),
      batteryPowerW: state.victron?.batteryPowerW,
    });
  }
  let lastEosPid = null;

  // Gespeicherte Day-Ahead-Historie (price_ct_kwh) für die Preis-Schätzung.
  // Einmal je Stunde aus der Datenbank; die echten Preise von heute/morgen
  // kommen bei jedem Push frisch aus der Prognose dazu.
  let priceHistoryCache = null;
  /**
   * Gespeicherte echte Day-Ahead-Preise (price_ct_kwh) von drei Stunden vor
   * jetzt bis drei Tage voraus als Preis-Slots `{start, end, ctKwh}` —
   * Rückfall, wenn der Speicher nach einem Neustart leer ist. Die Slotlänge
   * kommt aus dem tatsächlichen Abstand der Zeilen (kleinster Abstand, wie
   * realPriceCoverage), nicht aus dem Stempel: Stundenpreise bleiben
   * stündlich, und ein Abruf mit Lücke ist oft insgesamt falsch gestempelt
   * (Gegenprüfung 5ba95a7b). Eine echte Mischung zeigt sich als Lücke.
   */
  async function loadStoredRealPriceSlots(nowMs) {
    const store = ctx.telemetryStore;
    if (!store || typeof store.querySeries !== 'function') return [];
    const fromMs = nowMs - 3 * 3_600_000;
    let timer = null;
    try {
      const timeoutMs = Number(ctx.storedPricesTimeoutMs) > 0 ? Number(ctx.storedPricesTimeoutMs) : STORED_PRICES_TIMEOUT_MS;
      const rows = await Promise.race([
        store.querySeries({
          seriesKeys: ['price_ct_kwh'],
          start: new Date(fromMs).toISOString(),
          end: new Date(nowMs + 3 * 86_400_000).toISOString(),
          // Nicht nach dem Stempel filtern: ein Abruf mit Lücke im ersten
          // Zeilenpaar ist insgesamt grob gestempelt (Gegenprüfung fac22151).
          maxResolution: 86_400,
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Datenbank antwortet nicht innerhalb von ${timeoutMs} ms`)), timeoutMs);
          timer.unref?.();
        }),
      ]);
      const byStart = new Map();
      for (const r of rows || []) {
        if (r.key !== 'price_ct_kwh') continue;
        const ms = new Date(r.ts).getTime();
        const ct = Number(r.value);
        if (!Number.isFinite(ms) || !Number.isFinite(ct) || ms < fromMs || byStart.has(ms)) continue;
        byStart.set(ms, ct);
      }
      const starts = [...byStart.keys()].sort((a, b) => a - b);
      let stepMs = Infinity;
      for (let i = 1; i < starts.length; i += 1) stepMs = Math.min(stepMs, starts[i] - starts[i - 1]);
      if (!Number.isFinite(stepMs) || stepMs <= 0) stepMs = PRICE_SLOT_MS;
      return starts.map((ms) => ({
        start: new Date(ms).toISOString(),
        end: new Date(ms + stepMs).toISOString(),
        ctKwh: byStart.get(ms),
      }));
    } catch (e) {
      if (pushLog) pushLog('eos_prices_from_store_error', { error: e?.message || String(e) });
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  async function loadPriceHistory(nowMs) {
    if (priceHistoryCache && nowMs - priceHistoryCache.at < 3_600_000) return priceHistoryCache.points;
    const store = ctx.telemetryStore;
    if (!store || typeof store.querySeries !== 'function') return [];
    const points = [];
    try {
      const rows = await store.querySeries({
        // Wie routes-api (EEG-Verlängerung): der Live-Abruf schreibt
        // price_ct_kwh, spot_price_ct_kwh ist nur der Katalogname.
        seriesKeys: ['price_ct_kwh', 'spot_price_ct_kwh'],
        start: new Date(nowMs - (HISTORY_DAYS + 1) * 86_400_000).toISOString(),
        end: new Date(nowMs + 3 * 86_400_000).toISOString(),
        maxResolution: 3600,
      });
      const live = (rows || []).filter((r) => r.key === 'price_ct_kwh');
      for (const r of live.length ? live : (rows || [])) {
        const ms = new Date(r.ts).getTime();
        const ct = Number(r.value);
        if (!Number.isFinite(ms) || !Number.isFinite(ct)) continue;
        // Stundenwerte gelten für alle vier Viertelstunden.
        const quarters = Number(r.resolution) >= 3600 ? 4 : 1;
        for (let k = 0; k < quarters; k += 1) points.push({ ms: ms + k * PRICE_SLOT_MS, ct });
      }
    } catch (e) {
      if (pushLog) pushLog('eos_price_estimate_error', { error: e?.message || String(e) });
      // Fehler nicht zwischenspeichern: sonst bekäme EOS eine Stunde lang keinen
      // geschätzten Schwanz (Gesamtprüfung Release 1.0.9, Befund 15).
      return [];
    }
    // Eine leere Antwort ebenso wenig — beim nächsten Push neu fragen.
    if (points.length) priceHistoryCache = { at: nowMs, points };
    return points;
  }

  /**
   * Preisreihe für EOS: echte Preise, dahinter bis zum Ende der PV-/Last-
   * Prognose geschätzte Börsenpreise (price-estimate.js). Bezugs- und
   * Einspeisepreis werden daraus wie für echte Slots gebildet.
   */
  const PRICE_KEYS = ['elecprice_marketprice_wh', 'feed_in_tariff_wh'];

  /**
   * Alles hinter dem jetzt Geschickten in EOS löschen (sentEndMs = Ende der
   * Schätzung, ohne Schätzung das Ende der echten Preise) — bei jedem Push.
   * EOS speichert Importe nur dazu (upsert) und löscht nie; so liegen dort nie
   * ältere Schätzwerte als die gerade geschickten, auch nicht nach einem
   * Preisausfall, einem DVhub-Neustart oder aus einem anderen Prozess
   * (Gegenprüfungen 8c050aae … ec268f9f; eine Buchführung über Prozesse und
   * Neustarts hinweg fand immer neue Lücken). Der Bereich liegt immer hinter
   * dem Steuerzeitraum; ein Fehler macht den Push „nicht ok“ (Wiederholung),
   * sperrt aber keinen Lauf (prepareRun). Ohne echte Preise — weder im
   * Speicher noch in der Datenbank — wird nichts gelöscht; EOS hält evtl.
   * noch echte.
   */
  async function clearStaleEstimates(baseUrl, { sentEndMs, nowMs, gone = () => false }) {
    const start = sentEndMs;
    const end = nowMs + PRICE_FILL_MAX_MS + 3_600_000;
    if (!Number.isFinite(start) || !(end > start)) return { cleared: false, errors: [] };
    const q = (ms) => encodeURIComponent(new Date(ms).toISOString());
    const errors = [];
    for (const key of PRICE_KEYS) {
      // Aufgegebener Push (Wache): nichts mehr löschen — sonst träfe das alte
      // Löschfenster die Preise, die ein neuerer Push gerade importiert hat
      // (Gegenprüfung Release 1.0.9, P2).
      if (gone()) return { cleared: false, errors, abandoned: true };
      const res = await eosHttpRequest(baseUrl, 'DELETE', `/v1/prediction/range?key=${key}&start_datetime=${q(start)}&end_datetime=${q(end)}`);
      // 404 = Schlüssel in EOS (noch) unbekannt, dann gibt es nichts zu löschen.
      if (!res.ok && !/HTTP 404/.test(String(res.error))) errors.push(`${key}: ${res.error}`);
    }
    if (errors.length && pushLog) pushLog('eos_price_estimate_clear_error', { from: new Date(start).toISOString(), until: new Date(end).toISOString(), errors });
    return { cleared: errors.length === 0, errors };
  }

  // Stößt DVhub die Läufe nicht an — EOS rechnet nach eigenem Takt
  // (optimizer.eosStartAfterPreviousRun) oder ist (noch) nicht als 0.4
  // erkannt —, gibt es keinen Laufstart, vor dem prepareRun pushen könnte, und
  // ohne Erkennung auch keinen Steuerzeitraum: dann kein Schwanz
  // (Gegenprüfungen 16856110, 2ed313de); alte löscht clearStaleEstimates.
  //
  // Schwanz = P50 der Residuallast-Prognose (price-outlook.js, 1.0.11). Ohne
  // gültige Prognose (andere Preiszone, „Öffentlich“ als Preisquelle, Abruf
  // gescheitert und die gespeicherte älter als 48 h) gibt es KEINEN Schwanz:
  // EOS plant dann nur über die echten Preise wie vor dem 01.11.2026 — der
  // Steuerzeitraum bleibt dabei unverändert (er hängt nur an den echten
  // Preisen, siehe push), EOS kürzt nur seinen Schwanz.
  // Rückgabe: slots, estimate (null = kein Schwanz) und tail (Zustand für
  // Oberfläche/Log: status, reason, Zeiten der Prognose).
  async function priceSlotsForEos(realSlots, pvSlots, loadSlots, nowMs, { estimate = true, maxMs = PRICE_FILL_MAX_MS, gone = () => false } = {}) {
    const svc = ctx.priceOutlook;
    let cur = null;
    if (svc && typeof svc.current === 'function') {
      try { await svc.ensureFresh?.(); } catch { /* current() meldet den Zustand */ }
      if (gone()) return { slots: realSlots, estimate: null, tail: null };
      try { cur = svc.current(Date.now()); } catch { cur = null; }
    }
    const outlookInfo = cur ? {
      status: cur.status,
      reason: cur.reason ?? null,
      issuedAt: cur.issuedAt ?? null,
      fetchedAt: cur.fetchedAt ?? null,
      unavailableSince: cur.unavailableSince ?? null,
    } : { status: 'unavailable', reason: 'no_service', issuedAt: null, fetchedAt: null, unavailableSince: null };
    const none = (why) => ({ slots: realSlots, estimate: null, tail: { ...outlookInfo, used: false, why } });
    if (!estimate) return none('eos_not_triggered');
    const untilMs = priceFillUntilMs(pvSlots, loadSlots, nowMs, maxMs);
    if (!cur?.outlook) return none(outlookInfo.reason || 'no_outlook');
    const res = fillPriceSlotsFromOutlook(realSlots, { outlook: cur.outlook, untilMs, nowMs });
    if (!res.estimate) return none(res.reason);
    return { slots: res.slots, estimate: res.estimate, tail: { ...outlookInfo, used: true, why: null } };
  }

  /**
   * Read the EOS process pid from /v1/health. The pid changes on every EOS
   * (re)start, so comparing it across polls is a reliable restart signal.
   * Returns null on any error (EOS unreachable / mid-restart) — the caller
   * treats null as "no decision, retry next poll".
   *
   * @param {string} baseUrl
   * @returns {Promise<number|null>}
   */
  async function readEosPid(baseUrl) {
    const res = await eosHttpRequest(baseUrl, 'GET', '/v1/health');
    const pid = res.ok && res.data ? Number(res.data.pid) : NaN;
    return Number.isFinite(pid) ? pid : null;
  }

  /**
   * Resolve the weighted "anzulegender Wert" (AW) in ct/kWh for the configured
   * PV plants. Prefers the explicit operator override; otherwise auto-computes
   * from BNetzA applicable values + pvPlants (same source the Historie page
   * uses, so the dispatch signal and the revenue KPI agree). Never throws —
   * returns null when AW can't be resolved (→ premium disabled, raw spot).
   *
   * @param {object} cfg
   * @returns {Promise<number|null>}
   */
  async function resolveApplicableValueCtKwh(cfg) {
    const uep = cfg?.userEnergyPricing || {};
    const override = Number(uep.applicableValueOverrideCtKwh);
    if (Number.isFinite(override) && override > 0) return override; // fast path, no async
    if (typeof getApplicableValueSummary !== 'function') return null;
    const pvPlants = Array.isArray(uep.pvPlants) ? uep.pvPlants : [];
    let summary;
    try {
      summary = await getApplicableValueSummary({ year: new Date().getUTCFullYear(), pvPlants });
    } catch {
      return null;
    }
    const r = summarizeWeightedApplicableValue({
      pvPlants,
      applicableValueSummary: summary,
      applicableValueOverrideCtKwh: uep.applicableValueOverrideCtKwh,
    });
    const aw = Number(r?.weightedApplicableValueCtKwh);
    return Number.isFinite(aw) ? aw : null;
  }

  /**
   * Resolve the *fixed* prior-year annual Solar market value (Jahresmarktwert)
   * in ct/kWh. Per operator directive (2026-06-21) the previous year's official
   * value is final and used as a constant — no rolling re-derivation. Never
   * throws — returns null when unavailable (→ premium disabled, raw spot).
   *
   * @returns {Promise<number|null>}
   */
  async function resolveAnnualMarketValueCtKwh() {
    if (typeof getSolarMarketValueSummary !== 'function') return null;
    const lastYear = new Date().getUTCFullYear() - 1;
    let summary;
    try {
      summary = await getSolarMarketValueSummary({ year: lastYear });
    } catch {
      return null;
    }
    const mw = Number(summary?.annualCtKwhByYear?.[lastYear]);
    return Number.isFinite(mw) ? mw : null;
  }

  /**
   * Market premium (ct/kWh) to add onto the spot export signal for EOS, so the
   * genetic optimizer values feed-in at the real EEG-Direktvermarktung margin
   * (spot + Marktprämie) instead of raw spot. Premium = max(0, AW − MW). Gated
   * behind optimizer.tariff.feedInIncludeMarketPremium (default OFF). Returns 0
   * when the gate is off or inputs are missing → push falls back to raw spot
   * (byte-identical to the pre-feature behaviour). Never throws.
   *
   * §51 (negative-price windows) is handled at the slot level by the caller:
   * the premium is only added to non-negative spot slots.
   *
   * @param {object} cfg
   * @returns {Promise<number>}
   */
  async function resolveFeedInMarketPremiumCtKwh(cfg) {
    const tariff = cfg?.optimizer?.tariff || {};
    if (tariff.feedInIncludeMarketPremium !== true) return 0;
    const [aw, mw] = await Promise.all([
      resolveApplicableValueCtKwh(cfg),
      resolveAnnualMarketValueCtKwh(),
    ]);
    if (!Number.isFinite(aw) || !Number.isFinite(mw)) {
      if (pushLog) pushLog('eos_feedin_premium_skip', { reason: 'AW or MW unavailable', aw, mw });
      return 0;
    }
    return Math.max(0, aw - mw);
  }

  /**
   * Push the current battery (and, when available, EV) State-of-Charge into
   * EOS' own measurement series. The genetic optimizer seeds its run with the
   * latest `*-soc-factor` measurement at ems.start_datetime
   * (geneticparams.py:440 / :511); without it the start SoC defaults to 0 and
   * any plan EOS produces is wrong (it "thinks" the battery is empty). DVhub
   * already records SoC every poll as telemetry `battery_soc_pct` — this just
   * forwards the live value to EOS.
   *
   * EOS measurement keys are device-derived (`battery1-soc-factor`,
   * `ev11-soc-factor`). We discover them from /v1/measurement/keys instead of
   * hard-coding device ids, so a device rename can't silently break the push.
   *
   * Value is the SoC *factor* (0..1) = percent / 100. Never throws.
   *
   * @param {string} baseUrl
   * @returns {Promise<{pushed: string[], errors: object, skipped?: string}>}
   */
  async function pushSoc(baseUrl, { freshOnly = false, gone = () => false } = {}) {
    const pushed = [];
    const errors = {};

    const socPct = Number(planningSocPct(ctx));
    if (!Number.isFinite(socPct)) {
      return { pushed, errors, skipped: 'no live battery soc in state' };
    }
    const battFactor = Math.max(0, Math.min(1, socPct / 100));

    // EV-SoC aus TeslaMate / evcc (ev-soc.js). Fehlt er, wird der EV-Kanal
    // uebersprungen. EOS 0.4 wuerde den Lauf sonst abbrechen — deshalb meldet
    // eos-config-sync das Fahrzeug gar nicht erst an, solange es keinen SoC gibt.
    const evSoc = evSocForEos(ctx);
    const evLegacyPct = Number(state?.victron?.evSocPct);
    const evPct = evSoc ? evSoc.pct : evLegacyPct;
    // Abgerundet auf ganze Prozent wie im Lauf-Aufruf (socForRun).
    const evFactor = Number.isFinite(evPct) ? Math.max(0, Math.min(1, Math.floor(evPct + 1e-9) / 100)) : null;

    const keysRes = await eosHttpRequest(baseUrl, 'GET', '/v1/measurement/keys');
    if (!keysRes.ok || !Array.isArray(keysRes.data)) {
      errors.soc = `could not read measurement keys: ${keysRes.error || 'unexpected shape'}`;
      return { pushed, errors };
    }
    const socKeys = keysRes.data.filter((k) => /-soc-factor$/.test(String(k)));
    // Ein Zeitstempel „jetzt“: EOS 0.4 prueft die FRISCHE. configrequest.py:108-115 nimmt
    //      den juengsten Messwert <= observation_datetime (der echten Uhrzeit)
    //      und bricht den Lauf ab, wenn er aelter ist als
    //      optimization.genetic.measurement_max_age_seconds (Vorgabe 300 s).
    //      Am 2026-09-20 auf einer frischen v0.4.0rc1-Instanz nachgemessen:
    //      nur der Stundenstempel -> HTTP 503 "Fresh SoC missing for battery1";
    //      zusaetzlich "jetzt" -> HTTP 200 mit vollstaendiger Loesung.
    // Der fruehere zweite Stempel zur vollen Stunde war nur fuer EOS 0.3 und
    // kostete einen zusaetzlichen Komplett-Schreibvorgang von measurement.json.
    const freshIso = new Date().toISOString();
    const socStamps = [freshIso];

    // Stößt DVhub die Läufe an, reist der Ladestand im Aufruf mit (socForRun)
    // und wird nicht als Messwert geschrieben.
    for (const key of (dvhubTriggersEosRuns(getCfg()) ? [] : socKeys)) {
      const isEv = /(^|[^a-z])ev\d*-soc-factor$/.test(key);
      const value = isEv ? evFactor : battFactor;
      if (value === null) continue; // EV with no live value — skip cleanly
      // value rides as a query param (verified accepted by EOS 0.3.0 und
      // 0.4.0rc1); the endpoint takes datetime/key/value all on the query
      // string, no body.
      let anyOk = false;
      let lastErr = null;
      for (const stamp of socStamps) {
        const path =
          `/v1/measurement/value?datetime=${encodeURIComponent(stamp)}` +
          `&key=${encodeURIComponent(key)}&value=${value}`;
        if (gone()) return { pushed, errors, abandoned: true };
        const res = await eosHttpRequest(baseUrl, 'PUT', path);
        if (res.ok) anyOk = true;
        else lastErr = res.error;
      }
      // Ein Fehlschlag bei EINEM der beiden Stempel ist kein Ausfall: solange
      // einer sitzt, hat die jeweils laufende EOS-Generation ihren Wert.
      if (anyOk) pushed.push(`${key}=${value}`);
      else errors[key] = lastErr;
    }

    // Planbare Geräte (EOS 0.4): heute abgeschlossene Läufe als Messwert. EOS
    // liest den jüngsten Wert seit Tagesbeginn und bricht den GANZEN Lauf ab,
    // wenn dort nur Lücken stehen („Invalid completed cycle count“). Zähler aus
    // der Geräte-Bridge; DVhub sendet keine num_cycles (EOS-Vorgabe 1) → 0..1.
    const cycleKeys = keysRes.data.filter((k) => /\.cycles_completed$/.test(String(k)));
    const cyclesToday = state?.optimizer?.applianceCyclesToday || {};
    for (const key of cycleKeys) {
      const eosId = String(key).slice(0, -'.cycles_completed'.length);
      const n = Math.min(1, Math.max(0, Math.trunc(Number(cyclesToday[eosId]) || 0)));
      const path = `/v1/measurement/value?datetime=${encodeURIComponent(freshIso)}`
        + `&key=${encodeURIComponent(key)}&value=${n}`;
      if (gone()) return { pushed, errors, abandoned: true };
      const res = await eosHttpRequest(baseUrl, 'PUT', path);
      if (res.ok) pushed.push(`${key}=${n}`);
      else errors[key] = res.error;
    }

    return { pushed, errors };
  }

  /**
   * Nur den SoC schicken (Akku + Auto), mit Zeitstempel "jetzt". Fuer EOS ab
   * 0.4: ein Lauf nimmt den SoC nur aus den letzten measurement_max_age_seconds
   * (300 s, configrequest.py) und bricht sonst ab — der Prognose-Push alle
   * 15 min reicht dafuer nicht. server.js ruft das minuetlich.
   */
  async function pushFreshSoc() {
    const cfg = getCfg();
    if (!cfg?.optimizer?.eosProxy?.enabled) return { skipped: 'eosProxy.enabled=false' };
    if (dvhubTriggersEosRuns(cfg)) return { skipped: 'soc travels with the run request' };
    // Erst wenn der Abgleich ein EOS 0.4 erkannt hat (state.optimizer.eos).
    if (state?.optimizer?.eos?.supported !== true) return { skipped: 'eos not supported' };
    const baseUrl = resolveEosProxy(cfg).url;
    return pushSoc(baseUrl, { freshOnly: true });
  }

  /**
   * Ladestände für einen angestoßenen Lauf (POST /v1/optimize, Feld `soc`):
   * ganze Prozent je EOS-Gerät. Die Geräte kommen aus EOS selbst
   * (`<device_id>-soc-factor` in /v1/measurement/keys) — ein Ladestand für ein
   * dort nicht angemeldetes Gerät ließe den Lauf scheitern. Ein Auto ohne
   * Ladestand fehlt in der Antwort (eos-config-sync meldet es dann ohnehin ab).
   * @returns {Promise<{soc?: Record<string, number>, skipped?: string, error?: string}>}
   */
  async function socForRun() {
    const cfg = getCfg();
    const baseUrl = resolveEosProxy(cfg).url;
    const socPct = Number(planningSocPct(ctx));
    if (!Number.isFinite(socPct)) return { skipped: 'no live battery soc in state' };
    const evSoc = evSocForEos(ctx);
    const evLegacyPct = Number(state?.victron?.evSocPct);
    const evPct = evSoc ? evSoc.pct : evLegacyPct;
    const keysRes = await eosHttpRequest(baseUrl, 'GET', '/v1/measurement/keys');
    if (!keysRes.ok || !Array.isArray(keysRes.data)) {
      return { error: `could not read measurement keys: ${keysRes.error || 'unexpected shape'}` };
    }
    const whole = (pct) => Math.max(0, Math.min(100, Math.round(pct)));
    // Auto: abrunden, nie aufrunden — sonst plant EOS mit einem halben Prozent
    // mehr, als drin ist, und verfehlt ein Mindestziel knapp (Simulation
    // ev-minmax: 21 von 269 Abfahrten 0,1–0,5 Punkte darunter).
    const wholeDown = (pct) => Math.max(0, Math.min(100, Math.floor(pct + 1e-9)));
    const soc = {};
    for (const key of keysRes.data.map(String).filter((k) => SOC_KEY_RE.test(k))) {
      const deviceId = key.slice(0, -'-soc-factor'.length);
      if (EV_SOC_KEY_RE.test(key)) {
        if (Number.isFinite(evPct)) soc[deviceId] = wholeDown(evPct);
      } else {
        soc[deviceId] = whole(socPct);
      }
    }
    if (!Object.keys(soc).length) return { skipped: 'no battery registered in EOS' };
    return { soc };
  }

  // Grundlage nur bei einem Wechsel neu stempeln (`since`): Ein Plan, der vor
  // dem Wechsel gerechnet ist, zeigt dann die vorige (Gegenprüfung d22f5a4d).
  // Der erste Push nach dem Start gilt erst ab Start der Bridge — ob ein Plan
  // von vorher mit derselben Einstellung gerechnet ist, weiß DVhub nicht
  // (Gegenprüfung 18f41bac).
  const bridgeStartedAt = Date.now();
  function rememberFeedInBasis(next) {
    if (!state) return;
    state.optimizer = state.optimizer || {};
    const cur = state.optimizer.eosFeedInBasis;
    if (!cur) { state.optimizer.eosFeedInBasis = { ...next, since: bridgeStartedAt }; return; }
    if (cur.feedIn === next.feedIn && cur.fixedCtKwh === next.fixedCtKwh) return;
    state.optimizer.eosFeedInBasisPrev = cur;
    state.optimizer.eosFeedInBasis = { ...next, since: Date.now() };
  }

  let lastHorizonHours = null;
  let lastPredictionHours = null;
  let loggedHorizonHours = null;
  let loggedPredictionHours = null;
  /**
   * Steuerzeitraum = volle Stunden, die ab jetzt lueckenlos mit Preisen belegt
   * sind, minus 15 min Puffer (EOS rechnet auf eigenem 15-min-Takt; der
   * naechste Lauf vor dem naechsten Push muss noch abgedeckt sein), 1 h bis
   * zur Grenze aus resolveControlHorizonMaxHours (Standard: ganzer bekannter
   * Preiszeitraum). Dazu der EOS-Prognosehorizont (prediction.hours,
   * resolveEosPredictionHours) — er muss den Steuerzeitraum immer abdecken.
   * Nur wenn der Abgleich ein EOS 0.4 erkannt hat.
   */
  // Steuerzeitraum dieses Pushs (decideControlHorizon) an EOS: decision.hours,
  // null = keine Reihe deckt jetzt ab.
  async function syncControlHorizon(baseUrl, decision, { gone = () => false } = {}) {
    if (state?.optimizer?.eos?.supported !== true) return { skipped: 'eos not supported' };
    const cfg = getCfg();
    const predictionHours = resolveEosPredictionHours(cfg);
    const hours = decision?.hours ?? null;
    if (hours === null) return { skipped: 'no prices' };
    // Immer senden (kostet nichts): nach einem EOS-Neustart kennt EOS die
    // zuletzt gesetzten Werte evtl. nicht mehr. Protokolliert wird nur ein Wechsel.
    // Reihenfolge: Wird der Prognosehorizont kürzer, erst den Steuerzeitraum
    // senken — sonst stünde kurz prediction.hours < horizon_hours, und ein Lauf
    // genau dann bräche ab. Sonst erst den Prognosehorizont.
    // Vorwerte fürs Log getrennt führen: lastHorizonHours/lastPredictionHours
    // ändern sich je angenommenem PUT (Gegenprüfung a25589cc).
    const previous = { hours: loggedHorizonHours, predictionHours: loggedPredictionHours };
    // Jeden angenommenen Wert sofort festhalten: scheitert danach der andere
    // PUT, muss DVhub trotzdem wissen, mit welchem Steuerzeitraum EOS rechnet
    // (Warmstart im Lauf-Anstoß, Gegenprüfung ae4e76f6).
    // Nach jeder Antwort: Ist der Push inzwischen aufgegeben, trägt er nichts
    // mehr ein — sonst überschriebe eine verspätete Antwort den Stand des
    // neueren Pushs (Gegenprüfung aa0d76e9, P3).
    const putHorizon = async () => {
      const res = await eosHttpRequest(baseUrl, 'PUT', '/v1/config/optimization/genetic/horizon_hours', hours);
      if (gone()) return { ok: false, abandoned: true };
      if (res.ok) {
        lastHorizonHours = hours;
        if (state?.optimizer) {
          state.optimizer.eosControlHorizonH = hours;
          // Wie der Steuerzeitraum zustande kam — für Leitstand, Lauf-Protokoll
          // und die Regel-Umsetzung (eos-adapter): Modus, Grund, Frist, ab wann
          // geschätzte Preise darin liegen (null = nur echte).
          state.optimizer.eosControl = {
            hours,
            realHours: decision.realHours ?? null,
            mode: decision.mode || 'full',
            reason: decision.reason || null,
            deadline: decision.deadline || null,
            estimatedFrom: decision.estimatedFrom || null,
            deadlineCovered: decision.deadlineCovered ?? null,
            at: Date.now(),
          };
        }
      }
      return res;
    };
    const putPrediction = async () => {
      const res = await eosHttpRequest(baseUrl, 'PUT', '/v1/config/prediction/hours', predictionHours);
      if (gone()) return { ok: false, abandoned: true };
      if (res.ok) {
        lastPredictionHours = predictionHours;
        if (state?.optimizer) state.optimizer.eosPredictionHours = predictionHours;
      }
      return res;
    };
    // Stand in EOS unbekannt (nach einem DVhub-Neustart oder einem
    // gescheiterten PUT): Weder „erst Steuerzeitraum“ noch „erst Prognose“ ist
    // dann sicher — der Steuerzeitraum kann über dem alten Prognosehorizont
    // liegen und umgekehrt (Gesamtprüfung Release 1.0.9: nach dem Neustart galt
    // der Stand als „kürzer werdend“, auch wenn er wuchs). Darum erst den
    // Prognosehorizont auf das Höchste (72 h, deckt jeden Steuerzeitraum bis
    // 48 h), dann den Steuerzeitraum, dann den Zielwert.
    // Weit = mindestens 72 h (deckt jeden Steuerzeitraum bis 48 h), bei einem
    // längeren gewählten Prognosehorizont dieser.
    const wideHours = Math.max(EOS_PREDICTION_HOURS_MAX, predictionHours);
    const widen = async () => {
      const res = await eosHttpRequest(baseUrl, 'PUT', '/v1/config/prediction/hours', wideHours);
      if (gone()) return { ok: false, abandoned: true };
      if (res.ok) {
        lastPredictionHours = wideHours;
        if (state?.optimizer) state.optimizer.eosPredictionHours = wideHours;
      }
      return res;
    };
    let order;
    if (lastPredictionHours === null) {
      order = predictionHours < wideHours ? [widen, putHorizon, putPrediction] : [putPrediction, putHorizon];
    } else {
      order = predictionHours < lastPredictionHours ? [putHorizon, putPrediction] : [putPrediction, putHorizon];
    }
    const logChange = () => {
      const h = lastHorizonHours;
      const p = lastPredictionHours;
      if (pushLog && h !== null && (h !== previous.hours || (p !== null && p !== previous.predictionHours))) {
        pushLog('eos_control_horizon', {
          hours: h, previous: previous.hours, predictionHours: p,
          mode: decision.mode || 'full', reason: decision.reason || null,
          ...(decision.deadline ? { deadline: decision.deadline } : {}),
          ...(decision.estimatedFrom ? { estimatedFrom: decision.estimatedFrom } : {}),
        });
      }
      if (h !== null) loggedHorizonHours = h;
      if (p !== null) loggedPredictionHours = p;
    };
    for (const put of order) {
      if (gone()) return { abandoned: true };
      const res = await put();
      if (res.abandoned) return { abandoned: true };
      if (!res.ok) {
        // Unbekannter Stand: beim nächsten Push wieder vorsichtig (erst weit).
        lastPredictionHours = null;
        // Ein angenommener Steuerzeitraum-Wechsel gehört trotzdem ins Log.
        logChange();
        return { error: res.error };
      }
    }
    logChange();
    await syncTailHours(baseUrl, cfg, { gone });
    return { hours, predictionHours };
  }

  // Schwanz bei EOS anfordern (resolveEosTailHours). Bei einem Prognose-
  // horizont über 72 h bei jedem Push (wie der Steuerzeitraum: nach einem
  // EOS-Neustart kennt EOS ihn evtl. nicht mehr). Sonst einmal je DVhub-Start
  // der EOS-Standard 48 h — falls EOS von früher noch einen längeren hält; ein
  // EOS ohne diesen Schlüssel (älter) wird dann nicht weiter gefragt. Ein Fehler
  // wird nur protokolliert: EOS rechnet mit seinem Standard-Schwanz, der Lauf geht.
  let lastTailHours = null; // zuletzt gesendeter Wert (null = noch nie)
  let loggedTailError = null;
  async function syncTailHours(baseUrl, cfg, { gone = () => false } = {}) {
    const want = resolveEosTailHours(cfg);
    const value = want ?? EOS_DEFAULT_TAIL_HOURS;
    if (want === null && lastTailHours === EOS_DEFAULT_TAIL_HOURS) return;
    if (gone()) return;
    const res = await eosHttpRequest(baseUrl, 'PUT', '/v1/config/optimization/genetic/tail_horizon_hours', value);
    if (gone()) return;
    if (res.ok) {
      if (lastTailHours !== value && pushLog) pushLog('eos_tail_horizon', { hours: value, previous: lastTailHours });
      lastTailHours = value;
      loggedTailError = null;
      if (state?.optimizer) state.optimizer.eosTailHours = value;
    } else {
      // Standardwert nicht nochmal versuchen (älteres EOS); einen längeren beim nächsten Push.
      if (want === null) lastTailHours = EOS_DEFAULT_TAIL_HOURS;
      if (res.error !== loggedTailError) {
        loggedTailError = res.error;
        if (pushLog) pushLog('eos_tail_horizon_error', { hours: value, error: res.error });
      }
    }
  }

  /**
   * One push cycle: build the 3 payloads, PUT each. Sequential so that EOS'
   * disk-flush after each PUT doesn't race; the 15s timeout per call gives
   * plenty of headroom.
   */
  // Ergebnis jedes Pushs fuer den Prognose-Inspektor (Review 25.10.2026): die
  // Bridge ist einziger Schreiber der EOS-Prognosen, ihr Ergebnis ist das der
  // „letzten echten Uebertragung“.
  function recordPush(res) {
    if (!state) return res;
    state.optimizer = state.optimizer || {};
    const errors = res?.errors && typeof res.errors === 'object' ? res.errors : {};
    const errorText = Object.entries(errors).map(([key, value]) => `${key}: ${value}`).join('; ');
    state.optimizer.lastEosPush = {
      ok: res?.ok === true && !errors.horizon,
      error: errorText || null,
      at: Date.now(),
      // Geschätzte Preise hinter den echten (null = keine): Anzahl Slots,
      // erster geschätzter Slot, Ende, Verfahren — für eine spätere Anzeige.
      priceEstimate: res?.priceEstimate || null,
    };
    return res;
  }

  // Pushes laufen nacheinander (Takt, neue Day-Ahead-Preise, Konfiguration,
  // Laufstart): sonst könnte ein älterer Stand nach einem neueren dessen echte
  // Preise in EOS wieder löschen (Codex-Gegenprüfung f442800b).
  //
  // Wache je Schritt (Gegenprüfung a6dbbd1d): Datenbankabfragen haben kein
  // Zeitlimit. Hinge ein Push, warteten alle folgenden — und mit prepareRun
  // auch jeder EOS-Lauf. Nach der Frist gilt der Push als gescheitert, die
  // Kette geht weiter; der aufgegebene Push schreibt danach nichts mehr an EOS
  // (Prüfung vor jedem Schreiben), damit er keinen neueren Stand überschreibt.
  let pushChain = Promise.resolve();
  function push() {
    const job = { abandoned: false };
    const step = () => guardedPush(job);
    const run = pushChain.then(step, step);
    pushChain = run.catch(() => {});
    return run;
  }

  function guardedPush(job) {
    const timeoutMs = Number(ctx.pushTimeoutMs) > 0 ? Number(ctx.pushTimeoutMs) : PUSH_TIMEOUT_MS;
    let timer = null;
    const watchdog = new Promise((resolve) => {
      timer = setTimeout(() => {
        job.abandoned = true;
        const err = `push did not finish within ${timeoutMs} ms — abandoned`;
        if (pushLog) pushLog('eos_forecast_bridge_error', { reason: err });
        resolve(recordPush({ ok: false, pushed: [], errors: { timeout: err } }));
      }, timeoutMs);
      timer.unref?.();
    });
    return Promise.race([pushOnce(job), watchdog]).finally(() => clearTimeout(timer));
  }

  /**
   * Vor jedem EOS-Lauf (eos-run-trigger.js): frisch pushen, im Prozess, der den
   * Lauf anstößt. Schätzpreise dürfen nie im Steuerzeitraum liegen; beim Push
   * gilt das (Schätzung nur hinter echten Preisen, die jetzt + 1 h 15 min
   * decken; Steuerzeitraum aus den echten Preisen minus 15 min Puffer — also
   * auch für einen Lauf, der erst im nächsten Slot beginnt). Ein Lauf an der
   * Grenze oder per kick käme sonst mit dem Stand eines älteren Pushs.
   * Der Lauf geht nur, wenn dieser Push echte Preise hatte, der Preis-Import
   * ankam und der Steuerzeitraum gesetzt ist; sonst könnten ältere Werte im
   * Steuerzeitraum liegen — vor der Schätzung brach EOS dann ohnehin ab
   * („Missing or invalid prices“). Ein gescheitertes Löschen hinter dem
   * Geschickten sperrt nicht (liegt hinter dem Steuerzeitraum).
   * Ein laufender Push wird abgewartet (Kette); die Wache begrenzt das.
   *
   * @returns {Promise<{ok:boolean, pushed:boolean, error?:string}>}
   */
  async function prepareRun() {
    const res = await push();
    if (res?.skipped) return { ok: true, pushed: false };
    if (res?.runReady === true) {
      await syncEvBeforeRun();
      return { ok: true, pushed: true };
    }
    const why = res?.runBlockedBy
      || (res?.errors && typeof res.errors === 'object' ? Object.entries(res.errors).map(([k, v]) => `${k}: ${v}`).join('; ') : '')
      || 'Push gescheitert';
    return { ok: false, pushed: true, error: `Lauf ohne sichere Preisgrundlage: ${why}` };
  }

  // Wertstufen des Autos (soc_value_steps, ev-targets.js) frisch zum Lauf
  // (Restbefund Codex P2, 1.0.10): Sie hängen an der Wertgrundlage
  // (state.optimizer.evValueInputs), die erst der Push eben gebaut hat. Ohne
  // diesen Schritt rechnete der Lauf mit den Stufen des letzten
  // Fahrzeug-Abgleichs — nach dem Start ohne Grundlage, also leer; die
  // Minuten-Wache (ev-watch.js) schickte die neuen erst nach dem Laufstart.
  // Reihenfolge: Push → Fahrzeug an EOS → Lauf. Scheitert der Abgleich, läuft
  // der Lauf trotzdem (der Akku-Plan soll nicht am Auto hängen). Zeit: ein
  // PUT (≤ 15 s) plus Ladestand (≤ 15 s) liegt in RUN_START_MARGIN_MS.
  async function syncEvBeforeRun() {
    if (getCfg()?.optimizer?.eosOptimizeEv !== true) return;
    const syncEv = ctx.eosConfigSync?.syncEv;
    if (typeof syncEv !== 'function') return;
    try {
      const r = await syncEv.call(ctx.eosConfigSync);
      if (r?.ok === false && !r.skipped && pushLog) pushLog('eos_ev_sync_before_run_error', { error: r.error || null });
    } catch (e) {
      if (pushLog) pushLog('eos_ev_sync_before_run_error', { error: e?.message || String(e) });
    }
  }

  async function pushOnce(job = null) {
    // Von der Wache aufgegeben: nichts mehr an EOS schreiben, nichts eintragen.
    const gone = () => job?.abandoned === true;
    const abandoned = () => ({ ok: false, pushed: [], errors: { timeout: 'abandoned' } });
    const cfg = getCfg();
    const baseUrl = resolveEosProxy(cfg).url;

    if (cfg?.optimizer?.eosProxy?.enabled === false) {
      return { ok: true, pushed: [], errors: {}, skipped: 'eosProxy.enabled=false' };
    }

    if (!forecastService?.buildForecastResponse) {
      const err = 'forecastService.buildForecastResponse unavailable — bridge inactive';
      if (pushLog) pushLog('eos_forecast_bridge_skip', { reason: err });
      return recordPush({ ok: false, pushed: [], errors: { bootstrap: err } });
    }

    let forecast;
    try {
      forecast = await forecastService.buildForecastResponse();
    } catch (e) {
      if (gone()) return abandoned();
      const err = `forecastService.buildForecastResponse failed: ${e.message}`;
      if (pushLog) pushLog('eos_forecast_bridge_error', { reason: err });
      return recordPush({ ok: false, pushed: [], errors: { build: err } });
    }
    if (gone()) return abandoned();

    // Echte Preise. Die gespeicherten echten Day-Ahead-Preise aus der
    // Datenbank umfassen alles, was DVhub je abgerufen hat, also auch, was EOS
    // noch hält. Sie werden genommen,
    //   - wenn die im Speicher jetzt nicht abdecken (DVhub neu gestartet,
    //     während der Preisabruf gestört ist) — sonst fiele jeder Lauf aus, bis
    //     ein Abruf gelingt (Gegenprüfung c0fdcbef, P2);
    //   - wenn sie lückenlos weiter reichen als die im Speicher: epex-fetch.js
    //     ersetzt state.epex.data komplett, ein Abruf mit nur heute ließe sonst
    //     Schätzwerte die echten Preise für morgen in EOS überschreiben und
    //     clearStaleEstimates sie löschen (Gesamtprüfung Release 1.0.9, Befund 9).
    //     Dann gelten die im Speicher, dahinter die aus der Datenbank — bei
    //     gleicher Slot-Länge (eine gemischte Kadenz liest EOS mit Lücken,
    //     Gegenprüfung 8c050aae), sonst ganz die aus der Datenbank.
    let realPriceSlots = forecast?.price?.slots || [];
    {
      const nowMs = Date.now();
      const memEnd = contiguousPriceEndMs(realPriceSlots, nowMs);
      const stored = await loadStoredRealPriceSlots(nowMs);
      if (gone()) return abandoned();
      const storedEnd = contiguousPriceEndMs(stored, nowMs);
      if (Number.isFinite(storedEnd) && (!Number.isFinite(memEnd) || storedEnd > memEnd)) {
        let merged = stored;
        let mode = Number.isFinite(memEnd) ? 'extend' : 'replace';
        if (Number.isFinite(memEnd) && realPriceCoverage(realPriceSlots).stepMs === realPriceCoverage(stored).stepMs) {
          // Aus der Datenbank nur Zeitpunkte, die im Speicher fehlen: Slots
          // hinter einer Lücke im Speicher kämen sonst doppelt, und der
          // jeweils letzte (Datenbank) gewönne (Gegenprüfung 1c7d8b2c, P3).
          const inMemory = new Set(realPriceSlots.map((x) => Date.parse(x?.start)));
          merged = [
            ...realPriceSlots,
            ...stored.filter((x) => Date.parse(x.start) >= memEnd && !inMemory.has(Date.parse(x.start))),
          ];
          mode = 'append';
        }
        if (pushLog) {
          pushLog('eos_prices_from_store', {
            mode, slots: stored.length, from: stored[0].start, until: new Date(storedEnd).toISOString(),
            memoryUntil: Number.isFinite(memEnd) ? new Date(memEnd).toISOString() : null,
          });
        }
        realPriceSlots = merged;
      }
    }

    let pvSlots = keepOnGridSlots(forecast?.pv?.slots || []);
    let loadSlots = padSlotsBackToNow(forecast?.load?.slots || [], Date.now());
    // Echte Preise enden vormittags um Mitternacht. Ohne Preise dahinter kürzt
    // EOS seinen Schwanz auf 0,5 h und bewertet die Restladung fast nur zum
    // Einspeisewert — es speist mittags PV ein, statt sie für Nacht und Morgen
    // zu speichern (Prod 01.11.2026). Deshalb dahinter Schätzwerte; der
    // Steuerzeitraum richtet sich weiter nur nach den echten Preisen.
    // Dahinter der Preisschwanz aus der Residuallast-Prognose (priceSlotsForEos).
    const priceFill = await priceSlotsForEos(realPriceSlots, pvSlots, loadSlots, Date.now(), {
      estimate: dvhubTriggersEosRuns(cfg) && state?.optimizer?.eos?.supported === true,
      maxMs: resolveEosPredictionHours(cfg) * 3_600_000,
      gone,
    });
    if (gone()) return abandoned();
    const priceSlotsCt = priceFill.slots;
    const priceEstimate = priceFill.estimate;
    if (state) {
      state.optimizer = state.optimizer || {};
      state.optimizer.eosPriceEstimate = priceEstimate;
      // Zustand des Preisschwanzes für Leitstand, EOS-Karte und Integrationen:
      // woher (Prognose live/gespeichert), bis wann, und — ohne Schwanz —
      // warum und seit wann die Prognose fehlt.
      state.optimizer.eosPriceTail = priceFill.tail ? {
        ...priceFill.tail,
        from: priceEstimate?.from ?? null,
        until: priceEstimate?.until ?? null,
        slots: priceEstimate?.estimatedSlots ?? 0,
        leadDaysMax: priceEstimate?.leadDaysMax ?? null,
        realUntil: Number.isFinite(realPriceCoverage(realPriceSlots).end) ? new Date(realPriceCoverage(realPriceSlots).end).toISOString() : null,
        at: Date.now(),
      } : null;
    }
    // Schätzwerte gehen gleich an EOS: Merker „keine Schätzwerte in EOS“ schon
    // jetzt zurücknehmen — ein abgebrochener Push darf ihn nicht stehen lassen
    // (Codex d81a0ddc).
    if (state && priceEstimate) state.optimizer.eosEstimatesClearedAt = null;
    // Nur Netzspeicher: PV = 0, Verbrauch = Ruhebedarf aus dem Netzzähler
    // (grid-storage.js). Prognosen für PV und Hausverbrauch gelten dann nicht.
    let gridStorage = null;
    if (isGridStorageOnly(cfg)) {
      const standby = resolveStandbyW(cfg, standbyEstimator);
      ({ pvSlots, loadSlots } = buildGridStorageSeries(priceSlotsCt, standby.watts));
      gridStorage = { standbyW: standby.watts, standbySource: standby.source, samples: standbyEstimator.count() };
    }
    if (state) { state.optimizer = state.optimizer || {}; state.optimizer.gridStorage = gridStorage; }
    const tz = cfg?.optimizer?.timezone || 'Europe/Berlin';

    // Import (Bezugs) price. In FIXED-tariff mode the operator pays a flat gross
    // ct/kWh (e.g. 26.9 ct) regardless of spot, so push THAT — not the raw spot
    // (~14 ct) the bridge would otherwise stream. Otherwise the GA prices grid
    // imports far too cheaply, making self-consumption look barely better than
    // selling, so it over-sells the battery at the evening peak and buys the
    // night back from the grid. With the real import price, self-consumption
    // (avoided ~26.9 ct) clearly beats feed-in (≤17 ct spot) and the battery
    // covers the night instead. Feed-in/Vermarktung stays spot (handled below).
    // 2026-05-30, operator request.
    const pricing = cfg?.userEnergyPricing || {};
    // Import (Bezugs) price resolved PER SLOT against the active price PERIOD
    // (userEnergyPricing.periods, date-based) — not a flat top-level value. A
    // tariff-period boundary inside the forecast horizon, or a stale top-level
    // fixedGrossImportCtKwh, can then no longer feed EOS the wrong Bezugspreis:
    // each slot gets the price that actually applies on ITS date (e.g. the 29 ct
    // "Grünwelt" period ended 2025-12-09; since 2025-12-10 the 26.9 ct period
    // applies). resolveUserImportPriceCtKwhForSlot covers fixed (period-aware),
    // §14a module-3 windows AND dynamic (spot + components) in one call, so the
    // flat-import intent (push the real gross ~26.9 ct, not the ~14 ct raw spot)
    // is preserved, and the overnight-reserve threshold (Bezug × 1.2) follows it
    // automatically. Falls back to raw spot if no price resolves (never starve
    // EOS of an elecprice series). 2026-06-29, operator request.
    // Bezugspreis je Slot in ct/kWh (auch für die E-Auto-Wertbestimmung unten).
    const importCtOf = (s) => {
      let ct = resolveUserImportPriceCtKwhForSlot(
        { ts: s.start, ct_kwh: s.ctKwh },
        pricing,
        { timeZone: tz },
      );
      if (!Number.isFinite(ct)) ct = Number(s.ctKwh); // fallback: raw spot
      return Number.isFinite(ct) ? ct : null;
    };
    const elecpriceSlots = priceSlotsCt
      .filter((s) => s && s.start)
      .map((s) => {
        const ct = importCtOf(s);
        if (ct === null) return null;
        return s.estimated ? { start: s.start, powerW: ct / 100 / 1000, estimated: true } : { start: s.start, powerW: ct / 100 / 1000 };
      })
      .filter(Boolean);

    // Feed-in tariff = spot price × feedInSpotFactor (€/Wh), pushed only in spot
    // mode (operator request 2026-05-29). Without this EOS values feed-in at the
    // flat EEG tariff (FeedInTariffEnergyCharts) and never discharges the battery
    // to grid at the high evening spot — with it, EOS plans evening Vermarktung
    // at peak prices and holds PV back from feed-in during negative windows.
    const tariff = cfg?.optimizer?.tariff || {};
    const feedInSpot = String(tariff.feedInMode || 'fixed').toLowerCase() === 'spot';
    const feedInFactor = Number.isFinite(Number(tariff.feedInSpotFactor)) ? Number(tariff.feedInSpotFactor) : 1.0;
    // Market premium (ct/kWh) added onto non-negative spot slots so EOS values
    // feed-in at the real Direktvermarktung margin (spot + Marktprämie), not raw
    // spot. 0 when the gate is OFF (default) → the else-branch below reproduces
    // the exact original expression → byte-identical push. 2026-06-21.
    const premiumCt = await resolveFeedInMarketPremiumCtKwh(cfg);
    if (gone()) return abandoned();
    const feedInSlots = feedInSpot
      ? priceSlotsCt
          .filter((s) => s && s.start && Number.isFinite(Number(s.ctKwh)))
          .map((s) => {
            const spotCt = Number(s.ctKwh);
            // §51: premium only on non-negative spot. Gate OFF (premiumCt===0)
            // keeps the original (spot/100/1000)*factor expression untouched.
            const powerW = premiumCt > 0 && spotCt >= 0
              ? (spotCt * feedInFactor + premiumCt) / 100 / 1000
              : (spotCt / 100 / 1000) * feedInFactor;
            return s.estimated ? { start: s.start, powerW, estimated: true } : { start: s.start, powerW };
          })
      : fixedFeedInSlots(priceSlotsCt, tariff);
    // Einspeisewert je Slot in ct/kWh — dieselbe Regel wie oben (E-Auto-Wertbestimmung).
    const feedInCtOf = (s) => {
      const spotCt = Number(s?.ctKwh);
      if (!feedInSpot) return fixedFeedInSlots([s], tariff)[0]?.powerW * 100 * 1000;
      if (!Number.isFinite(spotCt)) return null;
      return premiumCt > 0 && spotCt >= 0 ? spotCt * feedInFactor + premiumCt : spotCt * feedInFactor;
    };
    // Womit der Einspeisewert tatsächlich gebildet ist — für die Anzeige im
    // Leitstand (/api/eos/plan priceBasis, eosPlanFeedInBasis): Marktprämie nur,
    // wenn sie > 0 war; bei fester Vergütung der Satz. Abgelegt erst, wenn EOS
    // die Einspeise-Reihe angenommen hat (unten).
    const feedInBasisNow = feedInSpot
      ? { feedIn: premiumCt > 0 ? 'spot_premium' : 'spot' }
      : { feedIn: 'fixed', fixedCtKwh: fixedFeedInCt(tariff) };

    // Heizstab (stufenlos regelbar): EOS plant ihn nicht — DVhub regelt ihn
    // nach Überschuss. Sein erwarteter Verbrauch kommt als Last in die Prognose,
    // damit EOS denselben PV-Überschuss nicht noch einmal verplant
    // (heater-load-reservation.js). Abschaltbar je Gerät (plan.reserveInForecast
    // = false) oder ganz (optimizer.heaterLoadReservation = false).
    let loadSlotsForEos = loadSlots;
    let heaterReservation = null;
    if (cfg?.optimizer?.heaterLoadReservation !== false) {
      try {
        const heaters = loadSchedulableDevices(cfg).devices
          .filter((d) => d.kind === 'modulating' && d.enabled !== false && d.plan?.reserveInForecast !== false)
          .map((d) => ({ id: d.id, maxPowerW: d.plan?.maxPowerW, minPowerW: d.plan?.minPowerW, capacityWh: d.plan?.capacityWh }));
        if (heaters.length) {
          const reserved = reserveHeaterLoad({
            loadSlots,
            pvSlots,
            feedInSlots,
            heaters,
            localDateOf: (ms) => localDate(ms, tz),
            nowMs: Date.now(),
            deliveredToday: state?.optimizer?.heaterEnergyToday || {},
          });
          if (reserved.reservedWh > 0) {
            loadSlotsForEos = reserved.slots;
            heaterReservation = { reservedWh: reserved.reservedWh, byDay: reserved.byDay };
          }
        }
      } catch (e) {
        if (pushLog) pushLog('eos_heater_reservation_error', { error: e?.message || String(e) });
      }
    }
    if (state) { state.optimizer = state.optimizer || {}; state.optimizer.heaterReservation = heaterReservation; }

    // E-Auto Max-Ladestand „wenn günstig“ (ev-targets.js): die Wertbestimmung
    // braucht Preise und PV-Überschuss bis 7 Tage über die Abfahrt hinaus, also
    // weiter als EOS (bis jetzt + 9,5 Tage, dahinter geschätzt). Nur wenn sie
    // wirkt: Auto mitoptimiert, Max-Ladestand an, EOS kennt die Wertstufen.
    if (state) {
      let evValueInputs = null;
      const evOpt = cfg?.optimizer || {};
      if (evOpt.eosOptimizeEv === true && configuredMaxSocPct(evOpt) !== null && state?.optimizer?.eos?.evSocValue === true && !gridStorage) {
        try {
          const nowMs = Date.now();
          const wantedMs = nowMs + EV_VALUE_INPUTS_DAYS * 86_400_000;
          let longSlots = priceSlotsCt;
          if (realPriceCoverage(longSlots).end < wantedMs) {
            const history = await loadPriceHistory(nowMs);
            if (gone()) return abandoned();
            longSlots = fillPriceSlots(realPriceSlots, {
              history, untilMs: wantedMs, nowMs,
              timeZone: cfg?.optimizer?.timezone || cfg?.epex?.timezone || 'Europe/Berlin',
            }).slots;
          }
          evValueInputs = buildEvValueInputs({ priceSlots: longSlots, importCtOf, feedInCtOf, pvSlots, loadSlots: loadSlotsForEos, nowMs, timeZone: tz });
        } catch (e) {
          if (pushLog) pushLog('ev_value_inputs_error', { error: e?.message || String(e) });
        }
      }
      state.optimizer = state.optimizer || {};
      state.optimizer.evValueInputs = evValueInputs;
    }

    // Wie weit EOS vorausschauen kann (1.0.11): Ende von PV, Last und Preisen
    // gegen den Prognosehorizont — EOS kürzt seinen Schwanz an der kürzesten
    // Reihe. Für die Anzeige „Vorausschau bis …, begrenzt durch …“.
    if (state?.optimizer?.eosPriceTail) {
      const endOf = (list, stepMs) => {
        let end = -Infinity;
        for (const x of Array.isArray(list) ? list : []) {
          const ms = Date.parse(x?.start);
          if (Number.isFinite(ms) && Number.isFinite(Number(x?.powerW ?? x?.ctKwh))) end = Math.max(end, ms + stepMs);
        }
        return end;
      };
      const nowMs = Date.now();
      const ends = {
        prediction: nowMs + resolveEosPredictionHours(cfg) * 3_600_000,
        pv: endOf(pvSlots, PRICE_SLOT_MS),
        load: endOf(loadSlotsForEos, 3_600_000),
        prices: realPriceCoverage(priceSlotsCt).end,
      };
      let limitedBy = 'prediction';
      for (const k of ['prices', 'pv', 'load']) if (ends[k] < ends[limitedBy]) limitedBy = k;
      const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
      state.optimizer.eosPriceTail.lookahead = {
        until: iso(ends[limitedBy]),
        limitedBy,
        predictionUntil: iso(ends.prediction),
        pvUntil: iso(ends.pv),
        loadUntil: iso(ends.load),
        pricesUntil: iso(ends.prices),
      };
    }

    const tasks = [
      {
        provider: 'PVForecastImport',
        body: buildDataFrameBody('pvforecast_ac_power', pvSlots, tz),
        rows: pvSlots.length,
      },
      {
        provider: 'LoadImport',
        body: buildDataFrameBody(
          'loadforecast_power_w',
          expandHourlyToQuarterHourly(loadSlotsForEos),
          tz,
        ),
        rows: loadSlotsForEos.length * 4,
      },
      {
        provider: 'ElecPriceImport',
        body: buildDataFrameBody('elecprice_marketprice_wh', elecpriceSlots, tz),
        rows: elecpriceSlots.length,
      },
    ];
    if (feedInSlots.length) {
      tasks.push({
        provider: 'FeedInTariffImport',
        body: buildDataFrameBody('feed_in_tariff_wh', feedInSlots, tz),
        rows: feedInSlots.length,
      });
    }

    const pushed = [];
    const errors = {};
    for (const t of tasks) {
      if (gone()) return abandoned();
      if (t.rows === 0) {
        errors[t.provider] = 'no slots available — skipping';
        continue;
      }
      const res = await eosHttpRequest(
        baseUrl,
        'PUT',
        // force_enable=true lets the import land even when this provider is not
        // the active one yet — the exact state on a FRESH INSTALL and right
        // after an EOS restart, before eos-config-sync flips load/pvforecast/
        // elecprice to the *Import providers. Without it EOS returns 404
        // "Provider not enabled" (server/eos.py:980), the forecast never
        // reaches EOS until a much later reconcile tick, and EOS plans on empty
        // data → no overnight reserve → the battery drains. No-op once the
        // provider is enabled (the EOS-side guard short-circuits).
        `/v1/prediction/import/${t.provider}?force_enable=true`,
        t.body,
      );
      if (res.ok) pushed.push(`${t.provider}(${t.rows})`);
      else errors[t.provider] = res.error;
      if (gone()) return abandoned();
      if (res.ok && t.provider === 'FeedInTariffImport') rememberFeedInBasis(feedInBasisNow);
    }

    // Steuerzeitraum an die Preisabdeckung koppeln (EOS 0.4).
    // 0.4 bricht einen Lauf ab, wenn im Steuerzeitraum ein Preis fehlt
    // ("Missing or invalid prices within the control horizon", prod
    // 2026-09-23 01:51). Day-Ahead reicht nachts nur bis Mitternacht, erst
    // gegen 13 Uhr kommt der Folgetag — mit festen 24 h plant 0.4 dann bis
    // zum Nachmittag GAR NICHT. Der Steuerzeitraum endet deshalb dort, wo
    // echte Preise belegt sind; dahinter bewertet EOS die Restladung ueber
    // seinen Endwert — im Schwanz mit geschaetzten Preisen (01.11.2026).
    // Geschätzte Preise zählen nicht: der Steuerzeitraum deckt die echten ab
    // (nie kürzer, Christin 03.10.), die Schätzung wirkt nur im Schwanz.
    const realOnly = (list) => list.filter((s) => !s.estimated);
    // Alles hinter dem Geschickten aus EOS entfernen (vor dem Lauf).
    if (gone()) return abandoned();
    const realEndMs = realPriceCoverage(realPriceSlots).end;
    // Ende der echten Preise: Grenze für die Regel-Umsetzung, wenn zum
    // gezeigten Plan keine Lauf-Angaben vorliegen (eos-adapter, nach einem
    // DVhub-Neustart; Codex-Gegenprüfung 3a14d90c).
    // Verlauf (eosRealPriceEnds): für Pläne ohne Lauf-Angaben die Grenze, die
    // zum Beginn ihres Laufs galt (eos-adapter estimatedPriceCutoffMs, Codex 8ecb4fa9).
    if (state && Number.isFinite(realEndMs)) {
      state.optimizer = state.optimizer || {};
      const endIso = new Date(realEndMs).toISOString();
      state.optimizer.eosRealPriceEnd = endIso;
      const hist = Array.isArray(state.optimizer.eosRealPriceEnds) ? state.optimizer.eosRealPriceEnds : [];
      if (!hist.length || hist[hist.length - 1].end !== endIso) {
        state.optimizer.eosRealPriceEnds = [...hist, { at: Date.now(), end: endIso }].slice(-16);
      }
    }
    {
      const sentEndMs = priceEstimate ? Date.parse(priceEstimate.until) : realEndMs;
      const clear = await clearStaleEstimates(baseUrl, { sentEndMs, nowMs: Date.now(), gone });
      if (gone()) return abandoned();
      if (clear.errors.length) errors.priceEstimateClear = clear.errors.join('; ');
      // Seit wann liegen sicher keine Schätzwerte mehr in EOS (Fable R3, P3-2)?
      // Für Pläne ohne Lauf-Angaben (EOS nach eigenem Takt): lag schon zum
      // frühesten Laufbeginn keine Schätzung vor, entfällt der Schnitt an der
      // alten Preisgrenze (eos-adapter estimatedPriceCutoffMs). Gesetzt beim
      // ersten gelungenen Löschen ohne Schätzung, nicht bei jedem Push
      // nachgezogen; ein Push mit Schätzung nimmt ihn zurück.
      if (state) {
        state.optimizer = state.optimizer || {};
        // Merker gilt je EOS-Ziel; anderes Ziel → neu ab diesem Löschen (Codex d81a0ddc).
        const target = eosTargetKey(cfg);
        if (state.optimizer.eosEstimatesClearedTarget !== target) {
          state.optimizer.eosEstimatesClearedAt = null;
          state.optimizer.eosEstimatesClearedTarget = target;
        }
        if (priceEstimate) state.optimizer.eosEstimatesClearedAt = null;
        else if (clear.cleared === true && !clear.errors.length && !Number.isFinite(state.optimizer.eosEstimatesClearedAt)) {
          state.optimizer.eosEstimatesClearedAt = Date.now();
        }
      }
    }

    // PV wie die Last auf jetzt zurückgefüllt — nur für die Berechnung: PV
    // aus VRM beginnt nach einem Abruf erst zur nächsten vollen Stunde, der
    // Steuerzeitraum fiele sonst aus (Gegenprüfung 7e99580c). Die laufende
    // Stunde hält EOS aus früheren Pushes — nach einem EOS-Neustart nicht;
    // dann bricht EOS bis zur nächsten vollen Stunde mit „Missing PV“ ab, wie
    // schon vor der Preis-Schätzung (offen, Gegenprüfung 165fa8be).
    const horizonLists = {
      Bezugspreis: realOnly(elecpriceSlots),
      Einspeisewert: feedInSlots.length ? realOnly(feedInSlots) : null,
      PV: padSeriesBackToNow(pvSlots, Date.now()),
      Last: expandHourlyToQuarterHourly(loadSlotsForEos),
    };
    // Laufbeginn-Fenster: EOS rundet den Laufbeginn auf seinen Slot ab (ems.py,
    // nur 900 oder 3600 s, v0.4.0rc3); das Fenster beginnt frühestens an der
    // abgerundeten Grenze von jetzt und endet spätestens Steuerzeitraum nach
    // dem abgerundeten spätesten Laufbeginn (Gegenprüfungen 165fa8be,
    // 8d71f34d). Einen anderen Wert (1800) lehnt EOS ab und behält seinen
    // alten — dann vorsichtig: frühester Beginn zur vollen Stunde, spätester
    // zur Viertelstunde.
    const intervalMs = buildEosOptimization(cfg).interval * 1000;
    const knownInterval = intervalMs === 900_000 || intervalMs === 3_600_000;
    const earliestSlotMs = knownInterval ? intervalMs : 3_600_000;
    const latestSlotMs = knownInterval ? intervalMs : 900_000;
    const runWindow = (nowMs) => ({
      windowStartMs: Math.floor(nowMs / earliestSlotMs) * earliestSlotMs,
      latestRunStartMs: Math.floor((nowMs + RUN_START_MARGIN_MS) / latestSlotMs) * latestSlotMs,
    });
    const runNowMs = Date.now();

    // Steuerzeitraum: echte Preise (und PV/Last) ab jetzt, mit der Grenze aus
    // den Einstellungen; im Modus „automatisch“ mindestens 6 h und bis zur
    // spätesten Frist (decideControlHorizon).
    const maxHours = resolveControlHorizonMaxHours(cfg);
    const realHours = computeControlHorizonHours(Object.values(horizonLists).filter(Boolean), runNowMs, { maxHours });
    const deadlines = collectPlanningDeadlines(cfg, state, runNowMs);
    const { windowStartMs: decisionWindowMs } = runWindow(runNowMs);
    let decision = decideControlHorizon({
      realHours,
      mode: controlHorizonMode(cfg),
      deadlines,
      windowStartMs: decisionWindowMs,
    });
    // E-Auto-Frist hinter den echten Preisen: bis zur Abfahrt in die
    // Prognosepreise (extendForEvDeadline) — nur für diesen Fall. Im Modus
    // „bis in die Preisprognose“ so weit, wie Preise, PV und Last reichen
    // (extendIntoForecast).
    if (priceEstimate) {
      const fullHours = computeControlHorizonHours([
        elecpriceSlots,
        feedInSlots.length ? feedInSlots : null,
        horizonLists.PV,
        horizonLists.Last,
      ].filter(Boolean), runNowMs, { maxHours });
      decision = extendForEvDeadline(decision, {
        evAtMs: deadlines.find((d) => d.kind === 'ev')?.atMs ?? null,
        fullHours,
        windowStartMs: decisionWindowMs,
        realCoveredEndMs: contiguousPriceEndMs(realPriceSlots, decisionWindowMs),
        estimatedFrom: priceEstimate.from,
      });
      decision = extendIntoForecast(decision, { fullHours, estimatedFrom: priceEstimate.from });
    }
    const horizon = await syncControlHorizon(baseUrl, decision, { gone });
    if (horizon.error) errors.horizon = horizon.error;
    if (gone()) return abandoned();

    // Darf ein Lauf auf diesem Stand rechnen (prepareRun)? Nur wenn der
    // Preis-Import ankam und der Steuerzeitraum ab dem spätest möglichen
    // Laufbeginn ganz in echten Preisen liegt: davor hat der Import alles mit
    // echten Werten überschrieben, also liegt dort keine Schätzung — alt oder
    // neu, gelöscht oder nicht (Gegenprüfung 7e99580c). Wo das nicht gilt,
    // brach EOS vor der Schätzung ohnehin ab („Missing prices“).
    let runBlockedBy = null;
    if (!Number.isFinite(realEndMs)) runBlockedBy = 'keine echten Preise';
    else if (errors.ElecPriceImport || (feedInSlots.length && errors.FeedInTariffImport)) {
      runBlockedBy = ['ElecPriceImport', 'FeedInTariffImport'].filter((k) => errors[k]).map((k) => `${k}: ${errors[k]}`).join('; ');
    } else if (horizon.hours === undefined) {
      // Welche Reihe deckt jetzt nicht ab? (Sonst hieß es pauschal „no prices“.)
      const nowMs = Date.now();
      const gaps = horizon.skipped === 'no prices'
        ? Object.entries(horizonLists)
          .filter(([, l]) => Array.isArray(l) && l.some((x) => Number.isFinite(Number(x?.powerW))) && computeControlHorizonHours([l], nowMs) === null)
          .map(([name]) => name)
        : [];
      runBlockedBy = gaps.length
        ? `Steuerzeitraum nicht gesetzt (${gaps.join(', ')} deckt jetzt nicht ab)`
        : `Steuerzeitraum nicht gesetzt (${horizon.error || horizon.skipped})`;
    } else {
      // Gegen die lückenlose Abdeckung (eine Lücke könnte alte Schätzwerte
      // halten), im Fenster des Laufbeginns (oben, windowStartMs bis
      // latestRunStartMs + Steuerzeitraum) — ab jetzt, nach den PUTs.
      const { windowStartMs, latestRunStartMs } = runWindow(Date.now());
      const coveredEndMs = contiguousPriceEndMs(realPriceSlots, windowStartMs);
      const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : '—');
      if (decision.estimatedFrom) {
        // E-Auto-Frist (extendForEvDeadline): Hinter den echten Preisen liegen
        // die Schätzwerte DIESES Pushs — der Import hat jeden Slot bis zum Ende
        // der Schätzung überschrieben, dahinter ist gelöscht. Verlangt: die
        // gesendete Reihe (echt + geschätzt) deckt den Steuerzeitraum ab dem
        // spätesten Laufbeginn lückenlos, und echte Preise decken mindestens
        // die erste Stunde des Laufs.
        const sentEndMs = contiguousPriceEndMs(priceSlotsCt, windowStartMs);
        if (latestRunStartMs + horizon.hours * 3_600_000 > sentEndMs) {
          runBlockedBy = `Steuerzeitraum (${horizon.hours} h, ${decision.reason === 'price_forecast' ? 'bis in die Preisprognose' : 'E-Auto-Frist'}) reicht über die gesendeten Preise hinaus (lückenlos bis ${iso(sentEndMs)})`;
        } else if (latestRunStartMs + 3_600_000 > coveredEndMs) {
          runBlockedBy = `echte Preise decken den Laufbeginn nicht (lückenlos bis ${iso(coveredEndMs)})`;
        }
      } else if (latestRunStartMs + horizon.hours * 3_600_000 > coveredEndMs) {
        runBlockedBy = `Steuerzeitraum (${horizon.hours} h) reicht über die echten Preise hinaus (lückenlos bis ${iso(coveredEndMs)})`;
      }
    }

    // Forward the live battery SoC so EOS seeds its optimizer with the real
    // start state (not 0). Folded into the same cycle/cadence as the forecasts.
    const socRes = await pushSoc(baseUrl, { gone });
    if (gone()) return abandoned();
    for (const p of socRes.pushed) pushed.push(p);
    Object.assign(errors, socRes.errors);

    // Auch ein fehlgeschlagenes Löschen alter Schätzwerte macht den Push
    // „nicht ok“ — sonst gilt die Prognose als zugestellt und der
    // Wiederholversuch entfällt (Codex-Gegenprüfung).
    const okAll = pushed.length === tasks.length + socRes.pushed.length
      && Object.keys(socRes.errors).length === 0
      && !errors.priceEstimateClear;
    if (pushLog) {
      pushLog('eos_forecast_bridge', {
        ok: okAll, pushed, errors, socSkipped: socRes.skipped,
        ...(heaterReservation ? { heaterReservedWh: heaterReservation.byDay } : {}),
        ...(priceEstimate ? { estimatedPriceSlots: priceEstimate.estimatedSlots, estimatedPriceFrom: priceEstimate.from, estimatedPriceMethod: priceEstimate.method, estimatedPriceIssuedAt: priceEstimate.issuedAt ?? null } : {}),
        ...(!priceEstimate && priceFill.tail ? { priceTailMissing: priceFill.tail.why, priceOutlookStatus: priceFill.tail.status } : {}),
      });
    }
    return { ...recordPush({ ok: okAll, pushed, errors, priceEstimate }), runReady: runBlockedBy === null, runBlockedBy };
  }

  /**
   * Start the hourly push cycle. Synchronizes to ems.interval by firing the
   * first push immediately (so EOS has fresh data BEFORE its first tick) and
   * then every 3600s. Hourly is the right cadence because all upstream
   * forecast pipelines update at most hourly — pushing more often than that
   * sends EOS the same numbers redundantly.
   */
  /**
   * Start the periodic reconcile timer.
   *
   * @param {object} [opts]
   * @param {() => (void|Promise<void>)} [opts.beforePush] - run BEFORE each push.
   *   Use this to re-assert EOS config (eos-config-sync) ahead of the forecast
   *   import so a provider that an EOS restart reset back to its default is
   *   re-enabled before the import lands — otherwise EOS reads the stale
   *   default provider for up to a full interval. Preferred over afterPush.
   * @param {() => (void|Promise<void>)} [opts.afterPush] - run AFTER each push,
   *   on the same tick. This is how the integration SELF-HEALS after an *EOS*
   *   restart: an EOS restart resets all API-set config (elecprice/load/
   *   pvforecast providers, optimization.interval, battery efficiency) back to
   *   its EOS.config.json defaults, and eos-config-sync otherwise only runs on
   *   DVhub boot/save. Wiring config-sync in here re-asserts that config every
   *   tick, so a reverted provider (e.g. elecprice -> EnergyCharts spot) is
   *   auto-reconciled within <=1 interval instead of needing a manual DVhub
   *   restart. push() runs BEFORE afterPush so the *Import series are fresh when
   *   the providers are re-flipped at them.
   * @param {number} [opts.intervalMs] - tick interval, default 3600_000 (1 h).
   * @param {boolean} [opts.fireImmediately=true] - run one tick now. Pass false
   *   when the caller already ran a boot reconcile (push->sync) just before.
   * @param {number} [opts.watchdogMs=60000] - EOS-restart watchdog poll interval.
   *   Polls /v1/health for the EOS pid; on a pid change (= EOS restarted) it runs
   *   a full reconcile tick immediately so providers + data recover in ~seconds
   *   instead of waiting up to intervalMs.
   * @param {Function} [opts.onEosRestart] - called after that reconcile tick,
   *   so the optimizer can fetch the first plan of the new EOS process quickly.
   */
  function start(opts = {}) {
    if (tickHandle) return;
    const intervalMs = Number(opts.intervalMs) > 0 ? Number(opts.intervalMs) : 3600 * 1000;
    const tick = async () => {
      // beforePush, push() and afterPush each log + swallow their own errors;
      // the timer callback must never throw.
      //
      // beforePush re-asserts EOS config (providers/interval) BEFORE the push,
      // so an EOS restart — which resets all API-set config back to its
      // defaults (providers disabled, interval 300) — is healed before the
      // forecast import lands, not a whole interval later. With sync-first the
      // *Import providers are active when the push arrives; the push's
      // force_enable=true covers the brief flip race either way.
      if (typeof opts.beforePush === 'function') {
        try { await opts.beforePush(); } catch { /* beforePush logs/swallows */ }
      }
      try { await push(); } catch { /* push() already logs */ }
      if (typeof opts.afterPush === 'function') {
        try { await opts.afterPush(); } catch { /* afterPush logs/swallows */ }
      }
    };
    if (opts.fireImmediately !== false) tick();
    tickHandle = setInterval(tick, intervalMs);
    standbyHandle = setInterval(sampleStandby, 60_000);
    standbyHandle.unref?.();

    // EOS-restart watchdog (2026-06-28). An EOS restart wipes ALL pushed
    // *Import series AND reverts some providers (observed: load/pvforecast fall
    // back to their EOS defaults; elecprice/interval survive). The persisted
    // config file only reliably preserves a subset, and the data is gone
    // regardless — so the only complete recovery is to re-assert config AND
    // re-push data. Without this, that recovery waited for the next forecast
    // tick (up to intervalMs, i.e. 15 min), during which EOS planned on stale
    // defaults + empty series. Polling the EOS pid (which changes on every
    // restart) lets us run a full reconcile within ~watchdogMs instead. The
    // reconcile reuses tick() so providers (beforePush=config-sync) are
    // re-flipped and forecasts+SoC re-pushed in one go.
    const watchdogMs = Number(opts.watchdogMs) > 0 ? Number(opts.watchdogMs) : 60_000;
    const watchdog = async () => {
      const cfg = getCfg();
      if (cfg?.optimizer?.eosProxy?.enabled === false) return;
      const baseUrl = resolveEosProxy(cfg).url;
      // Neustart-Zähler des zentralen EOS-Monitors (erkennt auch Neustarts im
      // Container, wo die Prozessnummer immer 1 ist — siehe eos-monitor.js);
      // ohne Monitor die Prozessnummer selbst erfragen.
      let pid;
      let reason = 'pid';
      if (ctx.eosMonitor) {
        const mon = ctx.eosMonitor.status();
        if (mon.pid === null && !mon.restarts) return; // EOS noch nie erreicht
        pid = `restart#${mon.restarts || 0}`;
        reason = mon.lastRestartReason || 'pid';
      } else {
        pid = await readEosPid(baseUrl);
      }
      if (pid === null) return; // EOS unreachable / still starting — decide next poll
      if (lastEosPid !== null && pid !== lastEosPid) {
        const lastEosPidBefore = lastEosPid;
        if (pushLog) pushLog('eos_restart_detected', { oldPid: lastEosPid, newPid: pid, reason });
        lastEosPid = pid;
        await tick(); // re-assert providers + re-push data immediately
        if (typeof opts.onEosRestart === 'function') {
          try { await opts.onEosRestart({ oldPid: lastEosPidBefore, newPid: pid }); } catch { /* caller logs */ }
        }
        return;
      }
      lastEosPid = pid;
    };
    watchdogHandle = setInterval(watchdog, watchdogMs);
  }

  function stop() {
    if (tickHandle) {
      clearInterval(tickHandle);
      tickHandle = null;
    }
    if (watchdogHandle) {
      clearInterval(watchdogHandle);
      watchdogHandle = null;
    }
    if (standbyHandle) {
      clearInterval(standbyHandle);
      standbyHandle = null;
    }
  }

  return { push, prepareRun, pushFreshSoc, socForRun, start, stop };
}

// Exported for unit-tests.
export {
  slotsToTimeMap,
  expandHourlyToQuarterHourly,
  priceSlotsToEosFormat,
  buildDataFrameBody,
};

// Internal regexes exported for unit-tests of the SoC key classification.
export const SOC_KEY_RE = /-soc-factor$/;
export const EV_SOC_KEY_RE = /(^|[^a-z])ev\d*-soc-factor$/;
