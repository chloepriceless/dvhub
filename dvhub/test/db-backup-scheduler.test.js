import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { backupDueDay, createDbBackupScheduler } from '../services/db-backup-scheduler.js';

const baseCfg = (over = {}) => ({
  telemetry: { database: { name: 'dvhub' } },
  dbBackup: { enabled: true, scope: 'full', time: '03:30', destinationDir: '/x', retentionCount: 14, ...over }
});

test('backupDueDay fires at HH:MM once per day', () => {
  const cfg = baseCfg();
  const at = (h, m) => new Date(2026, 5, 1, h, m, 0);
  assert.equal(backupDueDay(cfg, at(3, 29), null), null);
  assert.equal(backupDueDay(cfg, at(3, 30), null), '2026-06-01');
  // already ran today → no refire in the same minute
  assert.equal(backupDueDay(cfg, at(3, 30), '2026-06-01'), null);
  assert.equal(backupDueDay(cfg, at(3, 31), '2026-06-01'), null);
});

test('backupDueDay respects enabled / destinationDir / time format', () => {
  const at = new Date(2026, 5, 1, 3, 30, 0);
  assert.equal(backupDueDay(baseCfg({ enabled: false }), at, null), null);
  assert.equal(backupDueDay(baseCfg({ destinationDir: '' }), at, null), null);
  assert.equal(backupDueDay(baseCfg({ time: 'nonsense' }), at, null), null);
  assert.equal(backupDueDay({}, at, null), null);
});

// Fake pg_dump that "writes" the -f target file then exits 0/1.
function fakeSpawn(exitCode, { writeFile = true } = {}) {
  return (_cmd, args) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    const fi = args.indexOf('-f');
    const outFile = fi >= 0 ? args[fi + 1] : null;
    queueMicrotask(() => {
      if (exitCode === 0 && writeFile && outFile) fs.writeFileSync(outFile, 'PGDMP-fake');
      if (exitCode !== 0) child.stderr.emit('data', Buffer.from('FATAL: boom'));
      child.emit('close', exitCode);
    });
    return child;
  };
}

test('runNow writes a dump to destinationDir and prunes to retentionCount', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvbk-'));
  // Seed 3 old backups; retentionCount 2 → after a new dump (4 total) prune to 2.
  for (const d of ['2026-05-01-0330', '2026-05-02-0330', '2026-05-03-0330']) {
    fs.writeFileSync(path.join(dir, `dvhub-full-${d}.dump`), 'old');
  }
  const logs = [];
  const sched = createDbBackupScheduler({
    getCfg: () => baseCfg({ destinationDir: dir, retentionCount: 2 }),
    pushLog: (e, d) => logs.push([e, d]),
    nowFn: () => new Date(2026, 5, 4, 3, 30, 0),
    spawnFn: fakeSpawn(0)
  });
  const r = await sched.runNow('manual');
  assert.equal(r.ok, true);
  const remaining = fs.readdirSync(dir).filter(f => f.endsWith('.dump')).sort();
  assert.equal(remaining.length, 2, 'pruned to retentionCount');
  // newest two kept (04 just created + 03)
  assert.ok(remaining.includes('dvhub-full-2026-06-04-0330.dump'));
  assert.ok(remaining.includes('dvhub-full-2026-05-03-0330.dump'));
  assert.ok(logs.some(([e]) => e === 'db_backup_scheduled_ok'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runNow on pg_dump failure removes the partial file and reports error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvbk-'));
  const sched = createDbBackupScheduler({
    getCfg: () => baseCfg({ destinationDir: dir }),
    pushLog: () => {},
    nowFn: () => new Date(2026, 5, 4, 3, 30, 0),
    spawnFn: fakeSpawn(1, { writeFile: false })
  });
  const r = await sched.runNow('manual');
  assert.equal(r.ok, false);
  assert.match(r.error, /boom/);
  assert.equal(fs.readdirSync(dir).filter(f => f.endsWith('.dump')).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runNow refuses without destinationDir', async () => {
  const sched = createDbBackupScheduler({ getCfg: () => baseCfg({ destinationDir: '' }), pushLog: () => {} });
  const r = await sched.runNow('manual');
  assert.equal(r.ok, false);
  assert.match(r.error, /destinationDir/);
});

test('getStatus reflects config + last run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvbk-'));
  const sched = createDbBackupScheduler({
    getCfg: () => baseCfg({ destinationDir: dir, scope: 'energy15m' }),
    pushLog: () => {},
    nowFn: () => new Date(2026, 5, 4, 3, 30, 0),
    spawnFn: fakeSpawn(0)
  });
  await sched.runNow('manual');
  const s = sched.getStatus();
  assert.equal(s.enabled, true);
  assert.equal(s.scope, 'energy15m');
  assert.equal(s.lastResult, 'ok');
  assert.equal(s.destinationDir, dir);
  fs.rmSync(dir, { recursive: true, force: true });
});
