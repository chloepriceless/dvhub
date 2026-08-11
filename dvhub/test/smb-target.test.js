import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { parseSmbLs, buildSmbcArgs, buildSmbcCommand, smbExec } from '../services/smb-target.js';

test('parseSmbLs extracts dvhub backup filenames (deduped)', () => {
  const out = [
    '  .                                   D        0  Mon Jun  1 03:30:00 2026',
    '  dvhub-full-2026-05-30-0330.dump      A  7360349  Fri May 30 03:30:10 2026',
    '  dvhub-full-2026-05-31-0330.dump      A  7361200  Sat May 31 03:30:11 2026',
    '  dvhub-energy15m-2026-05-31-0330.dump A   740100  Sat May 31 03:31:00 2026',
    '  notes.txt                            A      12  ...'
  ].join('\n');
  assert.deepEqual(parseSmbLs(out), [
    'dvhub-full-2026-05-30-0330.dump',
    'dvhub-full-2026-05-31-0330.dump',
    'dvhub-energy15m-2026-05-31-0330.dump'
  ]);
  assert.deepEqual(parseSmbLs(''), []);
  assert.deepEqual(parseSmbLs('NT_STATUS_NO_SUCH_FILE listing dvhub-*.dump'), []);
});

test('buildSmbcCommand prefixes cd only when a subPath is given', () => {
  assert.equal(buildSmbcCommand('', ['put "/tmp/a" "a"']), 'put "/tmp/a" "a"');
  assert.equal(buildSmbcCommand('dvhub', ['ls dvhub-*.dump']), 'cd "dvhub"; ls dvhub-*.dump');
  assert.equal(buildSmbcCommand('/dvhub/sub', ['del "x"']), 'cd "dvhub/sub"; del "x"');
  assert.equal(buildSmbcCommand('d', ['del "a"', 'del "b"']), 'cd "d"; del "a"; del "b"');
});

test('buildSmbcArgs always authenticates via -A file, never password in argv', () => {
  const args = buildSmbcArgs({ host: '192.168.1.10', share: 'backups', authFile: '/tmp/x.auth', command: 'ls' });
  assert.deepEqual(args, ['//192.168.1.10/backups', '-A', '/tmp/x.auth', '-c', 'ls']);
  assert.ok(!args.join(' ').toLowerCase().includes('password'));
});

// smbExec with a fake fs (capture auth file) + fake spawn.
function fakeFs() {
  const files = {};
  return {
    files,
    writeFileSync(p, content, opts) { files[p] = { content, opts }; },
    unlinkSync(p) { delete files[p]; }
  };
}
function fakeSmbSpawn(code, stdout = '') {
  return () => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (stdout) c.stdout.emit('data', Buffer.from(stdout));
      c.emit('close', code);
    });
    return c;
  };
}

test('smbExec writes a 0600 auth file with creds and cleans it up', async () => {
  const fsMod = fakeFs();
  let authPathSeen = null;
  const spawnFn = (_cmd, args) => {
    authPathSeen = args[args.indexOf('-A') + 1];
    // auth file must exist (with mode 0600) at spawn time
    assert.ok(fsMod.files[authPathSeen], 'auth file present during exec');
    assert.equal(fsMod.files[authPathSeen].opts.mode, 0o600);
    assert.match(fsMod.files[authPathSeen].content, /username = bob/);
    assert.match(fsMod.files[authPathSeen].content, /password = s3cret/);
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
    queueMicrotask(() => c.emit('close', 0));
    return c;
  };
  const res = await smbExec({ host: 'h', share: 's', username: 'bob', password: 's3cret', command: 'ls', spawnFn, fsMod });
  assert.equal(res.ok, true);
  assert.equal(fsMod.files[authPathSeen], undefined, 'auth file deleted after exec');
});

test('smbExec reports failure on nonzero exit', async () => {
  const res = await smbExec({ host: 'h', share: 's', username: 'u', password: 'p', command: 'put x y', spawnFn: fakeSmbSpawn(1, 'NT_STATUS_ACCESS_DENIED'), fsMod: fakeFs() });
  assert.equal(res.ok, false);
  assert.match(res.stdout, /ACCESS_DENIED/);
});

// --- Review 2026-06-10 (B3): smbclient metachar sanitizing ---
import { buildSmbcCommand as _cmdB3, buildSmbcArgs as _argsB3 } from '../services/smb-target.js';

test('B3: subPath smbclient metachars are stripped (no command injection via cd)', () => {
  const cmd = _cmdB3('backups"; del dvhub-*; cd "x', ['ls dvhub-*.dump']);
  assert.ok(!cmd.includes('"; del'), `injection survived: ${cmd}`);
  assert.equal(cmd, 'cd "backups del dvhub-* cd x"; ls dvhub-*.dump');
});

test('B3: host/share are reduced to hostname/share charsets', () => {
  const args = _argsB3({ host: 'nas;rm -rf', share: 'back"up$', authFile: '/tmp/a', command: 'ls' });
  assert.equal(args[0], '//nasrm-rf/backup$');
});
