// test/mqtt-publisher-control.test.js -- Steuerbefehle als retained
// MQTT-Topics (2026-09-14). Ein HA-Akku oder Loxone hängt sich an
// <prefix>/control/* und bekommt transparent, was DVhub gerade will —
// der Modbus-/Bridge-Pfad bleibt die Wahrheit, hier wird nur gespiegelt.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMqttPublisher } from '../services/mqtt/publisher.js';

function makeMockHub() {
  const published = [];
  return { publish(topic, payload, opts) { published.push({ topic, payload, opts }); }, get connected() { return true; }, _published: published };
}

const T0 = 1_789_000_000_000;

function makeState() {
  return {
    meter: { grid_total_w: 0, grid_l1_w: 0, grid_l2_w: 0, grid_l3_w: 0 },
    victron: { soc: 50, batteryPowerW: 0, minSocPct: 15, maxDischargeW: -1, pvTotalW: 0, pvPowerW: 0 },
    epex: { data: [] },
    ctrl: { discretionaryWritesPaused: false },
    schedule: {
      active: {
        gridSetpointW: { value: -2500, source: 'rule:peak', at: T0 },
        chargeCurrentA: { value: 30, source: 'default', at: T0 - 1000 },
        feedExcessDcPv: { value: 1, source: 'runtime', at: T0 + 500 }
      }
    },
    energy: {}
  };
}

function pubMap(hub) {
  const m = {};
  for (const p of hub._published) m[p.topic] = { value: JSON.parse(p.payload), retain: p.opts?.retain };
  return m;
}

describe('MQTT publisher — control/* topics', () => {
  it('publiziert die vier generischen Sollwerte retained unter <prefix>/control/', () => {
    const hub = makeMockHub();
    const state = makeState();
    const pub = createMqttPublisher(hub, { state, getCfg: () => ({ mqtt: { topicPrefix: 'dvhub' } }), pushLog: () => {} });
    pub._publishOnce();
    const m = pubMap(hub);
    assert.equal(m['dvhub/control/grid_setpoint_w'].value, -2500);
    assert.equal(m['dvhub/control/grid_setpoint_w'].retain, true);
    assert.equal(m['dvhub/control/charge_current_a'].value, 30);
    assert.equal(m['dvhub/control/min_soc_pct'].value, 15, 'Rücklesung, wenn kein aktiver Sollwert');
    assert.equal(m['dvhub/control/max_discharge_w'].value, -1);
    assert.equal(m['dvhub/control/source'].value, 'rule:peak');
    assert.equal(m['dvhub/control/rule'].value, 'peak');
    assert.equal(m['dvhub/control/updated_at'].value, new Date(T0).toISOString());
    assert.equal(m['dvhub/control/paused'].value, false);
    assert.equal(typeof m['dvhub/control/state'].value, 'object');
    assert.equal(m['dvhub/control/state'].value.gridSetpointW.value, -2500);
  });

  it('kein feed_excess-Topic — Victron-spezifisch', () => {
    const hub = makeMockHub();
    const pub = createMqttPublisher(hub, { state: makeState(), getCfg: () => ({ mqtt: {} }), pushLog: () => {} });
    pub._publishOnce();
    const topics = hub._published.map(p => p.topic);
    assert.equal(topics.some(t => /feed_excess|feedExcess/i.test(t)), false);
  });

  it('respektiert den Topic-Prefix und zählt die Control-Topics mit', () => {
    const hub = makeMockHub();
    const pub = createMqttPublisher(hub, { state: makeState(), getCfg: () => ({ mqtt: { topicPrefix: 'haus1' } }), pushLog: () => {} });
    pub._publishOnce();
    assert.ok(hub._published.some(p => p.topic === 'haus1/control/grid_setpoint_w'));
    assert.ok(pub.topicCount >= 29, `topicCount ${pub.topicCount} enthält die 9 Control-Topics`);
  });

  it('leerer Steuerzustand → null-Werte, source none (nie 0 erfinden)', () => {
    const hub = makeMockHub();
    const state = makeState();
    state.schedule.active = {};
    state.victron = {};
    const pub = createMqttPublisher(hub, { state, getCfg: () => ({ mqtt: {} }), pushLog: () => {} });
    pub._publishOnce();
    const m = pubMap(hub);
    assert.equal(m['dvhub/control/grid_setpoint_w'].value, null);
    assert.equal(m['dvhub/control/source'].value, 'none');
    assert.equal(m['dvhub/control/updated_at'].value, null);
  });
});
