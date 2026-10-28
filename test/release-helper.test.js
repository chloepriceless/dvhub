// test/release-helper.test.js — Box-Seite der Release-Pakete: dvhub-release
// (docs/release-pakete.md). Argumentprüfung, Versionen, Signaturen (gut,
// verändert, falscher Schlüssel, Rotation), Index, und die Abläufe install /
// rollback / Rückweg bei schlechter Gesundheit / Abbruch beim Download /
// Umstellung git → Paket im Wegwerf-Wurzelordner mit lokalem HTTP-Server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { packTree, mergeIndex, sha256, createTar, gzipDeterministic, collectEntries } from '../scripts/release/lib/release-lib.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const H = require(path.join(repoRoot, 'dvhub-release.cjs'));
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ── Argumente und Hilfsfunktionen ───────────────────────────────────────────

test('parseArgs: nur feste Aktionen mit geprüften Werten', () => {
  assert.deepEqual(H.parseArgs(['check', 'stable']), { action: 'check', channel: 'stable' });
  assert.deepEqual(H.parseArgs(['install', 'latest', 'dev']), { action: 'install', version: 'latest', channel: 'dev' });
  assert.deepEqual(H.parseArgs(['install', '1.0.8-dev.20261027162124.c7a245a1', 'dev']).version, '1.0.8-dev.20261027162124.c7a245a1');
  assert.deepEqual(H.parseArgs(['rollback']), { action: 'rollback' });
  assert.deepEqual(H.parseArgs(['status']), { action: 'status' });
  assert.deepEqual(H.parseArgs(['migrate', '--force']), { action: 'migrate', force: true });
  assert.deepEqual(H.parseArgs(['_job', 'install', '1.0.9', 'stable']), { action: '_job', job: 'install', version: '1.0.9', channel: 'stable' });
  const bad = [[], ['nix'], ['check'], ['check', 'beta'], ['check', 'stable', 'x'], ['install', '1.0.9'], ['install', 'v1.0.9', 'stable'],
    ['install', '1.0.9;id', 'stable'], ['install', '../../etc', 'stable'], ['install', `1.0.9-${'a'.repeat(80)}`, 'stable'],
    ['install', '1.0.9', 'stable', '--force'], ['rollback', '1.0.8'], ['status', '--json'], ['migrate', '--yes'], ['_job', 'rm'],
    ['install', '--help', 'stable']];
  for (const a of bad) {
    assert.throws(() => H.parseArgs(a), (e) => e instanceof H.Exit && e.exitCode === 2, a.join(' '));
  }
});

test('Versionen, Node-Bereich, Label, Architektur, Konfiguration, offizielles Repo', () => {
  assert.equal(H.compareVersions('1.0.10', '1.0.9'), 1);
  assert.equal(H.compareVersions('1.0.8-dev.2', '1.0.8-dev.10'), -1);
  assert.equal(H.compareVersions('1.0.8-dev.1', '1.0.8'), -1);
  assert.ok(H.satisfiesEngine('>=22.0.0', 'v22.23.3'));
  assert.ok(!H.satisfiesEngine('>=22.0.0', 'v20.18.0'));
  assert.ok(H.satisfiesEngine('^22.1.0', 'v22.4.0') && !H.satisfiesEngine('^22.1.0', 'v23.0.0'));
  assert.ok(H.satisfiesEngine('', 'v1.0.0'));
  assert.equal(H.versionFromLabel('v1.0.9+abc1234'), '1.0.9');
  assert.equal(H.versionFromLabel('v1.0.8-dev.20261027162124.c7a245a1'), '1.0.8-dev.20261027162124.c7a245a1');
  assert.equal(H.debArch('arm'), 'armhf');
  assert.equal(H.debArch('x64'), 'amd64');
  for (const u of ['https://github.com/chloepriceless/dvhub.git', 'https://github.com/chloepriceless/dvhub', 'git@github.com:chloepriceless/dvhub.git']) {
    assert.ok(H.OFFICIAL_REPO_RE.test(u), u);
  }
  for (const u of ['https://github.com/someone/dvhub.git', 'https://git.example/chloepriceless/dvhub.git', 'https://github.com/chloepriceless/dvhub-1.0.git', '/srv/dvhub.git']) {
    assert.ok(!H.OFFICIAL_REPO_RE.test(u), u);
  }
  const d = tmp('dvhub-conf-');
  try {
    fs.writeFileSync(path.join(d, 'c'), 'base_url=http://mirror.local/rel\nhealth_timeout_s=30\nevil=1\n# x\n');
    assert.deepEqual(H.readConf(path.join(d, 'c')), { base_url: 'http://mirror.local/rel', health_timeout_s: '30' });
    fs.writeFileSync(path.join(d, 'c'), 'base_url=file:///etc\n');
    assert.deepEqual(H.readConf(path.join(d, 'c')), {});
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('rewriteUnit: git-Pfade (auch v0.4-Unit) → current', () => {
  const s = { installDir: '/opt/dvhub' };
  const unit = '[Service]\nWorkingDirectory=/opt/dvhub/dvhub\nExecStartPre=-+/usr/bin/bash /opt/dvhub/post-update.sh\nExecStart=/usr/bin/node /opt/dvhub/dvhub/server.js\nEnvironment=X=1\n';
  assert.equal(H.rewriteUnit(s, unit), '[Service]\nWorkingDirectory=/opt/dvhub/current/dvhub\nExecStartPre=-+/usr/bin/bash /opt/dvhub/current/post-update.sh\nExecStart=/usr/bin/node /opt/dvhub/current/dvhub/server.js\nEnvironment=X=1\n');
  const old = 'WorkingDirectory=/opt/dvhub/dvhub\nExecStart=/usr/bin/node --experimental-sqlite /opt/dvhub/dvhub/server.js\n';
  assert.equal(H.rewriteUnit(s, old), 'WorkingDirectory=/opt/dvhub/current/dvhub\nExecStart=/usr/bin/node /opt/dvhub/current/dvhub/server.js\n');
});

test('verifyTree: zusätzliche, fehlende und veränderte Dateien fallen auf', () => {
  const d = tmp('dvhub-tree-');
  try {
    fs.writeFileSync(path.join(d, 'a.sh'), 'x');
    fs.chmodSync(path.join(d, 'a.sh'), 0o755);
    const manifest = { files: [{ path: 'a.sh', sha256: sha256(Buffer.from('x')), size: 1, mode: '0755' }] };
    H.verifyTree(d, manifest);
    fs.writeFileSync(path.join(d, 'extra'), '');
    assert.throws(() => H.verifyTree(d, manifest), /zusätzliche Datei/);
    fs.rmSync(path.join(d, 'extra'));
    fs.writeFileSync(path.join(d, 'a.sh'), 'y');
    assert.throws(() => H.verifyTree(d, manifest), /Prüfsumme/);
    fs.rmSync(path.join(d, 'a.sh'));
    assert.throws(() => H.verifyTree(d, manifest), /fehlt/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Prüfstand: Box im Wegwerf-Ordner, lokaler Server, Schlüssel ──────────────

function keypair(dir, name) {
  const k = path.join(dir, name);
  assert.equal(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', k]).status, 0);
  return { key: k, line: `dvhub-release namespaces="dvhub-release,dvhub-release-index" ${fs.readFileSync(`${k}.pub`, 'utf8').trim()}` };
}

function sign(file, key, ns) {
  fs.rmSync(`${file}.sig`, { force: true });
  const r = spawnSync('ssh-keygen', ['-Y', 'sign', '-q', '-f', key, '-n', ns, file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

function makeRig() {
  const root = tmp('dvhub-rel-rig-');
  const pub = path.join(root, 'pub');
  const box = path.join(root, 'opt');
  const state = path.join(root, 'state');
  const etc = path.join(root, 'etc');
  for (const d of [pub, box, state, etc]) fs.mkdirSync(d, { recursive: true });
  const k1 = keypair(root, 'k1');
  const k2 = keypair(root, 'k2');
  const unitFile = path.join(root, 'dvhub.service');
  fs.writeFileSync(unitFile, 'Environment=DV_DATA_DIR=' + path.join(root, 'data') + '\n');
  const fakeBin = path.join(root, 'bin');
  fs.mkdirSync(fakeBin);
  const sysLog = path.join(root, 'systemctl.log');
  fs.writeFileSync(path.join(fakeBin, 'systemctl'), `#!/bin/sh\necho "$*" >> '${sysLog}'\ncase "$*" in *"is-active --quiet dvhub.service"*) exit 0;; is-active*) exit 3;; esac\nexit 0\n`, { mode: 0o755 });
  const runLog = path.join(root, 'systemd-run.log');
  fs.writeFileSync(path.join(fakeBin, 'systemd-run'), `#!/bin/sh\necho "$*" >> '${runLog}'\nexit 0\n`, { mode: 0o755 });

  const bad = new Set();
  const behaviour = { interruptOnce: new Set(), interruptAlways: new Set(), override: new Map() };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/health') {
      const cfgFile = path.join(root, 'config.json');
      const allowed = fs.existsSync(cfgFile) ? (JSON.parse(fs.readFileSync(cfgFile, 'utf8')).allowedHosts || []) : [];
      if (allowed.length && !allowed.includes(req.headers.host)) { res.writeHead(400); res.end('{"ok":false,"error":"host_not_allowed"}'); return; }
      let v = null;
      try { v = fs.readlinkSync(path.join(box, 'current')).replace(/^releases\//, ''); } catch { v = 'git'; }
      if (bad.has(v)) { res.writeHead(500); res.end('kaputt'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: v === 'git' ? 'v0.9.0+deadbee' : `v${v}` }));
      return;
    }
    const file = path.join(pub, decodeURIComponent(u.pathname));
    if (!file.startsWith(pub) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    let body = behaviour.override.get(u.pathname) || fs.readFileSync(file);
    const range = /^bytes=(\d+)-$/.exec(req.headers.range || '');
    const status = range ? 206 : 200;
    if (range) body = body.subarray(Number(range[1]));
    res.writeHead(status, { 'content-length': body.length });
    if (behaviour.interruptAlways.has(u.pathname) || (behaviour.interruptOnce.has(u.pathname) && !range)) {
      behaviour.interruptOnce.delete(u.pathname);
      res.write(body.subarray(0, Math.floor(body.length / 2)));
      setTimeout(() => res.destroy(), 20);
      return;
    }
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    fs.writeFileSync(path.join(etc, 'release.conf'), `base_url=http://127.0.0.1:${port}\n`);
    const env = {
      DVHUB_RELEASE_TEST_INSTALL_DIR: box, DVHUB_RELEASE_TEST_STATE_DIR: state, DVHUB_RELEASE_TEST_ETC_DIR: etc,
      DVHUB_RELEASE_TEST_EUID: '0', DVHUB_RELEASE_TEST_ARCH: 'arm64', DVHUB_RELEASE_TEST_UNIT_FILE: unitFile,
      DVHUB_RELEASE_TEST_SYSTEMCTL: path.join(fakeBin, 'systemctl'), DVHUB_RELEASE_TEST_SYSTEMD_RUN: path.join(fakeBin, 'systemd-run'),
      DVHUB_RELEASE_TEST_HEALTH_URL: `http://127.0.0.1:${port}/health`, DVHUB_RELEASE_TEST_FAST: '1', DVHUB_RELEASE_TEST_HEALTH_TIMEOUT_S: '2',
      DVHUB_RELEASE_TEST_CONFIG_DIR: root, DVHUB_RELEASE_TEST_DROPIN_DIR: path.join(root, 'dvhub.service.d'),
    };
    const settings = () => H.settings(env);
    const trust = (...lines) => fs.writeFileSync(path.join(etc, 'allowed_signers'), `${lines.join('\n')}\n`);
    trust(k1.line);
    const indexes = { stable: null, dev: null };

    // Paket bauen und veröffentlichen (wie publish-release.sh).
    const publish = ({ version, channel = 'stable', key = k1.key, trustLines = null, arch = 'arm64', manifestArch = arch, indexKey = key, extraFiles = {} }) => {
      const tree = fs.mkdtempSync(path.join(root, 'tree-'));
      const w = (p, c, mode = 0o644) => { fs.mkdirSync(path.dirname(path.join(tree, p)), { recursive: true }); fs.writeFileSync(path.join(tree, p), c, { mode }); };
      w('dvhub/server.js', `// ${version}\n`);
      w('dvhub/package.json', JSON.stringify({ name: 'dvhub', version: version.split('-')[0] }));
      w('post-update.sh', `#!/usr/bin/env bash\necho "post-update ${version} INSTALL_DIR=$INSTALL_DIR" >> "$INSTALL_DIR/../post-update.log"\n`, 0o755);
      w('eos-provision.sh', '#!/usr/bin/env bash\n', 0o755);
      w(`only-in-${version}.txt`, version);
      if (trustLines) w('release-keys/allowed_signers', `${trustLines.join('\n')}\n`);
      for (const [p, c] of Object.entries(extraFiles)) w(p, c);
      const { gz } = packTree(tree, { mtime: 1700000000, meta: { name: 'dvhub', version, channel, git_sha: 'a'.repeat(40), arch: manifestArch, node_engine: '>=18.0.0' } });
      fs.rmSync(tree, { recursive: true, force: true });
      const tag = channel === 'stable' ? `v${version}` : 'dev';
      const dir = path.join(pub, tag);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `dvhub-${version}-${arch}.tar.gz`);
      fs.writeFileSync(file, gz);
      sign(file, key, 'dvhub-release');
      indexes[channel] = mergeIndex(indexes[channel], { channel, release: { version, git_sha: 'a'.repeat(40), date: '2026-10-27T00:00:00Z', changes: [`Änderung ${version}`],
        artifacts: { [arch]: { url: `../${tag}/${path.basename(file)}`, sha256: sha256(gz), size: gz.length, sig: `../${tag}/${path.basename(file)}.sig` } } } });
      fs.mkdirSync(path.join(pub, 'channels'), { recursive: true });
      const idx = path.join(pub, 'channels', `index-${channel}.json`);
      fs.writeFileSync(idx, JSON.stringify(indexes[channel], null, 2));
      sign(idx, indexKey, 'dvhub-release-index');
      return { file, url: `/${tag}/${path.basename(file)}`, gz };
    };

    // Box mit installiertem Paket <version> (wie nach der Umstellung).
    const seed = (version, channel = 'stable') => {
      const { file } = publish({ version, channel });
      const dest = path.join(box, 'releases', version);
      fs.mkdirSync(dest, { recursive: true });
      assert.equal(spawnSync('tar', ['-xzf', file, '-C', dest]).status, 0);
      fs.symlinkSync(`releases/${version}`, path.join(box, 'current'));
      H.reconcileLinks(settings());
      fs.writeFileSync(path.join(state, 'state.json'), JSON.stringify({ format: 1, current: version, previous: null, history: [{ version, result: 'ok' }] }));
    };

    const run = async (...argv) => {
      const out = [];
      const s = { ...settings(), write: (c) => { out.push(String(c)); return true; } };
      const code = await H.main(argv, s).catch((e) => (e instanceof H.Exit ? e.exitCode : (out.push(e.message), 1)));
      return { code, out: out.join('') };
    };
    const status = () => JSON.parse(fs.readFileSync(path.join(state, 'status.json'), 'utf8'));
    const current = () => { try { return fs.readlinkSync(path.join(box, 'current')); } catch { return null; } };
    resolve({ root, pub, box, state, etc, k1, k2, bad, behaviour, publish, seed, run, status, current, trust, settings, unitFile, runLog, sysLog,
      close: () => { server.close(); fs.rmSync(root, { recursive: true, force: true }); } });
  }));
}

// ── Abläufe ─────────────────────────────────────────────────────────────────

test('install, Kompatibilitäts-Links, check, rollback und Re-Install', { timeout: 60000 }, async () => {
  const r = await makeRig();
  try {
    r.seed('1.0.0');
    r.publish({ version: '1.0.1' });
    const chk = await r.run('check', 'stable');
    assert.equal(chk.code, 0, chk.out);
    const c = JSON.parse(chk.out);
    assert.equal(c.mode, 'package');
    assert.equal(c.updateAvailable, true);
    assert.equal(c.latest.version, '1.0.1');
    assert.deepEqual(c.changelog, ['1.0.1: Änderung 1.0.1']);

    const inst = await r.run('install', 'latest', 'stable');
    assert.equal(inst.code, 0, JSON.stringify(r.status()));
    assert.equal(r.current(), 'releases/1.0.1');
    assert.equal(r.status().state, 'ok');
    assert.equal(fs.readlinkSync(path.join(r.box, 'dvhub')), 'current/dvhub');
    assert.equal(fs.readlinkSync(path.join(r.box, 'post-update.sh')), 'current/post-update.sh');
    assert.ok(fs.existsSync(path.join(r.box, 'only-in-1.0.1.txt')));
    assert.ok(!fs.existsSync(path.join(r.box, 'only-in-1.0.0.txt')) && !isLink(path.join(r.box, 'only-in-1.0.0.txt')), 'tote Links weg');
    assert.match(fs.readFileSync(path.join(r.root, 'post-update.log'), 'utf8'), new RegExp(`post-update 1.0.1 INSTALL_DIR=${r.box}`));
    assert.match(fs.readFileSync(r.sysLog, 'utf8'), /restart dvhub\.service/);
    const st = JSON.parse(fs.readFileSync(path.join(r.state, 'state.json'), 'utf8'));
    assert.equal(st.current, '1.0.1');
    assert.equal(st.previous, '1.0.0');
    assert.equal(st.pending, null);
    assert.equal(fs.readdirSync(path.join(r.state, 'staging')).filter((f) => f.endsWith('.tar.gz')).length, 0, 'Staging aufgeräumt');

    assert.equal((await r.run('check', 'stable')).out.includes('"updateAvailable":false'), true);
    assert.equal((await r.run('install', '1.0.0', 'stable')).code, 3, 'kein Downgrade per install');

    const rb = await r.run('rollback');
    assert.equal(rb.code, 0, JSON.stringify(r.status()));
    assert.equal(r.current(), 'releases/1.0.0');
    assert.equal(JSON.parse((await r.run('status')).out).previous, '1.0.1');
    const again = await r.run('rollback');
    assert.equal(again.code, 0);
    assert.equal(r.current(), 'releases/1.0.1', 'rollback wechselt hin und her');
  } finally { r.close(); }
});

test('Negativ: verändertes Paket, falsche Paket-Signatur, falsche Index-Signatur, falsche Architektur', { timeout: 60000 }, async () => {
  const r = await makeRig();
  try {
    r.seed('1.0.0');
    const p = r.publish({ version: '1.0.1' });
    const tampered = Buffer.from(p.gz);
    tampered[tampered.length - 100] ^= 0xff;
    r.behaviour.override.set(p.url, tampered);
    let res = await r.run('install', 'latest', 'stable');
    assert.notEqual(res.code, 0);
    assert.match(r.status().message, /Prüfsumme/);
    assert.equal(r.current(), 'releases/1.0.0');
    assert.ok(!fs.existsSync(path.join(r.box, 'releases/1.0.1')));
    r.behaviour.override.clear();

    r.publish({ version: '1.0.2', key: r.k2.key });
    res = await r.run('install', 'latest', 'stable');
    assert.notEqual(res.code, 0);
    assert.match(r.status().message, /Signatur ungültig/);
    assert.equal(r.current(), 'releases/1.0.0');

    r.publish({ version: '1.0.3', indexKey: r.k2.key });
    res = await r.run('check', 'stable');
    assert.notEqual(res.code, 0);

    r.publish({ version: '1.0.4', manifestArch: 'amd64' });
    res = await r.run('install', 'latest', 'stable');
    assert.notEqual(res.code, 0);
    assert.match(r.status().message, /Paket für amd64/);
    assert.equal(r.current(), 'releases/1.0.0');

    r.trust('# kein Schlüssel');
    res = await r.run('install', 'latest', 'stable');
    assert.equal(res.code, 3);
    assert.match(r.status().message, /kein Release-Schlüssel/);
  } finally { r.close(); }
});

test('Negativ: neue Version nicht gesund → automatisch zurück, Release-Ordner weg', { timeout: 60000 }, async () => {
  const r = await makeRig();
  try {
    r.seed('1.0.0');
    r.publish({ version: '1.0.1' });
    r.bad.add('1.0.1');
    const res = await r.run('install', 'latest', 'stable');
    assert.equal(res.code, 1);
    assert.equal(r.status().state, 'rolled_back');
    assert.equal(r.current(), 'releases/1.0.0');
    assert.ok(!fs.existsSync(path.join(r.box, 'releases/1.0.1')));
    const st = JSON.parse(fs.readFileSync(path.join(r.state, 'state.json'), 'utf8'));
    assert.equal(st.current, '1.0.0');
    assert.equal(st.pending, null);
    assert.equal(st.history.at(-1).result, 'rolled_back');
  } finally { r.close(); }
});

test('Negativ: Download bricht ab — einmal (setzt fort) und immer (sauber gescheitert)', { timeout: 60000 }, async () => {
  const r = await makeRig();
  try {
    r.seed('1.0.0');
    const p = r.publish({ version: '1.0.1' });
    r.behaviour.interruptOnce.add(p.url);
    let res = await r.run('install', 'latest', 'stable');
    assert.equal(res.code, 0, JSON.stringify(r.status()));
    assert.equal(r.current(), 'releases/1.0.1');
    assert.ok(r.status().log.some((l) => /Download-Versuch 1\/3/.test(l)));

    const p2 = r.publish({ version: '1.0.2' });
    r.behaviour.interruptAlways.add(p2.url);
    res = await r.run('install', 'latest', 'stable');
    assert.notEqual(res.code, 0);
    assert.equal(r.status().state, 'failed');
    assert.match(r.status().message, /Download/);
    assert.equal(r.current(), 'releases/1.0.1');
    r.behaviour.interruptAlways.clear();
    res = await r.run('install', 'latest', 'stable');
    assert.equal(res.code, 0, 'nächster Versuch klappt');
  } finally { r.close(); }
});

test('Schlüsselrotation: neuer Schlüssel kommt mit einem Paket des alten, alter geht danach', { timeout: 60000 }, async () => {
  const r = await makeRig();
  try {
    r.seed('1.0.0');
    r.publish({ version: '1.0.1', key: r.k1.key, trustLines: [r.k1.line, r.k2.line] });
    assert.equal((await r.run('install', 'latest', 'stable')).code, 0, JSON.stringify(r.status()));
    const trusted = fs.readFileSync(path.join(r.etc, 'allowed_signers'), 'utf8');
    assert.ok(trusted.includes(r.k1.line) && trusted.includes(r.k2.line));

    r.publish({ version: '1.0.2', key: r.k2.key, indexKey: r.k2.key, trustLines: [r.k2.line] });
    assert.equal((await r.run('install', 'latest', 'stable')).code, 0, JSON.stringify(r.status()));
    assert.ok(!fs.readFileSync(path.join(r.etc, 'allowed_signers'), 'utf8').includes(r.k1.line), 'alter Schlüssel entfernt');

    r.publish({ version: '1.0.3', key: r.k1.key, indexKey: r.k2.key });
    const res = await r.run('install', 'latest', 'stable');
    assert.notEqual(res.code, 0);
    assert.match(r.status().message, /Signatur ungültig/);

    // Rückweg auf ein Paket mit älterer Vertrauensdatei ändert das Vertrauen nicht.
    assert.equal((await r.run('rollback')).code, 0);
    assert.ok(!fs.readFileSync(path.join(r.etc, 'allowed_signers'), 'utf8').includes(r.k1.line));
  } finally { r.close(); }
});

test('Aufräumen: Vorgabe zwei Releases (aktuell + vorig), keep_releases in release.conf', { timeout: 60000 }, async () => {
  const r = await makeRig();
  try {
    r.seed('1.0.0');
    for (const v of ['1.0.1', '1.0.2', '1.0.3']) {
      r.publish({ version: v });
      assert.equal((await r.run('install', 'latest', 'stable')).code, 0, JSON.stringify(r.status()));
    }
    assert.deepEqual(fs.readdirSync(path.join(r.box, 'releases')).sort(), ['1.0.2', '1.0.3']);
    fs.appendFileSync(path.join(r.etc, 'release.conf'), 'keep_releases=3\n');
    for (const v of ['1.0.4', '1.0.5']) {
      r.publish({ version: v });
      assert.equal((await r.run('install', 'latest', 'stable')).code, 0, JSON.stringify(r.status()));
    }
    assert.deepEqual(fs.readdirSync(path.join(r.box, 'releases')).sort(), ['1.0.3', '1.0.4', '1.0.5']);
  } finally { r.close(); }
});

// ── Umstellung git → Paket ──────────────────────────────────────────────────

function gitBox(r, { origin = 'https://github.com/chloepriceless/dvhub.git' } = {}) {
  const w = (p, c, mode = 0o644) => { fs.mkdirSync(path.dirname(path.join(r.box, p)), { recursive: true }); fs.writeFileSync(path.join(r.box, p), c, { mode }); };
  w('dvhub/server.js', '// git\n');
  w('dvhub/package.json', JSON.stringify({ name: 'dvhub', version: '0.9.0' }));
  w('post-update.sh', '#!/usr/bin/env bash\n', 0o755);
  w('install.sh', '#!/usr/bin/env bash\n', 0o755);
  w('docs/x.md', 'doku\n');
  w('.gitignore', '/eos-venv/\n/bin/\n/dvhub/node_modules/\n');
  const g = (...a) => { const x = spawnSync('git', a, { cwd: r.box, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2026-10-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-01T00:00:00Z' } }); assert.equal(x.status, 0, x.stderr); return x.stdout.trim(); };
  g('init', '-q');
  g('add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'git-stand');
  g('remote', 'add', 'origin', origin);
  w('eos-venv/bin/python', 'venv\n');
  w('bin/dvhub-eebus', 'bin\n', 0o755);
  w('dvhub/node_modules/x/index.js', 'alt\n');
  w('.npm-install-hash', 'abc\n');
  const unit = `[Service]\nWorkingDirectory=${r.box}/dvhub\nExecStartPre=-+/usr/bin/bash ${r.box}/post-update.sh\nExecStart=/usr/bin/node ${r.box}/dvhub/server.js\nEnvironment=DV_DATA_DIR=${r.root}/data\n`;
  fs.writeFileSync(r.unitFile, unit);
  return { unit, g };
}

test('Umstellung git → Paket: Checkout nach .legacy-git, Links, Unit, Zustand bleibt', { timeout: 60000 }, async () => {
  const r = await makeRig();
  try {
    const { unit } = gitBox(r);
    r.publish({ version: '1.0.1', trustLines: [r.k1.line] });
    const res = await r.run('migrate');
    assert.equal(res.code, 0, JSON.stringify(r.status()));
    assert.equal(r.current(), 'releases/1.0.1');
    for (const n of ['dvhub', 'post-update.sh', 'eos-provision.sh']) assert.equal(fs.readlinkSync(path.join(r.box, n)), `current/${n}`);
    for (const n of ['.git', 'install.sh', 'docs', 'dvhub/node_modules/x/index.js']) assert.ok(fs.existsSync(path.join(r.box, '.legacy-git', n)), n);
    assert.ok(!fs.existsSync(path.join(r.box, 'install.sh')) && !fs.existsSync(path.join(r.box, 'docs')));
    for (const n of ['eos-venv/bin/python', 'bin/dvhub-eebus', '.npm-install-hash']) assert.ok(fs.existsSync(path.join(r.box, n)), `Zustand bleibt: ${n}`);
    const u = fs.readFileSync(r.unitFile, 'utf8');
    assert.match(u, new RegExp(`ExecStart=/usr/bin/node ${r.box}/current/dvhub/server.js`));
    assert.match(u, new RegExp(`WorkingDirectory=${r.box}/current/dvhub`));
    assert.equal(fs.readFileSync(path.join(r.state, 'dvhub.service.git-backup'), 'utf8'), unit);
    const st = JSON.parse(fs.readFileSync(path.join(r.state, 'state.json'), 'utf8'));
    assert.equal(st.current, '1.0.1');
    assert.equal(st.legacy.version, '0.9.0');
    assert.equal(st.migration, null);

    // Nächstes Paket-Update entfernt den alten Checkout.
    r.publish({ version: '1.0.2' });
    assert.equal((await r.run('install', 'latest', 'stable')).code, 0, JSON.stringify(r.status()));
    assert.ok(!fs.existsSync(path.join(r.box, '.legacy-git')));
  } finally { r.close(); }
});

test('Umstellung scheitert an der Gesundheit → git-Checkout, Unit und Dateien wie vorher', { timeout: 60000 }, async () => {
  const r = await makeRig();
  try {
    const { unit, g } = gitBox(r);
    const before = g('ls-files').split('\n').sort();
    r.publish({ version: '1.0.1' });
    r.bad.add('1.0.1');
    const res = await r.run('migrate');
    assert.equal(res.code, 1);
    assert.equal(r.status().state, 'rolled_back');
    assert.equal(r.current(), null);
    assert.equal(fs.readFileSync(r.unitFile, 'utf8'), unit);
    assert.ok(fs.statSync(path.join(r.box, 'dvhub')).isDirectory() && !isLink(path.join(r.box, 'dvhub')));
    assert.deepEqual(g('ls-files').split('\n').sort(), before);
    assert.equal(g('status', '--porcelain', '--untracked-files=no'), '');
    assert.ok(!fs.existsSync(path.join(r.box, 'releases/1.0.1')));
    assert.ok(!fs.existsSync(path.join(r.box, 'eos-provision.sh')), 'keine Links übrig');
    const st = JSON.parse(fs.readFileSync(path.join(r.state, 'state.json'), 'utf8'));
    assert.equal(st.migrate.attempts, 1);
    assert.equal(st.migration, null);
  } finally { r.close(); }
});

test('Umstellung unterbleibt: eigenes Repo, lokale Änderungen, kein Schlüssel, Opt-out; --force geht', { timeout: 60000 }, async () => {
  const r = await makeRig();
  try {
    const { g } = gitBox(r, { origin: 'https://git.example/fork/dvhub.git' });
    r.publish({ version: '1.0.1' });
    let res = await r.run('migrate');
    assert.equal(res.code, 0);
    assert.equal(r.status().reason, 'custom_repo');
    assert.equal(r.current(), null);
    g('remote', 'set-url', 'origin', 'https://github.com/chloepriceless/dvhub.git');
    fs.appendFileSync(path.join(r.box, 'install.sh'), '# lokal\n');
    res = await r.run('migrate');
    assert.equal(r.status().reason, 'local_changes');
    g('checkout', '--', 'install.sh');
    fs.mkdirSync(path.join(r.root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(r.root, 'data', '.no-release-packages'), '');
    res = await r.run('migrate');
    assert.equal(r.status().reason, 'opt_out');
    fs.rmSync(path.join(r.root, 'data', '.no-release-packages'));
    r.trust('# leer');
    res = await r.run('migrate');
    assert.equal(r.status().reason, 'no_release_key');
    r.trust(r.k1.line);
    g('remote', 'set-url', 'origin', 'https://git.example/fork/dvhub.git');
    res = await r.run('migrate', '--force');
    assert.equal(res.code, 0, JSON.stringify(r.status()));
    assert.equal(r.current(), 'releases/1.0.1');
  } finally { r.close(); }
});

test('boot-hook: plant die Umstellung einmal, wiederholt frühestens nach 24 h; setzt Unterbrochenes fort', { timeout: 60000 }, async () => {
  const r = await makeRig();
  try {
    gitBox(r);
    r.publish({ version: '1.0.1' });
    let res = await r.run('boot-hook');
    assert.equal(res.code, 0);
    assert.match(res.out, /in 120 s geplant/);
    assert.match(fs.readFileSync(r.runLog, 'utf8'), /--unit=dvhub-release-migrate .*--on-active=120s .*_job migrate/);
    const st = { format: 1, migrate: { attempts: 1, last_attempt: Math.floor(Date.now() / 1000) } };
    fs.writeFileSync(path.join(r.state, 'state.json'), JSON.stringify(st));
    res = await r.run('boot-hook');
    assert.match(res.out, /nach 24 h/);

    // Paket-Box mit liegengebliebenem Auftrag (anderer Start) → Fortsetzung.
    fs.rmSync(path.join(r.box, '.git'), { recursive: true, force: true });
    const seedState = { format: 1, current: '1.0.1', pending: { op: 'install', version: '1.0.2', previous: '1.0.1', boot_id: 'anderer-start' } };
    fs.writeFileSync(path.join(r.state, 'state.json'), JSON.stringify(seedState));
    res = await r.run('boot-hook');
    assert.match(res.out, /Fortsetzung/);
    assert.match(fs.readFileSync(r.runLog, 'utf8'), /--unit=dvhub-release-resume .*_job resume/);
  } finally { r.close(); }
});

test('resume: unterbrochenes Update — gesund wird bestätigt, sonst zurück', { timeout: 60000 }, async () => {
  const r = await makeRig();
  try {
    r.seed('1.0.0');
    r.publish({ version: '1.0.1' });
    assert.equal((await r.run('install', 'latest', 'stable')).code, 0);
    // Simulierter Stromausfall nach dem Umschalten auf 1.0.2, vor der Prüfung.
    const p = r.publish({ version: '1.0.2' });
    const dest = path.join(r.box, 'releases', '1.0.2');
    fs.mkdirSync(dest);
    assert.equal(spawnSync('tar', ['-xzf', p.file, '-C', dest]).status, 0);
    H.switchCurrent(r.settings(), '1.0.2');
    const st = JSON.parse(fs.readFileSync(path.join(r.state, 'state.json'), 'utf8'));
    st.pending = { op: 'install', version: '1.0.2', previous: '1.0.1', boot_id: 'x' };
    fs.writeFileSync(path.join(r.state, 'state.json'), JSON.stringify(st));
    r.bad.add('1.0.2');
    assert.equal((await r.run('_job', 'resume')).code, 1);
    assert.equal(r.current(), 'releases/1.0.1');
    assert.equal(JSON.parse(fs.readFileSync(path.join(r.state, 'state.json'), 'utf8')).pending, null);
  } finally { r.close(); }
});

// ── Befunde der Codex-Gegenprüfung 67ade305 ─────────────────────────────────

test('Gesundheitsprüfung schickt einen erlaubten Host (allowedHosts gesetzt)', { timeout: 60000 }, async () => {
  const r = await makeRig();
  try {
    fs.writeFileSync(path.join(r.root, 'config.json'), JSON.stringify({ httpPort: 8080, allowedHosts: ['dvhub.example.org:8080'] }));
    r.seed('1.0.0');
    r.publish({ version: '1.0.1' });
    const res = await r.run('install', 'latest', 'stable');
    assert.equal(res.code, 0, JSON.stringify(r.status()));
    assert.equal(r.current(), 'releases/1.0.1');
  } finally { r.close(); }
});

test('gleichzeitige Prüfungen teilen sich keine Index-Dateien', { timeout: 60000 }, async () => {
  const r = await makeRig();
  try {
    r.seed('1.0.0');
    r.publish({ version: '1.0.1' });
    const all = await Promise.all(Array.from({ length: 6 }, () => r.run('check', 'stable')));
    for (const x of all) assert.equal(x.code, 0, x.out);
    assert.deepEqual(fs.readdirSync(path.join(r.state, 'staging')), [], 'nichts liegen geblieben');
  } finally { r.close(); }
});

test('resume bestätigt ein unterbrochenes Update vollständig (Vertrauensdatei übernommen)', { timeout: 60000 }, async () => {
  const r = await makeRig();
  try {
    r.seed('1.0.0');
    const p = r.publish({ version: '1.0.1', trustLines: [r.k1.line, r.k2.line] });
    const dest = path.join(r.box, 'releases', '1.0.1');
    fs.mkdirSync(dest);
    assert.equal(spawnSync('tar', ['-xzf', p.file, '-C', dest]).status, 0);
    H.switchCurrent(r.settings(), '1.0.1');
    const st = JSON.parse(fs.readFileSync(path.join(r.state, 'state.json'), 'utf8'));
    st.pending = { op: 'install', version: '1.0.1', previous: '1.0.0', boot_id: 'x' };
    fs.writeFileSync(path.join(r.state, 'state.json'), JSON.stringify(st));
    assert.equal((await r.run('_job', 'resume')).code, 0, JSON.stringify(r.status()));
    assert.ok(fs.readFileSync(path.join(r.etc, 'allowed_signers'), 'utf8').includes(r.k2.line), 'neuer Schlüssel übernommen');
    assert.equal(JSON.parse(fs.readFileSync(path.join(r.state, 'state.json'), 'utf8')).trust_version, '1.0.1');
  } finally { r.close(); }
});

test('Umstellung: Commit des Pakets älter als der Checkout → nicht ohne --force', { timeout: 60000 }, async () => {
  const r = await makeRig();
  try {
    gitBox(r);
    // publish() datiert das Paket auf 2026-10-27; der Checkout ist neuer.
    const g = (...a) => spawnSync('git', a, { cwd: r.box, encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: '2026-12-01T00:00:00Z', GIT_AUTHOR_DATE: '2026-12-01T00:00:00Z' } });
    assert.equal(g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'neuer').status, 0);
    r.publish({ version: '1.0.1' });
    let res = await r.run('migrate');
    assert.equal(res.code, 0, JSON.stringify(r.status()));
    assert.equal(r.status().state, 'skipped');
    assert.equal(r.status().reason, 'package_older');
    assert.match(r.status().message, /älter/);
    assert.equal(r.current(), null);
    const st = JSON.parse(fs.readFileSync(path.join(r.state, 'state.json'), 'utf8'));
    assert.equal(st.migrate.attempts || 0, 0, 'Warten ist kein Fehlversuch');
    assert.match((await r.run('boot-hook')).out, /nächste Prüfung in 6 h/);
    res = await r.run('migrate', '--force');
    assert.equal(res.code, 0, JSON.stringify(r.status()));
  } finally { r.close(); }
});

test('Umstellung: Stromausfall mitten im Verschieben → recover stellt den git-Stand her', { timeout: 60000 }, async () => {
  const r = await makeRig();
  try {
    const { unit, g } = gitBox(r);
    const before = g('ls-files').split('\n').sort();
    r.publish({ version: '1.0.1' });
    // Zustand wie nach einem Abbruch: Release entpackt, current gesetzt,
    // dvhub schon verschoben und verlinkt, post-update.sh verschoben, aber
    // noch ohne Verweis — und vor dem Journal-Eintrag „erledigt“.
    const dest = path.join(r.box, 'releases', '1.0.1');
    fs.mkdirSync(dest, { recursive: true });
    assert.equal(spawnSync('tar', ['-xzf', path.join(r.pub, 'v1.0.1', 'dvhub-1.0.1-arm64.tar.gz'), '-C', dest]).status, 0);
    fs.symlinkSync('releases/1.0.1', path.join(r.box, 'current'));
    const legacy = path.join(r.box, '.legacy-git');
    fs.mkdirSync(legacy);
    fs.renameSync(path.join(r.box, 'dvhub'), path.join(legacy, 'dvhub'));
    fs.symlinkSync('current/dvhub', path.join(r.box, 'dvhub'));
    fs.renameSync(path.join(r.box, 'post-update.sh'), path.join(legacy, 'post-update.sh'));
    fs.writeFileSync(path.join(r.state, 'state.json'), JSON.stringify({ format: 1, migration: {
      phase: 'moving', version: '1.0.1', legacy, moved: ['dvhub'], linked: ['dvhub'], moving: 'post-update.sh',
      unit_backup: path.join(r.state, 'dvhub.service.git-backup'), boot_id: 'anderer-start' } }));
    fs.writeFileSync(path.join(r.state, 'dvhub.service.git-backup'), unit);
    fs.mkdirSync(path.join(r.root, 'dvhub.service.d'), { recursive: true });
    fs.writeFileSync(path.join(r.root, 'dvhub.service.d', '05-dvhub-release-recover.conf'), 'x');
    const res = await r.run('recover');
    assert.equal(res.code, 0, res.out);
    assert.equal(r.current(), null);
    assert.ok(fs.statSync(path.join(r.box, 'dvhub')).isDirectory() && !isLink(path.join(r.box, 'dvhub')));
    assert.ok(fs.existsSync(path.join(r.box, 'post-update.sh')) && !isLink(path.join(r.box, 'post-update.sh')));
    assert.deepEqual(g('ls-files').split('\n').sort(), before);
    assert.equal(g('status', '--porcelain', '--untracked-files=no'), '');
    assert.ok(!fs.existsSync(path.join(r.root, 'dvhub.service.d', '05-dvhub-release-recover.conf')), 'Notfall-Drop-in weg');
    const after = JSON.parse(fs.readFileSync(path.join(r.state, 'state.json'), 'utf8'));
    assert.equal(after.migration, null);
    assert.equal(after.history.at(-1).version, '1.0.1');
    assert.equal(after.history.at(-1).result, 'migration_interrupted');
    // Kein Reload mitten im Start (ExecStartPre) — sonst fiele post-update.sh aus der Liste.
    assert.doesNotMatch(fs.existsSync(r.sysLog) ? fs.readFileSync(r.sysLog, 'utf8') : '', /daemon-reload/);
    assert.match(fs.readFileSync(r.runLog, 'utf8'), /--on-active=30s .*systemctl daemon-reload/);
  } finally { r.close(); }
});

test('Notfall-Drop-in: recover läuft VOR post-update.sh (Liste zurückgesetzt)', () => {
  const unit = '[Service]\nWorkingDirectory=/opt/dvhub/dvhub\nExecStartPre=-+/usr/bin/bash /opt/dvhub/post-update.sh\nExecStart=/usr/bin/node /opt/dvhub/dvhub/server.js\n';
  const c = H.dropinContent({ installDir: '/opt/dvhub', self: '/usr/local/libexec/dvhub-release' }, unit);
  const lines = c.split('\n').filter((l) => l.startsWith('ExecStartPre=') || l.startsWith('WorkingDirectory='));
  assert.deepEqual(lines, [
    'WorkingDirectory=-/opt/dvhub/dvhub',
    'ExecStartPre=',
    'ExecStartPre=-+/usr/local/libexec/dvhub-release recover',
    'ExecStartPre=-+/usr/bin/bash /opt/dvhub/post-update.sh',
  ]);
});

test('Umstellung: während des Verschiebens sichert ein Drop-in den Start ab, danach ist es weg', { timeout: 60000 }, async () => {
  const r = await makeRig();
  try {
    gitBox(r);
    r.publish({ version: '1.0.1' });
    assert.equal((await r.run('migrate')).code, 0, JSON.stringify(r.status()));
    assert.ok(!fs.existsSync(path.join(r.root, 'dvhub.service.d', '05-dvhub-release-recover.conf')));
    assert.match(fs.readFileSync(r.sysLog, 'utf8'), /daemon-reload/);
    assert.ok(r.status().log.some((l) => /Notfall-Drop-in/.test(l)), r.status().log.join('\n'));
    assert.equal(H.parseArgs(['recover']).action, 'recover');
  } finally { r.close(); }
});

test('Absturzschleife der neuen Version: Rückweg ohne die volle Wartezeit', { timeout: 60000 }, async () => {
  const r = await makeRig();
  try {
    r.seed('1.0.0');
    r.publish({ version: '1.0.1' });
    r.bad.add('1.0.1');
    // systemd zählt Neustarts der Unit hoch, solange 1.0.1 abstürzt.
    const n = path.join(r.root, 'nrestarts');
    fs.writeFileSync(n, '0');
    fs.writeFileSync(path.join(r.root, 'bin', 'systemctl'), `#!/bin/sh
echo "$*" >> '${r.sysLog}'
case "$*" in
  *"is-active --quiet dvhub.service"*) exit 0;;
  is-active*) exit 3;;
  *"show -p NRestarts --value dvhub.service"*) c=$(cat '${n}'); if readlink '${r.box}/current' | grep -q 1.0.1; then c=$((c+1)); echo $c > '${n}'; fi; echo $c; exit 0;;
esac
exit 0
`, { mode: 0o755 });
    const env = { ...r.settings() };
    const t0 = Date.now();
    const res = await H.main(['install', 'latest', 'stable'], { ...env, healthTimeoutS: 60, write: () => true }).catch((e) => e.exitCode);
    assert.equal(res, 1);
    assert.ok(Date.now() - t0 < 20000, `zu langsam: ${Date.now() - t0} ms`);
    assert.equal(r.current(), 'releases/1.0.0');
    assert.ok(r.status().log.some((l) => /Neustarts/.test(l)), r.status().log.join('\n'));
  } finally { r.close(); }
});

test('Umstellung: Index nicht ladbar zählt als Fehlversuch (24-h-Pause, Obergrenze)', { timeout: 60000 }, async () => {
  const r = await makeRig();
  try {
    gitBox(r);
    // kein Index veröffentlicht → 404
    const res = await r.run('migrate');
    assert.equal(res.code, 1);
    const st = JSON.parse(fs.readFileSync(path.join(r.state, 'state.json'), 'utf8'));
    assert.equal(st.migrate.attempts, 1);
    assert.ok(st.migrate.last_attempt > 0);
    assert.match((await r.run('boot-hook')).out, /nach 24 h/);
  } finally { r.close(); }
});

test('Neue Version krank UND Rückweg krank → Ergebnis failed, nicht „läuft wieder“', { timeout: 60000 }, async () => {
  const r = await makeRig();
  try {
    r.seed('1.0.0');
    r.publish({ version: '1.0.1' });
    r.bad.add('1.0.1');
    r.bad.add('1.0.0');
    const res = await r.run('install', 'latest', 'stable');
    assert.equal(res.code, 1);
    assert.equal(r.status().state, 'failed');
    assert.doesNotMatch(r.status().message, /läuft wieder/);
    assert.match(r.status().message, /nicht gesund/);
    assert.equal(r.current(), 'releases/1.0.0', 'zurückgeschaltet ist trotzdem');
  } finally { r.close(); }
});

// ── Ausgelieferter Vertrauensanker ──────────────────────────────────────────

// Ohne gültigen Schlüssel in release-keys/allowed_signers lehnt jede Box jedes
// Paket ab — ein versehentlich geleerter, verstümmelter oder durch einen
// Testschlüssel ersetzter Anker darf nicht unbemerkt ausgeliefert werden.
// Bei einer Rotation den neuen Fingerabdruck hier ergänzen; valid-before/
// valid-after an einer Zeile sind erlaubt (docs/release-pakete.md, Rotation).
const RELEASE_KEY_FINGERPRINTS = new Set([
  'SHA256:ElDpOZLh+Zbish5io+jSOmJmx+TQfWWzG10BMGCbJXY' // dvhub-release-2026, angelegt 28.10.2026
]);

// Jede Zeile wird so geprüft, wie die Box sie liest: Schlüssel gegen einen
// Wegwerfschlüssel getauscht (Prinzipal und Optionen bleiben), damit signiert
// und mit `ssh-keygen -Y verify` gegen genau diese Zeile geprüft — so fallen
// auch Tippfehler in valid-before/-after oder Namensräumen auf.
function sshVerify(dir, allowed, ns, extra = []) {
  const msg = path.join(dir, 'msg');
  const r = spawnSync('ssh-keygen', ['-Y', 'verify', '-f', allowed, '-I', 'dvhub-release', '-n', ns, '-s', `${msg}.${ns}.sig`, ...extra],
    { input: fs.readFileSync(msg), encoding: 'utf8' });
  return r.status === 0;
}

test('release-keys/allowed_signers: nur bekannte Release-Schlüssel, Zeilen so gültig wie auf der Box', () => {
  const lines = fs.readFileSync(path.join(repoRoot, 'release-keys/allowed_signers'), 'utf8')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  assert.ok(lines.length >= 1, 'mindestens ein Schlüssel');
  const dir = tmp('dvhub-anchor-');
  try {
    const tk = path.join(dir, 'tk');
    assert.equal(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'wegwerf', '-f', tk]).status, 0);
    const throwaway = fs.readFileSync(`${tk}.pub`, 'utf8').trim();
    fs.writeFileSync(path.join(dir, 'msg'), 'dvhub-anchor-check\n');
    for (const ns of ['dvhub-release', 'dvhub-release-index', 'file']) {
      assert.equal(spawnSync('ssh-keygen', ['-q', '-Y', 'sign', '-f', tk, '-n', ns, path.join(dir, 'msg')]).status, 0);
      fs.renameSync(path.join(dir, 'msg.sig'), path.join(dir, `msg.${ns}.sig`));
    }
    let validNow = 0;
    for (const [i, line] of lines.entries()) {
      const m = line.match(/^(dvhub-release(?:\s+\S+)?)\s+(ssh-ed25519\s+[A-Za-z0-9+/=]+)(?:\s+\S+)?$/);
      assert.ok(m, `Zeilenformat: ${line.slice(0, 60)}`);
      fs.writeFileSync(path.join(dir, 'k.pub'), `${m[2]}\n`);
      const r = spawnSync('ssh-keygen', ['-l', '-f', path.join(dir, 'k.pub')], { encoding: 'utf8' });
      assert.equal(r.status, 0, `ssh-keygen liest den Schlüssel: ${r.stderr}`);
      const fp = r.stdout.split(/\s+/)[1];
      assert.ok(RELEASE_KEY_FINGERPRINTS.has(fp), `unbekannter Schlüssel ${fp}`);

      const allowed = path.join(dir, `allowed.${i}`);
      fs.writeFileSync(allowed, `${m[1]} ${throwaway}\n`);
      // Innerhalb des Gültigkeitsfensters (Beginn bzw. weit vor einem Ende):
      const after = line.match(/valid-after="(\d{8}(?:\d{4}(?:\d{2})?)?)Z?"/);
      const at = ['-Overify-time=' + (after ? after[1] : '20000101')];
      for (const ns of ['dvhub-release', 'dvhub-release-index']) {
        assert.ok(sshVerify(dir, allowed, ns, at), `Zeile ${i + 1}: ssh-keygen nimmt sie für ${ns} nicht an`);
      }
      assert.ok(!sshVerify(dir, allowed, 'file', at), `Zeile ${i + 1}: Namensräume nicht auf dvhub-release eingeschränkt`);
      if (sshVerify(dir, allowed, 'dvhub-release') && sshVerify(dir, allowed, 'dvhub-release-index')) validNow += 1;
    }
    assert.ok(validNow >= 1, 'mindestens ein Schlüssel muss heute gültig sein');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function isLink(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } }

// Damit eslint die importierten Bauteile nicht als unbenutzt meldet.
void createTar; void gzipDeterministic; void collectEntries;
