// test/eos-device-bridge.test.js -- Aktuierungs-Bridge für planbare Geräte
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createEosDeviceBridge, deferrableOnNow, surplusW } from '../services/optimizer/eos-device-bridge.js';

function fakeActuator() {
  const calls = [];
  return {
    calls,
    apply: async (device, command) => { calls.push({ id: device.id, ...command }); return { ok: true }; },
    commandKey: (device, command) => device.kind === 'modulating' ? `p:${Math.round(command.powerW || 0)}` : `o:${command.on ? 1 : 0}`,
  };
}

const dishwasher = { id: 'dw', name: 'GS', schedulable: true, kind: 'deferrable', plan: { energyWh: 1000, durationH: 1 }, endpoint: { type: 'mqtt_expose' } };
const heater = { id: 'elwa', name: 'Elwa', schedulable: true, kind: 'modulating', plan: { maxPowerW: 3000, minPowerW: 100 }, endpoint: { type: 'mqtt_publish', powerTopic: 't' } };

describe('deferrableOnNow', () => {
  it('true inside a window, false outside', () => {
    const nowMs = 1000;
    assert.equal(deferrableOnNow({ appl_dw: [{ startMs: 500, endMs: 1500 }] }, 'appl_dw', nowMs), true);
    assert.equal(deferrableOnNow({ appl_dw: [{ startMs: 2000, endMs: 3000 }] }, 'appl_dw', nowMs), false);
    assert.equal(deferrableOnNow({}, 'appl_dw', nowMs), false);
  });
});

describe('surplusW', () => {
  it('export (negative grid) plus already-drawing', () => {
    assert.equal(surplusW({ meter: { grid_total_w: -1500 } }, 500), 2000);
    assert.equal(surplusW({ meter: { grid_total_w: 800 } }, 0), 0); // importing → no surplus
  });
  it('Codex-P1: importing while drawing → throttle to 0 (signed grid)', () => {
    // 1200 W Heizlast, 1200 W Netzbezug → kein Überschuss → 0 (nicht 1200!)
    assert.equal(surplusW({ meter: { grid_total_w: 1200 } }, 1200), 0);
    // teilw. Bezug: 1200 W Last, 400 W Bezug → 800 W echter Überschuss
    assert.equal(surplusW({ meter: { grid_total_w: 400 } }, 1200), 800);
  });
  it('unknown grid → 0 (fail-safe)', () => {
    assert.equal(surplusW({}, 500), 0);
    assert.equal(surplusW({ meter: {} }, 1000), 0);
  });
});

describe('createEosDeviceBridge', () => {
  afterEach(() => { delete process.env.DVHUB_READ_ONLY; });

  it('skips in read-only mode', async () => {
    process.env.DVHUB_READ_ONLY = '1';
    const act = fakeActuator();
    const b = createEosDeviceBridge({ getCfg: () => ({ devices: [dishwasher] }), getSolution: async () => ({ rows: [] }), actuator: act, state: {} });
    const r = await b.tick();
    assert.equal(r.skipped, 'read_only');
    assert.equal(act.calls.length, 0);
  });

  it('Not-Halt: friert ein — kein Schalten, auch nicht fuer entfernte Geraete; danach normal', async () => {
    const now = () => Date.parse('2026-09-26T13:30:00.000Z');
    const rows = [
      { ts_utc: '2026-09-26T13:00:00.000Z', appliances: { appl_dw_running: 1 } },
      { ts_utc: '2026-09-26T14:00:00.000Z', appliances: { appl_dw_running: 0 } },
    ];
    const act = fakeActuator();
    const state = { ctrl: { discretionaryWritesPaused: true }, optimizer: { eosApplianceIdMap: { appl_dw: 'dw' } }, meter: { grid_total_w: -3000 } };
    let devices = [dishwasher, heater];
    const b = createEosDeviceBridge({ getCfg: () => ({ devices }), getSolution: async () => ({ rows }), actuator: act, state, now });
    assert.equal((await b.tick()).skipped, 'paused');
    assert.equal(act.calls.length, 0);
    state.ctrl.discretionaryWritesPaused = false;
    await b.tick();
    assert.ok(act.calls.some((c) => c.id === 'dw' && c.on === true));
    const n = act.calls.length;
    // Geraet entfernt waehrend Not-Halt: kein Ausschalt-Befehl, bis er aufgehoben ist.
    state.ctrl.discretionaryWritesPaused = true;
    devices = [heater];
    await b.tick();
    assert.equal(act.calls.length, n);
    state.ctrl.discretionaryWritesPaused = false;
    await b.tick();
    assert.ok(act.calls.slice(n).some((c) => c.id === 'dw' && c.on === false));
  });

  it('deferrable: turns ON when EOS dispatch covers now', async () => {
    const now = () => Date.parse('2026-09-26T13:30:00.000Z');
    const rows = [
      { ts_utc: '2026-09-26T13:00:00.000Z', appliances: { appl_dw_running: 1 } },
      { ts_utc: '2026-09-26T14:00:00.000Z', appliances: { appl_dw_running: 0 } },
    ];
    const act = fakeActuator();
    const state = { optimizer: { eosApplianceIdMap: { appl_dw: 'dw' } } };
    const b = createEosDeviceBridge({ getCfg: () => ({ devices: [dishwasher] }), getSolution: async () => ({ rows }), actuator: act, state, now });
    await b.tick();
    assert.deepEqual(act.calls, [{ id: 'dw', on: true }]);
  });

  it('zählt abgeschlossene Läufe je Tag (EOS 0.4 cycles_completed)', async () => {
    let t = Date.parse('2026-09-26T13:10:00.000Z');
    const rows = [
      { ts_utc: '2026-09-26T13:00:00.000Z', appliances: { appl_dw_running: 1 } },
      { ts_utc: '2026-09-26T14:00:00.000Z', appliances: { appl_dw_running: 0 } },
    ];
    const state = { optimizer: { eosApplianceIdMap: { appl_dw: 'dw' } } };
    const b = createEosDeviceBridge({ getCfg: () => ({ devices: [dishwasher] }), getSolution: async () => ({ rows }), actuator: fakeActuator(), state, now: () => t });
    await b.tick();
    assert.equal(state.optimizer.applianceCyclesToday.appl_dw, 0, 'läuft noch');
    t = Date.parse('2026-09-26T14:05:00.000Z'); await b.tick();
    assert.equal(state.optimizer.applianceCyclesToday.appl_dw, 1, '55 min ≥ halbe Dauer → 1 Lauf');
    t = Date.parse('2026-09-27T08:00:00.000Z'); await b.tick();
    assert.equal(state.optimizer.applianceCyclesToday.appl_dw, 0, 'neuer Tag');
  });

  it('deferrable: OFF when no dispatch window now', async () => {
    const now = () => Date.parse('2026-09-26T20:00:00.000Z');
    const rows = [{ ts_utc: '2026-09-26T13:00:00.000Z', appliances: { appl_dw_running: 1 } }];
    const act = fakeActuator();
    const state = { optimizer: { eosApplianceIdMap: { appl_dw: 'dw' } } };
    const b = createEosDeviceBridge({ getCfg: () => ({ devices: [dishwasher] }), getSolution: async () => ({ rows }), actuator: act, state, now });
    await b.tick();
    assert.deepEqual(act.calls, [{ id: 'dw', on: false }]);
  });

  it('modulating: follows PV surplus', async () => {
    const act = fakeActuator();
    const state = { meter: { grid_total_w: -1200 } };
    const b = createEosDeviceBridge({ getCfg: () => ({ devices: [heater] }), getSolution: async () => ({ rows: [] }), actuator: act, state });
    await b.tick();
    assert.deepEqual(act.calls, [{ id: 'elwa', powerW: 1200 }]);
  });

  it('dedups: unchanged command not re-sent (heater pinned at max)', async () => {
    const act = fakeActuator();
    // Großer Überschuss → Leistung an maxPowerW geklemmt, bleibt über Ticks gleich
    // (auch mit Ramp: Export + Heizlast bleibt > max → clamp auf max) → Dedup.
    const state = { meter: { grid_total_w: -5000 } };
    const b = createEosDeviceBridge({ getCfg: () => ({ devices: [heater] }), getSolution: async () => ({ rows: [] }), actuator: act, state });
    await b.tick();
    await b.tick();
    assert.equal(act.calls.length, 1);
    assert.deepEqual(act.calls[0], { id: 'elwa', powerW: 3000 });
  });

  it('Codex-P1: sends OFF/0W when a controlled device is removed from config', async () => {
    const act = fakeActuator();
    const state = { meter: { grid_total_w: -1200 } };
    let cfgDevices = [heater, dishwasher];
    const state2 = { ...state, optimizer: { eosApplianceIdMap: { appl_dw: 'dw' } } };
    const b = createEosDeviceBridge({ getCfg: () => ({ devices: cfgDevices }), getSolution: async () => ({ rows: [] }), actuator: act, state: state2 });
    await b.tick(); // steuert elwa (1200W) + dw (off)
    const before = act.calls.length;
    assert.ok(before >= 1);
    // Heizstab aus der Config entfernen → nächster Tick muss 0 W schicken
    cfgDevices = [dishwasher];
    await b.tick();
    const elwaOff = act.calls.slice(before).find(c => c.id === 'elwa' && c.powerW === 0);
    assert.ok(elwaOff, 'entferntes Gerät bekommt 0 W');
  });

  it('modulating ramp: surplus accounts for already-drawing power', async () => {
    const act = fakeActuator();
    const state = { meter: { grid_total_w: -1200 } };
    const b = createEosDeviceBridge({ getCfg: () => ({ devices: [heater] }), getSolution: async () => ({ rows: [] }), actuator: act, state });
    await b.tick(); // surplus 1200 → power 1200, lastPower=1200
    state.meter.grid_total_w = 0; // now no export, but heater draws 1200 → surplus = 1200
    await b.tick();
    // command unchanged (still 1200) → deduped, so still 1 call
    assert.equal(act.calls.length, 1);
  });
});

describe('Heizstab: heute gelieferte Energie wird mitgezählt', () => {
  it('rechnet die gestellte Leistung über die Zeit zwischen den Takten hoch, je Tag neu', async () => {
    let t = Date.parse('2026-10-04T10:00:00.000Z');
    const state = { meter: { grid_total_w: -2000 } };
    const b = createEosDeviceBridge({ getCfg: () => ({ devices: [heater] }), getSolution: async () => ({ rows: [] }), actuator: fakeActuator(), state, now: () => t });
    await b.tick();                                   // stellt 2000 W; bis hierher lief nichts
    assert.equal(state.optimizer.heaterEnergyToday.elwa.wh, 0);
    assert.equal(state.optimizer.heaterEnergyToday.elwa.date, '2026-10-04');
    t += 30_000; await b.tick();                      // 2000 W × 30 s
    assert.ok(Math.abs(state.optimizer.heaterEnergyToday.elwa.wh - 2000 * 30 / 3600) < 1e-6);
    // Der zweite Takt hat auf 3000 W hochgeregelt (Überschuss = Einspeisung + eigene Last).
    t += 3600_000; await b.tick();                    // lange Lücke zählt höchstens 2 min
    const afterGap = state.optimizer.heaterEnergyToday.elwa.wh;
    assert.ok(Math.abs(afterGap - (2000 * 30 + 3000 * 120) / 3600) < 1e-6, `nach der Lücke ${afterGap}`);
    t = Date.parse('2026-10-04T22:30:00.000Z'); await b.tick(); // 00:30 Ortszeit am 5.10.
    assert.equal(state.optimizer.heaterEnergyToday.elwa.date, '2026-10-05', 'neuer Tag (Europe/Berlin) beginnt bei 0');
    assert.ok(state.optimizer.heaterEnergyToday.elwa.wh <= 100 + 1e-6, 'nur der eine Takt des neuen Tags');
  });
});

describe('surplusW: nur echter PV-Überschuss (Anlage mit aufgeteilten Flüssen)', () => {
  const flows = (o) => ({ victron: { solarToGridW: 0, gridImportW: 0, batteryDischargeW: 0, ...o } });
  it('PV ins Netz + eigene Heizleistung', () => {
    assert.equal(surplusW(flows({ solarToGridW: 1500 }), 500), 2000);
    assert.equal(surplusW(flows({ solarToGridW: 0 }), 0), 0);
  });
  it('geplante Akku-Einspeisung ist kein Überschuss — auch nicht, wenn der Stab schon läuft', () => {
    // Abends: Akku speist 5 kW ein, keine PV.
    assert.equal(surplusW(flows({ batteryDischargeW: 5000 }), 0), 0);
    // Der Stab zieht 2 kW davon: er muss auf 0 zurück.
    assert.equal(surplusW(flows({ batteryDischargeW: 5000 }), 2000), 0);
  });
  it('PV bricht ein: was Akku oder Netz zum Stab beisteuern, zählt nicht', () => {
    assert.equal(surplusW(flows({ batteryDischargeW: 1500 }), 2000), 500);
    assert.equal(surplusW(flows({ gridImportW: 800 }), 2000), 1200);
    assert.equal(surplusW(flows({ gridImportW: 2500 }), 2000), 0);
  });
  it('Flüsse gehen vor dem Netzwert, egal welches Vorzeichen die Anlage nutzt', () => {
    // Heute Nacht auf dem eHive: +124 = Einspeisung aus dem Akku, keine PV.
    const state = { meter: { grid_total_w: 124 }, victron: { solarToGridW: 0, gridImportW: 0, batteryDischargeW: 1835 } };
    assert.equal(surplusW(state, 0, { gridPositiveMeans: 'feed_in' }), 0);
  });
});

describe('surplusW: Rückfall auf den Netzwert mit dem Vorzeichen der Anlage', () => {
  it('feed_in: positiv = Einspeisung; Bezug ist kein Überschuss', () => {
    const cfg = { gridPositiveMeans: 'feed_in' };
    assert.equal(surplusW({ meter: { grid_total_w: 1500 } }, 500, cfg), 2000);
    assert.equal(surplusW({ meter: { grid_total_w: -185 } }, 0, cfg), 0, 'Netzbezug darf den Stab nicht einschalten');
    assert.equal(surplusW({ meter: { grid_total_w: -400 } }, 1200, cfg), 800);
  });
  it('noch keine Flüsse gemessen (null) → Netzwert', () => {
    const state = { meter: { grid_total_w: -900 }, victron: { solarToGridW: null, gridImportW: null, batteryDischargeW: null } };
    assert.equal(surplusW(state, 0), 900);
  });
});
