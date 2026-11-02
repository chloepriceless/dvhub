// Aktive SoC-Grenze des Victron (31.10.2026, Entlade-Wächter).
//
// Venus OS meldet neben der eingestellten Mindestgrenze (Reg. 2901,
// /Settings/CGwacs/BatteryLife/MinimumSocLimit) die gerade WIRKSAME Grenze
// (Reg. 2903, /Settings/CGwacs/BatteryLife/SocLimit, nur lesbar, 0,1 %).
// Prod 31.10.: 2901 = 50 (5 %), 2903 = 100 (10 %) — unterhalb von 10 % entlädt
// der Multi nicht. DVhub las bisher nur 2901; der Wächter hielt den Akku bei
// 10 % darum für entladbar. Der Test sperrt das Lesen über das ausgelieferte
// Herstellerprofil fest.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfigFile } from '../config-model.js';
import { createPoller } from '../polling.js';
import { buildVenusTopicMaps } from '../transport-mqtt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHIPPED_PROFILE = path.join(__dirname, '..', 'hersteller', 'victron.json');

function loadShippedVictronConfig() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-2903-'));
  fs.mkdirSync(path.join(rootDir, 'hersteller'), { recursive: true });
  fs.copyFileSync(SHIPPED_PROFILE, path.join(rootDir, 'hersteller', 'victron.json'));
  const configPath = path.join(rootDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ manufacturer: 'victron', victron: { host: '192.0.2.10' } }));
  return loadConfigFile(configPath);
}

test('ausgeliefertes Victron-Profil liest die aktive SoC-Grenze (Reg. 2903, 0,1 %)', async () => {
  const { effectiveConfig: cfg } = loadShippedVictronConfig();
  const point = cfg.points.activeSocLimitPct;
  assert.ok(point?.enabled, 'Punkt activeSocLimitPct fehlt im Profil');
  assert.equal(point.address, 2903);
  assert.equal(point.fc, 4);

  const regs = { 843: 10, 2901: 50, 2903: 100 };
  const state = {
    meter: { ok: false, updatedAt: 0, raw: [], grid_l1_w: 0, grid_l2_w: 0, grid_l3_w: 0, grid_total_w: 0, error: null },
    victron: { errors: {}, updatedAt: 0, fieldUpdatedAt: {} },
    dvRegs: new Array(8).fill(0),
    energy: { day: '2026-10-31', importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0, lastTs: 0 }
  };
  const transport = {
    type: 'modbus',
    async mbRequest(conf) {
      const out = [];
      for (let i = 0; i < (conf.quantity ?? 1); i += 1) out.push(regs[Number(conf.address) + i] ?? 0);
      return out;
    },
    async mbWriteSingle() {},
    async mbWriteMultiple() {}
  };
  const poller = createPoller({
    state, getCfg: () => cfg, transport, pushLog: () => {},
    energyPath: path.join(os.tmpdir(), 'victron-2903-poll-test.json'),
    onPollComplete: () => {}, epexNowNext: () => ({ current: { ct_kwh: 0 } })
  });
  await poller.requestPoll();
  assert.equal(state.victron.minSocPct, 5);
  assert.equal(state.victron.activeSocLimitPct, 10);
  assert.ok(state.victron.fieldUpdatedAt.activeSocLimitPct > 0, 'Frische-Stempel fehlt');
});

test('Venus-MQTT kennt das Topic der aktiven SoC-Grenze', () => {
  const { READ_TOPICS } = buildVenusTopicMaps('c0ffee');
  assert.equal(READ_TOPICS.activeSocLimitPct, 'N/c0ffee/settings/0/Settings/CGwacs/BatteryLife/SocLimit');
});
