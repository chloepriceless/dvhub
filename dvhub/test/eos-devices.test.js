// test/eos-devices.test.js -- EOS Home-Appliance Builder + Dispatch-Parser
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  eosApplianceId, nextLocalTimeIso, buildEosHomeAppliances,
  parseApplianceDispatch, applianceDispatchToPlanSlots,
} from '../services/optimizer/eos-devices.js';

const dishwasher = {
  id: 'dishwasher', name: 'GS', schedulable: true, kind: 'deferrable',
  plan: { energyWh: 1200, durationH: 2, deadline: '18:00', earliestStart: '08:00' },
  endpoint: { type: 'shelly', shellyDeviceId: 's1' },
};
const heater = { id: 'elwa', kind: 'modulating', plan: { maxPowerW: 3000 }, endpoint: { type: 'mqtt_publish', powerTopic: 't' } };

describe('eosApplianceId', () => {
  it('sanitises to a safe EOS key', () => {
    assert.equal(eosApplianceId('Dish-Washer_1'), 'appl_dish_washer_1');
    assert.equal(eosApplianceId(''), 'appl_x');
  });
});

describe('nextLocalTimeIso', () => {
  it('returns a future ISO for a given HH:MM', () => {
    const now = Date.parse('2026-09-26T10:00:00Z');
    const iso = nextLocalTimeIso('18:00', 'Europe/Berlin', now);
    assert.ok(iso && new Date(iso).getTime() > now);
  });
  it('rolls to tomorrow when the time already passed today', () => {
    const now = Date.parse('2026-09-26T20:00:00Z'); // 22:00 Berlin
    const iso = nextLocalTimeIso('08:00', 'Europe/Berlin', now);
    const dtMs = new Date(iso).getTime();
    assert.ok(dtMs > now && dtMs < now + 24 * 3600_000 + 3600_000);
  });
  it('rejects garbage', () => {
    assert.equal(nextLocalTimeIso('99:99'), null);
    assert.equal(nextLocalTimeIso(''), null);
  });
});

describe('buildEosHomeAppliances', () => {
  it('builds HomeApplianceParameters for deferrable devices only', () => {
    const now = Date.parse('2026-09-26T10:00:00Z');
    const { appliances, idMap } = buildEosHomeAppliances([dishwasher, heater], { nowMs: now });
    assert.equal(appliances.length, 1); // heater (modulating) excluded
    const a = appliances[0];
    assert.equal(a.device_id, 'appl_dishwasher');
    assert.equal(a.consumption_wh, 1200);
    assert.equal(a.duration_h, 2);
    assert.ok(a.deadline_datetime && a.earliest_start_datetime);
    assert.equal(idMap['appl_dishwasher'], 'dishwasher');
  });
  it('rounds fractional duration up and floors at 1h', () => {
    const { appliances } = buildEosHomeAppliances([{ ...dishwasher, plan: { energyWh: 500, durationH: 0.5 } }]);
    assert.equal(appliances[0].duration_h, 1);
    const { appliances: a2 } = buildEosHomeAppliances([{ ...dishwasher, plan: { energyWh: 500, durationH: 2.3 } }]);
    assert.equal(a2[0].duration_h, 3);
  });
  it('skips disabled devices', () => {
    const { appliances } = buildEosHomeAppliances([{ ...dishwasher, enabled: false }]);
    assert.equal(appliances.length, 0);
  });
});

describe('parseApplianceDispatch', () => {
  const startMs = Date.parse('2026-09-26T12:00:00Z');
  it('reads on-blocks from home_appliance_running (hourly)', () => {
    const sol = { home_appliance_running: { appl_dishwasher: [0, 0, 1, 1, 0, 0] } };
    const d = parseApplianceDispatch(sol, { startMs, slotMinutes: 60 });
    assert.equal(d.appl_dishwasher.length, 1);
    assert.equal(d.appl_dishwasher[0].startMs, startMs + 2 * 3600_000);
    assert.equal(d.appl_dishwasher[0].endMs, startMs + 4 * 3600_000);
  });
  it('falls back to appliance_starts + duration when no running array', () => {
    const sol = { appliance_starts: { appl_dishwasher: 3 } };
    const d = parseApplianceDispatch(sol, { startMs, slotMinutes: 60, durationByEosId: { appl_dishwasher: 2 } });
    assert.equal(d.appl_dishwasher[0].startMs, startMs + 3 * 3600_000);
    assert.equal(d.appl_dishwasher[0].endMs, startMs + 5 * 3600_000);
  });
  it('reads nested result.home_appliance_running', () => {
    const sol = { result: { home_appliance_running: { appl_x: [1, 1] } } };
    const d = parseApplianceDispatch(sol, { startMs });
    assert.equal(d.appl_x[0].startMs, startMs);
  });
  it('tolerates empty/missing', () => {
    assert.deepEqual(parseApplianceDispatch({}, { startMs }), {});
    assert.deepEqual(parseApplianceDispatch(null, { startMs }), {});
  });
});

describe('applianceDispatchToPlanSlots', () => {
  it('maps eosId windows back to device slots, sorted', () => {
    const startMs = Date.parse('2026-09-26T12:00:00Z');
    const dispatch = { appl_dishwasher: [{ startMs: startMs + 3600_000, endMs: startMs + 2 * 3600_000 }] };
    const slots = applianceDispatchToPlanSlots(dispatch, { appl_dishwasher: 'dishwasher' });
    assert.equal(slots.length, 1);
    assert.equal(slots[0].device, 'dishwasher');
    assert.equal(slots[0].action, 'on');
    assert.equal(slots[0].start, new Date(startMs + 3600_000).toISOString());
  });
});

import { parseApplianceRowsDispatch } from '../services/optimizer/eos-devices.js';
describe('parseApplianceRowsDispatch', () => {
  const t = (h) => `2026-09-26T${String(h).padStart(2,'0')}:00:00.000Z`;
  it('builds windows from running columns aligned to the slot grid', () => {
    const rows = [
      { ts_utc: t(12), appliances: null },
      { ts_utc: t(13), appliances: { appl_dishwasher_running: 1 } },
      { ts_utc: t(14), appliances: { appl_dishwasher_running: 1 } },
      { ts_utc: t(15), appliances: { appl_dishwasher_running: 0 } },
    ];
    const d = parseApplianceRowsDispatch(rows, { appl_dishwasher: 'dishwasher' });
    assert.equal(d.appl_dishwasher.length, 1);
    assert.equal(d.appl_dishwasher[0].startMs, Date.parse(t(13)));
    assert.equal(d.appl_dishwasher[0].endMs, Date.parse(t(15))); // last on-slot 14:00 + 1h
  });
  it('ignores op_factor noise columns', () => {
    const rows = [
      { ts_utc: t(12), appliances: { appl_x_op_factor: 0.9, appl_x_op_mode: 1 } },
      { ts_utc: t(13), appliances: { appl_x_op_factor: 0.9 } },
    ];
    const d = parseApplianceRowsDispatch(rows, { appl_x: 'x' });
    assert.deepEqual(d, {}); // no running/energy column → not "on"
  });
  it('empty when no idMap or rows', () => {
    assert.deepEqual(parseApplianceRowsDispatch([], { appl_x: 'x' }), {});
    assert.deepEqual(parseApplianceRowsDispatch([{ ts_utc: t(1), appliances: {} }], {}), {});
  });
});

import { resolveApplianceWindow } from '../services/optimizer/eos-devices.js';
describe('Codex fixes', () => {
  it('P2: resolveApplianceWindow keeps earliest before deadline (no impossible window)', () => {
    const noon = Date.parse('2026-09-26T10:00:00Z'); // 12:00 Berlin
    const w = resolveApplianceWindow('08:00', '18:00', 'Europe/Berlin', noon);
    assert.ok(new Date(w.earliestIso).getTime() < new Date(w.deadlineIso).getTime(), 'earliest < deadline');
    // deadline heute in der Zukunft, earliest heute (schon vergangen, aber erlaubt)
    assert.ok(new Date(w.deadlineIso).getTime() > noon);
    assert.ok(new Date(w.earliestIso).getTime() <= noon);
  });
  it('P2: buildEosHomeAppliances yields earliest_start < deadline', () => {
    const noon = Date.parse('2026-09-26T10:00:00Z');
    const { appliances } = buildEosHomeAppliances([{ id: 'dw', kind: 'deferrable', plan: { energyWh: 1000, durationH: 1, earliestStart: '08:00', deadline: '18:00' } }], { nowMs: noon });
    const a = appliances[0];
    assert.ok(Date.parse(a.earliest_start_datetime) < Date.parse(a.deadline_datetime));
  });
  it('P2: eosApplianceId collisions get distinct EOS ids', () => {
    const { idMap } = buildEosHomeAppliances([
      { id: 'dw-1', kind: 'deferrable', plan: { energyWh: 1000, durationH: 1 } },
      { id: 'dw_1', kind: 'deferrable', plan: { energyWh: 1000, durationH: 1 } },
    ]);
    const keys = Object.keys(idMap);
    assert.equal(keys.length, 2, 'zwei distinkte eosIds');
    assert.deepEqual([...new Set(Object.values(idMap))].sort(), ['dw-1', 'dw_1']);
  });
  it('P2: dispatch parser matches exact appliance id, not prefix', () => {
    const rows = [{ ts_utc: '2026-09-26T12:00:00Z', appliances: { appl_dw2_running: 1 } }];
    const d = parseApplianceRowsDispatch(rows, { appl_dw: 'dw', appl_dw2: 'dw2' });
    assert.ok(!d.appl_dw, 'appl_dw darf NICHT durch appl_dw2_running getriggert werden');
    assert.ok(d.appl_dw2, 'appl_dw2 wird korrekt erkannt');
  });
});
