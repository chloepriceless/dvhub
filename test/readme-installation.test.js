import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const readmePath = path.join(repoRoot, 'README.md');
const source = fs.readFileSync(readmePath, 'utf8');

test('README installation command references the main branch installer path', () => {
  assert.match(
    source,
    /https:\/\/raw\.githubusercontent\.com\/chloepriceless\/dvhub\/main\/install\.sh/,
    'README must point installation instructions at the main branch installer'
  );
  assert.doesNotMatch(
    source,
    /https:\/\/raw\.githubusercontent\.com\/chloepriceless\/dvhub\/feature\/schedule-mqtt\/install\.sh/,
    'README must not keep the feature branch installer URL after merge preparation'
  );
});

test('README startup and service paths use the dvhub app directory', () => {
  assert.match(
    source,
    /cd \/opt\/dvhub\/dvhub/,
    'README must start the app from /opt/dvhub/dvhub'
  );
  assert.match(
    source,
    /WorkingDirectory=\/opt\/dvhub\/dvhub/,
    'README systemd example must use the renamed app directory'
  );
  assert.match(
    source,
    /ExecStart=\/usr\/bin\/node --experimental-sqlite \/opt\/dvhub\/dvhub\/server\.js/,
    'README systemd example must launch server.js from /opt/dvhub/dvhub'
  );
  assert.doesNotMatch(
    source,
    /cd \/opt\/dvhub\/dv-control-webapp|WorkingDirectory=\/opt\/dvhub\/dv-control-webapp|ExecStart=\/usr\/bin\/node --experimental-sqlite \/opt\/dvhub\/dv-control-webapp\/server\.js/,
    'README must no longer document the legacy app directory as the runtime path'
  );
});
