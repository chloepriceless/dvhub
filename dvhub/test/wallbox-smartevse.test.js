// SmartEVSE v3 (Christin 2026-10-20). Quelle: github.com/SmartEVSE/SmartEVSE-3 (MIT),
// docs/REST_API.md und src/esp32.cpp: GET /settings · POST /settings?… mit leerem Rumpf.
//   mode: 0 OFF · 1 NORMAL · 2 SOLAR · 3 SMART · 4 PAUSE (mode_id im GET gleich)
//   override_current = A × 10, nur in NORMAL/SMART, im Bereich current_min…current_max
//   disable_override_current = Vorgabe aufheben
//   evse.state_id: 0 A (kein Auto) · 1 B · 2 C (lädt) · 9 B1 · 10 C1 · 11–14 Modem
//   ev_meter.import_active_power W · total_wh Wh · currents L1–L3 in 0,1 A
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createSmartevseAdapter } from '../services/wallbox/smartevse.js';
import { WALLBOX_TYPES } from '../services/wallbox/types.js';

function fakeEvse({ modeId = 2, stateId = 2, errorId = 0, meter = 'Eastron3P', override = 0, rejectOverride = false } = {}) {
  const calls = [];
  const st = { modeId, override };
  const server = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET') {
      return res.end(JSON.stringify({ mode_id: st.modeId, car_connected: stateId !== 0,
        evse: { state_id: stateId, error_id: errorId, state: 'x' },
        settings: { override_current: st.override, current_min: 6, current_max: 16 },
        ev_meter: { description: meter, import_active_power: 7120, total_wh: 5670100, currents: { TOTAL: 310, L1: 104, L2: 103, L3: 103 } },
        ev_state: { computed_soc: 55 } }));
    }
    const out = {};
    if (u.searchParams.has('mode')) { st.modeId = Number(u.searchParams.get('mode')); out.mode = u.searchParams.get('mode'); }
    if (u.searchParams.has('override_current')) {
      const v = Number(u.searchParams.get('override_current'));
      if (!rejectOverride && (st.modeId === 1 || st.modeId === 3)) { st.override = v; out.override_current = v; } else out.override_current = 'Value not allowed!';
    }
    if (u.searchParams.has('disable_override_current')) { st.override = 0; out.disable_override_current = 'OK'; }
    res.end(JSON.stringify(out));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, st, host: `127.0.0.1:${server.address().port}` })));
}
const posts = (b) => b.calls.filter((c) => c.startsWith('POST')).map((c) => c.slice(5));

test('Typ smartevse wählbar', () => { assert.ok(WALLBOX_TYPES.includes('smartevse')); });

test('Status: lädt, Leistung W, Strom 0,1 A → A, SoC aus dem Modem, Energie Wh', async () => {
  const b = await fakeEvse();
  try {
    const s = await createSmartevseAdapter(() => ({ host: b.host })).status();
    assert.deepEqual([s.ok, s.connected, s.charging, s.powerW, s.currentA, s.vehicleSocPct], [true, true, true, 7120, 10.4, 55]);
    assert.equal(s.raw.energyWh, 5670100);
  } finally { b.server.close(); }
  const n = await fakeEvse({ stateId: 0, meter: 'Disabled' });
  try {
    const s = await createSmartevseAdapter(() => ({ host: n.host })).status();
    assert.deepEqual([s.connected, s.charging, s.powerW], [false, false, null]);
  } finally { n.server.close(); }
});

test('Laden: aus SOLAR → NORMAL + Vorgabe in 0,1 A (auf current_max begrenzt); gleiche Vorgabe nicht neu senden', async () => {
  const b = await fakeEvse({ modeId: 2 });
  try {
    const a = createSmartevseAdapter(() => ({ host: b.host }));
    assert.equal((await a.charge(10.7)).ok, true);
    assert.deepEqual(posts(b), ['/settings?mode=1&override_current=100']);
    await a.charge(10.2);
    assert.equal(posts(b).length, 1, 'unverändert → kein POST');
    await a.charge(40);
    assert.equal(posts(b).at(-1), '/settings?override_current=160');
  } finally { b.server.close(); }
});

test('Stopp = OFF; Freigeben = Vorgabe aufheben und alten Modus (SOLAR) zurück', async () => {
  const b = await fakeEvse({ modeId: 2 });
  try {
    const a = createSmartevseAdapter(() => ({ host: b.host }));
    await a.charge(8); await a.stop(); await a.release();
    assert.deepEqual(posts(b), ['/settings?mode=1&override_current=80', '/settings?mode=0', '/settings?disable_override_current=1&mode=2']);
  } finally { b.server.close(); }
});

test('Box lehnt Vorgabe ab („Value not allowed!“, z. B. als Lastverteil-Node) → Fehler', async () => {
  const b = await fakeEvse({ modeId: 1, rejectOverride: true });
  try {
    const r = await createSmartevseAdapter(() => ({ host: b.host })).charge(9);
    assert.equal(r.ok, false);
    assert.match(r.error, /nicht erlaubt|not allowed/i);
  } finally { b.server.close(); }
});
