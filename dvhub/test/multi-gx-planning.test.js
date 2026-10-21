// test/multi-gx-planning.test.js -- EOS plant beide Akkus als einen (Chrissi
// 21.10.2026): Kapazitaet und Leistung addiert, Ladestand und Mindest-SoC nach
// Kapazitaet gewichtet. Ohne erreichbare zweite Anlage bleibt alles wie bisher
// (gleiches Objekt, keine Kopie).
import test from 'node:test';
import assert from 'node:assert/strict';
import { planningCfg, planningSocPct, planningMinSocPct } from '../services/multi-gx/planning.js';
import { buildEosBatteries, buildEosInverters } from '../services/optimizer/eos-config-sync.js';

function ctxWith({ follower = { online: true, socPct: 80 }, enabled = true } = {}) {
  const cfg = {
    updateChannel: 'dev',
    optimizer: { batteryCapacityWh: 64000, maxChargeW: 10000, maxDischargeW: 12000, hardFloorSocPct: 5 },
    system: { power: { inverterMaxPowerW: 15000 } },
    multiGx: { enabled, host: '192.168.1.20', batteryCapacityWh: 32000, maxChargeW: 5000, maxDischargeW: 6000, minSocPct: 20 },
  };
  const state = { victron: { soc: 50, minSocPct: 10 }, multiGx: { enabled, ...follower, minSocPct: 20 } };
  return { getCfg: () => cfg, state, cfg };
}

test('zweite Anlage erreichbar: EOS-Akku mit Summen', () => {
  const ctx = ctxWith();
  const cfg = planningCfg(ctx, ctx.cfg);
  const [b] = buildEosBatteries(cfg, { minSocPct: planningMinSocPct(ctx, 10) });
  assert.equal(b.capacity_wh, 96000);
  assert.equal(b.max_charge_power_w, 18000);
  assert.equal(b.min_soc_percentage, Number(((10 * 64000 + 20 * 32000) / 96000).toFixed(1)));
  const [inv] = buildEosInverters(cfg);
  assert.equal(inv.max_power_w, 21000);
  assert.equal(planningSocPct(ctx), 60);
  assert.equal(ctx.cfg.optimizer.batteryCapacityWh, 64000, 'Original-Config unveraendert');
});

test('zweite Anlage offline oder aus: alles wie bisher', () => {
  for (const ctx of [ctxWith({ follower: { online: false, socPct: null } }), ctxWith({ enabled: false })]) {
    assert.equal(planningCfg(ctx, ctx.cfg), ctx.cfg);
    assert.equal(planningSocPct(ctx), 50);
    assert.equal(planningMinSocPct(ctx, 10), 10);
  }
});

test('Stable-Kanal: Planung nur mit der Hauptanlage', () => {
  const ctx = ctxWith();
  ctx.cfg.updateChannel = 'stable';
  assert.equal(planningCfg(ctx, ctx.cfg), ctx.cfg);
  assert.equal(planningSocPct(ctx), 50);
});

test('ohne Dienst (aeltere Aufrufer, Tests): Hauptanlage', () => {
  const ctx = { getCfg: () => ({ optimizer: {} }), state: { victron: { soc: 42 } } };
  assert.equal(planningSocPct(ctx), 42);
  const cfg = ctx.getCfg();
  assert.equal(planningCfg(ctx, cfg), cfg);
});
