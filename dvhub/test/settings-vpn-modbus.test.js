// test/settings-vpn-modbus.test.js — Zeile „Letzte Modbus-Abfrage“ und
// Port-Hinweis im VPN-Bereich (Support-Fall 2026-10-15, LUOX): Der Bereich
// zeigte keine Modbus-Aktivität, und DVhub lauschte auf 1502, während LUOX
// Port 502 abfragt.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function loadHelpers() {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../public/settings.js'), 'utf8');
  const sandbox = { console, globalThis: {}, window: { DVhubCommon: { escapeHtml: (v) => String(v ?? '') }, addEventListener() {}, setTimeout() {} } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, sandbox, { filename: 'settings.js' });
  return sandbox.DVhubSettingsVpn;
}

const NOW = Date.parse('2026-10-15T17:25:44Z');

test('letzte Abfrage mit Alter und Absender, Port 502 ohne Hinweis', () => {
  const { vpnModbusInfo } = loadHelpers();
  const r = vpnModbusInfo({ lastModbusActivity: { ts: NOW - 5 * 60000, remote: '10.12.0.4' }, modbusListenPort: 502 }, NOW);
  assert.equal(r.activity, 'Letzte Modbus-Abfrage: vor 5 min von 10.12.0.4');
  assert.equal(r.portHint, null);
});

test('noch keine Abfrage', () => {
  const { vpnModbusInfo } = loadHelpers();
  const r = vpnModbusInfo({ lastModbusActivity: null, modbusListenPort: 502 }, NOW);
  assert.equal(r.activity, 'Letzte Modbus-Abfrage: noch keine seit dem Start');
});

test('anderer Port als 502 → Hinweis', () => {
  const { vpnModbusInfo } = loadHelpers();
  const r = vpnModbusInfo({ lastModbusActivity: { ts: NOW - 30000, remote: '10.12.0.4' }, modbusListenPort: 1502 }, NOW);
  assert.equal(r.activity, 'Letzte Modbus-Abfrage: vor 30 s von 10.12.0.4');
  assert.equal(r.portHint, 'DVhub lauscht auf Port 1502 — Direktvermarkter wie LUOX fragen meist Port 502 ab (Einstellungen → System → Modbus Listen Port).');
});

test('Alter in Stunden', () => {
  const { vpnModbusInfo } = loadHelpers();
  const r = vpnModbusInfo({ lastModbusActivity: { ts: NOW - 3 * 3600000, remote: '10.12.0.4' }, modbusListenPort: 502 }, NOW);
  assert.equal(r.activity, 'Letzte Modbus-Abfrage: vor 3 h von 10.12.0.4');
});
