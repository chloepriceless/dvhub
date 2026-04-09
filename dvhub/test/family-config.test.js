// test/family-config.test.js -- Unit tests for DEFAULT_CONFIG.family defaults.
// Covers D-04 (useAsRoot), D-16/D-17 (screensaver), D-19 (presence polling),
// D-20 (branding / background image).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultConfig } from '../config-model.js';

describe('DEFAULT_CONFIG.family', () => {
  it('exists as a section in createDefaultConfig()', () => {
    const cfg = createDefaultConfig();
    assert.ok(cfg.family, 'family section must exist in default config');
    assert.equal(typeof cfg.family, 'object');
  });

  it('useAsRoot defaults to false (D-04)', () => {
    const cfg = createDefaultConfig();
    assert.equal(cfg.family.useAsRoot, false);
  });

  it('screensaver defaults match D-16 / D-17', () => {
    const cfg = createDefaultConfig();
    const s = cfg.family.screensaver;
    assert.ok(s, 'family.screensaver must exist');
    assert.equal(s.enabled, true);
    assert.equal(s.defaultTimeoutSec, 120);
    assert.equal(s.dimOpacity, 0.3);
    assert.ok(Array.isArray(s.windows), 'windows must be an array (D-17)');
    assert.equal(s.windows.length, 0, 'windows defaults empty');
  });

  it('presence defaults match D-19', () => {
    const cfg = createDefaultConfig();
    const p = cfg.family.presence;
    assert.ok(p, 'family.presence must exist');
    assert.equal(p.pollIntervalMs, 2000);
    assert.equal(p.webhookEnabled, true);
  });

  it('branding defaults match D-20', () => {
    const cfg = createDefaultConfig();
    const b = cfg.family.branding;
    assert.ok(b, 'family.branding must exist');
    assert.equal(b.backgroundImage, '/assets/family-scene.png');
    assert.equal(typeof b.title, 'string');
    assert.ok(b.title.length > 0);
  });
});
