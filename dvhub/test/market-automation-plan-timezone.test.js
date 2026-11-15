// test/market-automation-plan-timezone.test.js — GH #20: Die Zeiten in der
// Plan-Zusammenfassung (planSummary.selectedSlots[].time, oben in der UI) müssen
// in der konfigurierten Zeitzone stehen — genau wie die Schedule-Tabelle unten
// (formatLocalHHMM). Vorher nahm toLocaleTimeString ohne timeZone-Option die
// Prozess-Zeitzone; im Container (UTC) zeigte die obere Tabelle UTC, die untere
// Europe/Berlin — dieselben Slots, zwei verschiedene Uhrzeiten.
//
// Damit der Bug reproduzierbar ist, läuft dieser Test bewusst mit TZ=UTC
// (Prozess-Zeitzone ≠ Berlin). Node läuft jede Testdatei in einem eigenen
// Subprozess, daher beeinflusst das keine andere Datei.
process.env.TZ = 'UTC';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMarketAutomationBuilder } from '../market-automation-builder.js';

const NOW = Date.parse('2026-01-15T12:00:00Z');          // 13:00 Berlin (MEZ, UTC+1)
const at = (hhmmBerlin) => Date.parse(`2026-01-15T${hhmmBerlin}:00+01:00`);
const PRICES = [['17:00', 20], ['17:15', 25], ['17:30', 50], ['17:45', 30], ['18:00', 40], ['18:15', 10]];
const epex = () => PRICES.map(([t, ct]) => ({ ts: at(t), ct_kwh: ct }));
const manual = { id: 'm1', enabled: true, target: 'gridSetpointW', start: '20:00', end: '20:30', value: -500, source: 'manual' };

function setup() {
  const state = {
    victron: { soc: 50, minSocPct: 5, pvTotalW: 0 },
    epex: { data: epex() },
    forecast: {},
    optimizer: {},
    schedule: { rules: [{ ...manual }], smallMarketAutomation: {} },
  };
  const cfg = {
    epex: { timezone: 'Europe/Berlin' },
    optimizer: { enabled: false },
    schedule: {
      timezone: 'Europe/Berlin',
      smallMarketAutomation: {
        enabled: true, engine: 'greedy', searchWindowStart: '17:00', searchWindowEnd: '21:00',
        batteryCapacityKwh: 10, minSocPct: 30, inverterEfficiencyPct: 100, maxDischargeW: -4000,
      },
    },
  };
  const mab = createMarketAutomationBuilder({
    state, getCfg: () => cfg, pushLog: () => {},
    persistConfig: () => {},
    getSunTimesCacheForPlanning: () => ({ cache: {} }),
  });
  return { mab, state };
}

describe('GH #20 — Plan-Zusammenfassung zeigt lokale Zeit (Europe/Berlin), nicht UTC', () => {
  it('selectedSlots[].time ist Berlin-Zeit, auch wenn der Prozess auf UTC läuft', async () => {
    assert.equal(process.env.TZ, 'UTC', 'Vorbedingung: Prozess-Zeitzone UTC, sonst verdeckt Berlin-TZ den Bug');
    const { mab, state } = setup();
    await mab.regenerateSmallMarketAutomationRules({ now: NOW, force: true });
    const plan = state.schedule.smallMarketAutomation.plan;
    assert.ok(plan && Array.isArray(plan.selectedSlots) && plan.selectedSlots.length > 0, 'Plan mit Slots erwartet');

    // Der gewählte Haupt-Slot ist 17:30 Berlin (= 16:30 UTC im Winter, MEZ).
    // Vor dem Fix (UTC-Prozess) stand hier "16:30"; korrekt ist die lokale "17:30".
    for (const slot of plan.selectedSlots) {
      const berlin = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).format(new Date(slot.ts));
      assert.equal(slot.time, berlin, `Slot ${slot.ts}: time muss lokale Berlin-Zeit sein, nicht UTC`);
    }

    const mainSlot = plan.selectedSlots.find((s) => s.ts === at('17:30'));
    assert.ok(mainSlot, 'Haupt-Slot 17:30 Berlin erwartet');
    assert.equal(mainSlot.time, '17:30', 'Haupt-Slot zeigt 17:30 (Berlin), nicht 16:30 (UTC)');
  });
});
