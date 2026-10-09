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
    version: '0.3.0'
  }));
  fs.mkdirSync(path.join(root, '.git', 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(root, '.git', 'refs', 'heads', 'main'), 'ea104c9c8b1d234567890123456789012345678\n');

  assert.deepEqual(readAppVersionInfo({ appDir }), {
    name: 'dvhub',
    version: '0.3.0',
    revision: 'ea104c9',
    versionLabel: 'v0.3.0+ea104c9'
  });
});

test('readAppVersionInfo falls back to package version when no git metadata is present', () => {
  const { appDir } = createTempAppDir();

  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({
    name: 'dvhub',
    version: '0.3.0'
  }));

  assert.deepEqual(readAppVersionInfo({ appDir }), {
    name: 'dvhub',
    version: '0.3.0',
    revision: null,
    versionLabel: 'v0.3.0'
  });
});

// Container: kein .git im Image — der Commit kommt aus DVHUB_REVISION.
test('readAppVersionInfo nimmt im Container den Commit aus DVHUB_REVISION', () => {
  const { appDir } = createTempAppDir();
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'dvhub', version: '1.0.7' }));
  const before = process.env.DVHUB_REVISION;
  try {
    process.env.DVHUB_REVISION = '4c066dab1234567890abcdef1234567890abcdef';
    assert.equal(readAppVersionInfo({ appDir }).versionLabel, 'v1.0.7+4c066da');
    // Platzhalter des Dockerfile („unknown") und Unsinn zählen nicht.
    process.env.DVHUB_REVISION = 'unknown';
    assert.equal(readAppVersionInfo({ appDir }).versionLabel, 'v1.0.7');
    delete process.env.DVHUB_REVISION;
    assert.equal(readAppVersionInfo({ appDir }).versionLabel, 'v1.0.7');
  } finally {
    if (before === undefined) delete process.env.DVHUB_REVISION; else process.env.DVHUB_REVISION = before;
  }
});
