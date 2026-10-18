// test/mispel-calc.test.js — MiSpeL-Abrechnung aus Messwerten (Pauschaloption mit
// Rumpfjahren, Abgrenzungsoption Formelsatz A1). Erwartungswerte von Hand gerechnet;
// das Rumpfjahr-Beispiel ist das der BNetzA (Anlage 2, Abschnitt 9: 8 kWp,
// Speicher 10 → 15 kWh am 16.05.), Referenz R1 1.005/119/1.125, R2 2.995/134/3.128.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  daysInYear, periodDays, pauschalLimits, periodsForYear, plantForPeriod,
  sumPauschalSlots, pauschalYearEnd, abgrenzungMonths,
} from '../services/mispel/mispel-calc.js';

const close = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

test('Tage und Sommertage: Kalenderjahr, Schaltjahr, Rumpfjahre', () => {
  assert.equal(daysInYear(2026), 365);
  assert.equal(daysInYear(2028), 366);
  assert.deepEqual(periodDays('2026-01-01', '2026-12-31'), { tr: 365, trs: 183 });
  assert.deepEqual(periodDays('2028-01-01', '2028-12-31'), { tr: 366, trs: 183 });
  assert.deepEqual(periodDays('2026-01-01', '2026-05-16'), { tr: 136, trs: 46 });   // 01.04.–16.05.
  assert.deepEqual(periodDays('2026-10-01', '2026-12-31'), { tr: 92, trs: 0 });
});

test('BNetzA-Beispiel: Speicher 10 → 15 kWh am 16.05. teilt das Jahr, der Tag zählt zum Rumpfjahr davor', () => {
  const changes = [{ date: '2026-05-16', storageKwh: 15, label: 'Speichererweiterung' }];
  const perioden = periodsForYear(2026, { changes });
  assert.deepEqual(perioden.map((p) => [p.von, p.bis, p.tr, p.trs]), [
    ['2026-01-01', '2026-05-16', 136, 46],
    ['2026-05-17', '2026-12-31', 229, 137],
  ]);
  assert.equal(perioden[0].change.label, 'Speichererweiterung');
  const plant = (p) => plantForPeriod(p, { kwp: 8, storageKwhAt: () => 10, changes });
  assert.deepEqual(plant(perioden[0]), { kwp: 8, storageKwh: 10 });
  assert.deepEqual(plant(perioden[1]), { kwp: 8, storageKwh: 15 });
  const L1 = pauschalLimits({ ...plant(perioden[0]), ...perioden[0] });
  const L2 = pauschalLimits({ ...plant(perioden[1]), ...perioden[1] });
  close(L1.P1, 46 * 4000 / 183); close(L1.P3, 136 * 320 / 365); close(L1.P4, 1124.70);
  close(L2.P1, 137 * 4000 / 183); close(L2.P3, 229 * (0.1 * 8 / 15 * 4000) / 365); close(L2.P4, 3128.38);
  assert.equal(Math.round(L1.P1), 1005); assert.equal(Math.round(L1.P3), 119); assert.equal(Math.round(L1.P4), 1125);
  assert.equal(Math.round(L2.P1), 2995); assert.equal(Math.round(L2.P3), 134); assert.equal(Math.round(L2.P4), 3128);
});

test('Volles Kalenderjahr = kein Rumpfjahr: P1 = 500 · kWp, P3 = 0,1 · kWp / SK · P1', () => {
  const [p] = periodsForYear(2026, {});
  assert.equal(p.rumpf, false);
  const L = pauschalLimits({ kwp: 29.7, storageKwh: 77, ...p });
  close(L.P1, 14850); close(L.P2, 0.1 * 29.7 / 77, 1e-9); close(L.P3, 0.1 * 29.7 / 77 * 14850); close(L.P4, 14850 + 572.79);
  assert.equal(L.anwendbar, true);
  assert.equal(pauschalLimits({ kwp: 36, storageKwh: 100, ...p }).anwendbar, false, 'über 30 kWp keine Pauschaloption');
});

test('Start der Option: im ersten Jahr Rumpfjahr ab dem Starttag, davor nichts, später volle Jahre', () => {
  assert.deepEqual(periodsForYear(2026, { startDate: '2027-01-01' }), []);
  const [p] = periodsForYear(2026, { startDate: '2026-10-01' });
  assert.deepEqual([p.von, p.bis, p.tr, p.trs, p.rumpf], ['2026-10-01', '2026-12-31', 92, 0, true]);
  const L = pauschalLimits({ kwp: 8, storageKwh: 10, ...p });
  assert.equal(L.P1, 0, 'Winter-Rumpfjahr: keine förderfähige Menge');
  close(L.P3, 92 * 320 / 365);
  // Änderung vor dem Start oder am 31.12. teilt nichts
  assert.equal(periodsForYear(2026, { startDate: '2026-10-01', changes: [{ date: '2026-03-01' }, { date: '2026-12-31' }] }).length, 1);
  assert.deepEqual(periodsForYear(2027, { startDate: '2026-10-01' }).map((x) => x.tr), [365]);
});

test('Pauschal: Summen aus Viertelstunden — negativer Preis zählt nicht zu P7/P14, fehlender Preis wird gemeldet', () => {
  const s = sumPauschalSlots([
    { exportKwh: 1, importKwh: 0, priceCtKwh: 5 },
    { exportKwh: 2, importKwh: 0, priceCtKwh: -1 },
    { exportKwh: 0.5, importKwh: 0, priceCtKwh: null },
    { exportKwh: 0, importKwh: 3, priceCtKwh: 10 },
  ]);
  assert.deepEqual(s, { P7: 1.5, P9: 3, P14: 1.5, slots: 4, ohnePreis: 1 });
});

test('Pauschal: Jahresend-Einordnung P8, P10, P11, P15', () => {
  const L = { P1: 1005.46, P2: 0.08, P3: 119.23, P4: 1124.69 };
  const y = pauschalYearEnd(L, { P7: 2000, P9: 500, P14: 1900 });
  close(y.P8, 875.31); assert.equal(y.P10, 500); assert.equal(y.P11, 0); close(y.P15, 1005.46);
  const unter = pauschalYearEnd(L, { P7: 900, P9: 500, P14: 900 });
  assert.equal(unter.P8, 0); assert.equal(unter.P10, 0); assert.equal(unter.P11, 500); assert.equal(unter.P15, 900);
});

test('Abgrenzung A1: reiner Graustrom (Netz → Speicher → Netz) ist voll umlagereduziert, ohne Marktprämie', () => {
  const { monate, jahr } = abgrenzungMonths([
    { month: '2026-11', importKwh: 2, exportKwh: 0, batteryChargeKwh: 2, batteryDischargeKwh: 0, priceCtKwh: 3 },
    { month: '2026-11', importKwh: 0, exportKwh: 1.8, batteryChargeKwh: 0, batteryDischargeKwh: 1.8, priceCtKwh: 15 },
  ]);
  const m = monate[0];
  assert.equal(m.f9, 2); assert.equal(m.f10, 0); close(m.f11, 1.8); close(m.f14, 0.9, 1e-9);
  close(m.f16, 1.8); close(m.f17, 0.2); close(m.f19, 0.2); close(m.f20, 2); close(m.f21, 0);
  assert.equal(m.f32, 0);
  close(jahr.f22, 0); assert.equal(jahr.f33, 0);
});

test('Abgrenzung A1: Solarstrom über den Speicher ins Netz ist förderfähig, nicht saldierbar', () => {
  const { monate } = abgrenzungMonths([
    { month: '2026-06', importKwh: 0, exportKwh: 0, batteryChargeKwh: 1, batteryDischargeKwh: 0, priceCtKwh: 4 },
    { month: '2026-06', importKwh: 0, exportKwh: 0.9, batteryChargeKwh: 0, batteryDischargeKwh: 0.9, priceCtKwh: 20 },
    { month: '2026-06', importKwh: 0, exportKwh: 2, batteryChargeKwh: 0, batteryDischargeKwh: 0, priceCtKwh: -2 },
  ]);
  const m = monate[0];
  close(m.f15, 0.9); assert.equal(m.f16, 0);
  close(m.f31, 0.9);
  close(m.f26, 0, 1e-9, 'Einspeisung bei negativem Preis: kein anzulegender Wert (§ 51)');
  close(m.f32, 0.9);
  close(m.f4, 2.9);
});

// ── Über die echte history-runtime (Monatsweises Laden, Preise, Stichtage) ──
import { createHistoryRuntime, createHistoryApiHandlers } from '../history-runtime.js';

function mispelStore(slots, prices) {
  const inRange = (ts, start, end) => ts >= start && ts < end;
  return {
    async listMaterializedEnergySlots({ start, end }) { return slots.filter((s) => inRange(s.ts, start, end)); },
    async listAggregatedEnergySlots() { return []; },
    async listPriceSlots({ start, end }) { return prices.filter((p) => inRange(p.ts, start, end)); },
  };
}

test('Historie: Start 01.10., Speicher 10 → 15 kWh am 15.11. — zwei Rumpfjahre aus den Messwerten, heute = 01.12.', async () => {
  const slot = (ts, o) => ({ ts, importKwh: 0, exportKwh: 0, batteryChargeKwh: 0, batteryDischargeKwh: 0, ...o });
  const slots = [
    slot('2026-09-30T10:00:00.000Z', { exportKwh: 500 }),           // vor dem Start
    slot('2026-10-10T10:00:00.000Z', { exportKwh: 100 }),
    slot('2026-10-10T10:15:00.000Z', { exportKwh: 50 }),            // negativer Preis
    slot('2026-10-20T20:00:00.000Z', { importKwh: 30 }),
    slot('2026-11-20T10:00:00.000Z', { exportKwh: 40 }),
    slot('2026-11-20T20:00:00.000Z', { importKwh: 10 }),            // ohne Preis
    slot('2026-12-10T10:00:00.000Z', { exportKwh: 999 }),           // nach heute
  ];
  const prices = [
    { ts: '2026-10-10T10:00:00.000Z', priceCtKwh: 5 }, { ts: '2026-10-10T10:15:00.000Z', priceCtKwh: -1 },
    { ts: '2026-10-20T20:00:00.000Z', priceCtKwh: 10 }, { ts: '2026-11-20T10:00:00.000Z', priceCtKwh: 3 },
  ];
  const optimizer = {
    batteryCapacityWh: 10000,
    mispel: { mode: 'pauschal', startDate: '2026-10-01', pvKwp: 8, changes: [{ date: '2026-11-15', label: 'Speicher erweitert', storageKwh: 15 }] },
  };
  const runtime = createHistoryRuntime({
    store: mispelStore(slots, prices), getOptimizerConfig: () => optimizer, getCurrentDate: () => '2026-12-01',
  });
  const r = await runtime.getMispelOverview({ year: 2026 });
  assert.equal(r.mode, 'pauschal');
  assert.deepEqual(r.perioden.map((p) => [p.von, p.bis, p.tr, p.trs]), [['2026-10-01', '2026-11-15', 46, 0], ['2026-11-16', '2026-12-31', 46, 0]]);
  const [a, b] = r.perioden;
  assert.deepEqual(a.plant, { kwp: 8, storageKwh: 10 });
  assert.equal(a.grenzen.P1, 0);
  close(a.grenzen.P4, 46 * 320 / 365);
  assert.equal(a.werte.P7, 100); close(a.werte.P8, 100 - 46 * 320 / 365); assert.equal(a.werte.P9, 30);
  assert.equal(a.werte.P10, 30); assert.equal(a.werte.P11, 0); assert.equal(a.werte.P15, 0);
  assert.equal(a.change.label, 'Speicher erweitert');
  assert.deepEqual(b.plant, { kwp: 8, storageKwh: 15 });
  close(b.grenzen.P4, 46 * (0.1 * 8 / 15 * 4000) / 365);
  assert.equal(b.werte.P7, 40); assert.equal(b.werte.P9, 10); assert.equal(b.ohnePreis, 1);
  assert.equal(b.laufend, true);
  assert.equal(r.abgrenzung, undefined);
});

test('Historie: ohne Option leer; Abgrenzung liefert zusätzlich die Monate; Handler prüft das Jahr', async () => {
  const store = mispelStore([{ ts: '2026-11-03T10:00:00.000Z', importKwh: 0, exportKwh: 2, batteryChargeKwh: 0, batteryDischargeKwh: 2 }],
    [{ ts: '2026-11-03T10:00:00.000Z', priceCtKwh: 8 }]);
  const make = (mispel) => createHistoryRuntime({ store, getOptimizerConfig: () => ({ batteryCapacityWh: 10000, mispel }), getCurrentDate: () => '2026-12-01' });
  assert.deepEqual((await make({ mode: 'none' }).getMispelOverview({ year: 2026 })).perioden, []);
  const ab = await make({ mode: 'abgrenzung', startDate: '2026-11-01', pvKwp: 8 }).getMispelOverview({ year: 2026 });
  assert.deepEqual(ab.abgrenzung.monate.map((m) => [m.monat, m.f4, m.f6, m.f11]), [['2026-11', 2, 2, 2]]);
  const api = createHistoryApiHandlers({ historyRuntime: make({ mode: 'pauschal' }), telemetryEnabled: true });
  assert.equal((await api.getMispel({ year: 'x' })).status, 400);
  assert.equal((await api.getMispel({ year: '2026' })).status, 200);
  assert.equal((await createHistoryApiHandlers({ historyRuntime: null, telemetryEnabled: false }).getMispel({ year: '2026' })).status, 503);
});

// Codex 2026-10-18: Speicher leer = wieder aus den Ausbaustufen, auch nach einer früheren Angabe.
test('Speicher leer in einer späteren Änderung: zurück auf die Ausbaustufe', () => {
  const changes = [{ date: '2026-03-01', storageKwh: 15 }, { date: '2026-06-01', storageKwh: null, kwp: null }];
  const perioden = periodsForYear(2026, { changes });
  const at = (p) => plantForPeriod(p, { kwp: 8, storageKwhAt: (d) => (d >= '2026-06-02' ? 20 : 10), changes });
  assert.deepEqual(perioden.map((p) => at(p)), [{ kwp: 8, storageKwh: 10 }, { kwp: 8, storageKwh: 15 }, { kwp: 8, storageKwh: 20 }]);
});

// Codex 2026-10-18: §51 hängt an der Anlage — ältere Anlagen behalten den anzulegenden Wert bei negativem Preis.
test('§51 je Anlage: keine Kürzung, je Viertelstunde, nach 4 Stunden', async () => {
  assert.deepEqual(sumPauschalSlots([{ exportKwh: 2, priceCtKwh: -1, awZero: false }]), { P7: 0, P9: 0, P14: 2, slots: 1, ohnePreis: 0 });
  const slots = [10, 11, 12, 13].map((h) => ({ ts: `2026-11-03T${h}:00:00.000Z`, importKwh: 0, exportKwh: 1, batteryChargeKwh: 0, batteryDischargeKwh: 0 }));
  const prices = slots.map((s) => ({ ts: s.ts, priceCtKwh: -2 }));
  const run = async (pvPlants) => (await createHistoryRuntime({
    store: mispelStore(slots, prices), getCurrentDate: () => '2026-12-01',
    getPricingConfig: () => ({ pvPlants }),
    getOptimizerConfig: () => ({ batteryCapacityWh: 10000, mispel: { mode: 'pauschal', startDate: '2026-11-01', pvKwp: 8 } }),
  }).getMispelOverview({ year: 2026 })).perioden[0].werte;
  const alt = await run([{ commissionedAt: '2020-05-01', kwp: 8 }]);      // keine §51-Regel
  assert.equal(alt.P7, 0); assert.equal(alt.P14, 4);
  const neu = await run([{ commissionedAt: '2025-06-01', kwp: 8 }]);      // 15-min-Regel
  assert.equal(neu.P14, 0);
  const gross = await run([{ commissionedAt: '2022-03-01', kwp: 450 }]);  // 4-h-Regel: erst die 4. Stunde
  assert.equal(gross.P14, 3);
});
