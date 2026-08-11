#!/usr/bin/env node
/*
 * tests/sudoers-drift.mjs — D-10 sudoers drift-sentinel (CI contract check).
 *
 * Fails CI the moment the `BEGIN DVHUB SUDOERS`..`END DVHUB SUDOERS` block in
 * `install.sh` diverges from the same block in `post-update.sh`.
 *
 * Why drift is dangerous: `post-update.sh` is the script that actually writes
 * `/etc/sudoers.d/dvhub-service-actions` on prod during a git-based update. If
 * its sudoers block silently drifts from `install.sh`, a stale set of root
 * permission grants gets re-armed on the live battery system — most notably the
 * VPN-watchdog restart loop — without anyone noticing. Both files MUST carry a
 * byte-identical block; this sentinel is the enforcement.
 *
 * The two blocks are byte-identical today, so this check is green day one and
 * only ever fails on a real, intentional-or-accidental divergence.
 *
 * Usage:
 *   node tests/sudoers-drift.mjs   # exit 0 if identical, exit 1 on drift
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// __dirname is <repo>/tests — install.sh / post-update.sh live at <repo> root.
// Resolve from this file's own location so the check runs identically from the
// repo root AND from dvhub/ (the cwd `npm test` uses).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const block = (relPath) => {
  const lines = readFileSync(join(repoRoot, relPath), 'utf8').split('\n');
  const a = lines.findIndex(l => l.includes('BEGIN DVHUB SUDOERS'));
  const b = lines.findIndex(l => l.includes('END DVHUB SUDOERS'));
  if (a === -1 || b === -1 || b < a) {
    console.error('sudoers-drift: FAIL — BEGIN/END DVHUB SUDOERS markers missing in ' + relPath);
    process.exit(1);
  }
  return lines.slice(a, b + 1).join('\n');
};

if (block('install.sh') !== block('post-update.sh')) {
  console.error('sudoers-drift: FAIL — BEGIN/END DVHUB SUDOERS block diverged between install.sh and post-update.sh');
  process.exit(1);
}
console.log('sudoers-drift: OK (install.sh <-> post-update.sh BEGIN/END blocks identical)');
process.exit(0);
