// OCPP 1.6J-Zentrale in DVhub (Christin 2026-10-20, Wallbox-Liste Punkt 3).
// OCPP ist ein offener Standard (Open Charge Alliance); viele Wallboxen (Alfen,
// ABL, Wallbox, Zaptec, Bender-basierte …) sprechen ihn. Die Wallbox verbindet
// sich mit ws://<DVhub>:<port>/<Ladepunkt-ID> (Subprotokoll „ocpp1.6“).
// Nachrichten: [2, id, Aktion, Daten] (Aufruf), [3, id, Antwort], [4, id, Fehler…].
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

import { createOcppServer } from '../services/wallbox/ocpp-server.js';
import { createOcppAdapter } from '../services/wallbox/ocpp.js';
import { WALLBOX_TYPES, directWallboxConfigured } from '../services/wallbox/types.js';

async function start(cfgOver = {}) {
  const port = 21000 + Math.floor(Math.random() * 20000);
  const logs = [];
  const cfg = { ocpp: { enabled: true, port, host: '127.0.0.1', password: '', ...cfgOver } };
  const srv = createOcppServer({ getCfg: () => cfg, pushLog: (e, d) => logs.push([e, d]) }, { callTimeoutMs: 2000 });
  await srv.start();
  return { srv, port, logs, cfg };
}

// Nachgebaute Wallbox: beantwortet Aufrufe der Zentrale (Antworten konfigurierbar).
function chargePoint(port, id, { auth, answers = {} } = {}) {
  const headers = auth ? { authorization: 'Basic ' + Buffer.from(`${id}:${auth}`).toString('base64') } : {};
  const ws = new WebSocket(`ws://127.0.0.1:${port}/${id}`, 'ocpp1.6', { headers });
  const received = [];
  const pending = new Map();
  let n = 0;
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m[0] === 2) {
      received.push([m[2], m[3]]);
      const ans = answers[m[2]] ?? { status: 'Accepted' };
      ws.send(JSON.stringify([3, m[1], ans]));
    } else if (m[0] === 3 || m[0] === 4) {
      pending.get(m[1])?.(m);
      pending.delete(m[1]);
    }
  });
  const call = (action, payload) => new Promise((resolve) => {
    const id2 = `cp${++n}`;
    pending.set(id2, resolve);
    ws.send(JSON.stringify([2, id2, action, payload]));
  });
  const opened = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); ws.once('unexpected-response', (_q, res) => reject(new Error(`HTTP ${res.statusCode}`))); });
  return { ws, call, received, opened };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('Typ „ocpp“ wählbar; eingerichtet, wenn die Zentrale an ist', () => {
  assert.ok(WALLBOX_TYPES.includes('ocpp'));
  assert.equal(directWallboxConfigured({ wallbox: { type: 'ocpp' }, ocpp: { enabled: true } }), true);
  assert.equal(directWallboxConfigured({ wallbox: { type: 'ocpp' }, ocpp: { enabled: false } }), false);
});

test('Anmeldung, Lebenszeichen, Status und Messwerte; Zentrale stellt Messintervall ein', async () => {
  const { srv, port } = await start();
  const cp = chargePoint(port, 'BOX-1');
  try {
    await cp.opened;
    const boot = await cp.call('BootNotification', { chargePointVendor: 'Alfen', chargePointModel: 'Eve' });
    assert.equal(boot[2].status, 'Accepted');
    assert.ok(boot[2].interval > 0 && boot[2].currentTime);
    assert.ok((await cp.call('Heartbeat', {}))[2].currentTime);
    await cp.call('StatusNotification', { connectorId: 1, status: 'Preparing', errorCode: 'NoError' });
    await cp.call('MeterValues', { connectorId: 1, meterValue: [{ timestamp: new Date().toISOString(), sampledValue: [
      { measurand: 'Power.Active.Import', unit: 'kW', value: '7.2' },
      { measurand: 'Energy.Active.Import.Register', unit: 'Wh', value: '123456' },
      { measurand: 'Current.Import', phase: 'L1', unit: 'A', value: '10.4' },
    ] }] });
    await wait(50);
    const st = srv.chargePoint('BOX-1');
    assert.equal(st.connected, true);
    assert.equal(st.vendor, 'Alfen');
    assert.equal(st.connectors[1].status, 'Preparing');
    assert.equal(st.connectors[1].powerW, 7200);
    assert.equal(st.connectors[1].energyWh, 123456);
    assert.ok(cp.received.some(([a, p]) => a === 'ChangeConfiguration' && p.key === 'MeterValueSampleInterval'));
    assert.deepEqual(srv.list().map((c) => c.id), ['BOX-1']);
  } finally { cp.ws.close(); await srv.stop(); }
});

test('Ladevorgang: Start/Stop vom Ladepunkt werden angenommen (Transaktions-ID)', async () => {
  const { srv, port } = await start();
  const cp = chargePoint(port, 'BOX-2');
  try {
    await cp.opened;
    const auth = await cp.call('Authorize', { idTag: 'ABC' });
    assert.equal(auth[2].idTagInfo.status, 'Accepted');
    const s = await cp.call('StartTransaction', { connectorId: 1, idTag: 'ABC', meterStart: 100, timestamp: new Date().toISOString() });
    assert.ok(Number.isInteger(s[2].transactionId));
    assert.equal(srv.chargePoint('BOX-2').connectors[1].transactionId, s[2].transactionId);
    const e = await cp.call('StopTransaction', { transactionId: s[2].transactionId, meterStop: 900, timestamp: new Date().toISOString() });
    assert.equal(e[2].idTagInfo.status, 'Accepted');
    assert.equal(srv.chargePoint('BOX-2').connectors[1].transactionId, null);
    const unknown = await cp.call('GibtsNicht', {});
    assert.equal(unknown[0], 4, 'unbekannte Aktion → CALLERROR');
    assert.equal(unknown[2], 'NotImplemented');
  } finally { cp.ws.close(); await srv.stop(); }
});

test('Adapter: Laden = Ladeprofil in A (+ Fernstart, wenn kein Vorgang läuft); Stopp = 0 A; Freigeben = Profil löschen', async () => {
  const { srv, port } = await start();
  const cp = chargePoint(port, 'BOX-3');
  try {
    await cp.opened;
    await cp.call('BootNotification', { chargePointVendor: 'X', chargePointModel: 'Y' });
    await cp.call('StatusNotification', { connectorId: 1, status: 'Preparing', errorCode: 'NoError' });
    const a = createOcppAdapter(() => ({ chargePointId: '', connectorId: 1 }), { getServer: () => srv });
    assert.equal(a.isConfigured(), true);
    assert.equal((await a.charge(10.7)).ok, true);
    const prof = cp.received.filter(([x]) => x === 'SetChargingProfile').at(-1)[1];
    assert.equal(prof.connectorId, 1);
    assert.equal(prof.csChargingProfiles.chargingProfilePurpose, 'TxDefaultProfile');
    assert.equal(prof.csChargingProfiles.chargingSchedule.chargingRateUnit, 'A');
    assert.equal(prof.csChargingProfiles.chargingSchedule.chargingSchedulePeriod[0].limit, 10);
    assert.ok(cp.received.some(([x, p]) => x === 'RemoteStartTransaction' && p.connectorId === 1), 'Auto steckt, kein Vorgang → Fernstart');
    assert.equal((await a.stop()).ok, true);
    assert.equal(cp.received.filter(([x]) => x === 'SetChargingProfile').at(-1)[1].csChargingProfiles.chargingSchedule.chargingSchedulePeriod[0].limit, 0);
    assert.equal((await a.release()).ok, true);
    assert.ok(cp.received.some(([x]) => x === 'ClearChargingProfile'));
    const st = await a.status();
    assert.deepEqual([st.ok, st.connected, st.charging], [true, true, false]);
  } finally { cp.ws.close(); await srv.stop(); }
});

test('Adapter: Ladepunkt lehnt Profil ab → Fehler; nicht verbunden → Fehler', async () => {
  const { srv, port } = await start();
  const cp = chargePoint(port, 'BOX-4', { answers: { SetChargingProfile: { status: 'Rejected' } } });
  try {
    await cp.opened;
    await cp.call('StatusNotification', { connectorId: 1, status: 'Charging', errorCode: 'NoError' });
    const a = createOcppAdapter(() => ({ chargePointId: 'BOX-4', connectorId: 1 }), { getServer: () => srv });
    assert.match((await a.charge(16)).error, /Rejected/);
    const b = createOcppAdapter(() => ({ chargePointId: 'FEHLT', connectorId: 1 }), { getServer: () => srv });
    assert.match((await b.status()).error, /nicht verbunden/);
  } finally { cp.ws.close(); await srv.stop(); }
});

test('Passwort (Sicherheitsprofil 1): ohne/falsch → abgelehnt, richtig → verbunden', async () => {
  const { srv, port } = await start({ password: 'geheim' });
  try {
    await assert.rejects(chargePoint(port, 'BOX-5').opened, /401/);
    await assert.rejects(chargePoint(port, 'BOX-5', { auth: 'falsch' }).opened, /401/);
    const ok = chargePoint(port, 'BOX-5', { auth: 'geheim' });
    await ok.opened;
    ok.ws.close();
  } finally { await srv.stop(); }
});

// A7S 2026-10-20: evcc lauscht mit seiner eigenen OCPP-Zentrale auf 8887.
test('Port belegt → klare Meldung im Status, einmal im Protokoll, kein Absturz; Standardport 8889', async () => {
  const net = await import('node:net');
  const blocker = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  const port = blocker.address().port;
  const logs = [];
  const cfg = { ocpp: { enabled: true, port, host: '127.0.0.1' } };
  const srv = createOcppServer({ getCfg: () => cfg, pushLog: (e, d) => logs.push([e, d]) });
  try {
    await srv.reconcile();
    await srv.reconcile();
    const st = srv.status();
    assert.equal(st.listening, false);
    assert.match(st.error, /belegt/);
    assert.equal(logs.filter(([e]) => e === 'ocpp_start_error').length, 1, 'nur einmal melden');
  } finally { blocker.close(); await srv.stop(); }
  const { createDefaultConfig } = await import('../config-model.js');
  assert.equal(createDefaultConfig().ocpp.port, 8889);
});
