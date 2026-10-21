// test/telemetry-store-pg-second-battery.test.js -- Akku der zweiten GX-Anlage
// in den 15-min-Energieslots (Chrissi 21.10.2026: „kannst die Akkus dort
// getrennt aufzeigen“). Die sechs Energie-Reihen werden wie die des Hauptakkus
// verdichtet und als eigene kWh-Felder je Slot ausgegeben; der Ladestand
// (second_battery_soc_pct) ist keine Energie und bleibt draussen.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMaterializedEnergySlotWrites, createTelemetryStorePg } from '../telemetry-store-pg.js';

const SECOND_FIELDS = {
  second_battery_charge_w: 'secondBatteryChargeKwh',
  second_battery_discharge_w: 'secondBatteryDischargeKwh',
  second_solar_to_battery_w: 'secondSolarToBatteryKwh',
  second_grid_to_battery_w: 'secondGridToBatteryKwh',
  second_battery_to_grid_w: 'secondBatteryToGridKwh',
  second_battery_direct_use_w: 'secondBatteryDirectUseKwh'
};

const liveRow = (seriesKey, value) => ({
  seriesKey, scope: 'live', source: 'local_poll', ts: '2026-10-21T10:05:00.000Z', value, resolutionSeconds: 900
});

function poolReturning(rowsFor) {
  const calls = [];
  return {
    calls,
    connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
    query: async (text, params) => {
      calls.push({ text: String(text), params });
      return { rows: rowsFor(String(text), params) };
    }
  };
}

describe('PG-Store: Akku 2 in den Energieslots', () => {
  test('Live-Reihen des zweiten Akkus werden verdichtet, der Ladestand nicht', () => {
    const rows = [...Object.keys(SECOND_FIELDS).map((k) => liveRow(k, 4000)), liveRow('second_battery_soc_pct', 70)];
    const writes = buildMaterializedEnergySlotWrites(rows);
    const keys = writes.map((w) => w.seriesKey).sort();
    assert.deepEqual(keys, Object.keys(SECOND_FIELDS).sort());
    for (const w of writes) assert.equal(w.valueNum, 1, `${w.seriesKey}: 4000 W × 15 min = 1 kWh`);
  });

  test('listMaterializedEnergySlots liefert die Akku-2-Felder je Slot', async () => {
    const pool = poolReturning((text) => (/energy_slots_15m/.test(text) && /GROUP BY slot_start_utc/.test(text)
      ? [{
        slot_start_utc: new Date('2026-10-21T10:00:00.000Z'),
        grid_import_w: 0.5,
        battery_to_grid_w: 0.3,
        second_battery_charge_w: 0.4,
        second_battery_discharge_w: 0.2,
        second_solar_to_battery_w: 0.25,
        second_grid_to_battery_w: 0.15,
        second_battery_to_grid_w: 0.12,
        second_battery_direct_use_w: 0.08,
        available_kinds: ['local_live'],
        selected_kinds: ['local_live'],
        estimated_keys: null,
        incomplete_keys: null
      }]
      : []));
    const store = createTelemetryStorePg(pool);
    const [slot] = await store.listMaterializedEnergySlots({ start: '2026-10-21T00:00:00Z', end: '2026-10-22T00:00:00Z' });
    assert.equal(slot.secondBatteryChargeKwh, 0.4);
    assert.equal(slot.secondBatteryDischargeKwh, 0.2);
    assert.equal(slot.secondSolarToBatteryKwh, 0.25);
    assert.equal(slot.secondGridToBatteryKwh, 0.15);
    assert.equal(slot.secondBatteryToGridKwh, 0.12);
    assert.equal(slot.secondBatteryDirectUseKwh, 0.08);
    assert.equal(slot.batteryToGridKwh, 0.3, 'Hauptakku unveraendert');
    // Die Akku-2-Reihen werden mit abgefragt ($1), aber nicht als „verfolgte“
    // Reihen fuer geschaetzt/unvollstaendig gefuehrt ($6).
    const call = pool.calls.find((c) => /GROUP BY slot_start_utc/.test(c.text));
    for (const k of Object.keys(SECOND_FIELDS)) {
      assert.ok(call.params[0].includes(k), `${k} in der Reihenliste`);
      assert.ok(call.params[4].includes(k), `${k} unter den Slot-Feldern`);
      assert.ok(!call.params[5].includes(k), `${k} nicht verfolgt`);
    }
  });

  test('listAggregatedEnergySlots (Rohdaten-Ausweichpfad) liefert die Akku-2-Felder', async () => {
    const pool = poolReturning((text, params) => {
      if (!/FROM timeseries_samples/.test(text)) return [];
      return Object.keys(SECOND_FIELDS)
        .filter((k) => params.includes(k))
        .map((k) => ({ series_key: k, ts_utc: '2026-10-21T10:00:00.000Z', resolution_seconds: 900, value_num: 2000, meta_json: null }));
    });
    const store = createTelemetryStorePg(pool);
    const [slot] = await store.listAggregatedEnergySlots({ start: '2026-10-21T00:00:00Z', end: '2026-10-22T00:00:00Z' });
    assert.ok(slot, 'Slot aus den Akku-2-Reihen');
    for (const field of Object.values(SECOND_FIELDS)) assert.equal(slot[field], 0.5, field);
  });

  test('ohne Akku-2-Daten: Felder sind 0', async () => {
    const pool = poolReturning((text) => (/GROUP BY slot_start_utc/.test(text)
      ? [{ slot_start_utc: new Date('2026-10-21T10:00:00.000Z'), grid_import_w: 0.5, available_kinds: ['local_live'], selected_kinds: ['local_live'] }]
      : []));
    const [slot] = await createTelemetryStorePg(pool).listMaterializedEnergySlots({ start: '2026-10-21T00:00:00Z', end: '2026-10-22T00:00:00Z' });
    for (const field of Object.values(SECOND_FIELDS)) assert.equal(slot[field], 0, field);
    assert.equal(slot.importKwh, 0.5);
  });
});
