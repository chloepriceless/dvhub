// test/storage-mounts.test.js — mehrere Datenträger, Wachstum, Reichweite
// (Speicher-Konzept 23.11.2026, Schritt 2). Kundenfall: Datenbank auf eigener
// 6-GB-Partition, die Wache maß nur das DVhub-Datenverzeichnis.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  mountCandidates, statPath, measureMounts, mountFor, recordSample, growthMbPerDay, reserveMb, daysLeft,
  readPgDataDirectory, readSamples, writeSamples,
} from '../services/storage-mounts.js';
import { createStorageGuard } from '../services/storage-guard.js';

const GB = 1024; // MB
// Zwei Platten: /var/lib/postgresql (6 GB, fast voll) und / (32 GB, frei).
const DISKS = {
  '/var/lib/postgresql': { dev: 2, totalMb: 6 * GB, freeMb: 300 },
  '/': { dev: 1, totalMb: 32 * GB, freeMb: 20 * GB },
};
function diskOf(p) {
  const hit = Object.keys(DISKS).filter((k) => p === k || p.startsWith(k === '/' ? '/' : `${k}/`)).sort((a, b) => b.length - a.length)[0];
  return DISKS[hit];
}
const fakeStatfs = (denied = []) => (p) => {
  if (denied.includes(p)) { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; }
  const d = diskOf(p);
  return { bsize: 1048576, blocks: d.totalMb, bavail: d.freeMb };
};
const fakeStat = (p) => ({ dev: diskOf(p).dev });

test('Kandidaten: nativ mit PG-Datenverzeichnis, Docker mit bzw. ohne DB-Volume', () => {
  assert.deepEqual(mountCandidates({ container: false, dataDir: '/var/lib/dvhub', pgDataDir: '/var/lib/postgresql/17/main' }).map((c) => c.role),
    ['db', 'data', 'system', 'logs']);
  const withVol = mountCandidates({ container: true, dataDir: '/var/lib/dvhub', exists: () => true });
  assert.deepEqual(withVol[0], { role: 'db', path: '/run/dvhub-dbvol' });
  const without = mountCandidates({ container: true, dataDir: '/var/lib/dvhub', exists: () => false });
  assert.deepEqual(without[0], { role: 'db', path: '/', assumed: true }, 'S6 a: Platte der Docker-Wurzel');
  assert.ok(!without.some((c) => c.role === 'logs'));
});

test('PG-Datenverzeichnis nicht lesbar (0700): Elternordner auf derselben Platte', () => {
  const m = statPath('/var/lib/postgresql/17/main', { statfs: fakeStatfs(['/var/lib/postgresql/17/main']), stat: fakeStat });
  assert.equal(m.measuredPath, '/var/lib/postgresql/17');
  assert.equal(m.totalMb, 6 * GB);
});

test('Getrennte Partitionen: DB-Platte ist maßgeblich, dieselbe Platte zählt einmal', () => {
  const mounts = measureMounts(mountCandidates({ dataDir: '/var/lib/dvhub', pgDataDir: '/var/lib/postgresql/17/main' }),
    { statfs: fakeStatfs(), stat: fakeStat });
  assert.equal(mounts.length, 2);
  assert.deepEqual(mounts[0].roles, ['db']);
  assert.deepEqual(mounts[1].roles, ['data', 'system', 'logs']);
  assert.equal(mountFor(mounts, 'db').freeMb, 300);
});

test('Wachstum erst ab 2 Tagen Abstand, über bis zu 7 Tage, Schrumpfen zählt 0', () => {
  let s = [];
  const m = (usedMb) => [{ roles: ['db'], usedMb }];
  s = recordSample(s, { day: '2026-11-20', mounts: m(1000) });
  s = recordSample(s, { day: '2026-11-21', mounts: m(1200) });
  assert.equal(growthMbPerDay(s, 'db'), null);
  s = recordSample(s, { day: '2026-11-22', mounts: m(1400) });
  assert.equal(growthMbPerDay(s, 'db'), 200);
  s = recordSample(s, { day: '2026-11-22', mounts: m(1500) });
  assert.equal(s.length, 3, 'derselbe Tag ersetzt');
  assert.equal(growthMbPerDay(s, 'db'), 250);
  s = recordSample(s, { day: '2026-11-24', mounts: m(900) });
  assert.equal(growthMbPerDay(s, 'db'), 0);
  for (let i = 0; i < 40; i++) s = recordSample(s, { day: `2027-01-${String(i % 28 + 1).padStart(2, '0')}`, mounts: m(i) });
  assert.ok(s.length <= 35);
});

test('Reserve und Reichweite', () => {
  assert.equal(reserveMb({ container: true, maxWalMb: 1024 }), 1536 + 1024 + 230);
  assert.equal(reserveMb({ container: false, maxWalMb: 256 }), 512 + 256 + 230);
  assert.equal(daysLeft({ freeMb: 6000, reserveMb: 1000, growth: 200 }), 25);
  assert.equal(daysLeft({ freeMb: 6000, reserveMb: 1000, growth: 0 }), null);
  assert.equal(daysLeft({ freeMb: 500, reserveMb: 1000, growth: 100 }), 0);
});

test('SHOW data_directory über sudo -u postgres psql (sudoers-Regel), Fehler → null', async () => {
  const fake = (code, out) => (cmd, args) => {
    assert.equal(cmd, 'sudo');
    assert.deepEqual(args.slice(0, 4), ['-n', '-u', 'postgres', '/usr/bin/psql']);
    assert.ok(args.includes('SHOW data_directory'));
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.kill = () => {};
    setImmediate(() => { c.stdout.emit('data', Buffer.from(out)); c.emit('close', code); });
    return c;
  };
  assert.equal(await readPgDataDirectory({ database: { name: 'dvhub' }, spawnFn: fake(0, '/var/lib/postgresql/17/main\n') }), '/var/lib/postgresql/17/main');
  assert.equal(await readPgDataDirectory({ spawnFn: fake(1, '') }), null);
  assert.equal(await readPgDataDirectory({ spawnFn: () => { throw new Error('kein sudo'); } }), null);
});

test('Messpunkte-Datei: schreiben und lesen, kaputte Datei → leer', () => {
  const files = {};
  const io = { writeFile: (f, d) => { files[f] = d; }, rename: (a, b) => { files[b] = files[a]; delete files[a]; } };
  writeSamples('/d', [{ day: '2026-11-23', used: { db: 1 } }], io);
  assert.deepEqual(readSamples('/d', (f) => files[f]), [{ day: '2026-11-23', used: { db: 1 } }]);
  assert.deepEqual(readSamples('/d', () => '{kaputt'), []);
});

test('Wache: misst die DB-Platte (nicht den DVhub-Ordner), Reichweite im Hinweis, andere Platte nur Hinweis', async () => {
  const files = {};
  const io = { writeFile: (f, d) => { files[f] = d; }, rename: (a, b) => { files[b] = files[a]; delete files[a]; }, readFile: (f) => { if (!(f in files)) throw new Error('ENOENT'); return files[f]; } };
  // Messpunkte von vor 3 Tagen: 450 MB/Tag Wachstum auf der DB-Platte.
  files['/var/lib/dvhub/storage-samples.json'] = JSON.stringify({ samples: [{ day: '2026-11-20', used: { db: 6 * GB - 300 - 1350 } }] });
  const warn = {};
  const r = await createStorageGuard({
    getDb: () => null, getDataDir: () => '/var/lib/dvhub', getPgDataDir: async () => '/var/lib/postgresql/17/main',
    statfs: fakeStatfs(), stat: fakeStat, now: () => Date.parse('2026-11-23T12:00:00Z'), samplesIo: io,
    setWarning: (id, m) => { warn[id] = m; },
  }).check();
  assert.equal(r.totalMb, 6 * GB, 'DB-Partition maßgeblich');
  assert.equal(r.level, 'kritisch');
  assert.equal(r.mounts.length, 2);
  assert.equal(r.growthMbPerDay, 450);
  assert.equal(r.daysLeft, 0, 'unter der Reserve');
  assert.match(warn.storage, /Speicher kritisch: 4\.9 % frei \(300 MB\), voll in etwa 0 Tagen/);
  assert.equal(warn.storage_other, null, 'Systemplatte hat genug Platz');
  assert.ok(files['/var/lib/dvhub/storage-samples.json'].includes('2026-11-23'), 'Messpunkt des Tages geschrieben');
});

test('Wache: Systemplatte fast voll, DB-Platte frei → eigener Hinweis', async () => {
  const saved = { ...DISKS['/'] };
  DISKS['/'].freeMb = 600; DISKS['/var/lib/postgresql'].freeMb = 5 * GB;
  try {
    const warn = {};
    const r = await createStorageGuard({
      getDb: () => null, getDataDir: () => '/var/lib/dvhub', getPgDataDir: async () => '/var/lib/postgresql/17/main',
      statfs: fakeStatfs(), stat: fakeStat, setWarning: (id, m) => { warn[id] = m; }, samplesIo: { readFile: () => { throw new Error('x'); }, writeFile() {}, rename() {} },
    }).check();
    assert.equal(r.level, 'ok');
    assert.equal(warn.storage, null);
    assert.match(warn.storage_other, /DVhub-Ordner \+ Systemplatte \(\/\) \+ Protokoll-Platte \(\/var\/log\) kritisch: 1\.8 % frei \(600 MB\)/);
  } finally { Object.assign(DISKS['/'], saved); DISKS['/var/lib/postgresql'].freeMb = 300; }
});

// Codex 38d2f56d (P1): ein Elternordner auf einer ANDEREN Platte darf nicht als DB-Platte gelten.
test('Pfad nicht messbar, Elternordner auf anderer Platte → nicht als DB-Platte', () => {
  // /srv/pg ist Einhängepunkt einer eigenen Platte (dev 9), aber nicht erreichbar; / ist dev 1.
  const statfs = (p) => { if (p.startsWith('/srv/pg')) { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; } return { bsize: 1048576, blocks: 32 * GB, bavail: 20 * GB }; };
  const stat = (p) => ({ dev: p.startsWith('/srv/pg') ? 9 : 1 });
  assert.equal(statPath('/srv/pg/17/main', { statfs, stat }), null);
  const noStat = (p) => { if (p.startsWith('/srv/pg')) throw new Error('EACCES'); return { dev: 1 }; };
  assert.equal(statPath('/srv/pg/17/main', { statfs, stat: noStat }), null, 'Platte nicht belegbar → null');
  const mounts = measureMounts(mountCandidates({ dataDir: '/var/lib/dvhub', pgDataDir: '/srv/pg/17/main' }), { statfs, stat });
  assert.equal(mountFor(mounts, 'db'), null, 'keine falsche DB-Platte');
});

// Codex 38d2f56d (P2): Docker overlay2 — / hat eigene Geräte-Nummer, liegt aber auf der Platte der Volumes.
test('Docker: Overlay-Wurzel und Volumes auf derselben Platte zählen einmal', () => {
  const statfs = (p) => (p === '/'
    ? { type: 0x794c7630, bsize: 4096, blocks: 30000000, bavail: 1000000, files: 1900000, ffree: 1500000 }
    : { type: 0xef53, bsize: 4096, blocks: 30000000, bavail: 1000004, files: 1900000, ffree: 1500002 });
  const stat = (p) => ({ dev: p === '/' ? 77 : 2049 });
  const mounts = measureMounts(mountCandidates({ container: true, dataDir: '/var/lib/dvhub', exists: () => true }), { statfs, stat });
  assert.equal(mounts.length, 1);
  assert.deepEqual(mounts[0].roles, ['db', 'data', 'system']);
  assert.ok(!('_overlay' in mounts[0]));
});

test('SHOW data_directory nutzt Host/Socket und Port der Konfiguration (Codex 38d2f56d)', async () => {
  let seen = null;
  const spawnFn = (cmd, args) => {
    seen = args;
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.kill = () => {};
    setImmediate(() => { c.stdout.emit('data', Buffer.from('/srv/pg/main\n')); c.emit('close', 0); });
    return c;
  };
  assert.equal(await readPgDataDirectory({ database: { host: '/run/pg2', port: 5434, name: 'dvhub' }, spawnFn }), '/srv/pg/main');
  assert.deepEqual(seen.slice(seen.indexOf('-h'), seen.indexOf('-h') + 4), ['-h', '/run/pg2', '-p', '5434']);
});

// Codex bec0a2c7 (P2): zwei verschiedene, gleich große Platten nicht zusammenlegen.
test('Docker: gleich große, aber verschiedene Platten bleiben getrennt', () => {
  const statfs = (p) => (p === '/'
    ? { type: 0x794c7630, bsize: 4096, blocks: 30000000, bavail: 2850000, files: 1900000, ffree: 1500000 }
    : { type: 0xef53, bsize: 4096, blocks: 30000000, bavail: 3120000, files: 1900000, ffree: 1700000 });
  const stat = (p) => ({ dev: p === '/' ? 77 : 2049 });
  const mounts = measureMounts(mountCandidates({ container: true, dataDir: '/var/lib/dvhub', exists: () => true }), { statfs, stat });
  assert.equal(mounts.length, 2);
});

// Codex bec0a2c7 (P2): localhost/127.0.0.1 über TCP bräuchte ein Passwort → Unix-Socket mit dem Port.
test('SHOW data_directory: TCP-Loopback geht über den Unix-Socket (peer), Port bleibt', async () => {
  let seen = null;
  const spawnFn = (cmd, args) => {
    seen = args;
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.kill = () => {};
    setImmediate(() => { c.stdout.emit('data', Buffer.from('/var/lib/postgresql/17/main\n')); c.emit('close', 0); });
    return c;
  };
  await readPgDataDirectory({ database: { host: '127.0.0.1', port: 5433, name: 'dvhub' }, spawnFn });
  assert.deepEqual(seen.slice(seen.indexOf('-h'), seen.indexOf('-h') + 4), ['-h', '/var/run/postgresql', '-p', '5433']);
});

// Codex bec0a2c7 (P1): DB-Platte bekannt, aber nicht messbar → keine Aufräumaktion nach einer anderen Platte.
test('Wache: DB-Platte nicht messbar → nichts in der DB aufräumen, eigener Hinweis', async () => {
  const statfs = (p) => { if (p.startsWith('/srv/pg')) throw new Error('EACCES'); return { bsize: 1048576, blocks: 3000, bavail: 60 }; };
  const stat = (p) => { if (p.startsWith('/srv/pg')) throw new Error('EACCES'); return { dev: 1 }; };
  const calls = [];
  const db = { async query(sql) { calls.push(sql); if (sql.includes('pg_extension')) return { rows: [{}] }; return { rows: [] }; } };
  const warn = {};
  const r = await createStorageGuard({ getDb: () => db, getDataDir: () => '/var/lib/dvhub', getPgDataDir: async () => '/srv/pg/17/main',
    statfs, stat, setWarning: (id, m) => { warn[id] = m; }, samplesIo: { readFile: () => { throw new Error('x'); }, writeFile() {}, rename() {} } }).check();
  assert.equal(r.dbUnmeasured, true);
  assert.ok(!calls.some((q) => /compress_chunk|drop_chunks|DELETE/.test(q)), 'kein Aufräumen');
  assert.match(warn.storage, /Datenbank-Platte nicht messbar/);
  assert.match(warn.storage_other, /DVhub-Ordner/, 'die volle andere Platte wird trotzdem gemeldet');
});
