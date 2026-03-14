import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildModuleConfig } from '../public/components/setup/module-config.js';

describe('buildModuleConfig', () => {
  it('enables DV module', () => {
    const result = buildModuleConfig({}, 'dv', true);
    assert.strictEqual(result.modules.dv.enabled, true);
  });

  it('disables DV module', () => {
    const cfg = { modules: { dv: { enabled: true } } };
    const result = buildModuleConfig(cfg, 'dv', false);
    assert.strictEqual(result.modules.dv.enabled, false);
  });

  it('enables optimizer module', () => {
    const result = buildModuleConfig({}, 'optimizer', true);
    assert.strictEqual(result.modules.optimizer.enabled, true);
  });

  it('does not mutate original config (deep clone)', () => {
    const original = { modules: { dv: { enabled: true } }, other: 'value' };
    const copy = JSON.parse(JSON.stringify(original));
    buildModuleConfig(original, 'dv', false);
    assert.deepStrictEqual(original, copy);
  });

  it('creates modules section when config has none', () => {
    const result = buildModuleConfig({ port: 3000 }, 'dv', true);
    assert.strictEqual(result.modules.dv.enabled, true);
    assert.strictEqual(result.port, 3000);
  });

  it('preserves other config keys when toggling a module', () => {
    const cfg = { systemName: 'test', modules: { optimizer: { enabled: true } } };
    const result = buildModuleConfig(cfg, 'dv', true);
    assert.strictEqual(result.systemName, 'test');
    assert.strictEqual(result.modules.optimizer.enabled, true);
    assert.strictEqual(result.modules.dv.enabled, true);
  });
});
