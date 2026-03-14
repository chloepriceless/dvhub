/**
 * Integration Wiring Tests
 *
 * Static analysis and runtime tests verifying all 7 integration gaps
 * (INT-01 through INT-07) are closed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dvhubRoot = join(__dirname, '..');

function readSource(relativePath) {
  return readFileSync(join(dvhubRoot, relativePath), 'utf-8');
}

// ─── Task 1: INT-01 + INT-04 — Bootstrap wiring ───

describe('INT-01: Exec module registered in server.js', () => {
  const src = readSource('server.js');

  it('imports createExecModule', () => {
    assert.match(src, /createExecModule/);
  });

  it('uses enabled !== false pattern (enabled by default)', () => {
    assert.match(src, /config\.modules\?\.exec\?\.enabled\s*!==\s*false/);
  });

  it('registers exec module via registry.register', () => {
    assert.match(src, /registry\.register\(createExecModule\(\)\)/);
  });
});

describe('INT-04: Database adapter instantiated in server.js', () => {
  const src = readSource('server.js');

  it('imports createDatabaseAdapter', () => {
    assert.match(src, /import\s*\{\s*createDatabaseAdapter\s*\}\s*from\s*'\.\/core\/database\/adapter\.js'/);
  });

  it('calls createDatabaseAdapter(config)', () => {
    assert.match(src, /createDatabaseAdapter\(config\)/);
  });

  it('passes db in registry.initAll context', () => {
    assert.match(src, /registry\.initAll\(\{[\s\S]*?\bdb\b[\s\S]*?\}\)/);
  });

  it('closes db in shutdown handler', () => {
    assert.match(src, /db\?*\)?\s*await\s+db\.close\(\)|if\s*\(db\)\s*await\s+db\.close\(\)/);
  });
});
