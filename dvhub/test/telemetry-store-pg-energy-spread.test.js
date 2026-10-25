// test/telemetry-store-pg-energy-spread.test.js -- Proben, die laenger als ein
// 15-min-Slot sind (VRM interval=hours/days, importSamples mit 3600 s), verteilen
// ihre Energie anteilig auf alle Slots, die sie ueberdecken. Vorher kappte der
// PG-Store auf 900 s und warf den Rest weg (pvAcKwh 75 % bzw. 99 % zu klein).
// Gleiche Faelle wie test/sqlite/telemetry-store.test.js („verteilt lange
// VRM-Proben …“), damit beide Stores dieselben Zahlen liefern.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMaterializedEnergySlotWrites, createTelemetryStorePg } from '../telemetry-store-pg.js';

const vrm = (seriesKey, ts, value, resolutionSeconds) => ({
  seriesKey, scope: 'history', source: 'vrm_import', quality: 'backfilled', ts, value, resolutionSeconds, unit: 'W'
});
const live = (seriesKey, ts, value, resolutionSeconds) => ({
  seriesKey, scope: 'live', source: 'local_poll', quality: 'raw', ts, value, resolutionSeconds, unit: 'W'
});
const bySlot = (writes, seriesKey) => Object.fromEntries(writes
  .filter((w) => w.seriesKey === seriesKey)
  .map((w) => [new Date(w.slotStartUtc).toISOString(), w.valueNum]));
const sum = (obj) => Object.values(obj).reduce((a, b) => a + b, 0);
const close = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-9, `${msg}: ${actual} != ${expected}`);

describe('PG-Store: lange Proben ueber mehrere Slots', () => {
  test('Stundenprobe (3600 s): 4000 W → je Viertelstunde 1 kWh, zusammen 4 kWh', () => {
    const slots = bySlot(buildMaterializedEnergySlotWrites([vrm('pv_ac_w', '2026-03-09T12:00:00.000Z', 4000, 3600)]), 'pv_ac_w');
    assert.deepEqual(Object.keys(slots).sort(), [
      '2026-03-09T12:00:00.000Z', '2026-03-09T12:15:00.000Z', '2026-03-09T12:30:00.000Z', '2026-03-09T12:45:00.000Z'
    ]);
    for (const [slot, kwh] of Object.entries(slots)) close(kwh, 1, slot);
  });

  test('Tagesprobe (86400 s): 1000 W ab Berliner Mitternacht → 96 Slots à 0,25 kWh = 24 kWh', () => {
    const slots = bySlot(buildMaterializedEnergySlotWrites([vrm('pv_ac_w', '2026-03-08T23:00:00.000Z', 1000, 86400)]), 'pv_ac_w');
    assert.equal(Object.keys(slots).length, 96);
    assert.ok(slots['2026-03-08T23:00:00.000Z'] != null && slots['2026-03-09T22:45:00.000Z'] != null);
    for (const [slot, kwh] of Object.entries(slots)) close(kwh, 0.25, slot);
    close(sum(slots), 24, 'Tagessumme');
  });

  test('nicht ausgerichtete Probe: 2000 W, 1800 s ab 12:05 → 10/15/5 min', () => {
    const slots = bySlot(buildMaterializedEnergySlotWrites([vrm('grid_import_w', '2026-03-09T12:05:00.000Z', 2000, 1800)]), 'grid_import_w');
    close(slots['2026-03-09T12:00:00.000Z'], 2000 * 600 / 3600000, '12:00');
    close(slots['2026-03-09T12:15:00.000Z'], 0.5, '12:15');
    close(slots['2026-03-09T12:30:00.000Z'], 2000 * 300 / 3600000, '12:30');
    close(sum(slots), 1, 'Summe');
  });

  // Gegenpruefung 84da7835 (P3): Tagesproben an Umstellungstagen. VRM stempelt
  // die Tage auf lokale Mitternacht; der 29.03. hat 23 h, der 25.10. 25 h. Die
  // Probe reicht bis zur naechsten Probe derselben Reihe, nicht starr 24 h.
  // Gegenpruefung a6c78de8 (P2): die Energie der Probe (Wert × Aufloesung,
  // hier 1000 W × 24 h = 24 kWh) bleibt dabei gleich, sie verteilt sich nur
  // auf 23 bzw. 25 h: 24/92 bzw. 24/100 kWh je Viertelstunde.
  test('Umstellungstage: Tagesprobe reicht bis zur naechsten (23 h bzw. 25 h), Energie bleibt', () => {
    const spring = bySlot(buildMaterializedEnergySlotWrites([
      vrm('pv_ac_w', '2026-03-28T23:00:00.000Z', 1000, 86400), // 29.03. Berlin, 23 h
      vrm('pv_ac_w', '2026-03-29T22:00:00.000Z', 1000, 86400)  // 30.03. Berlin
    ]), 'pv_ac_w');
    close(spring['2026-03-29T22:00:00.000Z'], 0.25, '30.03. 00:00 Berlin nur aus der zweiten Probe');
    close(spring['2026-03-29T21:45:00.000Z'], 24 / 92, '29.03. 23:45 Berlin');
    close(sum(spring), 48, 'zwei Tage à 24 kWh');
    const autumn = bySlot(buildMaterializedEnergySlotWrites([
      vrm('pv_ac_w', '2026-10-24T22:00:00.000Z', 1000, 86400), // 25.10. Berlin, 25 h
      vrm('pv_ac_w', '2026-10-25T23:00:00.000Z', 1000, 86400)  // 26.10. Berlin
    ]), 'pv_ac_w');
    close(autumn['2026-10-25T22:00:00.000Z'], 0.24, '25.10. 23:00 MEZ gehoert noch zum 25.10.');
    close(autumn['2026-10-25T22:45:00.000Z'], 0.24, '25.10. 23:45 MEZ');
    close(autumn['2026-10-25T23:00:00.000Z'], 0.25, '26.10. 00:00 MEZ');
    close(sum(autumn), 48, 'zwei Tage à 24 kWh');
  });

  test('Stundenproben mit Luecke werden nicht bis zur naechsten gestreckt', () => {
    const slots = bySlot(buildMaterializedEnergySlotWrites([
      vrm('pv_ac_w', '2026-03-09T12:00:00.000Z', 4000, 3600),
      vrm('pv_ac_w', '2026-03-09T14:00:00.000Z', 4000, 3600)
    ]), 'pv_ac_w');
    assert.equal(slots['2026-03-09T13:00:00.000Z'], undefined, '13:00–14:00 ohne Probe bleibt leer');
    close(sum(slots), 8, 'zwei Stunden à 4 kWh');
  });

  test('15-min-Probe bleibt ein Slot mit voller Energie', () => {
    const slots = bySlot(buildMaterializedEnergySlotWrites([vrm('pv_ac_w', '2026-03-09T12:00:00.000Z', 4000, 900)]), 'pv_ac_w');
    assert.deepEqual(slots, { '2026-03-09T12:00:00.000Z': 1 });
  });

  test('Live-Probe mit Lueckenaufloesung bleibt auf 900 s gekappt (T-0079)', () => {
    // Live-Zeitstempel markieren das Ende der Messspanne; ein Wert nach einem
    // Ausfall darf die Luecke nicht fuellen.
    const slots = bySlot(buildMaterializedEnergySlotWrites([live('grid_import_w', '2026-03-09T12:00:00.000Z', 4000, 3600)]), 'grid_import_w');
    assert.deepEqual(slots, { '2026-03-09T12:00:00.000Z': 1 });
  });

  test('writeSamples schreibt alle vier Slots der Stundenprobe (replace)', async () => {
    const sql = [];
    const client = {
      query: async (text, params) => { sql.push({ text: String(text), params }); return { rows: [] }; },
      release: () => {}
    };
    const pool = { connect: async () => client, query: async () => ({ rows: [] }) };
    await createTelemetryStorePg(pool).writeSamples([vrm('pv_ac_w', '2026-03-09T12:00:00.000Z', 4000, 3600)]);
    const slotInsert = sql.find((q) => /INSERT INTO energy_slots_15m/.test(q.text));
    assert.ok(slotInsert, 'Slot-INSERT');
    assert.match(slotInsert.text, /value_num = EXCLUDED\.value_num/);
    assert.equal(slotInsert.params[0].length, 4);
    for (const v of slotInsert.params[4]) close(v, 1, 'kWh je Slot');
  });
});
