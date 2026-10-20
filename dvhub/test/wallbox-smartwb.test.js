// EVSE-WiFi / smartWB (Christin 2026-10-20). Quelle: „EVSE-WiFi API-Dokumentation“
// (Mathias Nachbaur, Stand 27.05.2022, smartwb.de): HTTP GET
//   /getParameters → list[0]: vehicleState (1 bereit · 2 angeschlossen · 3 lädt · 5 Fehler),
//                    actualPower (kW), actualCurrent (A), maxCurrent, meterReading (kWh), alwaysActive
//   /setCurrent?current=<A> (Always Active/Remote: 0 = Ladevorgang beenden)
//   /setStatus?active=true|false (Normal-Modus) · kein Watchdog
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createSmartwbAdapter } from '../services/wallbox/smartwb.js';
import { WALLBOX_TYPES } from '../services/wallbox/types.js';

function fakeSwb({ alwaysActive = false, vehicleState = 3 } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/getParameters') return res.end(JSON.stringify({ type: 'parameters', list: [{ vehicleState, evseState: true, maxCurrent: 16, actualCurrent: 10, actualPower: 2.251, alwaysActive, meterReading: 54.35 }] }));
    res.end('S0_OK');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, host: `127.0.0.1:${server.address().port}` })));
}

test('Typ smartwb wählbar', () => { assert.ok(WALLBOX_TYPES.includes('smartwb')); });

test('Status: lädt, Leistung kW → W, Zählerstand', async () => {
  const b = await fakeSwb();
  try {
    const st = await createSmartwbAdapter(() => ({ host: b.host })).status();
    assert.deepEqual([st.ok, st.connected, st.charging, st.powerW, st.currentA], [true, true, true, 2251, 10]);
    assert.equal(st.raw.meterKwh, 54.35);
  } finally { b.server.close(); }
});

test('Normal-Modus: Laden = Strom + Start; Stopp = setStatus false; Freigeben = maxCurrent + Start', async () => {
  const b = await fakeSwb();
  try {
    const a = createSmartwbAdapter(() => ({ host: b.host }));
    await a.charge(10.4); await a.stop(); await a.release();
    assert.deepEqual(b.calls.filter((u) => u !== '/getParameters'), ['/setCurrent?current=10', '/setStatus?active=true', '/setStatus?active=false', '/setCurrent?current=16', '/setStatus?active=true']);
  } finally { b.server.close(); }
});

test('Always Active: Laden = Strom; Stopp = Strom 0', async () => {
  const b = await fakeSwb({ alwaysActive: true });
  try {
    const a = createSmartwbAdapter(() => ({ host: b.host }));
    await a.charge(12); await a.stop();
    assert.deepEqual(b.calls.filter((u) => u !== '/getParameters'), ['/setCurrent?current=12', '/setCurrent?current=0']);
  } finally { b.server.close(); }
});
