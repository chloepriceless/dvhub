// NRGkick Gen2 (Christin 2026-10-20). Quelle: NRGkick „local API“ (Demo-Doku
// nrgkick.com/wp-content/uploads/local_api_docu_simulate-1.html, SmartModule ≥ 4.0):
//   GET /control?current_set=<A>  ·  /control?charge_pause=0|1
//   GET /values → general.status (1 STANDBY · 2 CONNECTED · 3 CHARGING · 6 ERROR · 7 WAKEUP,
//                 als Text oder Zahl), powerflow.total_active_power (W), energy.total_charged_energy (Wh)
//   GET /info → general.rated_current · BasicAuth optional · kein Watchdog
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createNrgkickAdapter } from '../services/wallbox/nrgkick.js';
import { WALLBOX_TYPES } from '../services/wallbox/types.js';
import { REDACTED_PATHS } from '../config-redaction.js';

function fakeNrg({ status = 'CHARGING', auth = null } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    if (auth && req.headers.authorization !== 'Basic ' + Buffer.from(auth).toString('base64')) { res.writeHead(401); return res.end(); }
    calls.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.startsWith('/values')) return res.end(JSON.stringify({ general: { status }, powerflow: { total_active_power: 11040.5 }, energy: { total_charged_energy: 987654 } }));
    if (req.url.startsWith('/info')) return res.end(JSON.stringify({ general: { rated_current: 16 } }));
    if (req.url.startsWith('/control')) return res.end(JSON.stringify({ current_set: 10, charge_pause: 0 }));
    res.end('{}');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, host: `127.0.0.1:${server.address().port}` })));
}

test('Typ nrgkick wählbar, Passwort geschwärzt', () => {
  assert.ok(WALLBOX_TYPES.includes('nrgkick'));
  assert.ok(REDACTED_PATHS.includes('wallbox.nrgkick.password'));
});

test('Status: CHARGING (Text) bzw. 2 (Zahl), Leistung, Energie', async () => {
  const b = await fakeNrg();
  const b2 = await fakeNrg({ status: 2 });
  try {
    const st = await createNrgkickAdapter(() => ({ host: b.host })).status();
    assert.deepEqual([st.ok, st.connected, st.charging, st.powerW], [true, true, true, 11041]);
    assert.equal(st.raw.energyWh, 987654);
    const c = await createNrgkickAdapter(() => ({ host: b2.host })).status();
    assert.deepEqual([c.connected, c.charging], [true, false]);
  } finally { b.server.close(); b2.server.close(); }
});

test('Laden = current_set + Pause aus; Stopp = Pause an; Freigeben = Nennstrom + Pause aus; BasicAuth', async () => {
  const b = await fakeNrg({ auth: 'admin:geheim' });
  try {
    const a = createNrgkickAdapter(() => ({ host: b.host, username: 'admin', password: 'geheim' }));
    assert.equal((await a.charge(10.7)).ok, true);
    assert.equal((await a.stop()).ok, true);
    assert.equal((await a.release()).ok, true);
    assert.deepEqual(b.calls, ['/control?current_set=10&charge_pause=0', '/control?charge_pause=1', '/info', '/control?current_set=16&charge_pause=0']);
    const wrong = createNrgkickAdapter(() => ({ host: b.host, username: 'admin', password: 'falsch' }));
    assert.match((await wrong.status()).error, /401/);
  } finally { b.server.close(); }
});
