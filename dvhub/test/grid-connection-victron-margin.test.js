// test/grid-connection-victron-margin.test.js — Christin 07.11.2026 zur
// Victron-Grenze (Reg. 2714): „lass die Victron-Grenze als Grenze und ziehe
// nicht 1 kW ab, da ist schon ein Puffer, evtl. kann Victron auch weniger als
// der Anschluss.“
//  - Quelle Victron: kein Sicherheitsabstand, weder gesamt noch je Phase.
//  - Gesamt-kW aus 2714 mit den gemessenen Phasenspannungen (state.victron.
//    gridVoltage, nur frisch), sonst 230 V; je Phase gilt der Strom.
//  - Gewinnt die DVhub-Einstellung, bleibt deren Abstand.
//  - EOS bekommt den wirksamen Wert; Leitstand nennt „kein Abstand (Victron-Grenze)“.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  resolveGridConnection, victronLimitExtra, createGuardState, guardStep,
  createGridConnectionGuard, eosGridImportLimitW, eosGridChargeCapW
} from '../services/grid-connection/index.js';
import { buildEosInverters } from '../services/optimizer/eos-config-sync.js';
import { getConfigDefinition } from '../config-model.js';

const NOW = 1_800_000_000_000;
const vState = (a, gv = null) => ({
  victron: { acInputLimitA: a, fieldUpdatedAt: { acInputLimitA: NOW }, errors: {}, ...(gv ? { gridVoltage: gv } : {}) }
});

test('Quelle Victron: kein Abstand, Ziel = Victron-Grenze (gesamt und je Phase)', () => {
  const r = resolveGridConnection({ gridConnection: { limitKw: 29 } }, { victronPhaseLimitA: 40 });
  assert.equal(r.limitSource, 'victron');
  assert.equal(r.limitW, 27600);
  assert.equal(r.marginW, 0);
  assert.equal(r.targetW, 27600);
  assert.equal(r.phaseMarginW, 0);
  assert.equal(r.phaseTargetW, 9200);
});

test('Quelle Victron: gemessene Phasenspannungen statt 230 V', () => {
  const r = resolveGridConnection({}, { victronPhaseLimitA: 40, phaseVoltagesV: [235, 240, 228] });
  // 40 × 703 V = 28 120 W, auf 100 W abgerundet (Fable R1 P2-4).
  assert.equal(r.limitW, 28100);
  assert.equal(r.targetW, r.limitW);
  assert.deepEqual(r.phaseLimitsW, [9400, 9600, 9120]);
  assert.deepEqual(r.phaseTargetsW, [9400, 9600, 9120]);
  assert.equal(r.phaseTargetW, 9120, 'strengste Phase');
});

test('Spannung nur frisch und plausibel, sonst 230 V je Phase', () => {
  const fresh = victronLimitExtra(vState(40, { l1: 235, l2: null, l3: 400, updatedAt: NOW - 10_000 }), NOW, { manufacturer: 'victron' });
  assert.deepEqual(fresh.phaseVoltagesV, [235, null, null]);
  const r = resolveGridConnection({}, fresh);
  assert.deepEqual(r.phaseLimitsW, [9400, 9200, 9200]);
  const stale = victronLimitExtra(vState(40, { l1: 235, l2: 236, l3: 237, updatedAt: NOW - 3 * 60_000 }), NOW, { manufacturer: 'victron' });
  assert.equal(stale.phaseVoltagesV, null);
  assert.equal(resolveGridConnection({}, stale).limitW, 27600);
});

test('DVhub-Grenze strenger: deren Abstand bleibt; Phase von Victron ohne Abstand', () => {
  const r = resolveGridConnection({ gridConnection: { limitKw: 20 } }, { victronPhaseLimitA: 40 });
  assert.equal(r.limitSource, 'dvhub');
  assert.equal(r.marginW, 1000);
  assert.equal(r.targetW, 19000);
  assert.equal(r.phaseMarginW, 0);
  assert.equal(r.phaseTargetW, 9200);
});

test('DVhub-Phasengrenze strenger: deren Abstand bleibt je Phase', () => {
  const r = resolveGridConnection({ gridConnection: { limitKw: 29, phaseLimitA: 35 } }, { victronPhaseLimitA: 40 });
  assert.equal(r.limitSource, 'victron');
  assert.equal(r.marginW, 0);
  assert.equal(r.phaseLimitA, 35);
  assert.equal(r.phaseMarginW, 333);
  assert.equal(r.phaseTargetW, 35 * 230 - 333);
});

test('ohne Victron unverändert: DVhub 29 kW → Ziel 28 kW, Phase 40 A → 8 867 W', () => {
  const r = resolveGridConnection({ gridConnection: { limitKw: 29, phaseLimitA: 40 } });
  assert.equal(r.targetW, 28000);
  assert.equal(r.phaseTargetW, 8867);
});

test('Wächter je Phase gegen A × gemessene Spannung', () => {
  // L1 bei 245 V: 40 A = 9 800 W → 9 500 W auf L1 ist KEINE Überlast.
  const hi = resolveGridConnection({}, { victronPhaseLimitA: 40, phaseVoltagesV: [245, 230, 230] });
  const st = createGuardState();
  const wb = { id: 'wallbox', kind: 'wallbox', name: 'Wallbox', currentW: 7000, maxW: 11000, minW: 4140, phases: 1 };
  for (let i = 0; i < 4; i += 1) {
    guardStep(st, { resolved: hi, now: NOW + i * 2000, meas: { fresh: true, importW: 17000, phasesW: [9500, 4000, 3500] }, devices: [wb], battery: {} });
  }
  assert.equal(st.caps.wallbox ?? null, null, 'nicht gedeckelt');
  // L1 bei 220 V: 40 A = 8 800 W → 9 000 W ist Überlast (mit starr 230 V nicht).
  const lo = resolveGridConnection({}, { victronPhaseLimitA: 40, phaseVoltagesV: [220, 230, 230] });
  const st2 = createGuardState();
  guardStep(st2, { resolved: lo, now: NOW, meas: { fresh: true, importW: 16500, phasesW: [9000, 4000, 3500] }, devices: [wb], battery: {} });
  assert.ok(st2.caps.wallbox != null, 'sofort gedeckelt (harte Überschreitung)');
});

test('EOS bekommt bei Victron-Quelle die Grenze ohne Abzug', () => {
  const cfg = { gridConnection: { limitKw: 29 }, optimizer: { allowGridCharge: true, mispel: { mode: 'pauschal' }, maxChargeW: 27000 } };
  assert.equal(eosGridImportLimitW(cfg, { victronPhaseLimitA: 40 }), 27600);
  assert.equal(eosGridChargeCapW(cfg, { victronPhaseLimitA: 40 }), 26600);
  const inv = buildEosInverters(cfg, { gridImportLimitSupported: true, gridConnectionExtra: { victronPhaseLimitA: 40 } })[0];
  assert.equal(inv.max_grid_import_power_w, 27600);
});

test('Spannungsschwankung ist keine Grenzänderung (kein Log, kein EOS-Neuabgleich)', () => {
  const logs = [];
  let syncs = 0;
  let t = NOW;
  const state = { meter: { ok: true, updatedAt: t, grid_total_w: -5000 }, ...vState(40, { l1: 231, l2: 232, l3: 233, updatedAt: t }), schedule: {}, ctrl: {} };
  const guard = createGridConnectionGuard({
    getCfg: () => ({}), state, now: () => t, pushLog: (type) => logs.push(type),
    eosConfigSync: { sync: async () => { syncs += 1; } }
  });
  guard.tick();
  for (let i = 1; i <= 5; i += 1) {
    t += 61_000;
    state.meter.updatedAt = t;
    state.victron.fieldUpdatedAt.acInputLimitA = t;
    state.victron.gridVoltage = { l1: 231 + i * 0.3, l2: 232 - i * 0.2, l3: 233, updatedAt: t };
    guard.tick();
  }
  assert.equal(logs.filter((x) => x === 'grid_connection_limit_changed').length, 0);
  assert.equal(syncs, 0);
});

test('Leitstand: „kein Abstand (Victron-Grenze)“', () => {
  const state = { meter: { ok: true, updatedAt: NOW, grid_total_w: -5000 }, ...vState(40), schedule: {}, ctrl: {} };
  const guard = createGridConnectionGuard({ getCfg: () => ({ gridConnection: { limitKw: 29 } }), state, now: () => NOW, pushLog: () => {} });
  guard.tick();
  const s = guard.summary();
  assert.equal(s.marginW, 0);
  assert.equal(s.marginText, 'kein Abstand (Victron-Grenze)');
  const file = fileURLToPath(new URL('../public/grid-connection-view.js', import.meta.url));
  const sandbox = { window: {}, document: undefined };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox);
  const v = sandbox.window.DVhubGridConnection.view({ ...s, enabled: true });
  assert.match(v.limit, /kein Abstand \(Victron-Grenze\)/);
});

test('Einstellungen: Hilfe zum Abstand nennt die Victron-Ausnahme', () => {
  const f = getConfigDefinition().fields.find((x) => x.path === 'gridConnection.marginW');
  assert.ok(f, 'Feld vorhanden');
  assert.match(f.help, /kein Abstand \(Victron-Grenze\)/);
});
