// eebus-provision.sh baut dvhub-eebus auf nativen Installationen. Seit 20.10.2026
// die Go-Fassung (eebus-go): offizielle Go-Werkzeugkette von go.dev mit fest
// eingetragener Prüfsumme (dvhub/eebus/go-toolchain.pin), Bau mit build-go.sh,
// Selbsttest, erst dann ersetzen. C-Fassung (openeebus) bleibt als Rückweg
// ($DATA_DIR/.eebus-impl-c) und für Architekturen ohne Go-Paket.
// Getestet wird das ECHTE Skript und das echte build-go.sh; uname, curl, apt
// und die Go-Werkzeugkette sind Attrappen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = new URL('../../', import.meta.url).pathname;
const PIN = readFileSync(join(ROOT, 'dvhub/eebus/go-toolchain.pin'), 'utf8');
const GO_VERSION = PIN.match(/^GO_VERSION=(.+)$/m)?.[1];

const GO_STUB = `#!/bin/sh
case "$1" in
  list) echo v0.7.1-test ;;
  build)
    out=""
    args="$*"
    while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done
    set -- $args
    printf '#!/bin/sh\\nif [ "$1" = --gen-cert ]; then : > "$2"; : > "$3"; fi\\necho go-bin\\n' > "$out"
    echo "GOARCH=$GOARCH GOARM=$GOARM GOTOOLCHAIN=$GOTOOLCHAIN GOTMPDIR=$GOTMPDIR ARGS=$*" >> "$GO_LOG" ;;
esac
`;

function rig({ arch = 'aarch64', badSum = false } = {}) {
  const r = mkdtempSync(join(tmpdir(), 'eebus-prov-'));
  const opt = join(r, 'opt'), data = join(r, 'data'), stub = join(r, 'stub'), src = join(opt, 'dvhub/eebus');
  for (const d of [data, stub, join(src, 'go'), join(r, 'tmp'), join(r, 'tar/go/bin')]) mkdirSync(d, { recursive: true });
  copyFileSync(join(ROOT, 'eebus-provision.sh'), join(opt, 'eebus-provision.sh'));
  copyFileSync(join(ROOT, 'dvhub/eebus/build-go.sh'), join(src, 'build-go.sh'));
  for (const f of ['go.mod', 'go.sum', 'main.go']) copyFileSync(join(ROOT, 'dvhub/eebus/go', f), join(src, 'go', f));
  copyFileSync(join(ROOT, 'dvhub/eebus/openeebus.pin'), join(src, 'openeebus.pin'));
  // C-Fassung als Attrappe (der echte Bau holt openeebus und braucht cmake).
  writeFileSync(join(src, 'build.sh'), '#!/bin/bash\nmkdir -p "$1"; printf \'#!/bin/sh\\necho c-bin\\n\' > "$1/dvhub-eebus"; chmod 755 "$1/dvhub-eebus"; echo c > "$1/dvhub-eebus.version"\n');
  mkdirSync(join(src, 'bridge')); writeFileSync(join(src, 'bridge/main.c'), '');
  mkdirSync(join(src, 'patches'));

  writeFileSync(join(r, 'tar/go/bin/go'), GO_STUB); chmodSync(join(r, 'tar/go/bin/go'), 0o755);
  const tarball = join(r, 'go.tgz');
  execFileSync('tar', ['-czf', tarball, '-C', join(r, 'tar'), 'go']);
  const sum = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  const pinSum = badSum ? '0'.repeat(64) : sum;
  writeFileSync(join(src, 'go-toolchain.pin'), `GO_VERSION=${GO_VERSION}\nGO_SHA256_arm64=${pinSum}\nGO_SHA256_amd64=${pinSum}\nGO_SHA256_armv6l=${pinSum}\n`);

  const sh = (name, body) => { writeFileSync(join(stub, name), `#!/bin/sh\n${body}\n`); chmodSync(join(stub, name), 0o755); };
  sh('uname', `[ "$1" = -m ] && { echo ${arch}; exit 0; }; exec /usr/bin/uname "$@"`);
  sh('curl', `out=""; url=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift;; http*) url="$1";; esac; shift; done; echo "$url" >> "${join(r, 'curl.log')}"; cp "${tarball}" "$out"`);
  for (const n of ['apt-get', 'dpkg', 'systemctl']) sh(n, 'exit 0');
  // Prozesse des Rechners nie anfassen: pgrep findet einen „laufenden“ alten Stand, pkill protokolliert.
  sh('pgrep', 'exit 0');
  sh('pkill', `echo "$*" >> "${join(r, 'pkill.log')}"`);
  return {
    r, opt, data, src,
    run(...args) {
      const p = spawnSync('bash', [join(opt, 'eebus-provision.sh'), ...args], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${stub}:${process.env.PATH}`, INSTALL_DIR: opt, DATA_DIR: data, EEBUS_BUILD_ROOT: join(r, 'tmp'), GO_LOG: join(r, 'go.log') },
      });
      return { code: p.status, out: p.stdout + p.stderr };
    },
    read: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null),
    cleanup: () => rmSync(r, { recursive: true, force: true }),
  };
}

test('Go-Werkzeugkette: gleiche Version wie der Container-Bau, Prüfsummen für arm64/amd64/armv6l', () => {
  const buildGo = readFileSync(join(ROOT, 'dvhub/eebus/build-go.sh'), 'utf8');
  assert.equal(buildGo.match(/GO_VERSION="\$\{GO_VERSION:-([^}]+)\}"/)?.[1], GO_VERSION);
  for (const a of ['arm64', 'amd64', 'armv6l']) assert.match(PIN, new RegExp(`^GO_SHA256_${a}=[0-9a-f]{64}$`, 'm'));
});

test('arm64: lädt Go von go.dev, prüft die Summe, baut die Go-Fassung; zweiter Lauf baut nicht neu', (t) => {
  const g = rig(); t.after(g.cleanup);
  const first = g.run();
  assert.equal(first.code, 0, first.out);
  assert.deepEqual(g.read(join(g.r, 'curl.log')).trim().split('\n'), [`https://go.dev/dl/go${GO_VERSION}.linux-arm64.tar.gz`]);
  const goLog = g.read(join(g.r, 'go.log'));
  assert.match(goLog, /GOARCH=arm64 GOARM= GOTOOLCHAIN=local GOTMPDIR=\S*dvhub-eebus\.\w+\/gotmp /);
  // Checkout gehört dem Dienstnutzer, gebaut wird als root → ohne -buildvcs=false bricht go build ab.
  assert.match(goLog, /build -mod=readonly -buildvcs=false /);
  assert.equal(g.read(join(g.r, 'pkill.log')).trim(), '-TERM -x dvhub-eebus');
  assert.match(g.read(join(g.opt, 'bin/dvhub-eebus')), /go-bin/);
  assert.equal(g.read(join(g.opt, 'bin/dvhub-eebus.version')).trim(), 'go+eebus-go@v0.7.1-test');
  assert.match(g.read(join(g.data, '.eebus-provisioned')), /^go\+/);
  const second = g.run();
  assert.equal(second.code, 0, second.out);
  assert.match(second.out, /OK \(aktuell/);
  assert.equal(g.read(join(g.r, 'curl.log')).trim().split('\n').length, 1);
});

test('Bestehende C-Fassung wird beim nächsten Lauf durch die Go-Fassung ersetzt', (t) => {
  const g = rig(); t.after(g.cleanup);
  writeFileSync(join(g.data, '.eebus-impl-c'), '');
  assert.equal(g.run().code, 0);
  assert.match(g.read(join(g.opt, 'bin/dvhub-eebus')), /c-bin/);
  rmSync(join(g.data, '.eebus-impl-c'));
  const r = g.run();
  assert.equal(r.code, 0, r.out);
  assert.match(g.read(join(g.opt, 'bin/dvhub-eebus')), /go-bin/);
});

test('32-Bit-Pi (armv7l): armv6l-Paket, GOARCH=arm GOARM=7', (t) => {
  const g = rig({ arch: 'armv7l' }); t.after(g.cleanup);
  const r = g.run();
  assert.equal(r.code, 0, r.out);
  assert.match(g.read(join(g.r, 'curl.log')), new RegExp(`go${GO_VERSION.replace(/\./g, '\\.')}\\.linux-armv6l\\.tar\\.gz`));
  assert.match(g.read(join(g.r, 'go.log')), /GOARCH=arm GOARM=7 /);
});

test('Falsche Prüfsumme: Abbruch, vorhandenes Binary bleibt, kein Stand-Vermerk', (t) => {
  const g = rig({ badSum: true }); t.after(g.cleanup);
  mkdirSync(join(g.opt, 'bin'));
  writeFileSync(join(g.opt, 'bin/dvhub-eebus'), '#!/bin/sh\necho old\n'); chmodSync(join(g.opt, 'bin/dvhub-eebus'), 0o755);
  const r = g.run();
  assert.notEqual(r.code, 0);
  assert.match(r.out, /Prüfsumme/);
  assert.match(g.read(join(g.opt, 'bin/dvhub-eebus')), /old/);
  assert.equal(g.read(join(g.data, '.eebus-provisioned')), null);
  assert.equal(g.read(join(g.r, 'go.log')), null);
});

test('Ohne Go-Paket für die Architektur (riscv64) und mit .eebus-impl-c: C-Fassung', (t) => {
  const g = rig({ arch: 'riscv64' }); t.after(g.cleanup);
  const r = g.run();
  assert.equal(r.code, 0, r.out);
  assert.match(g.read(join(g.opt, 'bin/dvhub-eebus')), /c-bin/);
  assert.equal(g.read(join(g.r, 'curl.log')), null);
  assert.doesNotMatch(g.read(join(g.data, '.eebus-provisioned')), /^go\+/);
});
