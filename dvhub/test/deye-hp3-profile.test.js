// Deye HP3 (Hochvolt, 3-phasig) — mitgeliefertes Nur-Lese-Profil hersteller/deye-hp3.json.
// Echter Ladeweg (loadConfigFile), echter Poller (createPoller/pointFromRegs/Zähler-Standardweg) gegen ein
// synthetisches Registerbild nach Deye V105, echter Evaluator für die Schreibwege, echtes Hersteller-Dropdown.
// Registerwerte: .planning/docs/research/2026-11-15-deye-modbus-control-spec.md §2 (V105 [SPEC]).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfigFile } from '../config-model.js';
import { createPoller } from '../polling.js';
import { createScheduleEvaluator } from '../schedule-eval.js';
import { listManufacturerProfiles } from '../routes-api.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ID = 'deye-hp3';
const SHIPPED = path.join(HERE, '..', 'hersteller', `${ID}.json`);
const SHIPPED_VICTRON = path.join(HERE, '..', 'hersteller', 'victron.json');

// Wie auf einer Box: das Profil liegt neben der mitgelieferten victron.json. `editProfile` ändert eine Kopie
// (nur für die Gegenprobe im Draht-Test).
function setup(config = {}, editProfile = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dvhub-${ID}-`));
  fs.mkdirSync(path.join(dir, 'hersteller'));
  const profile = JSON.parse(fs.readFileSync(SHIPPED, 'utf8'));
  if (editProfile) editProfile(profile);
  fs.writeFileSync(path.join(dir, 'hersteller', `${ID}.json`), JSON.stringify(profile, null, 2));
  fs.copyFileSync(SHIPPED_VICTRON, path.join(dir, 'hersteller', 'victron.json'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    manufacturer: ID,
    gridPositiveMeans: 'grid_import',
    victron: { host: '192.0.2.71' },
    // Betreiber hat „Aktive Anlagensteuerung“ und Negativpreis-Schutz an — das Lese-Profil darf trotzdem nichts tun.
    dvControl: { enabled: true, negativePriceProtection: { enabled: true } },
    ...config
  }));
  return configPath;
}

const u16 = (v) => (v < 0 ? 0x10000 + v : v);

// Synthetisches HP3-Registerbild (Rohwerte, HV-Skala 10 W bei PV und Akku).
function hp3Image({ battRaw = -250, load = 4210 } = {}) {
  return new Map([
    [588, 63],                                   // SoC 63 %
    [590, u16(battRaw)],                         // Akku „output power“, ×10 W
    [622, 1200], [623, u16(-300)], [624, 450],   // Netz je Phase, 1 W
    [653, u16(load)],                            // Hauslast, 1 W
    [672, 412], [673, 388], [674, 95], [675, 0], // PV1–4, ×10 W
  ]);
}

function mockTransport(image) {
  const reads = [];
  const writes = [];
  return {
    type: 'modbus',
    reads,
    writes,
    async mbRequest(conf) {
      reads.push({ fc: conf.fc, address: Number(conf.address), quantity: conf.quantity ?? 1, unitId: conf.unitId, host: conf.host });
      const regs = [];
      for (let i = 0; i < (conf.quantity ?? 1); i += 1) {
        const addr = Number(conf.address) + i;
        if (!image.has(addr)) throw new Error(`illegal read @${addr}`);
        regs.push(image.get(addr));
      }
      return regs;
    },
    async mbWriteSingle({ address, value }) { writes.push([address, value]); },
    async mbWriteMultiple({ address, values }) { writes.push([address, values]); },
  };
}

async function pollOnce(cfg, image) {
  cfg.epex = { timezone: 'UTC' };
  cfg.userEnergyPricing = {};
  const state = {
    meter: { ok: false, updatedAt: 0, raw: [], grid_l1_w: 0, grid_l2_w: 0, grid_l3_w: 0, grid_total_w: 0, error: null },
    victron: { errors: {}, updatedAt: 0, fieldUpdatedAt: {} },
    dvRegs: new Array(8).fill(0),
    energy: { day: '2026-11-18', importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0, lastTs: 0 },
  };
  const transport = mockTransport(image);
  const poller = createPoller({
    state,
    getCfg: () => cfg,
    transport,
    pushLog: () => {},
    energyPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), `dvhub-${ID}-energy-`)), 'energy.json'),
    onPollComplete: () => {},
    epexNowNext: () => ({ current: { ct_kwh: 0 } }),
  });
  await poller.requestPoll();
  return { state, transport };
}

function writeTargets(cfg) {
  const out = [];
  for (const [k, v] of Object.entries(cfg.controlWrite || {})) if (v?.enabled) out.push(`controlWrite.${k}`);
  for (const k of ['feedExcessDcPv', 'dontFeedExcessAcPv', 'zeroFeedIn']) {
    if (cfg.dvControl?.[k] !== undefined) out.push(`dvControl.${k}`);
  }
  return out;
}

// --- Profil -----------------------------------------------------------------------------------------------------

test('deye-hp3.json: Nur-Lese-Profil, Beta, Label und Hilfetext sagen es offen', () => {
  const raw = JSON.parse(fs.readFileSync(SHIPPED, 'utf8'));
  assert.equal(raw.readOnly, true);
  assert.equal(raw.beta, true);
  assert.match(raw.label, /Deye/);
  assert.match(raw.label, /HP3/);
  assert.match(raw.label, /nur Anzeige/);
  assert.ok(raw.label.length <= 64, 'Dropdown kürzt Labels auf 64 Zeichen');
  assert.match(raw.help, /nur Anzeige, keine Steuerung, am Gerät ungeprüft/i);
  assert.equal(raw.identify, undefined, 'keine Geräteerkennung (E10 fehlt) — nichts vortäuschen');
});

test('Laden: gültig, Modbus über Gateway, Registerkarte HP3, Verbindung aus dem Profil', () => {
  const loaded = loadConfigFile(setup());
  assert.equal(loaded.valid, true);
  assert.equal(loaded.manufacturerProfileError, null);
  assert.equal(loaded.persistedConfig.manufacturer, ID);
  const cfg = loaded.effectiveConfig;
  assert.equal(cfg.writeSafety, undefined);
  assert.equal(cfg.victron.transport, 'modbus');
  assert.equal(cfg.victron.port, 502);
  assert.equal(cfg.victron.unitId, 1);
  assert.deepEqual([cfg.meter.fc, cfg.meter.address, cfg.meter.quantity, cfg.meter.readType], [3, 622, 3, undefined]);
  assert.equal(cfg.meter.host, '192.0.2.71');
  assert.equal(cfg.meter.unitId, 1);
  assert.deepEqual(Object.keys(cfg.points).sort(), ['batteryPowerW', 'pvPowerW', 'selfConsumptionW', 'soc']);
  for (const p of Object.values(cfg.points)) {
    assert.equal(p.fc, 3, 'Deye: nur FC 03 lesbar');
    assert.equal(p.host, '192.0.2.71');
    assert.equal(p.unitId, 1);
  }
  assert.equal(cfg.identify, undefined);
});

test('Schreiben: null Schreibziele und null Abregel-Ziele, auch mit dvControl.enabled:true in config.json', () => {
  const cfg = loadConfigFile(setup()).effectiveConfig;
  assert.deepEqual(writeTargets(cfg), []);
  assert.deepEqual(cfg.controlWrite, {});
  assert.equal(cfg.dvControl.enabled, false, 'config.json schaltet die Abregelung nicht ein');
  assert.equal(cfg.dvControl.negativePriceProtection.enabled, false);
});

// Treibt jeden Schreibweg des echten Evaluators: Sollwerte (Netz-Sollwert als Einspeisung, damit die
// Netzladesperre ihn nicht vorher abweist), Abregelung, Negativpreis, zwei Zeitplan-Takte. Der Transport liest
// überall 0 und zählt jeden Write — ein Lesefehler darf einen Write nicht verdecken.
async function wireWrites(cfg) {
  const state = {
    victron: { soc: 63 },
    meter: { ok: true, grid_total_w: -3000, updatedAt: Date.now() },
    ctrl: {},
    schedule: { rules: [], active: {}, lastWrite: {}, manualOverride: {}, config: {}, lastEvalAt: 0 },
  };
  const writes = [];
  const transport = {
    type: 'modbus',
    async mbRequest({ quantity = 1 }) { return Array.from({ length: quantity }, () => 0); },
    async mbWriteSingle({ address, value }) { writes.push([address, value]); },
    async mbWriteMultiple({ address, values }) { writes.push([address, values]); },
  };
  const ev = createScheduleEvaluator({
    state, getCfg: () => cfg, transport,
    pushLog: () => {}, telemetrySafeWrite: () => {}, persistConfig: async () => {},
    epexNowNext: () => ({ current: { ct_kwh: -5 } }),
    regenerateSmallMarketAutomationRules: async () => {},
  });
  await ev.applyControlTarget('gridSetpointW', -500, 'eos_optimization');
  await ev.applyControlTarget('gridSetpointW', -800, 'api');
  await ev.applyControlTarget('maxDischargeW', 0, 'eos_optimization');
  await ev.applyControlTarget('minSocPct', 20, 'eos_optimization');
  await ev.applyControlTarget('chargeCurrentA', 10, 'api');
  await ev.applyControlTarget('feedExcessDcPv', 0, 'negative_price_protection');
  await ev.applyDvVictronControl(false, { reason: 'negative_price_protection' });
  await ev.evaluateSchedule();
  await ev.evaluateSchedule();
  return writes;
}

test('Draht: alle Schreibwege des Evaluators (Sollwerte, Abregelung, Negativpreis) → kein einziger Modbus-Write', async () => {
  assert.deepEqual(await wireWrites(loadConfigFile(setup()).effectiveConfig), []);
});

test('Draht-Gegenprobe: dasselbe Profil OHNE readOnly und mit Schreibzielen schreibt — der Prüfstand sieht Writes', async () => {
  const cfg = loadConfigFile(setup({}, (p) => {
    delete p.readOnly;
    p.controlWrite = { gridSetpointW: { enabled: true, fc: 16, address: 1111, writeType: 'int16', scale: 1, offset: 0 } };
    p.dvControl = { enabled: true, feedExcessDcPv: { enabled: true, fc: 16, address: 40010, writeType: 'uint16' } };
  })).effectiveConfig;
  const addrs = new Set((await wireWrites(cfg)).map(([address]) => address));
  assert.ok(addrs.has(1111), `Netz-Sollwert muss auf dem Draht landen (gesehen: ${[...addrs]})`);
  assert.ok(addrs.has(40010), `Abregel-Flag muss auf dem Draht landen (gesehen: ${[...addrs]})`);
});

// --- Dekodieren über den echten Poller ------------------------------------------------------------------------------

test('Poller: HV-Skala 10 W (PV, Akku), Akku-Vorzeichen gedreht (+ = Laden), Netz 622–624, Last 653', async () => {
  const cfg = loadConfigFile(setup()).effectiveConfig;
  const { state, transport } = await pollOnce(cfg, hp3Image({ battRaw: -250 }));

  assert.deepEqual(state.victron.errors, {}, 'jede Lesung trifft ein Register des Bildes');
  assert.equal(state.victron.soc, 63);
  // 590 roh −250 → „output“ −2500 W = Akku nimmt 2500 W auf → DVhub +2500 (Laden).
  assert.equal(state.victron.batteryPowerW, 2500);
  assert.equal(state.victron.batteryChargeW, 2500);
  assert.equal(state.victron.batteryDischargeW, 0);
  // (412 + 388 + 95 + 0) × 10 W
  assert.equal(state.victron.pvPowerW, 8950);
  assert.equal(state.victron.selfConsumptionW, 4210);
  // 1200 − 300 + 450, S16 je Phase, Bezug positiv
  assert.equal(state.meter.ok, true);
  assert.deepEqual([state.meter.grid_l1_w, state.meter.grid_l2_w, state.meter.grid_l3_w], [1200, -300, 450]);
  assert.equal(state.meter.grid_total_w, 1350);
  assert.equal(state.victron.gridImportW, 1350);
  assert.equal(state.victron.gridExportW, 0);

  // Gelesen werden genau die Profilregister (FC 3, Unit 1) — kein Victron-Register, kein PV5–8, kein 616.
  const addrs = [...new Set(transport.reads.map((r) => r.address))].sort((a, b) => a - b);
  assert.deepEqual(addrs, [588, 590, 622, 653, 672]);
  assert.ok(transport.reads.every((r) => r.fc === 3 && r.unitId === 1 && r.host === '192.0.2.71'));
});

test('Poller: Entladen (590 positiv) wird negativ; Einspeisung über alle Phasen; Last S16 (−5 statt 65531)', async () => {
  const cfg = loadConfigFile(setup()).effectiveConfig;
  const image = hp3Image({ battRaw: 180, load: -5 });
  image.set(622, u16(-2100)); image.set(623, u16(-1900)); image.set(624, u16(-2000));
  const { state } = await pollOnce(cfg, image);
  assert.equal(state.victron.batteryPowerW, -1800);
  assert.equal(state.victron.batteryDischargeW, 1800);
  assert.equal(state.meter.grid_total_w, -6000);
  assert.equal(state.victron.gridExportW, 6000);
  assert.equal(state.victron.selfConsumptionW, -5, 'V105: 653 ist S16');
});

test('Poller: Netzsumme läuft nicht über, auch wenn sie 32 767 W übersteigt (DVhub addiert die Phasen)', async () => {
  const cfg = loadConfigFile(setup()).effectiveConfig;
  const image = hp3Image();
  image.set(622, 14000); image.set(623, 13500); image.set(624, 12800);
  const { state } = await pollOnce(cfg, image);
  assert.equal(state.meter.grid_total_w, 40300);
});

// --- Beta-Gate -------------------------------------------------------------------------------------------------

test('Dropdown: im Stable-Kanal ausgeblendet, im Bleeding-Edge-Kanal sichtbar, aktiv immer sichtbar', () => {
  const configPath = setup();
  const ctx = (updateChannel, manufacturer = 'victron') => ({
    getConfigPath: () => configPath,
    getRawCfg: () => ({ updateChannel, manufacturer }),
  });
  const values = (c) => listManufacturerProfiles(c).map((o) => o.value);
  assert.ok(!values(ctx('stable')).includes(ID), 'stable: ausgeblendet');
  const dev = listManufacturerProfiles(ctx('dev')).find((o) => o.value === ID);
  assert.ok(dev, 'dev: sichtbar');
  assert.equal(dev.beta, true);
  assert.match(dev.label, /HP3.*nur Anzeige/);
  assert.ok(values(ctx('stable', ID)).includes(ID), 'aktives Profil fällt nie aus der Liste');
});
