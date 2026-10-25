import path from 'node:path';

function pushSample(rows, seriesKey, value, unit, base = {}) {
  if (value == null) return;
  const num = Number(value);
  if (!Number.isFinite(num)) return;
  rows.push({
    seriesKey,
    value: num,
    unit,
    scope: base.scope || 'live',
    source: base.source || 'local_poll',
    quality: base.quality || 'raw',
    ts: base.ts || new Date().toISOString(),
    resolutionSeconds: Number(base.resolutionSeconds || 1),
    meta: base.meta || null
  });
}

export function buildHistoricalTelemetrySample({
  seriesKey,
  ts,
  value,
  unit,
  resolutionSeconds = 900,
  source = 'vrm_import',
  quality = 'backfilled',
  meta = null,
  scope = 'history'
} = {}) {
  const rows = [];
  pushSample(rows, seriesKey, value, unit, {
    ts,
    resolutionSeconds,
    scope,
    source,
    quality,
    meta
  });
  return rows[0] || null;
}

export function resolveTelemetryDbPath({ configPath, telemetryConfig = {}, dataDir }) {
  if (telemetryConfig.dbPath) return String(telemetryConfig.dbPath);
  let baseDir = dataDir;
  if (!baseDir) {
    baseDir = String(configPath).startsWith('/etc/')
      ? '/var/lib/dvhub'
      : path.join(path.dirname(configPath), 'data');
  }
  return path.join(baseDir, 'telemetry.sqlite');
}

export function buildLiveTelemetrySamples({ ts, resolutionSeconds, meter = {}, victron = {}, managed = null }) {
  const rows = [];
  const base = {
    ts,
    resolutionSeconds,
    scope: 'live',
    source: 'local_poll',
    quality: 'raw'
  };

  pushSample(rows, 'grid_l1_w', meter.grid_l1_w, 'W', base);
  pushSample(rows, 'grid_l2_w', meter.grid_l2_w, 'W', base);
  pushSample(rows, 'grid_l3_w', meter.grid_l3_w, 'W', base);
  pushSample(rows, 'grid_total_w', meter.grid_total_w, 'W', base);
  pushSample(rows, 'grid_import_w', victron.gridImportW, 'W', base);
  pushSample(rows, 'grid_export_w', victron.gridExportW, 'W', base);
  pushSample(rows, 'battery_soc_pct', victron.soc, '%', base);
  pushSample(rows, 'battery_power_w', victron.batteryPowerW, 'W', base);
  pushSample(rows, 'battery_charge_w', victron.batteryChargeW, 'W', base);
  pushSample(rows, 'battery_discharge_w', victron.batteryDischargeW, 'W', base);
  pushSample(rows, 'pv_dc_w', victron.pvPowerW, 'W', base);
  pushSample(rows, 'pv_ac_l1_w', victron.acPvL1W, 'W', base);
  pushSample(rows, 'pv_ac_l2_w', victron.acPvL2W, 'W', base);
  pushSample(rows, 'pv_ac_l3_w', victron.acPvL3W, 'W', base);
  pushSample(rows, 'pv_total_w', victron.pvTotalW, 'W', base);
  pushSample(rows, 'load_power_w', victron.selfConsumptionW, 'W', base);
  // Von der Haupt-GX gemessene Last, nur solange polling.js sie um Akku 2 der
  // zweiten Anlage korrigiert (sonst gleich load_power_w, Feld fehlt). Der
  // Wirkungsgrad braucht genau diesen Wert; aus load_power_w laesst er sich nicht
  // sicher zurueckrechnen, weil die Korrektur bei 0 kappt.
  pushSample(rows, 'load_measured_w', victron.selfConsumptionMeasuredW, 'W', base);
  // Inc 2 (Last-Separation): house load minus positively confirmed controllable
  // load, so the forecast stops learning EV/device draw that EOS then adds again.
  // The decision AND its log event live in server.js `onPollComplete` (this builder
  // is a pure mapper with no logger); `managed.exManagedW` is the finished result and
  // already equals the raw value whenever nothing qualified. null -> pushSample skips,
  // which is the correct behaviour when the raw load itself was unusable.
  pushSample(rows, 'load_power_w_ex_managed', managed?.exManagedW, 'W', base);
  pushSample(rows, 'self_consumption_w', victron.selfConsumptionW, 'W', base);
  pushSample(rows, 'solar_direct_use_w', victron.solarDirectUseW, 'W', base);
  pushSample(rows, 'solar_to_battery_w', victron.solarToBatteryW, 'W', base);
  pushSample(rows, 'solar_to_grid_w', victron.solarToGridW, 'W', base);
  pushSample(rows, 'grid_direct_use_w', victron.gridDirectUseW, 'W', base);
  pushSample(rows, 'grid_to_battery_w', victron.gridToBatteryW, 'W', base);
  pushSample(rows, 'battery_direct_use_w', victron.batteryDirectUseW, 'W', base);
  pushSample(rows, 'battery_to_grid_w', victron.batteryToGridW, 'W', base);
  // Akku der zweiten GX-Anlage als eigene Reihen (21.10.2026, Chrissi: „kannst
  // die Akkus dort getrennt aufzeigen“). polling.js setzt die Felder auf null,
  // solange keine zweite Anlage einbezogen ist → pushSample ueberspringt sie,
  // ohne zweite Anlage entsteht also keine einzige neue Zeile.
  pushSample(rows, 'second_battery_charge_w', victron.secondBatteryChargeW, 'W', base);
  pushSample(rows, 'second_battery_discharge_w', victron.secondBatteryDischargeW, 'W', base);
  pushSample(rows, 'second_solar_to_battery_w', victron.secondSolarToBatteryW, 'W', base);
  pushSample(rows, 'second_grid_to_battery_w', victron.secondGridToBatteryW, 'W', base);
  pushSample(rows, 'second_battery_to_grid_w', victron.secondBatteryToGridW, 'W', base);
  pushSample(rows, 'second_battery_direct_use_w', victron.secondBatteryDirectUseW, 'W', base);
  pushSample(rows, 'second_battery_soc_pct', victron.secondBatterySocPct, '%', base);
  // Akku→Akku-Verschiebung (gegenlaeufige Akkus), ebenfalls nur mit zweiter Anlage.
  pushSample(rows, 'battery_to_second_battery_w', victron.batteryToSecondBatteryW, 'W', base);
  pushSample(rows, 'second_battery_to_battery_w', victron.secondBatteryToBatteryW, 'W', base);
  pushSample(rows, 'grid_setpoint_w', victron.gridSetpointW, 'W', base);
  pushSample(rows, 'min_soc_pct', victron.minSocPct, '%', base);

  return rows;
}

export function buildPriceTelemetrySamples(rows, options = {}) {
  return rows.flatMap((row) => {
    const ts = new Date(Number(row.ts)).toISOString();
    const base = {
      ts,
      resolutionSeconds: Number(row.resolutionSeconds || options.resolutionSeconds || 3600),
      scope: options.scope || 'forecast',
      source: options.source || 'price_api',
      quality: options.quality || 'raw'
    };
    const out = [];
    pushSample(out, 'price_eur_mwh', row.eur_mwh, 'EUR/MWh', base);
    pushSample(out, 'price_ct_kwh', row.ct_kwh, 'ct/kWh', base);
    return out;
  });
}

export function buildHistoricalPriceTelemetrySamples(rows, options = {}) {
  // Zeilen duerfen ihren eigenen Stempel mitbringen (row.resolutionSeconds, aus
  // priceRowSpacingSeconds): vor dem 01.10.2025 war der Day-Ahead stuendlich
  // und wurde trotzdem pauschal als 900 s gestempelt.
  return buildPriceTelemetrySamples(rows, {
    resolutionSeconds: 900,
    scope: 'history',
    source: 'price_backfill',
    quality: 'backfilled',
    ...options
  });
}

const PRICE_QUARTER_MS = 900 * 1000;
const PRICE_HOUR_MS = 3600 * 1000;

function priceTsMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return new Date(value).getTime();
}

/**
 * Stempel je Preiszeile aus dem echten Abstand zu den Nachbarzeilen: 3600 fuer
 * Stundenpreise (volle Stunde, naechster Nachbar >= 1 h weg), sonst 900. Zeilen
 * mit `ts` (Epoch-ms oder ISO). Ueber die VOLLSTAENDIG geholten Zeilen rechnen,
 * nicht ueber eine ausgeduennte Auswahl.
 */
export function priceRowSpacingSeconds(rows) {
  const times = rows.map((row) => priceTsMs(Number.isFinite(Number(row.ts)) ? Number(row.ts) : row.ts));
  const sorted = [...new Set(times.filter(Number.isFinite))].sort((a, b) => a - b);
  const position = new Map(sorted.map((ms, index) => [ms, index]));
  return times.map((ms) => {
    const index = position.get(ms);
    if (index == null) return 900;
    const gaps = [];
    if (index > 0) gaps.push(ms - sorted[index - 1]);
    if (index + 1 < sorted.length) gaps.push(sorted[index + 1] - ms);
    if (!gaps.length) return 900;
    return Math.min(...gaps) >= PRICE_HOUR_MS && ms % PRICE_HOUR_MS === 0 ? 3600 : 900;
  });
}

/**
 * Energie einer Leistungsprobe je 15-min-Slot, fuer beide Stores (SQLite und
 * PostgreSQL) gleich. Liefert [{ slotStartMs, valueNum (kWh) }].
 *
 * - spread=true (VRM-Import: ts = Beginn der Probe): eine Probe, die laenger als
 *   ein Slot ist (interval=hours/days, importSamples mit 3600 s), verteilt ihre
 *   Energie anteilig auf alle Slots in [ts, ts + Aufloesung).
 * - spread=false (Live: ts = Ende der Messspanne): die Probe zaehlt im Slot ihres
 *   Zeitstempels, hoechstens einen Slot lang (T-0079). Ein Wert nach einem
 *   Ausfall mit grosser Aufloesung fuellt die Luecke nicht.
 *
 * Proben bis zu einem Slot landen in beiden Faellen ganz im Slot ihres
 * Zeitstempels (wie bisher). Leistung null zaehlt als 0 kWh; ungueltige
 * Aufloesung oder Leistung liefert [].
 *
 * nextStartMs (Beginn der naechsten Probe derselben Reihe): Tagesproben stehen
 * auf lokaler Mitternacht, an Umstellungstagen ist der Tag 23 bzw. 25 h lang.
 * Liegt die naechste Probe hoechstens eine Stunde neben ts + Aufloesung, endet
 * die Probe dort (keine Ueberlappung, keine Luecke). Nur fuer Proben ab einem
 * Tag — kuerzere haben keine Umstellung, eine Luecke danach bleibt leer.
 */
export function sampleEnergyBySlot({ ts, value, resolutionSeconds, spread = false, slotSeconds = 900, nextStartMs = null }) {
  const numeric = Number(value);
  const seconds = Number(resolutionSeconds || 0);
  const startMs = new Date(ts).getTime();
  if (!Number.isFinite(numeric) || !Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(startMs)) return [];
  const slotMs = slotSeconds * 1000;
  const firstSlotMs = Math.floor(startMs / slotMs) * slotMs;
  if (seconds <= slotSeconds || !spread) {
    return [{ slotStartMs: firstSlotMs, valueNum: (numeric * Math.min(seconds, slotSeconds)) / 3600000 }];
  }
  let endMs = startMs + seconds * 1000;
  const next = nextStartMs == null ? NaN : Number(nextStartMs);
  if (seconds >= 86400 && Number.isFinite(next) && next > startMs && Math.abs(next - endMs) <= 3_600_000) endMs = next;
  // Energie der Probe = Wert × Aufloesung (wie ueberall im Store); sie verteilt
  // sich nach Zeitanteil auf [startMs, endMs). Bei 23/25-h-Tagen bleibt sie
  // damit gleich, nur der Anteil je Viertelstunde aendert sich.
  const energyKwh = (numeric * seconds) / 3600000;
  const spanMs = endMs - startMs;
  const out = [];
  for (let slotStartMs = firstSlotMs; slotStartMs < endMs; slotStartMs += slotMs) {
    const overlapMs = Math.min(endMs, slotStartMs + slotMs) - Math.max(startMs, slotStartMs);
    if (overlapMs > 0) out.push({ slotStartMs, valueNum: (energyKwh * overlapMs) / spanMs });
  }
  return out;
}

/**
 * Beginn der naechsten Probe derselben Reihe (gleicher Schluessel aus
 * keyOf) im selben Schreibpaket, fuer sampleEnergyBySlot({ nextStartMs }).
 * Liefert (row) => ms | null.
 */
export function nextSampleStartLookup(rows, keyOf) {
  const byKey = new Map();
  for (const row of rows || []) {
    const key = keyOf(row);
    if (key == null) continue;
    const ms = new Date(row.ts).getTime();
    if (!Number.isFinite(ms)) continue;
    let list = byKey.get(key);
    if (!list) { list = []; byKey.set(key, list); }
    list.push(ms);
  }
  for (const list of byKey.values()) list.sort((a, b) => a - b);
  return (row) => {
    const list = byKey.get(keyOf(row));
    if (!list) return null;
    const ms = new Date(row.ts).getTime();
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] <= ms) lo = mid + 1; else hi = mid;
    }
    return lo < list.length ? list[lo] : null;
  };
}

/** Wie nextSampleStartLookup fuer VRM-Importproben: je Reihe und Aufloesung. */
export function vrmNextSampleStartLookup(rows) {
  return nextSampleStartLookup(rows, (row) => (
    (row.scope || '') === 'history' && (row.source || '') === 'vrm_import'
      ? `${String(row.seriesKey || '').trim()}\u0000${Number(row.resolutionSeconds || 0)}`
      : null
  ));
}

/**
 * Beginn des 15-min-Day-Ahead (SDAC, Lieferung ab 01.10.2025 00:00 Berlin).
 * Davor war der Day-Ahead stuendlich: 24 Zeilen je Tag.
 */
export const QUARTER_HOUR_DAY_AHEAD_START_MS = Date.UTC(2025, 8, 30, 22, 0, 0);

/**
 * true, wenn die Preiszeile bei `ms` ein Stundenpreis ist: vor dem 15-min-Day-
 * Ahead, volle UTC-Stunde und keine Nachbarzeile derselben Reihe naeher als eine
 * Stunde. Der Stempel taugt dafuer nicht: der Preis-Backfill stempelte
 * Stundenpreise mit 900 s, epex-fetch.js bis Maerz 2026 15-min-Preise mit 3600 s.
 * Danach nie: der Backfill schreibt nur fehlende Slots, ein einzelner 15-min-
 * Preis um :00 darf nicht fuer :15/:30/:45 gelten (Gegenpruefung 25.10.2026).
 * Dieselbe Regel steht als SQL in hourlyPriceExpansionCteSql.
 */
function isHourlyPriceRow(ms, prevMs, nextMs) {
  if (!Number.isFinite(ms) || ms >= QUARTER_HOUR_DAY_AHEAD_START_MS || ms % PRICE_HOUR_MS !== 0) return false;
  if (Number.isFinite(prevMs) && ms - prevMs < PRICE_HOUR_MS) return false;
  if (Number.isFinite(nextMs) && nextMs - ms < PRICE_HOUR_MS) return false;
  return true;
}

/**
 * SQL-Gegenstueck zu expandHourlyPriceRows fuer PostgreSQL (WITH-Teile, ohne
 * das WITH). Liefert price_expanded(ts, value_num, resolution_seconds): alle
 * Preiszeilen plus Kopien der Stundenpreise fuer :15/:30/:45.
 * `rangeSql` ist eine Bedingung auf ts_utc, die eine Stunde Rand vor und nach
 * dem gewuenschten Bereich einschliesst (PRICE_COVERAGE_PAD_MS).
 */
export function hourlyPriceExpansionCteSql({ seriesKey = 'price_ct_kwh', rangeSql }) {
  if (!/^[a-z0-9_]+$/.test(seriesKey)) throw new Error(`invalid price series key: ${seriesKey}`);
  return `price_rows AS (
        SELECT ts_utc, value_num, resolution_seconds
          FROM timeseries_samples
         WHERE series_key = '${seriesKey}' AND value_num IS NOT NULL AND ${rangeSql}
      ), price_spaced AS (
        SELECT ts_utc,
               EXTRACT(EPOCH FROM ts_utc - lag(ts_utc) OVER (ORDER BY ts_utc)) AS gap_prev,
               EXTRACT(EPOCH FROM lead(ts_utc) OVER (ORDER BY ts_utc) - ts_utc) AS gap_next
          FROM (SELECT DISTINCT ts_utc FROM price_rows) AS d
      ), price_hourly AS (
        SELECT ts_utc FROM price_spaced
         WHERE ts_utc < TIMESTAMPTZ '${new Date(QUARTER_HOUR_DAY_AHEAD_START_MS).toISOString()}'
           AND EXTRACT(EPOCH FROM ts_utc)::bigint % 3600 = 0
           AND COALESCE(gap_prev, 3600) >= 3600
           AND COALESCE(gap_next, 3600) >= 3600
      ), price_expanded AS (
        SELECT ts_utc AS ts, value_num, resolution_seconds FROM price_rows
        UNION ALL
        SELECT r.ts_utc + q.k * interval '900 seconds', r.value_num, r.resolution_seconds
          FROM price_rows r
          JOIN price_hourly h ON h.ts_utc = r.ts_utc
         CROSS JOIN (VALUES (1), (2), (3)) AS q(k)
      )`;
}

/** Zeitraum, den die Preisabfragen zusaetzlich lesen muessen (Stunde davor/danach). */
export const PRICE_COVERAGE_PAD_MS = PRICE_HOUR_MS;

/**
 * Ergaenzt Stundenpreis-Zeilen um Kopien fuer :15, :30 und :45 ihrer Stunde,
 * damit jede Viertelstunde einen Preis findet. Zeilen: { series_key, ts_utc,
 * resolution_seconds, value_num } wie aus den Stores. Die Kopien tragen
 * ts_utc als ISO-String; die Gewichtung (resolution_seconds) bleibt gleich.
 * Die Zeilen sollten eine Stunde vor und nach dem gewuenschten Bereich
 * enthalten (PRICE_COVERAGE_PAD_MS), sonst fehlen Nachbarn am Rand.
 */
export function expandHourlyPriceRows(rows) {
  const bySeries = new Map();
  for (const row of rows || []) {
    const ms = priceTsMs(row.ts_utc);
    if (!Number.isFinite(ms)) continue;
    const key = row.series_key ?? '';
    let byTs = bySeries.get(key);
    if (!byTs) { byTs = new Map(); bySeries.set(key, byTs); }
    const list = byTs.get(ms) || [];
    list.push(row);
    byTs.set(ms, list);
  }
  const out = [...(rows || [])];
  for (const byTs of bySeries.values()) {
    const times = [...byTs.keys()].sort((a, b) => a - b);
    for (let index = 0; index < times.length; index += 1) {
      const ms = times[index];
      const group = byTs.get(ms);
      if (!isHourlyPriceRow(ms, times[index - 1], times[index + 1])) continue;
      for (let quarter = 1; quarter < 4; quarter += 1) {
        const ts = new Date(ms + quarter * PRICE_QUARTER_MS).toISOString();
        for (const row of group) out.push({ ...row, ts_utc: ts });
      }
    }
  }
  return out;
}

const OPTIMIZER_TARGET_MAP = {
  gridSetpointW: { seriesKey: 'grid_setpoint_w', unit: 'W' },
  chargeCurrentA: { seriesKey: 'charge_current_a', unit: 'A' },
  minSocPct: { seriesKey: 'min_soc_pct', unit: '%' }
};

export function buildOptimizerRunPayload({ optimizer, body, source, ts = new Date().toISOString() }) {
  const series = [];
  for (const [key, meta] of Object.entries(OPTIMIZER_TARGET_MAP)) {
    const value = Number(body?.[key]);
    if (!Number.isFinite(value)) continue;
    series.push({
      seriesKey: meta.seriesKey,
      scope: 'output',
      ts,
      resolutionSeconds: 3600,
      value,
      unit: meta.unit
    });
  }

  return {
    optimizer,
    status: 'applied',
    source,
    inputJson: null,
    resultJson: body || {},
    series
  };
}
