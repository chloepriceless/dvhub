// test/peak-shaving-builtin.test.js — Peak Shaving P5 (Christin 24.11.2026): eingebaute Peak-Shaving-Funktion in
// JEDEM passenden Herstellerprofil, ungetestet gekennzeichnet, standardmäßig AUS, nur über das Schreibtor, nur bei
// aktivem Peak Shaving; nie andere Register. Ausgelieferte Profile über loadConfigFile, echtes Legacy-Tor, Modbus-
// Attrappe mit Registerspeicher.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfigFile } from '../config-model.js';
import { resolvePeakShaving, builtinSpecValid } from '../services/peak-shaving/index.js';
import { createBuiltinPeakShaving, BUILTIN_MIN_WRITE_INTERVAL_MS, encodeLimit } from '../services/peak-shaving/builtin.js';
import { createLegacyGate } from '../services/gate/legacy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILTIN_PROFILES = {
  'deye-lv': { limit: 191 }, 'deye-hp3': { limit: 191 }, 'goodwe-et': { limit: 47542, reserveSoc: 47544 },
  'growatt-sph': { limit: 3307, reserveSoc: 3310 }, solis: { mode: 43110 }, sofar: { mode: 4368 }, 'solax-g4': { mode: 31 }
};

function loadProfileConfig(manufacturer, persisted = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-ps-builtin-'));
  fs.mkdirSync(path.join(rootDir, 'hersteller'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'hersteller', `${manufacturer}.json`), path.join(rootDir, 'hersteller', `${manufacturer}.json`));
  const configPath = path.join(rootDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ manufacturer, updateChannel: 'dev', victron: { host: '192.0.2.10' }, ...persisted }));
  const loaded = loadConfigFile(configPath);
  if (loaded.manufacturerProfileError) throw new Error(loaded.manufacturerProfileError);
  return { cfg: loaded.effectiveConfig, rootDir };
}

const PS = (builtin = {}) => ({ peakShaving: { enabled: true, gridImportLimitW: 10000, marginW: 300, billing15min: false, builtin: { enabled: false, ...builtin } } });

test('jedes passende Profil trägt den Block: Quelle, „ungetestet“, nur die recherchierten Adressen', () => {
  for (const [m, addr] of Object.entries(BUILTIN_PROFILES)) {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hersteller', `${m}.json`), 'utf8'));
    const b = raw.peakShavingBuiltin;
    assert.ok(builtinSpecValid(b), m);
    assert.equal(b.status, 'ungetestet', m);
    assert.match(b.source, /research\/2026-11-15-.*-modbus-control-spec\.md/, m);
    assert.match(b._doc.join(' '), /UNGETESTET/, m);
    for (const k of ['limit', 'mode', 'reserveSoc']) assert.equal(b[k]?.address ?? undefined, addr[k], `${m}.${k}`);
  }
  // Profile ohne recherchierte Funktion tragen keinen Block
  for (const m of ['victron', 'sungrow', 'fronius', 'deye-lp1', 'huawei-sun2000', 'sma-speedwire']) {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hersteller', `${m}.json`), 'utf8'));
    assert.equal(raw.peakShavingBuiltin, undefined, m);
  }
});

test('Nur-Lese-Profile bleiben Nur-Lese-Profile (controlWrite leer); Hebel ab Werk „eingebaut, aus“', () => {
  for (const m of Object.keys(BUILTIN_PROFILES)) {
    const { cfg } = loadProfileConfig(m, PS());
    assert.ok(cfg.peakShavingBuiltin, `${m}: Block in der wirksamen Config`);
    const r = resolvePeakShaving(cfg);
    assert.equal(r.lever, 'builtin_off', m);
    assert.equal(r.active, false, m);
    assert.equal(r.reason, 'builtin_disabled', m);
    const on = resolvePeakShaving({ ...cfg, peakShaving: { ...cfg.peakShaving, builtin: { enabled: true } } });
    assert.equal(on.lever, 'builtin', m);
    assert.equal(on.active, true, m);
    assert.match(on.leverText, /ungetestet/);
  }
  const { cfg: g } = loadProfileConfig('goodwe-et', PS());
  assert.deepEqual(g.controlWrite, {}, 'readOnly leert weiter controlWrite');
});

function registerTransport(registers = {}, { failReads = false } = {}) {
  return {
    type: 'modbus', writes: [], reads: [], registers: { ...registers },
    async mbRequest({ address, quantity = 1, fc }) {
      this.reads.push({ fc, address, quantity });
      if (failReads) throw new Error('modbus exception 2');
      const out = [];
      for (let i = 0; i < quantity; i += 1) {
        const v = this.registers[address + i];
        if (v === undefined) throw new Error(`no response for register ${address + i}`);
        out.push(v);
      }
      return out;
    },
    async mbWriteSingle({ address, value }) { this.writes.push({ fc: 6, address, value }); this.registers[address] = value; },
    async mbWriteMultiple({ address, values }) { this.writes.push({ fc: 16, address, values }); values.forEach((v, i) => { this.registers[address + i] = v; }); }
  };
}

function rig(manufacturer, persisted, registers, opts = {}) {
  const { cfg, rootDir } = loadProfileConfig(manufacturer, persisted);
  const state = { ctrl: {}, victron: {} };
  const transport = registerTransport(registers, opts);
  const gate = createLegacyGate({ isHalted: () => state.ctrl.discretionaryWritesPaused === true, isReadOnly: () => false });
  const clock = { mono: 0 };
  const logs = [];
  const act = createBuiltinPeakShaving({
    state, getCfg: () => cfg, transport, gate, pushLog: (e, p) => logs.push({ e, p }),
    statePath: path.join(rootDir, 'ps-builtin.json'), monoNow: () => clock.mono
  });
  return { cfg, state, transport, act, clock, logs, rootDir };
}

test('Schalter aus (Werk): kein Lesen, kein Write, kein Zustand', async () => {
  const { act, transport, state } = rig('goodwe-et', PS(), { 47542: 0, 47543: 20000 });
  await act.tick();
  assert.deepEqual(transport.reads, []);
  assert.deepEqual(transport.writes, []);
  assert.equal(state.ctrl._peakShaving, undefined);
});

test('GoodWe an: Ist-Wert lesen und sichern, dann 47542–47543 = 9 700 W (U32, FC 16); Reserve nur mit Wert', async () => {
  const { act, transport, rootDir } = rig('goodwe-et', PS({ enabled: true }), { 47542: 0, 47543: 20000, 47544: 10 });
  await act.tick();
  assert.deepEqual(transport.reads.map((r) => [r.address, r.quantity]), [[47542, 2]]);
  assert.deepEqual(transport.writes, [{ fc: 16, address: 47542, values: [0, 9700] }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(rootDir, 'ps-builtin.json'), 'utf8')).limitRaw, 20000);
  // nie andere Register
  assert.ok(transport.writes.every((w) => [47542, 47544].includes(w.address)));
});

test('GoodWe: Reserve-SoC mit eingetragenem Wert einmal geschrieben und beim Ausschalten NICHT zurück (H-8); Grenze zurück', async () => {
  const persisted = PS({ enabled: true, reserveSocPct: 20 });
  const { act, transport, cfg } = rig('goodwe-et', persisted, { 47542: 0, 47543: 20000, 47544: 10 });
  await act.tick();
  assert.deepEqual(transport.writes.map((w) => w.address), [47542, 47544]);
  assert.equal(transport.registers[47544], 20);
  cfg.peakShaving.enabled = false;
  await act.tick();
  assert.deepEqual(transport.writes.at(-1), { fc: 16, address: 47542, values: [0, 20000] }, 'gesicherte Grenze zurück');
  assert.equal(transport.registers[47544], 20, 'Reserve bleibt');
  assert.equal(transport.writes.filter((w) => w.address === 47544).length, 1);
  // danach nichts mehr
  const n = transport.writes.length;
  await act.tick();
  assert.equal(transport.writes.length, n);
});

test('Deye HV: 10-W-Schritte (9 700 W → 970), FC 16', async () => {
  const { act, transport } = rig('deye-hp3', PS({ enabled: true }), { 191: 1200 });
  await act.tick();
  assert.deepEqual(transport.writes, [{ fc: 16, address: 191, values: [970] }]);
  assert.equal(encodeLimit({ scale: 10 }, 9700).raw, 970);
});

test('Solis: Bit 2048 per Lesen-Ändern-Schreiben (Self-Use 1 → 2049), Rücknahme auf 1', async () => {
  const { act, transport, cfg } = rig('solis', PS({ enabled: true }), { 43110: 1 });
  await act.tick();
  assert.deepEqual(transport.writes, [{ fc: 6, address: 43110, value: 2049 }]);
  cfg.peakShaving.builtin.enabled = false;
  await act.tick();
  assert.deepEqual(transport.writes.at(-1), { fc: 6, address: 43110, value: 1 });
});

test('SolaX G4: Betriebsart 0x1F = 4 per FC 16, Rücklesen aus 0x8B (Input)', async () => {
  const { act, transport } = rig('solax-g4', PS({ enabled: true }), { 139: 0 });
  await act.tick();
  assert.deepEqual(transport.reads[0], { fc: 4, address: 139, quantity: 1 });
  assert.deepEqual(transport.writes, [{ fc: 16, address: 31, values: [4] }]);
});

test('Ist-Wert nicht lesbar (Register fehlt, z. B. Growatt SPH ohne 3307): kein einziger Write', async () => {
  const { act, transport, logs } = rig('growatt-sph', PS({ enabled: true, reserveSocPct: 20 }), {}, { failReads: true });
  await act.tick();
  assert.deepEqual(transport.writes, []);
  assert.ok(logs.some((l) => l.e === 'peak_shaving_builtin_error'));
});

test('Not-Halt: keine Writes — weder Einstellen noch Rücknahme; danach Rücknahme, wenn Peak Shaving dann aus ist', async () => {
  const { act, transport, state, cfg } = rig('deye-lv', PS({ enabled: true }), { 191: 5000 });
  state.ctrl.discretionaryWritesPaused = true;
  await act.tick();
  assert.deepEqual(transport.writes, []);
  state.ctrl.discretionaryWritesPaused = false;
  await act.tick();
  assert.deepEqual(transport.writes, [{ fc: 16, address: 191, values: [9700] }]);
  state.ctrl.discretionaryWritesPaused = true;
  cfg.peakShaving.enabled = false;
  await act.tick();
  assert.equal(transport.writes.length, 1, 'im Not-Halt keine Rücknahme');
  state.ctrl.discretionaryWritesPaused = false;
  await act.tick();
  assert.deepEqual(transport.writes.at(-1), { fc: 16, address: 191, values: [5000] });
});

test('Flash schonen: neue Grenze frühestens 15 min nach dem letzten Write und erst ab 500 W Unterschied', async () => {
  const { act, transport, cfg, clock } = rig('deye-lv', PS({ enabled: true }), { 191: 5000 });
  await act.tick();
  assert.equal(transport.writes.length, 1);
  cfg.peakShaving.gridImportLimitW = 12000;   // Ziel 11 700 W
  clock.mono = 60_000;
  await act.tick();
  assert.equal(transport.writes.length, 1, 'innerhalb von 15 min nicht');
  clock.mono = BUILTIN_MIN_WRITE_INTERVAL_MS;
  await act.tick();
  assert.deepEqual(transport.writes.at(-1), { fc: 16, address: 191, values: [11700] });
  cfg.peakShaving.gridImportLimitW = 12200;   // Ziel 11 900 W: nur 200 W Unterschied
  clock.mono = 3 * BUILTIN_MIN_WRITE_INTERVAL_MS;
  await act.tick();
  assert.equal(transport.writes.length, 2, 'unter 500 W Unterschied kein Write');
});

test('Neustart: gesicherter Ist-Wert von der Platte → Rücknahme auch ohne eigenen Write in diesem Prozess', async () => {
  const first = rig('deye-lv', PS({ enabled: true }), { 191: 4200 });
  await first.act.tick();
  const statePath = path.join(first.rootDir, 'ps-builtin.json');
  first.cfg.peakShaving.enabled = false;
  const gate = createLegacyGate({ isHalted: () => false, isReadOnly: () => false });
  const act2 = createBuiltinPeakShaving({ state: { ctrl: {} }, getCfg: () => first.cfg, transport: first.transport, gate, statePath });
  await act2.tick();
  assert.deepEqual(first.transport.writes.at(-1), { fc: 16, address: 191, values: [4200] });
  assert.equal(fs.existsSync(statePath), false);
});

test('Gerät nicht freigegeben (Bestandsprüfung C2/identify): nichts', async () => {
  const { cfg, rootDir } = loadProfileConfig('deye-lv', PS({ enabled: true }));
  const transport = registerTransport({ 191: 5000 });
  const act = createBuiltinPeakShaving({
    state: { ctrl: {} }, getCfg: () => cfg, transport, gate: createLegacyGate({ isHalted: () => false, isReadOnly: () => false }),
    deviceWriteGate: () => 'device_not_identified', statePath: path.join(rootDir, 'x.json')
  });
  await act.tick();
  assert.deepEqual(transport.reads, []);
  assert.deepEqual(transport.writes, []);
});

test('Codex e5a25ac1: Grenze abgerundet (Growatt 1-kW-Schritte: 10 500 W → 10, nie 11)', () => {
  assert.equal(encodeLimit({ scale: 1000 }, 10500).raw, 10);
  assert.equal(encodeLimit({ scale: 10 }, 9705).raw, 970);
});

test('Codex e5a25ac1: Sicherung gehört zum Gerät — nach Adresswechsel keine Rücknahme auf das neue Gerät', async () => {
  const { act, transport, cfg, logs } = rig('deye-lv', PS({ enabled: true }), { 191: 4200 });
  await act.tick();
  assert.equal(transport.writes.length, 1);
  cfg.victron = { ...cfg.victron, host: '192.0.2.99' };
  cfg.peakShaving.enabled = false;
  await act.tick();
  assert.equal(transport.writes.length, 1, 'kein Write auf das andere Gerät');
  assert.ok(logs.some((l) => l.e === 'peak_shaving_builtin_restore_skipped'));
});

test('Codex e5a25ac1: Sicherung nicht speicherbar → kein Write', async () => {
  const { cfg } = loadProfileConfig('deye-lv', PS({ enabled: true }));
  const transport = registerTransport({ 191: 4200 });
  const act = createBuiltinPeakShaving({
    state: { ctrl: {} }, getCfg: () => cfg, transport, gate: createLegacyGate({ isHalted: () => false, isReadOnly: () => false }),
    statePath: '/nonexistent-dir-dvhub-test/x/ps.json'
  });
  await act.tick();
  assert.deepEqual(transport.writes, []);
});

test('Codex e5a25ac1: Wert steht schon im Gerät → kein Flash-Write; Neustart hält den 15-min-Abstand', async () => {
  const already = rig('deye-lv', PS({ enabled: true }), { 191: 9700 });
  await already.act.tick();
  assert.deepEqual(already.transport.writes, []);
  const first = rig('deye-lv', PS({ enabled: true }), { 191: 4200 });
  await first.act.tick();
  assert.equal(first.transport.writes.length, 1);
  first.cfg.peakShaving.gridImportLimitW = 12000;
  const gate = createLegacyGate({ isHalted: () => false, isReadOnly: () => false });
  const act2 = createBuiltinPeakShaving({ state: { ctrl: {} }, getCfg: () => first.cfg, transport: first.transport, gate, statePath: path.join(first.rootDir, 'ps-builtin.json') });
  await act2.tick();
  assert.equal(first.transport.writes.length, 1, 'neuer Prozess schreibt nicht innerhalb von 15 min nach dem letzten Write');
});

test('Codex e5a25ac1: Status zeigt die gesetzte Grenze, ein gedrosselter neuer Wert ist pending', async () => {
  const { act, cfg, state } = rig('deye-lv', PS({ enabled: true }), { 191: 4200 });
  await act.tick();
  cfg.peakShaving.gridImportLimitW = 5000;
  await act.tick();
  assert.equal(state.ctrl._peakShaving.builtin.targetW, 9700);
  assert.equal(state.ctrl._peakShaving.builtin.pending, true);
  assert.equal(state.ctrl._peakShaving.builtin.requestedW, 4700);
  const m = rig('sofar', PS({ enabled: true }), { 4368: 0 });
  await m.act.tick();
  assert.equal(m.state.ctrl._peakShaving.builtin.targetW, null, 'reine Betriebsart: keine Watt-Grenze behaupten');
  assert.equal(m.state.ctrl._peakShaving.builtin.modeSet, true);
});

test('Codex 65c52509: Neustart in der Sperrzeit zeigt die gelesene Grenze und pending; kleine Änderung ist belowStep', async () => {
  const first = rig('deye-lv', PS({ enabled: true }), { 191: 4200 });
  await first.act.tick();
  first.cfg.peakShaving.gridImportLimitW = 5000;
  const state2 = { ctrl: {} };
  const act2 = createBuiltinPeakShaving({ state: state2, getCfg: () => first.cfg, transport: first.transport,
    gate: createLegacyGate({ isHalted: () => false, isReadOnly: () => false }), statePath: path.join(first.rootDir, 'ps-builtin.json') });
  await act2.tick();
  assert.equal(state2.ctrl._peakShaving.builtin.targetW, 9700);
  assert.equal(state2.ctrl._peakShaving.builtin.pending, true);
  const small = rig('deye-lv', PS({ enabled: true }), { 191: 4200 });
  await small.act.tick();
  small.cfg.peakShaving.gridImportLimitW = 10200;
  await small.act.tick();
  assert.equal(small.state.ctrl._peakShaving.builtin.pending, false);
  assert.equal(small.state.ctrl._peakShaving.builtin.belowStep, true);
});
