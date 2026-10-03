import test from 'node:test';
import assert from 'node:assert/strict';
import { reserveHeaterLoad } from '../services/devices/heater-load-reservation.js';

const HOUR = 3_600_000;
const DAY0 = Date.UTC(2026, 9, 4, 0); // 2026-10-04 00:00 UTC
const localDateOf = (ms) => new Date(ms).toISOString().slice(0, 10); // Test: UTC = lokal
const hourly = (values, startMs = DAY0) => values.map((powerW, i) => ({ start: new Date(startMs + i * HOUR).toISOString(), powerW }));
const quarterly = (values, startMs = DAY0) => values.flatMap((powerW, i) => [0, 1, 2, 3].map((q) => ({ start: new Date(startMs + i * HOUR + q * 900_000).toISOString(), powerW })));

const LOAD = hourly(Array(24).fill(500));
// PV: 9–15 Uhr Überschuss, Spitze mittags.
const PV_W = Array(24).fill(0); [9, 10, 11, 12, 13, 14, 15].forEach((h, i) => { PV_W[h] = [1500, 3000, 5000, 6000, 5000, 3000, 1500][i]; });
const HEATER = { id: 'Heizstaab', maxPowerW: 3000, minPowerW: 0, capacityWh: 8000 };

test('reserviert die Tagesmenge in Überschuss-Stunden, höchstens Überschuss und Maximalleistung', () => {
  const r = reserveHeaterLoad({ loadSlots: LOAD, pvSlots: quarterly(PV_W), heaters: [HEATER], localDateOf, nowMs: DAY0 });
  assert.equal(r.reservedWh, 8000);
  assert.deepEqual(r.byDay, { '2026-10-04': 8000 });
  const heater = r.slots.map((s) => s.heaterW || 0);
  // Ohne Preise: Stunden mit dem meisten Überschuss zuerst (12, 11, 13 je 3000 → 9000 > 8000).
  assert.equal(heater[12], 3000);
  assert.equal(heater[11] + heater[13], 5000, 'Rest auf die nächstbesten Stunden');
  assert.equal(heater.reduce((a, b) => a + b, 0), 8000);
  assert.equal(heater[3], 0, 'nachts nichts');
  for (let h = 0; h < 24; h++) {
    assert.ok(heater[h] <= 3000, 'nie über Maximalleistung');
    assert.ok(heater[h] <= Math.max(0, PV_W[h] - 500), `nie über dem Überschuss (Stunde ${h})`);
    assert.equal(r.slots[h].powerW, 500 + heater[h], 'Last = Grundlast + Heizstab');
  }
  assert.equal(LOAD[12].powerW, 500, 'Eingabe bleibt unverändert');
});

test('niedrigster Einspeisewert zuerst', () => {
  const feedIn = Array(24).fill(10); feedIn[10] = 2; feedIn[14] = 1; feedIn[12] = 12;
  const r = reserveHeaterLoad({ loadSlots: LOAD, pvSlots: quarterly(PV_W), feedInSlots: quarterly(feedIn), heaters: [{ ...HEATER, capacityWh: 4000 }], localDateOf, nowMs: DAY0 });
  const heater = r.slots.map((s) => s.heaterW || 0);
  assert.equal(heater[14], 2500, 'billigste Stunde zuerst, begrenzt durch den Überschuss (3000 − 500)');
  assert.equal(heater[10], 1500, 'dann die zweitbilligste: Rest der Tagesmenge');
  assert.equal(heater[12], 0, 'die teuerste Stunde bleibt für die Einspeisung');
});

test('heute schon gelieferte Energie zählt, morgen gibt es wieder die volle Menge', () => {
  const load = hourly(Array(48).fill(500));
  const pv = quarterly([...PV_W, ...PV_W]);
  const r = reserveHeaterLoad({
    loadSlots: load, pvSlots: pv, heaters: [HEATER], localDateOf, nowMs: DAY0 + 11 * HOUR + 20 * 60_000,
    deliveredToday: { Heizstaab: { date: '2026-10-04', wh: 6500 } }
  });
  assert.deepEqual(r.byDay, { '2026-10-04': 1500, '2026-10-05': 8000 });
  const heater = r.slots.map((s) => s.heaterW || 0);
  assert.equal(heater.slice(0, 11).reduce((a, b) => a + b, 0), 0, 'vergangene Stunden bleiben unberührt');
});

test('gestriger Zählerstand gilt nicht für heute', () => {
  const r = reserveHeaterLoad({ loadSlots: LOAD, pvSlots: quarterly(PV_W), heaters: [HEATER], localDateOf, nowMs: DAY0, deliveredToday: { Heizstaab: { date: '2026-10-03', wh: 7000 } } });
  assert.equal(r.reservedWh, 8000);
});

test('keine Vorhaltung ohne Tagesmenge, ohne Überschuss oder ohne Heizstab', () => {
  const pv = quarterly(PV_W);
  assert.equal(reserveHeaterLoad({ loadSlots: LOAD, pvSlots: pv, heaters: [{ id: 'h', maxPowerW: 3000 }], localDateOf, nowMs: DAY0 }).reservedWh, 0);
  assert.equal(reserveHeaterLoad({ loadSlots: LOAD, pvSlots: quarterly(Array(24).fill(100)), heaters: [HEATER], localDateOf, nowMs: DAY0 }).reservedWh, 0);
  assert.equal(reserveHeaterLoad({ loadSlots: LOAD, pvSlots: pv, heaters: [], localDateOf, nowMs: DAY0 }).reservedWh, 0);
  assert.deepEqual(reserveHeaterLoad({ loadSlots: [], pvSlots: pv, heaters: [HEATER], localDateOf, nowMs: DAY0 }).slots, []);
});

test('Mindestleistung: Stunden mit zu wenig Überschuss werden übersprungen', () => {
  const r = reserveHeaterLoad({ loadSlots: LOAD, pvSlots: quarterly(PV_W), heaters: [{ ...HEATER, minPowerW: 2000 }], localDateOf, nowMs: DAY0 });
  const heater = r.slots.map((s) => s.heaterW || 0);
  assert.equal(heater[9], 0, '1000 W Überschuss < 2000 W Mindestleistung');
  assert.ok(heater.every((w) => w === 0 || w >= 2000));
});

test('zwei Heizstäbe teilen sich den Überschuss, keiner bekommt denselben doppelt', () => {
  const r = reserveHeaterLoad({ loadSlots: LOAD, pvSlots: quarterly(PV_W), heaters: [HEATER, { id: 'zweiter', maxPowerW: 2000, capacityWh: 3000 }], localDateOf, nowMs: DAY0 });
  assert.equal(r.reservedWh, 11000);
  r.slots.forEach((s, h) => assert.ok((s.heaterW || 0) <= Math.max(0, PV_W[h] - 500) + 1e-9, `Stunde ${h}`));
});
