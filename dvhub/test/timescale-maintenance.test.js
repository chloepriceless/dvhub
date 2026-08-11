import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { parseVersions, readTimescaleStatus, runTimescaleExtUpgrade } from '../services/timescale-maintenance.js';

// --- parseVersions (pure) ---------------------------------------------------

test('parseVersions: matching ext/binary → not pending', () => {
  const v = parseVersions('2.28.2|2.28.2');
  assert.deepEqual(v, { extVersion: '2.28.2', binaryVersion: '2.28.2', updatePending: false });
});

test('parseVersions: newer binary than extension → pending', () => {
  const v = parseVersions('2.25.2|2.28.2\n');
  assert.equal(v.extVersion, '2.25.2');
  assert.equal(v.binaryVersion, '2.28.2');
  assert.equal(v.updatePending, true);
});

test('parseVersions: package present but extension not created → ext null, not pending', () => {
  const v = parseVersions('|2.28.2');
  assert.equal(v.extVersion, null);
  assert.equal(v.binaryVersion, '2.28.2');
  assert.equal(v.updatePending, false);
});

test('parseVersions: empty (no timescaledb) → all null', () => {
  const v = parseVersions('');
  assert.deepEqual(v, { extVersion: null, binaryVersion: null, updatePending: false });
});

// --- shared mock ------------------------------------------------------------
// Routes `sudo -u postgres /usr/bin/psql … <sql>` and `sudo systemctl restart
// postgresql.service`. `versions` feeds successive VERSIONS_SQL probes (before,
// after, …). Emits on the next tick so runCmd's listeners attach first.
function mockSpawn({ versions = [], responses = {} } = {}) {
  const calls = [];
  let vIdx = 0;
  const fn = (cmd, args) => {
    const isPsql = (args || []).includes('/usr/bin/psql');
    const isSystemctl = !!(args && args[0] === 'systemctl');
    const sql = isPsql ? args[args.length - 1] : null;
    calls.push({ cmd, args, kind: isSystemctl ? 'systemctl' : (isPsql ? 'psql' : 'other'), sql });
    let r = {};
    if (isSystemctl) {
      r = responses.systemctl || {};
    } else if (isPsql) {
      if (/pg_available_extensions/.test(sql)) {
        const v = versions.length ? versions[Math.min(vIdx, versions.length - 1)] : '';
        vIdx++;
        r = { stdout: v == null ? '' : v };
      } else if (sql === 'SELECT 1') {
        r = { stdout: '1' };
      } else if (/ALTER EXTENSION/.test(sql)) {
        r = responses.alter || {};
      } else {
        r = {}; // metadata reconcile etc. → exit 0
      }
    }
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
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

const noSleep = async () => {};

// --- readTimescaleStatus ----------------------------------------------------

test('readTimescaleStatus: live probe is authoritative, file adds bookkeeping', async () => {
  const spawnFn = mockSpawn({ versions: ['2.28.2|2.28.2'] });
  const readFileFn = async () => JSON.stringify({
    extVersion: '2.25.2', binaryVersion: '2.25.2', edition: 'timescale',
    pgMajor: '17', lastChecked: '2026-07-02T03:17:00Z', lastPkgUpgrade: '2026-07-01T03:17:00Z'
  });
  const s = await readTimescaleStatus({ statusFile: '/x.json', database: { name: 'dvhub' }, spawnFn, readFileFn });
  assert.equal(s.ok, true);
  assert.equal(s.extVersion, '2.28.2', 'live version wins over the file');
  assert.equal(s.binaryVersion, '2.28.2');
  assert.equal(s.updatePending, false);
  assert.equal(s.available, true);
  assert.equal(s.edition, 'timescale', 'edition merged from file');
  assert.equal(s.lastChecked, '2026-07-02T03:17:00Z');
  assert.equal(s.lastPkgUpgrade, '2026-07-01T03:17:00Z');
});

test('readTimescaleStatus: updatePending computed from the live probe', async () => {
  const spawnFn = mockSpawn({ versions: ['2.25.2|2.28.2'] });
  const readFileFn = async () => { throw new Error('ENOENT'); }; // no status file yet
  const s = await readTimescaleStatus({ statusFile: '/x.json', database: {}, spawnFn, readFileFn });
  assert.equal(s.updatePending, true);
  assert.equal(s.extVersion, '2.25.2');
  assert.equal(s.binaryVersion, '2.28.2');
  assert.equal(s.lastChecked, null, 'no file → no bookkeeping');
});

test('readTimescaleStatus: no TimescaleDB → available:false', async () => {
  const spawnFn = mockSpawn({ versions: [''] });
  const readFileFn = async () => { throw new Error('ENOENT'); };
  const s = await readTimescaleStatus({ statusFile: '/x.json', database: {}, spawnFn, readFileFn });
  assert.equal(s.available, false);
  assert.equal(s.extVersion, null);
});

// --- runTimescaleExtUpgrade -------------------------------------------------

test('runTimescaleExtUpgrade: already current → no-op, no Postgres restart', async () => {
  const spawnFn = mockSpawn({ versions: ['2.28.2|2.28.2'] });
  const out = await runTimescaleExtUpgrade({ database: { name: 'dvhub' }, spawnFn, sleepFn: noSleep });
  assert.equal(out.ok, true);
  assert.equal(out.alreadyCurrent, true);
  assert.equal(out.restarted, false);
  assert.equal(out.from, '2.28.2');
  assert.equal(out.to, '2.28.2');
  assert.ok(!spawnFn.calls.some((c) => c.kind === 'systemctl'), 'no Postgres restart when nothing pending');
});

test('runTimescaleExtUpgrade: pending → restart → ALTER → reconcile → restart → verified', async () => {
  const spawnFn = mockSpawn({ versions: ['2.25.2|2.28.2', '2.28.2|2.28.2'] });
  const out = await runTimescaleExtUpgrade({ database: { name: 'dvhub' }, spawnFn, sleepFn: noSleep });
  assert.equal(out.ok, true);
  assert.equal(out.restarted, true);
  assert.equal(out.from, '2.25.2');
  assert.equal(out.to, '2.28.2');
  assert.ok(!out.alreadyCurrent);

  // Two Postgres restarts, ALTER EXTENSION between them.
  const restarts = spawnFn.calls.filter((c) => c.kind === 'systemctl');
  assert.equal(restarts.length, 2, 'Postgres bounced exactly twice');
  for (const c of restarts) assert.deepEqual(c.args, ['systemctl', 'restart', 'postgresql.service']);

  const kinds = spawnFn.calls.map((c) => c.kind === 'systemctl' ? 'RESTART' : c.sql);
  const iAlter = kinds.findIndex((s) => String(s).includes('ALTER EXTENSION timescaledb UPDATE'));
  const iReconcile = kinds.findIndex((s) => String(s).includes('_timescaledb_catalog.metadata'));
  const iFirstRestart = kinds.indexOf('RESTART');
  const iLastRestart = kinds.lastIndexOf('RESTART');
  assert.ok(iFirstRestart >= 0 && iFirstRestart < iAlter, 'restart BEFORE ALTER (load new .so)');
  assert.ok(iAlter < iLastRestart, 'restart AFTER ALTER (backends on new version)');
  assert.ok(iReconcile > iAlter && iReconcile < iLastRestart, 'catalog marker reconciled between');
});

test('runTimescaleExtUpgrade: ALTER fails → ok:false, alter_extension_failed', async () => {
  const spawnFn = mockSpawn({
    versions: ['2.25.2|2.28.2'],
    responses: { alter: { code: 1, stderr: 'ERROR: could not update' } }
  });
  const out = await runTimescaleExtUpgrade({ database: {}, spawnFn, sleepFn: noSleep });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'alter_extension_failed');
});

test('runTimescaleExtUpgrade: pre-restart fails → ok:false, no ALTER attempted', async () => {
  const spawnFn = mockSpawn({
    versions: ['2.25.2|2.28.2'],
    responses: { systemctl: { code: 1, stderr: 'Failed to restart postgresql.service' } }
  });
  const out = await runTimescaleExtUpgrade({ database: {}, spawnFn, sleepFn: noSleep });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'pg_restart_failed_pre');
  assert.ok(!spawnFn.calls.some((c) => String(c.sql).includes('ALTER EXTENSION')), 'never ran ALTER');
});

test('runTimescaleExtUpgrade: TimescaleDB not active → ok:false, nothing bounced', async () => {
  const spawnFn = mockSpawn({ versions: [''] });
  const out = await runTimescaleExtUpgrade({ database: {}, spawnFn, sleepFn: noSleep });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'timescaledb_not_active');
  assert.ok(!spawnFn.calls.some((c) => c.kind === 'systemctl'), 'no restart');
});
