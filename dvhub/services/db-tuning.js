// services/db-tuning.js — DVhub stellt seine PostgreSQL-Instanz selbst ein.
//
// Christin 2026-10-01: DVhub soll auf kleinen Boards (Radxa Zero 3E, Allwinner
// H3/H6, 512 MB–2 GB RAM, eMMC/SD-Karte) genauso laufen wie auf prod — egal ob
// nativ, als Docker-Suite, unter balenaOS oder Portainer. Die Einstellungen
// gehören deshalb nicht (nur) in eine Compose-Datei, die beim Nutzer veralten
// kann, sondern werden von DVhub beim Start gesetzt, sobald ein DB-Admin-Zugang
// da ist (im Container immer: DVHUB_DB_ADMIN_USER/_PASSWORD für Backup/Restore).
//
// Zwei Gruppen:
//   schreibarm (für jede Box, per Reload sofort wirksam)
//     synchronous_commit=off, wal_writer_delay=1s, checkpoint_timeout=15min,
//     wal_compression=on, min_wal_size=64MB — siehe pg-write-tuning.sh
//     (nativ dieselben Werte).
//   Speicher nach RAM-Profil
//     reloadbar: work_mem, maintenance_work_mem, effective_cache_size,
//       max_parallel_workers_per_gather, max_parallel_maintenance_workers
//     erst nach DB-Neustart: shared_buffers, max_connections,
//       max_worker_processes, autovacuum_max_workers,
//       timescaledb.max_background_workers
//
// Was auf der Kommandozeile steht (Compose `-c …`), gewinnt in PostgreSQL vor
// ALTER SYSTEM — das wird nicht angefasst, nur gemeldet.

import fs from 'node:fs';

const MB = 1024 * 1024;

export const WRITE_SETTINGS = Object.freeze({
  synchronous_commit: 'off',
  wal_writer_delay: '1s',
  checkpoint_timeout: '15min',
  wal_compression: 'on',
  // timescaledb-tune setzt 512MB — so viel Schreibpuffer (pg_wal) hält
  // PostgreSQL dann dauerhaft vor, auch wenn kaum geschrieben wird (A7S
  // 2026-10-18: 512 MB). 64 MB reichen; max_wal_size bleibt, damit unter
  // Last nicht öfter Checkpoints geschrieben werden.
  min_wal_size: '64MB',
});

/**
 * RAM-Profil für die Datenbank. Bewusst KLEIN für alle (Christin 2026-10-01:
 * „den kleinen Footprint für alle beibehalten“) — größere Boxen werden nicht
 * hochskaliert; DVhubs Abfragen laufen über Tages-/15-min-Aggregate, der
 * Rest ist freigebbarer Page-Cache. Nur sehr knappe Geräte (DB-Budget unter
 * 192 MB, z. B. 512-MB-Boards) gehen eine Stufe tiefer.
 * `budgetMb`: im Container das DB-Limit, nativ 25 % des Gesamt-RAMs.
 */
export function memoryProfile(budgetMb) {
  const b = Number(budgetMb) || 0;
  if (b > 0 && b < 192) {
    return { name: 'winzig', shared_buffers: '32MB', work_mem: '1MB', maintenance_work_mem: '16MB',
      effective_cache_size: '64MB', max_connections: '15', max_worker_processes: '6',
      autovacuum_max_workers: '1', 'timescaledb.max_background_workers': '2',
      max_parallel_workers_per_gather: '0', max_parallel_maintenance_workers: '0' };
  }
  return { name: 'klein', shared_buffers: '64MB', work_mem: '2MB', maintenance_work_mem: '16MB',
    effective_cache_size: '128MB', max_connections: '20', max_worker_processes: '8',
    autovacuum_max_workers: '2', 'timescaledb.max_background_workers': '4',
    max_parallel_workers_per_gather: '0', max_parallel_maintenance_workers: '0' };
}

/**
 * Speicher-Budget der DB in MB.
 *   Container: DVHUB_DB_MEM_LIMIT (z. B. "160m", aus compose mem_limit) —
 *   nativ: 25 % des Gesamt-RAMs (DVhub ~150 MB, EOS bis ~400 MB, System).
 */
export function dbBudgetMb({ env = process.env, totalMemBytes } = {}) {
  const lim = String(env.DVHUB_DB_MEM_LIMIT || '').trim().toLowerCase();
  const m = /^(\d+(?:\.\d+)?)\s*([kmg])?b?$/.exec(lim);
  if (m) {
    const n = Number(m[1]);
    return Math.round(m[2] === 'g' ? n * 1024 : m[2] === 'k' ? n / 1024 : m[2] === 'm' ? n : n / MB);
  }
  if (Number(totalMemBytes) > 0) return Math.round((Number(totalMemBytes) / MB) * 0.25);
  return 0;
}

/**
 * WAL-Grenzen nach Speicherprofil (services/storage-profile.js): kleine Platten
 * halten weniger Schreibpuffer vor. „groß“ (und ohne Profil) = bisher:
 * max_wal_size bleibt unangetastet (PostgreSQL-Standard 1 GB), min_wal_size 64MB.
 */
/** Merker „diesen max_wal_size hat DVhub gesetzt“ als Datei im Datenverzeichnis. */
export function fileWalOwner(dataDir, { fsImpl = null } = {}) {
  const f = `${dataDir}/storage-wal-owner.json`;
  return {
    read: () => {
      try { return Number(JSON.parse((fsImpl || fs).readFileSync(f, 'utf8')).maxWalMb) || null; } catch { return null; }
    },
    write: (mb) => {
      const fsx = fsImpl || fs;
      if (mb == null) { try { fsx.unlinkSync(f); } catch { /* egal */ } return; }
      fsx.writeFileSync(f, `${JSON.stringify({ maxWalMb: mb })}\n`);
    },
  };
}
export function walSettings(storageProfile = null) {
  if (!storageProfile || storageProfile.name === 'gross') return {};
  return { max_wal_size: `${storageProfile.maxWalMb}MB`, min_wal_size: `${storageProfile.minWalMb}MB` };
}

/** Soll-Werte für diese Box. */
export function desiredSettings({ budgetMb, includeMemory = true, storageProfile = null } = {}) {
  const prof = includeMemory ? memoryProfile(budgetMb) : null;
  const { name, ...mem } = prof || {};
  return { profile: name || null, settings: { ...WRITE_SETTINGS, ...(prof ? mem : {}), ...walSettings(storageProfile) } };
}

/**
 * Anwenden über eine Admin-Verbindung (`query(sql, params)`). Idempotent:
 * nur, was abweicht; nie, was auf der Kommandozeile steht.
 * @returns {{ changed: string[], pendingRestart: string[], skippedCommandLine: string[], profile: string|null }}
 */
export async function applyDbTuning(query, { budgetMb, includeMemory = true, storageProfile = null, walOwner = null } = {}) {
  const { profile, settings } = desiredSettings({ budgetMb, includeMemory, storageProfile });
  const names = Object.keys(settings);
  const res = await query(
    'SELECT name, setting, unit, source, context, pending_restart FROM pg_settings WHERE name = ANY($1::text[])',
    [names],
  );
  const cur = new Map((res.rows || []).map((r) => [r.name, r]));
  const changed = []; const skippedCommandLine = []; let skippedOwner = false;
  for (const [name, want] of Object.entries(settings)) {
    const row = cur.get(name);
    if (!row) continue;                                   // z. B. timescaledb.* ohne Extension
    if (row.source === 'command line') { skippedCommandLine.push(name); continue; }
    if (sameValue(row, want)) continue;
    // max_wal_size: erst den Merker schreiben, dann setzen — scheitert der
    // Merker (Platte voll), lieber nicht setzen, als einen Wert zu hinterlassen,
    // den DVhub später nicht mehr als eigenen erkennt (Codex 4f093b23).
    let prevOwn;
    if (name === 'max_wal_size' && walOwner) {
      try { prevOwn = walOwner.read?.() ?? null; } catch { prevOwn = null; }
      try { walOwner.write(parseWanted(want) / MB); } catch { skippedOwner = true; continue; }
    }
    // Name ist aus der festen Liste oben, Wert ebenso — kein Nutzertext.
    try {
      await query(`ALTER SYSTEM SET ${name.includes('.') ? `"${name}"` : name} = '${want}'`);
    } catch (e) {
      // Merker auf den vorigen Stand zurück, sonst passt er nicht mehr zur DB (Codex 3e530edf).
      if (name === 'max_wal_size' && walOwner) { try { walOwner.write(prevOwn); } catch { /* egal */ } }
      throw e;
    }
    changed.push(name);
  }
  // max_wal_size gehört DVhub nur, wenn DVhub ihn selbst gesetzt und sich das
  // gemerkt hat (walOwner, Datei im Datenverzeichnis, siehe Schleife oben) — ein
  // gleicher Wert per ALTER SYSTEM vom Betreiber ist sonst nicht zu
  // unterscheiden (Codex 2b7a081b).
  // Zurück auf „groß“ (oder ohne Profil): nur den eigenen, gemerkten Wert aus
  // postgresql.auto.conf entfernen — sonst bliebe ein vorübergehend kleinerer
  // Schreibpuffer für immer (Codex 2ef7ff2c). Ohne Merker nie.
  if (!('max_wal_size' in settings) && walOwner) {
    let own = null;
    try { own = Number(walOwner.read?.()); } catch { /* egal */ }
    if (Number.isFinite(own) && own > 0) {
      const w = (await query(
        "SELECT setting, unit, source, sourcefile FROM pg_settings WHERE name = 'max_wal_size'")).rows?.[0];
      const mb = w ? toBytes(w.setting, w.unit) / MB : null;
      const inAuto = /postgresql\.auto\.conf$/.test(String(w?.sourcefile || ''));
      if (w && inAuto && mb === own) {
        await query('ALTER SYSTEM RESET max_wal_size');
        changed.push('max_wal_size');
        try { walOwner.write?.(null); } catch { /* egal */ }
      } else if (w && ['default', 'environment variable', 'configuration file'].includes(w.source)) {
        // Unser Eintrag ist nicht mehr da (Standard, anderer Wert in auto.conf =
        // Betreiber, oder er gilt aus postgresql.conf) → Merker erledigt. Nur ein
        // höherrangiger Wert (Kommandozeile) kann ihn verdecken — dann bleibt er
        // (Codex 4f093b23, 3e530edf).
        try { walOwner.write?.(null); } catch { /* egal */ }
      }
    }
  }
  if (changed.length) await query('SELECT pg_reload_conf()');
  const after = await query('SELECT name FROM pg_settings WHERE pending_restart');
  return { profile, changed, skippedCommandLine, ...(skippedOwner ? { skippedOwner: ['max_wal_size'] } : {}), pendingRestart: (after.rows || []).map((r) => r.name) };
}

// pg_settings liefert z. B. shared_buffers als Anzahl 8-kB-Seiten mit unit '8kB'.
function toBytes(value, unit) {
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  const u = String(unit || '');
  const m = /^(\d+)?(kB|MB|GB|B)$/.exec(u);
  if (!m) return null;
  const factor = { B: 1, kB: 1024, MB: MB, GB: 1024 * MB }[m[2]] * (Number(m[1]) || 1);
  return v * factor;
}
function parseWanted(want) {
  const m = /^(\d+)(kB|MB|GB)$/.exec(String(want));
  return m ? Number(m[1]) * { kB: 1024, MB: MB, GB: 1024 * MB }[m[2]] : null;
}
function toSeconds(value, unit) {
  const v = Number(value);
  return { ms: v / 1000, s: v, min: v * 60 }[unit] ?? null;
}
function parseWantedSeconds(want) {
  const m = /^(\d+)(ms|s|min)$/.exec(String(want));
  return m ? Number(m[1]) * { ms: 0.001, s: 1, min: 60 }[m[2]] : null;
}
// PostgreSQL zeigt manche Werte anders an, als man sie setzt.
const ALIASES = { wal_compression: { on: 'pglz' } };
function sameValue(row, want) {
  const alias = ALIASES[row.name]?.[want];
  if (alias && String(row.setting) === alias) return true;
  const wb = parseWanted(want);
  if (wb != null) return toBytes(row.setting, row.unit) === wb;
  const ws = parseWantedSeconds(want);
  if (ws != null) return toSeconds(row.setting, row.unit) === ws;
  return String(row.setting) === String(want);
}

// ── TimescaleDB: kleine Blöcke, früh komprimieren (2026-10-01) ─────────────
// Auf prod lag die laufende Woche unkomprimiert bei 1,45 GB (7-Tage-Blöcke,
// Kompression nach 7 Tagen) — auf einem Board mit 2–3 GB eMMC zu viel.
// Tagesblöcke + Kompression nach 2 Tagen: höchstens ~2 Tage unkomprimiert.
// Auflösung bleibt 5 s, komprimierte Blöcke sind normal abfragbar. Wirkt für
// neue Blöcke; braucht Tabellen-Eigentümer (DVhub ist es für timeseries_samples).
export const SAMPLES_CHUNK_INTERVAL = '1 day';
export const SAMPLES_COMPRESS_AFTER = '2 days';

// 21.10.2026: Boxen, die unter der Apache-Edition installiert und später auf
// Community nachgerüstet wurden, haben keine Kompression: Migration 014 hat den
// TSL-Teil übersprungen und läuft nie wieder. Die Regel unten scheiterte dann
// bei jedem Start („columnstore not enabled on hypertable“), die Datenbank
// wuchs ungebremst (keine Retention, T-0078), und storage-guard konnte nicht
// komprimieren. Darum hier einschalten — mit denselben Einstellungen wie 014.
// Nur Metadaten (komprimiert wird später im Hintergrund-Job, Chunk für Chunk),
// aber das ALTER braucht eine Sperre auf der Hypertable: lock_timeout statt
// DVhub-Schreibzugriffe warten zu lassen, sonst beim nächsten Start erneut.
// SET LOCAL wirkt, weil beide Anweisungen als EIN Query (ohne Parameter) in
// einer impliziten Transaktion laufen; die Pool-Verbindung behält nichts.
export const SAMPLES_COMPRESS_LOCK_TIMEOUT = '10s';
const ENABLE_COMPRESSION_SQL = `SET LOCAL lock_timeout = '${SAMPLES_COMPRESS_LOCK_TIMEOUT}';
ALTER TABLE timeseries_samples SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'series_key,scope,source',
  timescaledb.compress_orderby = 'ts_utc desc'
)`;

/** Intervall-Text in Sekunden: „2 days“, „12 hours“, „12:00:00“, „1 day 06:00:00“. */
export function intervalSeconds(v) {
  const str = String(v ?? '').trim().toLowerCase();
  if (!str) return null;
  let sec = 0; let hit = false;
  const unit = { second: 1, seconds: 1, minute: 60, minutes: 60, hour: 3600, hours: 3600, day: 86400, days: 86400, week: 604800, weeks: 604800 };
  for (const m of str.matchAll(/(\d+(?:\.\d+)?)\s*(seconds?|minutes?|hours?|days?|weeks?)\b/g)) { sec += Number(m[1]) * unit[m[2]]; hit = true; }
  const hms = /(\d+):(\d{2}):(\d{2})/.exec(str);
  if (hms) { sec += Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]); hit = true; }
  return hit ? sec : null;
}

/**
 * Blöcke und Kompression nach Speicherprofil (services/storage-profile.js,
 * Speicher-Konzept 23.11.2026 Schritt 3). Ohne profile gilt „groß“ = das
 * Verhalten bis 1.0.12: Tagesblöcke, Kompression nach 2 Tagen, Lauf alle 12 h.
 * Kleinere Profile: kleinere Blöcke, früher und öfter komprimieren (S4:
 * Kompression immer, auf allen Profilen). Wirkt für neue Blöcke.
 */
export async function tuneTimescale(query, profile = null) {
  const chunkWant = profile?.chunkInterval || SAMPLES_CHUNK_INTERVAL;
  const afterWant = profile?.compressAfter || SAMPLES_COMPRESS_AFTER;
  const schedWant = profile?.compressSchedule || null;
  const out = { chunkInterval: null, compressAfter: null, changed: [], profile: profile?.name || null };
  const ext = await query("SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'");
  if (!ext.rows?.length) return { ...out, skipped: 'no_timescaledb' };
  const dim = await query(
    `SELECT extract(epoch FROM time_interval)::bigint AS s FROM timescaledb_information.dimensions
      WHERE hypertable_name = 'timeseries_samples' AND dimension_type = 'Time'`);
  const curS = Number(dim.rows?.[0]?.s);
  if (!Number.isFinite(curS)) return { ...out, skipped: 'no_hypertable' };
  const wantS = intervalSeconds(chunkWant);
  if (curS !== wantS) {
    // Werte stammen aus der festen Profiltabelle, kein Nutzertext.
    await query(`SELECT set_chunk_time_interval('timeseries_samples', INTERVAL '${chunkWant}')`);
    out.changed.push('chunk_interval');
  }
  out.chunkInterval = chunkWant;
  // Apache kann keine Kompression — dort kein Fehler, nur nichts zu tun.
  const lic = await query("SELECT current_setting('timescaledb.license', true) AS lic");
  if (lic.rows?.[0]?.lic !== 'timescale') return { ...out, skipped: 'apache' };
  const comp = await query(
    `SELECT compression_enabled AS on FROM timescaledb_information.hypertables
      WHERE hypertable_name = 'timeseries_samples'`);
  if (comp.rows?.[0]?.on !== true) {
    try {
      await query(ENABLE_COMPRESSION_SQL);
    } catch (e) {
      // 55P03 lock_not_available: Hypertable gerade belegt → nächster Start.
      if (e?.code === '55P03') return { ...out, deferred: 'compression_lock_timeout' };
      throw e;
    }
    out.changed.push('compression_enabled');
  }
  const JOB_SQL = `SELECT job_id, config->>'compress_after' AS after, extract(epoch FROM schedule_interval)::bigint AS sched
      FROM timescaledb_information.jobs
      WHERE proc_name = 'policy_compression' AND hypertable_name = 'timeseries_samples'`;
  let job = (await query(JOB_SQL)).rows?.[0] || null;
  const after = job?.after || null;
  if (intervalSeconds(after) !== intervalSeconds(afterWant)) {
    if (after) await query("SELECT remove_compression_policy('timeseries_samples', if_exists => true)");
    await query(`SELECT add_compression_policy('timeseries_samples', compress_after => INTERVAL '${afterWant}', if_not_exists => true)`);
    out.changed.push('compress_after');
    job = (await query(JOB_SQL)).rows?.[0] || null;
  }
  out.compressAfter = afterWant;
  // Lauf-Intervall des Kompressions-Jobs (nur wenn bekannt und abweichend).
  const sched = Number(job?.sched);
  if (schedWant && job?.job_id != null && Number.isFinite(sched) && sched !== intervalSeconds(schedWant)) {
    await query(`SELECT alter_job(${Number(job.job_id)}, schedule_interval => INTERVAL '${schedWant}')`);
    out.changed.push('compress_schedule');
  }
  if (schedWant) out.compressSchedule = schedWant;
  return out;
}

/**
 * Wie viele Datenbankverbindungen DVhub gleichzeitig öffnet. Jede aktive
 * Abfrage kostet in PostgreSQL eigenen Speicher (Sortieren, Hash, Entpacken
 * komprimierter Blöcke). Die History-Jahresansicht schickt 14 Abfragen
 * gleichzeitig — bei 160 MB DB-Limit beendete der Kernel dreimal einen
 * DB-Prozess (Container-Test 2026-10-02). Weniger Verbindungen = die Anfragen
 * warten kurz in DVhub statt die DB zu überfluten.
 */
export function dbPoolMax(budgetMb) {
  return memoryProfile(budgetMb).name === 'winzig' ? 3 : 5;
}
