// openWB als Hauptwallbox (Christin 2026-10-20, Wallbox-Liste Punkt 1).
// Zwei Wege, beide aus der openWB-2-Software (github.com/openWB/core, GPL —
// nur die Schnittstelle nachgelesen, kein Code übernommen):
//   pro       openWB Pro / series2 Satellit: HTTP http://<host>/connect.php
//             GET → JSON (plug_state, charge_state, power_all, currents, imported,
//             offered_current, soc_value, phases_in_use); POST ampere=<A> (0 = Stopp)
//   secondary openWB series2/Duo im Modus „Nur Ladepunkt“: DVhub steuert wie
//             eine übergeordnete openWB per MQTT am Broker der Box (Port 1883):
//             openWB/set/internal_chargepoint/<n>/data/set_current = A,
//             Lebenszeichen openWB/set/internal_chargepoint/global_data
//             {"heartbeat": <s>} — bleibt es 80 s aus, stoppt die Box selbst.
//             Messwerte: openWB/internal_chargepoint/<n>/get/#
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';

import { createOpenWbAdapter } from '../services/wallbox/openwb.js';
import { WALLBOX_TYPES, DIRECT_WALLBOX_TYPES, directWallboxConfigured } from '../services/wallbox/types.js';
import { WALLBOX_LABELS } from '../services/wallbox/main-wallbox.js';
import { DIRECT_CHARGERS } from '../services/wallbox/charger-status.js';
import { CHARGER_TYPES } from '../services/optimizer/eos-evcc-bridge.js';

test('Eine Typliste für alle: openWB ist wählbar, direkt, für EOS und §14a', () => {
  assert.ok(WALLBOX_TYPES.includes('openwb'));
  assert.equal(WALLBOX_LABELS.openwb, 'openWB');
  assert.deepEqual(DIRECT_CHARGERS, DIRECT_WALLBOX_TYPES);
  assert.deepEqual(CHARGER_TYPES, WALLBOX_TYPES);
  assert.equal(directWallboxConfigured({ wallbox: { type: 'openwb', openwb: { host: '192.0.2.5' } } }), true);
  assert.equal(directWallboxConfigured({ wallbox: { type: 'openwb', openwb: { host: '' } } }), false);
  assert.equal(directWallboxConfigured({ wallbox: { type: 'goe', goe: { url: 'http://x' } } }), true);
  assert.equal(directWallboxConfigured({ wallbox: { type: 'victron' }, victron: { host: 'gx' } }), true);
  assert.equal(directWallboxConfigured({ wallbox: { type: 'evcc' } }), false);
});

// ── openWB Pro (HTTP) ──
function fakePro(state) {
  const posts = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url !== '/connect.php') { res.writeHead(404); return res.end(); }
      if (req.method === 'POST') {
        posts.push(Object.fromEntries(new URLSearchParams(body)));
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('ok');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(state));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, posts, host: `127.0.0.1:${server.address().port}` })));
}

const PRO_STATE = {
  plug_state: true, charge_state: true, power_all: 7360, powers: [2453, 2453, 2454], currents: [10.7, 10.7, 10.6],
  imported: 1234567, exported: 0, offered_current: 11, phases_in_use: 3, phases_target: 3, soc_value: 64, serial: 'X',
};

test('openWB Pro: Status aus connect.php', async () => {
  const box = await fakePro(PRO_STATE);
  try {
    const st = await createOpenWbAdapter(() => ({ mode: 'pro', host: box.host })).status();
    assert.equal(st.ok, true);
    assert.equal(st.connected, true);
    assert.equal(st.charging, true);
    assert.equal(st.powerW, 7360);
    assert.equal(st.currentA, 11);
    assert.equal(st.vehicleSocPct, 64);
    assert.equal(st.raw.phasesInUse, 3);
  } finally { box.server.close(); }
});

test('openWB Pro: Laden = ampere (ganze A, ≥ 6), Stopp = ampere 0, Freigeben ändert nichts', async () => {
  const box = await fakePro(PRO_STATE);
  try {
    const a = createOpenWbAdapter(() => ({ mode: 'pro', host: box.host }));
    assert.equal((await a.charge(10.9)).ok, true);
    assert.equal((await a.charge(3)).ok, true);
    assert.equal((await a.stop()).ok, true);
    assert.equal((await a.release()).ok, true);
    assert.deepEqual(box.posts, [{ ampere: '10' }, { ampere: '6' }, { ampere: '0' }]);
  } finally { box.server.close(); }
});

test('openWB Pro: nicht erreichbar → Fehler, nicht eingerichtet → isConfigured false', async () => {
  const a = createOpenWbAdapter(() => ({ mode: 'pro', host: '127.0.0.1:9', timeoutMs: 500 }));
  assert.equal((await a.status()).ok, false);
  assert.equal(createOpenWbAdapter(() => ({ mode: 'pro', host: '' })).isConfigured(), false);
});

// ── openWB im Modus „Nur Ladepunkt“ (MQTT) ──
function fakeMqtt() {
  const published = [];
  const subscribed = [];
  const client = new EventEmitter();
  client.connected = true;
  client.publish = (topic, payload, opts, cb) => { published.push([topic, String(payload)]); (cb || opts)?.call?.(null); };
  client.subscribe = (t) => { subscribed.push(t); };
  client.end = () => {};
  const deliver = (topic, value) => client.emit('message', topic, Buffer.from(JSON.stringify(value)));
  return { client, published, subscribed, deliver, connect: () => client };
}

test('openWB Nur Ladepunkt: Abo, Lebenszeichen bei jedem Status, Messwerte aus den Topics', async () => {
  const m = fakeMqtt();
  const t = 1_800_000_000_000;
  const a = createOpenWbAdapter(() => ({ mode: 'secondary', host: '192.0.2.7', chargepoint: 1 }), { mqttConnect: m.connect, now: () => t });
  m.client.emit('connect');
  assert.deepEqual(m.subscribed, ['openWB/internal_chargepoint/1/get/#']);
  m.deliver('openWB/internal_chargepoint/1/get/plug_state', true);
  m.deliver('openWB/internal_chargepoint/1/get/charge_state', false);
  m.deliver('openWB/internal_chargepoint/1/get/power', 0);
  m.deliver('openWB/internal_chargepoint/1/get/evse_current', 6);
  m.deliver('openWB/internal_chargepoint/1/get/soc', 55);
  const st = await a.status();
  assert.equal(st.ok, true);
  assert.equal(st.connected, true);
  assert.equal(st.charging, false);
  assert.equal(st.vehicleSocPct, 55);
  const hb = m.published.find(([topic]) => topic === 'openWB/set/internal_chargepoint/global_data');
  assert.equal(JSON.parse(hb[1]).heartbeat, 1_800_000_000);
});

test('openWB Nur Ladepunkt: Laden/Stopp über set_current, mit Lebenszeichen', async () => {
  const m = fakeMqtt();
  const a = createOpenWbAdapter(() => ({ mode: 'secondary', host: '192.0.2.8', chargepoint: 0 }), { mqttConnect: m.connect, now: () => 1_800_000_000_000 });
  m.client.emit('connect');
  assert.equal((await a.charge(16.4)).ok, true);
  assert.equal((await a.stop()).ok, true);
  const sets = m.published.filter(([topic]) => topic === 'openWB/set/internal_chargepoint/0/data/set_current').map(([, v]) => v);
  assert.deepEqual(sets, ['16', '0']);
  assert.ok(m.published.some(([topic]) => topic === 'openWB/set/internal_chargepoint/global_data'));
});

test('openWB Nur Ladepunkt: keine Messwerte (Box nicht im Modus „Nur Ladepunkt“) → klarer Fehler', async () => {
  const m = fakeMqtt();
  const a = createOpenWbAdapter(() => ({ mode: 'secondary', host: '192.0.2.9' }), { mqttConnect: m.connect, now: () => 0 });
  m.client.emit('connect');
  const st = await a.status();
  assert.equal(st.ok, false);
  assert.match(st.error, /Nur Ladepunkt/);
});
