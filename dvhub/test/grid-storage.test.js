import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isGridChargeLicensed, isGridStorageOnly, gridImportW, createStandbyEstimator,
  resolveStandbyW, buildGridStorageSeries, STANDBY_FALLBACK_W
} from '../services/optimizer/grid-storage.js';

test('Netzladen: PV-Anlage braucht Schalter + MiSpeL, Netzspeicher nur den Schalter', () => {
  assert.equal(isGridChargeLicensed({ optimizer: { allowGridCharge: true } }), false);
  assert.equal(isGridChargeLicensed({ optimizer: { allowGridCharge: true, mispel: { mode: 'pauschal' } } }), true);
  assert.equal(isGridChargeLicensed({ optimizer: { allowGridCharge: true, mispel: { mode: 'abgrenzung' } } }), true);
  assert.equal(isGridChargeLicensed({ optimizer: { allowGridCharge: true, gridStorageOnly: true } }), true);
  assert.equal(isGridChargeLicensed({ optimizer: { gridStorageOnly: true } }), false);
  assert.equal(isGridStorageOnly({ optimizer: { gridStorageOnly: 'true' } }), false, 'nur echtes true');
});

test('Netzbezug aus dem Zählerwert, je nach Vorzeichenregel', () => {
  assert.equal(gridImportW(120, 'grid_import'), 120);
  assert.equal(gridImportW(-120, 'feed_in'), 120);
  assert.equal(gridImportW(undefined, 'feed_in'), null);
});

test('Ruhebedarf: Median des Netzbezugs, nur wenn der Akku ruht', () => {
  const est = createStandbyEstimator();
  assert.equal(est.estimateW(), null);
  for (let i = 0; i < 30; i++) est.sample({ importW: 80 + (i % 3) * 10, batteryPowerW: 20 });
  assert.equal(est.sample({ importW: 9000, batteryPowerW: 8800 }), false, 'Akku lädt');
  assert.equal(est.sample({ importW: -5000, batteryPowerW: 0 }), false, 'Einspeisung ist kein Ruhebedarf');
  assert.equal(est.sample({ importW: 90, batteryPowerW: null }), false, 'Akkuleistung unbekannt');
  assert.equal(est.estimateW(), 90);
});

test('Ruhebedarf für die Planung: fester Wert vor Messung vor 100 W', () => {
  const est = createStandbyEstimator();
  assert.deepEqual(resolveStandbyW({ optimizer: {} }, est), { watts: STANDBY_FALLBACK_W, source: 'fallback' });
  for (let i = 0; i < 25; i++) est.sample({ importW: 60, batteryPowerW: 0 });
  assert.deepEqual(resolveStandbyW({ optimizer: { gridStorageStandbyW: 0 } }, est), { watts: 60, source: 'measured' });
  assert.deepEqual(resolveStandbyW({ optimizer: { gridStorageStandbyW: 150 } }, est), { watts: 150, source: 'config' });
});

test('Reihen für EOS: PV 0 je Viertelstunde, Ruhebedarf je Stunde, über den Preiszeitraum', () => {
  const now = Date.parse('2026-10-06T10:20:00Z');
  const prices = [{ start: '2026-10-06T10:00:00Z' }, { start: '2026-10-07T21:45:00Z' }];
  const { pvSlots, loadSlots } = buildGridStorageSeries(prices, 120, now);
  assert.equal(loadSlots[0].start, '2026-10-06T08:00:00.000Z', 'zwei Stunden vor jetzt');
  assert.equal(loadSlots.at(-1).start, '2026-10-07T21:00:00.000Z');
  assert.equal(pvSlots.at(-1).start, '2026-10-07T21:45:00.000Z');
  assert.equal(pvSlots.length, loadSlots.length * 4);
  assert.equal(pvSlots.every((s) => s.powerW === 0), true);
  assert.equal(loadSlots.every((s) => s.powerW === 120), true);
  assert.deepEqual(buildGridStorageSeries([], 120, now), { pvSlots: [], loadSlots: [] });
});
