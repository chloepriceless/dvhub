// test/input-ha-loxone-e2e.test.js — Messwert-Eingang Ende-zu-Ende gegen einen
// ECHTEN DVhub-Prozess (server.js, Profil „Universal (DVhub-MQTT-Schema:
// HA/Loxone)“, ohne Hardware/DB): Loxone-HTTP-Push mit Push-Schlüssel und
// Home-Assistant-MQTT-Publish an den eingebauten DVhub-Broker landen in
// /api/status; fällt der Zufluss aus, wird der Zähler ungültig (nicht 0 W).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import mqtt from 'mqtt';

const DVHUB_DIR = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  s.on('error', rej);
});
async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) { last = await fn(); if (last) return last; await sleep(250); }
  throw new Error(`Timeout: ${what}`);
}

test('HA/Loxone-Eingang E2E: Push-Schlüssel, HTTP-Push, MQTT-Publish, toter Zufluss', { timeout: 120_000 }, async (t) => {
  const rig = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-input-e2e-'));
  fs.mkdirSync(path.join(rig, 'etc', 'hersteller'), { recursive: true });
  fs.mkdirSync(path.join(rig, 'data'));
  fs.copyFileSync(path.join(DVHUB_DIR, 'hersteller', 'dvhub-mqtt.json'), path.join(rig, 'etc', 'hersteller', 'dvhub-mqtt.json'));
  const port = await freePort();
  const brokerPort = await freePort();
  fs.writeFileSync(path.join(rig, 'etc', 'config.json'), JSON.stringify({
    manufacturer: 'dvhub-mqtt', updateChannel: 'dev', httpPort: port, httpsPort: 0,
    victron: { host: '127.0.0.1', mqtt: { schema: 'dvhub', topicPrefix: 'dvhub', staleMaxAgeMs: 4000 } },
    mqtt: { enabled: true, embeddedBroker: { enabled: true, port: brokerPort } },
  }));
  const out = fs.openSync(path.join(rig, 'dvhub.log'), 'w');
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: DVHUB_DIR,
    env: { ...process.env, DV_APP_CONFIG: path.join(rig, 'etc', 'config.json'), DV_DATA_DIR: path.join(rig, 'data'), NODE_ENV: 'test' },
    stdio: ['ignore', out, out],
  });
  let client = null;
  t.after(() => {
    try { client?.end(true); } catch { /* */ }
    proc.kill('SIGKILL');
    if (!process.env.KEEP_RIG) fs.rmSync(rig, { recursive: true, force: true });
    else console.log('Rig:', rig);
  });
  const dv = (p) => `http://127.0.0.1:${port}${p}`;
  const get = async (p, headers = {}) => { const r = await fetch(dv(p), { headers }); return { status: r.status, j: await r.json().catch(() => null) }; };
  await waitFor(async () => { try { return (await fetch(dv('/healthz'))).ok; } catch { return false; } }, 30_000, 'DVhub bootet');

  // Eingang aktiv, Standard-Broker = eingebauter DVhub-Broker
  const st = await waitFor(async () => { const s = await get('/api/input/status'); return s.j?.active ? s : null; }, 15_000, 'Eingang aktiv');
  assert.equal(st.j.broker, 'Broker der DVhub-MQTT-Integration');
  assert.equal(st.j.pushKeySet, false);

  // Push ohne Schlüssel — auch von localhost/LAN — abgewiesen
  const noKey = await get('/api/input/push?grid_w=-1500');
  assert.equal(noKey.status, 401, JSON.stringify(noKey.j));

  // Schlüssel erzeugen (braucht Nonce), dann Loxone-typischer GET-Push mit Header
  const keyRes = await fetch(dv('/api/input/push-key'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uiToken: st.j.uiToken }) });
  const { key, header } = await keyRes.json();
  assert.match(key, /^[a-f0-9]{64}$/);
  const wrong = await get('/api/input/push?grid_w=-1500', { [header]: 'f'.repeat(64) });
  assert.equal(wrong.status, 401);
  const push = await get('/api/input/push?grid_w=-1500&pv_w=5000&battery_w=1000&soc_pct=64&foo=1', { [header]: key });
  assert.equal(push.status, 200, JSON.stringify(push.j));
  assert.deepEqual(push.j.accepted.sort(), ['battery_w', 'grid_w', 'pv_w', 'soc_pct']);
  assert.deepEqual(push.j.errors, ['foo: unbekanntes Feld']);

  // Werte kommen beim Poller an; Verbrauch aus der Energiebilanz (kein load_w gesendet)
  const s1 = await waitFor(async () => {
    const s = await get('/api/status');
    // Verbrauch wird am ENDE des Poll-Durchlaufs abgeleitet (nach dem Warten
    // auf das nicht gesendete Verbrauchs-Topic) — auf den ganzen Durchlauf warten.
    return s.j?.meter?.ok && s.j?.victron?.soc === 64 && s.j?.victron?.selfConsumptionW != null ? s.j : null;
  }, 15_000, 'Push-Werte im Status');
  assert.equal(s1.meter.grid_total_w, 1500, 'feed_in-Konvention: 1,5 kW Einspeisung positiv');
  assert.equal(s1.victron.pvTotalW, 5000);
  assert.equal(s1.victron.batteryPowerW, 1000);
  assert.equal(s1.victron.selfConsumptionW, 2500, '5000 + 0 − 1500 − 1000');

  // Home Assistant publiziert per MQTT an den eingebauten Broker
  client = mqtt.connect(`mqtt://127.0.0.1:${brokerPort}`);
  await new Promise((res, rej) => { client.once('connect', res); client.once('error', rej); });
  const publish = () => {
    client.publish('dvhub/input/battery/soc_pct', '71');
    client.publish('dvhub/input/grid/total_w', '250');
    client.publish('dvhub/input/pv/total_w', '1200');
    client.publish('dvhub/input/battery/power_w', '-400');
    client.publish('dvhub/input/consumption/total_w', '1850');
  };
  const pubTimer = setInterval(publish, 1000);
  publish();
  const s2 = await waitFor(async () => {
    const s = await get('/api/status');
    return s.j?.victron?.soc === 71 && s.j?.victron?.selfConsumptionW === 1850 ? s.j : null;
  }, 20_000, 'MQTT-Werte im Status');
  clearInterval(pubTimer);
  assert.equal(s2.meter.grid_total_w, -250, '250 W Bezug → feed_in negativ');
  assert.equal(s2.victron.selfConsumptionW, 1850, 'gemessener Verbrauch statt Ableitung');

  // Zufluss bricht ab → nach staleMaxAgeMs (4 s) Zähler ungültig, nicht 0 W „ok“
  const dead = await waitFor(async () => {
    const s = await get('/api/status');
    return s.j?.meter && s.j.meter.ok === false ? s.j : null;
  }, 20_000, 'Zähler ungültig nach Ausfall');
  assert.match(String(dead.meter.error), /veraltet/);
});

test('Loxone ohne Broker: reiner HTTP-Push-Modus, keine Verbindungs-Wiederholungen im Log', { timeout: 90_000 }, async (t) => {
  const rig = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-input-e2e-'));
  fs.mkdirSync(path.join(rig, 'etc', 'hersteller'), { recursive: true });
  fs.mkdirSync(path.join(rig, 'data'));
  fs.copyFileSync(path.join(DVHUB_DIR, 'hersteller', 'dvhub-mqtt.json'), path.join(rig, 'etc', 'hersteller', 'dvhub-mqtt.json'));
  const port = await freePort();
  fs.writeFileSync(path.join(rig, 'etc', 'config.json'), JSON.stringify({
    manufacturer: 'dvhub-mqtt', updateChannel: 'dev', httpPort: port, httpsPort: 0,
    victron: { host: '', mqtt: { schema: 'dvhub', topicPrefix: 'dvhub' } },
  }));
  const logFile = path.join(rig, 'dvhub.log');
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: DVHUB_DIR,
    env: { ...process.env, DV_APP_CONFIG: path.join(rig, 'etc', 'config.json'), DV_DATA_DIR: path.join(rig, 'data'), NODE_ENV: 'test' },
    stdio: ['ignore', fs.openSync(logFile, 'w'), fs.openSync(logFile, 'a')],
  });
  t.after(() => { proc.kill('SIGKILL'); fs.rmSync(rig, { recursive: true, force: true }); });
  const dv = (p) => `http://127.0.0.1:${port}${p}`;
  await waitFor(async () => { try { return (await fetch(dv('/healthz'))).ok; } catch { return false; } }, 30_000, 'DVhub bootet');
  const st = await (await fetch(dv('/api/input/status'))).json();
  assert.equal(st.active, true);
  assert.match(st.broker, /nur HTTP-Push/);
  const { key, header } = await (await fetch(dv('/api/input/push-key'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uiToken: st.uiToken }) })).json();
  const push = await fetch(dv('/api/input/push'), { method: 'POST', headers: { 'content-type': 'application/json', [header]: key }, body: JSON.stringify({ grid_w: 300, pv_w: 0, battery_w: -800, soc_pct: 33, load_w: 1100 }) });
  assert.equal(push.status, 200);
  await waitFor(async () => {
    const s = await (await fetch(dv('/api/status'))).json();
    return s.meter?.ok && s.victron?.soc === 33 && s.victron?.selfConsumptionW === 1100 ? s : null;
  }, 15_000, 'Push-Werte im Status');
  await sleep(6000); // mehrere Transport-Retry-Fenster abwarten
  const log = fs.readFileSync(logFile, 'utf8');
  assert.doesNotMatch(log, /Transport init fehlgeschlagen/, 'kein Verbindungsversuch ohne Broker');
  assert.match(log, /nur HTTP-Push/);
});
