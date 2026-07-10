// D-27 Universal-MQTT-Vendor-Pack: hersteller/bridge-mqtt.json ist das
// offizielle Profil für den "virtuellen GX" (jeder fremde Wechselrichter über
// eine MQTT-Bridge, docs/DEYE-NODERED-BRIDGE.md). Diese Tests laden die ECHTE
// shipped Profildatei und prüfen den Vertrag: transport=mqtt, portalId-Default
// 'dvhub', Operator-Overrides für Broker/Portal-ID aus der persistierten Config
// (leere Werte fallen auf den Profil-Default zurück) und Topic-Abdeckung aller
// im Profil aktivierten Punkte in buildVenusTopicMaps.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfigFile } from '../config-model.js';
import { buildVenusTopicMaps } from '../transport-mqtt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHIPPED_PROFILE = path.join(__dirname, '..', 'hersteller', 'bridge-mqtt.json');

function setupTempConfig(persistedConfig) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-bridge-mqtt-'));
  const manufacturerDir = path.join(rootDir, 'hersteller');
  fs.mkdirSync(manufacturerDir, { recursive: true });
  fs.copyFileSync(SHIPPED_PROFILE, path.join(manufacturerDir, 'bridge-mqtt.json'));
  const configPath = path.join(rootDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(persistedConfig, null, 2));
  return configPath;
}

test('shipped bridge-mqtt.json loads as manufacturer profile with mqtt transport and dvhub portal default', () => {
  const configPath = setupTempConfig({
    manufacturer: 'bridge-mqtt',
    victron: { host: '192.168.1.50' }
  });

  const loaded = loadConfigFile(configPath);

  assert.equal(loaded.manufacturerProfileError, null);
  assert.equal(loaded.effectiveConfig.victron.transport, 'mqtt');
  assert.equal(loaded.effectiveConfig.victron.host, '192.168.1.50');
  assert.equal(loaded.effectiveConfig.victron.mqtt.portalId, 'dvhub');
  assert.equal(loaded.effectiveConfig.victron.mqtt.broker, '');
  // Steuerpfad-Vertrag: die Targets, die applyControlTarget/dv-control nutzen,
  // sind im Profil aktiviert.
  assert.equal(loaded.effectiveConfig.controlWrite.gridSetpointW.enabled, true);
  assert.equal(loaded.effectiveConfig.controlWrite.minSocPct.enabled, true);
  assert.equal(loaded.effectiveConfig.controlWrite.maxDischargeW.enabled, true);
  assert.equal(loaded.effectiveConfig.dvControl.enabled, true);
  assert.equal(loaded.effectiveConfig.dvControl.negativePriceProtection.gridSetpointW, -40);
});

test('persisted victron.mqtt overrides the profile defaults (operator-configurable, D-27)', () => {
  const configPath = setupTempConfig({
    manufacturer: 'bridge-mqtt',
    victron: {
      host: '192.168.1.50',
      mqtt: { broker: 'mqtt://10.0.0.2:1883', portalId: 'deye1' }
    }
  });

  const loaded = loadConfigFile(configPath);

  assert.equal(loaded.effectiveConfig.victron.mqtt.broker, 'mqtt://10.0.0.2:1883');
  assert.equal(loaded.effectiveConfig.victron.mqtt.portalId, 'deye1');
  // Nicht überschriebene Felder behalten den Profil-Default.
  assert.equal(loaded.effectiveConfig.victron.mqtt.keepaliveIntervalMs, 30000);
  // victron.mqtt darf beim Laden nicht mehr als manufacturer-managed gestrippt
  // werden (sonst wäre der Override wirkungslos und ginge beim Save verloren).
  const warnings = loaded.warnings || [];
  assert.equal(warnings.some((w) => String(w).startsWith('victron.mqtt')), false);
});

test('empty persisted mqtt values fall back to the profile default instead of erasing it', () => {
  // Ein leer gespeichertes GUI-Feld ('') bedeutet "Profil-Default gilt" — es
  // darf die portalId 'dvhub' aus dem Profil nicht auslöschen.
  const configPath = setupTempConfig({
    manufacturer: 'bridge-mqtt',
    victron: {
      host: '192.168.1.50',
      mqtt: { broker: '', portalId: '' }
    }
  });

  const loaded = loadConfigFile(configPath);

  assert.equal(loaded.effectiveConfig.victron.mqtt.portalId, 'dvhub');
  assert.equal(loaded.effectiveConfig.victron.mqtt.broker, '');
});

test('victron profile setups stay on modbus — persisted mqtt block does not flip the transport', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-bridge-mqtt-victron-'));
  const manufacturerDir = path.join(rootDir, 'hersteller');
  fs.mkdirSync(manufacturerDir, { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, '..', 'hersteller', 'victron.json'),
    path.join(manufacturerDir, 'victron.json')
  );
  const configPath = path.join(rootDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    manufacturer: 'victron',
    victron: {
      host: 'venus-gx.local',
      // transport bleibt manufacturer-managed: ein persistierter Wert wird
      // weiterhin gestrippt und kann das Profil nicht umstellen.
      transport: 'mqtt',
      mqtt: { portalId: 'c0619ab8db22' }
    }
  }, null, 2));

  const loaded = loadConfigFile(configPath);

  assert.equal(loaded.effectiveConfig.victron.transport, 'modbus');
  assert.equal((loaded.warnings || []).some((w) => String(w).startsWith('victron.transport')), true);
  // Aber die Portal-ID ist jetzt operator-editierbar (echter GX via späterem
  // MQTT-Profil braucht seine VRM-ID) und überlebt den Profil-Merge.
  assert.equal(loaded.effectiveConfig.victron.mqtt.portalId, 'c0619ab8db22');
});

test('every point/write target enabled in bridge-mqtt.json is covered by the Venus topic maps', () => {
  const profile = JSON.parse(fs.readFileSync(SHIPPED_PROFILE, 'utf8'));
  const { READ_TOPICS, WRITE_TOPICS } = buildVenusTopicMaps(profile.victron.mqtt.portalId);

  for (const [name, conf] of Object.entries(profile.points || {})) {
    if (!conf?.enabled) continue;
    // 'selfConsumptionW' ist der Summen-Sonderfall aus den drei Phasen-Topics
    // (T-MQTT-CONSUMPTION) — der Transport bedient ihn ohne direktes Topic.
    if (name === 'selfConsumptionW') {
      assert.ok(READ_TOPICS.selfConsumptionW_l1, 'consumption phase topics missing');
      continue;
    }
    assert.ok(READ_TOPICS[name], `read topic missing for enabled point: ${name}`);
  }

  for (const [name, conf] of Object.entries(profile.controlWrite || {})) {
    if (!conf?.enabled) continue;
    assert.ok(WRITE_TOPICS[name], `write topic missing for enabled controlWrite target: ${name}`);
  }

  for (const [name, conf] of Object.entries(profile.dvControl || {})) {
    if (name === 'enabled' || name === 'negativePriceProtection') continue;
    if (!conf?.enabled) continue;
    assert.ok(WRITE_TOPICS[name], `write topic missing for enabled dvControl target: ${name}`);
  }

  // Profil-Label ist reine Anzeige (listManufacturerProfiles) und darf nie in
  // die effektive Config gelangen.
  assert.equal(typeof profile.label, 'string');
  const configPath = setupTempConfig({ manufacturer: 'bridge-mqtt', victron: { host: 'h' } });
  const loaded = loadConfigFile(configPath);
  assert.equal(loaded.effectiveConfig.label, undefined);
});
