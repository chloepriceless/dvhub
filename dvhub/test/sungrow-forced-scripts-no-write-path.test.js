// test/sungrow-forced-scripts-no-write-path.test.js — Restpunkt 1, gleiches Muster außerhalb des Prozesses:
// ExecStopPost (scripts/sungrow-forced-release.mjs) und Box-Watchdog (scripts/sungrow-forced-watchdog.mjs) meldeten bei
// ungültigem Herstellerprofil „kein Sungrow-EMS-Profil aktiv — nichts zu tun“, auch wenn DVhubs Forced-Merker noch
// stand: DVhubs Modus 2 kann am Wechselrichter weiterlaufen, geschrieben wird nichts (R-T2.1: keine Schreibadressen).
// Jetzt sagen sie das laut. Echte Skripte, echter Ladeweg (config-model.js), kein Netzwerk (sie enden vor dem Transport).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadConfigFile } from '../config-model.js';
import { endpointKeyOf } from '../services/inverter/sungrow.js';

const DVHUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function box({ brokenProfile = true, merker = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-sg-scripts-'));
  fs.mkdirSync(path.join(dir, 'hersteller'), { recursive: true });
  if (brokenProfile) fs.writeFileSync(path.join(dir, 'hersteller', 'sungrow.json'), '{ "kaputt": ');
  else fs.copyFileSync(path.join(DVHUB, 'hersteller', 'sungrow.json'), path.join(dir, 'hersteller', 'sungrow.json'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ manufacturer: 'sungrow', updateChannel: 'dev', victron: { host: '192.0.2.50' } }));
  const cfg = loadConfigFile(configPath).effectiveConfig;
  if (merker) fs.writeFileSync(path.join(dir, 'sungrow_ems_state.json'), JSON.stringify({ ownMode: 2, endpointKey: endpointKeyOf(cfg.victron), at: 1 }));
  return { dir, configPath };
}

function run(script, b) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(DVHUB, 'scripts', script)], {
      cwd: DVHUB, timeout: 20_000,
      env: { ...process.env, DV_APP_CONFIG: b.configPath, DATA_DIR: b.dir, SUNGROW_RELEASE_TIMEOUT_MS: '3000', SUNGROW_WATCHDOG_TIMEOUT_MS: '3000' },
    }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, out: `${stdout}${stderr}` }));
  });
}

for (const script of ['sungrow-forced-release.mjs', 'sungrow-forced-watchdog.mjs']) {
  test(`${script}: ungültiges Herstellerprofil + Forced-Merker → laut „kein Schreibweg, nichts zurückgenommen“ statt „nichts zu tun“`, async () => {
    const b = box();
    const r = await run(script, b);
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /nichts zu tun/, r.out);
    assert.match(r.out, /Konfiguration ungültig/, r.out);
    assert.match(r.out, /NICHTS zurückgenommen/, r.out);
    assert.match(r.out, /manufacturer_profile_error/, r.out);
  });

  test(`${script}: ungültiges Herstellerprofil ohne Merker → wie bisher still (nichts zu tun)`, async () => {
    const b = box({ merker: false });
    const r = await run(script, b);
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /NICHTS zurückgenommen/, r.out);
  });
}
