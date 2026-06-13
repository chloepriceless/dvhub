// test/ha-discovery.test.js -- HA Auto-Discovery unit tests (INTG-03)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { publishHaDiscoveryTopics } from '../services/mqtt/ha-discovery.js';

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

  it('topics follow homeassistant/{sensor|binary_sensor}/dvhub_*/config pattern', () => {
    const hub = makeMockHub();
    publishHaDiscoveryTopics(hub, () => ({ mqtt: { haDiscovery: { enabled: true, prefix: 'homeassistant' }, topicPrefix: 'dvhub' } }));
    for (const pub of hub._published) {
      assert.match(pub.topic, /^homeassistant\/(sensor|binary_sensor)\/dvhub_\w+\/config$/, `topic ${pub.topic} matches pattern`);
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
