// services/raw-retention.js — wann 5-s-Rohwerte weg dürfen, und wie.
//
// SCHNITTSTELLE (Speicher-Konzept 23.11.2026, S3/S4; Zusammenführen mit
// feat/speicher-stufen-1min): „Rohwerte älter als X dürfen weg, wenn die
// verdichteten Werte (1 min / 15 min) dafür vorhanden sind.“
//
//   rawCompactedUntil(query) → Date | null
//     Bis wohin sind die Rohwerte verdichtet? Rohwerte JÜNGER als dieser
//     Zeitpunkt werden nie entfernt. null = nichts verdichtet → nichts löschen.
//     Seit 24.11.2026: aggregatedUntil() der Datenstufen (telemetry-tiers.js) —
//     bis dahin stehen 1-min- UND 15-min-Werte für ALLE Reihen vollständig.
//     Vorher war es der letzte Slot in energy_slots_15m (nur Energie-Reihen).
//
//   rawPruneCutoff({ keepDays, now, compactedUntil }) → Date | null
//     min(jetzt − keepDays, compactedUntil); null, wenn nichts weg darf.
//
//   pruneRawBefore(db, { before, timescale }) → { mode, before }
//     Entfernt 5-s-LIVE-Rohwerte vor `before`. Preise (series_key price%) und
//     Nicht-Live-Reihen (Importe, Altdaten) bleiben immer. Mit TimescaleDB
//     blockweise per drop_chunks (geht auch unter Apache; Preise/Altdaten
//     werden in derselben Transaktion gesichert und zurückgeschrieben), ohne
//     TimescaleDB in Portionen per DELETE.
//
// Aufrufer: storage-guard.js (Profil-Aufbewahrung je Lauf und Notfall-Stufen
// bei „kritisch“).

import { aggregatedUntil, TIER_SOURCE_MAX_RES_S } from './telemetry-tiers.js';

// Was keine Aufbewahrung löscht: Preise, Nicht-Live-Reihen (Importe, Altdaten) und grobe Live-Proben (≥ 15 min,
// z. B. nach einer langen Abfragepause) — die Stufen verdichten sie nicht, ohne sie wären sie ersatzlos weg
// (Codex Integration 24.11.). Sie sind selten und klein.
const KEEP_ROWS_SQL = `(scope <> 'live' OR series_key LIKE 'price%' OR resolution_seconds >= ${TIER_SOURCE_MAX_RES_S})`;
const FINE_LIVE_SQL = `scope = 'live' AND series_key NOT LIKE 'price%' AND resolution_seconds < ${TIER_SOURCE_MAX_RES_S}`;

export async function rawCompactedUntil(query) {
  const v = await aggregatedUntil({ query });
  return v ? new Date(v) : null;
}

export function rawPruneCutoff({ keepDays, now = Date.now(), compactedUntil }) {
  if (!(Number(keepDays) > 0) || !compactedUntil) return null;
  const t = Math.min(now - Number(keepDays) * 86_400_000, new Date(compactedUntil).getTime());
  return Number.isFinite(t) ? new Date(t) : null;
}

/** Alter des ältesten 5-s-Live-Rohwerts in Tagen (oder null). */
export async function oldestLiveRawDays(query) {
  const r = await query(`SELECT extract(epoch FROM now() - (SELECT min(ts_utc) FROM timeseries_samples WHERE ${FINE_LIVE_SQL})) / 86400 AS d`);
  const d = Number(r.rows?.[0]?.d);
  return Number.isFinite(d) ? d : null;
}

/** Ältester 5-s-Live-Rohwert (ohne Preise) als ms, oder null. */
export async function oldestLiveRawMs(query) {
  const r = await query(`SELECT min(ts_utc) AS t FROM timeseries_samples WHERE ${FINE_LIVE_SQL}`);
  const v = r.rows?.[0]?.t;
  return v ? new Date(v).getTime() : null;
}

/**
 * Nächste Einheit für den Notfall-Pfad: mit TimescaleDB der älteste Block (nur
 * ganze Blöcke lassen sich ohne Umbau löschen — auch alte 7-Tage-Blöcke), sonst
 * der älteste UTC-Tag. { fromMs, toMs } oder null.
 */
export async function oldestRawUnit(query, { timescale }) {
  const oldest = await oldestLiveRawMs(query);
  if (oldest == null) return null;
  if (timescale) {
    try {
      const r = await query(`SELECT range_start, range_end FROM timescaledb_information.chunks
        WHERE hypertable_name = 'timeseries_samples' AND range_end > $1 ORDER BY range_start LIMIT 1`, [new Date(oldest).toISOString()]);
      const c = r.rows?.[0];
      if (c?.range_start && c?.range_end) return { fromMs: new Date(c.range_start).getTime(), toMs: new Date(c.range_end).getTime() };
    } catch { /* dann tageweise */ }
  }
  const day = Math.floor(oldest / 86_400_000) * 86_400_000;
  return { fromMs: day, toMs: day + 86_400_000 };
}

/**
 * Stehen für JEDE Viertelstunde in [fromMs, toMs), in der es 5-s-Live-Rohwerte
 * gibt, 15-min-Werte da — und zwar JE REIHE (series_key, scope, source)? Ersatz
 * ist die Stufe timeseries_samples_15m derselben Reihe oder, für die
 * Energie-Reihen, ein Slot in energy_slots_15m mit demselben series_key. Eine
 * einzelne Zeile reicht nicht (Codex ee43127e), eine Zeile einer ANDEREN Reihe
 * auch nicht (Codex Integration 24.11., P1): auf einer aufgerüsteten Box steht
 * energy_slots_15m schon für jede Viertelstunde, die Stufen sind aber noch nicht
 * nachgefüllt — Spannungen, Phasen usw. wären sonst ohne Ersatz weg.
 * Ungültige Proben („invalid“) und Proben ohne Wert zählen nicht — sie
 * verdichten die Stufen nie und sperrten das Löschen sonst für immer. Grobe
 * Live-Proben (≥ 15 min) zählen nicht: pruneRawBefore behält sie (KEEP_ROWS_SQL).
 * Fehlt die Stufen-Tabelle, zählt nur energy_slots_15m.
 */
export async function has15mFor(query, fromMs, toMs) {
  const p = [new Date(fromMs).toISOString(), new Date(toMs).toISOString()];
  const raw = `SELECT DISTINCT date_bin('15 minutes', ts_utc, TIMESTAMPTZ '2000-01-01') AS q, series_key, scope, source
      FROM timeseries_samples
      WHERE ${FINE_LIVE_SQL} AND ts_utc >= $1 AND ts_utc < $2
        AND quality <> 'invalid' AND (value_num IS NOT NULL OR value_text IS NOT NULL)`;
  const energy = `EXISTS (SELECT 1 FROM energy_slots_15m e WHERE e.slot_start_utc = r.q AND e.series_key = r.series_key)`;
  const withTier = `SELECT count(*) AS missing FROM (${raw}) r
      WHERE NOT ${energy}
        AND NOT EXISTS (SELECT 1 FROM timeseries_samples_15m t
          WHERE t.series_key = r.series_key AND t.scope = r.scope AND t.source = r.source AND t.bucket_ts = r.q)`;
  const energyOnly = `SELECT count(*) AS missing FROM (${raw}) r WHERE NOT ${energy}`;
  let r;
  try { r = await query(withTier, p); } catch (e) {
    if (e?.code !== '42P01') throw e;
    r = await query(energyOnly, p);
  }
  return Number(r.rows?.[0]?.missing) === 0;
}

// Höchstens so viele zu rettende Zeilen im Speicher (Preise/Importe eines Blocks).
const KEEP_IN_MEMORY_MAX = 200_000;

export async function pruneRawBefore(db, { before, timescale, lowSpace = false }) {
  const iso = new Date(before).toISOString();
  if (timescale && lowSpace) {
    // Platte (fast) voll (E2E kleine Platte S4): schon die Zwischenkopie in eine
    // Temp-Tabelle scheitert („could not extend file“ — Katalog). Darum: zu
    // rettende Zeilen in den Speicher lesen, Block löschen (gibt Platz frei),
    // dann zurückschreiben. Nicht in EINER Transaktion — der Platz kommt erst
    // mit dem COMMIT des drop_chunks frei. Scheitert das Zurückschreiben, steht
    // es laut im Protokoll (Rückgabe restoreError).
    const kept = (await db.query(`SELECT * FROM timeseries_samples WHERE ts_utc < $1
      AND ${KEEP_ROWS_SQL} LIMIT ${KEEP_IN_MEMORY_MAX + 1}`, [iso])).rows || [];
    if (kept.length <= KEEP_IN_MEMORY_MAX) {
      await db.query("SELECT drop_chunks('timeseries_samples', older_than => $1::timestamptz)", [iso]);
      let restoreError = null;
      if (kept.length) {
        try {
          const cols = Object.keys(kept[0]);
          for (let i = 0; i < kept.length; i += 1000) {
            const part = kept.slice(i, i + 1000);
            const values = part.map((_, r) => `(${cols.map((__, c) => `$${r * cols.length + c + 1}`).join(',')})`).join(',');
            await db.query(`INSERT INTO timeseries_samples (${cols.map((c) => `"${c}"`).join(',')}) OVERRIDING SYSTEM VALUE VALUES ${values}
              ON CONFLICT DO NOTHING`, part.flatMap((row) => cols.map((c) => row[c])));
          }
        } catch (e) { restoreError = String(e?.message || e).slice(0, 200); }
      }
      return { mode: 'drop_chunks_low_space', before: iso, kept: kept.length, ...(restoreError ? { restoreError } : {}) };
    }
  }
  if (timescale) {
    // drop_chunks löscht ganze Blöcke mit ALLEN Reihen — darin liegen aber auch
    // Preise (die History rechnet Erlöse daraus) und importierte Altdaten. Die
    // werden vorher gesichert und danach zurückgeschrieben; nur die 5-s-Live-
    // Rohwerte gehen. Eine Transaktion: ganz oder gar nicht.
    // Nichts zu retten (keine Preise/Altdaten davor): ohne Zwischenkopie — auf
    // einer vollen Platte kann schon die Kopie scheitern (E2E kleine Platte S4).
    const keep = await db.query(`SELECT 1 FROM timeseries_samples WHERE ts_utc < $1
      AND ${KEEP_ROWS_SQL} LIMIT 1`, [iso]);
    if (!keep.rows?.length) {
      await db.query("SELECT drop_chunks('timeseries_samples', older_than => $1::timestamptz)", [iso]);
      return { mode: 'drop_chunks', before: iso };
    }
    const client = typeof db.connect === 'function' ? await db.connect() : db;
    try {
      await client.query('BEGIN');
      await client.query(`CREATE TEMP TABLE dvhub_keep_samples ON COMMIT DROP AS
        SELECT * FROM timeseries_samples
         WHERE ts_utc < $1 AND ${KEEP_ROWS_SQL}`, [iso]);
      await client.query("SELECT drop_chunks('timeseries_samples', older_than => $1::timestamptz)", [iso]);
      await client.query(`INSERT INTO timeseries_samples OVERRIDING SYSTEM VALUE SELECT * FROM dvhub_keep_samples
        ON CONFLICT DO NOTHING`);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      if (client !== db) client.release?.();
    }
    return { mode: 'drop_chunks', before: iso };
  }
  // ohne TimescaleDB: in Portionen löschen, damit nichts lange sperrt
  let rows = 0;
  for (let i = 0; i < 200; i++) {
    const d = await db.query(`DELETE FROM timeseries_samples WHERE ctid IN (
      SELECT ctid FROM timeseries_samples WHERE ${FINE_LIVE_SQL}
         AND ts_utc < $1 LIMIT 50000)`, [iso]);
    if (!d.rowCount) break;
    rows += d.rowCount;
  }
  // E2E „kleine Platte“ (24.11.): ohne VACUUM blieb der Platz gelöschter Zeilen
  // belegt und die DB wuchs weiter (957 → 1038 MB). VACUUM macht ihn für neue
  // Zeilen wieder nutzbar (keine Sperre gegen Schreiben). Ans Dateisystem geht er
  // nur mit VACUUM FULL zurück — das sperrt die Tabelle, darum nie automatisch.
  let vacuumed = false;
  if (rows > 0) {
    try { await db.query('VACUUM (ANALYZE) timeseries_samples'); vacuumed = true; } catch { /* z. B. in einer Transaktion */ }
  }
  return { mode: 'delete', before: iso, rows, vacuumed };
}
