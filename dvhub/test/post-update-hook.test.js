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
// They run the SAME sed/grep commands the script uses (kept in sync with
// post-update.sh §"systemd Service aktuell?"). The full offline-boot resilience
// (service starts despite apt/npm failure) is a prod-deploy observation.

const INSTALL_DIR = '/opt/dvhub';
const EXPECTED = `ExecStartPre=-+/usr/bin/bash ${INSTALL_DIR}/post-update.sh`;

// Mirror of the post-update.sh transformation block (T-0077). Operates on $1 = unit file.
const APPLY_HOOK_SH = `
set -euo pipefail
SERVICE_FILE="$1"
INSTALL_DIR="${INSTALL_DIR}"
EXPECTED_EXECSTARTPRE="ExecStartPre=-+/usr/bin/bash \${INSTALL_DIR}/post-update.sh"
if [[ -f "$SERVICE_FILE" ]]; then
  CURRENT_EXECSTARTPRE="$(grep -E '^ExecStartPre=.*post-update\\.sh' "$SERVICE_FILE" | head -1 || echo "")"
  if [[ -z "$CURRENT_EXECSTARTPRE" ]]; then
    sed -i "\\|^ExecStart=|i \${EXPECTED_EXECSTARTPRE}" "$SERVICE_FILE"
  elif [[ "$CURRENT_EXECSTARTPRE" != "$EXPECTED_EXECSTARTPRE" ]]; then
    sed -i "s|^ExecStartPre=.*post-update\\.sh.*|\${EXPECTED_EXECSTARTPRE}|" "$SERVICE_FILE"
  fi
fi
`;

function runHook(unitContent) {
  const dir = mkdtempSync(join(tmpdir(), 'dvhub-unit-'));
  const file = join(dir, 'dvhub.service');
  try {
    writeFileSync(file, unitContent);
    execFileSync('bash', ['-c', APPLY_HOOK_SH, 'apply-hook', file]);
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

test('T-0077: an old FATAL ExecStartPre hook (+, no -) is migrated to non-fatal (-+)', () => {
  const before = UNIT('ExecStartPre=+/usr/bin/bash /opt/dvhub/post-update.sh');
  const after = runHook(before);
  const pre = execStartPreLines(after);
  assert.equal(pre.length, 1, 'exactly one ExecStartPre line after migration');
  assert.equal(pre[0], EXPECTED, 'fatal hook rewritten to the non-fatal -+ form');
  assert.match(after, /^ExecStart=\/usr\/bin\/node /m, 'ExecStart line preserved intact');
});

test('T-0077: a missing hook is inserted (non-fatal -+) immediately before ExecStart', () => {
  const after = runHook(UNIT(null));
  const lines = after.split('\n');
  const preIdx = lines.findIndex((l) => l === EXPECTED);
  const execIdx = lines.findIndex((l) => /^ExecStart=/.test(l));
  assert.ok(preIdx >= 0, 'the non-fatal hook was inserted');
  assert.equal(preIdx + 1, execIdx, 'hook sits immediately before ExecStart');
});

test('T-0077: an already non-fatal hook is left unchanged (idempotent)', () => {
  const before = UNIT(EXPECTED);
  const after = runHook(before);
  assert.equal(execStartPreLines(after).length, 1, 'no duplicate hook');
  assert.equal(after, before, 'idempotent: byte-identical when already correct');
});
