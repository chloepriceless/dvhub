import test from 'node:test';
import assert from 'node:assert/strict';
import { getConfigDefinition } from '../config-model.js';

test('Einstellungen: jede Gruppe gehört zu genau einem der sieben Bereiche', () => {
  const def = getConfigDefinition();
  assert.deepEqual(def.areas.map((a) => a.label), ['Meine Anlage', 'Strompreise', 'Betriebsart', 'Geräte', 'Netz & Recht', 'Prognosen', 'System']);
  const placed = def.areas.flatMap((a) => [...a.groups, ...a.advanced]);
  assert.equal(new Set(placed).size, placed.length, 'keine Gruppe doppelt');
  const used = new Set(def.fields.map((f) => f.group || 'main'));
  for (const g of used) assert.equal(placed.includes(g), true, `Gruppe ${g} hat keinen Bereich`);
  for (const g of placed) assert.equal(used.has(g), true, `Bereich nennt unbekannte Gruppe ${g}`);
});

test('Einstellungen: Reserve und Zeitzone stehen dort, wo man sie sucht', () => {
  const def = getConfigDefinition();
  const areaOf = (group) => def.areas.find((a) => a.groups.includes(group) || a.advanced.includes(group))?.id;
  const groupOf = (path) => def.fields.find((f) => f.path === path).group;
  assert.equal(areaOf(groupOf('schedule.smallMarketAutomation.minSocPct')), 'mode');
  assert.equal(areaOf(groupOf('schedule.timezone')), 'sys');
  assert.equal(areaOf(groupOf('optimizer.allowGridCharge')), 'grid');
  assert.equal(areaOf(groupOf('optimizer.batteryCapacityWh')), 'plant');
  assert.equal(areaOf(groupOf('userEnergyPricing.mode')), 'prices');
});

test('Betriebsart-Schalter: drei Stellungen, jede Gruppe des Schalters liegt im Bereich', () => {
  const area = getConfigDefinition().areas.find((a) => a.id === 'mode');
  assert.deepEqual(area.modeSwitch.positions.map((p) => p.id), ['off', 'sma', 'eos']);
  const inArea = new Set([...area.groups, ...area.advanced]);
  for (const g of [...area.modeSwitch.groups.sma, ...area.modeSwitch.groups.eos]) assert.equal(inArea.has(g), true, g);
});
