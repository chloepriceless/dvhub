import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlantBattery, withPlantBattery } from '../market-automation-builder.js';

test('Akku-Werte der Anlage gelten für die Kleine Börsenautomatik', () => {
  const cfg = { optimizer: { batteryCapacityWh: 77000, maxDischargeW: 27000, inverterMaxPowerW: 24000 } };
  assert.deepEqual(resolvePlantBattery(cfg), { capacityKwh: 77, maxDischargeW: 24000, efficiencyPct: null });
  const sma = withPlantBattery({ enabled: true, batteryCapacityKwh: 60, maxDischargeW: -22000, minSocPct: 30 }, cfg);
  assert.equal(sma.batteryCapacityKwh, 77);
  assert.equal(sma.maxDischargeW, -24000, 'negativ wie bisher, begrenzt durch den Wechselrichter');
  assert.equal(sma.minSocPct, 30, 'alles andere bleibt');
});

test('ohne Anlagenwerte gelten weiter die eigenen Werte der Automatik', () => {
  const sma = { batteryCapacityKwh: 30, maxDischargeW: -12000 };
  assert.deepEqual(resolvePlantBattery({}), { capacityKwh: null, maxDischargeW: null, efficiencyPct: null });
  assert.deepEqual(withPlantBattery(sma, { optimizer: {} }), sma);
  assert.equal(withPlantBattery(sma, { optimizer: { batteryCapacityWh: 10240 } }).batteryCapacityKwh, 10.24);
  assert.equal(withPlantBattery(sma, { optimizer: { batteryCapacityWh: 10240 } }).maxDischargeW, -12000);
  assert.equal(withPlantBattery(undefined, {}), undefined);
});

test('gemessener Wirkungsgrad (wie für EOS) ersetzt den eingetragenen der Automatik', () => {
  const cfg = { optimizer: { batteryCapacityWh: 77000, roundTripEfficiency: 0.9025 } };
  const curve = { referenceEta: 0.907 };
  assert.equal(resolvePlantBattery(cfg, curve).efficiencyPct, 86.2, '0,95 × 0,907');
  assert.equal(withPlantBattery({ inverterEfficiencyPct: 91 }, cfg, curve).inverterEfficiencyPct, 86.2);
  assert.equal(withPlantBattery({ inverterEfficiencyPct: 91 }, cfg, null).inverterEfficiencyPct, 91, 'ohne Messung bleibt der eingetragene Wert');
  assert.equal(resolvePlantBattery({ optimizer: {} }, { referenceEta: 0.907 }).efficiencyPct, 85.3, 'Akku-Standard 0,94');
});
