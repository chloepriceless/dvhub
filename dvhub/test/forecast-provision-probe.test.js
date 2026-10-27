// test/forecast-provision-probe.test.js -- Probe-venv in einem eigenen Ordner.
// Review 25.10.2026 (P3): forecast-provision.sh (root) legte das Probe-venv unter
// dem festen Pfad /tmp/_dvhub_fc_venvtest an und löschte ihn danach mit rm -rf.
// Ein fester Name in /tmp kann schon von einem anderen Benutzer belegt sein.
// Jetzt: mktemp -d. python3/pip sind Attrappen, die ihre Aufrufe protokollieren.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'forecast-provision.sh');

test('Probe-venv liegt in einem frischen mktemp-Ordner und wird danach entfernt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dvhub-fcprobe-'));
  try {
    const bin = join(dir, 'bin');
    const tmp = join(dir, 'tmp');
    const app = join(dir, 'app');
    mkdirSync(bin); mkdirSync(tmp); mkdirSync(join(app, 'python'), { recursive: true });
    writeFileSync(join(app, 'python', 'requirements.txt'), 'pvlib\n');
    const log = join(dir, 'calls.log');
    // python3 -m venv <d>: legt <d>/bin/{python3,pip} als Attrappen an.
    const py = join(bin, 'python3');
    writeFileSync(py, `#!/usr/bin/env bash
echo "python3 $*" >> "${log}"
if [[ "$1" == -m && "$2" == venv ]]; then
  mkdir -p "$3/bin"
  printf '#!/usr/bin/env bash\\necho "venv $*" >> "${log}"\\n' > "$3/bin/pip"
  printf '#!/usr/bin/env bash\\nexit 0\\n' > "$3/bin/python3"
  chmod +x "$3/bin/pip" "$3/bin/python3"
  exit 0
fi
if [[ "$1" == -c ]]; then echo 3.12.0; exit 0; fi
exit 0
`);
    chmodSync(py, 0o755);
    writeFileSync(join(bin, 'chown'), '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(join(bin, 'chown'), 0o755);
    execFileSync('bash', [SCRIPT], {
      env: {
        PATH: `${bin}:${process.env.PATH}`, FORECAST_PROVISION_EUID: '0', TMPDIR: tmp,
        INSTALL_DIR: dir, APP_DIR: app, DATA_DIR: join(dir, 'data'), FORECAST_VENV: join(dir, 'forecast-venv'),
      },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const calls = readFileSync(log, 'utf8').split('\n');
    const probe = calls.find((l) => l.startsWith('python3 -m venv ') && !l.includes('forecast-venv'));
    assert.ok(probe, 'Probe-venv wurde angelegt');
    assert.doesNotMatch(probe, /_dvhub_fc_venvtest/, 'kein fester Name');
    assert.ok(probe.startsWith(`python3 -m venv ${tmp}/`), `unter TMPDIR (${probe})`);
    assert.deepEqual(readdirSync(tmp), [], 'Probe-Ordner danach entfernt');
    assert.ok(existsSync(join(dir, 'forecast-venv', 'bin', 'pip')), 'eigentliches venv angelegt');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
