// MQTT-PAYLOAD-FIX (Kundenfall 2026-10-02, Deye-Bridge „deye1“):
// End-to-End-Beweis gegen einen echten lokalen Broker (aedes, wie der
// eingebaute Hub), dass der Venus-Transport (N/ W/ R/) beide Payload-Formate
// verarbeitet — das dokumentierte {"value": X} (docs/DEYE-NODERED-BRIDGE.md)
// UND nackte Zahlen, wie sie die im Feld vorgefundene Bridge publiziert.
// Ohne den Fix im Venus-Zweig von transport-mqtt.js bleiben alle Werte null
// und dieser Test ist rot (derselbe Fall, der als „MQTT-Wert nicht verfügbar
// oder veraltet“ im State auftrat).
//
// Installationsort im Repo: dvhub/test/bridge-mqtt-venus-bare-payload.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { Aedes } from 'aedes';
import mqtt from 'mqtt';

import { createMqttTransport } from '../transport-mqtt.js';

async function startBroker() {
  const broker = await Aedes.createBroker();
  return new Promise((resolve, reject) => {
    const server = net.createServer(broker.handle);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ broker, server, port: server.address().port }));
  });
}

// Fake-Bridge nach dem im Feld vorgefundenen Verhalten: antwortet auf R/-
// Nachforderungen und Keepalive mit nackten Zahlen auf N/deye1/…
function startBareBridge(port, portalId, { bare = true, extras = {} } = {}) {
  const client = mqtt.connect(`mqtt://127.0.0.1:${port}`);
  const ready = new Promise((resolve, reject) => {
    client.once('connect', () => {
      client.subscribe([`R/${portalId}/#`, `W/${portalId}/#`], (err) => (err ? reject(err) : resolve()));
    });
    client.once('error', reject);
  });
  const enc = (v) => (bare ? String(v) : JSON.stringify({ value: v }));
  client.on('message', (topic) => {
    if (topic !== `R/${portalId}/keepalive`) return;
    client.publish(`N/${portalId}/system/0/Dc/Battery/Soc`, enc(26));
    client.publish(`N/${portalId}/system/0/Dc/Battery/Power`, enc(-952));
    client.publish(`N/${portalId}/system/0/Ac/Grid/L1/Power`, enc(-1));
    client.publish(`N/${portalId}/system/0/Ac/Grid/L2/Power`, enc(22));
    client.publish(`N/${portalId}/system/0/Ac/Grid/L3/Power`, enc(0));
    client.publish(`N/${portalId}/system/0/Dc/Pv/Power`, enc(0));
    for (const [t, v] of Object.entries(extras)) client.publish(t, typeof v === 'string' ? v : enc(v));
  });
  return { client, ready };
}

test('Venus-Transport nimmt nackte Zahlen aus der Bridge (Kundenfall deye1)', async () => {
  const { broker, server, port } = await startBroker();
  const bridge = startBareBridge(port, 'deye1', { bare: true });
  let transport = null;
  try {
    await bridge.ready;
    transport = createMqttTransport({
      host: '127.0.0.1',
      mqtt: { portalId: 'deye1', broker: `mqtt://127.0.0.1:${port}` }
    });
    assert.equal(transport.schema, 'venus');
    await transport.init();

    // vorgefundene Werte aus dem pcap: SoC 26 %, Batterie -952 W, Phasen -1/22/0
    assert.equal((await transport.readPoint('soc')).mqttValue, 26);
    assert.equal((await transport.readPoint('batteryPowerW')).mqttValue, -952);
    assert.equal(transport.getCached('meter_l1'), -1);
    assert.equal(transport.getCached('meter_l2'), 22);
    assert.equal(transport.getCached('meter_l3'), 0);
    assert.equal(transport.getCached('pvPowerW'), 0, 'echte 0 darf nicht als „kein Wert“ verschwinden');
    // Phasensumme (meter_total-Pfad des Pollers) muss aus den Phasen entstehen
    assert.equal(transport.getCached('meter_l1') + transport.getCached('meter_l2') + transport.getCached('meter_l3'), 21);
  } finally {
    if (transport) await transport.destroy();
    bridge.client.end(true);
    await new Promise((r) => broker.close(() => server.close(r)));
  }
});

test('Venus-Transport nimmt weiterhin das dokumentierte {"value": X}-Format', async () => {
  const { broker, server, port } = await startBroker();
  const bridge = startBareBridge(port, 'deye1', { bare: false });
  let transport = null;
  try {
    await bridge.ready;
    transport = createMqttTransport({
      host: '127.0.0.1',
      mqtt: { portalId: 'deye1', broker: `mqtt://127.0.0.1:${port}` }
    });
    await transport.init();
    assert.equal((await transport.readPoint('soc')).mqttValue, 26);
    assert.equal((await transport.readPoint('batteryPowerW')).mqttValue, -952);
  } finally {
    if (transport) await transport.destroy();
    bridge.client.end(true);
    await new Promise((r) => broker.close(() => server.close(r)));
  }
});

test('unverwertbare Payloads werden ignoriert, aber sichtbar gemeldet', async () => {
  const { broker, server, port } = await startBroker();
  const topic = 'N/deye1/system/0/Dc/Battery/Soc';
  const warn = [];
  const realWarn = console.warn;
  console.warn = (...args) => warn.push(args.join(' '));
  let transport = null;
  try {
    transport = createMqttTransport({
      host: '127.0.0.1',
      mqtt: { portalId: 'deye1', broker: `mqtt://127.0.0.1:${port}` }
    });
    // leer (Keepalive-Echo) und Text → nichts im Cache, aber eine Warnung
    transport._onMessage(topic, Buffer.from(''), { retain: false });
    transport._onMessage(topic, Buffer.from('unavailable'), { retain: false });
    assert.equal(Object.keys(transport._cacheSnapshot()).length, 0, 'Müll darf keinen Wert erzeugen');
    assert.equal(transport.getCached('soc'), null);
    assert.equal(warn.length, 1, `genau eine (entprellte) Warnung, kamen: ${JSON.stringify(warn)}`);
    assert.match(warn[0], /nicht verwertbar/);
    assert.match(warn[0], /Dc\/Battery\/Soc/);
    // {"value": null} = „Lieferant meldet unbekannt“ → wird gespeichert, nicht erfunden
    transport._onMessage(topic, Buffer.from('{"value":null}'), { retain: false });
    assert.equal(transport._cacheSnapshot()[topic].value, null);
    // retained Replay bleibt verworfen (T-MQTT-RETAIN darf der Fix nicht aushebeln)
    transport._onMessage(topic, Buffer.from('26'), { retain: true });
    assert.equal(transport._cacheSnapshot()[topic].value, null, 'retained Replay ist kein Frische-Beweis');
  } finally {
    console.warn = realWarn;
    if (transport) await transport.destroy();
    await new Promise((r) => broker.close(() => server.close(r)));
  }
});
