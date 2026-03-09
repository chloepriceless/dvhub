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

test('installer preserves INSTALLER_SOURCE_URL across sudo re-exec', () => {
  assert.match(
    source,
    /sudo --preserve-env=INSTALLER_SOURCE_URL,REPO_URL,REPO_BRANCH,INSTALL_DIR,APP_DIR,SERVICE_USER,SERVICE_NAME,CONFIG_DIR,CONFIG_PATH,DATA_DIR bash "\$0" "\$@"/,
    'install.sh must preserve INSTALLER_SOURCE_URL so branch auto-detection survives sudo re-exec'
  );
});

test('installer derives the default branch from the installer source URL when available', () => {
  assert.match(
    source,
    /function parse_branch_from_installer_url\(\)/,
    'install.sh must parse the branch name from GitHub installer URLs'
  );
  assert.match(
    source,
    /INSTALLER_SOURCE_URL/,
    'install.sh must read installer source metadata before falling back to main'
  );
});

test('installer still falls back to the main branch when source detection is unavailable', () => {
  assert.match(
    source,
    /REPO_BRANCH="main"/,
    'install.sh must still fall back to main so unattended installs without source metadata remain stable'
  );
});
