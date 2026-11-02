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
import { resolveEosProxy } from './eos-adapter.js';
import http from 'node:http';
import { summarizeWeightedApplicableValue } from '../../history-runtime.js';
import { resolveUserImportPriceCtKwhForSlot } from '../../config-model.js';
import { loadSchedulableDevices } from '../devices/schedulable.js';
import { reserveHeaterLoad } from '../devices/heater-load-reservation.js';
import { localDate } from '../../tz-fast.js';
// Zweite GX am selben Anschluss: Ladestand beider Akkus, nach Kapazitaet gewichtet.
import { planningSocPct } from '../multi-gx/planning.js';
// Preise hinter den bekannten Day-Ahead-Preisen schätzen (01.11.2026).
import { fillPriceSlots, realPriceCoverage, HISTORY_DAYS, MIN_REAL_AHEAD_MS, SLOT_MS as PRICE_SLOT_MS } from './price-estimate.js';

/**
 * Frist der Wache je Push (siehe push()): jede EOS-Anfrage hat 15 s, ein Push
 * macht höchstens gut ein Dutzend davon — 5 min lassen reichlich Luft.
 */
export const PUSH_TIMEOUT_MS = 5 * 60_000;
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
        hostname: url.hostname,
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
 * Wie viele volle Stunden ab `nowMs` sind in ALLEN Preisreihen lueckenlos
 * belegt? Slots `{start, powerW}` (15 min). Minus 15 min Puffer, begrenzt auf
 * 1..24. Reihen ohne einen einzigen Wert zaehlen nicht mit. null, wenn keine
 * Reihe Werte hat oder eine Reihe den laufenden Slot nicht abdeckt.
 */
export function computeControlHorizonHours(slotLists, nowMs, { slotMs = 15 * 60_000, maxHours = 24 } = {}) {
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

/** Höchstens so weit (ab jetzt) werden Preise geschätzt: Steuerzeitraum 24 h + Schwanz 48 h. */
export const PRICE_FILL_MAX_MS = 72 * 3_600_000;

/**
 * Bis wohin die Preisreihen reichen sollen: so weit wie PV- oder Lastprognose
 * (der EOS-Schwanz endet ohnehin an der kürzesten Reihe), höchstens 72 h.
 * Ohne beide Prognosen (z. B. Nur Netzspeicher) 48 h.
 */
export function priceFillUntilMs(pvSlots, loadSlots, nowMs) {
  let end = -Infinity;
  for (const [list, stepMs] of [[pvSlots, PRICE_SLOT_MS], [loadSlots, 3_600_000]]) {
    for (const s of Array.isArray(list) ? list : []) {
      const ms = Date.parse(s?.start);
      if (Number.isFinite(ms) && Number.isFinite(Number(s?.powerW))) end = Math.max(end, ms + stepMs);
    }
  }
  if (!Number.isFinite(end)) end = nowMs + 48 * 3_600_000;
  return Math.min(end, nowMs + PRICE_FILL_MAX_MS);
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
    try {
      const rows = await store.querySeries({
        seriesKeys: ['price_ct_kwh'],
        start: new Date(fromMs).toISOString(),
        end: new Date(nowMs + 3 * 86_400_000).toISOString(),
        // Nicht nach dem Stempel filtern: ein Abruf mit Lücke im ersten
        // Zeilenpaar ist insgesamt grob gestempelt (Gegenprüfung fac22151).
        maxResolution: 86_400,
      });
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
    }
  }

  async function loadPriceHistory(nowMs) {
    if (priceHistoryCache && nowMs - priceHistoryCache.at < 3_600_000) return priceHistoryCache.points;
    const store = ctx.telemetryStore;
    if (!store || typeof store.querySeries !== 'function') return [];
    let points = [];
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
      points = [];
    }
    priceHistoryCache = { at: nowMs, points };
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
  async function clearStaleEstimates(baseUrl, { sentEndMs, nowMs }) {
    const start = sentEndMs;
    const end = nowMs + PRICE_FILL_MAX_MS + 3_600_000;
    if (!Number.isFinite(start) || !(end > start)) return { cleared: false, errors: [] };
    const q = (ms) => encodeURIComponent(new Date(ms).toISOString());
    const errors = [];
    for (const key of PRICE_KEYS) {
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
  // ohne Erkennung auch keinen Steuerzeitraum: dann keine Schätzung
  // (Gegenprüfungen 16856110, 2ed313de); alte löscht clearStaleEstimates.
  async function priceSlotsForEos(realSlots, pvSlots, loadSlots, nowMs, { estimate = true } = {}) {
    if (!estimate) return { slots: realSlots, estimate: null };
    const untilMs = priceFillUntilMs(pvSlots, loadSlots, nowMs);
    const { end } = realPriceCoverage(realSlots);
    if (end < nowMs + MIN_REAL_AHEAD_MS || end >= untilMs) return { slots: realSlots, estimate: null };
    const history = await loadPriceHistory(nowMs);
    return fillPriceSlots(realSlots, { history, untilMs, nowMs });
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
  async function pushSoc(baseUrl, { freshOnly = false } = {}) {
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
    const evFactor = Number.isFinite(evPct) ? Math.max(0, Math.min(1, evPct / 100)) : null;

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
    const soc = {};
    for (const key of keysRes.data.map(String).filter((k) => SOC_KEY_RE.test(k))) {
      const deviceId = key.slice(0, -'-soc-factor'.length);
      if (EV_SOC_KEY_RE.test(key)) {
        if (Number.isFinite(evPct)) soc[deviceId] = whole(evPct);
      } else {
        soc[deviceId] = whole(socPct);
      }
    }
    if (!Object.keys(soc).length) return { skipped: 'no battery registered in EOS' };
    return { soc };
  }

  let lastHorizonHours = null;
  /**
   * Steuerzeitraum = volle Stunden, die ab jetzt lueckenlos mit Preisen belegt
   * sind, minus 15 min Puffer (EOS rechnet auf eigenem 15-min-Takt; der
   * naechste Lauf vor dem naechsten Push muss noch abgedeckt sein), 1..24 h.
   * Nur wenn der Abgleich ein EOS 0.4 erkannt hat.
   */
  async function syncControlHorizon(baseUrl, ...slotLists) {
    if (state?.optimizer?.eos?.supported !== true) return { skipped: 'eos not supported' };
    const hours = computeControlHorizonHours(slotLists.filter(Boolean), Date.now());
    if (hours === null) return { skipped: 'no prices' };
    // Immer senden (kostet nichts): nach einem EOS-Neustart kennt EOS den
    // zuletzt gesetzten Wert evtl. nicht mehr. Protokolliert wird nur ein Wechsel.
    const res = await eosHttpRequest(baseUrl, 'PUT', '/v1/config/optimization/genetic/horizon_hours', hours);
    if (!res.ok) return { error: res.error };
    if (pushLog && hours !== lastHorizonHours) pushLog('eos_control_horizon', { hours, previous: lastHorizonHours });
    lastHorizonHours = hours;
    if (state?.optimizer) state.optimizer.eosControlHorizonH = hours;
    return { hours };
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
    if (res?.runReady === true) return { ok: true, pushed: true };
    const why = res?.runBlockedBy
      || (res?.errors && typeof res.errors === 'object' ? Object.entries(res.errors).map(([k, v]) => `${k}: ${v}`).join('; ') : '')
      || 'Push gescheitert';
    return { ok: false, pushed: true, error: `Lauf ohne sichere Preisgrundlage: ${why}` };
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

    // Echte Preise. Decken die im Speicher jetzt nicht ab (DVhub neu
    // gestartet, während der Preisabruf gestört ist), die gespeicherten echten
    // Day-Ahead-Preise aus der Datenbank nehmen: sie umfassen alles, was DVhub
    // je abgerufen hat, also auch, was EOS noch hält — sonst fiele jeder Lauf
    // aus, bis ein Abruf gelingt (Gegenprüfung c0fdcbef, P2).
    let realPriceSlots = forecast?.price?.slots || [];
    if (!Number.isFinite(contiguousPriceEndMs(realPriceSlots, Date.now()))) {
      const stored = await loadStoredRealPriceSlots(Date.now());
      if (gone()) return abandoned();
      if (Number.isFinite(contiguousPriceEndMs(stored, Date.now()))) {
        if (pushLog) pushLog('eos_prices_from_store', { slots: stored.length, from: stored[0].start, until: stored[stored.length - 1].end });
        realPriceSlots = stored;
      }
    }

    let pvSlots = keepOnGridSlots(forecast?.pv?.slots || []);
    let loadSlots = padSlotsBackToNow(forecast?.load?.slots || [], Date.now());
    // Echte Preise enden vormittags um Mitternacht. Ohne Preise dahinter kürzt
    // EOS seinen Schwanz auf 0,5 h und bewertet die Restladung fast nur zum
    // Einspeisewert — es speist mittags PV ein, statt sie für Nacht und Morgen
    // zu speichern (Prod 01.11.2026). Deshalb dahinter Schätzwerte; der
    // Steuerzeitraum richtet sich weiter nur nach den echten Preisen.
    const priceFill = await priceSlotsForEos(realPriceSlots, pvSlots, loadSlots, Date.now(), { estimate: dvhubTriggersEosRuns(cfg) && state?.optimizer?.eos?.supported === true });
    if (gone()) return abandoned();
    const priceSlotsCt = priceFill.slots;
    const priceEstimate = priceFill.estimate;
    if (state) { state.optimizer = state.optimizer || {}; state.optimizer.eosPriceEstimate = priceEstimate; }
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
    const elecpriceSlots = priceSlotsCt
      .filter((s) => s && s.start)
      .map((s) => {
        let ct = resolveUserImportPriceCtKwhForSlot(
          { ts: s.start, ct_kwh: s.ctKwh },
          pricing,
          { timeZone: tz },
        );
        if (!Number.isFinite(ct)) ct = Number(s.ctKwh); // fallback: raw spot
        if (!Number.isFinite(ct)) return null;
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
    {
      const sentEndMs = priceEstimate ? Date.parse(priceEstimate.until) : realEndMs;
      const clear = await clearStaleEstimates(baseUrl, { sentEndMs, nowMs: Date.now() });
      if (gone()) return abandoned();
      if (clear.errors.length) errors.priceEstimateClear = clear.errors.join('; ');
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
    const horizon = await syncControlHorizon(baseUrl, ...Object.values(horizonLists));
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
      // halten). EOS rundet den Laufbeginn auf seinen Slot ab (ems.py, nur
      // 900 oder 3600 s, v0.4.0rc3): das Fenster beginnt frühestens an der
      // abgerundeten Grenze von jetzt und endet spätestens Steuerzeitraum nach
      // dem abgerundeten spätesten Laufbeginn (Gegenprüfungen 165fa8be,
      // 8d71f34d). Einen anderen Wert (1800) lehnt EOS ab und behält seinen
      // alten — dann vorsichtig: frühester Beginn zur vollen Stunde, spätester
      // zur Viertelstunde.
      const nowMs = Date.now();
      const intervalMs = buildEosOptimization(cfg).interval * 1000;
      const known = intervalMs === 900_000 || intervalMs === 3_600_000;
      const earliestSlotMs = known ? intervalMs : 3_600_000;
      const latestSlotMs = known ? intervalMs : 900_000;
      const windowStartMs = Math.floor(nowMs / earliestSlotMs) * earliestSlotMs;
      const latestRunStartMs = Math.floor((nowMs + RUN_START_MARGIN_MS) / latestSlotMs) * latestSlotMs;
      const coveredEndMs = contiguousPriceEndMs(realPriceSlots, windowStartMs);
      if (latestRunStartMs + horizon.hours * 3_600_000 > coveredEndMs) {
        runBlockedBy = `Steuerzeitraum (${horizon.hours} h) reicht über die echten Preise hinaus (lückenlos bis ${Number.isFinite(coveredEndMs) ? new Date(coveredEndMs).toISOString() : '—'})`;
      }
    }

    // Forward the live battery SoC so EOS seeds its optimizer with the real
    // start state (not 0). Folded into the same cycle/cadence as the forecasts.
    const socRes = await pushSoc(baseUrl);
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
        ...(priceEstimate ? { estimatedPriceSlots: priceEstimate.estimatedSlots, estimatedPriceFrom: priceEstimate.from, estimatedPriceMethod: priceEstimate.method } : {}),
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
