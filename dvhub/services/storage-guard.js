// services/storage-guard.js — Platz-Wache für kleine Speicher (eMMC/SD).
//
// Christin 2026-10-01: Boards mit 2–3 GB eMMC. Die 5-s-Rohwerte sind der
// größte Posten der Datenbank. Statt die Box vollaufen zu lassen, reagiert
// DVhub in Stufen — die 15-min-Werte (energy_slots_15m), Tagesaggregate und
// seltenen Ereignisse bleiben IMMER, ebenso die letzten 30 Tage Rohwerte:
//
//   < 20 % frei  „knapp“    ältere Rohwert-Blöcke sofort komprimieren
//   < 10 % frei  „wenig“    zusätzlich Rohwerte älter als N Tage entfernen,
//                           N in Stufen 365 → 180 → 90 → 30 (eine Stufe je Lauf)
//   <  5 % frei  „kritisch“ wie „wenig“, Warnung dringend
//
// Rohwerte werden nur entfernt, wo es 15-min-Werte dafür gibt (nie jüngere
// als der letzte verdichtete Zeitraum) — und nur die 5-s-Live-Werte: Preise
// (Erlösrechnung der History) und importierte Altdaten bleiben. Jede Stufe erscheint als Systemhinweis
// mit dem Vorschlag, den Speicher zu erweitern (USB-Stick/SD-Karte).

import fs from 'node:fs';

export const STORAGE_CHECK_INTERVAL_MS = 30 * 60_000;
export const RAW_KEEP_STEPS_DAYS = Object.freeze([365, 180, 90, 30]);

export function storageLevel(freePct) {
  if (!Number.isFinite(freePct)) return 'unbekannt';
  if (freePct < 5) return 'kritisch';
  if (freePct < 10) return 'wenig';
  if (freePct < 20) return 'knapp';
  return 'ok';
}

/** Nächste Aufbewahrungsstufe: die erste, die kürzer ist als das, was heute da ist. */
export function nextKeepDays(oldestRawAgeDays) {
  for (const d of RAW_KEEP_STEPS_DAYS) if (oldestRawAgeDays > d) return d;
  return null;   // schon bei ≤ 30 Tagen — nichts mehr entfernen
}

export function createStorageGuard({ getDb, getDataDir, pushLog, setWarning, now = () => Date.now(), statfs = (p) => fs.statfsSync(p) } = {}) {
  let last = null;
  let running = false;
  const log = (e, d, lvl) => { try { pushLog?.(e, d, lvl); } catch { /* egal */ } };

  async function check() {
    if (running) return last;
    running = true;
    try {
      const dir = getDataDir?.() || '/';
      let freePct = NaN; let freeMb = null; let totalMb = null;
      try {
        const s = statfs(dir);
        totalMb = Math.round((s.blocks * s.bsize) / 1048576);
        freeMb = Math.round((s.bavail * s.bsize) / 1048576);
        freePct = totalMb > 0 ? Math.round((freeMb / totalMb) * 1000) / 10 : NaN;
      } catch { /* statfs nicht möglich */ }
      const level = storageLevel(freePct);
      const out = { at: new Date(now()).toISOString(), dir, freePct, freeMb, totalMb, level, dbMb: null, actions: [] };
      const db = getDb?.();
      if (db && typeof db.query === 'function') {
        try { out.dbMb = Math.round(Number((await db.query('SELECT pg_database_size(current_database()) AS b')).rows?.[0]?.b) / 1048576); } catch { /* egal */ }
        if (level !== 'ok' && level !== 'unbekannt') {
          const ts = (await db.query("SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'")).rows?.length > 0;
          if (ts) {
            const r = await db.query(`SELECT count(*) AS n FROM (SELECT compress_chunk(c, if_not_compressed => true)
              FROM show_chunks('timeseries_samples', older_than => INTERVAL '1 day') c) x`);
            out.actions.push({ action: 'compress', chunks: Number(r.rows?.[0]?.n) || 0 });
          }
          if (level === 'wenig' || level === 'kritisch') {
            // Ältester Rohwert und letzter verdichteter 15-min-Slot.
            const b = (await db.query(`SELECT
                extract(epoch FROM now() - (SELECT min(ts_utc) FROM timeseries_samples WHERE scope = 'live')) / 86400 AS oldest_days,
                (SELECT max(slot_start_utc) FROM energy_slots_15m) AS agg_until`)).rows?.[0] || {};
            const keep = nextKeepDays(Number(b.oldest_days));
            if (keep && b.agg_until) {
              const cutoff = new Date(Math.min(now() - keep * 86_400_000, new Date(b.agg_until).getTime()));
              if (ts) {
                // drop_chunks löscht ganze Blöcke mit ALLEN Reihen — darin liegen
                // aber auch Preise (die History rechnet Erlöse daraus) und
                // importierte Altdaten. Die werden vorher gesichert und danach
                // zurückgeschrieben; nur die 5-s-Live-Rohwerte gehen. Eine
                // Transaktion: ganz oder gar nicht.
                const client = typeof db.connect === 'function' ? await db.connect() : db;
                try {
                  await client.query('BEGIN');
                  await client.query(`CREATE TEMP TABLE dvhub_keep_samples ON COMMIT DROP AS
                    SELECT * FROM timeseries_samples
                     WHERE ts_utc < $1 AND (scope <> 'live' OR series_key LIKE 'price%')`, [cutoff.toISOString()]);
                  await client.query("SELECT drop_chunks('timeseries_samples', older_than => $1::timestamptz)", [cutoff.toISOString()]);
                  await client.query(`INSERT INTO timeseries_samples OVERRIDING SYSTEM VALUE SELECT * FROM dvhub_keep_samples
                    ON CONFLICT DO NOTHING`);
                  await client.query('COMMIT');
                } catch (e) {
                  await client.query('ROLLBACK').catch(() => {});
                  throw e;
                } finally {
                  if (client !== db) client.release?.();
                }
              } else {
                // ohne TimescaleDB: in Portionen löschen, damit nichts lange sperrt
                for (let i = 0; i < 200; i++) {
                  const d = await db.query(`DELETE FROM timeseries_samples WHERE ctid IN (
                    SELECT ctid FROM timeseries_samples WHERE scope = 'live' AND series_key NOT LIKE 'price%'
                       AND ts_utc < $1 LIMIT 50000)`, [cutoff.toISOString()]);
                  if (!d.rowCount) break;
                }
              }
              out.actions.push({ action: 'drop_raw', keepDays: keep, before: cutoff.toISOString() });
              log('storage_raw_dropped', { keepDays: keep, before: cutoff.toISOString(), freePct }, 'warn');
            }
          }
        }
      }
      // Systemhinweis setzen bzw. wegnehmen.
      if (level === 'ok' || level === 'unbekannt') setWarning?.('storage', null);
      else {
        const dropped = out.actions.find((a) => a.action === 'drop_raw');
        setWarning?.('storage', `Speicher ${level}: ${freePct} % frei (${freeMb} MB). `
          + (dropped ? `5-s-Rohwerte älter als ${dropped.keepDays} Tage wurden entfernt — 15-min-Werte bleiben. ` : 'Ältere Messwerte werden früher komprimiert. ')
          + 'Speicher erweitern: USB-Stick oder SD-Karte als Datenspeicher einrichten.');
      }
      if (level !== (last?.level)) log('storage_level', { level, freePct, freeMb, dbMb: out.dbMb }, level === 'ok' ? 'info' : 'warn');
      last = out;
      return out;
    } catch (e) {
      log('storage_guard_error', { error: e.message }, 'warn');
      return last;
    } finally {
      running = false;
    }
  }

  let timer = null;
  return {
    start() {
      if (timer) return;
      setTimeout(() => { check().catch(() => {}); }, 5 * 60_000).unref?.();
      timer = setInterval(() => { check().catch(() => {}); }, STORAGE_CHECK_INTERVAL_MS);
      timer.unref?.();
    },
    check,
    status: () => last,
  };
}
