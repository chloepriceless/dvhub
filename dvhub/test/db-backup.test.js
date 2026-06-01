import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { buildPgDumpArgs, backupFilename, streamPgDump, DB_BACKUP_SCOPES } from '../services/db-backup.js';

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
