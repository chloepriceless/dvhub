import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const installPath = path.join(repoRoot, 'install.sh');
const source = fs.readFileSync(installPath, 'utf8');

test('installer defaults APP_DIR to the renamed dvhub app directory', () => {
  assert.match(
    source,
    /APP_DIR="\$\{APP_DIR:-\$INSTALL_DIR\/dvhub\}"/,
    'install.sh must default APP_DIR to /opt/dvhub/dvhub'
  );
  assert.doesNotMatch(
    source,
    /APP_DIR="\$\{APP_DIR:-\$INSTALL_DIR\/dv-control-webapp\}"/,
    'install.sh must not keep the legacy default app directory'
  );
});

test('installer defines a legacy app path and migration helpers for old host layouts', () => {
  assert.match(
    source,
    /LEGACY_APP_DIR="\$\{LEGACY_APP_DIR:-\$INSTALL_DIR\/dv-control-webapp\}"/,
    'install.sh must keep track of the legacy app directory so old hosts can be migrated'
  );
  assert.match(
    source,
    /function migrate_legacy_config_files\(\)/,
    'install.sh must define a config migration helper for legacy installs'
  );
  assert.match(
    source,
    /function migrate_legacy_data_files\(\)/,
    'install.sh must define a data migration helper for legacy installs'
  );
  assert.match(
    source,
    /function remove_legacy_app_dir\(\)/,
    'install.sh must define a cleanup helper for the old app directory'
  );
  assert.match(
    source,
    /function assert_supported_layout\(\)/,
    'install.sh must validate host layouts before migration'
  );
});

test('installer runs legacy migration before validating the renamed app directory', () => {
  const migrateIndex = source.indexOf('migrate_legacy_config_files');
  const migrateDataIndex = source.indexOf('migrate_legacy_data_files');
  const cleanupIndex = source.indexOf('remove_legacy_app_dir');
  const packageIndex = source.indexOf('if [[ ! -f "$APP_DIR/package.json" ]]');

  assert.notEqual(migrateIndex, -1, 'install.sh must invoke legacy config migration');
  assert.notEqual(migrateDataIndex, -1, 'install.sh must invoke legacy data migration');
  assert.notEqual(cleanupIndex, -1, 'install.sh must remove the legacy app dir after migration');
  assert.notEqual(packageIndex, -1, 'install.sh must still validate the renamed app directory');
  assert.ok(migrateIndex < packageIndex, 'legacy migration must happen before app validation');
  assert.ok(migrateDataIndex < packageIndex, 'legacy data migration must happen before app validation');
  assert.ok(cleanupIndex < packageIndex, 'legacy cleanup must happen before app validation');
});

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

test('installer restarts the dvhub service after a successful sync', () => {
  const enableIndex = source.indexOf('systemctl enable --now "${SERVICE_NAME}.service"');
  const restartIndex = source.indexOf('systemctl restart "${SERVICE_NAME}.service"');

  assert.notEqual(enableIndex, -1, 'install.sh must enable the service');
  assert.notEqual(restartIndex, -1, 'install.sh must explicitly restart the service after updates');
  assert.ok(restartIndex > enableIndex, 'service restart must happen after the unit is enabled and started');
});
