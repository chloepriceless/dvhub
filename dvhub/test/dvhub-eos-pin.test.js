// test/dvhub-eos-pin.test.js — DVhub-EOS statt Vanilla-EOS, mit Rust-Kern (T-0415, Christin 11.11.2026).
//
// DVhub 1.0.10 liefert das DVhub-EOS aus dem Fork chloepriceless/EOS aus
// (upstream main + offene PRs, je Release neu gebaut, tools/dvhub-eos im Fork).
// Git-Tag und Docker-Tag unterscheiden sich nur im Präfix:
//   Git-Tag     dvhub-eos-<upstream-version>-dvhub.<N>   (EOS_PIN / EOS_TAG)
//   Docker-Tag  <upstream-version>-dvhub.<N>             (EOS_IMAGE_TAG)
// Die upstream-Version von main ist 0.3.0.dev… — kleiner als 0.4.0rc3, obwohl
// der Stand neuer ist. Deshalb vergleicht DVhub EOS-Stände nirgends der Größe
// nach, sondern nur auf Gleichheit (Marker, .env-Abgleich) bzw. erkennt EOS an
// seiner Konfiguration (eos-capabilities).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readEosPin, eosVersionLabel, DEFAULT_REMOTE_EOS_VERSION } from '../services/optimizer/eos-remote.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const kv = (text) => Object.fromEntries(text.split('\n').filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l))
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const pin = kv(read('eos-version.env'));
const example = kv(read('docker/.env.example'));
const FORK = 'https://github.com/chloepriceless/EOS.git';
const TAG_RE = /^dvhub-eos-(\d+\.\d+\.\d+[0-9A-Za-z.]*-dvhub\.\d+)$/;

test('Pin: DVhub-EOS aus dem Fork, nativ und Docker gleich', () => {
  assert.equal(pin.EOS_REPO_URL, FORK);
  assert.match(pin.EOS_PIN, TAG_RE);
  assert.equal(example.EOS_REPO, pin.EOS_REPO_URL, 'docker/.env.example EOS_REPO = eos-version.env EOS_REPO_URL');
  assert.equal(example.EOS_TAG, pin.EOS_PIN, 'docker/.env.example EOS_TAG = eos-version.env EOS_PIN');
  assert.equal(example.EOS_IMAGE_TAG, TAG_RE.exec(pin.EOS_PIN)[1], 'Docker-Tag = Git-Tag ohne Präfix');
});

test('eos-provision.sh: Rückfall ohne eos-version.env ist derselbe Stand', () => {
  const sh = read('eos-provision.sh');
  assert.equal(/^EOS_REPO_URL="\$\{EOS_REPO_URL:-\$\{_pin_repo:-([^}]+)\}\}"$/m.exec(sh)?.[1], pin.EOS_REPO_URL);
  assert.equal(/^EOS_PIN="\$\{EOS_PIN:-\$\{EOS_BRANCH:-\$\{_pin_ref:-([^}]+)\}\}\}"$/m.exec(sh)?.[1], pin.EOS_PIN);
});

test('compose.yml: Vorgaben = .env.example; EOS_TAG allein (eigener Pin) bleibt Image-Tag', () => {
  const yml = read('docker/compose.yml');
  const img = TAG_RE.exec(pin.EOS_PIN)[1];
  assert.ok(yml.includes(`image: \${EOS_IMAGE:-docker.io/bikinibottomcapital/dvhub-eos}:\${EOS_IMAGE_TAG:-\${EOS_TAG:-${img}}}`), 'image');
  assert.ok(yml.includes(`context: \${EOS_REPO:-${FORK}}#\${EOS_TAG:-${pin.EOS_PIN}}`), 'build.context');
  assert.ok(yml.includes(`BUILD_VERSION: \${EOS_IMAGE_TAG:-\${EOS_TAG:-${img}}}`), 'build.args.BUILD_VERSION');
});

test('Erwartete EOS-Version (Fernbetrieb/Anzeige) = Docker-Tag, wie EOS_BUILD_VERSION im Image', () => {
  const img = TAG_RE.exec(pin.EOS_PIN)[1];
  assert.equal(eosVersionLabel(pin.EOS_PIN), img);
  assert.equal(eosVersionLabel('v0.4.0rc3'), 'v0.4.0rc3', 'alte Pins unverändert');
  assert.equal(readEosPin(path.join(root, 'dvhub')), img);
  assert.equal(DEFAULT_REMOTE_EOS_VERSION, img, 'Rückfallwert (Container ohne eos-version.env) nachziehen');
});

// --- scripts/eos-image-plan.sh --------------------------------------------
function plan(envText, { release = false, published = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-eosplan-'));
  try {
    const envFile = path.join(dir, 'env');
    fs.writeFileSync(envFile, envText);
    const list = path.join(dir, 'published');
    fs.writeFileSync(list, published.map((s) => `${s}\n`).join(''));
    const inspect = path.join(dir, 'inspect');
    fs.writeFileSync(inspect, `#!/usr/bin/env bash\ngrep -qxF "$1" "${list}"\n`);
    fs.chmodSync(inspect, 0o755);
    const out = path.join(dir, 'out');
    const r = spawnSync('bash', [path.join(root, 'scripts', 'eos-image-plan.sh'), ...(release ? ['--release'] : []), envFile], {
      env: { ...process.env, EOS_PLAN_INSPECT: inspect, GITHUB_OUTPUT: out }, encoding: 'utf8',
    });
    const o = fs.existsSync(out) ? kv(fs.readFileSync(out, 'utf8').replace(/^([a-z_]+)=/gm, (m, k) => `${k.toUpperCase()}=`)) : {};
    return { status: r.status, log: r.stdout + r.stderr, ...o };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const OURS = 'docker.io/bikinibottomcapital/dvhub-eos';

test('eos-image-plan: Vorgabe → Git-Tag zum Bauen, Docker-Tag fürs Image', () => {
  const r = plan(read('docker/.env.example'), { release: true });
  assert.equal(r.status, 0, r.log);
  assert.equal(r.TAG, example.EOS_TAG);
  assert.equal(r.REPO, example.EOS_REPO);
  assert.equal(r.IMAGE, OURS);
  assert.equal(r.IMAGE_TAG, example.EOS_IMAGE_TAG);
  assert.equal(r.BUILD, 'true');
});

test('eos-image-plan (main): fehlt das Image unter dem Docker-Tag, wird gebaut — sonst nicht', () => {
  const text = read('docker/.env.example');
  const missing = plan(text, { published: [`${OURS}:${example.EOS_TAG}`] });
  assert.equal(missing.status, 0, missing.log);
  assert.equal(missing.BUILD, 'true', 'ein Image unter dem Git-Tag zählt nicht');
  const there = plan(text, { published: [`${OURS}:${example.EOS_IMAGE_TAG}`] });
  assert.equal(there.status, 0, there.log);
  assert.equal(there.BUILD, 'false');
});

test('eos-image-plan: Image-Tag muss zum Pin passen; alte v-Tags weiter ohne EOS_IMAGE_TAG', () => {
  const bad = plan(`EOS_REPO=${FORK}\nEOS_TAG=dvhub-eos-0.3.0.dev1-dvhub.2\nEOS_IMAGE_TAG=0.3.0.dev1-dvhub.1\n`);
  assert.notEqual(bad.status, 0);
  assert.match(bad.log, /passt nicht zum Pin/);
  const noImageTag = plan(`EOS_REPO=${FORK}\nEOS_TAG=dvhub-eos-0.3.0.dev1-dvhub.2\n`, { release: true });
  assert.equal(noImageTag.status, 0, noImageTag.log);
  assert.equal(noImageTag.IMAGE_TAG, '0.3.0.dev1-dvhub.2', 'ohne EOS_IMAGE_TAG: Git-Tag ohne Präfix');
  const legacy = plan('EOS_REPO=https://github.com/Akkudoktor-EOS/EOS.git\nEOS_TAG=v0.4.0rc3\n', { release: true });
  assert.equal(legacy.status, 0, legacy.log);
  assert.equal(legacy.IMAGE_TAG, 'v0.4.0rc3');
});

// --- Rust-Kern: Wheels als Release-Assets des Fork-Tags, sha256 gepinnt ------
// (Christin 11.11.2026: DVhub liefert DVhub-EOS IMMER mit aktivem Rust-Kern.)
const ARCH_KEYS = { X86_64: 'x86_64', AARCH64: 'aarch64', ARMV7L: 'armv7l' };

test('Rust-Kern: Wheels gehören zum Fork-Tag, je Architektur Datei + sha256', () => {
  assert.equal(pin.EOS_NATIVE_URL, `${FORK.replace(/\.git$/, '')}/releases/download/${pin.EOS_PIN}`);
  assert.match(pin.EOS_NATIVE_VERSION, /^\d+\.\d+\.\d+$/);
  for (const [key, arch] of Object.entries(ARCH_KEYS)) {
    const file = pin[`EOS_NATIVE_${key}`];
    assert.ok(file, `EOS_NATIVE_${key}`);
    assert.ok(file.startsWith(`akkudoktoreos_native-${pin.EOS_NATIVE_VERSION}-cp3`), `${file}: Kern-Version`);
    assert.match(file, new RegExp(`-abi3-[^-]*manylinux[^-]*_${arch}\\.whl$`), `${file}: glibc-Wheel für ${arch}`);
    assert.match(pin[`EOS_NATIVE_${key}_SHA256`], /^[0-9a-f]{64}$/);
  }
  const listed = spawnSync('bash', [path.join(root, 'scripts', 'eos-native-wheels.sh'), 'list', path.join(root, 'eos-version.env')], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.stdout.trim().split('\n').map((l) => l.split(' ')[0]), Object.keys(ARCH_KEYS));
});

test('Rust-Kern: Backend native in Image, schlankem Image und nativer Unit; nie python ausgeliefert', () => {
  const nativeDf = read('docker/eos-native/Dockerfile');
  assert.match(nativeDf, /^ENV EOS_OPTIMIZATION__GENETIC__BACKEND=native$/m);
  assert.match(nativeDf, /^FROM eos AS smoke$/m);
  assert.match(nativeDf, /native-smoke\.py && touch \/native-smoke-ok/);
  assert.match(nativeDf, /^COPY --from=smoke \/native-smoke-ok /m, 'ohne Abhängigkeit überspränge BuildKit den Rauchtest');
  assert.match(nativeDf, /sha256sum -c -/);
  const slim = read('docker/eos-slim/Dockerfile');
  assert.match(slim, /^\s+EOS_OPTIMIZATION__GENETIC__BACKEND=native$/m, 'ENV überlebt FROM scratch nicht — neu setzen');
  assert.match(slim, /^FROM full AS smoke$/m);
  assert.match(slim, /^COPY --from=smoke \/native-smoke-ok /m);
  assert.match(read('eos-provision.sh'), /^\$\{EOS_BACKEND:\+Environment=EOS_OPTIMIZATION__GENETIC__BACKEND=\$EOS_BACKEND\}$/m);
  for (const f of ['.github/workflows/container.yml', '.github/workflows/container-dev.yml', 'docker/compose.yml',
    'docker/.env.example', 'docker/eos-native/Dockerfile', 'docker/eos-slim/Dockerfile', 'docker/eos-native/docker-bake.hcl']) {
    const code = read(f).split('\n').filter((l) => !/^\s*(#|\/\/)/.test(l)).join('\n');
    assert.doesNotMatch(code, /EOS_OPTIMIZATION__GENETIC__BACKEND\s*[=:]\s*"?python/, f);
  }
});

test('Rust-Kern: Hilfsskript ausführbar (die CI ruft es direkt auf)', () => {
  assert.ok(fs.statSync(path.join(root, 'scripts', 'eos-native-wheels.sh')).mode & 0o111);
});

test('Rust-Kern: Hilfsskripte stehen in der Paket-Allowlist (native Paket-Boxen)', () => {
  const allow = read('scripts/release/allowlist.txt');
  for (const f of ['scripts/eos-native-wheels.sh', 'scripts/eos-native-smoke.py', 'eos-version.env', 'eos-provision.sh']) {
    assert.match(allow, new RegExp(`^\\+ ${f.replace(/\./g, '\\.')}$`, 'm'), f);
  }
});

test('Rust-Kern: Rauchtest im Repo = der des Fork-Werkzeugs, nur mit eigenen Ordnern', () => {
  const smoke = read('scripts/eos-native-smoke.py');
  assert.match(smoke, /GENETIC native run/);
  assert.match(smoke, /native backend not used/);
  assert.match(smoke, /EOS_CACHE_DIR=os\.path\.join\(workdir, "cache"\)/, 'im Image zeigt EOS_CACHE_DIR sonst auf /data');
  assert.match(smoke, /atexit\.register\(shutil\.rmtree, workdir, True\)/);
});

// --- CI: multi-arch aus dem Fork-Tag mit Rust-Kern, Image unter dem Docker-Tag --
const bake = read('docker/eos-native/docker-bake.hcl');
test('docker-bake.hcl: Grundstufe = unverändertes Fork-Dockerfile am Git-Tag, BUILD_VERSION = Docker-Tag', () => {
  assert.match(bake, /target "eos-base" \{\n\s+context\s+= "\$\{EOS_REPO\}#\$\{EOS_TAG\}"/);
  assert.match(bake, /args\s+= \{ BUILD_VERSION = EOS_IMAGE_TAG \}/);
  assert.match(bake, /base\s+= "target:eos-base"/);
  assert.match(bake, /dvhubscripts = "scripts"/);
  assert.match(bake, /"org\.opencontainers\.image\.source"\s+= "https:\/\/github\.com\/chloepriceless\/EOS"/);
  assert.match(bake, /"net\.dvhub\.eos\.git-tag"\s+= EOS_TAG/);
});

for (const wf of ['.github/workflows/container.yml', '.github/workflows/container-dev.yml']) {
  test(`${wf}: dvhub-eos aus repo#Git-Tag mit Rust-Kern, amd64+arm64, unter dem Docker-Tag`, () => {
    const y = read(wf);
    const steps = y.split(/\n(?=\s+- (?:name|uses): )/);
    const fetch = steps.find((s) => s.includes('scripts/eos-native-wheels.sh fetch'));
    assert.ok(fetch, 'Wheels über die Pins holen');
    assert.match(fetch, /fetch "\$RUNNER_TEMP\/eos-wheels" X86_64 AARCH64/);
    assert.match(fetch, /want="\$\{EOS_REPO%\.git\}\/releases\/download\/\$\{EOS_TAG\}"/, 'Wheels gehören zum Git-Tag');
    const build = steps.find((s) => s.includes('docker buildx bake -f docker/eos-native/docker-bake.hcl'));
    assert.ok(build, 'Bau über docker-bake.hcl');
    assert.match(build, /--push dvhub-eos/);
    assert.match(build, /PLATFORMS: linux\/amd64,linux\/arm64/);
    assert.match(build, /EOS_TAG: \$\{\{ steps\.eos\.outputs\.tag \}\}/);
    assert.match(build, /EOS_IMAGE_TAG: \$\{\{ steps\.eos\.outputs\.image_tag \}\}/);
    assert.match(build, /WHEELS_DIR: \$\{\{ runner\.temp \}\}\/eos-wheels/);
    assert.match(build, /TAGS: docker\.io\/bikinibottomcapital\/dvhub-eos:\$\{\{ steps\.eos\.outputs\.image_tag \}\}/);
    assert.match(build, /export \$\(grep -E '\^EOS_NATIVE_\[A-Z0-9_\]\+=' eos-version\.env\)/);
    assert.ok(steps.indexOf(fetch) < steps.indexOf(build));
    assert.doesNotMatch(y, /dvhub-eos(-slim)?:\$\{\{ steps\.eos\.outputs\.tag \}\}/, 'nie unter dem Git-Tag veröffentlichen');
    assert.doesNotMatch(y, /context: \$\{\{ steps\.eos\.outputs\.repo \}\}#/, 'kein Bau ohne Kern mehr');
  });
}

test('EOS-schlank: Grundlage unter dem Docker-Tag, Healthcheck-Modul von DVhub-EOS', () => {
  const df = read('docker/eos-slim/Dockerfile');
  assert.equal(/^ARG EOS_IMAGE_TAG=(\S+)$/m.exec(df)?.[1], example.EOS_IMAGE_TAG);
  assert.match(df, /^FROM \$\{EOS_IMAGE\}:\$\{EOS_IMAGE_TAG\} AS full$/m);
  assert.match(df, /akkudoktoreos\.server\.containerhealthcheck/);
  assert.doesNotMatch(df, /container_healthcheck/, 'Modulname von v0.4.0rc3');
  assert.match(read('.github/workflows/container-dev.yml'), /EOS_IMAGE_TAG=\$\{\{ steps\.eos\.outputs\.image_tag \}\}/);
});
