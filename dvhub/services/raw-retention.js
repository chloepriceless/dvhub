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

import { aggregatedUntil } from './telemetry-tiers.js';

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
  const r = await query(`SELECT extract(epoch FROM now() - (SELECT min(ts_utc) FROM timeseries_samples WHERE scope = 'live')) / 86400 AS d`);
  const d = Number(r.rows?.[0]?.d);
  return Number.isFinite(d) ? d : null;
}

export async function pruneRawBefore(db, { before, timescale }) {
  const iso = new Date(before).toISOString();
  if (timescale) {
    // drop_chunks löscht ganze Blöcke mit ALLEN Reihen — darin liegen aber auch
    // Preise (die History rechnet Erlöse daraus) und importierte Altdaten. Die
    // werden vorher gesichert und danach zurückgeschrieben; nur die 5-s-Live-
    // Rohwerte gehen. Eine Transaktion: ganz oder gar nicht.
    const client = typeof db.connect === 'function' ? await db.connect() : db;
    try {
      await client.query('BEGIN');
      await client.query(`CREATE TEMP TABLE dvhub_keep_samples ON COMMIT DROP AS
        SELECT * FROM timeseries_samples
         WHERE ts_utc < $1 AND (scope <> 'live' OR series_key LIKE 'price%')`, [iso]);
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
      SELECT ctid FROM timeseries_samples WHERE scope = 'live' AND series_key NOT LIKE 'price%'
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
