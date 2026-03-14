import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../core/config.js';
import { createDvModule } from '../modules/dv/index.js';
import { createOptimizerModule } from '../modules/optimizer/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Helper: write a temporary config file with given overrides merged
 * into a minimal valid base config.
 */
function writeTempConfig(overrides = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-test-'));
  const base = {
    manufacturer: 'victron',
    httpPort: 8080,
    modbusListenHost: '0.0.0.0',
    modbusListenPort: 1502,
    offLeaseMs: 480000,
    meterPollMs: 2000,
    keepalivePulseSec: 60,
    gridPositiveMeans: 'feed_in',
    victron: { host: '127.0.0.1' },
    schedule: {
      timezone: 'Europe/Berlin',
      evaluateMs: 15000,
      defaultGridSetpointW: -40,
      defaultChargeCurrentA: null,
      rules: []
    },
    userEnergyPricing: {
      mode: 'fixed',
      fixedGrossImportCtKwh: 31.5,
      costs: { pvCtKwh: 6, batteryBaseCtKwh: 2, batteryLossMarkupPct: 20 }
    },
    ...overrides
  };
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(base, null, 2));

  // Copy manufacturer profile so loadConfigFile can resolve it
  const srcProfile = path.resolve(__dirname, '..', 'hersteller', 'victron.json');
  if (fs.existsSync(srcProfile)) {
    const destDir = path.join(tmpDir, 'hersteller');
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(srcProfile, path.join(destDir, 'victron.json'));
  }

  return { configPath, tmpDir };
}

function cleanup(tmpDir) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

describe('loadConfig - module activation', () => {
  it('returns config with dv enabled when modules.dv.enabled=true', () => {
    const { configPath, tmpDir } = writeTempConfig({
      modules: { dv: { enabled: true }, optimizer: { enabled: false } }
    });
    try {
      const result = loadConfig(configPath);
      assert.equal(result.config.modules.dv.enabled, true);
    } finally {
      cleanup(tmpDir);
    }
  });

  it('throws when both dv and optimizer are disabled', () => {
    const { configPath, tmpDir } = writeTempConfig({
      modules: { dv: { enabled: false }, optimizer: { enabled: false } }
    });
    try {
      assert.throws(
        () => loadConfig(configPath),
        /at least one of DV or Optimizer must be active/i
      );
    } finally {
      cleanup(tmpDir);
    }
  });

  it('enables both modules when modules section is missing (backward compat)', () => {
    const { configPath, tmpDir } = writeTempConfig({});
    // No modules key at all — should default to both enabled for backward compatibility
    try {
      const result = loadConfig(configPath);
      assert.equal(result.config.modules.dv.enabled, true);
      assert.equal(result.config.modules.optimizer.enabled, true);
    } finally {
      cleanup(tmpDir);
    }
  });

  it('succeeds with dv enabled and optimizer disabled', () => {
    const { configPath, tmpDir } = writeTempConfig({
      modules: { dv: { enabled: true }, optimizer: { enabled: false } }
    });
    try {
      const result = loadConfig(configPath);
      assert.ok(result.config);
      assert.equal(result.config.modules.dv.enabled, true);
      assert.equal(result.config.modules.optimizer.enabled, false);
    } finally {
      cleanup(tmpDir);
    }
  });
});

describe('createDvModule', () => {
  it('returns object with correct name, requires, init, destroy', async () => {
    const mod = createDvModule({});
    assert.equal(mod.name, 'dv');
    assert.deepEqual(mod.requires, ['gateway']);
    assert.equal(typeof mod.init, 'function');
    assert.equal(typeof mod.destroy, 'function');
    // init and destroy should not throw
    await mod.init({});
    await mod.destroy();
  });
});

describe('createOptimizerModule', () => {
  it('returns object with correct name, requires, init, destroy', async () => {
    const mod = createOptimizerModule({});
    assert.equal(mod.name, 'optimizer');
    assert.deepEqual(mod.requires, ['gateway']);
    assert.equal(typeof mod.init, 'function');
    assert.equal(typeof mod.destroy, 'function');
    await mod.init({});
    await mod.destroy();
  });
});
