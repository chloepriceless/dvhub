// test/eos-remote-licence.test.js — Lizenznachweis für den EOS-Rechendienst.
// Nur intern (Fassade), nie über HTTP; nur bei aktiver Lizenz mit Machine-File.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLicenseService } from '../services/license/index.js';

function svc() {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lic-remote-'));
  const state = {};
  const s = createLicenseService({ state, getCfg: () => ({ licensing: { keygenAccount: 't' } }), pushLog: () => {}, appDir });
  return { s, state, appDir };
}

test('getRemoteProof: Schlüssel + Machine-File nur bei aktiver Lizenz', () => {
  const { s, state, appDir } = svc();
  assert.equal(s.getRemoteProof(), null);
  s.setLicenseKeyForTest('key/abc.sig');
  s.setStatusForTest('active');
  assert.equal(s.getRemoteProof(), null, 'ohne Machine-File kein Nachweis');
  state.license.machine_file = '-----BEGIN MACHINE FILE-----\nx\n-----END MACHINE FILE-----';
  assert.deepEqual(s.getRemoteProof(), { licenseKey: 'key/abc.sig', machineFile: state.license.machine_file });
  s.setStatusForTest('expired');
  assert.equal(s.getRemoteProof(), null);
  // Nie im öffentlichen Zustand.
  const pub = s.getState();
  assert.equal(pub.license_key ?? null, null);
  assert.equal(pub.machine_file ?? null, null);
  fs.rmSync(appDir, { recursive: true, force: true });
});
