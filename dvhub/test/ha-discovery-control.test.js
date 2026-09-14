// test/ha-discovery-control.test.js -- HA-Auto-Discovery für die
// control/*-Topics (2026-09-14): Home Assistant zeigt die DVhub-Sollwerte
// automatisch als Entitäten, ohne dass der Nutzer Topics abtippen muss.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { publishHaDiscoveryTopics } from '../services/mqtt/ha-discovery.js';

function makeHub() {
  const published = [];
  return { publish(topic, payload, opts) { published.push({ topic, payload: JSON.parse(payload), opts }); }, get connected() { return true; }, _published: published };
}

describe('HA discovery — control entities', () => {
  it('publiziert Sollwert-Sensoren mit Einheit und ohne Mess-device_class', () => {
    const hub = makeHub();
    const n = publishHaDiscoveryTopics(hub, () => ({ mqtt: { topicPrefix: 'dvhub', haDiscovery: { enabled: true, prefix: 'homeassistant' } } }), '1.0.7');
    assert.ok(n >= 6, `mindestens die bisherigen plus 6 Control-Entitäten (n=${n})`);
    const byId = {};
    for (const p of hub._published) byId[p.payload.unique_id] = p;
    const gs = byId['dvhub_control_grid_setpoint_w'];
    assert.ok(gs, 'control_grid_setpoint_w vorhanden');
    assert.equal(gs.topic, 'homeassistant/sensor/dvhub_control_grid_setpoint_w/config');
    assert.equal(gs.payload.state_topic, 'dvhub/control/grid_setpoint_w');
    assert.equal(gs.payload.unit_of_measurement, 'W');
    assert.equal(gs.payload.device_class, undefined, 'Sollwert ist keine Messung → keine power-Klasse');
    assert.equal(byId['dvhub_control_charge_current_a'].payload.unit_of_measurement, 'A');
    assert.equal(byId['dvhub_control_min_soc_pct'].payload.unit_of_measurement, '%');
    assert.equal(byId['dvhub_control_max_discharge_w'].payload.unit_of_measurement, 'W');
    assert.equal(byId['dvhub_control_source'].payload.state_topic, 'dvhub/control/source');
    assert.equal(byId['dvhub_control_updated_at'].payload.device_class, 'timestamp');
    assert.ok(!Object.keys(byId).some(id => /feed_excess/.test(id)), 'kein Victron-spezifisches feed_excess');
    for (const p of hub._published) assert.equal(p.opts?.retain, true, 'Discovery-Configs sind retained');
  });
});
