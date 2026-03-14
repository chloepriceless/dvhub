/**
 * Install preflight contract tests.
 *
 * These are "contract tests" that grep install.sh for required patterns,
 * verifying the installer has the expected structure without running it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const installSh = readFileSync(resolve(__dirname, '../../install.sh'), 'utf-8');

describe('install-preflight contract tests', () => {
  it('npm ci requires package-lock.json', () => {
    assert.ok(
      installSh.includes('package-lock.json'),
      'install.sh should check for package-lock.json'
    );
    assert.ok(
      installSh.includes('npm ci'),
      'install.sh should use npm ci'
    );
  });

  it('Docker check skipped in native mode', () => {
    assert.ok(
      /DEPLOY_MODE.*!=.*native|DEPLOY_MODE.*ne.*native/.test(installSh) ||
      installSh.includes('"$DEPLOY_MODE" != "native"'),
      'install.sh should skip Docker check in native mode'
    );
  });

  it('Docker check required in hybrid mode', () => {
    assert.ok(
      installSh.includes('docker compose version'),
      'install.sh should verify docker compose v2 plugin'
    );
    assert.ok(
      installSh.includes('command -v docker'),
      'install.sh should check for docker binary'
    );
  });

  it('systemd template uses sed substitution', () => {
    assert.ok(
      installSh.includes('dvhub.service.template'),
      'install.sh should reference the systemd template file'
    );
    assert.ok(
      installSh.includes('sed') && installSh.includes('__SERVICE_USER__'),
      'install.sh should use sed to substitute template placeholders'
    );
  });

  it('--mode parameter accepted', () => {
    assert.ok(
      installSh.includes('--mode)'),
      'install.sh should accept --mode parameter'
    );
    assert.ok(
      installSh.includes('DEPLOY_MODE'),
      'install.sh should set DEPLOY_MODE variable'
    );
  });
});
