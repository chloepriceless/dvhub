// reg-2704-Scale-Fix (2026-07-12): Venus /Settings/CGwacs/MaxDischargePower
// zählt in 10-W-Schritten (Victron-Scalefactor 0.1). DVhub las/schrieb bisher
// mit scale 1 → prod zeigte „2 400 W" statt real 24 000 W, und ein GUI-Write
// von 20 000 hätte raw 20000 = 200 kW geschrieben. Fix: scale 10 + rawSentinels
// — die Mode-Werte -1 (unbegrenzt) und 0 (Entladung sperren) gehen UNskaliert
// (sonst würde -1 mit scale 10 zu round(-0.1) = 0 = Sperre — genau falsch herum).
// Testet Write-Encoding (applyControlTarget → Modbus-Rohwert) und Read-Decode
// (Poller → state.victron.maxDischargeW) gegen die prod-Konstellation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfigFile } from '../config-model.js';
import { createPoller } from '../polling.js';
import { createScheduleEvaluator } from '../schedule-eval.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHIPPED_PROFILE = path.join(__dirname, '..', 'hersteller', 'victron.json');

// prod-Konstellation: shipped Profil + Operator-Zusatz points.maxDischargeW
// (Anzeige-Read auf reg 2704) mit der korrigierten Skala.
function loadVictronEffectiveConfig() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-2704-'));
  fs.mkdirSync(path.join(rootDir, 'hersteller'), { recursive: true });
  const profile = JSON.parse(fs.readFileSync(SHIPPED_PROFILE, 'utf8'));
  profile.points.maxDischargeW = {
    enabled: true, fc: 4, address: 2704, quantity: 1,
    signed: true, scale: 10, offset: 0, rawSentinels: [-1, 0]
  };
  fs.writeFileSync(path.join(rootDir, 'hersteller', 'victron.json'), JSON.stringify(profile));
  const configPath = path.join(rootDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    manufacturer: 'victron',
    victron: { host: '192.0.2.10' }
  }));
  return loadConfigFile(configPath);
}

function makeMockTransport(regValues = {}) {
  return {
    type: 'modbus',
    writes: [],
    async mbRequest(conf) {
      const regs = [];
      for (let i = 0; i < (conf.quantity ?? 1); i += 1) {
        regs.push(regValues[Number(conf.address) + i] ?? 0);
      }
      return regs;
    },
    async mbWriteSingle({ address, value }) { this.writes.push({ fc: 6, address, value }); },
    async mbWriteMultiple({ address, values }) { this.writes.push({ fc: 16, address, values }); }
  };
}

function makeEvaluator(cfg, transport) {
  const state = {
    victron: { soc: 50, fieldUpdatedAt: { soc: Date.now() } },
    schedule: { rules: [], active: {}, lastWrite: {}, manualOverride: {}, config: {}, lastEvalAt: 0 },
    ctrl: {}
  };
  const evaluator = createScheduleEvaluator({
    state,
    getCfg: () => cfg,
    transport,
    pushLog: () => {},
    telemetrySafeWrite: () => {},
    persistConfig: async () => {},
    telemetryStore: null,
    epexNowNext: () => null
  });
  return { evaluator, state };
}

test('shipped victron.json: controlWrite.maxDischargeW hat scale 10 + rawSentinels [-1, 0]', () => {
  const loaded = loadVictronEffectiveConfig();
  assert.equal(loaded.manufacturerProfileError, null);
  const conf = loaded.effectiveConfig.controlWrite.maxDischargeW;
  assert.equal(conf.scale, 10);
  assert.deepEqual(conf.rawSentinels, [-1, 0]);
  assert.equal(conf.address, 2704);
});

test('Write: 24000 W → raw 2400 (10-W-Schritte); 20000 W → raw 2000', async () => {
  const loaded = loadVictronEffectiveConfig();
  const transport = makeMockTransport();
  const { evaluator } = makeEvaluator(loaded.effectiveConfig, transport);

  const r1 = await evaluator.applyControlTarget('maxDischargeW', 24000, 'test');
  assert.equal(r1.ok, true, JSON.stringify(r1));
  const r2 = await evaluator.applyControlTarget('maxDischargeW', 20000, 'test');
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.deepEqual(transport.writes, [
    { fc: 6, address: 2704, value: 2400 },
    { fc: 6, address: 2704, value: 2000 }
  ]);
});

test('Write-Sentinels: -1 (unbegrenzt) → raw 0xFFFF, 0 (sperren) → raw 0 — NIE skaliert', async () => {
  const loaded = loadVictronEffectiveConfig();
  const transport = makeMockTransport();
  const { evaluator } = makeEvaluator(loaded.effectiveConfig, transport);

  const r1 = await evaluator.applyControlTarget('maxDischargeW', -1, 'test');
  assert.equal(r1.ok, true, JSON.stringify(r1));
  const r2 = await evaluator.applyControlTarget('maxDischargeW', 0, 'test');
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.deepEqual(transport.writes, [
    { fc: 6, address: 2704, value: 0xffff }, // -1 als int16-Zweierkomplement, NICHT round(-0.1)=0
    { fc: 6, address: 2704, value: 0 }
  ]);
});

test('Read: raw 2400 → 24000 W Anzeige; raw -1 (0xFFFF) → -1 (Sentinel, nicht -10)', async () => {
  const loaded = loadVictronEffectiveConfig();
  const cfg = loaded.effectiveConfig;
  cfg.pollMs = 500;
  cfg.epex = { timezone: 'UTC' };
  cfg.userEnergyPricing = {};

  const regs = {
    820: 0, 821: 0, 822: 0,          // meter
    843: 57, 842: 0, 850: 0,         // soc / battery / pv
    808: 0, 809: 0, 810: 0,
    2716: 0, 2717: 0, 2901: 50,
    817: 0, 818: 0, 819: 0,
    2704: 2400                        // MaxDischargePower raw = 24 000 W
  };
  const state = {
    meter: { ok: false, updatedAt: 0, raw: [], grid_l1_w: 0, grid_l2_w: 0, grid_l3_w: 0, grid_total_w: 0, error: null },
    victron: { errors: {}, updatedAt: 0, fieldUpdatedAt: {} },
    dvRegs: new Array(8).fill(0),
    energy: { day: '2026-07-12', importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0, lastTs: 0 }
  };
  const transport = makeMockTransport(regs);
  const poller = createPoller({
    state,
    getCfg: () => cfg,
    transport,
    pushLog: () => {},
    energyPath: path.join(os.tmpdir(), 'victron-2704-poll-test.json'),
    onPollComplete: () => {},
    epexNowNext: () => ({ current: { ct_kwh: 0 } })
  });

  await poller.requestPoll();
  assert.equal(state.victron.maxDischargeW, 24000, '10-W-Schritte hochskaliert');

  regs[2704] = 0xffff; // -1 = unbegrenzt (Victron-Sentinel)
  await poller.requestPoll();
  assert.equal(state.victron.maxDischargeW, -1, 'Sentinel unskaliert (nicht -10)');
});
