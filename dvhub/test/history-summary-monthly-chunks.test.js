// test/history-summary-monthly-chunks.test.js — Jahr/Alle werden Monat für
// Monat geladen und bewertet (Speicher folgt dem größten Monat, nicht dem
// Zeitraum). Wichtigster Randfall: ein §51-Negativpreis-Lauf über eine
// Monatsgrenze — der Stundenzähler muss in den neuen Monat weiterlaufen.
// (Bit-Gleichheit mit der alten Ganz-Zeitraum-Fassung wurde zusätzlich per
// Golden-Vergleich auf 47 000 Echtdaten-Slots aller Ansichten geprüft.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryRuntime } from '../history-runtime.js';

// 31.01.2026 21:00 UTC … 01.02.2026 02:00 UTC = 22:00–03:00 Berlin (CET):
// Stunden 21,22 (UTC) liegen im Januar, 23,00,01 schon im Februar (lokal).
function fakeStore() {
  const slots = [];
  const prices = [];
  const startMs = Date.parse('2026-01-31T21:00:00Z');
  for (let i = 0; i < 5 * 4; i++) {
    const ts = new Date(startMs + i * 900_000).toISOString();
    slots.push({ ts, importKwh: 0, exportKwh: 1, pvKwh: 1, loadKwh: 0, sourceKind: 'local_live', sourceKinds: ['local_live'] });
    prices.push({ ts, priceCtKwh: -1 });
  }
  // eine Stunde positiv danach (beendet den Lauf)
  for (let i = 0; i < 4; i++) {
    const ts = new Date(startMs + (20 + i) * 900_000).toISOString();
    slots.push({ ts, importKwh: 0, exportKwh: 1, pvKwh: 1, loadKwh: 0, sourceKind: 'local_live', sourceKinds: ['local_live'] });
    prices.push({ ts, priceCtKwh: 5 });
  }
  const calls = [];
  const within = (rows, start, end) => rows.filter((r) => r.ts >= start && r.ts < end);
  return {
    calls,
    async listMaterializedEnergySlots({ start, end }) { calls.push([start, end]); return within(slots, start, end); },
    async listAggregatedEnergySlots() { return []; },
    async listPriceSlots({ start, end }) { return within(prices, start, end); },
  };
}

const pricing = { pvPlants: [{ kwp: 600, commissionedAt: '2021-06-01' }] }; // §51: 4-Stunden-Regel

test('Jahr: §51-Stundenzähler läuft über die Monatsgrenze weiter', async () => {
  const store = fakeStore();
  const rt = createHistoryRuntime({ store, getPricingConfig: () => pricing, getCurrentDate: () => '2026-09-29' });
  const r = await rt.getSummary({ view: 'year', date: '2026-01-01' });
  assert.equal(r.kpis.negPriceRule, '4h');
  // Negativstunden 1–5 in Folge; ab der 4. betroffen = 2 Stunden × 4 Slots.
  assert.equal(r.kpis.negPriceQuarterHourCount, 8, 'ohne Übertrag wären es 0 (Februar zählte neu ab 1)');
  // Dieselbe Zahl wie der Monat Februar allein (dessen Vortags-Aufwärmen den Januar sieht)
  const feb = await rt.getSummary({ view: 'month', date: '2026-02-01' });
  assert.equal(feb.kpis.negPriceQuarterHourCount, 8);
});

test('Jahr/Alle laden nie mehr als einen Monat auf einmal', async () => {
  for (const view of ['year', 'all']) {
    const store = fakeStore();
    const rt = createHistoryRuntime({ store, getPricingConfig: () => pricing, getCurrentDate: () => '2026-09-29' });
    const r = await rt.getSummary({ view, date: '2026-01-01' });
    assert.equal(r.meta.unresolved.slotCount, 24);
    assert.deepEqual(r.slots, [], 'Jahr/Alle liefern keine Einzelslots aus');
    const longest = Math.max(...store.calls.map(([s, e]) => Date.parse(e) - Date.parse(s)));
    assert.ok(longest <= 32 * 86_400_000, `${view}: längste Abfrage ${longest / 86_400_000} Tage`);
  }
});
