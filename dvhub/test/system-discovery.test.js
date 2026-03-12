import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefaultConfig } from '../config-model.js';

async function loadSystemDiscoveryModule() {
  return import(new URL(`../system-discovery.js?ts=${Date.now()}`, import.meta.url));
}

let serverModulePromise = null;

async function loadServerModule() {
  if (serverModulePromise) return serverModulePromise;
  const repoDir = fileURLToPath(new URL('..', import.meta.url));
  const configPath = path.join(repoDir, `.tmp-system-discovery-${Date.now()}.json`);
  const config = createDefaultConfig();
  config.manufacturer = '';
  config.victron = { ...config.victron, host: '' };
  config.telemetry = { ...config.telemetry, enabled: false };
  config.epex = { ...config.epex, enabled: false };
  config.influx = { ...config.influx, enabled: false };
  fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');

  const previousRole = process.env.DVHUB_PROCESS_ROLE;
  const previousConfigPath = process.env.DV_APP_CONFIG;
  process.env.DVHUB_PROCESS_ROLE = 'test';
  process.env.DV_APP_CONFIG = configPath;

  serverModulePromise = import(new URL(`../server.js?ts=${Date.now()}`, import.meta.url)).finally(() => {
    fs.rmSync(configPath, { force: true });
    if (previousRole == null) delete process.env.DVHUB_PROCESS_ROLE;
    else process.env.DVHUB_PROCESS_ROLE = previousRole;
    if (previousConfigPath == null) delete process.env.DV_APP_CONFIG;
    else process.env.DV_APP_CONFIG = previousConfigPath;
  });

  return serverModulePromise;
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
          { label: 'Venus GX', host: 'venus.local', ip: '192.168.1.20' },
          { label: 'Venus GX', host: 'venus.local', ip: '192.168.1.20' }
        ];
      }
    }
  });

  assert.deepEqual(calls, ['victron']);
  assert.equal(systems.length, 1);
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
  const module = await loadServerModule().catch(() => ({}));
  const { buildSystemDiscoveryPayload } = module;

  assert.equal(typeof buildSystemDiscoveryPayload, 'function');

  const payload = await buildSystemDiscoveryPayload({
    query: { manufacturer: 'victron' },
    discoverSystems: async () => [{ id: 'a', label: 'Venus GX', host: 'venus.local', ip: '192.168.1.20' }]
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.manufacturer, 'victron');
  assert.equal(payload.systems[0].ip, '192.168.1.20');
});

test('buildSystemDiscoveryPayload turns discovery failures into explicit API errors with empty systems', async () => {
  const module = await loadServerModule().catch(() => ({}));
  const { buildSystemDiscoveryPayload } = module;

  assert.equal(typeof buildSystemDiscoveryPayload, 'function');

  const payload = await buildSystemDiscoveryPayload({
    query: { manufacturer: 'victron' },
    discoverSystems: async () => {
      throw new Error('network unavailable');
    }
  });

  assert.equal(payload.ok, false);
  assert.deepEqual(payload.systems, []);
  assert.match(payload.error, /network unavailable/i);
});
