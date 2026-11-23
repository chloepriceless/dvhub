// test/peak-shaving-native-lever.test.js — Peak Shaving P5 (Christin 24.11.2026): Sungrow und MQTT-Bridge/DVhub-MQTT
// über den vorhandenen Hebel (resolveBatteryLever: Netz-Sollwert bzw. Entladegrenze).
//
// Ausgelieferte Profile über loadConfigFile. Der Dienst fordert beim Netzanschluss-Wächter Akku-Hilfe an
// (Quelle 'peak-shaving', höchster Netzbezug = Regelziel); der Wächter senkt damit die Sollwert-Decke bzw. hebt die
// Entladegrenze an — derselbe, für §14a und die EOS-Schwelle schon geprüfte Weg. Die Victron-Wege im Steuerpfad
// bleiben für diese Hebel aus.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfigFile } from '../config-model.js';
import { resolvePeakShaving, createPeakShaving } from '../services/peak-shaving/index.js';
import { createGridConnectionGuard } from '../services/grid-connection/index.js';
import { quarterHourSlot } from '../services/peak-shaving/budget.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadProfileConfig(manufacturer, persisted = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-ps-native-'));
  fs.mkdirSync(path.join(rootDir, 'hersteller'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'hersteller', `${manufacturer}.json`), path.join(rootDir, 'hersteller', `${manufacturer}.json`));
  const configPath = path.join(rootDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ manufacturer, updateChannel: 'dev', victron: { host: '192.0.2.10' }, ...persisted }));
  const loaded = loadConfigFile(configPath);
  if (loaded.manufacturerProfileError) throw new Error(loaded.manufacturerProfileError);
  return loaded.effectiveConfig;
}

const PS = { peakShaving: { enabled: true, gridImportLimitW: 10000, marginW: 300, billing15min: false } };

test('Hebel je Profil: Victron, Sungrow/MQTT nativ, Fronius ohne Hebel', () => {
  assert.equal(resolvePeakShaving(loadProfileConfig('victron', PS)).lever, 'victron');
  for (const m of ['sungrow', 'bridge-mqtt', 'dvhub-mqtt']) {
    const r = resolvePeakShaving(loadProfileConfig(m, PS));
    assert.equal(r.lever, 'native', m);
    assert.equal(r.active, true, m);
    assert.match(r.leverText, /Akku zuerst/, m);
  }
  const f = resolvePeakShaving(loadProfileConfig('fronius', PS));
  assert.equal(f.lever, 'none');
  assert.equal(f.reason, 'manufacturer_unsupported');
});

function makeState({ importW = 14000, soc = 60 } = {}) {
  const now = Date.now();
  return {
    victron: {
      soc, batteryPowerW: 0, batteryDischargeW: 0, batteryChargeW: 0, gridImportW: importW,
      fieldUpdatedAt: { soc: now, batteryPowerW: now, selfConsumptionW: now }, errors: {}
    },
    meter: { ok: true, updatedAt: now, grid_total_w: -importW },
    schedule: { rules: [], lastWrite: {} },
    ctrl: {}
  };
}

for (const m of ['sungrow', 'bridge-mqtt']) {
  test(`${m}: Dienst fordert Akku-Hilfe mit Bezug höchstens 9 700 W an; Wächter nimmt sie an (Hebel nativ)`, () => {
    const cfg = loadProfileConfig(m, PS);
    const state = makeState();
    const logs = [];
    const ctx = { state, getCfg: () => cfg, pushLog: (e, p) => logs.push({ e, p }) };
    ctx.gridConnection = createGridConnectionGuard(ctx);
    ctx.batteryAssist = ctx.gridConnection.batteryAssist;
    const ps = createPeakShaving(ctx);
    ps.pollTick();
    const st = ctx.batteryAssist.status('peak-shaving');
    assert.equal(st.active, true, JSON.stringify(st));
    assert.equal(st.kind, 'native');
    assert.equal(st.sourceTargetW, 9700);
    assert.equal(state.ctrl._peakShaving.assist.requested, true);
    // Netz-Sollwert-Profile: Decke für positive Sollwerte = 9 700 W (mit Netzanschluss-Abrundung auf 100 W)
    assert.equal(ctx.gridConnection.batteryCeilingW(), 9700);
    assert.ok(logs.some((l) => l.e === 'peak_shaving_assist' && l.p.requested === true));
    // Summary zeigt den Hebel
    const s = ps.summary();
    assert.equal(s.lever, 'native');
    assert.equal(s.assist.maxImportW, 9700);
  });
}

test('Peak Shaving aus → Anforderung wird zurückgenommen', () => {
  const cfg = loadProfileConfig('bridge-mqtt', PS);
  const state = makeState();
  const ctx = { state, getCfg: () => cfg, pushLog: () => {} };
  ctx.gridConnection = createGridConnectionGuard(ctx);
  ctx.batteryAssist = ctx.gridConnection.batteryAssist;
  const ps = createPeakShaving(ctx);
  ps.pollTick();
  assert.equal(ctx.batteryAssist.status('peak-shaving').active, true);
  cfg.peakShaving.enabled = false;
  ps.pollTick();
  assert.equal(ctx.batteryAssist.status('peak-shaving').active, false);
  assert.equal(state.ctrl._peakShaving.assist, null);
});

test('Not-Halt: keine Anforderung (Wächter lehnt ab), kein Write durch Peak Shaving', () => {
  const cfg = loadProfileConfig('bridge-mqtt', PS);
  const state = makeState();
  state.ctrl.discretionaryWritesPaused = true;
  const ctx = { state, getCfg: () => cfg, pushLog: () => {} };
  ctx.gridConnection = createGridConnectionGuard(ctx);
  ctx.batteryAssist = ctx.gridConnection.batteryAssist;
  const ps = createPeakShaving(ctx);
  ps.pollTick();
  assert.equal(state.ctrl._peakShaving.assist.requested, false);
  assert.equal(state.ctrl._peakShaving.assist.reason, 'emergency_stop');
  assert.equal(ctx.batteryAssist.status('peak-shaving').active, false);
});

test('Victron: Dienst fordert KEINE Akku-Hilfe an (Victron regelt im Steuerpfad wie bisher)', () => {
  const cfg = loadProfileConfig('victron', PS);
  const requests = [];
  const ctx = { state: makeState(), getCfg: () => cfg, pushLog: () => {}, batteryAssist: { request: (q) => { requests.push(q); return { ok: true }; }, release: () => {} } };
  createPeakShaving(ctx).pollTick();
  assert.equal(requests.length, 0);
});

test('Budget gilt auch für den nativen Hebel: erlaubte Restleistung als höchster Bezug', () => {
  const cfg = loadProfileConfig('bridge-mqtt', { peakShaving: { ...PS.peakShaving, billing15min: true }, system: { power: { batteryMaxDischargeDcW: 10000 } } });
  const requests = [];
  const state = makeState({ importW: 5000 });
  // Viertelstundenanfang in der Vergangenheit: die echten Messwert-Stempel sind für den Dienst frisch.
  const clock = { wall: quarterHourSlot(Date.now() - 20 * 60_000, 'Europe/Berlin').startMs, mono: 0 };
  const ctx = { state, getCfg: () => cfg, pushLog: () => {}, batteryAssist: { request: (q) => { requests.push(q); return { ok: true }; }, release: () => {}, status: () => ({}) } };
  const ps = createPeakShaving(ctx, { now: () => clock.wall, monoNow: () => clock.mono });
  for (let i = 0; i < 150; i += 1) { clock.wall += 2000; clock.mono += 2000; ps.pollTick(); }
  // 5 min mit 5 kW → erlaubt (9 700 × 900 − 1 500 000) / 600 = 12 050 W → 12 000 W
  const last = requests.at(-1);
  assert.equal(last.source, 'peak-shaving');
  assert.equal(last.maxImportW, 12000, JSON.stringify(ps.control().budget));
});
