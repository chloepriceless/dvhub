// test/evcc-integration-state.test.js -- evcc-Abfrage: spaet eingetragene URL,
// evccs eigene Fehlerliste, Ladepunkt-Details fuer die EOS-Bruecke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createEvccIntegration } from '../evcc-integration.js';

function mockEvcc(state) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url === '/api/state' ? JSON.stringify(state) : '{}');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((r) => server.close(r))
  })));
}

const waitFor = async (fn, maxMs = 1000) => {
  for (let t = 0; t < maxMs; t += 20) { if (fn()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('timeout');
};

test('URL erst nach dem Start eingetragen: Abfrage laeuft trotzdem an', async () => {
  const evcc = await mockEvcc({ loadpoints: [] });
  const cfg = { evcc: { url: '', pollIntervalMs: 5000, enabled: false } };
  const integ = createEvccIntegration({ getCfg: () => cfg, pushLog: () => {} });
  try {
    integ.start();
    assert.equal(integ.getStatus().lastError, 'no url configured');
    cfg.evcc.url = evcc.url; // wie ein Speichern in den Integrationen
    // Frueher lief ohne Start-URL gar kein Takt — dann kam hier nie eine Abfrage an.
    await waitFor(() => evcc.requests.includes('GET /api/state'), 7000);
    assert.equal(integ.getStatus().lastError, null);
  } finally {
    integ.stop();
    await evcc.close();
  }
});

test('0 Ladepunkte + fatal: Grund wird durchgereicht, Ladepunkt-Details fuer EOS', async () => {
  const evcc = await mockEvcc({
    fatal: [{ class: 'charger', device: 'db:13', error: 'wifi firmware too old: 4.1.4 (need 4.1.9 or later)' }],
    loadpoints: [{ title: 'Garage', mode: 'pv', minCurrent: 6, maxCurrent: 16, phasesConfigured: 3 }]
  });
  const integ = createEvccIntegration({ getCfg: () => ({ evcc: { url: evcc.url, enabled: false } }), pushLog: () => {} });
  try {
    integ.start();
    await waitFor(() => integ.getStatus().lastPolledAt > 0);
    const st = integ.getStatus();
    assert.equal(st.fatal.length, 1);
    assert.match(st.fatal[0].error, /firmware too old/);
    assert.equal(st.loadpoints[0].minCurrentA, 6);
    assert.equal(st.loadpoints[0].maxCurrentA, 16);
    assert.equal(st.loadpoints[0].phasesConfigured, 3);
  } finally {
    integ.stop();
    await evcc.close();
  }
});

test('setMaxCurrent: POST /api/loadpoints/{id}/maxcurrent/{A}, Grenzen geprueft', async () => {
  const evcc = await mockEvcc({ loadpoints: [] });
  const integ = createEvccIntegration({ getCfg: () => ({ evcc: { url: evcc.url } }), pushLog: () => {} });
  try {
    assert.deepEqual(await integ.setMaxCurrent(2, 8.5), { ok: true, currentA: 8.5 });
    assert.ok(evcc.requests.includes('POST /api/loadpoints/2/maxcurrent/8.5'));
    assert.equal((await integ.setMaxCurrent(2, 5)).ok, false, 'unter 6 A');
    assert.equal((await integ.setMaxCurrent(0, 10)).ok, false, 'Ladepunkt 0');
  } finally {
    await evcc.close();
  }
});
