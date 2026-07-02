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

// Run the pg maintenance tools as the postgres SUPERUSER via sudo. The app's DB
// role (dvhub) is NOT a superuser, so it cannot LOCK/back-up nor drop/restore
// objects owned by another role — e.g. the postgres-owned `victron_internals`
// hypertable on prod: `pg_dump -U dvhub` dies with "permission denied for table
// victron_internals" and the whole FULL backup fails. The appliance grants a
// narrow NOPASSWD sudo rule for exactly these three binaries (install.sh /
// post-update.sh sudoers block). sudo's env_reset drops PGPASSWORD — not needed,
// peer auth via the unix socket maps the postgres OS user to the postgres role.
const PG_DUMP_BIN = '/usr/bin/pg_dump';
const PG_RESTORE_BIN = '/usr/bin/pg_restore';
const PG_PSQL_BIN = '/usr/bin/psql';
const PG_SUPERUSER = 'postgres';

/** Wrap a pg binary + argv to run as the postgres superuser: `sudo -u postgres <bin> <args…>`. */
function pgWrap(bin, binArgs) {
  return { cmd: 'sudo', args: ['-u', PG_SUPERUSER, bin, ...binArgs] };
}

/**
 * Pure: build the pg_dump argv for a scope against a telemetry.database config.
 * Connection mirrors db-client.js createPool so the dump talks to the same DB
 * the app uses (unix socket + peer auth by default; PGPASSWORD added by the
 * runner when a password is configured).
 *
 * @returns {{ok:true, args:string[], dbName:string} | {ok:false, error:string}}
 */
export function buildPgDumpArgs({ scope, database = {}, superuser = false } = {}) {
  if (!DB_BACKUP_SCOPES.has(scope)) {
    return { ok: false, error: 'invalid scope' };
  }
  const host = database.host || '/var/run/postgresql';
  const port = String(database.port || 5432);
  const dbName = database.name || database.database || 'dvhub';
  // superuser path (GUI backup): connect as postgres (peer auth after sudo) and
  // keep OWNERSHIP + GRANTS in the dump — a FULL restore must reproduce them so
  // the app (dvhub) keeps access to postgres-owned tables like victron_internals.
  // legacy path: connect as the app role, --no-owner/--no-privileges for a
  // role-portable dump of dvhub-owned tables only.
  const user = superuser ? PG_SUPERUSER : (database.user || 'dvhub');
  const args = ['-h', host, '-p', port, '-U', user, '-d', dbName, '-Fc'];
  if (!superuser) args.push('--no-owner', '--no-privileges');
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
  // superuser:true → dump EVERYTHING (incl. postgres-owned tables) as postgres.
  const built = buildPgDumpArgs({ scope, database, superuser: true });
  if (!built.ok) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: built.error }));
    return;
  }

  const env = { ...process.env };

  let child;
  try {
    const w = pgWrap(PG_DUMP_BIN, built.args);
    child = spawnFn(w.cmd, w.args, { env });
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

// ---------------------------------------------------------------------------
// Restore (GUI DB-Restore, POST /api/db/restore) — the inverse of the backup
// side above. DESTRUCTIVE: pg_restore --clean drops existing objects first.
// ---------------------------------------------------------------------------

/**
 * Pure: build the pg_restore argv for a target telemetry.database config.
 * Mirrors buildPgDumpArgs' connection resolution so the restore talks to the
 * same DB the app uses. --clean --if-exists drops existing objects before
 * recreating them; --no-owner/--no-privileges keep the archive portable across
 * roles (matches how the dump was written). The dump file is the last arg.
 *
 * @returns {{ok:true, args:string[], dbName:string} | {ok:false, error:string}}
 */
export function buildPgRestoreArgs({ database = {}, file } = {}) {
  if (!file || typeof file !== 'string') return { ok: false, error: 'missing_file' };
  const host = database.host || '/var/run/postgresql';
  const port = String(database.port || 5432);
  const dbName = database.name || database.database || 'dvhub';
  // Restore runs as the postgres superuser (peer auth after sudo) and KEEPS the
  // dump's ownership + grants (no --no-owner/--no-privileges) so every object
  // lands under its original role — the app (dvhub) keeps write access, and
  // postgres-owned tables (victron_internals) restore correctly too.
  const args = ['-h', host, '-p', port, '-U', PG_SUPERUSER, '-d', dbName,
    '--clean', '--if-exists', file];
  return { ok: true, args, dbName };
}

/**
 * Pure: build a psql argv that runs one SQL command against the same DB (for
 * the TimescaleDB pre/post_restore dance + backend termination). -Atqc keeps
 * output minimal and script-parseable; ON_ERROR_STOP surfaces real failures.
 */
export function buildPsqlArgs({ database = {}, sql } = {}) {
  const host = database.host || '/var/run/postgresql';
  const port = String(database.port || 5432);
  const dbName = database.name || database.database || 'dvhub';
  // Runs as postgres (peer auth after sudo): the pre/post_restore dance +
  // pg_terminate_backend must reliably reach background workers and every
  // client backend, not just the app role's own connections.
  return ['-h', host, '-p', port, '-U', PG_SUPERUSER, '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-Atqc', sql];
}

/** Spawn a command, buffer stdout/stderr, resolve an outcome. Never rejects. */
function runCmd(cmd, args, env, spawnFn) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnFn(cmd, args, { env }); }
    catch (err) { resolve({ ok: false, code: null, stdout: '', stderr: err.message }); return; }
    let stdout = '', stderr = '';
    if (child.stdout) child.stdout.on('data', (d) => { if (stdout.length < 8000) stdout += d.toString(); });
    if (child.stderr) child.stderr.on('data', (d) => { if (stderr.length < 8000) stderr += d.toString(); });
    child.on('error', (err) => resolve({ ok: false, code: null, stdout: stdout.trim(), stderr: (stderr || err.message).trim() }));
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

/**
 * Restore a pg_dump custom-format (-Fc) file into the telemetry DB. DESTRUCTIVE.
 *
 * Handles the TimescaleDB pre/post_restore dance when the extension is present
 * (a FULL dump carries the timeseries_samples hypertable + continuous
 * aggregates, which must import with timescaledb.restoring='on' — set at
 * DATABASE level so the separate pg_restore connection inherits it), and
 * terminates other client backends first so --clean's DROPs don't block on the
 * app's connection pool. post_restore/RESET ALWAYS run afterwards — even if
 * pg_restore failed — so the DB is never left stuck in restore mode. An
 * energy15m dump (plain table) passes through the same path harmlessly.
 *
 * Never throws; returns a structured outcome. buildPgRestoreArgs stays pure and
 * unit-testable; the orchestration is exercised via an injected spawnFn.
 *
 * @returns {Promise<{ok:boolean, code:number|null, stderr:string, hadTimescale:boolean, ignoredErrors:number}>}
 */
export async function runDbRestore({ database = {}, inFile, spawnFn = spawn } = {}) {
  const built = buildPgRestoreArgs({ database, file: inFile });
  if (!built.ok) return { ok: false, code: null, stderr: built.error, hadTimescale: false, ignoredErrors: 0 };
  const env = { ...process.env };
  const psql = (sql) => {
    const w = pgWrap(PG_PSQL_BIN, buildPsqlArgs({ database, sql }));
    return runCmd(w.cmd, w.args, env, spawnFn);
  };

  // 1. Is TimescaleDB present on the target?
  const extProbe = await psql("SELECT 1 FROM pg_extension WHERE extname='timescaledb'");
  const hadTimescale = extProbe.ok && extProbe.stdout.includes('1');

  // 2. Enter TimescaleDB restore mode (stops background workers; imports chunks
  //    as plain tables). Flag the DB (not just the session) so pg_restore's own
  //    connection sees it.
  if (hadTimescale) {
    await psql('SELECT timescaledb_pre_restore()');
    await psql(`ALTER DATABASE "${built.dbName}" SET timescaledb.restoring = 'on'`);
  }

  // 3. Lock the app OUT for the duration of the restore. Terminating backends is
  //    not enough — the non-super app role reconnects on its next poll and keeps
  //    INSERTing (e.g. audit_log/control_events), which then collides with the
  //    dump's rows and fails the PRIMARY KEY rebuild ("key (id)=… is duplicated").
  //    CONNECTION LIMIT 0 blocks all NON-superuser connects; postgres (our
  //    pg_dump/pg_restore/psql, all superuser) is exempt, so the restore proceeds
  //    while the app cannot reconnect. Then terminate the existing backends.
  await psql(`ALTER DATABASE "${built.dbName}" CONNECTION LIMIT 0`);
  await psql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'");

  // 4. The restore itself (as postgres via sudo).
  const restoreWrap = pgWrap(PG_RESTORE_BIN, built.args);
  const restore = await runCmd(restoreWrap.cmd, restoreWrap.args, env, spawnFn);

  // 5. ALWAYS unwind — re-open connections + leave restore mode — even on
  //    failure, so the DB is never left locked out or stuck in restore mode.
  await psql(`ALTER DATABASE "${built.dbName}" CONNECTION LIMIT -1`);
  if (hadTimescale) {
    await psql(`ALTER DATABASE "${built.dbName}" RESET timescaledb.restoring`);
    await psql('SELECT timescaledb_post_restore()');
  }

  // pg_restore continues past non-fatal errors by default and still exits 0,
  // printing "errors ignored on restore: N". Surface that count so a partial
  // restore isn't reported as clean.
  const m = /errors ignored on restore:\s*(\d+)/i.exec(restore.stderr || '');
  const ignoredErrors = m ? Number(m[1]) : 0;

  return {
    ok: restore.ok,
    code: restore.code,
    stderr: (restore.stderr || '').slice(0, 2000),
    hadTimescale,
    ignoredErrors
  };
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
