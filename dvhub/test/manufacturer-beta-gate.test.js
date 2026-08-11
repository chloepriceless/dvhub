// Beta-Gate (2026-07-11): listManufacturerProfiles() blendet Profile mit
// "beta": true aus dem Hersteller-Dropdown aus, SOLANGE der Update-Kanal nicht
// 'dev' (Bleeding Edge) ist. So bleiben instabile Treiber (Fronius/Deye/bridge-
// mqtt) faktisch aus dem Release-Tag, ohne sie physisch aus dem Code zu nehmen.
// Ausnahme: ein bereits AKTIV gewähltes Beta-Profil bleibt immer sichtbar.
// Nebenvertrag: Dotfiles (.shipped-hashes.json) sind KEINE Herstellerprofile.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listManufacturerProfiles } from '../routes-api.js';

function setupHerstellerDir() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-beta-gate-'));
  const dir = path.join(rootDir, 'hersteller');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'victron.json'), JSON.stringify({ label: 'Victron' }));
  fs.writeFileSync(path.join(dir, 'fronius.json'), JSON.stringify({ label: 'Fronius GEN24 — Beta', beta: true }));
  fs.writeFileSync(path.join(dir, 'deye-lv.json'), JSON.stringify({ label: 'Deye LV — Beta', beta: true }));
  fs.writeFileSync(path.join(dir, 'bridge-mqtt.json'), JSON.stringify({ label: 'Universal — Beta', beta: true }));
  // Dotfile, das auf .json endet — darf NIE als Hersteller auftauchen.
  fs.writeFileSync(path.join(dir, '.shipped-hashes.json'), JSON.stringify({ profiles: {} }));
  return path.join(rootDir, 'config.json');
}

function ctxFor(configPath, { updateChannel = 'stable', manufacturer = 'victron' } = {}) {
  return {
    getConfigPath: () => configPath,
    getRawCfg: () => ({ updateChannel, manufacturer })
  };
}

test('stable-Kanal: Beta-Profile sind ausgeblendet, victron bleibt', () => {
  const configPath = setupHerstellerDir();
  const values = listManufacturerProfiles(ctxFor(configPath, { updateChannel: 'stable' })).map((o) => o.value);
  assert.ok(values.includes('victron'), 'victron immer da');
  assert.ok(!values.includes('fronius'), 'fronius (beta) ausgeblendet im stable-Kanal');
  assert.ok(!values.includes('deye-lv'), 'deye-lv (beta) ausgeblendet');
  assert.ok(!values.includes('bridge-mqtt'), 'bridge-mqtt (beta) ausgeblendet');
});

test('dev-Kanal (Bleeding Edge): Beta-Profile erscheinen', () => {
  const configPath = setupHerstellerDir();
  const values = listManufacturerProfiles(ctxFor(configPath, { updateChannel: 'dev' })).map((o) => o.value);
  assert.ok(values.includes('victron'));
  assert.ok(values.includes('fronius'), 'fronius im dev-Kanal sichtbar');
  assert.ok(values.includes('deye-lv'));
  assert.ok(values.includes('bridge-mqtt'));
});

test('bereits aktives Beta-Profil bleibt im stable-Kanal sichtbar (kein stiller Verlust)', () => {
  const configPath = setupHerstellerDir();
  const values = listManufacturerProfiles(
    ctxFor(configPath, { updateChannel: 'stable', manufacturer: 'fronius' })
  ).map((o) => o.value);
  assert.ok(values.includes('fronius'), 'aktiver Hersteller darf nie aus dem Dropdown fallen');
  // andere Beta-Profile bleiben trotzdem versteckt
  assert.ok(!values.includes('deye-lv'), 'nicht-aktives Beta bleibt versteckt');
});

test('.shipped-hashes.json taucht NIE als Hersteller auf (Dotfile-Filter)', () => {
  const configPath = setupHerstellerDir();
  for (const channel of ['stable', 'dev']) {
    const values = listManufacturerProfiles(ctxFor(configPath, { updateChannel: channel })).map((o) => o.value);
    assert.ok(!values.some((v) => v.includes('shipped-hashes')), `kein shipped-hashes im ${channel}-Kanal`);
  }
});

test('Option trägt beta-Flag für die UI', () => {
  const configPath = setupHerstellerDir();
  const opts = listManufacturerProfiles(ctxFor(configPath, { updateChannel: 'dev' }));
  const fronius = opts.find((o) => o.value === 'fronius');
  const victron = opts.find((o) => o.value === 'victron');
  assert.equal(fronius.beta, true);
  assert.equal(victron.beta, false);
});
