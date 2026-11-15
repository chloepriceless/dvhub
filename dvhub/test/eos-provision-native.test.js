// test/eos-provision-native.test.js — Rust-Kern des DVhub-EOS bei der nativen
// Installation (T-0415, Christin 11.11.2026: DVhub liefert DVhub-EOS IMMER mit
// aktivem Rust-Kern aus).
//
// eos-provision.sh holt das zur Box passende Wheel (Auswahl über die
// Plattform-Tags des EOS-venv), prüft die gepinnte sha256, installiert es,
// setzt EOS_OPTIMIZATION__GENETIC__BACKEND=native in der Unit und lässt
// scripts/eos-native-smoke.py einen nativen Lauf rechnen. Plattform ohne Wheel:
// ausdrücklich Python. Gescheitert: Exit 2, Marker „failed“, nie still Python.
// python3/pip/systemctl sind Attrappen, das Wheel-„Release“ ein lokaler Ordner
// (file://), das echte scripts/eos-native-wheels.sh prüft die Prüfsumme.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'eos-provision.sh');
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
const WHEEL = (arch) => `akkudoktoreos_native-0.2.0-cp311-abi3-manylinux2014_${arch}.manylinux_2_17_${arch}.whl`;
const sha = (s) => createHash('sha256').update(s).digest('hex');

function setup({ arch = 'aarch64' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dvhub-eosnative-'));
  const upstream = join(dir, 'upstream');
  mkdirSync(upstream);
  git(upstream, 'init', '-q', '-b', 'main');
  writeFileSync(join(upstream, 'pyproject.toml'), 'v = 1\n');
  git(upstream, 'add', '.'); git(upstream, 'commit', '-qm', 'one'); git(upstream, 'tag', 'dvhub-eos-1.0.0-dvhub.1');
  const pin = 'dvhub-eos-1.0.0-dvhub.1';

  // „Release-Assets“ des Fork-Tags.
  const rel = join(dir, 'release');
  mkdirSync(rel);
  const pins = [];
  for (const [key, a] of [['X86_64', 'x86_64'], ['AARCH64', 'aarch64'], ['ARMV7L', 'armv7l']]) {
    const body = `wheel ${a}\n`;
    writeFileSync(join(rel, WHEEL(a)), body);
    pins.push(`EOS_NATIVE_${key}=${WHEEL(a)}`, `EOS_NATIVE_${key}_SHA256=${sha(body)}`);
  }
  // local-native: das eigenständige Binär dvhub-optimize als Release-Asset.
  // Dieselbe Datei für alle Arch-Pins — eos-provision.sh wählt nach `uname -m`,
  // so läuft der Test auf jeder Host-Arch. Das „Binär“ ist ein Skript, das auf
  // `version` antwortet (der Rauchtest ruft genau das auf).
  const binName = 'dvhub-optimize-0.1.0-test';
  const binBody = '#!/usr/bin/env bash\ncase "$1" in version) echo "dvhub-optimize test (eos-genetic)";; esac\nexit 0\n';
  writeFileSync(join(rel, binName), binBody);
  chmodSync(join(rel, binName), 0o755);
  const binPins = [];
  for (const key of ['X86_64', 'AARCH64', 'ARMV7L']) {
    binPins.push(`EOS_NATIVE_BIN_${key}=${binName}`, `EOS_NATIVE_BIN_${key}_SHA256=${sha(binBody)}`);
  }
  const pinFile = join(dir, 'eos-version.env');
  writeFileSync(pinFile, [`EOS_REPO_URL=file://${upstream}`, `EOS_PIN=${pin}`, 'EOS_NATIVE_VERSION=0.2.0',
    `EOS_NATIVE_URL=file://${rel}`, ...pins,
    'EOS_NATIVE_BIN_VERSION=0.1.0-test', `EOS_NATIVE_BIN_URL=file://${rel}`, ...binPins, ''].join('\n'));

  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'calls.log');
  const fake = (name, body = '') => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\necho "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // venv-Python: wählt wie pip nach Plattform (FAKE_ARCH), rechnet den
  // Rauchtest (FAKE_SMOKE=fail → Rückfall) und protokolliert das Backend.
  const venvPython = `#!/usr/bin/env bash
echo "python $* backend=\${EOS_OPTIMIZATION__GENETIC__BACKEND:-}" >> "${log}"
if [[ "$1" == - ]]; then
  cat >/dev/null; shift
  for n in "$@"; do [[ "$n" == *"_\${FAKE_ARCH}.whl" ]] && { echo "$n"; exit 0; }; done
  exit 3
fi
if [[ "$1" == -c ]]; then echo "linux-\${FAKE_ARCH}"; exit 0; fi
if [[ "$1" == *eos-native-smoke.py ]]; then
  if [[ -e "${dir}/smoke-fails" ]]; then echo "native_status: NativeStatus(available=False)"; echo "FAIL: native kernel not available: not certified"; exit 1; fi
  echo "log: GENETIC native run (akkudoktoreos_native 0.2.0) took 0.01 s."; echo "OK: native kernel used, no fallback"; exit 0
fi
exit 0
`;
  fake('python3', `if [[ "$1" == -m && "$2" == venv ]]; then
  mkdir -p "$3/bin"
  printf '#!/usr/bin/env bash\\necho "pip $*" >> "${log}"\\nexit 0\\n' > "$3/bin/pip"
  cat > "$3/bin/python" <<'PYFAKE'
${venvPython}
PYFAKE
  chmod +x "$3/bin/pip" "$3/bin/python"
fi
exit 0`);
  fake('systemctl'); fake('chown'); fake('timedatectl', 'echo Europe/Berlin');
  const install = join(dir, 'opt');
  mkdirSync(install);
  const unitFile = join(dir, 'eos.service');
  const optinMarker = join(dir, 'eos-native-optin');
  const env = {
    PATH: `${bin}:${process.env.PATH}`, ...GIT_ENV, HOME: dir, FAKE_ARCH: arch,
    EOS_PROVISION_EUID: '0', INSTALL_DIR: install, DATA_DIR: join(dir, 'data'),
    EOS_PIN_FILE: pinFile, EOS_HOME: join(dir, 'eos-home'),
    EOS_ENV_FILE: join(dir, 'eos.env'), EOS_UNIT_FILE: unitFile,
    EOS_NATIVE_OPTIN_MARKER: optinMarker,
  };
  const run = (extra = {}) => {
    writeFileSync(log, '');
    return spawnSync('bash', [SCRIPT], { env: { ...env, ...extra }, encoding: 'utf8' });
  };
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
  return {
    dir, rel, pin, upstream, run, pinFile,
    calls: () => read(log) || '',
    unit: () => read(unitFile) || '',
    marker: () => read(join(dir, 'data', '.eos-provisioned'))?.trim() ?? null,
    native: () => read(join(dir, 'data', '.eos-native'))?.trim() ?? null,
    engine: () => read(join(dir, 'data', '.eos-native-engine'))?.trim() ?? null,
    nativeBin: () => read(join(install, 'bin', 'dvhub-optimize')),
    setOptin: (on) => { if (on) writeFileSync(optinMarker, ''); else rmSync(optinMarker, { force: true }); },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const backendLine = (unit) => (/^Environment=EOS_OPTIMIZATION__GENETIC__BACKEND=(\S+)$/m.exec(unit) || [])[1] ?? null;

test('passendes Wheel: geprüft, installiert, Rauchtest nativ, Backend native vor EnvironmentFile', () => {
  const s = setup({ arch: 'aarch64' });
  try {
    const r = s.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const calls = s.calls();
    assert.match(calls, new RegExp(`^pip install --no-deps --no-index --force-reinstall \\S+/${WHEEL('aarch64').replace(/\./g, '\\.')}$`, 'm'));
    assert.match(calls, /^python \S+eos-native-smoke\.py backend=native$/m, 'Rauchtest mit Backend native');
    assert.equal(backendLine(s.unit()), 'native');
    assert.ok(s.unit().indexOf('EOS_OPTIMIZATION__GENETIC__BACKEND=native') < s.unit().indexOf('EnvironmentFile='),
      'eos.env darf das Backend im Notfall überschreiben');
    assert.equal(s.native(), `file://${s.upstream}@${s.pin} ok ${WHEEL('aarch64')}`);
    assert.equal(s.marker(), `file://${s.upstream}@${s.pin}`);
    assert.match(r.stdout, /Rust-Kern aktiv \(GENETIC native run/);
  } finally { s.cleanup(); }
});

test('32-Bit-Userland (armv7l): das armv7l-Wheel, nicht das der Kernel-Architektur', () => {
  const s = setup({ arch: 'armv7l' });
  try {
    const r = s.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(s.calls(), new RegExp(`force-reinstall \\S+/${WHEEL('armv7l').replace(/\./g, '\\.')}$`, 'm'));
    assert.equal(s.native(), `file://${s.upstream}@${s.pin} ok ${WHEEL('armv7l')}`);
  } finally { s.cleanup(); }
});

test('Plattform ohne Wheel (armv6l): ausdrücklich Python, Warnung, kein Fehler', () => {
  const s = setup({ arch: 'armv6l' });
  try {
    const r = s.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(s.calls(), /force-reinstall/);
    assert.doesNotMatch(s.calls(), /eos-native-smoke/);
    assert.equal(backendLine(s.unit()), 'python');
    assert.equal(s.native(), `file://${s.upstream}@${s.pin} unsupported linux-armv6l`);
    assert.match(r.stderr, /keinen Rust-Kern; EOS rechnet ausdruecklich in Python/);
  } finally { s.cleanup(); }
});

test('Prüfsumme passt nicht: nichts installiert, Exit 2, Marker failed, EOS selbst installiert', () => {
  const s = setup();
  try {
    writeFileSync(join(s.rel, WHEEL('aarch64')), 'manipuliert\n');
    const r = s.run();
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.doesNotMatch(s.calls(), /force-reinstall/);
    assert.match(r.stderr, /Prüfsumme von \S+ passt nicht/);
    assert.match(r.stderr, /Rust-Kern ist NICHT aktiv/);
    assert.match(s.native(), / failed /);
    assert.equal(backendLine(s.unit()), 'native', 'Backend bleibt native: EOS meldet den Rückfall laut');
    assert.equal(s.marker(), `file://${s.upstream}@${s.pin}`, 'EOS ist installiert — kein venv-Neubau beim nächsten Versuch');
  } finally { s.cleanup(); }
});

test('Rauchtest scheitert (Rückfall): Exit 2 mit FAIL-Zeile; nächster Lauf nur Kern (EOS_NATIVE_ONLY)', () => {
  const s = setup();
  try {
    writeFileSync(join(s.dir, 'smoke-fails'), '');
    const r = s.run();
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(s.native(), / failed Rauchtest gescheitert \(rc=1\): FAIL: native kernel not available/);
    rmSync(join(s.dir, 'smoke-fails'));
    const again = s.run({ EOS_NATIVE_ONLY: '1' });
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.match(again.stdout, /nur der Rust-Kern wird nachgezogen/);
    assert.doesNotMatch(s.calls(), /^pip install -e /m, 'kein pip install -e');
    assert.doesNotMatch(s.calls(), /^pip install --upgrade pip/m);
    assert.match(s.native(), / ok /);
    assert.equal(backendLine(s.unit()), 'native');
  } finally { s.cleanup(); }
});

test('EOS_NATIVE_ONLY bei neuem Stand: volle Provisionierung', () => {
  const s = setup();
  try {
    const r = s.run({ EOS_NATIVE_ONLY: '1' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /nur der Rust-Kern/);
    assert.match(s.calls(), /^pip install -e /m);
  } finally { s.cleanup(); }
});

test('eigener Stand (Pin per Env, nicht aus eos-version.env): kein Kern, kein Backend, Warnung', () => {
  const s = setup();
  try {
    git(s.upstream, 'tag', 'v-eigen');
    const r = s.run({ EOS_PIN: 'v-eigen' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(backendLine(s.unit()), null, 'unbekanntes EOS kennt den Schlüssel womöglich nicht');
    assert.doesNotMatch(s.calls(), /force-reinstall/);
    assert.equal(s.native(), `file://${s.upstream}@v-eigen none eigener-Stand`);
    assert.match(r.stderr, /kein Rust-Kern hinterlegt/);
  } finally { s.cleanup(); }
});

test('Backend aus einer alten Unit wandert nicht in eos.env (sonst klebte es für immer)', () => {
  const s = setup({ arch: 'armv6l' });
  try {
    writeFileSync(join(s.dir, 'eos.service'), '[Service]\nEnvironment=EOS_OPTIMIZATION__GENETIC__BACKEND=python\nEnvironment=EOS_FOO=1\n');
    const r = s.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const envFile = readFileSync(join(s.dir, 'eos.env'), 'utf8');
    assert.match(envFile, /^EOS_FOO=1$/m);
    assert.doesNotMatch(envFile, /GENETIC__BACKEND/);
  } finally { s.cleanup(); }
});

// --- scripts/eos-native-wheels.sh update-pins --------------------------------
test('update-pins: glibc-Wheels aus SHA256SUMS in die Pin-Datei, musllinux bleibt draußen', () => {
  const s = setup();
  try {
    const sums = join(s.dir, 'SHA256SUMS');
    const lines = [];
    for (const a of ['x86_64', 'aarch64', 'armv7l']) {
      lines.push(`${'a'.repeat(63)}${a.length}  akkudoktoreos_native-0.3.0-cp311-abi3-musllinux_1_2_${a}.whl`);
      lines.push(`${'b'.repeat(63)}${a.length}  akkudoktoreos_native-0.3.0-cp311-abi3-manylinux2014_${a}.manylinux_2_17_${a}.whl`);
    }
    writeFileSync(sums, `${lines.join('\n')}\n`);
    const r = spawnSync('bash', [join(ROOT, 'scripts', 'eos-native-wheels.sh'), 'update-pins', sums, s.pinFile], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const text = readFileSync(s.pinFile, 'utf8');
    assert.match(text, /^EOS_NATIVE_AARCH64=akkudoktoreos_native-0\.3\.0-cp311-abi3-manylinux2014_aarch64\.manylinux_2_17_aarch64\.whl$/m);
    assert.match(text, new RegExp(`^EOS_NATIVE_AARCH64_SHA256=${'b'.repeat(63)}7$`, 'm'));
    assert.match(text, new RegExp(`^EOS_NATIVE_X86_64_SHA256=${'b'.repeat(63)}6$`, 'm'));
    assert.doesNotMatch(text, /musllinux/);
  } finally { s.cleanup(); }
});

// ── local-native: nativer Optimierer dvhub-optimize ALS EOS-Dienst ──────────
// Nur mit BEIDEM — Config mode=local-native (EOS_PROXY_MODE) UND Opt-in-Marker.
// Sonst bleibt es beim Python-EOS (der bestehende Weg ist unberührt). Fehlt das
// Binär/passt die Prüfsumme nicht, Rückfall auf Python.
const nativeExec = (unit) => /^ExecStart=\S*dvhub-optimize serve --listen 127\.0\.0\.1:8503 /m.test(unit);
const pythonExec = (unit) => /ExecStart=\S*python -m akkudoktoreos\.server\.eos/.test(unit);

test('local-native + Opt-in: nativer Dienst, kein venv/pip, Marker native', () => {
  const s = setup({ arch: 'aarch64' });
  try {
    s.setOptin(true);
    const r = s.run({ EOS_PROXY_MODE: 'local-native' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(nativeExec(s.unit()), `native ExecStart erwartet:\n${s.unit()}`);
    assert.ok(!pythonExec(s.unit()), 'kein Python-ExecStart');
    assert.doesNotMatch(s.calls(), /^pip install -e /m, 'kein Python-Install im nativen Weg');
    assert.match(s.calls(), /^systemctl restart eos\.service/m);
    assert.ok(s.nativeBin(), 'Binär nach INSTALL_DIR/bin/dvhub-optimize installiert');
    assert.match(s.native(), /\bok native:dvhub-optimize-0\.1\.0-test-AARCH64:/);
    // Steuer-Marker .eos-native-engine getrennt; .eos-provisioned (Python-Stand)
    // fasst der native Weg NICHT an (Rückweg-Datensicherung, Codex-P2 #3).
    assert.match(s.engine(), /^native file:\/\/\S+@\S+ dvhub-optimize-0\.1\.0-test:[0-9a-f]{12}$/);
    assert.equal(s.marker(), null, '.eos-provisioned unangetastet im nativen Weg');
    assert.match(r.stdout, /nativer Optimierer AKTIV/);
  } finally { s.cleanup(); }
});

test('mode=local-native OHNE Opt-in: KEIN nativer Dienst, Python-Weg (Codex-P3)', () => {
  const s = setup({ arch: 'aarch64' });
  try {
    // kein setOptin → der Config-Schalter allein darf nicht umstellen
    const r = s.run({ EOS_PROXY_MODE: 'local-native' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(pythonExec(s.unit()), 'Python-ExecStart (nicht nativ)');
    assert.ok(!nativeExec(s.unit()), 'kein nativer ExecStart ohne Opt-in');
    assert.match(s.calls(), /^pip install -e /m, 'Python-Weg lief');
    assert.equal(s.nativeBin(), null, 'kein Binär installiert');
  } finally { s.cleanup(); }
});

test('Opt-in gesetzt, aber mode=local: Python-Weg (beides nötig)', () => {
  const s = setup({ arch: 'aarch64' });
  try {
    s.setOptin(true);
    const r = s.run({ EOS_PROXY_MODE: 'local' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(pythonExec(s.unit()));
    assert.ok(!nativeExec(s.unit()));
  } finally { s.cleanup(); }
});

test('Binär-Prüfsumme passt nicht: Rückfall auf Python, Warnung', () => {
  const s = setup({ arch: 'aarch64' });
  try {
    s.setOptin(true);
    writeFileSync(join(s.rel, 'dvhub-optimize-0.1.0-test'), 'manipuliert\n'); // sha ≠ Pin
    const r = s.run({ EOS_PROXY_MODE: 'local-native' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(pythonExec(s.unit()), 'Rückfall: Python-Dienst');
    assert.ok(!nativeExec(s.unit()));
    assert.match(r.stderr, /Rückfall auf Python-EOS/);
    // Als Fallback VERMERKT, damit post-update.sh nicht bei jedem Start neu
    // (teuer) provisioniert (Codex-P2 #1).
    assert.match(s.engine(), /^fallback file:\/\/\S+@\S+ /);
  } finally { s.cleanup(); }
});

test('kein Binär-Pin für diese Arch: Python, KEIN Fallback-Vermerk (Codex-P2 #1, kein Churn)', () => {
  const s = setup({ arch: 'aarch64' });
  try {
    s.setOptin(true);
    // Alle Binär-Pins entfernen → eos_bin_sig leer → gar nicht erst nativ versuchen.
    const pins = readFileSync(s.pinFile, 'utf8').replace(/^EOS_NATIVE_BIN_.*$/gm, '').replace(/\n{2,}/g, '\n');
    writeFileSync(s.pinFile, pins);
    const r = s.run({ EOS_PROXY_MODE: 'local-native' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(pythonExec(s.unit()), 'Python-Dienst');
    assert.ok(!nativeExec(s.unit()));
    assert.equal(s.engine(), null, 'kein Motor-Marker (weder native noch fallback) → post-update churnt nicht');
    assert.match(r.stderr, /kein natives Binär für .* gepinnt/);
  } finally { s.cleanup(); }
});

test('vorübergehender Download-Fehler (kein Prüfsummen-Fehler): Python, KEIN Vermerk → erneuter Versuch (Codex-P3)', () => {
  const s = setup({ arch: 'aarch64' });
  try {
    s.setOptin(true);
    rmSync(join(s.rel, 'dvhub-optimize-0.1.0-test'), { force: true }); // Asset fehlt → Download-Fehler, kein sha-Fehler
    const r = s.run({ EOS_PROXY_MODE: 'local-native' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(pythonExec(s.unit()), 'Python vorerst');
    assert.equal(s.engine(), null, 'kein Fallback-Vermerk bei transientem Fehler → nächster Start versucht nativ erneut');
    assert.match(r.stderr, /erneuter Versuch beim nächsten Start/);
  } finally { s.cleanup(); }
});

test('EOS_ENGINE=native erzwingt nativ (mit Opt-in)', () => {
  const s = setup({ arch: 'aarch64' });
  try {
    s.setOptin(true);
    const r = s.run({ EOS_ENGINE: 'native' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(nativeExec(s.unit()));
  } finally { s.cleanup(); }
});

test('EOS_ENGINE=native OHNE Opt-in: trotzdem Python (Marker ist harte Sperre)', () => {
  const s = setup({ arch: 'aarch64' });
  try {
    const r = s.run({ EOS_ENGINE: 'native' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(pythonExec(s.unit()), 'ohne Opt-in nie nativ');
  } finally { s.cleanup(); }
});

test('idempotent: zweiter nativer Lauf ändert nichts, kein erneuter restart', () => {
  const s = setup({ arch: 'aarch64' });
  try {
    s.setOptin(true);
    assert.equal(s.run({ EOS_PROXY_MODE: 'local-native' }).status, 0);
    const r = s.run({ EOS_PROXY_MODE: 'local-native' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /nativer Optimierer aktuell .* nichts zu tun/);
    assert.doesNotMatch(s.calls(), /^systemctl restart eos\.service/m, 'kein Neustart-Karussell');
  } finally { s.cleanup(); }
});

test('neuer Binär-Pin (andere sha) → Neu-Installation, nicht "nichts zu tun" (Codex-P2 #2)', () => {
  const s = setup({ arch: 'aarch64' });
  try {
    s.setOptin(true);
    assert.equal(s.run({ EOS_PROXY_MODE: 'local-native' }).status, 0);
    // Binär im Release ersetzen + Pin-sha nachziehen (wie DEV→CI-Bau).
    const neu = '#!/usr/bin/env bash\ncase "$1" in version) echo "dvhub-optimize test v2";; esac\nexit 0\n';
    writeFileSync(join(s.rel, 'dvhub-optimize-0.1.0-test'), neu);
    const newSha = createHash('sha256').update(neu).digest('hex');
    const pins = readFileSync(s.pinFile, 'utf8').replace(/^(EOS_NATIVE_BIN_[A-Z0-9_]*_SHA256)=.*$/gm, `$1=${newSha}`);
    writeFileSync(s.pinFile, pins);
    const r = s.run({ EOS_PROXY_MODE: 'local-native' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /nativer Optimierer AKTIV/, 'neu installiert, nicht übersprungen');
    assert.match(s.engine(), new RegExp(`:${newSha.slice(0, 12)}$`), 'Motor-Marker nennt die neue sha');
  } finally { s.cleanup(); }
});

test('Rückweg: von nativ zurück auf Python (mode=local) stellt den Python-Dienst wieder her', () => {
  const s = setup({ arch: 'aarch64' });
  try {
    s.setOptin(true);
    assert.ok(nativeExec((s.run({ EOS_PROXY_MODE: 'local-native' }), s.unit())));
    const r = s.run({ EOS_PROXY_MODE: 'local' }); // Schalter zurück
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(pythonExec(s.unit()), 'Python-Dienst wieder da');
    assert.ok(!nativeExec(s.unit()));
    assert.match(s.calls(), /^pip install -e /m);
    assert.equal(s.engine(), null, 'Motor-Marker beim Rückweg gelöscht');
  } finally { s.cleanup(); }
});
