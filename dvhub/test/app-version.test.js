import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readAppVersionInfo } from '../app-version.js';

function createTempAppDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-app-version-'));
  const appDir = path.join(root, 'dvhub');
  fs.mkdirSync(appDir, { recursive: true });
  return { root, appDir };
}

test('readAppVersionInfo returns package version and git short sha for a regular checkout', () => {
  const { root, appDir } = createTempAppDir();

  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({
    name: 'dvhub',
    version: '3.0.0'
  }));
  fs.mkdirSync(path.join(root, '.git', 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(root, '.git', 'refs', 'heads', 'main'), 'ea104c9c8b1d234567890123456789012345678\n');

  assert.deepEqual(readAppVersionInfo({ appDir }), {
    name: 'dvhub',
    version: '3.0.0',
    revision: 'ea104c9',
    versionLabel: 'v3.0.0+ea104c9'
  });
});

test('readAppVersionInfo falls back to package version when no git metadata is present', () => {
  const { appDir } = createTempAppDir();

  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({
    name: 'dvhub',
    version: '3.0.0'
  }));

  assert.deepEqual(readAppVersionInfo({ appDir }), {
    name: 'dvhub',
    version: '3.0.0',
    revision: null,
    versionLabel: 'v3.0.0'
  });
});
