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

// Codex-Gegenprüfung 7f88bc74 (P2): alte Frequenz darf nicht mit der Zeit
// frischer Spannungen als frisch durchgehen.
test('Venus: Messzeit = älteste verwendete Größe, auch die Frequenz', () => {
  const t = createMqttTransport({ host: 'gx', mqtt: { portalId: 'p1', staleMaxAgeMs: 0 } });
  const realNow = Date.now;
  try {
    const t0 = realNow();
    Date.now = () => t0 - 180_000;
    msg(t, 'N/p1/grid/40/Ac/Frequency', 49.7);
    Date.now = () => t0;
    msg(t, 'N/p1/grid/40/Ac/L1/Voltage', 238);
    const g = t.readGridVoltage();
    assert.equal(g.frequencyHz, 49.7);
    assert.equal(g.ts, t0 - 180_000);
  } finally {
    Date.now = realNow;
  }
});

test('Venus: Empfangszeit je Phase (phaseTs) für die Datenspende', () => {
  const t = createMqttTransport({ host: 'gx', mqtt: { portalId: 'p1' } });
  msg(t, 'N/p1/grid/40/Ac/L1/Voltage', 238);
  msg(t, 'N/p1/grid/40/Ac/L3/Voltage', 237);
  const g = t.readGridVoltage();
  assert.equal(g.phaseTs.length, 3);
  assert.ok(g.phaseTs[0] > 0 && g.phaseTs[2] > 0);
  assert.equal(g.phaseTs[1], null);
});

// Codex-Gegenprüfung 19f1d2bf (P2): {"value":null} für alle Phasen ist eine
// ausdrückliche Ungültig-Meldung, kein abgerissener Zufluss.
test('Venus: alle Phasen {"value":null} → invalidated statt null', () => {
  const t = createMqttTransport({ host: 'gx', mqtt: { portalId: 'p1' } });
  msg(t, 'N/p1/grid/40/Ac/L1/Voltage', 238);
  msg(t, 'N/p1/grid/40/Ac/L1/Voltage', null);
  const g = t.readGridVoltage();
  assert.equal(g.invalidated, true);
  assert.deepEqual([g.l1, g.l2, g.l3], [null, null, null]);
});

// Codex-Gegenprüfung 186f688f (P2): einphasiger Zähler — L1 läuft ab, während
// L2/L3 weiter {"value":null} senden. Das ist „veraltet“, nicht „ungültig“.
test('Venus: L1 abgelaufen, L2/L3 senden null → nicht invalidated (null = veraltet)', () => {
  const t = createMqttTransport({ host: 'gx', mqtt: { portalId: 'p1', staleMaxAgeMs: 90_000 } });
  const realNow = Date.now;
  try {
    const t0 = realNow();
    Date.now = () => t0;
    msg(t, 'N/p1/grid/31/Ac/L1/Voltage', 231);
    Date.now = () => t0 + 60_000;
    msg(t, 'N/p1/grid/31/Ac/L2/Voltage', null);
    msg(t, 'N/p1/grid/31/Ac/L3/Voltage', null);
    Date.now = () => t0 + 91_000;
    assert.equal(t.readGridVoltage(), null, 'L1 nur abgelaufen, nicht ungültig gemeldet');
    // Meldet danach auch L1 null, hat keine Phase mehr einen Zahlenwert → ungültig.
    msg(t, 'N/p1/grid/31/Ac/L1/Voltage', null);
    assert.equal(t.readGridVoltage().invalidated, true);
  } finally {
    Date.now = realNow;
  }
});
