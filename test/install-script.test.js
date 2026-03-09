import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const installPath = path.join(repoRoot, 'install.sh');
const source = fs.readFileSync(installPath, 'utf8');

test('installer registers the repo directory as a git safe.directory before updating an existing checkout', () => {
  const safeDirectoryLine = 'git config --global --add safe.directory "$INSTALL_DIR"';
  const safeIndex = source.indexOf(safeDirectoryLine);
  const fetchIndex = source.indexOf('git -C "$INSTALL_DIR" fetch --tags origin');

  assert.notEqual(safeIndex, -1, 'install.sh must register $INSTALL_DIR as a safe.directory');
  assert.notEqual(fetchIndex, -1, 'install.sh must update existing repositories via git fetch');
  assert.ok(safeIndex < fetchIndex, 'safe.directory must be configured before fetch/checkouts run');
});

test('installer force-syncs an existing checkout to the requested remote branch instead of using ff-only pull', () => {
  assert.match(
    source,
    /git -C "\$INSTALL_DIR" checkout -B "\$REPO_BRANCH" "origin\/\$REPO_BRANCH"/,
    'install.sh must align the local branch with origin/$REPO_BRANCH for managed deploy checkouts'
  );
  assert.doesNotMatch(
    source,
    /git -C "\$INSTALL_DIR" pull --ff-only origin "\$REPO_BRANCH"/,
    'install.sh must not rely on ff-only pull for existing managed installs'
  );
});

test('installer defaults to the main branch for fresh installs', () => {
  assert.match(
    source,
    /REPO_BRANCH="\$\{REPO_BRANCH:-main\}"/,
    'install.sh must default REPO_BRANCH to main so unattended installs track the merge target'
  );
});
