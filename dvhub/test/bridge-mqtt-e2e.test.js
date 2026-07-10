// D-27 Universal-MQTT-Pack — End-to-End-Beweis gegen einen ECHTEN lokalen
// MQTT-Broker (aedes, wie der eingebaute Hub): das shipped Profil
// hersteller/bridge-mqtt.json wird über loadConfigFile zur effektiven Config,
// daraus entsteht der echte MQTT-Transport, und eine Fake-Bridge (Vertrag aus
// docs/DEYE-NODERED-BRIDGE.md: R/-Keepalive → N/-Vollpublikation, W/-Kommandos)
// beantwortet Lese- und Schreibpfad. Beweist, dass Profil, Topic-Schema und
// Transport zusammenpassen — ohne Hardware, ohne Netz.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Aedes } from 'aedes';
import mqtt from 'mqtt';

import { loadConfigFile } from '../config-model.js';
import { createMqttTransport } from '../transport-mqtt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function startBroker() {
  const broker = await Aedes.createBroker();
  return new Promise((resolve, reject) => {
    const server = net.createServer(broker.handle);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ broker, server, port: server.address().port });
    });
  });
}

test('bridge-mqtt profile drives the real MQTT transport end-to-end (read + write)', async () => {
  const { broker, server, port } = await startBroker();
  let bridgeClient = null;
  let transport = null;
  try {
    // Effektive Config aus dem SHIPPED Universal-Profil laden — nur die zwei
    // Operator-Felder sind gesetzt (Broker explizit, Portal-ID bleibt Default).
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-bridge-e2e-'));
    fs.mkdirSync(path.join(rootDir, 'hersteller'), { recursive: true });
    fs.copyFileSync(
      path.join(__dirname, '..', 'hersteller', 'bridge-mqtt.json'),
      path.join(rootDir, 'hersteller', 'bridge-mqtt.json')
    );
    const configPath = path.join(rootDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      manufacturer: 'bridge-mqtt',
      victron: { host: '127.0.0.1', mqtt: { broker: `mqtt://127.0.0.1:${port}` } }
    }));
    const loaded = loadConfigFile(configPath);
    assert.equal(loaded.effectiveConfig.victron.transport, 'mqtt');
    const portalId = loaded.effectiveConfig.victron.mqtt.portalId;
    assert.equal(portalId, 'dvhub');

    // Fake-Bridge nach Doku-Vertrag: Keepalive beantworten, W/-Topics sammeln.
    const receivedWrites = [];
    bridgeClient = mqtt.connect(`mqtt://127.0.0.1:${port}`);
    await new Promise((resolve, reject) => {
      bridgeClient.once('connect', () => {
        bridgeClient.subscribe([`R/${portalId}/#`, `W/${portalId}/#`], (err) => (err ? reject(err) : resolve()));
      });
      bridgeClient.once('error', reject);
    });
    bridgeClient.on('message', (topic) => {
      if (topic === `R/${portalId}/keepalive`) {
        bridgeClient.publish(`N/${portalId}/system/0/Dc/Battery/Soc`, JSON.stringify({ value: 57 }));
        bridgeClient.publish(`N/${portalId}/system/0/Dc/Battery/Power`, JSON.stringify({ value: -1200 }));
      }
    });
    bridgeClient.on('message', (topic, payload) => {
      if (topic.startsWith(`W/${portalId}/`)) {
        receivedWrites.push({ topic, payload: JSON.parse(payload.toString()) });
      }
    });

    // Echter Transport aus der effektiven Config (init sendet das Keepalive).
    transport = createMqttTransport(loaded.effectiveConfig.victron);
    await transport.init();

    // Lesepfad: die Keepalive-Antwort der Bridge landet als frischer Wert.
    const soc = await transport.readPoint('soc');
    assert.equal(soc.mqttValue, 57);
    const batteryPower = await transport.readPoint('batteryPowerW');
    assert.equal(batteryPower.mqttValue, -1200);

    // Schreibpfad: Engineering-Wert kommt als {"value": …} auf dem W/-Topic an.
    await transport.mqttWrite('gridSetpointW', -2000);
    await new Promise((r) => setTimeout(r, 300));
    const setpoint = receivedWrites.find(
      (w) => w.topic === `W/${portalId}/settings/0/Settings/CGwacs/AcPowerSetPoint`
    );
    assert.ok(setpoint, 'bridge must receive the grid setpoint write');
    assert.equal(setpoint.payload.value, -2000);
  } finally {
    if (transport) await transport.destroy();
    if (bridgeClient) bridgeClient.end(true);
    await new Promise((r) => broker.close(() => server.close(r)));
  }
});
