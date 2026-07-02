import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { buildPgDumpArgs, backupFilename, streamPgDump, selectBackupsToDelete, DB_BACKUP_SCOPES, buildPgRestoreArgs, buildPsqlArgs, runDbRestore } from '../services/db-backup.js';

test('selectBackupsToDelete keeps the N newest of a scope, oldest deleted first', () => {
  const files = [
    'dvhub-full-2026-05-01-0330.dump',
    'dvhub-full-2026-05-02-0330.dump',
    'dvhub-full-2026-05-03-0330.dump',
    'dvhub-energy15m-2026-05-03-0330.dump', // other scope — never touched
    'something-else.txt'
  ];
  assert.deepEqual(selectBackupsToDelete(files, 'full', 2), ['dvhub-full-2026-05-01-0330.dump']);
  assert.deepEqual(selectBackupsToDelete(files, 'full', 3), []);
  assert.deepEqual(selectBackupsToDelete(files, 'energy15m', 1), []);
});

test('selectBackupsToDelete with keep<=0 or invalid deletes NOTHING (safety)', () => {
  const files = ['dvhub-full-2026-05-01-0330.dump', 'dvhub-full-2026-05-02-0330.dump'];
  assert.deepEqual(selectBackupsToDelete(files, 'full', 0), []);
  assert.deepEqual(selectBackupsToDelete(files, 'full', -3), []);
  assert.deepEqual(selectBackupsToDelete(files, 'full', NaN), []);
});

test('full scope dumps the whole DB (no -t table filter)', () => {
  const r = buildPgDumpArgs({ scope: 'full', database: { host: '/var/run/postgresql', port: 5432, name: 'dvhub', user: 'dvhub' } });
  assert.equal(r.ok, true);
  assert.equal(r.dbName, 'dvhub');
  assert.ok(r.args.includes('-Fc'));
  assert.ok(r.args.includes('--no-owner'));
  assert.ok(!r.args.includes('-t'));
  assert.deepEqual(r.args.slice(0, 8), ['-h', '/var/run/postgresql', '-p', '5432', '-U', 'dvhub', '-d', 'dvhub']);
});

test('energy15m scope restricts to the energy_slots_15m table', () => {
  const r = buildPgDumpArgs({ scope: 'energy15m', database: { name: 'dvhub' } });
  assert.equal(r.ok, true);
  const i = r.args.indexOf('-t');
  assert.ok(i >= 0);
  assert.equal(r.args[i + 1], 'energy_slots_15m');
});

test('defaults match db-client.js createPool when config sparse', () => {
  const r = buildPgDumpArgs({ scope: 'full', database: {} });
  assert.deepEqual(r.args.slice(0, 8), ['-h', '/var/run/postgresql', '-p', '5432', '-U', 'dvhub', '-d', 'dvhub']);
});

test('invalid scope rejected', () => {
  assert.equal(buildPgDumpArgs({ scope: 'everything' }).ok, false);
  assert.ok(!DB_BACKUP_SCOPES.has('everything'));
  assert.ok(DB_BACKUP_SCOPES.has('full') && DB_BACKUP_SCOPES.has('energy15m'));
});

test('backupFilename encodes scope + stamp', () => {
  assert.equal(backupFilename('full', '2026-06-01-1234'), 'dvhub-full-2026-06-01-1234.dump');
  assert.equal(backupFilename('energy15m', '2026-06-01-1234'), 'dvhub-energy15m-2026-06-01-1234.dump');
});

// --- streamPgDump lifecycle with a fake child process + fake res ---

function fakeRes() {
  return {
    headersSent: false,
    statusCode: null,
    headers: null,
    chunks: [],
    destroyed: false,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; this.headersSent = true; },
    write(c) { this.chunks.push(c); },
    end(c) { if (c != null) this.chunks.push(c); this.ended = true; },
    destroy() { this.destroyed = true; }
  };
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.pipe = function () { /* no-op for the test */ };
  child.stderr = new EventEmitter();
  return child;
}

test('invalid scope → 400 JSON, never spawns', () => {
  const res = fakeRes();
  let spawned = false;
  streamPgDump({ scope: 'nope', res, spawnFn: () => { spawned = true; } });
  assert.equal(res.statusCode, 400);
  assert.equal(spawned, false);
});

test('first stdout chunk commits 200 + attachment headers', () => {
  const res = fakeRes();
  const child = fakeChild();
  streamPgDump({ scope: 'full', database: { name: 'dvhub' }, res, stamp: '2026-06-01-1200', spawnFn: () => child });
  child.stdout.emit('data', Buffer.from('PGDMP-bytes'));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/octet-stream');
  assert.match(res.headers['content-disposition'], /dvhub-full-2026-06-01-1200\.dump/);
  assert.deepEqual(res.chunks[0], Buffer.from('PGDMP-bytes'));
});

test('spawn error before output → 503 JSON', () => {
  const res = fakeRes();
  const child = fakeChild();
  streamPgDump({ scope: 'full', database: {}, res, spawnFn: () => child });
  child.emit('error', new Error('pg_dump ENOENT'));
  assert.equal(res.statusCode, 503);
  assert.match(String(res.chunks[0]), /pg_dump_unavailable/);
});

test('nonzero exit before output → 500 JSON with stderr', () => {
  const res = fakeRes();
  const child = fakeChild();
  streamPgDump({ scope: 'full', database: {}, res, spawnFn: () => child });
  child.stderr.emit('data', Buffer.from('FATAL: auth failed'));
  child.emit('close', 1);
  assert.equal(res.statusCode, 500);
  assert.match(String(res.chunks[0]), /pg_dump_failed/);
  assert.match(String(res.chunks[0]), /auth failed/);
});

test('nonzero exit MID-stream destroys the connection (no truncated "backup")', () => {
  const res = fakeRes();
  const child = fakeChild();
  streamPgDump({ scope: 'full', database: {}, res, stamp: 's', spawnFn: () => child });
  child.stdout.emit('data', Buffer.from('partial'));
  assert.equal(res.statusCode, 200);
  child.emit('close', 1);
  assert.equal(res.destroyed, true);
});

// --- backup/restore run as the postgres superuser (sudo) --------------------

test('buildPgDumpArgs superuser: connect as postgres, keep ownership + grants', () => {
  const r = buildPgDumpArgs({ scope: 'full', database: { name: 'dvhub' }, superuser: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.args.slice(0, 8), ['-h', '/var/run/postgresql', '-p', '5432', '-U', 'postgres', '-d', 'dvhub']);
  assert.ok(!r.args.includes('--no-owner'), 'ownership kept for a faithful full restore');
  assert.ok(!r.args.includes('--no-privileges'), 'grants kept so dvhub keeps access to postgres-owned tables');
});

test('buildPgDumpArgs legacy (default): app role + role-portable flags', () => {
  const r = buildPgDumpArgs({ scope: 'full', database: { name: 'dvhub' } });
  assert.deepEqual(r.args.slice(0, 8), ['-h', '/var/run/postgresql', '-p', '5432', '-U', 'dvhub', '-d', 'dvhub']);
  assert.ok(r.args.includes('--no-owner'));
});

test('buildPgRestoreArgs: postgres superuser + --clean --if-exists, keeps ownership, file last', () => {
  const r = buildPgRestoreArgs({ database: { name: 'dvhub' }, file: '/tmp/x.dump' });
  assert.equal(r.ok, true);
  assert.equal(r.dbName, 'dvhub');
  assert.deepEqual(r.args.slice(0, 8), ['-h', '/var/run/postgresql', '-p', '5432', '-U', 'postgres', '-d', 'dvhub']);
  for (const flag of ['--clean', '--if-exists']) assert.ok(r.args.includes(flag), flag);
  assert.ok(!r.args.includes('--no-owner'), 'ownership preserved on restore');
  assert.equal(r.args[r.args.length - 1], '/tmp/x.dump');
});

test('buildPgRestoreArgs: missing file rejected', () => {
  assert.equal(buildPgRestoreArgs({ database: {} }).ok, false);
  assert.equal(buildPgRestoreArgs({ database: {}, file: 123 }).ok, false);
});

test('buildPsqlArgs: postgres superuser + ON_ERROR_STOP + the sql as final arg', () => {
  const a = buildPsqlArgs({ database: { name: 'dvhub' }, sql: 'SELECT 1' });
  assert.deepEqual(a.slice(0, 8), ['-h', '/var/run/postgresql', '-p', '5432', '-U', 'postgres', '-d', 'dvhub']);
  assert.ok(a.includes('ON_ERROR_STOP=1'));
  assert.equal(a[a.length - 1], 'SELECT 1');
});

// --- runDbRestore orchestration (injected spawnFn) --------------------------

// Every pg tool is spawned as `sudo -u postgres <bin> …` (pgWrap). Detect the
// real binary from the argv so the mock can route + assert on it.
function pgBinOf(args) {
  const found = (args || []).find((a) => a === '/usr/bin/pg_dump' || a === '/usr/bin/pg_restore' || a === '/usr/bin/psql');
  return found ? found.split('/').pop() : null;
}

// responses(bin, args) → { stdout?, stderr?, code? }. Emits on the next tick so
// runCmd's synchronously-attached listeners are in place first.
function mockSpawn(responses) {
  const calls = [];
  const fn = (cmd, args) => {
    const bin = pgBinOf(args);
    calls.push({ cmd, args, bin, sql: args[args.length - 1] });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const r = responses(bin, args) || {};
    setImmediate(() => {
      if (r.stdout) child.stdout.emit('data', Buffer.from(r.stdout));
      if (r.stderr) child.stderr.emit('data', Buffer.from(r.stderr));
      child.emit('close', r.code == null ? 0 : r.code);
    });
    return child;
  };
  fn.calls = calls;
  return fn;
}

const isSudoPostgres = (c) => c.cmd === 'sudo' && c.args[0] === '-u' && c.args[1] === 'postgres';

test('runDbRestore: TimescaleDB present → pre/post_restore dance around pg_restore, all as sudo postgres', async () => {
  const spawnFn = mockSpawn((bin, args) => {
    if (bin === 'psql' && args[args.length - 1].includes('pg_extension')) return { stdout: '1\n' };
    return {};
  });
  const out = await runDbRestore({ database: { name: 'dvhub' }, inFile: '/tmp/x.dump', spawnFn });
  assert.equal(out.ok, true);
  assert.equal(out.hadTimescale, true);
  assert.ok(spawnFn.calls.every(isSudoPostgres), 'every pg tool runs via sudo -u postgres');
  const seq = spawnFn.calls.map((c) => c.bin === 'pg_restore' ? 'RESTORE' : c.sql);
  const iPre = seq.findIndex((s) => String(s).includes('timescaledb_pre_restore'));
  const iSet = seq.findIndex((s) => String(s).includes("restoring = 'on'"));
  const iRestore = seq.indexOf('RESTORE');
  const iReset = seq.findIndex((s) => String(s).includes('RESET timescaledb.restoring'));
  const iPost = seq.findIndex((s) => String(s).includes('timescaledb_post_restore'));
  assert.ok(iPre >= 0 && iSet >= 0 && iRestore >= 0 && iReset >= 0 && iPost >= 0, 'all steps present');
  assert.ok(iPre < iRestore && iSet < iRestore, 'pre_restore + SET before restore');
  assert.ok(iReset > iRestore && iPost > iRestore, 'RESET + post_restore after restore');
  assert.ok(seq.some((s) => String(s).includes('pg_terminate_backend')), 'terminates other backends');
  const iLock = seq.findIndex((s) => String(s).includes('CONNECTION LIMIT 0'));
  const iUnlock = seq.findIndex((s) => String(s).includes('CONNECTION LIMIT -1'));
  assert.ok(iLock >= 0 && iLock < iRestore, 'app locked out (CONNECTION LIMIT 0) before restore');
  assert.ok(iUnlock > iRestore, 'connections re-opened (CONNECTION LIMIT -1) after restore');
});

test('runDbRestore: no TimescaleDB → plain pg_restore, no dance', async () => {
  const spawnFn = mockSpawn((bin, args) => {
    if (bin === 'psql' && args[args.length - 1].includes('pg_extension')) return { stdout: '' }; // absent
    return {};
  });
  const out = await runDbRestore({ database: { name: 'dvhub' }, inFile: '/tmp/x.dump', spawnFn });
  assert.equal(out.ok, true);
  assert.equal(out.hadTimescale, false);
  const sqls = spawnFn.calls.map((c) => c.sql);
  assert.ok(!sqls.some((s) => String(s).includes('timescaledb_pre_restore')), 'no pre_restore');
  assert.ok(!sqls.some((s) => String(s).includes('timescaledb_post_restore')), 'no post_restore');
  assert.ok(spawnFn.calls.some((c) => c.bin === 'pg_restore'), 'still restores');
});

test('runDbRestore: parses "errors ignored on restore: N"', async () => {
  const spawnFn = mockSpawn((bin, args) => {
    if (bin === 'psql' && args[args.length - 1].includes('pg_extension')) return { stdout: '1' };
    if (bin === 'pg_restore') return { code: 0, stderr: 'pg_restore: warning: errors ignored on restore: 3' };
    return {};
  });
  const out = await runDbRestore({ database: {}, inFile: '/tmp/x.dump', spawnFn });
  assert.equal(out.ok, true);
  assert.equal(out.ignoredErrors, 3);
});

test('runDbRestore: pg_restore FAILS but post_restore STILL runs (DB never left stuck)', async () => {
  const spawnFn = mockSpawn((bin, args) => {
    if (bin === 'psql' && args[args.length - 1].includes('pg_extension')) return { stdout: '1' };
    if (bin === 'pg_restore') return { code: 1, stderr: 'pg_restore: error: could not connect' };
    return {};
  });
  const out = await runDbRestore({ database: {}, inFile: '/tmp/x.dump', spawnFn });
  assert.equal(out.ok, false);
  assert.equal(out.code, 1);
  const sqls = spawnFn.calls.map((c) => c.sql);
  assert.ok(sqls.some((s) => String(s).includes('timescaledb_post_restore')), 'post_restore ran despite failure');
});

test('runDbRestore: missing file → ok:false, nothing spawned', async () => {
  let spawned = false;
  const out = await runDbRestore({ database: {}, inFile: '', spawnFn: () => { spawned = true; } });
  assert.equal(out.ok, false);
  assert.equal(spawned, false);
});
