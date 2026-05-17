import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultConfig, getConfigDefinition, normalizeConfigInput } from '../config-model.js';

// RED scaffolding (Phase 10 Wave 0, TDD gate).
// sanitizeSmallMarketAutomation in config-model.js does NOT yet handle the
// `predictivePreEmpty` sub-block — plan 10-02 adds it. The four tests below
// therefore fail RED: today the sanitizer passes `predictivePreEmpty` through
// unsanitized, so the string->number coercion and the reset-on-invalid
// contract do not happen. Do NOT modify config-model.js in this plan.

// --- predictivePreEmpty config sub-block sanitizer (D-17) ---

test('normalizeConfigInput round-trips predictivePreEmpty.akkuHardLimitW string to number', () => {
  const normalized = normalizeConfigInput({
    schedule: {
      smallMarketAutomation: {
        enabled: true,
        predictivePreEmpty: {
          akkuHardLimitW: '20000'
        }
      }
    }
  });
  const ppe = normalized.rawConfig.schedule.smallMarketAutomation.predictivePreEmpty;
  assert.equal(ppe.akkuHardLimitW, 20000);
  assert.equal(typeof ppe.akkuHardLimitW, 'number');
});

test('normalizeConfigInput resets an invalid akkuHardLimitW to the safe default 20000 (never deletes it)', () => {
  // T-10-01: a missing clamp value must NEVER silently disable the battery hard
  // limit. An invalid akkuHardLimitW must RESET to 20000, not be deleted.
  const normalized = normalizeConfigInput({
    schedule: {
      smallMarketAutomation: {
        enabled: true,
        predictivePreEmpty: {
          akkuHardLimitW: 'abc'
        }
      }
    }
  });
  const ppe = normalized.rawConfig.schedule.smallMarketAutomation.predictivePreEmpty;
  assert.ok('akkuHardLimitW' in ppe,
    'akkuHardLimitW must remain present (reset, not deleted) so the clamp is never disabled');
  assert.equal(ppe.akkuHardLimitW, 20000);
});

test('normalizeConfigInput coerces predictivePreEmpty.enabled string "true" to boolean true', () => {
  const normalized = normalizeConfigInput({
    schedule: {
      smallMarketAutomation: {
        enabled: true,
        predictivePreEmpty: {
          enabled: 'true'
        }
      }
    }
  });
  const ppe = normalized.rawConfig.schedule.smallMarketAutomation.predictivePreEmpty;
  assert.equal(ppe.enabled, true);
  assert.equal(typeof ppe.enabled, 'boolean');
});

// Smoke guard so this file always runs at least one assertion that exercises
// the module surface even if the schedule block above changes shape.
test('getConfigDefinition and createDefaultConfig remain importable', () => {
  assert.equal(typeof getConfigDefinition, 'function');
  const defaults = createDefaultConfig();
  assert.ok(defaults && typeof defaults === 'object');
});
