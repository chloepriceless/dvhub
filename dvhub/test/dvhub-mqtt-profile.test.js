// test/dvhub-mqtt-profile.test.js -- hersteller/dvhub-mqtt.json: Profil für
// Anlagen, deren Akku/PV/Zähler nur in Home Assistant oder Loxone existieren
// (2026-09-14). Vertrag: transport=mqtt, schema=dvhub, Topic-Prefix 'dvhub',
// jeder aktivierte Punkt hat ein Topic im DVhub-Schema, die Victron-
// spezifischen feedExcess-Punkte sind AUS.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfigFile } from '../config-model.js';
import { buildDvhubTopicMaps } from '../transport-mqtt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHIPPED_PROFILE = path.join(__dirname, '..', 'hersteller', 'dvhub-mqtt.json');

function setupTempConfig(persistedConfig) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-mqtt-profile-'));
  const manufacturerDir = path.join(rootDir, 'hersteller');
  fs.mkdirSync(manufacturerDir, { recursive: true });
  fs.copyFileSync(SHIPPED_PROFILE, path.join(manufacturerDir, 'dvhub-mqtt.json'));
  const configPath = path.join(rootDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(persistedConfig, null, 2));
  return configPath;
}

test('shipped dvhub-mqtt.json: transport mqtt, schema dvhub, Prefix dvhub, feedExcess aus', () => {
  const loaded = loadConfigFile(setupTempConfig({ manufacturer: 'dvhub-mqtt', victron: { host: '192.168.1.60' } }));
  assert.equal(loaded.manufacturerProfileError, null);
  const v = loaded.effectiveConfig.victron;
  assert.equal(v.transport, 'mqtt');
  assert.equal(v.mqtt.schema, 'dvhub');
  assert.equal(v.mqtt.topicPrefix, 'dvhub');
  assert.equal(loaded.effectiveConfig.controlWrite.gridSetpointW.enabled, true);
  assert.equal(loaded.effectiveConfig.controlWrite.minSocPct.enabled, true);
  assert.equal(loaded.effectiveConfig.dvControl.enabled, true);
  assert.equal(loaded.effectiveConfig.dvControl.feedExcessDcPv?.enabled ?? false, false, 'Victron-spezifisch: aus');
  assert.equal(loaded.effectiveConfig.dvControl.dontFeedExcessAcPv?.enabled ?? false, false);
  assert.equal(loaded.effectiveConfig.dvControl.negativePriceProtection.enabled, true);
});

test('jeder im Profil aktivierte Punkt hat ein Topic im DVhub-Schema', () => {
  const profile = JSON.parse(fs.readFileSync(SHIPPED_PROFILE, 'utf8'));
  const { READ_TOPICS, WRITE_TOPICS } = buildDvhubTopicMaps('dvhub');
  for (const [name, p] of Object.entries(profile.points || {})) {
    if (!p.enabled) continue;
    const ok = name === 'selfConsumptionW'
      ? ['selfConsumptionW_l1', 'selfConsumptionW_l2', 'selfConsumptionW_l3'].every(k => READ_TOPICS[k])
      : !!READ_TOPICS[name];
    assert.ok(ok, `Lesepunkt ${name} braucht ein Topic`);
  }
  for (const [name, w] of Object.entries(profile.controlWrite || {})) {
    if (!w.enabled) continue;
    assert.ok(WRITE_TOPICS[name], `Schreibziel ${name} braucht ein …/set-Topic`);
  }
});

test('Operator-Overrides: Broker und Prefix aus der Config, leere Werte fallen aufs Profil zurück', () => {
  const loaded = loadConfigFile(setupTempConfig({
    manufacturer: 'dvhub-mqtt',
    victron: { host: '192.168.1.60', mqtt: { broker: 'mqtt://192.168.1.34:1883', topicPrefix: '', schema: '' } }
  }));
  assert.equal(loaded.effectiveConfig.victron.mqtt.broker, 'mqtt://192.168.1.34:1883');
  assert.equal(loaded.effectiveConfig.victron.mqtt.topicPrefix, 'dvhub');
  assert.equal(loaded.effectiveConfig.victron.mqtt.schema, 'dvhub');
});
