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
import path from 'node:path';

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

// Container (DVHUB_RUNTIME=container): kein sudo, keine Unix-Socket-Peer-Auth —
// die DB läuft in einem eigenen Container. Die pg-Werkzeuge liegen im Image
// (postgresql17-client unter DVHUB_PG_BIN_DIR) und verbinden sich per TCP als
// DB-Admin (DVHUB_DB_ADMIN_USER/PASSWORD, im Compose der postgres-Superuser).
// Die App selbst bleibt die nicht-privilegierte Rolle dvhub — sonst griffe die
// Aussperrung während des Restores (CONNECTION LIMIT 0) nicht.
/**
 * Wie werden die pg-Werkzeuge aufgerufen? Rein, aus der Umgebung.
 * @returns {{direct:false} | {direct:true, binDir:string, adminUser:string, adminPassword:string}}
 */
export function pgRuntime(env = process.env) {
  const direct = env.DVHUB_RUNTIME === 'container' || env.DVHUB_PG_DIRECT === '1';
  if (!direct) return { direct: false };
  return {
    direct: true,
    binDir: env.DVHUB_PG_BIN_DIR || '/usr/bin',
    adminUser: env.DVHUB_DB_ADMIN_USER || PG_SUPERUSER,
    adminPassword: env.DVHUB_DB_ADMIN_PASSWORD || '',
  };
}

function adminUser(runtime) {
  return runtime?.direct ? runtime.adminUser : PG_SUPERUSER;
}

/**
 * Wrap a pg binary + argv. Native: `sudo -u postgres <bin> <args…>` (fester
 * Pfad, passend zur sudoers-Regel). Container: das Binary direkt aus binDir.
 */
function pgWrap(bin, binArgs, runtime = { direct: false }) {
  if (runtime.direct) return { cmd: path.join(runtime.binDir, path.basename(bin)), args: binArgs };
  return { cmd: 'sudo', args: ['-u', PG_SUPERUSER, bin, ...binArgs] };
}

/** Umgebung für einen Admin-Aufruf: im Container mit PGPASSWORD des DB-Admins. */
function adminEnv(runtime) {
  const env = { ...process.env };
  if (runtime.direct && runtime.adminPassword) env.PGPASSWORD = runtime.adminPassword;
  return env;
}

/** Im Container ohne Admin-Passwort sind Backup/Restore nicht möglich. */
function adminMissing(runtime) {
  return runtime.direct && !runtime.adminPassword;
}
const ADMIN_MISSING_HINT = 'DVHUB_DB_ADMIN_PASSWORD ist im Container nicht gesetzt (Passwort des DB-Admins, siehe docker/compose.yml).';

/**
 * Pure: build the pg_dump argv for a scope against a telemetry.database config.
 * Connection mirrors db-client.js createPool so the dump talks to the same DB
 * the app uses (unix socket + peer auth by default; PGPASSWORD added by the
 * runner when a password is configured).
 *
 * @returns {{ok:true, args:string[], dbName:string} | {ok:false, error:string}}
 */
export function buildPgDumpArgs({ scope, database = {}, superuser = false, runtime = { direct: false } } = {}) {
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
  const user = superuser ? adminUser(runtime) : (database.user || 'dvhub');
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
export function streamPgDump({ scope, database = {}, res, securityHeaders = {}, stamp, pushLog, spawnFn = spawn, runtime = pgRuntime() } = {}) {
  // superuser:true → dump EVERYTHING (incl. postgres-owned tables) as postgres.
  const built = buildPgDumpArgs({ scope, database, superuser: true, runtime });
  if (!built.ok) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: built.error }));
    return;
  }
  if (adminMissing(runtime)) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'db_admin_missing', hint: ADMIN_MISSING_HINT }));
    return;
  }

  const env = adminEnv(runtime);

  let child;
  try {
    const w = pgWrap(PG_DUMP_BIN, built.args, runtime);
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
export function dumpToFile({ scope, database = {}, outFile, spawnFn = spawn, runtime = pgRuntime() } = {}) {
  return new Promise((resolve) => {
    // Container mit Admin-Zugang: wie der GUI-Download als DB-Admin (sonst
    // scheitert ein Full-Dump an postgres-eigenen Tabellen einer migrierten DB).
    const asAdmin = runtime.direct && !adminMissing(runtime);
    const built = buildPgDumpArgs({ scope, database, superuser: asAdmin, runtime });
    if (!built.ok) { resolve({ ok: false, code: null, stderr: built.error, file: outFile }); return; }
    const args = [...built.args, '-f', outFile];
    const env = asAdmin ? adminEnv(runtime) : { ...process.env };
    if (!asAdmin && database.password) env.PGPASSWORD = String(database.password);
    let child;
    try {
      // Container: pg_dump liegt nicht im PATH (postgresql17-client → binDir).
      child = spawnFn(runtime.direct ? path.join(runtime.binDir, 'pg_dump') : 'pg_dump', args, { env });
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
export function buildPgRestoreArgs({ database = {}, file, runtime = { direct: false }, clean = true } = {}) {
  if (!file || typeof file !== 'string') return { ok: false, error: 'missing_file' };
  const host = database.host || '/var/run/postgresql';
  const port = String(database.port || 5432);
  const dbName = database.name || database.database || 'dvhub';
  // Restore runs as the postgres superuser (peer auth after sudo) and KEEPS the
  // dump's ownership + grants (no --no-owner/--no-privileges) so every object
  // lands under its original role — the app (dvhub) keeps write access, and
  // postgres-owned tables (victron_internals) restore correctly too.
  const args = ['-h', host, '-p', port, '-U', adminUser(runtime), '-d', dbName];
  // clean=false: Ziel-DB wurde frisch angelegt (Vollwiederherstellung, s. runDbRestore).
  if (clean) args.push('--clean', '--if-exists');
  args.push(file);
  return { ok: true, args, dbName };
}

/**
 * Pure: build a psql argv that runs one SQL command against the same DB (for
 * the TimescaleDB pre/post_restore dance + backend termination). -Atqc keeps
 * output minimal and script-parseable; ON_ERROR_STOP surfaces real failures.
 */
export function buildPsqlArgs({ database = {}, sql, runtime = { direct: false }, dbOverride = null } = {}) {
  const host = database.host || '/var/run/postgresql';
  const port = String(database.port || 5432);
  // dbOverride: Wartungs-DB (postgres) für DROP/CREATE DATABASE.
  const dbName = dbOverride || database.name || database.database || 'dvhub';
  // Runs as postgres (peer auth after sudo): the pre/post_restore dance +
  // pg_terminate_backend must reliably reach background workers and every
  // client backend, not just the app role's own connections.
  return ['-h', host, '-p', port, '-U', adminUser(runtime), '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-Atqc', sql];
}

const ROLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/;
const BUILTIN_ROLES = new Set(['public', 'postgres', 'current_user', 'session_user', 'current_role']);

/**
 * Pure: Rollen, auf die sich das Schema-SQL eines Dumps bezieht (Eigentümer,
 * GRANT … TO, REVOKE … FROM). Für den Container-Restore: eine frische DB kennt
 * nur postgres + dvhub; Rollen einer Alt-Installation (grafana, vlogger, …)
 * werden vorher als NOLOGIN angelegt, damit GRANTs und Eigentümer 1:1 ankommen
 * — auch die GRANTs an dvhub auf postgres-eigenen Tabellen. Nur gültige,
 * einfache Rollennamen; pg_*-Systemrollen und PUBLIC ausgenommen.
 * @param {string} sql
 * @returns {string[]}
 */
export function rolesFromSchemaSql(sql) {
  const roles = new Set();
  const take = (list) => {
    for (const raw of String(list).split(',')) {
      const name = raw.trim().replace(/;$/, '').replace(/^"(.*)"$/, '$1');
      if (!ROLE_NAME_RE.test(name) || BUILTIN_ROLES.has(name.toLowerCase()) || name.startsWith('pg_')) continue;
      roles.add(name);
    }
  };
  for (const line of String(sql || '').split('\n')) {
    let m;
    if ((m = /^ALTER .* OWNER TO (.+);$/.exec(line))) take(m[1]);
    else if ((m = /^GRANT .* TO (.+?)( WITH GRANT OPTION)?;$/.exec(line))) take(m[1]);
    else if ((m = /^REVOKE .* FROM (.+);$/.exec(line))) take(m[1]);
  }
  return [...roles].sort();
}

/** Schema-SQL eines Dumps lesen (pg_restore -s -f -, ohne DB) → Rollen. */
function dumpRoles(file, runtime, spawnFn) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnFn(path.join(runtime.binDir, 'pg_restore'), ['-s', '-f', '-', file], { env: { ...process.env } }); }
    catch { resolve([]); return; }
    const roles = new Set();
    let rest = '';
    const feed = (text) => { for (const r of rolesFromSchemaSql(text)) roles.add(r); };
    if (child.stdout) {
      child.stdout.on('data', (d) => {
        const buf = rest + d.toString();
        const cut = buf.lastIndexOf('\n');
        if (cut < 0) { rest = buf; return; }
        feed(buf.slice(0, cut));
        rest = buf.slice(cut + 1);
      });
    }
    child.on('error', () => resolve([...roles]));
    child.on('close', () => { feed(rest); resolve([...roles].sort()); });
  });
}

/**
 * Pure: ist das Inhaltsverzeichnis (pg_restore -l) ein VOLLSTÄNDIGER
 * TimescaleDB-Dump? Nur dann wird die Ziel-DB neu angelegt; ein Dump nur der
 * 15-min-Tabelle ersetzt ausschließlich diese Tabelle.
 */
export function isFullTimescaleToc(toc) {
  return /^\s*\d+;\s*\d+\s+\d+\s+EXTENSION\s+-\s+timescaledb\b/m.test(String(toc || ''));
}

/** Spawn a command, buffer stdout/stderr, resolve an outcome. Never rejects. */
function runCmd(cmd, args, env, spawnFn, { fullStdout = false } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnFn(cmd, args, { env }); }
    catch (err) { resolve({ ok: false, code: null, stdout: '', stderr: err.message }); return; }
    let stdout = '', stderr = '';
    // fullStdout: Inhaltsverzeichnis eines Dumps (einige MB) — bis 64 MB.
    const cap = fullStdout ? 64 * 1024 * 1024 : 8000;
    if (child.stdout) child.stdout.on('data', (d) => { if (stdout.length < cap) stdout += d.toString(); });
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
export async function runDbRestore({ database = {}, inFile, spawnFn = spawn, runtime = pgRuntime() } = {}) {
  const probeArgs = buildPgRestoreArgs({ database, file: inFile, runtime });
  if (!probeArgs.ok) return { ok: false, code: null, stderr: probeArgs.error, hadTimescale: false, ignoredErrors: 0 };
  if (adminMissing(runtime)) return { ok: false, code: null, stderr: ADMIN_MISSING_HINT, hadTimescale: false, ignoredErrors: 0 };
  const env = adminEnv(runtime);
  const psql = (sql, dbOverride = null) => {
    const w = pgWrap(PG_PSQL_BIN, buildPsqlArgs({ database, sql, runtime, dbOverride }), runtime);
    return runCmd(w.cmd, w.args, env, spawnFn);
  };

  // 0. Inhaltsverzeichnis lesen (prüft zugleich, dass die Datei lesbar ist —
  //    VOR jedem zerstörenden Schritt). Ein vollständiger TimescaleDB-Dump
  //    lässt sich NICHT per --clean über eine laufende DB legen: DROP TABLE der
  //    Hypertable scheitert an ihren Chunks („other objects depend on it“), die
  //    Extension ebenso. Dann wird die DB leer neu angelegt (wie Timescale es
  //    für pg_restore vorsieht) und ohne --clean eingespielt.
  const tocWrap = pgWrap(PG_RESTORE_BIN, ['-l', inFile], runtime);
  const toc = await runCmd(tocWrap.cmd, tocWrap.args, env, spawnFn, { fullStdout: true });
  if (!toc.ok) return { ok: false, code: toc.code, stderr: `Dump unlesbar: ${toc.stderr}`.slice(0, 2000), hadTimescale: false, ignoredErrors: 0 };
  const recreate = isFullTimescaleToc(toc.stdout);
  const built = buildPgRestoreArgs({ database, file: inFile, runtime, clean: !recreate });
  const owner = database.user || 'dvhub';
  if (recreate && !ROLE_NAME_RE.test(owner)) {
    return { ok: false, code: null, stderr: 'ungültiger DB-Benutzer', hadTimescale: false, ignoredErrors: 0 };
  }

  // 1. Is TimescaleDB present on the target?
  const extProbe = await psql("SELECT 1 FROM pg_extension WHERE extname='timescaledb'");
  const hadTimescale = recreate || (extProbe.ok && extProbe.stdout.includes('1'));

  // 2. Enter TimescaleDB restore mode (stops background workers; imports chunks
  //    as plain tables). Flag the DB (not just the session) so pg_restore's own
  //    connection sees it.
  if (hadTimescale && !recreate) {
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
  // Container: fehlende Rollen des Dumps (Alt-Installation) vorher anlegen,
  // damit Eigentümer und GRANTs 1:1 ankommen (s. rolesFromSchemaSql).
  if (runtime.direct) {
    for (const role of await dumpRoles(inFile, runtime, spawnFn)) {
      await psql(`DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE "${role}" NOLOGIN; END IF; END$$`);
    }
  }

  await psql(`ALTER DATABASE "${built.dbName}" CONNECTION LIMIT 0`);
  await psql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'");

  if (recreate) {
    // Leer neu anlegen — gesperrt (CONNECTION LIMIT 0), bis der Restore durch ist.
    const drop = await psql(`DROP DATABASE IF EXISTS "${built.dbName}" WITH (FORCE)`, 'postgres');
    const create = drop.ok
      ? await psql(`CREATE DATABASE "${built.dbName}" OWNER "${owner}" CONNECTION LIMIT 0`, 'postgres')
      : drop;
    if (!create.ok) {
      // Nichts eingespielt; DB (falls noch vorhanden) wieder freigeben.
      await psql(`ALTER DATABASE "${built.dbName}" CONNECTION LIMIT -1`, 'postgres');
      return { ok: false, code: create.code, stderr: `DB konnte nicht neu angelegt werden: ${create.stderr}`.slice(0, 2000), hadTimescale, ignoredErrors: 0 };
    }
    await psql('CREATE EXTENSION IF NOT EXISTS timescaledb');
    await psql('SELECT timescaledb_pre_restore()');
    await psql(`ALTER DATABASE "${built.dbName}" SET timescaledb.restoring = 'on'`);
  }

  // 4. The restore itself (as postgres via sudo).
  const restoreWrap = pgWrap(PG_RESTORE_BIN, built.args, runtime);
  const restore = await runCmd(restoreWrap.cmd, restoreWrap.args, env, spawnFn);

  // 5. ALWAYS unwind — re-open connections + leave restore mode — even on
  //    failure, so the DB is never left locked out or stuck in restore mode.
  await psql(`ALTER DATABASE "${built.dbName}" CONNECTION LIMIT -1`);
  if (hadTimescale) {
    // Cross-version restore reconcile: a dump from an OLDER TimescaleDB (e.g.
    // prod 2.25.2 → a fresh box on 2.28.2) restores the catalog's version marker
    // behind the installed binary, so timescaledb_post_restore() raises "catalog
    // version mismatch" and the DB stays stuck in restoring mode. Bring the
    // extension objects up to the binary version and align the marker to it, then
    // post_restore succeeds. Same-version restores no-op here. (Only ever moves
    // the marker toward the installed binary; a newer dump on an older binary is
    // unsupported and still fails loudly.)
    await psql('ALTER EXTENSION timescaledb UPDATE');
    await psql(
      "UPDATE _timescaledb_catalog.metadata m SET value = e.extversion " +
      "FROM pg_extension e WHERE e.extname = 'timescaledb' " +
      "AND m.key = 'timescaledb_version' AND m.value <> e.extversion"
    );
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
