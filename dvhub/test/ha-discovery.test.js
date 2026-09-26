// test/ha-discovery.test.js -- HA Auto-Discovery unit tests (INTG-03)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { publishHaDiscoveryTopics, clearHaDiscoveryTopics } from '../services/mqtt/ha-discovery.js';

function makeMockHub() {
  const published = [];
  return {
    publish(topic, payload, opts) { published.push({ topic, payload: typeof payload === 'string' ? JSON.parse(payload) : payload, opts }); },
    get connected() { return true; },
    _published: published
  };
}

describe('publishHaDiscoveryTopics', () => {
  it('exports publishHaDiscoveryTopics function', () => {
    assert.equal(typeof publishHaDiscoveryTopics, 'function');
  });

  it('does nothing when haDiscovery.enabled is false', () => {
    const hub = makeMockHub();
    publishHaDiscoveryTopics(hub, () => ({ mqtt: { haDiscovery: { enabled: false, prefix: 'homeassistant' }, topicPrefix: 'dvhub' } }));
    assert.equal(hub._published.length, 0);
  });

  it('publishes sensor configs when haDiscovery.enabled is true', () => {
    const hub = makeMockHub();
    publishHaDiscoveryTopics(hub, () => ({ mqtt: { haDiscovery: { enabled: true, prefix: 'homeassistant' }, topicPrefix: 'dvhub' } }));
    assert.ok(hub._published.length >= 6, `published ${hub._published.length} topics, expected >= 6`);
  });

  it('topics follow homeassistant/{sensor|binary_sensor|number|switch|select}/dvhub_*/config pattern', () => {
    const hub = makeMockHub();
    publishHaDiscoveryTopics(hub, () => ({ mqtt: { haDiscovery: { enabled: true, prefix: 'homeassistant' }, topicPrefix: 'dvhub' } }));
    for (const pub of hub._published) {
      // Seit 2026-09-26 auch steuerbare Komponenten (number/switch/select) für die
      // bidirektionale HA-Integration.
      assert.match(pub.topic, /^homeassistant\/(sensor|binary_sensor|number|switch|select)\/dvhub_\w+\/config$/, `topic ${pub.topic} matches pattern`);
    }
  });

  it('payloads are published with retain:true', () => {
    const hub = makeMockHub();
    publishHaDiscoveryTopics(hub, () => ({ mqtt: { haDiscovery: { enabled: true, prefix: 'homeassistant' }, topicPrefix: 'dvhub' } }));
    for (const pub of hub._published) {
      assert.equal(pub.opts?.retain, true, `topic ${pub.topic} should be retained`);
    }
  });

  it('payload includes device block with identifiers dvhub', () => {
    const hub = makeMockHub();
    publishHaDiscoveryTopics(hub, () => ({ mqtt: { haDiscovery: { enabled: true, prefix: 'homeassistant' }, topicPrefix: 'dvhub' } }));
    for (const pub of hub._published) {
      assert.ok(pub.payload.device, `${pub.topic} has device block`);
      assert.deepEqual(pub.payload.device.identifiers, ['dvhub']);
      assert.equal(pub.payload.device.name, 'DVhub');
      assert.equal(pub.payload.device.manufacturer, 'DVhub');
      assert.equal(pub.payload.device.model, 'HEMS');
    }
  });

  it('includes grid_power_w sensor', () => {
    const hub = makeMockHub();
    publishHaDiscoveryTopics(hub, () => ({ mqtt: { haDiscovery: { enabled: true, prefix: 'homeassistant' }, topicPrefix: 'dvhub' } }));
    const gridSensor = hub._published.find(p => p.topic.includes('dvhub_grid_power_w'));
    assert.ok(gridSensor, 'grid_power_w sensor found');
    assert.equal(gridSensor.payload.state_topic, 'dvhub/energy/grid_power_w');
    assert.equal(gridSensor.payload.unit_of_measurement, 'W');
  });

  it('includes battery_soc_pct sensor', () => {
    const hub = makeMockHub();
    publishHaDiscoveryTopics(hub, () => ({ mqtt: { haDiscovery: { enabled: true, prefix: 'homeassistant' }, topicPrefix: 'dvhub' } }));
    const socSensor = hub._published.find(p => p.topic.includes('dvhub_battery_soc_pct'));
    assert.ok(socSensor, 'battery_soc_pct sensor found');
    assert.equal(socSensor.payload.state_topic, 'dvhub/battery/soc_pct');
    assert.equal(socSensor.payload.unit_of_measurement, '%');
  });

  it('includes pv_total_w sensor', () => {
    const hub = makeMockHub();
    publishHaDiscoveryTopics(hub, () => ({ mqtt: { haDiscovery: { enabled: true, prefix: 'homeassistant' }, topicPrefix: 'dvhub' } }));
    const pvSensor = hub._published.find(p => p.topic.includes('dvhub_pv_total_w'));
    assert.ok(pvSensor, 'pv_total_w sensor found');
    assert.equal(pvSensor.payload.state_topic, 'dvhub/solar/pv_total_w');
    assert.equal(pvSensor.payload.unit_of_measurement, 'W');
  });

  it('includes epex price sensor (rate, no monetary device_class)', () => {
    const hub = makeMockHub();
    publishHaDiscoveryTopics(hub, () => ({ mqtt: { haDiscovery: { enabled: true, prefix: 'homeassistant' }, topicPrefix: 'dvhub' } }));
    const priceSensor = hub._published.find(p => p.topic.includes('dvhub_epex_price_ct_kwh'));
    assert.ok(priceSensor, 'epex_price_ct_kwh sensor found');
    assert.equal(priceSensor.payload.state_topic, 'dvhub/price/epex_current_ct_kwh');
    assert.equal(priceSensor.payload.unit_of_measurement, 'ct/kWh');
    // A ct/kWh rate is NOT a monetary total — device_class must be absent.
    assert.equal(priceSensor.payload.device_class, undefined);
  });

  it('publishes the energy counters as Energy-Dashboard grid sources', () => {
    const hub = makeMockHub();
    publishHaDiscoveryTopics(hub, () => ({ mqtt: { haDiscovery: { enabled: true, prefix: 'homeassistant' }, topicPrefix: 'dvhub' } }));
    for (const id of ['import_wh', 'export_wh']) {
      const s = hub._published.find(p => p.topic.includes('dvhub_' + id));
      assert.ok(s, id + ' sensor found');
      assert.equal(s.payload.device_class, 'energy');
      assert.equal(s.payload.state_class, 'total_increasing');
      assert.equal(s.payload.unit_of_measurement, 'Wh');
    }
  });

  it('payloads include an origin block naming DVhub', () => {
    const hub = makeMockHub();
    publishHaDiscoveryTopics(hub, () => ({ mqtt: { haDiscovery: { enabled: true, prefix: 'homeassistant' }, topicPrefix: 'dvhub' } }), '1.2.3');
    for (const pub of hub._published) {
      assert.ok(pub.payload.origin, `${pub.topic} has origin block`);
      assert.equal(pub.payload.origin.name, 'DVhub');
      assert.equal(pub.payload.unique_id, pub.topic.split('/')[2]);
    }
  });

  it('includes battery_power_w sensor', () => {
    const hub = makeMockHub();
    publishHaDiscoveryTopics(hub, () => ({ mqtt: { haDiscovery: { enabled: true, prefix: 'homeassistant' }, topicPrefix: 'dvhub' } }));
    const batSensor = hub._published.find(p => p.topic.includes('dvhub_battery_power_w'));
    assert.ok(batSensor, 'battery_power_w sensor found');
    assert.equal(batSensor.payload.state_topic, 'dvhub/battery/power_w');
    assert.equal(batSensor.payload.unit_of_measurement, 'W');
  });

  it('includes optimizer_status sensor', () => {
    const hub = makeMockHub();
    publishHaDiscoveryTopics(hub, () => ({ mqtt: { haDiscovery: { enabled: true, prefix: 'homeassistant' }, topicPrefix: 'dvhub' } }));
    const optSensor = hub._published.find(p => p.topic.includes('dvhub_optimizer_status'));
    assert.ok(optSensor, 'optimizer_status sensor found');
    assert.equal(optSensor.payload.state_topic, 'dvhub/optimizer/status');
  });

  it('uses custom prefix from config', () => {
    const hub = makeMockHub();
    publishHaDiscoveryTopics(hub, () => ({ mqtt: { haDiscovery: { enabled: true, prefix: 'custom_ha' }, topicPrefix: 'dvhub' } }));
    for (const pub of hub._published) {
      assert.ok(pub.topic.startsWith('custom_ha/'), `topic ${pub.topic} uses custom prefix`);
    }
  });
});

// --- Steuerbare Entitäten (2026-09-26, bidirektionale HA-Integration) --------
describe('publishHaDiscoveryTopics — steuerbare Entitäten', () => {
  const enabledCfg = () => ({ mqtt: { haDiscovery: { enabled: true, prefix: 'homeassistant' }, topicPrefix: 'dvhub' } });
  const find = (hub, idPart) => hub._published.find(p => p.topic.includes(idPart));

  it('grid-Sollwert: number mit command_topic, state_topic und Grenzen', () => {
    const hub = makeMockHub();
    publishHaDiscoveryTopics(hub, enabledCfg);
    const e = find(hub, 'homeassistant/number/dvhub_set_grid_setpoint_w');
    assert.ok(e, 'set_grid_setpoint_w number found');
    assert.equal(e.payload.command_topic, 'dvhub/cmd/grid_setpoint_w');
    assert.equal(e.payload.state_topic, 'dvhub/control/grid_setpoint_w');
    assert.equal(e.payload.unit_of_measurement, 'W');
    assert.equal(e.payload.mode, 'box');
    assert.equal(typeof e.payload.min, 'number');
    assert.equal(typeof e.payload.max, 'number');
    assert.ok(e.opts.retain === true);
  });

  it('min-SoC-number schnappt in 5%-Schritten (step=5)', () => {
    const hub = makeMockHub();
    publishHaDiscoveryTopics(hub, enabledCfg);
    const e = find(hub, 'dvhub_set_min_soc_pct');
    assert.equal(e.payload.command_topic, 'dvhub/cmd/min_soc_pct');
    assert.equal(e.payload.step, 5);
    assert.equal(e.payload.max, 100);
  });

  it('Not-Halt: switch mit command_topic und state_on aus control/paused', () => {
    const hub = makeMockHub();
    publishHaDiscoveryTopics(hub, enabledCfg);
    const e = find(hub, 'homeassistant/switch/dvhub_emergency_stop');
    assert.ok(e, 'emergency_stop switch found');
    assert.equal(e.payload.command_topic, 'dvhub/cmd/emergency_stop');
    assert.equal(e.payload.state_topic, 'dvhub/control/paused');
    assert.equal(e.payload.payload_on, 'ON');
    assert.equal(e.payload.state_on, 'true');
    assert.equal(e.payload.state_off, 'false');
  });

  it('Wallbox-Modus: select mit den vier evcc-Modi', () => {
    const hub = makeMockHub();
    publishHaDiscoveryTopics(hub, enabledCfg);
    const e = find(hub, 'homeassistant/select/dvhub_ev_mode');
    assert.ok(e, 'ev_mode select found');
    assert.equal(e.payload.command_topic, 'dvhub/cmd/ev/mode');
    assert.deepEqual(e.payload.options, ['off', 'pv', 'minpv', 'now']);
  });

  it('E-Auto-Mitplanung: switch auf cmd/ev/optimize', () => {
    const hub = makeMockHub();
    publishHaDiscoveryTopics(hub, enabledCfg);
    const e = find(hub, 'homeassistant/switch/dvhub_ev_optimize');
    assert.ok(e, 'ev_optimize switch found');
    assert.equal(e.payload.command_topic, 'dvhub/cmd/ev/optimize');
    assert.equal(e.payload.state_topic, 'dvhub/ev/optimize');
  });

  it('schaltbare Geräte werden als dynamische switches ergänzt', () => {
    const hub = makeMockHub();
    const devices = [
      { id: 'shelly-plug-1', name: 'Waschmaschine', output: false },
      { id: 'sensor-only', name: 'Nur Messung', output: null }, // kein switch
    ];
    publishHaDiscoveryTopics(hub, enabledCfg, '1.0', devices);
    const sw = find(hub, 'homeassistant/switch/dvhub_device_shelly_plug_1');
    assert.ok(sw, 'device switch found');
    assert.equal(sw.payload.command_topic, 'dvhub/cmd/device/shelly-plug-1');
    assert.equal(sw.payload.state_topic, 'dvhub/device/shelly-plug-1/state');
    // Nur-Mess-Gerät bekommt keinen switch.
    assert.equal(hub._published.some(p => p.topic.includes('dvhub_device_sensor_only')), false);
  });

  it('command entities are cleared on clearHaDiscoveryTopics', () => {
    // Roh-Mock: clear sendet leere Payloads, die der JSON-parsende Mock nicht mag.
    const published = [];
    const hub = { publish(topic, payload, opts) { published.push({ topic, payload, opts }); }, get connected() { return true; } };
    clearHaDiscoveryTopics(hub, enabledCfg, undefined, [{ id: 'shelly-1', name: 'X', output: true }]);
    const e = published.find(p => p.topic.includes('homeassistant/number/dvhub_set_grid_setpoint_w'));
    assert.ok(e, 'number config cleared');
    assert.equal(e.payload, ''); // leerer retained Payload = entfernt
    assert.equal(e.opts.retain, true);
    assert.ok(published.some(p => p.topic.includes('dvhub_device_shelly_1')), 'device config cleared too');
  });
});
