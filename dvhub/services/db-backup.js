// DVhub (2026-06-01) — on-demand Postgres backup download.
//
// Streams a `pg_dump` of the telemetry DB straight to the HTTP response so the
// operator can pull a full backup (or just the 15-min aggregated energy table)
// from the LAN browser. Custom format (-Fc): compressed and pg_restore-able.
//
// NB: the DB runs TimescaleDB — a plain pg_dump captures all data, but a clean
// restore needs the timescaledb extension present on the target and the usual
// timescaledb_pre_restore()/post_restore() dance. That's an expert recovery
// step; for *securing* the data the dump is complete and correct.

import { spawn } from 'node:child_process';

// Two scopes the operator can pick at download time.
export const DB_BACKUP_SCOPES = new Set(['full', 'energy15m']);

/**
 * Pure: build the pg_dump argv for a scope against a telemetry.database config.
 * Connection mirrors db-client.js createPool so the dump talks to the same DB
 * the app uses (unix socket + peer auth by default; PGPASSWORD added by the
 * runner when a password is configured).
 *
 * @returns {{ok:true, args:string[], dbName:string} | {ok:false, error:string}}
 */
export function buildPgDumpArgs({ scope, database = {} } = {}) {
  if (!DB_BACKUP_SCOPES.has(scope)) {
    return { ok: false, error: 'invalid scope' };
  }
  const host = database.host || '/var/run/postgresql';
  const port = String(database.port || 5432);
  const dbName = database.name || database.database || 'dvhub';
  const user = database.user || 'dvhub';
  // --no-owner/--no-privileges keep the dump restore-portable across roles.
  const args = ['-h', host, '-p', port, '-U', user, '-d', dbName,
    '-Fc', '--no-owner', '--no-privileges'];
  // "Nur 15-min-Werte": just the aggregated energy table the dashboards use.
  if (scope === 'energy15m') {
    args.push('-t', 'energy_slots_15m');
  }
  return { ok: true, args, dbName };
}

/**
 * Download filename for a scope + timestamp stamp (YYYY-MM-DD-HHMM).
 */
export function backupFilename(scope, stamp) {
  const kind = scope === 'energy15m' ? 'energy15m' : 'full';
  return `dvhub-${kind}-${stamp}.dump`;
}

/**
 * Spawn pg_dump and pipe its stdout to `res`. Manages the header/error
 * lifecycle so a spawn/connection failure BEFORE any output yields a JSON
 * error, while a failure mid-stream destroys the (now-incomplete) download so
 * the client can't mistake a truncated file for a good backup.
 *
 * @param {object} p
 * @param {string} p.scope                 'full' | 'energy15m'
 * @param {object} p.database              telemetry.database config
 * @param {import('http').ServerResponse} p.res
 * @param {object} [p.securityHeaders]
 * @param {string} p.stamp                 filename timestamp
 * @param {(event:string, data:object)=>void} [p.pushLog]
 * @param {(cmd:string,args:string[],opts:object)=>any} [p.spawnFn]  injectable for tests
 */
export function streamPgDump({ scope, database = {}, res, securityHeaders = {}, stamp, pushLog, spawnFn = spawn } = {}) {
  const built = buildPgDumpArgs({ scope, database });
  if (!built.ok) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: built.error }));
    return;
  }

  const env = { ...process.env };
  if (database.password) env.PGPASSWORD = String(database.password);

  let child;
  try {
    child = spawnFn('pg_dump', built.args, { env });
  } catch (err) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'pg_dump_unavailable', detail: err.message }));
    return;
  }

  let headersSent = false;
  let stderr = '';
  if (child.stderr) {
    child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += d.toString(); });
  }

  child.on('error', (err) => {
    if (!headersSent && !res.headersSent) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'pg_dump_unavailable', detail: err.message }));
    } else {
      res.destroy();
    }
    if (pushLog) pushLog('db_backup_error', { scope, detail: err.message });
  });

  // First stdout chunk == spawn + pg_dump startup succeeded → commit headers,
  // write that chunk, then pipe the remainder. (Attaching pipe synchronously
  // inside the once('data') handler keeps the stream paused between events, so
  // no bytes are lost.)
  child.stdout.once('data', (chunk) => {
    headersSent = true;
    res.writeHead(200, {
      ...securityHeaders,
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${backupFilename(scope, stamp)}"`,
      'cache-control': 'no-store'
    });
    res.write(chunk);
    child.stdout.pipe(res);
  });

  child.on('close', (code) => {
    if (code !== 0) {
      if (!headersSent && !res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'pg_dump_failed', detail: stderr.slice(0, 500) }));
      } else {
        // Already streaming → kill the connection so the partial file is
        // recognisably broken rather than a silently-truncated "backup".
        res.destroy();
      }
      if (pushLog) pushLog('db_backup_failed', { scope, code, stderr: stderr.slice(0, 300) });
    } else if (pushLog) {
      pushLog('db_backup_ok', { scope });
    }
  });
}

/**
 * Run pg_dump straight to a file (for the scheduled backup-to-network-target).
 * Uses pg_dump's own -f so nothing is buffered in node. Resolves with the
 * outcome; never rejects.
 *
 * @returns {Promise<{ok:boolean, code:number|null, stderr:string, file:string}>}
 */
export function dumpToFile({ scope, database = {}, outFile, spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    const built = buildPgDumpArgs({ scope, database });
    if (!built.ok) { resolve({ ok: false, code: null, stderr: built.error, file: outFile }); return; }
    const args = [...built.args, '-f', outFile];
    const env = { ...process.env };
    if (database.password) env.PGPASSWORD = String(database.password);
    let child;
    try {
      child = spawnFn('pg_dump', args, { env });
    } catch (err) {
      resolve({ ok: false, code: null, stderr: err.message, file: outFile });
      return;
    }
    let stderr = '';
    if (child.stderr) child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += d.toString(); });
    child.on('error', (err) => resolve({ ok: false, code: null, stderr: err.message, file: outFile }));
    child.on('close', (code) => resolve({ ok: code === 0, code, stderr, file: outFile }));
  });
}

/**
 * Pure: given a directory listing, pick the backup files to delete to keep only
 * the `keep` newest for a scope. Filenames embed a sortable YYYY-MM-DD-HHMM
 * stamp, so lexicographic sort == chronological. keep<=0 deletes NOTHING (a
 * safety guard — never wipe every backup). Only ever matches this scope's own
 * `dvhub-<kind>-*.dump` files, never anything else in the directory.
 *
 * @returns {string[]} filenames to delete (oldest first)
 */
export function selectBackupsToDelete(files, scope, keep) {
  const kind = scope === 'energy15m' ? 'energy15m' : 'full';
  const prefix = `dvhub-${kind}-`;
  const matching = (files || []).filter((f) => f.startsWith(prefix) && f.endsWith('.dump')).sort();
  if (!Number.isFinite(keep) || keep <= 0) return [];
  return matching.length > keep ? matching.slice(0, matching.length - keep) : [];
}
