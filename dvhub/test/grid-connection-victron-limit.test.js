// test/grid-connection-victron-limit.test.js — Punkt 7 (Christin 07.11.2026):
// „Der Wert soll aus Victron ausgelesen werden, wenn das Victron-Profil
// eingestellt ist.“ Unit 100, Reg. 2714 /Settings/CGwacs/AcInputLimit „AC import
// limit when peakshaving“, int16, A je Phase, -1 = aus (Liste 3.70, live an
// ihrem GX gelesen: 40). Nur lesen, selten (60 s). Steht in DVhub zusätzlich ein
// Wert, gilt der strengere.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfigFile } from '../config-model.js';
import { createPoller } from '../polling.js';
import { buildVenusTopicMaps } from '../transport-mqtt.js';
import {
  resolveGridConnection, gridConnectionFromState, createGridConnectionGuard, eosGridImportLimitW, eosGridChargeCapW
} from '../services/grid-connection/index.js';
import { buildEosInverters } from '../services/optimizer/eos-config-sync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHIPPED = (name) => path.join(__dirname, '..', 'hersteller', `${name}.json`);

function loadProfile(name, extra = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-2714-'));
  fs.mkdirSync(path.join(rootDir, 'hersteller'), { recursive: true });
  fs.copyFileSync(SHIPPED(name), path.join(rootDir, 'hersteller', `${name}.json`));
  const configPath = path.join(rootDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ manufacturer: name, victron: { host: '192.0.2.10' }, ...extra }));
  return loadConfigFile(configPath).effectiveConfig;
}

function pollerFor(cfg, regs, { throwOn = null } = {}) {
  const state = {
    meter: { ok: false, updatedAt: 0, raw: [], grid_l1_w: 0, grid_l2_w: 0, grid_l3_w: 0, grid_total_w: 0, error: null },
    victron: { errors: {}, updatedAt: 0, fieldUpdatedAt: {} },
    dvRegs: new Array(8).fill(0),
    energy: { day: '2026-11-07', importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0, lastTs: 0 }
  };
  const reads = [];
  const transport = {
    type: 'modbus',
    async mbRequest(conf) {
      reads.push(Number(conf.address));
      if (throwOn === Number(conf.address)) throw new Error('modbus exception 2');
      const out = [];
      for (let i = 0; i < (conf.quantity ?? 1); i += 1) out.push(regs[Number(conf.address) + i] ?? 0);
      return out;
    },
    async mbWriteSingle() { throw new Error('nie schreiben'); },
    async mbWriteMultiple() { throw new Error('nie schreiben'); }
  };
  const poller = createPoller({
    state, getCfg: () => cfg, transport, pushLog: () => {},
    energyPath: path.join(os.tmpdir(), `victron-2714-${process.pid}.json`),
    onPollComplete: () => {}, epexNowNext: () => ({ current: { ct_kwh: 0 } })
  });
  return { poller, state, reads };
}

test('Victron-Profil liest Reg. 2714 (int16, A je Phase), nur lesend', async () => {
  const cfg = loadProfile('victron');
  assert.equal(cfg.points.acInputLimitA?.address, 2714);
  assert.equal(cfg.points.acInputLimitA?.signed, true);
  const { poller, state } = pollerFor(cfg, { 2714: 40 });
  await poller.requestPoll();
  assert.equal(state.victron.acInputLimitA, 40);
});

test('Reg. 2714 = -1 (aus) wird als -1 gelesen und gilt nicht als Grenze', async () => {
  const cfg = loadProfile('victron');
  const { poller, state } = pollerFor(cfg, { 2714: 0xffff });
  await poller.requestPoll();
  assert.equal(state.victron.acInputLimitA, -1);
  assert.equal(gridConnectionFromState({}, state).active, false);
});

test('Reg. 2714 nie lesbar: Fehler gemerkt, nur DVhub-Werte', async () => {
  const cfg = loadProfile('victron');
  const { poller, state } = pollerFor(cfg, {}, { throwOn: 2714 });
  await poller.requestPoll();
  assert.match(state.victron.errors.acInputLimitA, /exception/);
  const r = gridConnectionFromState({ gridConnection: { limitKw: 29 } }, state);
  assert.equal(r.limitW, 29000);
  assert.equal(r.victronReadError, true);
});

// Fable R1 P1-3 (10.11.2026): früher hob ein einzelner Lesefehler die
// Victron-Grenze sofort auf („kein Fail-safe“) — alle Deckel weg, Ziel sprang
// auf die DVhub-Grenze. Jetzt fail-safe: der letzte gültige Wert gilt bis
// VICTRON_LIMIT_MAX_AGE_MS nach der letzten erfolgreichen Lesung weiter.
test('Reg. 2714 einmal nicht lesbar: der letzte gelesene Wert gilt weiter (fail-safe)', async () => {
  const cfg = loadProfile('victron');
  const regs = { 2714: 40 };
  const p = pollerFor(cfg, regs);
  await p.poller.requestPoll();
  assert.equal(p.state.victron.acInputLimitA, 40);
  p.state.victron.errors.acInputLimitA = 'modbus exception 2'; // nächste Lesung scheitert
  const r = gridConnectionFromState({ gridConnection: { limitKw: 34.5 } }, p.state);
  assert.equal(r.limitW, 27600, 'Victron-Grenze bleibt');
  assert.equal(r.victronReadError, true, 'Lesefehler wird trotzdem gemeldet');
  assert.equal(gridConnectionFromState({}, p.state).active, true, 'nur Victron-Grenze: bleibt aktiv');
});

test('Reg. 2714 nur alle 60 s', async () => {
  const cfg = loadProfile('victron');
  const { poller, reads } = pollerFor(cfg, { 2714: 40 });
  await poller.requestPoll();
  await poller.requestPoll();
  assert.equal(reads.filter((a) => a === 2714).length, 1);
});

test('andere Profile lesen 2714 nicht', async () => {
  const cfg = loadProfile('fronius');
  assert.equal(cfg.points.acInputLimitA, undefined);
});

test('Venus-MQTT kennt das Topic', () => {
  const { READ_TOPICS } = buildVenusTopicMaps('c0ffee');
  assert.equal(READ_TOPICS.acInputLimitA, 'N/c0ffee/settings/0/Settings/CGwacs/AcInputLimit');
});

test('strengere Grenze gilt: Victron 40 A (≈ 27,6 kW) gegen DVhub 29 kW', () => {
  const r = resolveGridConnection({ gridConnection: { limitKw: 29 } }, { victronPhaseLimitA: 40 });
  assert.equal(r.limitW, 27600);
  assert.equal(r.phaseLimitA, 40);
  assert.equal(r.limitSource, 'victron');
  const r2 = resolveGridConnection({ gridConnection: { limitKw: 20 } }, { victronPhaseLimitA: 40 });
  assert.equal(r2.limitW, 20000);
  assert.equal(r2.limitSource, 'dvhub');
  assert.equal(r2.phaseLimitA, 40, 'Phasengrenze von Victron gilt trotzdem');
  const r3 = resolveGridConnection({}, { victronPhaseLimitA: 40 });
  assert.equal(r3.active, true, 'Victron allein reicht');
  assert.equal(r3.limitW, 27600);
  const r4 = resolveGridConnection({ gridConnection: { limitKw: 29, phaseLimitA: 35 } }, { victronPhaseLimitA: 40 });
  assert.equal(r4.phaseLimitA, 35);
});

test('Wächter nimmt den Victron-Wert, auch wenn er sich zur Laufzeit ändert; EOS bekommt den wirksamen Wert', () => {
  const t = Date.now();
  const cfg = { gridConnection: { limitKw: 29 } };
  const state = { meter: { ok: true, updatedAt: t, grid_total_w: -10000 }, victron: { acInputLimitA: 40, fieldUpdatedAt: { acInputLimitA: t }, errors: {} }, schedule: {}, ctrl: {} };
  const guard = createGridConnectionGuard({ getCfg: () => cfg, state, pushLog: () => {} });
  guard.tick();
  assert.equal(guard.summary().limitW, 27600);
  assert.match(guard.summary().limitText, /Victron: 40 A je Phase/);
  state.victron.acInputLimitA = 30;
  guard.tick();
  assert.equal(guard.summary().limitW, 20700);
  assert.equal(eosGridImportLimitW(cfg, { victronPhaseLimitA: 40 }), 27600, 'Victron-Grenze ohne Abstand');
  assert.equal(eosGridChargeCapW(cfg, { victronPhaseLimitA: 40 }), 26600);
  const inv = buildEosInverters({ ...cfg, optimizer: { allowGridCharge: true, mispel: { mode: 'pauschal' }, maxChargeW: 27000 } }, { gridImportLimitSupported: true, gridConnectionExtra: { victronPhaseLimitA: 40 } })[0];
  assert.equal(inv.max_grid_import_power_w, 27600);
});
