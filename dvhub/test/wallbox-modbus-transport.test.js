// Modbus-Wallboxen brauchen einen echten Modbus-Transport — auch wenn die Anlage selbst
// per MQTT angebunden ist (victron.transport = 'mqtt', z. B. HA/Loxone-Schema). Der
// MQTT-Transport hat kein mbRequest; KEBA, Heidelberg & Co. meldeten dort nur
// „Modbus nicht verfügbar“ (gefunden 2026-10-20).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MODBUS_WALLBOXES = ['charx', 'keba', 'heidelberg', 'bender', 'salia', 'peblar', 'abl', 'nexblue', 'em2go', 'phoenix'];

test('Modbus-Wallboxen nutzen wallboxModbus (bei MQTT-Anlage der eigene Modbus-Transport)', () => {
  const src = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(src, /const wallboxModbus = \(\) => \(transport\.type === 'modbus' \? transport : scanTransport\);/);
  for (const t of MODBUS_WALLBOXES) {
    const line = src.split('\n').find((l) => l.includes(`if (type === '${t}') return`));
    assert.ok(line, `${t} fehlt in directWallboxAdapter`);
    assert.match(line, /getTransport: wallboxModbus/, `${t} nutzt nicht wallboxModbus`);
  }
});
