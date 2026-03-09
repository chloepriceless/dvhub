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
