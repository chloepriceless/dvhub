import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

async function loadSystemDiscoveryModule() {
  return import(new URL(`../system-discovery.js?ts=${Date.now()}`, import.meta.url));
}

// Extract buildSystemDiscoveryPayload from server.js source without importing the
// full module (which pulls in heavy dependencies like pg that may not be installed
// in every environment).
function loadBuildSystemDiscoveryPayload() {
  const repoDir = fileURLToPath(new URL('..', import.meta.url));
  const serverSource = fs.readFileSync(path.join(repoDir, 'server.js'), 'utf8');
  // Find the start of the function declaration
  const startMarker = 'export async function buildSystemDiscoveryPayload(';
  const startIdx = serverSource.indexOf(startMarker);
  if (startIdx < 0) return null;
  // First match parentheses to skip past the parameter list
  let parenDepth = 0;
  let paramEnd = startIdx + startMarker.length;
  for (let i = startIdx + startMarker.length - 1; i < serverSource.length; i++) {
    if (serverSource[i] === '(') parenDepth++;
    else if (serverSource[i] === ')') parenDepth--;
    if (parenDepth === 0) { paramEnd = i; break; }
  }
  // Find the function body opening brace after the closing ')'
  const bodyStart = serverSource.indexOf('{', paramEnd + 1);
  if (bodyStart < 0) return null;
  // Walk forward counting braces to find the matching '}'
  let depth = 0;
  let endIdx = bodyStart;
  for (let i = bodyStart; i < serverSource.length; i++) {
    if (serverSource[i] === '{') depth++;
    else if (serverSource[i] === '}') depth--;
    if (depth === 0) { endIdx = i; break; }
  }
  const fnSource = serverSource.slice(startIdx, endIdx + 1).replace(/^export\s+/, '');
  const sandbox = { String, Math };
  vm.runInNewContext(fnSource, sandbox);
  return sandbox.buildSystemDiscoveryPayload;
}

test('discoverSystems dispatches by manufacturer and deduplicates normalized results', async () => {
  const module = await loadSystemDiscoveryModule().catch(() => ({}));
  const { discoverSystems } = module;

  assert.equal(typeof discoverSystems, 'function');

  const calls = [];
  const systems = await discoverSystems({
    manufacturer: 'victron',
    timeoutMs: 1500,
    providers: {
      victron: async () => {
        calls.push('victron');
        return [
          { label: 'Venus GX', host: 'venus.local', ipv4: '192.168.1.20', ipv6: 'fe80::20' },
          { label: 'Venus GX', host: 'venus.local', ipv4: '192.168.1.20', ipv6: 'fe80::20' }
        ];
      }
    }
  });

  assert.deepEqual(calls, ['victron']);
  assert.equal(systems.length, 1);
  assert.equal(systems[0].ipv4, '192.168.1.20');
  assert.equal(systems[0].ipv6, 'fe80::20');
  assert.equal(systems[0].ip, '192.168.1.20');
});

test('discoverSystems returns an empty list on provider timeout and rejects unknown manufacturers cleanly', async () => {
  const module = await loadSystemDiscoveryModule().catch(() => ({}));
  const { DiscoveryTimeoutError, discoverSystems } = module;

  assert.equal(typeof DiscoveryTimeoutError, 'function');
  assert.equal(typeof discoverSystems, 'function');

  await assert.rejects(
    () => discoverSystems({ manufacturer: 'unknown', providers: {} }),
    /not supported/i
  );

  const systems = await discoverSystems({
    manufacturer: 'victron',
    providers: {
      victron: async () => {
        throw new DiscoveryTimeoutError('timed out');
      }
    }
  });

  assert.deepEqual(systems, []);
});

test('buildSystemDiscoveryPayload returns manufacturer-scoped API responses', async () => {
  const buildSystemDiscoveryPayload = loadBuildSystemDiscoveryPayload();

  assert.equal(typeof buildSystemDiscoveryPayload, 'function');

  const payload = await buildSystemDiscoveryPayload({
    query: { manufacturer: 'victron' },
    discoverSystems: async () => [{
      id: 'a',
      label: 'Venus GX',
      host: 'venus.local',
      ipv4: '192.168.1.20',
      ipv6: 'fe80::20',
      ip: '192.168.1.20'
    }]
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.manufacturer, 'victron');
  assert.equal(payload.systems[0].ipv4, '192.168.1.20');
  assert.equal(payload.systems[0].ipv6, 'fe80::20');
  assert.equal(payload.systems[0].ip, '192.168.1.20');
});

test('buildSystemDiscoveryPayload turns discovery failures into explicit API errors with empty systems', async () => {
  const buildSystemDiscoveryPayload = loadBuildSystemDiscoveryPayload();

  assert.equal(typeof buildSystemDiscoveryPayload, 'function');

  const payload = await buildSystemDiscoveryPayload({
    query: { manufacturer: 'victron' },
    discoverSystems: async () => {
      throw new Error('network unavailable');
    }
  });

  assert.equal(payload.ok, false);
  assert.ok(Array.isArray(payload.systems) && payload.systems.length === 0);
  assert.match(payload.error, /network unavailable/i);
});
