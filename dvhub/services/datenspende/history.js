// services/datenspende/history.js — Bestandsdaten für den Nachversand an die
// Datenspende aus der DVhub-Datenbank lesen und in Spende-Messwerte umrechnen.
//
// Zwei Quellen, zeitlich lückenlos hintereinander:
//   1. energy_slots_15m (Viertelstunden, VRM-Import bzw. eigene Messung) — bis
//      die hochaufgelösten Live-Daten beginnen. Werte sind Energie je 15 min
//      (unit 'kWh', × 4000 = mittlere Leistung W) oder bereits Leistung (unit 'W').
//      VRM hat Vorrang (reicht am weitesten zurück), sonst eigene Messung.
//   2. timeseries_samples scope='live' (~5 s) — ab dann.
//
// Vorzeichen wie bei der Live-Spende: Netz + Bezug/− Einspeisung, Batterie
// + Laden/− Entladen. ACHTUNG: die VRM-Reihe `battery_power_w` in
// energy_slots_15m ist KEIN vorzeichenbehafteter Netto-Wert (Summe aus Laden
// UND Entladen, prod-geprüft 2026-09-28) — Batterie daher immer als
// battery_charge_w − battery_discharge_w.

const KWH15_TO_W = 4000;
const SLOT_SOURCES = ['vrm_import', 'local_live'];

// Zeitstempel auf volle Sekunde, Format der Spende (2026-09-28T12:00:00Z).
const isoSecond = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
const round1 = (v) => Math.round(v * 10) / 10;

function slotToW(value, unit) {
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  if (String(unit) === 'kWh') return v * KWH15_TO_W;
  if (String(unit) === 'W') return v;
  return null; // unbekannte Einheit → lieber nichts als falsch
}

// Welche Reihen brauchen wir für welche Spende-Quelle?
export function slotSeriesFor(sources) {
  const keys = [];
  if (sources.grid) keys.push('grid_import_w', 'grid_export_w');
  if (sources.pv) keys.push('pv_total_w');
  if (sources.load) keys.push('self_consumption_w');
  if (sources.battery) keys.push('battery_charge_w', 'battery_discharge_w');
  return keys;
}
export function liveSeriesFor(sources, tileIds = []) {
  const keys = [];
  if (sources.grid) keys.push('grid_import_w', 'grid_export_w');
  if (sources.pv) keys.push('pv_total_w');
  if (sources.load) keys.push('self_consumption_w');
  if (sources.battery) keys.push('battery_power_w'); // live: vorzeichenbehaftet (+Laden)
  if (sources.mqttTiles) for (const id of tileIds) keys.push(`mqtt_tile_${id}`);
  return keys;
}

// Viertelstunden-Zeilen → Messwerte { key, timestamp, power }.
// rows: { slot_start_utc, series_key, source_kind, unit, value_num }
export function slotRowsToReadings(rows, sources) {
  // pro Slot+Reihe den besten Wert (VRM vor eigener Messung)
  const best = new Map(); // `${ms}|${key}` → { rank, w }
  for (const r of rows) {
    const ms = new Date(r.slot_start_utc).getTime();
    const rank = SLOT_SOURCES.indexOf(r.source_kind);
    if (!Number.isFinite(ms) || rank < 0) continue;
    const w = slotToW(r.value_num, r.unit);
    if (w === null) continue;
    const k = `${ms}|${r.series_key}`;
    const cur = best.get(k);
    if (!cur || rank < cur.rank) best.set(k, { rank, w });
  }
  const bySlot = new Map();
  for (const [k, { w }] of best) {
    const [ms, key] = k.split('|');
    if (!bySlot.has(ms)) bySlot.set(ms, {});
    bySlot.get(ms)[key] = w;
  }
  const out = [];
  for (const ms of [...bySlot.keys()].map(Number).sort((a, b) => a - b)) {
    const s = bySlot.get(String(ms));
    const ts = isoSecond(ms);
    // Paar-Reihen: fehlt eine Seite, obwohl die andere da ist, war sie 0
    // (VRM lässt Null-Slots aus). Fehlen beide → kein Wert.
    const pair = (a, b) => (a === undefined && b === undefined ? null : (a || 0) - (b || 0));
    if (sources.grid) { const v = pair(s.grid_import_w, s.grid_export_w); if (v !== null) out.push({ key: 'grid', timestamp: ts, power: round1(v) }); }
    if (sources.pv && s.pv_total_w !== undefined) out.push({ key: 'pv', timestamp: ts, power: round1(s.pv_total_w) });
    if (sources.load && s.self_consumption_w !== undefined) out.push({ key: 'load', timestamp: ts, power: round1(s.self_consumption_w) });
    if (sources.battery) { const v = pair(s.battery_charge_w, s.battery_discharge_w); if (v !== null) out.push({ key: 'battery', timestamp: ts, power: round1(v) }); }
  }
  return out;
}

// Live-Zeilen → Messwerte. rows: { ts_utc, series_key, value_num, unit }
// Bezug/Einspeisung werden über denselben Zeitstempel gepaart; je Zähler und
// Sekunde nur ein Wert (der Server lehnt Doppelte ab).
export function liveRowsToReadings(rows, sources) {
  const netz = new Map(); // ms → { imp, exp }
  const seen = new Set();
  const out = [];
  const push = (key, ms, power) => {
    const ts = isoSecond(ms);
    const id = `${key}|${ts}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ key, timestamp: ts, power: round1(power), _ms: ms });
  };
  for (const r of rows) {
    const ms = new Date(r.ts_utc).getTime();
    const v = Number(r.value_num);
    if (!Number.isFinite(ms) || !Number.isFinite(v)) continue;
    const k = r.series_key;
    if (k === 'grid_import_w' || k === 'grid_export_w') {
      const e = netz.get(ms) || {};
      e[k === 'grid_import_w' ? 'imp' : 'exp'] = v;
      netz.set(ms, e);
    } else if (k === 'pv_total_w' && sources.pv) push('pv', ms, v);
    else if (k === 'self_consumption_w' && sources.load) push('load', ms, v);
    else if (k === 'battery_power_w' && sources.battery) push('battery', ms, v);
    else if (k.startsWith('mqtt_tile_') && sources.mqttTiles) {
      const unit = String(r.unit || 'W');
      if (unit === 'W' || unit === 'kW') push(`tile:${k.slice('mqtt_tile_'.length)}`, ms, unit === 'kW' ? v * 1000 : v);
    }
  }
  if (sources.grid) {
    for (const [ms, e] of netz) {
      if (e.imp === undefined || e.exp === undefined) continue; // nur vollständige Paare
      push('grid', ms, e.imp - e.exp);
    }
  }
  out.sort((a, b) => a._ms - b._ms);
  return out.map(({ _ms, ...r }) => r);
}

// ── DB-Abfragen (PostgreSQL, ctx.db) ─────────────────────────────────────────

export async function findHistoryBounds(db, sources) {
  const slotKeys = slotSeriesFor(sources);
  const first = slotKeys.length ? (await db.query(
    `SELECT min(slot_start_utc) AS t FROM energy_slots_15m WHERE series_key = ANY($1) AND source_kind = ANY($2)`,
    [slotKeys, SLOT_SOURCES],
  )).rows[0]?.t : null;
  const liveStart = (await db.query(
    `SELECT ts_utc AS t FROM timeseries_samples WHERE series_key = 'grid_import_w' AND scope = 'live' ORDER BY ts_utc ASC LIMIT 1`,
  )).rows[0]?.t || null;
  return {
    firstSlot: first ? new Date(first).toISOString() : null,
    liveStart: liveStart ? new Date(liveStart).toISOString() : null,
  };
}

export async function readSlotWindow(db, fromIso, toIso, sources) {
  const keys = slotSeriesFor(sources);
  if (!keys.length) return [];
  const { rows } = await db.query(
    `SELECT slot_start_utc, series_key, source_kind, unit, value_num FROM energy_slots_15m
      WHERE slot_start_utc >= $1 AND slot_start_utc < $2 AND series_key = ANY($3) AND source_kind = ANY($4)`,
    [fromIso, toIso, keys, SLOT_SOURCES],
  );
  return slotRowsToReadings(rows, sources);
}

export async function readLiveWindow(db, fromIso, toIso, sources, tileIds) {
  const keys = liveSeriesFor(sources, tileIds);
  if (!keys.length) return [];
  const { rows } = await db.query(
    `SELECT ts_utc, series_key, value_num, unit FROM timeseries_samples
      WHERE scope = 'live' AND series_key = ANY($1) AND ts_utc >= $2 AND ts_utc < $3 ORDER BY ts_utc`,
    [keys, fromIso, toIso],
  );
  return liveRowsToReadings(rows, sources);
}
