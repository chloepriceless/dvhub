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
//     wal_compression=on — siehe pg-write-tuning.sh (nativ dieselben Werte).
//   Speicher nach RAM-Profil
//     reloadbar: work_mem, maintenance_work_mem, effective_cache_size,
//       max_parallel_workers_per_gather, max_parallel_maintenance_workers
//     erst nach DB-Neustart: shared_buffers, max_connections,
//       max_worker_processes, autovacuum_max_workers,
//       timescaledb.max_background_workers
//
// Was auf der Kommandozeile steht (Compose `-c …`), gewinnt in PostgreSQL vor
// ALTER SYSTEM — das wird nicht angefasst, nur gemeldet.

const MB = 1024 * 1024;

export const WRITE_SETTINGS = Object.freeze({
  synchronous_commit: 'off',
  wal_writer_delay: '1s',
  checkpoint_timeout: '15min',
  wal_compression: 'on',
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

/** Soll-Werte für diese Box. */
export function desiredSettings({ budgetMb, includeMemory = true } = {}) {
  const prof = includeMemory ? memoryProfile(budgetMb) : null;
  const { name, ...mem } = prof || {};
  return { profile: name || null, settings: { ...WRITE_SETTINGS, ...(prof ? mem : {}) } };
}

/**
 * Anwenden über eine Admin-Verbindung (`query(sql, params)`). Idempotent:
 * nur, was abweicht; nie, was auf der Kommandozeile steht.
 * @returns {{ changed: string[], pendingRestart: string[], skippedCommandLine: string[], profile: string|null }}
 */
export async function applyDbTuning(query, { budgetMb, includeMemory = true } = {}) {
  const { profile, settings } = desiredSettings({ budgetMb, includeMemory });
  const names = Object.keys(settings);
  const res = await query(
    'SELECT name, setting, unit, source, context, pending_restart FROM pg_settings WHERE name = ANY($1::text[])',
    [names],
  );
  const cur = new Map((res.rows || []).map((r) => [r.name, r]));
  const changed = []; const skippedCommandLine = [];
  for (const [name, want] of Object.entries(settings)) {
    const row = cur.get(name);
    if (!row) continue;                                   // z. B. timescaledb.* ohne Extension
    if (row.source === 'command line') { skippedCommandLine.push(name); continue; }
    if (sameValue(row, want)) continue;
    // Name ist aus der festen Liste oben, Wert ebenso — kein Nutzertext.
    await query(`ALTER SYSTEM SET ${name.includes('.') ? `"${name}"` : name} = '${want}'`);
    changed.push(name);
  }
  if (changed.length) await query('SELECT pg_reload_conf()');
  const after = await query('SELECT name FROM pg_settings WHERE pending_restart');
  return { profile, changed, skippedCommandLine, pendingRestart: (after.rows || []).map((r) => r.name) };
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

export async function tuneTimescale(query) {
  const out = { chunkInterval: null, compressAfter: null, changed: [] };
  const ext = await query("SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'");
  if (!ext.rows?.length) return { ...out, skipped: 'no_timescaledb' };
  const dim = await query(
    `SELECT extract(epoch FROM time_interval)::bigint AS s FROM timescaledb_information.dimensions
      WHERE hypertable_name = 'timeseries_samples' AND dimension_type = 'Time'`);
  const curS = Number(dim.rows?.[0]?.s);
  if (!Number.isFinite(curS)) return { ...out, skipped: 'no_hypertable' };
  if (curS > 86400) {
    await query(`SELECT set_chunk_time_interval('timeseries_samples', INTERVAL '${SAMPLES_CHUNK_INTERVAL}')`);
    out.changed.push('chunk_interval');
  }
  out.chunkInterval = curS > 86400 ? SAMPLES_CHUNK_INTERVAL : `${curS / 3600} h`;
  const job = await query(
    `SELECT config->>'compress_after' AS after FROM timescaledb_information.jobs
      WHERE proc_name = 'policy_compression' AND hypertable_name = 'timeseries_samples'`);
  const after = job.rows?.[0]?.after || null;
  if (after !== SAMPLES_COMPRESS_AFTER) {
    if (after) await query("SELECT remove_compression_policy('timeseries_samples', if_exists => true)");
    await query(`SELECT add_compression_policy('timeseries_samples', compress_after => INTERVAL '${SAMPLES_COMPRESS_AFTER}', if_not_exists => true)`);
    out.changed.push('compress_after');
  }
  out.compressAfter = SAMPLES_COMPRESS_AFTER;
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
