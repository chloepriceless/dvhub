// B-1118 Deye-LV-Pack Stufe 1 (NUR Niedervolt 3ph, SG04LP3 — HV bewusst
// ausgeklammert): shipped hersteller/deye-lv.json + Work-Mode-Abregelung mit
// Readback-Restore. Tests fahren das echte Profil durch loadConfigFile, den
// echten Poller gegen ein synthetisches LP3-Registerbild und die echte
// Sequenz-Mechanik (saveBefore/restore) im Evaluator.
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
const SHIPPED_PROFILE = path.join(__dirname, '..', 'hersteller', 'deye-lv.json');

function loadDeyeEffectiveConfig() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-deye-lv-'));
  fs.mkdirSync(path.join(rootDir, 'hersteller'), { recursive: true });
  fs.copyFileSync(SHIPPED_PROFILE, path.join(rootDir, 'hersteller', 'deye-lv.json'));
  const configPath = path.join(rootDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    manufacturer: 'deye-lv',
    gridPositiveMeans: 'grid_import',
    victron: { host: '192.168.1.70' }
  }));
  return loadConfigFile(configPath);
}

// Synthetisches SG04LP3-Registerbild: SoC 588=57 %, Batterie 590=-1200 W (S16),
// Grid-CT 616-618, Hauslast 653=850 W, PV1/PV2 672/673.
function buildLp3Image(workMode = 1) {
  const image = new Map();
  image.set(142, workMode);
  image.set(588, 57);
  image.set(590, 0x10000 - 1200); // -1200 als u16-Rohwert
  image.set(616, 120); image.set(617, 90); image.set(618, 110);
  image.set(653, 850);
  image.set(672, 3100); image.set(673, 2400);
  return image;
}

function makeMockTransport(image) {
  return {
    type: 'modbus',
    writes: [],
    async mbRequest(conf) {
      const regs = [];
      for (let i = 0; i < (conf.quantity ?? 1); i += 1) {
        const addr = Number(conf.address) + i;
        if (!image.has(addr)) throw new Error(`illegal read @${addr}`);
        regs.push(image.get(addr));
      }
      return regs;
    },
    async mbWriteSingle({ address, value }) {
      this.writes.push({ fc: 6, address, value });
      image.set(address, value); // Register-Semantik: Write ist zurücklesbar
    },
    async mbWriteMultiple({ address, values }) { this.writes.push({ fc: 16, address, values }); }
  };
}

function makeEvaluator(cfg, transport) {
  const state = {
    victron: { soc: 50 },
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
  return { state, evaluator };
}

test('shipped deye-lv.json loads: modbus transport, LP3 register map, workMode sequence', () => {
  const loaded = loadDeyeEffectiveConfig();
  assert.equal(loaded.manufacturerProfileError, null);
  const cfg = loaded.effectiveConfig;
  assert.equal(cfg.victron.transport, 'modbus');
  assert.equal(cfg.points.soc.address, 588);
  assert.equal(cfg.points.batteryPowerW.signed, true);
  assert.equal(cfg.points.pvPowerW.sumRegisters, true);
  assert.equal(cfg.meter.address, 616);
  assert.equal(cfg.meter.host, '192.168.1.70');
  // Keine aktiven Steuer-Targets außer dem Sequenz-Punkt workMode.
  assert.equal(cfg.controlWrite.gridSetpointW.enabled, false);
  assert.equal(cfg.controlWrite.workMode.enabled, true);
  assert.equal(cfg.controlWrite.workMode.address, 142);
  const seq = cfg.dvControl.dontFeedExcessAcPv.sequence;
  assert.equal(seq['1'][0].saveBefore, true);
  assert.equal(seq['0'][0].restore, true);
  assert.equal(seq['0'][0].restoreDefault, 0);
});

test('poller reads LP3 telemetry (soc, signed battery, summed PV, load, CT meter)', async () => {
  const loaded = loadDeyeEffectiveConfig();
  const cfg = loaded.effectiveConfig;
  cfg.pollMs = 500;
  cfg.epex = { timezone: 'UTC' };
  cfg.userEnergyPricing = {};

  const state = {
    meter: { ok: false, updatedAt: 0, raw: [], grid_l1_w: 0, grid_l2_w: 0, grid_l3_w: 0, grid_total_w: 0, error: null },
    victron: { errors: {}, updatedAt: 0, fieldUpdatedAt: {} },
    dvRegs: new Array(8).fill(0),
    energy: { day: '2026-07-10', importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0, lastTs: 0 }
  };
  const transport = makeMockTransport(buildLp3Image());
  const poller = createPoller({
    state,
    getCfg: () => cfg,
    transport,
    pushLog: () => {},
    energyPath: path.join(os.tmpdir(), 'deye-lv-poll-test.json'),
    onPollComplete: () => {},
    epexNowNext: () => ({ current: { ct_kwh: 0 } })
  });

  await poller.requestPoll();

  assert.equal(state.victron.soc, 57);
  assert.equal(state.victron.batteryPowerW, -1200);
  assert.equal(state.victron.pvPowerW, 5500);        // 3100 + 2400
  assert.equal(state.victron.selfConsumptionW, 850);
  assert.equal(state.meter.ok, true);
  assert.equal(state.meter.grid_total_w, 320);       // grid_import: 120+90+110
});

test('curtailment saves the customer work mode and restores it on release', async () => {
  const loaded = loadDeyeEffectiveConfig();
  const cfg = loaded.effectiveConfig;
  // Kunde fährt regulär Zero-Export-to-Load (1) — NICHT Selling first.
  const transport = makeMockTransport(buildLp3Image(1));
  const { state, evaluator } = makeEvaluator(cfg, transport);

  // Sperren: liest Modus 1, sichert ihn, schreibt Zero-Export-to-CT (2).
  await evaluator.applyDvVictronControl(false);
  assert.deepEqual(transport.writes, [{ fc: 6, address: 142, value: 2 }]);
  assert.equal(state.ctrl._dvSeqSaved.workMode, 1);
  assert.equal(state.ctrl._lastDvFeedIn, false);

  // Freigeben: der GESICHERTE Kundenmodus (1) kommt zurück — nicht ein fixer Default.
  transport.writes.length = 0;
  await evaluator.applyDvVictronControl(true);
  assert.deepEqual(transport.writes, [{ fc: 6, address: 142, value: 1 }]);
  assert.equal(state.ctrl._dvSeqSaved.workMode, undefined);
});

test('release without a saved mode falls back to restoreDefault (restart during curtailment)', async () => {
  const loaded = loadDeyeEffectiveConfig();
  const cfg = loaded.effectiveConfig;
  const transport = makeMockTransport(buildLp3Image(2)); // steht noch auf Zero-Export-to-CT
  const { state, evaluator } = makeEvaluator(cfg, transport);

  // Kein vorheriger Block in dieser Prozess-Lebenszeit (state leer) → Freigabe
  // schreibt den dokumentierten Default (Selling first, 0).
  await evaluator.applyDvVictronControl(true);
  assert.deepEqual(transport.writes, [{ fc: 6, address: 142, value: 0 }]);
  assert.equal(state.ctrl._lastDvFeedIn, true);
});

test('double-block does not overwrite the saved customer mode with the block value', async () => {
  const loaded = loadDeyeEffectiveConfig();
  const cfg = loaded.effectiveConfig;
  const transport = makeMockTransport(buildLp3Image(0));
  const { state, evaluator } = makeEvaluator(cfg, transport);

  await evaluator.applyDvVictronControl(false);
  assert.equal(state.ctrl._dvSeqSaved.workMode, 0);
  // Change-Cache zurücksetzen, um einen erneuten Block-Write zu erzwingen
  // (z. B. nach T-0076-Retry) — die Sicherung darf NICHT mit 2 überschrieben werden.
  state.ctrl._lastDvFeedIn = undefined;
  await evaluator.applyDvVictronControl(false);
  assert.equal(state.ctrl._dvSeqSaved.workMode, 0, 'saved mode must survive a re-block');
});
