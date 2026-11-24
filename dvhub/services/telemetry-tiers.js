// services/telemetry-tiers.js — Datenstufen 5 s → 1 min → 15 min für ALLE Reihen.
//
// Christin 23.11.2026 (Konzept Speicher-Überwachung, S3 a+c): „dass die 15min
// Werte noch dazu kommen, das sollte eigentlich für jede Datenreihe gelten die
// wir aufnehmen“. Bisher gab es 15-min-Werte nur für die Energie-Reihen in
// energy_slots_15m (kWh je Slot); 26 von 43 Reihen lagen nur roh vor und wären
// beim Löschen alter Rohwerte ersatzlos weg.
//
// Was hier passiert:
//   timeseries_samples (Feinwerte, resolution_seconds < 900, jede Reihe, jeder
//   scope/source, generisch — neue Reihen kommen von selbst dazu)
//     → timeseries_samples_1m   je Reihe/scope/source und Minute
//     → timeseries_samples_15m  je Reihe/scope/source und Viertelstunde (für immer)
//   Beide Stufen entstehen in DERSELBEN Transaktion aus den Rohwerten, decken
//   also immer denselben Zeitraum ab.
//
// Je Eimer stehen ALLE Kennzahlen, damit die Stufe für jede Art Reihe stimmt,
// ohne Liste je Hersteller oder Reihe (universell):
//   n            Zahl der Proben (Zahl oder Text)
//   n_num, value_sum  Zahl und Summe der Zahlwerte (ungewichtetes Mittel wie
//                AVG(value_num) über Rohwerte, für Anzeigen, die das so rechnen)
//   covered_s    Σ resolution_seconds der Zahl-Proben (Gewicht des Mittels;
//                ≥ Eimerlänge = Eimer voll abgedeckt)
//   res_min      feinste Auflösung im Eimer (Abfragen filtern damit wie roh)
//   value_avg    zeitgewichteter Mittelwert Σ(v·res)/Σres — Leistungen, Spannungen,
//                Temperaturen, Ladestand; Σ(value_avg·covered_s) = Σ(v·res), die
//                Energie bleibt also exakt
//   value_min/max  Spitzen (Bezugsspitze, Spannungsband …)
//   value_first/last  erster/letzter Zahlwert — Zählerstände und kumulative
//                Werte (Wh), Zustände/Modi (ESS-Modus, Ladezustand des Autos)
//   value_text   letzter Text (tesla_geofence, Namen, Zustände als Text)
//   unit         letzte Einheit
// Welcher Wert beim Lesen „der“ Wert ist, entscheidet tierValueKind(): letzter
// Wert für Energie-Einheiten (Wh/kWh/MWh) und Zustände (…_mode/_state/…), sonst
// der Mittelwert. Die Regel lässt sich ändern, ohne neu zu verdichten.
// Text: letzter statt häufigster Wert — er stimmt am Eimerrand genau und lässt
// sich über Stufen fortsetzen (letzter der 15 Minutenwerte = Viertelstundenwert);
// der häufigste Wert ließe sich nicht aus den Minutenwerten bilden.
//
// Preise und Importe: Preise (price_*, tariff_*) und VRM-Importe liegen mit
// 900/3600 s in timeseries_samples und bleiben dort unangetastet — sie sind
// schon Viertelstunden- bzw. Stundenwerte. Dieses Modul löscht NIE Rohwerte.
//
// Fortschritt: telemetry_tier_state.done_until (Zeiger, 15-min-genau). Ein Lauf
// verdichtet [done_until, Ziel) in Portionen von 1 h je Transaktion; der Zeiger
// rückt nur mit dem COMMIT vor → nach Neustart geht es genau dort weiter.
// Doppelte gibt es nicht: Schlüssel (series_key, scope, source, bucket_ts),
// erneutes Verdichten ersetzt (ON CONFLICT … DO UPDATE), aber nur, wenn der
// neue Eimer mindestens so viele Proben hat (nie durch einen Rest ersetzen,
// z. B. wenn Rohwerte schon gelöscht sind).
// Spät geschriebene Feinwerte (Puffer nach DB-Ausfall, Nachladen) markiert
// writeSamples als „dirty“ (telemetry_tier_dirty, 15-min-Eimer); der nächste
// Lauf verdichtet diese Viertelstunden neu. Gegen das Rennen Schreiben ↔ Lauf
// sperren beide die Zustandszeile (FOR SHARE ↔ FOR UPDATE).
//
// Speicher: mit TimescaleDB Hypertables (1 min: Tagesblöcke, 15 min: 7-Tage-
// Blöcke), unter Community IMMER komprimiert (segmentby series_key,scope,source).
// Ohne TimescaleDB bzw. unter Apache laufen dieselben Tabellen normal bzw. als
// Hypertable ohne Kompression; Löschen alter Minutenwerte dann in Portionen.
//
// Schnittstelle für die Aufbewahrung (Speicher-Wache/Profil-Engine):
//   aggregatedUntil(db) → ISO|null   bis wohin BEIDE Stufen für alle Reihen
//                                     vollständig sind (Rohwerte davor dürfen weg)
//   tierCoverage(db)    → Details (Zeiger, offene Nachzügler, Beginn)
//   pruneOneMinuteTier(db, { olderThan })  Minutenwerte löschen, nur wo die
//                                     15-min-Werte sicher stehen

export const TIER_1M_TABLE = 'timeseries_samples_1m';
export const TIER_15M_TABLE = 'timeseries_samples_15m';
export const TIER_STATE_ID = 'tiers';
// Quelle: alles feiner als eine Viertelstunde (5-s-Live, 1-min-, 5-min-Reihen).
export const TIER_SOURCE_MAX_RES_S = 900;
// Verdichtet wird bis „jetzt − 30 min“ (Live-Werte kommen gebündelt je Minute).
export const TIER_LAG_MS = 30 * 60_000;
// writeSamples prüft nur Feinwerte, die älter als 15 min sind, auf „dirty“
// (15 min Abstand zur Lag-Grenze fangen Uhr-Unterschiede ab).
export const TIER_DIRTY_MARK_AGE_MS = 15 * 60_000;
export const TIER_PORTION_MS = 60 * 60_000;
export const TIER_RUN_BUDGET_MS = 60_000;
export const TIER_INTERVAL_MS = 5 * 60_000;
export const TIER_FIRST_RUN_DELAY_MS = 2 * 60_000;
const STORAGE_RETRY_MS = 60 * 60_000;
// Höchstens so viele 15-min-Eimer aus der Nachzügler-Liste je Transaktion.
const DIRTY_BATCH = 16;
const STATEMENT_TIMEOUT = '120s';
const QUARTER_MS = 900_000;
const ORIGIN = "TIMESTAMPTZ '2000-01-01 00:00:00+00'";

export const TIER_TABLES = Object.freeze([
  { name: '1m', table: TIER_1M_TABLE, seconds: 60, chunk: '1 day', compressAfter: '2 days' },
  { name: '15m', table: TIER_15M_TABLE, seconds: 900, chunk: '7 days', compressAfter: '7 days' },
]);

export const floorQuarterMs = (ms) => Math.floor(ms / QUARTER_MS) * QUARTER_MS;
const iso = (ms) => new Date(ms).toISOString();
const toMs = (v) => (v == null ? null : (v instanceof Date ? v.getTime() : Date.parse(v)));

// ── Welcher Wert gilt beim Lesen? ───────────────────────────────────────────
const LAST_UNITS = new Set(['wh', 'kwh', 'mwh']);
// Codex 2fe0149f: TeslaMate schreibt ohne Einheit — Ladezähler (…_added) und
// Ja/Nein-Zustände (plugged_in) zählen sonst als Mittelwert (0 → 1 würde 0,5).
const LAST_KEY_RE = /(_wh|_kwh|_mwh|_count|_counter|_mode|_state|_status|_since|_id|_added|plugged_in)$/i;
/** 'last' für Zählerstände/Energie-Summen und Zustände, sonst 'avg'. */
export function tierValueKind(seriesKey, unit) {
  if (LAST_UNITS.has(String(unit ?? '').trim().toLowerCase())) return 'last';
  if (LAST_KEY_RE.test(String(seriesKey ?? ''))) return 'last';
  return 'avg';
}
/** Der eine Wert eines Stufen-Eimers (Zahl oder null). */
export function tierRowValue(row, seriesKey = row?.series_key) {
  const kind = tierValueKind(seriesKey, row?.unit);
  const pick = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const primary = kind === 'last' ? pick(row?.value_last) : pick(row?.value_avg);
  return primary ?? (kind === 'last' ? pick(row?.value_avg) : pick(row?.value_last));
}

// ── Verdichten ──────────────────────────────────────────────────────────────
const TIER_COLUMNS = 'series_key, scope, source, bucket_ts, n, n_num, value_sum, covered_s, res_min, value_avg, value_min, value_max, value_first, value_last, value_text, unit';

/**
 * INSERT … SELECT für eine Stufe über [$1, $2). Mit scopeFilter zusätzlich
 * `scope = ANY($3)` — ohne TimescaleDB nutzt Postgres so den Index (scope, ts_utc)
 * statt die ganze Tabelle zu lesen.
 */
export function tierAggregateSql(table, seconds, { scopeFilter = false } = {}) {
  const res = 'GREATEST(resolution_seconds, 1)';
  return `
    INSERT INTO ${table} AS t (${TIER_COLUMNS})
    SELECT series_key, scope, source,
           date_bin(interval '${seconds} seconds', ts_utc, ${ORIGIN}) AS bucket_ts,
           count(*)::int,
           count(value_num)::int,
           sum(value_num),
           sum(${res}) FILTER (WHERE value_num IS NOT NULL)::float8,
           min(${res}),
           sum(value_num * ${res}) / NULLIF(sum(${res}) FILTER (WHERE value_num IS NOT NULL), 0),
           min(value_num), max(value_num),
           (array_agg(value_num ORDER BY ts_utc ASC, resolution_seconds ASC) FILTER (WHERE value_num IS NOT NULL))[1],
           (array_agg(value_num ORDER BY ts_utc DESC, resolution_seconds ASC) FILTER (WHERE value_num IS NOT NULL))[1],
           (array_agg(value_text ORDER BY ts_utc DESC, resolution_seconds ASC) FILTER (WHERE value_text IS NOT NULL))[1],
           (array_agg(unit ORDER BY ts_utc DESC) FILTER (WHERE unit IS NOT NULL))[1]
      FROM timeseries_samples
     WHERE ts_utc >= $1 AND ts_utc < $2
       AND resolution_seconds < ${TIER_SOURCE_MAX_RES_S}
       AND quality <> 'invalid'
       AND (value_num IS NOT NULL OR value_text IS NOT NULL)${scopeFilter ? '\n       AND scope = ANY($3::text[])' : ''}
     GROUP BY 1, 2, 3, 4
    ON CONFLICT (series_key, scope, source, bucket_ts) DO UPDATE SET
      n = EXCLUDED.n, n_num = EXCLUDED.n_num, value_sum = EXCLUDED.value_sum, covered_s = EXCLUDED.covered_s, res_min = EXCLUDED.res_min,
      value_avg = EXCLUDED.value_avg, value_min = EXCLUDED.value_min, value_max = EXCLUDED.value_max,
      value_first = EXCLUDED.value_first, value_last = EXCLUDED.value_last,
      value_text = EXCLUDED.value_text, unit = EXCLUDED.unit
    WHERE EXCLUDED.n >= t.n`;
}

/** Nachzügler markieren (aus writeSamples, in dessen Transaktion). */
export const MARK_DIRTY_SQL = `
  INSERT INTO telemetry_tier_dirty (bucket_ts)
  SELECT DISTINCT date_bin(interval '15 minutes', x.ts, ${ORIGIN})
    FROM unnest($1::timestamptz[]) AS x(ts)
   WHERE x.ts < (SELECT done_until FROM telemetry_tier_state WHERE id = '${TIER_STATE_ID}' FOR SHARE)
  ON CONFLICT (bucket_ts) DO NOTHING`;

/**
 * Feinwerte, die hinter dem Zeiger landen, als Nachzügler markieren. Läuft im
 * Client der Schreib-Transaktion mit SAVEPOINT: fehlt die Tabelle (Migration
 * nicht gelaufen), geht kein Messwert verloren.
 * @param {{query: Function}} client  Verbindung IN der laufenden Transaktion
 * @param {Array<{ts: any, resolutionSeconds?: number}>} rows
 * @param {number} [nowMs]
 * @returns {Promise<number>} Zahl der geprüften alten Zeitstempel (0 = nichts getan)
 */
export async function markTierDirty(client, rows, nowMs = Date.now()) {
  const limit = nowMs - TIER_DIRTY_MARK_AGE_MS;
  const old = [];
  for (const row of rows || []) {
    if (!(Number(row?.resolutionSeconds || 1) < TIER_SOURCE_MAX_RES_S)) continue;
    const ms = toMs(row.ts);
    if (Number.isFinite(ms) && ms < limit) old.push(iso(ms));
  }
  if (!old.length) return 0;
  await client.query('SAVEPOINT dvhub_tier_dirty');
  try {
    await client.query(MARK_DIRTY_SQL, [old]);
    await client.query('RELEASE SAVEPOINT dvhub_tier_dirty');
  } catch {
    await client.query('ROLLBACK TO SAVEPOINT dvhub_tier_dirty').catch(() => {});
  }
  return old.length;
}

// ── Speicherform (Hypertable, Kompression) ──────────────────────────────────
const LARGE_PLAIN_TIER_ROWS = 2_000_000;

/**
 * Stufen-Tabellen als Hypertable einrichten und (Community) komprimieren —
 * wie tuneTimescale für timeseries_samples, auch als Heilung, wenn TimescaleDB
 * erst später dazukam. Blockiert nie lange (lock_timeout), Fehler je Tabelle
 * landen im Ergebnis statt zu werfen.
 * @returns {Promise<{mode: 'plain'|'apache'|'timescale', tables: object}>}
 */
export async function ensureTierStorage(db) {
  const query = (q, p) => db.query(q, p);
  const ext = await query("SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'");
  if (!ext.rows?.length) return { mode: 'plain', tables: {} };
  const lic = (await query("SELECT current_setting('timescaledb.license', true) AS lic")).rows?.[0]?.lic;
  const community = lic === 'timescale';
  const tables = {};
  for (const t of TIER_TABLES) {
    const out = { hypertable: false, compression: false, changed: [] };
    tables[t.name] = out;
    try {
      const hyper = await query(
        'SELECT compression_enabled AS c FROM timescaledb_information.hypertables WHERE hypertable_name = $1', [t.table]);
      out.hypertable = hyper.rows?.length > 0;
      out.compression = hyper.rows?.[0]?.c === true;
      if (!out.hypertable) {
        // Später nachgerüstet und schon groß: lieber normale Tabelle lassen,
        // als die Daten beim Start minutenlang umzuziehen.
        const big = await query(`SELECT count(*)::int AS n FROM (SELECT 1 FROM ${t.table} LIMIT ${LARGE_PLAIN_TIER_ROWS + 1}) x`);
        if (Number(big.rows?.[0]?.n) > LARGE_PLAIN_TIER_ROWS) { out.skipped = 'large_plain_table'; continue; }
        await inTransaction(db, async (c) => {
          await c.query("SET LOCAL lock_timeout = '10s'");
          await c.query(`SELECT create_hypertable('${t.table}', 'bucket_ts', chunk_time_interval => INTERVAL '${t.chunk}',
            migrate_data => true, if_not_exists => true, create_default_indexes => false)`);
        });
        out.hypertable = true;
        out.changed.push('hypertable');
      }
      if (!community) continue;
      if (!out.compression) {
        await inTransaction(db, async (c) => {
          await c.query("SET LOCAL lock_timeout = '10s'");
          await c.query(`ALTER TABLE ${t.table} SET (timescaledb.compress,
            timescaledb.compress_segmentby = 'series_key,scope,source', timescaledb.compress_orderby = 'bucket_ts DESC')`);
        });
        out.compression = true;
        out.changed.push('compression_enabled');
      }
      const job = await query(`SELECT config->>'compress_after' AS after FROM timescaledb_information.jobs
        WHERE proc_name = 'policy_compression' AND hypertable_name = $1`, [t.table]);
      if (!job.rows?.length) {
        await query(`SELECT add_compression_policy('${t.table}', compress_after => INTERVAL '${t.compressAfter}', if_not_exists => true)`);
        out.changed.push('compression_policy');
      }
    } catch (e) {
      out.error = String(e?.message || e).slice(0, 200);
    }
  }
  return { mode: community ? 'timescale' : 'apache', tables };
}

async function inTransaction(db, fn) {
  const client = typeof db.connect === 'function' ? await db.connect() : db;
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    if (client !== db) client.release?.();
  }
}

// ── Abdeckung (Schnittstelle für die Aufbewahrung) ──────────────────────────
/**
 * Stand der Stufen.
 * @returns {Promise<{available: boolean, cursor: string|null, dirtyFrom: string|null,
 *   dirtyCount: number, startedFrom: string|null, until: string|null, updatedAt: string|null}>}
 *   until = min(cursor, dirtyFrom): davor sind 1-min- UND 15-min-Werte aller
 *   Reihen vollständig. null = noch nichts verdichtet bzw. Tabellen fehlen.
 */
export async function tierCoverage(db) {
  const none = { available: false, cursor: null, dirtyFrom: null, dirtyCount: 0, startedFrom: null, until: null, updatedAt: null };
  let r;
  try {
    r = await db.query(`SELECT s.done_until, s.started_from, s.updated_at,
        (SELECT min(bucket_ts) FROM telemetry_tier_dirty) AS dirty_from,
        (SELECT count(*)::int FROM telemetry_tier_dirty) AS dirty_n
      FROM telemetry_tier_state s WHERE s.id = $1`, [TIER_STATE_ID]);
  } catch (e) {
    if (e?.code === '42P01') return none;   // Migration noch nicht gelaufen
    throw e;
  }
  const row = r.rows?.[0];
  if (!row) return none;
  const cursor = toMs(row.done_until);
  const dirty = toMs(row.dirty_from);
  const until = cursor == null ? null : (dirty != null && dirty < cursor ? dirty : cursor);
  return {
    available: true,
    cursor: cursor == null ? null : iso(cursor),
    dirtyFrom: dirty == null ? null : iso(dirty),
    dirtyCount: Number(row.dirty_n) || 0,
    startedFrom: row.started_from ? iso(toMs(row.started_from)) : null,
    until: until == null ? null : iso(until),
    updatedAt: row.updated_at ? iso(toMs(row.updated_at)) : null,
  };
}

/**
 * Bis wann sind die 1-min- und die 15-min-Werte für ALLE Reihen vollständig?
 * Feinwerte (timeseries_samples, resolution_seconds < 900) mit ts_utc < Ergebnis
 * stehen verdichtet in beiden Stufen; nur DAVOR dürfen Rohwerte weg.
 * @param {{query: Function}} db
 * @returns {Promise<string|null>} ISO-Zeitpunkt (15-min-genau) oder null = nichts löschen
 */
export async function aggregatedUntil(db) {
  return (await tierCoverage(db)).until;
}

/**
 * Minutenwerte älter als `olderThan` löschen — nie jünger als aggregatedUntil
 * (die 15-min-Werte bleiben für immer). Mit TimescaleDB ganze Blöcke
 * (drop_chunks), sonst DELETE in Portionen (keine langen Sperren).
 * @returns {Promise<{cutoff: string|null, droppedChunks: number, deletedRows: number}>}
 */
export async function pruneOneMinuteTier(db, { olderThan, batchRows = 20_000, maxBatches = 500 } = {}) {
  const until = toMs(await aggregatedUntil(db));
  const wanted = toMs(olderThan);
  if (until == null || !Number.isFinite(wanted)) return { cutoff: null, droppedChunks: 0, deletedRows: 0 };
  const cutoff = iso(floorQuarterMs(Math.min(wanted, until)));
  const hyper = await isHypertable(db, TIER_1M_TABLE);
  if (hyper) {
    const r = await db.query(`SELECT count(*)::int AS n FROM drop_chunks('${TIER_1M_TABLE}', older_than => $1::timestamptz)`, [cutoff]);
    return { cutoff, droppedChunks: Number(r.rows?.[0]?.n) || 0, deletedRows: 0 };
  }
  let deleted = 0;
  for (let i = 0; i < maxBatches; i++) {
    const d = await db.query(`DELETE FROM ${TIER_1M_TABLE} WHERE ctid IN (
      SELECT ctid FROM ${TIER_1M_TABLE} WHERE bucket_ts < $1 LIMIT ${Math.max(1, Math.floor(batchRows))})`, [cutoff]);
    deleted += d.rowCount || 0;
    if (!d.rowCount) break;
  }
  // Platz der gelöschten Zeilen wieder nutzbar machen (E2E „kleine Platte“ 24.11.).
  if (deleted > 0) { try { await db.query(`VACUUM (ANALYZE) ${TIER_1M_TABLE}`); } catch { /* egal */ } }
  return { cutoff, droppedChunks: 0, deletedRows: deleted };
}

async function isHypertable(db, table) {
  try {
    const r = await db.query('SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = $1', [table]);
    return r.rows?.length > 0;
  } catch {
    return false;   // keine TimescaleDB
  }
}

// ── Lauf ────────────────────────────────────────────────────────────────────
/** Alle scope-Werte über den Index (scope, ts_utc), ohne die Tabelle zu lesen. */
const DISTINCT_SCOPES_SQL = `
  WITH RECURSIVE s AS (
    (SELECT scope FROM timeseries_samples ORDER BY scope LIMIT 1)
    UNION ALL
    SELECT (SELECT t.scope FROM timeseries_samples t WHERE t.scope > s.scope ORDER BY t.scope LIMIT 1)
      FROM s WHERE s.scope IS NOT NULL
  ) SELECT scope FROM s WHERE scope IS NOT NULL`;

/**
 * Laufender Verdichter. Ein Lauf: erst Nachzügler, dann vorwärts bis
 * „jetzt − TIER_LAG_MS“, höchstens budgetMs lang, eine Transaktion je Portion.
 */
export function createTelemetryTiers({
  getDb, pushLog, now = () => Date.now(),
  portionMs = TIER_PORTION_MS, lagMs = TIER_LAG_MS, budgetMs = TIER_RUN_BUDGET_MS,
  // Platz-Wache „kritisch“ (E2E kleine Platte S4, 24.11.): Rückfüllung ruht, sie
  // würde den letzten Platz in die Stufen-Tabellen schreiben. Den nächsten zu
  // löschenden Tag verdichtet die Wache selbst (aggregateRange).
  isPaused = () => false,
} = {}) {
  let running = false;
  let last = null;
  let storage = null;
  let storageAt = 0;
  let timer = null;
  const log = (e, d, lvl) => { try { pushLog?.(e, d, lvl); } catch { /* egal */ } };

  // Ohne TimescaleDB: scope-Liste für den Index (scope, ts_utc). Sie wird in
  // JEDER Portion unter der Zustandssperre neu gelesen (Codex e6fed14e): ein
  // Nachzügler mit neuem scope, der vor der Sperre committet, ist sonst nicht
  // in der Liste, und seine Nachzügler-Marke würde trotzdem gelöscht.
  async function scopesNow(client) {
    const r = await client.query(DISTINCT_SCOPES_SQL);
    return (r.rows || []).map((x) => x.scope);
  }

  /** Nächster Feinwert ab fromMs (für Lücken und den ersten Start). */
  async function nextFineMs(client, fromMs, layout) {
    const r = layout.scopes
      ? await client.query(`SELECT min(x.ts) AS ts FROM unnest($2::text[]) AS s(scope)
          CROSS JOIN LATERAL (SELECT ts_utc AS ts FROM timeseries_samples t
             WHERE t.scope = s.scope AND t.ts_utc >= $1 AND t.resolution_seconds < ${TIER_SOURCE_MAX_RES_S}
               AND t.quality <> 'invalid' ORDER BY t.ts_utc LIMIT 1) x`, [iso(fromMs), layout.scopes])
      : await client.query(`SELECT ts_utc AS ts FROM timeseries_samples
          WHERE ts_utc >= $1 AND resolution_seconds < ${TIER_SOURCE_MAX_RES_S} AND quality <> 'invalid'
          ORDER BY ts_utc LIMIT 1`, [iso(fromMs)]);
    return toMs(r.rows?.[0]?.ts);
  }

  async function aggregateWindow(client, aMs, bMs, layout) {
    const params = layout.scopes ? [iso(aMs), iso(bMs), layout.scopes] : [iso(aMs), iso(bMs)];
    let rows = 0;
    for (const t of TIER_TABLES) {
      const r = await client.query(tierAggregateSql(t.table, t.seconds, { scopeFilter: !!layout.scopes }), params);
      if (t.seconds === 60) rows = r.rowCount || 0;
    }
    return rows;
  }

  /** Eine Portion in einer Transaktion. Liefert, was getan wurde, oder null (nichts zu tun / gesperrt). */
  async function step(db, hypertable, targetMs) {
    const client = typeof db.connect === 'function' ? await db.connect() : db;
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
      const st = await client.query(
        'SELECT done_until FROM telemetry_tier_state WHERE id = $1 FOR UPDATE SKIP LOCKED', [TIER_STATE_ID]);
      if (!st.rows?.length) { await client.query('ROLLBACK'); return { busy: true }; }
      const layout = { scopes: hypertable ? null : await scopesNow(client) };
      let cursor = toMs(st.rows[0].done_until);
      // 1. Nachzügler (Viertelstunden hinter dem Zeiger).
      const dirty = await client.query(
        `SELECT bucket_ts FROM telemetry_tier_dirty ORDER BY bucket_ts LIMIT ${DIRTY_BATCH}`);
      if (dirty.rows?.length) {
        const buckets = dirty.rows.map((x) => toMs(x.bucket_ts));
        // Zusammenhängende Viertelstunden in einem Fenster.
        let start = buckets[0]; let end = start + QUARTER_MS;
        const windows = [];
        for (const b of buckets.slice(1)) {
          if (b === end) { end += QUARTER_MS; continue; }
          windows.push([start, end]); start = b; end = b + QUARTER_MS;
        }
        windows.push([start, end]);
        for (const [a, b] of windows) await aggregateWindow(client, a, b, layout);
        await client.query('DELETE FROM telemetry_tier_dirty WHERE bucket_ts = ANY($1::timestamptz[])', [buckets.map(iso)]);
        await client.query('UPDATE telemetry_tier_state SET updated_at = now() WHERE id = $1', [TIER_STATE_ID]);
        await client.query('COMMIT');
        return { dirty: buckets.length };
      }
      // 2. Erster Lauf: beim ältesten Feinwert beginnen (ohne Daten: beim Ziel).
      if (cursor == null) {
        const first = await nextFineMs(client, 0, layout);
        cursor = first == null ? targetMs : Math.min(floorQuarterMs(first), targetMs);
        await client.query('UPDATE telemetry_tier_state SET done_until = $2, started_from = $2, updated_at = now() WHERE id = $1',
          [TIER_STATE_ID, iso(cursor)]);
        await client.query('COMMIT');
        return { initialized: iso(cursor) };
      }
      if (cursor >= targetMs) { await client.query('ROLLBACK'); return null; }
      // 3. Vorwärts: eine Portion, leere Strecken überspringen.
      let b = Math.min(cursor + portionMs, targetMs);
      const rows = await aggregateWindow(client, cursor, b, layout);
      if (rows === 0 && b < targetMs) {
        const next = await nextFineMs(client, b, layout);
        b = next == null || next >= targetMs ? targetMs : Math.max(b, floorQuarterMs(next));
      }
      await client.query('UPDATE telemetry_tier_state SET done_until = $2, started_from = COALESCE(started_from, $3), updated_at = now() WHERE id = $1',
        [TIER_STATE_ID, iso(b), iso(cursor)]);
      await client.query('COMMIT');
      return { from: iso(cursor), to: iso(b), rows };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      if (client !== db) client.release?.();
    }
  }

  /**
   * Ein Lauf. budgetMs begrenzt die Zeit (erste Runde auf einer alten Box
   * verteilt sich so über viele Läufe).
   * @returns {Promise<object|null>}
   */
  async function runOnce({ budget = budgetMs } = {}) {
    if (running) return last;
    try { if (isPaused?.()) return last; } catch { /* egal */ }
    running = true;
    const startedAt = now();
    const out = { at: iso(startedAt), portions: 0, dirty: 0, rows: 0, from: null, to: null, done: false };
    try {
      const db = getDb?.();
      if (!db || typeof db.query !== 'function') return last;
      // Einrichtung (Hypertable/Kompression) erneut versuchen, solange sie einen
      // Fehler meldet — höchstens einmal je Stunde (Codex 2fe0149f: ein kurzer
      // Sperr-Timeout ließ eine Stufe sonst bis zum Neustart unkomprimiert).
      const storageFailed = storage && Object.values(storage.tables || {}).some((t) => t.error);
      if (!storage || (storageFailed && now() - storageAt >= STORAGE_RETRY_MS)) {
        storage = await ensureTierStorage(db);
        storageAt = now();
        if (Object.values(storage.tables).some((t) => t.changed?.length || t.error || t.skipped)) log('telemetry_tiers_storage', storage);
      }
      const hypertable = await isHypertable(db, 'timeseries_samples');
      const targetMs = floorQuarterMs(now() - lagMs);
      // Mindestens ein Schritt je Lauf, dann bis das Zeitbudget aufgebraucht ist.
      do {
        const r = await step(db, hypertable, targetMs);
        if (!r || r.busy) { out.done = !r; out.busy = !!r?.busy; break; }
        out.portions += 1;
        if (r.dirty) out.dirty += r.dirty;
        if (r.rows) out.rows += r.rows;
        if (r.from && !out.from) out.from = r.from;
        if (r.to) out.to = r.to;
      } while (now() - startedAt < budget);
      out.coverage = await tierCoverage(db);
      last = out;
      return out;
    } catch (e) {
      out.error = String(e?.message || e).slice(0, 300);
      log('telemetry_tiers_error', { error: out.error }, 'warn');
      last = out;
      return out;
    } finally {
      running = false;
    }
  }

  /**
   * Einen Zeitraum synchron in 1 min UND 15 min verdichten (alle Reihen), ohne
   * den Zeiger zu bewegen — für den Notfall-Pfad der Platz-Wache: erst diesen
   * Tag verdichten, dann seine Rohwerte löschen. Ersetzt vorhandene Eimer nur
   * mit mindestens so vielen Proben (wie der normale Lauf).
   * @returns {Promise<number>} Zahl der 1-min-Eimer
   */
  async function aggregateRange(fromMs, toMs) {
    const db = getDb?.();
    if (!db || typeof db.query !== 'function') throw new Error('keine Datenbank');
    const a = floorQuarterMs(fromMs); const b = floorQuarterMs(toMs);
    if (!(b > a)) return 0;
    const hypertable = await isHypertable(db, 'timeseries_samples');
    return inTransaction(db, async (client) => {
      await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
      const layout = { scopes: hypertable ? null : await scopesNow(client) };
      return aggregateWindow(client, a, b, layout);
    });
  }

  return {
    runOnce,
    aggregateRange,
    status: () => ({ last, storage }),
    aggregatedUntil: () => { const db = getDb?.(); return db ? aggregatedUntil(db) : Promise.resolve(null); },
    coverage: () => { const db = getDb?.(); return db ? tierCoverage(db) : Promise.resolve(null); },
    pruneOneMinuteTier: (opts) => { const db = getDb?.(); return db ? pruneOneMinuteTier(db, opts) : Promise.resolve(null); },
    start() {
      if (timer) return;
      setTimeout(() => { runOnce().catch(() => {}); }, TIER_FIRST_RUN_DELAY_MS).unref?.();
      timer = setInterval(() => { runOnce().catch(() => {}); }, TIER_INTERVAL_MS);
      timer.unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}

// ── Lesen (Rückfall, wenn Rohwerte fehlen) ──────────────────────────────────
/**
 * Stufen-Eimer je Reihe für Lücken [from, until) lesen und auf rebinSec
 * zusammenfassen ($1 keys, $2 froms, $3 untils je Lücke; $4/$5 Gesamtbereich
 * für Index/Blockauswahl; $6 Ausgaberaster in s; $7 Auflösungsfilter).
 */
export function tierReadSql(table, tierSeconds) {
  return `
    SELECT t.series_key,
           date_bin(make_interval(secs => $6), t.bucket_ts, ${ORIGIN}) AS b,
           sum(t.value_avg * t.covered_s) / NULLIF(sum(t.covered_s) FILTER (WHERE t.value_avg IS NOT NULL), 0) AS value_avg,
           min(t.value_min) AS value_min, max(t.value_max) AS value_max,
           (array_agg(t.value_first ORDER BY t.bucket_ts ASC) FILTER (WHERE t.value_first IS NOT NULL))[1] AS value_first,
           (array_agg(t.value_last ORDER BY t.bucket_ts DESC) FILTER (WHERE t.value_last IS NOT NULL))[1] AS value_last,
           (array_agg(t.value_text ORDER BY t.bucket_ts DESC) FILTER (WHERE t.value_text IS NOT NULL))[1] AS value_text,
           (array_agg(t.unit ORDER BY t.bucket_ts DESC) FILTER (WHERE t.unit IS NOT NULL))[1] AS unit,
           sum(t.n)::int AS n, sum(t.n_num)::int AS n_num, sum(t.value_sum) AS value_sum,
           sum(t.covered_s) AS covered_s, min(t.res_min) AS res_min
      FROM unnest($1::text[], $2::timestamptz[], $3::timestamptz[]) AS r(k, f, u)
      JOIN ${table} t ON t.series_key = r.k
     WHERE t.bucket_ts >= $4 AND t.bucket_ts < $5
       AND t.bucket_ts >= r.f AND t.bucket_ts + interval '${tierSeconds} seconds' <= r.u
       AND t.res_min <= $7
     GROUP BY 1, 2
     ORDER BY 2, 1`;
}

/**
 * Lücken je Reihe auf dem Raster gridMs: alle ganzen Raster-Eimer in
 * [startMs, endMs), die keine belegte Spanne berührt. Eine Rohzeile belegt
 * ihre ganze Dauer (resolution_seconds), eine Stunden-Zeile also vier
 * Viertelstunden (Codex d4f9ddc0).
 * @param {Array<number|[number, number]>} occupied  Zeitpunkte (ms) oder Spannen [von, bis)
 * @returns {Array<[number, number]>}
 */
export function gapIntervals(occupied, startMs, endMs, gridMs) {
  const from0 = Math.ceil(startMs / gridMs) * gridMs;
  const until0 = Math.floor(endMs / gridMs) * gridMs;
  if (until0 - from0 < gridMs) return [];
  const spans = [];
  for (const o of occupied || []) {
    const [a, b] = Array.isArray(o) ? o : [o, o + 1];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    // auf das Raster erweitern: jeder berührte Eimer gilt als belegt
    const lo = Math.floor(a / gridMs) * gridMs;
    const hi = Math.ceil(Math.max(b, a + 1) / gridMs) * gridMs;
    if (hi > from0 && lo < until0) spans.push([lo, hi]);
  }
  spans.sort((x, y) => x[0] - y[0]);
  const out = [];
  let cur = from0;
  for (const [lo, hi] of spans) {
    if (lo - cur >= gridMs) out.push([cur, lo]);
    cur = Math.max(cur, hi);
  }
  if (until0 - cur >= gridMs) out.push([cur, until0]);
  return out;
}

/**
 * Rückfall auf die Stufen je Lücke: Wo im Ausgaberaster kein Rohwert liegt
 * (Rohwerte gelöscht), kommen die 1-min-Eimer, und wo auch die fehlen
 * (Minutenwerte gelöscht), die 15-min-Eimer. Ein Raster-Eimer mit Rohwert
 * bekommt nie etwas aus den Stufen — mit vollständigen Rohwerten bleibt die
 * Antwort unverändert, auch wenn eine einzelne Rohprobe mitten in einem
 * gelöschten Zeitraum liegt (Codex e6fed14e).
 * @param {{query: Function}} db
 * @param {object} o
 * @param {string[]} o.keys
 * @param {Map<string, Array<number|[number, number]>>} o.rawTimesByKey  key → Rohzeilen im Ergebnis als Zeitpunkt oder Spanne [von, bis) in ms
 * @param {number} o.startMs
 * @param {number} o.endMs
 * @param {number|null} o.bucketSec  Ausgabe-Raster (null = Stufe unverändert)
 * @param {number} [o.resLimit]  wie die Roh-Abfrage: nur Eimer mit res_min ≤ resLimit
 * @returns {Promise<Array<{key, tsMs, row, resolution, tier}>>}
 */
export async function readTierFallback(db, { keys, rawTimesByKey, startMs, endMs, bucketSec = null, resLimit = TIER_SOURCE_MAX_RES_S }) {
  const out = [];
  const plan = Number(bucketSec) >= 900 ? [TIER_TABLES[1]] : TIER_TABLES;
  const occupied = new Map(keys.map((k) => [k, [...(rawTimesByKey.get(k) || [])]]));
  for (const t of plan) {
    const rebin = Math.max(t.seconds, Number(bucketSec) > 0 ? Number(bucketSec) : t.seconds);
    const ks = []; const fs = []; const us = [];
    for (const k of keys) {
      for (const [f, u] of gapIntervals(occupied.get(k), startMs, endMs, rebin * 1000)) {
        ks.push(k); fs.push(iso(f)); us.push(iso(u));
      }
    }
    if (!ks.length) break;
    const r = await db.query(tierReadSql(t.table, t.seconds), [ks, fs, us, iso(startMs), iso(endMs), rebin, resLimit]);
    const wanted = new Set(ks);
    for (const row of r.rows || []) {
      const ms = toMs(row.b);
      if (!Number.isFinite(ms) || !wanted.has(row.series_key)) continue;
      occupied.get(row.series_key).push([ms, ms + rebin * 1000]);   // gefüllt: die gröbere Stufe nicht noch einmal
      out.push({ key: row.series_key, tsMs: ms, row, resolution: rebin, tier: t.name });
    }
  }
  return out.sort((a, b) => a.tsMs - b.tsMs || String(a.key).localeCompare(String(b.key)));
}
