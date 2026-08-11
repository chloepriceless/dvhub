// test/settings-license-capacity.test.js
//
// T-LICENSE-KWP-GATING Increment 5: licenseCapacityMessage() — the license-
// section upgrade nudge. Covers both over-tier flavours (DECLARED via
// capacity_ok=false, MEASURED via plant_exceeds_license + grace/gate) and the
// no-op cases (no tier / not active / within tier).
//
// Loads public/settings.js in a VM sandbox and reads the DVhubSettingsLicense
// global (mirrors test/settings-pv-plants.test.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function loadLicenseHelpers() {
  const settingsPath = fileURLToPath(new URL('../public/settings.js', import.meta.url));
  const source = fs.readFileSync(settingsPath, 'utf8');
  const sandbox = {
    console,
    globalThis: {},
    window: {
      DVhubCommon: { escapeHtml: (v) => String(v ?? '') },
      addEventListener() {},
      setTimeout() {}
    }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: path.basename(settingsPath) });
  return sandbox.DVhubSettingsLicense;
}

const { licenseCapacityMessage } = loadLicenseHelpers();

test('capacity message: null when not active', () => {
  assert.equal(licenseCapacityMessage({ status: 'none', max_kwp: 50 }), null);
  assert.equal(licenseCapacityMessage(null), null);
});

test('capacity message: null for no tier (max_kwp null = Community/Pro L/Legacy)', () => {
  assert.equal(licenseCapacityMessage({ status: 'active', max_kwp: null, capacity_ok: true }), null);
});

test('capacity message: null when everything fits (capacity_ok true, no measured flag)', () => {
  assert.equal(licenseCapacityMessage({ status: 'active', max_kwp: 50, system_kwp: 40, capacity_ok: true }), null);
});

test('capacity message: DECLARED over-tier (capacity_ok false) → immediate-deactivation nudge', () => {
  const msg = licenseCapacityMessage({ status: 'active', max_kwp: 50, system_kwp: 80, capacity_ok: false });
  assert.match(msg, /80 kWp/);
  assert.match(msg, /50 kWp/);
  assert.match(msg, /deaktiviert/i);
  assert.match(msg, /upgrad/i);
});

test('capacity message: MEASURED over-tier within grace → upgrade nudge with grace date', () => {
  const msg = licenseCapacityMessage({
    status: 'active', max_kwp: 50, capacity_ok: true,
    plant_exceeds_license: true, plant_gate_active: false,
    observed_peak_w: 90000, plant_exceeds_grace_until: '2026-07-20T10:00:00.000Z'
  });
  assert.match(msg, /90 kW/);          // 90000 W → 90 kW
  assert.match(msg, /50 kWp/);
  assert.match(msg, /2026-07-20/);     // grace date shown
  assert.match(msg, /Kulanzfrist/i);
});

test('capacity message: MEASURED over-tier after grace (gate active) → deactivated', () => {
  const msg = licenseCapacityMessage({
    status: 'active', max_kwp: 50, capacity_ok: true,
    plant_exceeds_license: true, plant_gate_active: true,
    observed_peak_w: 90000, plant_exceeds_grace_until: '2026-07-01T10:00:00.000Z'
  });
  assert.match(msg, /abgelaufen/i);
  assert.match(msg, /deaktiviert/i);
});
