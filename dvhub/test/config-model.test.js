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

// --- Phase 24-02: sichere Out-of-Box-Security-Defaults (Wave-0-Assertions) ---
//
// 24-01-AUDIT zeigt: die root-fähige VPN-Apply-Route hängt am
// `security.lanTrust:'open'`-Default — ein Neuinstall lässt out-of-box jeden
// LAN-Client token-frei schreiben/admin/VPN steuern. Diese Wave-0-Assertions
// nageln die sichere Default-Posture für `createDefaultConfig` (Neuinstalls)
// fest. BEACHTE die Verschachtelung: `cfg.security.lanTrust` liegt im
// security-Block, aber `cfg.allowedHosts`/`cfg.corsAllowedOrigins`/
// `cfg.trustProxy`/`cfg.trustedProxyIps` sind Geschwister EINE Ebene höher.
test('Phase 24-02: createDefaultConfig liefert eine sichere LAN-Trust-Default-Posture', () => {
  const cfg = createDefaultConfig();

  // Minimum-Security-Posture (unabhängig vom konkreten Operator-Wert): ein
  // ausgelieferter Neuinstall darf NICHT den blanket-LAN-Bypass 'open' tragen.
  // Gegen den ungepatchten config-model.js ist diese Assertion RED; sie wird
  // erst durch Task 3 (Operator-freigegebener Default != 'open') GREEN.
  assert.notEqual(
    cfg.security.lanTrust,
    'open',
    'Neuinstall-Default lanTrust darf nicht "open" sein (kein blanket-LAN-Bypass out-of-box)'
  );

  // Operator-Checkpoint (Task 2) entschied 2026-06-16 (Christin): 'restricted'
  // (RESEARCH-Empfehlung A1). Hardcodierte Assertion auf den entschiedenen Wert.
  assert.equal(
    cfg.security.lanTrust,
    'restricted',
    'Neuinstall-Default lanTrust ist der operator-freigegebene Wert "restricted"'
  );

  // Feld-Coverage-Assertions: die übrigen Security-Default-Felder bleiben auf
  // ihren konservativen Out-of-Box-Werten (DNS-Rebinding-Schutz NICHT vorbefüllt,
  // kein Reverse-Proxy-Vertrauen ohne Operator-Opt-in).
  assert.deepEqual(
    cfg.allowedHosts,
    [],
    'allowedHosts bleibt out-of-box leer (Vorbefüllung ist Setup-Wizard-Logik, kein Default)'
  );
  assert.deepEqual(
    cfg.corsAllowedOrigins,
    [],
    'corsAllowedOrigins bleibt out-of-box leer'
  );
  assert.equal(
    cfg.trustProxy,
    false,
    'trustProxy bleibt out-of-box false (kein Reverse-Proxy-Vertrauen ohne Operator-Opt-in)'
  );
});

// Single-floor model (2026-06-16): the misleading soft `optimizer.minSocPct`
// knob was retired from the settings UI — it never governed the EOS control
// path (EOS discharges to optimizer.hardFloorSocPct), so showing it as
// "Min. SOC — der Optimizer entlädt nie unter diesen Wert" was a footgun. The
// hard floor is now the ONE operator-facing discharge floor. Guard against the
// soft knob being reintroduced as a UI field.
test('single-floor model: no optimizer.minSocPct UI field, hard floor present', () => {
  const def = getConfigDefinition();
  const optPaths = (def.fields || [])
    .map((f) => f && f.path)
    .filter((p) => typeof p === 'string' && p.startsWith('optimizer.'));
  assert.equal(
    optPaths.includes('optimizer.minSocPct'),
    false,
    'optimizer.minSocPct must NOT be a settings field (retired soft floor)'
  );
  assert.equal(
    optPaths.includes('optimizer.hardFloorSocPct'),
    true,
    'optimizer.hardFloorSocPct must remain the single discharge floor'
  );
});
