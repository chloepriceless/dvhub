// test/family-config.test.js -- contract tests for the optional `family` config
// section.
//
// Plan 16-04 (D-06 triage): REBUILT. The original tests asserted that a `family`
// section (useAsRoot / screensaver / presence / branding) lived in
// createDefaultConfig(). That contract changed by design — the `family` section
// was removed from the minimal default config (see the `60502cc feat(05-01)`
// clobber + the deliberate minimal-defaults architecture). routes-api.js
// `ALLOWED_CONFIG_ROOTS` documents `family` as a "Migration-seeded / optional
// section", and the family service reads it defensively
// (`cfg?.family?.screensaver || null`). A fresh install has no `family` section
// and the dashboard runs on hardcoded fallbacks until the user configures it.
//
// These tests assert that REAL contract: createDefaultConfig() does not seed
// `family`, `family` is an accepted POST /api/config root key, and the family
// service tolerates an absent `family` section without throwing.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultConfig } from '../config-model.js';

describe('family config section (optional)', () => {
  it('createDefaultConfig() does not seed the optional family section', () => {
    const cfg = createDefaultConfig();
    assert.equal(cfg.family, undefined,
      'family is an optional section — absent from the minimal default config');
  });

  it('family is an accepted POST /api/config root key', async () => {
    // Absent from defaults, but the settings UI must be able to save it —
    // ALLOWED_CONFIG_ROOTS is the strict root-key allowlist on POST /api/config.
    const { ALLOWED_CONFIG_ROOTS } = await import('../routes-api.js');
    assert.ok(ALLOWED_CONFIG_ROOTS.has('family'),
      'family must round-trip through POST /api/config');
  });

  it('the family service tolerates an absent family section (config -> null)', async () => {
    const { createFamilyService } = await import('../services/family/index.js');
    const ctx = {
      state: { epex: { ok: false, data: [] }, forecast: null },
      // getCfg() returns a config with NO family section — the absent-by-default state.
      getCfg: () => ({}),
      pushLog: () => {},
      db: null
    };
    const svc = createFamilyService(ctx);
    const status = await svc.buildFamilyStatus();
    assert.ok(status && typeof status === 'object', 'buildFamilyStatus returns a payload');
    assert.ok(status.config, 'payload exposes a config block');
    // Defensive read: absent family section degrades to null, not a throw.
    assert.equal(status.config.screensaver, null,
      'screensaver config is null when the family section is absent');
    assert.equal(status.config.presence, null,
      'presence config is null when the family section is absent');
  });
});
