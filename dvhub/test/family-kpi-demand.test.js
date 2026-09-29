// test/family-kpi-demand.test.js — Familien-KPIs (heute/Monat/Jahr) werden nur
// gerechnet, solange das Dashboard abgefragt wird. Die Jahres-Zusammenfassung
// lädt die 15-min-Historie des ganzen Jahres (~100 MB Heap bei echtem Bestand);
// beim Booten und ohne Zuschauer war das reine Speicherlast.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFamilyService, FAMILY_DEMAND_WINDOW_MS } from '../services/family/index.js';

function ctxWithHistory() {
  const calls = [];
  let inFlight = 0, maxInFlight = 0;
  const ctx = {
    state: { victron: {}, meter: {}, epex: { data: [] }, energy: {} },
    getCfg: () => ({ family: {}, optimizer: {} }),
    pushLog: () => {},
    buildFallbackStatusPayload: () => ({}),
    historyApi: {
      async getSummary({ view }) {
        calls.push(view);
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { body: { kpis: { pvKwh: 1, netEur: 2 } } };
      },
    },
  };
  return { ctx, calls, maxInFlight: () => maxInFlight };
}
const settle = () => new Promise((r) => setTimeout(r, 60));

test('start(): kein Rechnen beim Booten', async (t) => {
  const { ctx, calls } = ctxWithHistory();
  const svc = createFamilyService(ctx);
  t.after(() => svc.close?.());
  await svc.start();
  await settle();
  assert.deepEqual(calls, []);
});

test('erster Dashboard-Abruf stößt heute + Monat + Jahr an; Monat und Jahr nacheinander', async (t) => {
  const { ctx, calls, maxInFlight } = ctxWithHistory();
  const svc = createFamilyService(ctx);
  t.after(() => svc.close?.());
  await svc.start();
  svc.buildFamilyStatus();
  await settle();
  assert.deepEqual(calls, ['day', 'month', 'year']);
  assert.equal(maxInFlight(), 1, 'nie zwei Zusammenfassungen gleichzeitig im Speicher');
  // weitere Abrufe im Fenster lösen nicht erneut aus
  svc.buildFamilyStatus();
  await settle();
  assert.deepEqual(calls, ['day', 'month', 'year']);
});

test('Timer rechnet nur, solange das Dashboard im Fenster abgefragt wurde', async (t) => {
  const { ctx, calls } = ctxWithHistory();
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const svc = createFamilyService(ctx);
  t.after(() => svc.close?.());
  await svc.start();
  t.mock.timers.tick(60_000);
  await Promise.resolve();
  assert.deepEqual(calls, [], 'ohne Zuschauer: nichts');
  svc.buildFamilyStatus();                 // Dashboard offen → day (+ month/year async)
  const afterDemand = calls.length;
  t.mock.timers.tick(60_000);              // im Fenster → Timer rechnet „heute“
  await Promise.resolve();
  assert.ok(calls.length > afterDemand, 'Timer rechnet, solange jemand zuschaut');
  const before = calls.length;
  t.mock.timers.tick(FAMILY_DEMAND_WINDOW_MS + 60_000); // Dashboard zu
  await Promise.resolve();
  const n = calls.length;
  t.mock.timers.tick(60_000);
  await Promise.resolve();
  assert.equal(calls.length, n, 'nach Ablauf des Fensters rechnet der Timer nicht mehr');
  assert.ok(n >= before);
});
