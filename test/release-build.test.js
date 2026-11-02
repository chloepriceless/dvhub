// test/release-build.test.js — Bau der Release-Pakete (docs/release-pakete.md):
// Allowlist, deterministisches tar, Version, Manifest, Abhängigkeits-Prüfung,
// Kanal-Index und ein vollständiger Lauf von build-release.sh auf einem
// Wegwerf-Repo (zweimal → gleiche Bytes, signiert, Allowlist wirkt).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseAllowlist, isAllowed, createTar, readTar, gzipDeterministic, computeReleaseVersion, compareVersions,
  packTree, buildManifest, checkDependencies, mergeIndex, validateIndex, referencedScripts, changelogSection,
  MANIFEST_NAME, sha256,
} from '../scripts/release/lib/release-lib.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const BUILD = path.join(repoRoot, 'scripts/release/build-release.sh');
const ALLOWLIST = path.join(repoRoot, 'scripts/release/allowlist.txt');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('Allowlist: alles verboten, gezielt erlaubt, letzte Regel gewinnt', () => {
  const rules = parseAllowlist(fs.readFileSync(ALLOWLIST, 'utf8'));
  const yes = ['dvhub/server.js', 'dvhub/public/index.html', 'dvhub/hersteller/victron.json', 'dvhub/db/migrations/001-vrm-forecasts-unique.sql',
    'dvhub/package-lock.json', 'post-update.sh', 'eos-provision.sh', 'eos-version.env', 'dvhub-update.sh', 'dvhub-release.cjs',
    'scripts/reconcile-vendor-profiles.mjs', 'release-keys/allowed_signers', 'LICENSE.md', 'dvhub/eebus/go/main.go',
    'dvhub/python/requirements.lock', 'dvhub/services/python-bridge/scripts/pv_forecast.py', 'eos-patches/apply.sh'];
  const no = ['dvhub/test/foo.test.js', 'dvhub/docs/ABREGELUNG-ERKLAERT.md', 'dvhub/node_modules/x/index.js', 'dvhub/eslint.config.js',
    'dvhub/eebus/go/main_test.go', 'dvhub/eebus/go/testdata/fixtures/openssl-key.pem', 'dvhub/eebus/test/interop.py',
    'dvhub/services/python-bridge/scripts/tests/test_x.py', 'dvhub/config.json', 'dvhub/foo.log', 'test/install-script.test.js',
    'tests/csp-lint.mjs', '.github/workflows/ci.yml', 'docs/API.md', 'assets/logo.png', 'install.sh', 'Dockerfile', 'docker/compose.yml',
    'installer-portal/server.js', 'support-relay/x.js', 'README.md', '.gitignore', 'db/telemetry.sqlite', 'scripts/deploy-test.sh',
    'dvhub/scripts/probe-pvnode-headers.js', '.planning/x.md'];
  for (const p of yes) assert.ok(isAllowed(p, rules), `sollte im Paket sein: ${p}`);
  for (const p of no) assert.ok(!isAllowed(p, rules), `darf nicht ins Paket: ${p}`);
  assert.throws(() => parseAllowlist('dvhub/'), /erwartet/);
});

test('Allowlist deckt alle Skripte ab, die post-update.sh und install.sh aufrufen', () => {
  const rules = parseAllowlist(fs.readFileSync(ALLOWLIST, 'utf8'));
  const refs = new Set([
    ...referencedScripts(fs.readFileSync(path.join(repoRoot, 'post-update.sh'), 'utf8')),
    ...referencedScripts(fs.readFileSync(path.join(repoRoot, 'install.sh'), 'utf8')),
  ]);
  assert.ok(refs.has('eos-provision.sh') && refs.has('dvhub-update.sh') && refs.has('dvhub-release.cjs'), [...refs].join(','));
  for (const r of refs) {
    if (!fs.existsSync(path.join(repoRoot, r))) continue;
    assert.ok(isAllowed(r, rules), `aufgerufen, aber nicht in der Allowlist: ${r}`);
  }
});

test('tar: sortiert, root/0, feste Zeit und Modi, lange Pfade über PAX, Rundreise', () => {
  const long = `dvhub/node_modules/${'a'.repeat(60)}/${'b'.repeat(60)}/${'c'.repeat(120)}.js`;
  const entries = [
    { path: 'z.sh', type: 'file', mode: 0o700, data: Buffer.from('#!/bin/sh\n') },
    { path: 'a', type: 'dir' },
    { path: 'a/x.txt', type: 'file', mode: 0o666, data: Buffer.from('x') },
    { path: long, type: 'file', mode: 0o644, data: Buffer.from('lang') },
    { path: 'a/link', type: 'symlink', linkname: 'x.txt' },
  ];
  const t1 = createTar(entries, { mtime: 1700000000 });
  const t2 = createTar([...entries].reverse(), { mtime: 1700000000 });
  assert.ok(t1.equals(t2), 'Reihenfolge der Eingabe darf nicht zählen');
  assert.equal(t1.length % 10240, 0);
  const back = readTar(t1);
  assert.deepEqual(back.map((e) => e.path), ['a', 'a/link', 'a/x.txt', long, 'z.sh']);
  for (const e of back) {
    assert.equal(e.uid, 0); assert.equal(e.gid, 0); assert.equal(e.uname, 'root'); assert.equal(e.mtime, 1700000000);
  }
  assert.equal(back.find((e) => e.path === 'z.sh').mode, 0o755);
  assert.equal(back.find((e) => e.path === 'a/x.txt').mode, 0o644);
  assert.equal(back.find((e) => e.path === 'a/link').linkname, 'x.txt');
  assert.equal(back.find((e) => e.path === long).data.toString(), 'lang');
  for (const bad of ['/etc/passwd', '../x', 'a/../../x', 'a//b']) {
    assert.throws(() => createTar([{ path: bad, type: 'file', data: Buffer.from('') }], { mtime: 0 }), /ungültiger Pfad/);
  }
});

test('tar wird von GNU/BSD tar gelesen (Modi, Symlink, langer Pfad)', () => {
  const dir = tmp('dvhub-tar-');
  try {
    const long = `n/${'d'.repeat(90)}/${'e'.repeat(90)}/f.js`;
    const gz = gzipDeterministic(createTar([
      { path: 'run.sh', type: 'file', mode: 0o755, data: Buffer.from('#!/bin/sh\necho hi\n') },
      { path: long, type: 'file', mode: 0o644, data: Buffer.from('ok') },
      { path: 'l', type: 'symlink', linkname: 'run.sh' },
    ], { mtime: 1700000000 }));
    assert.equal(gz[9], 3, 'gzip-OS-Byte Unix');
    assert.equal(gz.readUInt32LE(4), 0, 'gzip ohne Zeitstempel');
    fs.writeFileSync(path.join(dir, 'p.tar.gz'), gz);
    fs.mkdirSync(path.join(dir, 'x'));
    const r = spawnSync('tar', ['-xzf', path.join(dir, 'p.tar.gz'), '-C', path.join(dir, 'x')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(dir, 'x', long), 'utf8'), 'ok');
    assert.ok(fs.statSync(path.join(dir, 'x/run.sh')).mode & 0o100);
    assert.equal(fs.readlinkSync(path.join(dir, 'x/l')), 'run.sh');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Version: Tag → stable (muss zu package.json passen), sonst dev mit Commit-Zeit und SHA', () => {
  const sha = 'c7a245a1fb36057044a6faed4f002e1c4dad103a';
  assert.deepEqual(computeReleaseVersion({ tag: 'v1.0.9', pkgVersion: '1.0.9', commitTime: 0, sha }), { version: '1.0.9', channel: 'stable' });
  assert.throws(() => computeReleaseVersion({ tag: 'v1.0.9', pkgVersion: '1.0.8', commitTime: 0, sha }), /passt nicht/);
  assert.deepEqual(computeReleaseVersion({ tag: '', pkgVersion: '1.0.8', commitTime: 1761582084, sha }),
    { version: '1.0.8-dev.20251027162124.c7a245a1', channel: 'dev' });
  assert.equal(compareVersions('1.0.10', '1.0.9'), 1);
  assert.equal(compareVersions('1.0.8-dev.20261027162124.c7a245a1', '1.0.8'), -1);
  assert.equal(compareVersions('1.0.8-dev.20261028000000.aaaaaaaa', '1.0.8-dev.20261027162124.c7a245a1'), 1);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
});

test('Manifest: alle Dateien mit sha256, Größe, Modus; Symlinks mit Ziel; ohne sich selbst', () => {
  const m = buildManifest({
    entries: [
      { path: 'a.sh', type: 'file', mode: 0o755, data: Buffer.from('x') },
      { path: 'd', type: 'dir' },
      { path: 'd/l', type: 'symlink', linkname: '../a.sh' },
      { path: MANIFEST_NAME, type: 'file', mode: 0o644, data: Buffer.from('{}') },
    ],
    meta: { version: '1.0.9', arch: 'arm64' },
  });
  assert.equal(m.version, '1.0.9');
  assert.deepEqual(m.files, [
    { path: 'a.sh', sha256: sha256(Buffer.from('x')), size: 1, mode: '0755' },
    { path: 'd/l', type: 'symlink', target: '../a.sh' },
  ]);
});

test('packTree lehnt Symlinks ab, die aus dem Paket zeigen', () => {
  const dir = tmp('dvhub-pack-');
  try {
    fs.writeFileSync(path.join(dir, 'a'), 'a');
    fs.symlinkSync('/etc/passwd', path.join(dir, 'bad'));
    assert.throws(() => packTree(dir, { mtime: 0, meta: {} }), /zeigt aus dem Paket/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Abhängigkeiten: Install-Skripte, os/cpu und native Module schlagen an', () => {
  const dir = tmp('dvhub-deps-');
  try {
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ packages: {
      '': {}, 'node_modules/ok': {}, 'node_modules/dev': { dev: true, hasInstallScript: true },
      'node_modules/bad': { hasInstallScript: true }, 'node_modules/plat': { os: ['linux'] },
    } }));
    fs.mkdirSync(path.join(dir, 'node_modules/n/build'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules/n/build/x.node'), '');
    fs.writeFileSync(path.join(dir, 'node_modules/n/package.json'), JSON.stringify({ name: 'n', scripts: { postinstall: 'node x' } }));
    const p = checkDependencies(dir).join('\n');
    assert.match(p, /node_modules\/bad: hasInstallScript/);
    assert.match(p, /node_modules\/plat: os\/cpu/);
    assert.match(p, /x\.node: natives Modul/);
    assert.match(p, /scripts\.postinstall/);
    assert.doesNotMatch(p, /node_modules\/dev:/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Die echten Produktionsabhängigkeiten sind architekturneutral (Lockfile)', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'dvhub/package-lock.json'), 'utf8'));
  const bad = Object.entries(lock.packages).filter(([k, p]) => k && !p.dev && (p.hasInstallScript || p.os || p.cpu));
  assert.deepEqual(bad.map(([k]) => k), []);
});

test('Kanal-Index: einfügen, absteigend, latest, Prüfung', () => {
  const art = (v) => ({ arm64: { url: `../v${v}/dvhub-${v}-arm64.tar.gz`, sha256: 'a'.repeat(64), size: 10, sig: `../v${v}/x.sig` } });
  let idx = mergeIndex(null, { channel: 'stable', release: { version: '1.0.9', date: 'd1', artifacts: art('1.0.9') } });
  idx = mergeIndex(idx, { channel: 'stable', release: { version: '1.0.10', date: 'd2', artifacts: art('1.0.10') } });
  idx = mergeIndex(idx, { channel: 'stable', release: { version: '1.0.9', date: 'd1', artifacts: art('1.0.9') } });
  assert.equal(idx.latest, '1.0.10');
  assert.deepEqual(idx.releases.map((r) => r.version), ['1.0.10', '1.0.9']);
  validateIndex(idx, 'stable');
  assert.throws(() => validateIndex(idx, 'dev'), /Kanal/);
  assert.throws(() => validateIndex({ ...idx, releases: [{ version: '1.0.9', artifacts: { arm64: { url: 'x', sig: 'y', size: 1, sha256: 'kurz' } } }] }, 'stable'), /sha256/);
  const kept = [1, 2, 3, 4].reduce((acc, n) => mergeIndex(acc, { channel: 'dev', release: { version: `1.0.8-dev.2026102${n}000000.aaaaaaa${n}`, artifacts: {} }, keep: 3 }), null);
  assert.equal(kept.releases.length, 3);
  assert.equal(kept.latest, '1.0.8-dev.20261024000000.aaaaaaa4');
});

test('CHANGELOG-Abschnitt für den Index', () => {
  const text = '## [Unreleased]\n- neu\n\n## [1.0.9] - 2026-11-01\n\nText\n\n- **Fett**: mit `code` und [Link](http://x)\n  Folgezeile\n- zweiter Punkt\n\n## [1.0.8]\n- alt\n';
  assert.deepEqual(changelogSection(text, '1.0.9'), ['Fett: mit code und Link', 'zweiter Punkt']);
  assert.deepEqual(changelogSection(text, '9.9.9'), []);
});

// ── build-release.sh auf einem Wegwerf-Repo ──────────────────────────────────

function fixtureRepo() {
  const dir = tmp('dvhub-build-repo-');
  const w = (p, c, mode) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), c); if (mode) fs.chmodSync(path.join(dir, p), mode); };
  w('dvhub/package.json', JSON.stringify({ name: 'dvhub', version: '1.2.3', type: 'module', engines: { node: '>=22.0.0' } }));
  w('dvhub/package-lock.json', JSON.stringify({ name: 'dvhub', version: '1.2.3', lockfileVersion: 3, requires: true, packages: { '': { name: 'dvhub', version: '1.2.3' } } }));
  w('dvhub/server.js', 'console.log("hi")\n');
  w('dvhub/public/index.html', '<!doctype html>\n');
  w('dvhub/test/a.test.js', 'nein\n');
  w('dvhub/eslint.config.js', 'nein\n');
  w('post-update.sh', '#!/usr/bin/env bash\nbash "$INSTALL_DIR/eos-provision.sh"\n', 0o755);
  w('eos-provision.sh', '#!/usr/bin/env bash\n', 0o755);
  w('eos-version.env', 'EOS_REPO_URL=https://example.invalid/eos.git\nEOS_PIN=v0.4.0rc3\n');
  w('.node-version', '22\n');
  w('README.md', 'nein\n');
  w('tests/x.mjs', 'nein\n');
  const git = (...a) => {
    const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2026-10-27T16:21:24Z', GIT_COMMITTER_DATE: '2026-10-27T16:21:24Z' } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  git('tag', 'v1.2.3');
  w('untracked-leftover.txt', 'darf nicht ins Paket\n');
  w('dvhub/config.json', '{"geheim":1}\n');
  return { dir, git };
}

function keypair(dir, name) {
  const k = path.join(dir, name);
  const r = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', k]);
  assert.equal(r.status, 0);
  return { key: k, pub: fs.readFileSync(`${k}.pub`, 'utf8').trim() };
}

function build(repo, out, extra = []) {
  return spawnSync('bash', [BUILD, ...extra, '--repo', repo, '--out', out, '--arch', 'arm64', '--no-eebus'], {
    encoding: 'utf8', env: { ...process.env, DVHUB_RELEASE_NPM_CACHE: path.join(out, '..', 'npm-cache') },
  });
}

test('build-release.sh: Tag → signiertes, reproduzierbares Paket nur aus der Allowlist', { timeout: 120000 }, () => {
  const { dir } = fixtureRepo();
  const work = tmp('dvhub-build-out-');
  try {
    const { key, pub } = keypair(work, 'k');
    const r1 = build(dir, path.join(work, 'o1'), ['v1.2.3', '--key', key]);
    assert.equal(r1.status, 0, r1.stdout + r1.stderr);
    const r2 = build(dir, path.join(work, 'o2'), ['v1.2.3', '--key', key]);
    assert.equal(r2.status, 0, r2.stderr);
    const f1 = path.join(work, 'o1/1.2.3/dvhub-1.2.3-arm64.tar.gz');
    const f2 = path.join(work, 'o2/1.2.3/dvhub-1.2.3-arm64.tar.gz');
    assert.equal(sha256(fs.readFileSync(f1)), sha256(fs.readFileSync(f2)), 'gleiche Ref → gleiche Bytes');

    const entries = readTar(zlib.gunzipSync(fs.readFileSync(f1)));
    const names = entries.filter((e) => e.type !== 'dir').map((e) => e.path).sort();
    assert.deepEqual(names, ['.dvhub-release.json', '.node-version', 'dvhub/package-lock.json', 'dvhub/package.json', 'dvhub/public/index.html',
      'dvhub/server.js', 'eos-provision.sh', 'eos-version.env', 'post-update.sh']);
    assert.ok(entries.every((e) => e.uid === 0 && e.mtime === 1793118084));

    const manifest = JSON.parse(entries.find((e) => e.path === '.dvhub-release.json').data);
    assert.equal(manifest.version, '1.2.3');
    assert.equal(manifest.channel, 'stable');
    assert.equal(manifest.tag, 'v1.2.3');
    assert.equal(manifest.arch, 'arm64');
    assert.equal(manifest.node_engine, '>=22.0.0');
    assert.equal(manifest.eos.pin, 'v0.4.0rc3');
    for (const f of manifest.files) {
      assert.equal(f.sha256, sha256(entries.find((e) => e.path === f.path).data), f.path);
    }
    assert.equal(manifest.files.find((f) => f.path === 'post-update.sh').mode, '0755');

    const rel = JSON.parse(fs.readFileSync(path.join(work, 'o1/1.2.3/release.json'), 'utf8'));
    assert.equal(rel.artifacts.arm64.sha256, sha256(fs.readFileSync(f1)));

    fs.writeFileSync(path.join(work, 'allowed'), `dvhub-release namespaces="dvhub-release,dvhub-release-index" ${pub}\n`);
    const verify = (file, sig) => spawnSync('ssh-keygen', ['-Y', 'verify', '-f', path.join(work, 'allowed'), '-I', 'dvhub-release', '-n', 'dvhub-release', '-s', sig], { input: fs.readFileSync(file) });
    assert.equal(verify(f1, `${f1}.sig`).status, 0, 'Signatur gültig');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('build-release.sh: Ref ohne Tag → dev-Version; ohne Schlüssel nur mit --no-sign; Allowlist-Lücke bricht ab', { timeout: 120000 }, () => {
  const { dir, git } = fixtureRepo();
  const work = tmp('dvhub-build-out-');
  try {
    const sha = git('rev-parse', 'HEAD');
    const noKey = build(dir, path.join(work, 'o'), ['HEAD', '--key', path.join(work, 'fehlt')]);
    assert.notEqual(noKey.status, 0);
    assert.match(noKey.stderr, /Signaturschlüssel/);
    const r = build(dir, path.join(work, 'o'), ['HEAD', '--no-sign']);
    assert.equal(r.status, 0, r.stderr);
    const v = `1.2.3-dev.20261027162124.${sha.slice(0, 8)}`;
    assert.ok(fs.existsSync(path.join(work, 'o', v, `dvhub-${v}-arm64.tar.gz`)), r.stdout);
    assert.equal(JSON.parse(fs.readFileSync(path.join(work, 'o', v, 'release.json'), 'utf8')).channel, 'dev');

    const narrow = path.join(work, 'allow.txt');
    fs.writeFileSync(narrow, '+ dvhub/\n+ post-update.sh\n');
    const gap = build(dir, path.join(work, 'o3'), ['HEAD', '--no-sign', '--allowlist', narrow]);
    assert.notEqual(gap.status, 0);
    assert.match(gap.stderr, /eos-provision\.sh/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('build-release.sh: Schlüsselrechte mit GNU-stat (Linux/CI) richtig gelesen', { timeout: 120000 }, () => {
  const { dir } = fixtureRepo();
  const work = tmp('dvhub-build-out-');
  try {
    const { key } = keypair(work, 'k');
    // GNU stat: "-f" heißt Dateisystem — '%Lp' wird als Dateiname gelesen,
    // die Ausgabe zum echten Pfad landet trotzdem auf stdout, Exit 1.
    const bin = path.join(work, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'stat'), `#!/bin/sh
if [ "$1" = "-f" ]; then echo "  File: \\"$3\\""; echo "    ID: 0 Namelen: 255 Type: apfs"; echo "stat: cannot read file system information for '$2'" >&2; exit 1; fi
if [ "$1" = "-c" ]; then node -e 'process.stdout.write((require("fs").statSync(process.argv[1]).mode & 0o777).toString(8) + "\\n")' "$3"; exit 0; fi
exit 2
`, { mode: 0o755 });
    const r = spawnSync('bash', [BUILD, 'v1.2.3', '--key', key, '--repo', dir, '--out', path.join(work, 'o'), '--arch', 'arm64', '--no-eebus'], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DVHUB_RELEASE_NPM_CACHE: path.join(work, 'npm-cache') },
    });
    assert.equal(r.status, 0, r.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});
