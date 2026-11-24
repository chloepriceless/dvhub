// test/release-dev-worker.test.js — lokaler dev-Paket-Worker (scripts/release/dev-worker.sh).
// Christin 24.11.2026: der Mac baut nach jedem grünen main-Push selbst das
// dev-Paket. Geprüft wird die Steuerlogik auf einem Wegwerf-Repo mit
// Stellvertretern für ci-check.py, build-release.sh, publish-release.sh,
// ssh-keygen und osascript; GitHub (API + Kanal-Index) ist ein lokaler HTTP-Server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const WORKER = path.join(repoRoot, 'scripts/release/dev-worker.sh');
const skip = process.platform === 'win32' ? 'nur Unix' : false;

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const BUILD_STUB = `#!/usr/bin/env bash
set -euo pipefail
sha="$1"; shift; out=""; key=""
while [[ $# -gt 0 ]]; do case "$1" in --out) out="$2"; shift 2;; --key) key="$2"; shift 2;; *) shift;; esac; done
echo "build $sha key=$(basename "$key") sock=\${SSH_AUTH_SOCK:+ja}" >> "$FAKE_CALLS"
[[ "\${FAKE_BUILD_FAIL:-}" == 1 ]] && exit 1
d="$out/1.0.12-dev.20261124000000.\${sha:0:8}"; mkdir -p "$d"
printf '{"version":"%s","channel":"dev","git_sha":"%s"}\\n' "$(basename "$d")" "$sha" > "$d/release.json"
`;
const PUBLISH_STUB = `#!/usr/bin/env bash
set -euo pipefail
echo "publish $* token=\${GH_TOKEN:+ja}" >> "$FAKE_CALLS"
build="$1"; dest=""; dry=0
while [[ $# -gt 0 ]]; do case "$1" in --dry-run) dry=1; shift;; --dest) dest="$2"; shift 2;; *) shift;; esac; done
if [[ $dry == 1 ]]; then mkdir -p "$dest"; else sed -n 's/.*"git_sha":"\\([0-9a-f]*\\)".*/\\1/p' "$build/release.json" >> "$FAKE_PUBLISHED"; fi
`;
const CI_STUB = `import os, sys
print("CI stub rc " + os.environ.get("FAKE_CI_RC", "0"))
sys.exit(int(os.environ.get("FAKE_CI_RC", "0")))
`;
const SSHKEYGEN_STUB = `#!/usr/bin/env bash
mode="\${FAKE_SIGN:-ok}"
if [[ "$1" == -Y && "$2" == verify ]]; then exit 0; fi
case "$mode" in
  hang) exec sleep 60 ;;
  fail) echo "agent refused operation" >&2; exit 1 ;;
esac
file="\${@: -1}"; echo sig > "$file.sig"
`;
const OSASCRIPT_STUB = `#!/usr/bin/env bash
echo "\${@: -2:1}" >> "$FAKE_NOTIFY"
`;

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin');
  fs.mkdirSync(path.join(origin, 'scripts/release'), { recursive: true });
  fs.writeFileSync(path.join(origin, 'scripts/ci-check.py'), CI_STUB);
  fs.writeFileSync(path.join(origin, 'scripts/release/build-release.sh'), BUILD_STUB);
  fs.writeFileSync(path.join(origin, 'scripts/release/publish-release.sh'), PUBLISH_STUB);
  const g = (...a) => sh('git', ['-C', origin, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]);
  g('init', '-q', '-b', 'main');
  g('add', '.'); g('commit', '-qm', 'eins');
  const oldSha = g('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(origin, 'README'), 'zwei\n');
  g('add', '.'); g('commit', '-qm', 'zwei');
  const sha = g('rev-parse', 'HEAD');

  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'ssh-keygen'), SSHKEYGEN_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'osascript'), OSASCRIPT_STUB, { mode: 0o755 });
  const pub = path.join(root, 'release.pub');
  fs.writeFileSync(pub, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestTestTest test\n');

  // Agent-Socket (nur Existenz wird geprüft; ssh-keygen ist ein Stellvertreter).
  const sock = path.join(root, 's');
  const sockServer = net.createServer(() => {}).listen(sock);
  t.after(() => sockServer.close());

  const files = { calls: path.join(root, 'calls'), notify: path.join(root, 'notify'), published: path.join(root, 'published') };
  // Schon veröffentlichte SHAs (von Hand), zusätzlich zu dem, was publish-Stub einträgt.
  const remote = { extra: new Set(), auth: [] };
  const publishedShas = () => new Set([...remote.extra,
    ...(fs.existsSync(files.published) ? fs.readFileSync(files.published, 'utf8').split('\n').filter(Boolean) : [])]);
  const verOf = (s) => `1.0.12-dev.20261124000000.${s.slice(0, 8)}`;
  const server = http.createServer((req, res) => {
    remote.auth.push(req.headers.authorization || '');
    const shas = [...publishedShas()];
    if (req.url === '/repos/chloepriceless/dvhub/releases/tags/dev') {
      const assets = shas.flatMap((s) => ['arm64', 'armhf', 'amd64'].flatMap((a) =>
        [`dvhub-${verOf(s)}-${a}.tar.gz`, `dvhub-${verOf(s)}-${a}.tar.gz.sig`, `dvhub-${verOf(s)}-${a}.manifest.json`]))
        .map((name, id) => ({ id, name }));
      res.end(JSON.stringify({ assets }));
    } else if (req.url === '/chloepriceless/dvhub/releases/download/channels/index-dev.json') {
      res.end(JSON.stringify({ channel: 'dev', releases: shas.map((s) => ({ version: verOf(s), git_sha: s })) }));
    } else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const dwHome = path.join(root, 'dw home'); // Leerzeichen wie „Application Support“
  const log = path.join(root, 'logs/dev-worker.log');
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home, TMPDIR: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    DVHUB_DW_HOME: dwHome, DVHUB_DW_LOG: log, DVHUB_DW_ORIGIN: origin, DVHUB_DW_API: base, DVHUB_DW_DOWNLOAD: base,
    DVHUB_DW_SSH_AUTH_SOCK: sock, DVHUB_DW_PUBKEY: pub, DVHUB_DW_TEST: '1', DVHUB_DW_FAKE_TOKEN: 'test-token',
    DVHUB_DW_AGENT_TIMEOUT: '2',
    FAKE_CALLS: files.calls, FAKE_NOTIFY: files.notify, FAKE_PUBLISHED: files.published,
  };
  const run = (extraEnv = {}, args = []) => new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn('bash', [WORKER, ...args], { env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, err, ms: Date.now() - t0 }));
  });
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  return {
    root, sha, oldSha, dwHome, remote, run, env,
    calls: () => read(files.calls).split('\n').filter(Boolean),
    notes: () => read(files.notify).split('\n').filter(Boolean),
    log: () => read(log),
    state: (n) => read(path.join(dwHome, 'state', n)),
  };
}

test('schon veröffentlicht → nichts bauen, Zustand nachtragen, kein Doppel-Paket', { skip }, async (t) => {
  const w = await setup(t);
  w.remote.extra.add(w.sha);
  const r = await w.run();
  assert.equal(r.code, 0, r.err + w.log());
  assert.deepEqual(w.calls(), []);
  assert.match(w.log(), /schon veröffentlicht \(nicht durch den Worker\)/);
  assert.match(w.state('published'), new RegExp(`^${w.sha} 1\\.0\\.12-dev\\.\\d+\\.${w.sha.slice(0, 8)} \\S+ extern$`, 'm'));
  assert.deepEqual(w.notes(), []);
  assert.ok(w.remote.auth.every((a) => a === '' || a === 'Bearer test-token'));
  assert.ok(w.remote.auth.includes('Bearer test-token'), 'API-Abfrage mit Token (über curl -K -)');
});

test('CI rot → nichts bauen, genau einmal melden', { skip }, async (t) => {
  const w = await setup(t);
  for (let i = 0; i < 2; i++) {
    const r = await w.run({ FAKE_CI_RC: '1' });
    assert.equal(r.code, 0, r.err + w.log());
  }
  assert.deepEqual(w.calls(), []);
  assert.equal((w.log().match(/CI rot — nichts gebaut/g) || []).length, 2);
  assert.equal(w.notes().length, 1, w.notes().join('|'));
  assert.match(w.notes()[0], /CI rot/);
  // CI läuft noch → still warten
  const r3 = await w.run({ FAKE_CI_RC: '3' });
  assert.equal(r3.code, 0);
  assert.match(w.log(), /CI läuft noch/);
  assert.deepEqual(w.calls(), []);
});

test('grün → bauen, veröffentlichen, Zustand; zweiter Lauf tut nichts', { skip }, async (t) => {
  const w = await setup(t);
  const r = await w.run();
  assert.equal(r.code, 0, r.err + w.log());
  const calls = w.calls();
  assert.equal(calls.length, 2, calls.join('\n'));
  assert.equal(calls[0], `build ${w.sha} key=release_agent sock=ja`);
  assert.match(calls[1], /^publish .*1\.0\.12-dev\.20261124000000\.[0-9a-f]{8} --key .*release_agent token=ja$/);
  assert.doesNotMatch(calls[1], /--dry-run/);
  assert.match(w.state('published'), new RegExp(`^${w.sha} .* worker$`, 'm'));
  assert.match(w.notes().join('\n'), /veröffentlicht/);
  const key = path.join(w.dwHome, 'key/release_agent');
  assert.equal(fs.statSync(key).mode & 0o777, 0o600);
  const r2 = await w.run();
  assert.equal(r2.code, 0);
  assert.equal(w.calls().length, 2, 'kein zweiter Bau');
  assert.match(w.log(), /schon veröffentlicht — nichts zu tun/);
  // Arbeits-Checkout bleibt unberührt: der Worker arbeitet im eigenen Klon.
  assert.ok(fs.existsSync(path.join(w.dwHome, 'repo/.git')));
});

test('1Password wartet auf Freigabe → Zeitlimit, kein Bau, einmal melden, kein Hängen', { skip }, async (t) => {
  const w = await setup(t);
  for (let i = 0; i < 2; i++) {
    const r = await w.run({ FAKE_SIGN: 'hang', DVHUB_DW_AGENT_TIMEOUT: '1' });
    assert.equal(r.code, 1);
    assert.ok(r.ms < 20000, `Lauf dauerte ${r.ms} ms`);
  }
  assert.deepEqual(w.calls(), []);
  assert.equal((w.log().match(/Freigabe in 1Password nötig/g) || []).length, 2);
  assert.equal(w.notes().length, 1);
  assert.match(w.notes()[0], /Freigabe in 1Password nötig/);
  // Danach signiert der Agent wieder → Bau läuft, Sperr-Meldung zurückgesetzt.
  const r = await w.run();
  assert.equal(r.code, 0, w.log());
  assert.equal(w.calls().length, 2);
  assert.match(w.log(), /1Password-Agent signiert wieder/);
});

test('Agent verweigert → Fehler gemeldet, kein Bau', { skip }, async (t) => {
  const w = await setup(t);
  const r = await w.run({ FAKE_SIGN: 'fail' });
  assert.equal(r.code, 1);
  assert.deepEqual(w.calls(), []);
  assert.match(w.log(), /Signieren über den 1Password-Agenten fehlgeschlagen/);
});

test('Sperre: zweiter Lauf bricht ab; verwaiste Sperre wird übernommen', { skip }, async (t) => {
  const w = await setup(t);
  const first = w.run({ FAKE_SIGN: 'hang', DVHUB_DW_AGENT_TIMEOUT: '6' });
  const pidFile = path.join(w.dwHome, 'lock/pid');
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(pidFile) || fs.readFileSync(pidFile, 'utf8').split('\n').length < 3) {
    assert.ok(Date.now() < deadline, 'erster Lauf nimmt die Sperre nicht');
    await new Promise((r) => setTimeout(r, 50));
  }
  const second = await w.run();
  assert.equal(second.code, 0);
  assert.ok(second.ms < 5000, `zweiter Lauf wartete ${second.ms} ms`);
  assert.match(w.log(), /läuft schon \(PID \d+/);
  const r1 = await first;
  assert.equal(r1.code, 1);
  assert.deepEqual(w.calls(), []);
  assert.ok(!fs.existsSync(path.join(w.dwHome, 'lock')), 'Sperre nach Lauf entfernt');

  // Verwaiste Sperre eines beendeten Prozesses.
  const dead = spawnSync('bash', ['-c', 'echo $$']).stdout.toString().trim();
  fs.mkdirSync(path.join(w.dwHome, 'lock'));
  fs.writeFileSync(pidFile, `${dead}\nMon Jan  1 00:00:00 2026\n${Math.floor(Date.now() / 1000)}\n`);
  const r3 = await w.run();
  assert.equal(r3.code, 0, w.log());
  assert.match(w.log(), /verwaiste Sperre \(PID \d+\) übernommen/);
  assert.equal(w.calls().length, 2);
});

test('Bau scheitert → höchstens DW_MAX_FAILS Versuche je Commit', { skip }, async (t) => {
  const w = await setup(t);
  for (let i = 0; i < 4; i++) await w.run({ FAKE_BUILD_FAIL: '1', DVHUB_DW_MAX_FAILS: '3' });
  assert.equal(w.calls().filter((c) => c.startsWith('build')).length, 3);
  assert.ok(!w.calls().some((c) => c.startsWith('publish')));
  assert.match(w.log(), /gebe für [0-9a-f]{8} auf/);
  assert.match(w.log(), /aufgegeben — wartet auf neuen main-Commit/);
  assert.equal(w.notes().length, 2, w.notes().join('|')); // erster und letzter Versuch
});

test('--dry-run --sha: baut älteren main-Commit, publish nur --dry-run, kein Zustand', { skip }, async (t) => {
  const w = await setup(t);
  w.remote.extra.add(w.oldSha); // auch schon veröffentlichte Stände lassen sich trocken bauen
  const r = await w.run({}, ['--dry-run', '--sha', w.oldSha]);
  assert.equal(r.code, 0, r.err + w.log());
  const calls = w.calls();
  assert.equal(calls[0], `build ${w.oldSha} key=release_agent sock=ja`);
  assert.match(calls[1], /--dry-run --dest .*dry\/1\.0\.12-dev/);
  assert.match(calls[1], /token=$/, 'Trockenlauf bekommt kein Token');
  assert.equal(w.state('published'), '');
  assert.match(w.log(), /Trockenlauf ok/);
  // Fremder Commit (nicht auf origin/main) wird abgelehnt.
  const r2 = await w.run({}, ['--dry-run', '--sha', 'deadbeef']);
  assert.equal(r2.code, 1);
});

test('Plist: alle 10 min, nicht beim Laden, Node 22 im PATH', { skip }, () => {
  const out = sh('bash', [WORKER, '--print-plist'], { env: { ...process.env, HOME: '/Users/x' } });
  assert.match(out, /<string>zone\.bikini\.dvhub-dev-worker<\/string>/);
  assert.match(out, /<key>StartInterval<\/key>\s*<integer>600<\/integer>/);
  assert.match(out, /<key>RunAtLoad<\/key>\s*<false\/>/);
  assert.match(out, /\/opt\/homebrew\/opt\/node@22\/bin:\/opt\/homebrew\/bin:/);
  assert.match(out, /Library\/Application Support\/dvhub-dev-worker\/bin\/dev-worker\.sh/);
  if (process.platform === 'darwin') {
    const r = spawnSync('plutil', ['-lint', '-'], { input: out, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }
});

test('Signieren pausiert → kein Signierversuch (keine 1Password-Rückfrage), kein Bau', { skip }, async (t) => {
  const w = await setup(t);
  fs.mkdirSync(path.join(w.dwHome, 'state'), { recursive: true });
  fs.writeFileSync(path.join(w.dwHome, 'state/sign-paused'), 'Test\n');
  for (let i = 0; i < 2; i++) {
    const r = await w.run({ FAKE_SIGN: 'hang', DVHUB_DW_AGENT_TIMEOUT: '1' });
    assert.equal(r.code, 0, w.log());
  }
  assert.deepEqual(w.calls(), []);
  assert.doesNotMatch(w.log(), /Freigabe in 1Password|Signier-Probe|Signieren über/);
  assert.equal((w.log().match(/Signieren pausiert/g) || []).length, 2);
  assert.equal(w.notes().length, 1);
  fs.rmSync(path.join(w.dwHome, 'state/sign-paused'));
  const r = await w.run();
  assert.equal(r.code, 0, w.log());
  assert.equal(w.calls().length, 2, 'nach dem Entfernen läuft der Bau');
});
