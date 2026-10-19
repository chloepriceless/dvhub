// Geräte am Victron GX (Christin 2026-10-20): Seit Venus OS 3.80 koppelt der GX
// EEBUS-Wärmepumpen und -Wallboxen selbst und legt sie als eigene Dienste an
// (com.victronenergy.heatpump / evcharger), genau wie Victrons eigene Wallbox
// (EVCS) und gemessene AC-Lasten (com.victronenergy.acload). DVhub findet sie
// über den Modbus-TCP-Server des GX (Unit-IDs werden dort dynamisch vergeben)
// und liest sie nur — Register laut CCGX-Modbus-TCP-register-list.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  scanGxServices, readEvcharger, readHeatpump, readAcload, createVictronGxDevices, GX_SCAN_UNITS
} from '../services/victron-gx/devices.js';

// Nachgebauter GX: units = { unitId: { address: wert } }. Unbekannte Unit →
// Ausnahme 10 (wie der echte GX), unbekanntes Register → Ausnahme 2.
function fakeGx(units) {
  const calls = [];
  async function mbRequest({ unitId, fc, address, quantity }) {
    calls.push({ unitId, fc, address, quantity });
    assert.equal(fc, 3, 'nur lesen (FC3)');
    const u = units[unitId];
    if (!u) throw new Error('modbus exception 10');
    const out = [];
    for (let a = address; a < address + quantity; a++) {
      if (!(a in u)) throw new Error('modbus exception 2');
      out.push(u[a]);
    }
    return out;
  }
  return { mbRequest, calls };
}

const u32 = (base, v) => ({ [base]: (v >>> 16) & 0xffff, [base + 1]: v & 0xffff });
const i32 = (base, v) => u32(base, v < 0 ? (v + 0x100000000) : v);

// Victron EVCS an Unit 40: lädt 3-phasig mit 7,2 kW, manuell, 10 A.
const EVCS = {
  3800: 0xc025, 3814: 32, 3815: 0, ...u32(3816, 1234), 3818: 2400, 3819: 2400, 3820: 2400, 3821: 7200,
  3822: 360, 3823: 10, 3824: 2, 3825: 10, 3826: 1, 3827: 0, ...u32(3828, 3600), ...u32(3836, 98765)
};
// EEBUS-Wärmepumpe an Unit 41: heizt, 2,1 kW, 45,0 °C von 50,0 °C.
const HEATPUMP = { 5500: 0xa1b2, 5501: 3, ...u32(5502, 2100), ...u32(5504, 456789), 5506: 450, 5507: 500 };
// AC-Last an Unit 50 (wie am echten GX 2026-10-20): 31 W auf L1.
const ACLOAD = {
  3900: 31, 3901: 0, 3902: 0, ...u32(3916, 1000), ...u32(3918, 0), ...u32(3920, 0),
  ...i32(3924, 31), ...i32(3926, 0), ...i32(3928, 0)
};

test('Suche: findet Wallbox, Wärmepumpe und AC-Last an ihren Unit-IDs', async () => {
  const { mbRequest, calls } = fakeGx({ 40: EVCS, 41: HEATPUMP, 50: ACLOAD, 100: { 834: 0x381 } });
  const found = await scanGxServices(mbRequest, { host: 'gx', port: 502 });
  assert.deepEqual(found, [
    { kind: 'evcharger', unitId: 40 },
    { kind: 'heatpump', unitId: 41 },
    { kind: 'acload', unitId: 50 }
  ]);
  assert.ok(calls.every((c) => c.fc === 3));
  assert.equal(GX_SCAN_UNITS.length, 247);
});

test('Wallbox lesen: Leistung, Strom, Status, Modus, Energie', async () => {
  const { mbRequest } = fakeGx({ 40: EVCS });
  const d = await readEvcharger(mbRequest, { host: 'gx', port: 502, unitId: 40 });
  assert.equal(d.powerW, 7200);
  assert.deepEqual(d.phasesW, [2400, 2400, 2400]);
  assert.equal(d.currentA, 10);
  assert.equal(d.setCurrentA, 10);
  assert.equal(d.maxCurrentA, 32);
  assert.equal(d.status, 2);
  assert.equal(d.statusText, 'lädt');
  assert.equal(d.connected, true);
  assert.equal(d.charging, true);
  assert.equal(d.mode, 0);
  assert.equal(d.startStop, 1);
  assert.equal(d.sessionEnergyKwh, 12.34);
  assert.equal(d.energyKwh, 987.65);
});

test('Wallbox ohne Steuerregister (z. B. über EEBUS gekoppelt): Leistung und Status reichen', async () => {
  const { mbRequest } = fakeGx({ 40: { 3800: 1, 3821: 3700, 3824: 1 } });
  const d = await readEvcharger(mbRequest, { host: 'gx', port: 502, unitId: 40 });
  assert.equal(d.powerW, 3700);
  assert.equal(d.status, 1);
  assert.equal(d.connected, true);
  assert.equal(d.charging, false);
  assert.equal(d.mode, null);
  assert.equal(d.controllable, false);
});

test('Wärmepumpe lesen: Zustand, Leistung, Energie, Temperaturen', async () => {
  const { mbRequest } = fakeGx({ 41: HEATPUMP });
  const d = await readHeatpump(mbRequest, { host: 'gx', port: 502, unitId: 41 });
  assert.equal(d.state, 3);
  assert.equal(d.stateText, 'heizt');
  assert.equal(d.powerW, 2100);
  assert.equal(d.energyKwh, 4567.89);
  assert.equal(d.temperatureC, 45);
  assert.equal(d.targetTemperatureC, 50);
});

test('Wärmepumpe meldet keine Energie (z. B. NIBE über EEBUS): Leistung bleibt', async () => {
  const { mbRequest } = fakeGx({ 41: { 5500: 1, 5501: 0xffff, ...u32(5502, 39), ...u32(5504, 0xffffffff), 5506: 0xffff, 5507: 0xffff } });
  const d = await readHeatpump(mbRequest, { host: 'gx', port: 502, unitId: 41 });
  assert.equal(d.powerW, 39);
  assert.equal(d.energyKwh, null);
  assert.equal(d.state, null);
  assert.equal(d.temperatureC, null);
});

test('AC-Last lesen: Summe der Phasen (32-Bit-Register), Energie', async () => {
  const { mbRequest } = fakeGx({ 50: ACLOAD });
  const d = await readAcload(mbRequest, { host: 'gx', port: 502, unitId: 50 });
  assert.equal(d.powerW, 31);
  assert.deepEqual(d.phasesW, [31, 0, 0]);
  assert.equal(d.energyKwh, 10);
});

test('AC-Last ohne 32-Bit-Register: 16-Bit-Leistung', async () => {
  const { mbRequest } = fakeGx({ 50: { 3900: 120, 3901: 80, 3902: 0 } });
  const d = await readAcload(mbRequest, { host: 'gx', port: 502, unitId: 50 });
  assert.equal(d.powerW, 200);
  assert.equal(d.energyKwh, null);
});

test('Dienst: sucht, liest, zeigt — nur bei Victron über Modbus', async () => {
  const gx = fakeGx({ 40: EVCS, 50: ACLOAD });
  let cfg = { manufacturer: 'victron', victron: { host: 'gx', port: 502 } };
  const svc = createVictronGxDevices({ getCfg: () => cfg, pushLog: () => {} }, { getTransport: () => ({ type: 'modbus', mbRequest: gx.mbRequest }), now: () => Date.parse('2026-10-20T10:00:00Z') });
  await svc.scan();
  await svc.refresh();
  const st = svc.status();
  assert.equal(st.supported, true);
  assert.deepEqual(st.devices.map((d) => [d.kind, d.unitId, d.powerW]), [['evcharger', 40, 7200], ['acload', 50, 31]]);
  assert.equal(svc.findUnit('evcharger'), 40);
  assert.equal(st.scannedAt, '2026-10-20T10:00:00.000Z');

  cfg = { manufacturer: 'fronius' };
  assert.equal(svc.status().supported, false);
  assert.deepEqual(await svc.scan(), { skipped: 'source_unsupported' });
});

test('Dienst: ein Gerät, das nicht mehr antwortet, behält den letzten Stand mit Fehler', async () => {
  const units = { 40: EVCS };
  const gx = fakeGx(units);
  const svc = createVictronGxDevices({ getCfg: () => ({ manufacturer: 'victron', victron: { host: 'gx' } }), pushLog: () => {} }, { getTransport: () => ({ type: 'modbus', mbRequest: gx.mbRequest }) });
  await svc.scan();
  await svc.refresh();
  delete units[40];
  await svc.refresh();
  const d = svc.status().devices[0];
  assert.equal(d.powerW, 7200);
  assert.match(d.error, /exception 10/);
});
