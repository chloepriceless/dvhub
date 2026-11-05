// test/transport-mqtt-grid-voltage.test.js — Victron MQTT: Netzspannung L1–L3
// und Frequenz aus den Grid-Topics (N/<portal>/grid/<instanz>/Ac/...), Frische
// wie bei den übrigen Werten; DVhub-Schema kennt keine Spannungen.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createMqttTransport } from '../transport-mqtt.js';

const msg = (t, topic, value) => t._onMessage(topic, Buffer.from(JSON.stringify({ value })), { retain: false });

test('Venus: Spannungen + Frequenz des Netzzählers aus grid/<instanz>/Ac', () => {
  const t = createMqttTransport({ host: 'gx', mqtt: { portalId: 'p1' } });
  assert.equal(t.readGridVoltage(), null, 'noch nichts empfangen');
  msg(t, 'N/p1/grid/40/Ac/L1/Voltage', 238.2);
  msg(t, 'N/p1/grid/40/Ac/L2/Voltage', 237.1);
  msg(t, 'N/p1/grid/40/Ac/L3/Voltage', 237.4);
  msg(t, 'N/p1/grid/40/Ac/Frequency', 49.98);
  const g = t.readGridVoltage();
  assert.deepEqual([g.l1, g.l2, g.l3, g.frequencyHz, g.instance], [238.2, 237.1, 237.4, 49.98, '40']);
  assert.ok(g.ts > 0);
});

test('Venus: einphasiger Zähler → L2/L3 null; {"value":null} = unbekannt', () => {
  const t = createMqttTransport({ host: 'gx', mqtt: { portalId: 'p1' } });
  msg(t, 'N/p1/grid/31/Ac/L1/Voltage', 231);
  msg(t, 'N/p1/grid/31/Ac/L2/Voltage', null);
  const g = t.readGridVoltage();
  assert.deepEqual([g.l1, g.l2, g.l3, g.frequencyHz], [231, null, null, null]);
});

test('Venus: veraltete Spannungen (staleMaxAgeMs) → null', () => {
  const t = createMqttTransport({ host: 'gx', mqtt: { portalId: 'p1', staleMaxAgeMs: 1000 } });
  const realNow = Date.now;
  try {
    msg(t, 'N/p1/grid/40/Ac/L1/Voltage', 238);
    Date.now = () => realNow() + 5000;
    assert.equal(t.readGridVoltage(), null);
  } finally {
    Date.now = realNow;
  }
});

test('DVhub-Schema: keine Spannungs-Topics → immer null', () => {
  const t = createMqttTransport({ host: 'x', mqtt: { schema: 'dvhub', topicPrefix: 'dvhub' } });
  t._onMessage('N/p1/grid/40/Ac/L1/Voltage', Buffer.from('238'), { retain: false });
  assert.equal(t.readGridVoltage(), null);
});

test('Venus: Abo der Grid-Spannungs-Topics (Wildcard je Instanz) beim Verbinden', async () => {
  let subscribed = [];
  const connectFn = () => {
    const fake = new EventEmitter();
    fake.subscribe = (topics, opts, cb) => { subscribed = topics; (typeof opts === 'function' ? opts : cb)?.(null); };
    fake.publish = () => {};
    fake.end = () => {};
    setImmediate(() => fake.emit('connect'));
    return fake;
  };
  const t = createMqttTransport({ host: 'gx', mqtt: { broker: 'mqtt://127.0.0.1:1883', portalId: 'p1' } }, { connectFn });
  try {
    await t.init();
    for (const topic of ['N/p1/grid/+/Ac/L1/Voltage', 'N/p1/grid/+/Ac/L2/Voltage', 'N/p1/grid/+/Ac/L3/Voltage', 'N/p1/grid/+/Ac/Frequency']) {
      assert.ok(subscribed.includes(topic), topic);
    }
  } finally {
    await t.destroy();
  }
});
