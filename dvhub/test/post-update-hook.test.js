import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// T-0077: post-update.sh runs as a systemd ExecStartPre on EVERY service start and
// rewrites the live unit file's ExecStartPre hook. A bad transformation could corrupt
// the unit → the service refuses to start = exactly the brick we are preventing.
// These tests pin the two transformations against the ../post-update.sh logic:
//   - missing hook  → insert "-+" form before ExecStart=
//   - old fatal hook ("+", no "-") → migrate in place to the non-fatal "-+" form
//   - already "-+"  → idempotent (no change)
// Getestet wird der ECHTE Block aus ../post-update.sh (§ "systemd Service
// aktuell?"), nicht eine Kopie — sonst laufen Test und Skript unbemerkt
// auseinander (2026-10-15). Das Skript läuft nur unter Linux mit GNU sed
// (`sed -i`, `i`/`a` als Einzeiler); BSD-sed (macOS) versteht das nicht.
// Ohne GNU sed werden die Tests mit Grund übersprungen — die CI (Linux) führt
// sie aus. The full offline-boot resilience (service starts despite apt/npm
// failure) is a prod-deploy observation.

const INSTALL_DIR = '/opt/dvhub';
const EXPECTED = `ExecStartPre=-+/usr/bin/bash ${INSTALL_DIR}/post-update.sh`;

// Block aus post-update.sh: von EXPECTED_EXECSTARTPRE= bis zum Ende des
// TimeoutStartSec-Blocks.
const SCRIPT = readFileSync(new URL('../../post-update.sh', import.meta.url), 'utf8');
function extractHookBlock(script) {
  const from = script.indexOf('EXPECTED_EXECSTARTPRE="ExecStartPre=');
  const timeoutAt = script.indexOf('|a TimeoutStartSec=120" "$SERVICE_FILE"', from);
  const to = script.indexOf('\nfi\n', timeoutAt);
  if (from < 0 || timeoutAt < 0 || to < 0) throw new Error('Hook-Block in post-update.sh nicht gefunden — Test an das Skript anpassen');
  return script.slice(from, to + 4);
}
const APPLY_HOOK_SH = `
set -euo pipefail
SERVICE_FILE="$1"
INSTALL_DIR="${INSTALL_DIR}"
SERVICE_CHANGED=0
${extractHookBlock(SCRIPT)}
`;

// GNU sed vorhanden? (Linux: sed; macOS mit Homebrew: gsed)
function findGnuSed() {
  for (const bin of ['sed', 'gsed']) {
    try {
      if (/GNU sed/.test(execFileSync(bin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))) return bin;
    } catch { /* nicht vorhanden oder BSD-sed */ }
  }
  return null;
}
const GNU_SED = findGnuSed();
const SKIP = GNU_SED ? false : 'GNU sed fehlt (macOS: brew install gnu-sed) — post-update.sh läuft nur unter Linux; die CI prüft es';

function runHook(unitContent) {
  const dir = mkdtempSync(join(tmpdir(), 'dvhub-unit-'));
  const file = join(dir, 'dvhub.service');
  try {
    writeFileSync(file, unitContent);
    // gsed unter dem Namen sed bereitstellen, wie auf Linux.
    const shim = GNU_SED === 'gsed' ? `sed() { gsed "$@"; }\n` : '';
    execFileSync('bash', ['-c', shim + APPLY_HOOK_SH, 'apply-hook', file]);
    return readFileSync(file, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const UNIT = (preLine) => [
  '[Service]',
  'Type=simple',
  'User=dvhub',
  ...(preLine ? [preLine] : []),
  'ExecStart=/usr/bin/node /opt/dvhub/dvhub/server.js',
  'Restart=always',
  ''
].join('\n');

const execStartPreLines = (s) => s.split('\n').filter((l) => /^ExecStartPre=/.test(l));

test('T-0077: an old FATAL ExecStartPre hook (+, no -) is migrated to non-fatal (-+)', { skip: SKIP }, () => {
  const before = UNIT('ExecStartPre=+/usr/bin/bash /opt/dvhub/post-update.sh');
  const after = runHook(before);
  const pre = execStartPreLines(after);
  assert.equal(pre.length, 1, 'exactly one ExecStartPre line after migration');
  assert.equal(pre[0], EXPECTED, 'fatal hook rewritten to the non-fatal -+ form');
  assert.match(after, /^ExecStart=\/usr\/bin\/node /m, 'ExecStart line preserved intact');
});

test('T-0077: a missing hook is inserted (non-fatal -+) immediately before ExecStart', { skip: SKIP }, () => {
  const after = runHook(UNIT(null));
  const lines = after.split('\n');
  const preIdx = lines.findIndex((l) => l === EXPECTED);
  const execIdx = lines.findIndex((l) => /^ExecStart=/.test(l));
  assert.ok(preIdx >= 0, 'the non-fatal hook was inserted');
  assert.equal(preIdx + 1, execIdx, 'hook sits immediately before ExecStart');
});

test('T-0077: an already non-fatal hook is not duplicated/rewritten (ExecStartPre idempotent)', { skip: SKIP }, () => {
  const after = runHook(UNIT(EXPECTED));
  const pre = execStartPreLines(after);
  assert.equal(pre.length, 1, 'no duplicate hook');
  assert.equal(pre[0], EXPECTED, 'already-correct hook left as-is');
});

// --- T-0077 P0-3 Auflage: explicit start timeout ------------------------------

const timeoutLines = (s) => s.split('\n').filter((l) => /^TimeoutStartSec=/.test(l));

test('T-0077 P0-3: TimeoutStartSec=120 is inserted after ExecStart when absent', { skip: SKIP }, () => {
  const after = runHook(UNIT(EXPECTED));
  const lines = after.split('\n');
  assert.deepEqual(timeoutLines(after), ['TimeoutStartSec=120'], 'exactly one timeout line');
  const execIdx = lines.findIndex((l) => /^ExecStart=/.test(l));
  const toIdx = lines.findIndex((l) => /^TimeoutStartSec=/.test(l));
  assert.equal(toIdx, execIdx + 1, 'timeout sits immediately after ExecStart');
});

test('T-0077 P0-3: an existing TimeoutStartSec is not duplicated (idempotent)', { skip: SKIP }, () => {
  const unit = UNIT(EXPECTED).replace('Restart=always', 'TimeoutStartSec=300\nRestart=always');
  const after = runHook(unit);
  assert.deepEqual(timeoutLines(after), ['TimeoutStartSec=300'], 'operator value kept, not duplicated');
});
