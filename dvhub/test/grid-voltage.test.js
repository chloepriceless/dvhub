// test/grid-voltage.test.js — Netzspannung L1–L3 und Netzfrequenz zentral
// (services/grid-voltage.js): Victron Modbus mit Unit-Suche für den
// Netzzähler (GH #33), Victron MQTT, SPiNE EnergyLink, sonst leer. Abnehmer
// (Ortsnetz, Datenspende) lesen nur noch state.victron.gridVoltage.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGridVoltagePoller, readVictronGridVoltage, freshGridVoltage,
  VICTRON_GRID_REGS, GRID_SCAN_ORDER, GRID_VOLTAGE_POLL_MS, GRID_VOLTAGE_MAX_AGE_MS, GRID_UNIT_RESCAN_MS,
} from '../services/grid-voltage.js';
import { buildVictronSnapshot } from '../runtime-state.js';

// Nachgebauter GX wie in victron-gx-devices.test.js: unbekannte Unit →
// Ausnahme 10, unbekanntes Register → Ausnahme 2.
function fakeGx(units, { timeoutUnits = [] } = {}) {
  const calls = [];
  async function mbRequest({ unitId, fc, address, quantity }) {
    calls.push({ unitId, fc, address, quantity });
    assert.equal(fc, 3, 'nur lesen (FC3)');
    if (timeoutUnits.includes(unitId)) throw new Error('modbus timeout');
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
// Netzzähler-Register: 238,2 / 237,1 / 237,4 V, 49,98 Hz (Ströme dazwischen).
const GRID = { 2616: 2382, 2617: 142, 2618: 2371, 2619: 139, 2620: 2374, 2644: 4998 };
const SYSTEM = { 820: 100, 821: 200, 822: 300, 843: 55 };

function harness({ cfg = {}, transport, now = 1_000_000, state } = {}) {
  let t = now;
  const logs = [];
  const st = state || { meter: { consecutiveErrors: 0 }, victron: { errors: {} } };
  const c = { manufacturer: 'victron', victron: { host: 'gx', port: 502, unitId: 100, timeoutMs: 900 }, meter: {}, ...cfg };
  const poller = createGridVoltagePoller({
    state: st,
    pushLog: (event, details) => logs.push({ event, details }),
    getTransport: () => transport,
    now: () => t,
    firstDelayMs: 0,
  });
  return { st, logs, poller, cfg: c, advance: (ms) => { t += ms; }, now: () => t };
}

test('readVictronGridVoltage: Register 2616/2618/2620 ×0,1 V, 2644 ×0,01 Hz; 0xFFFF = nicht verfügbar', async () => {
  const calls = [];
  const mb = async (req) => {
    calls.push([req.unitId, req.address, req.quantity, req.fc]);
    return req.address === VICTRON_GRID_REGS.l1 ? [2376, 21, 2368, 65515, 0xffff] : [5004];
  };
  const r = await readVictronGridVoltage(mb, { host: 'gx', port: 502, unitId: 31 });
  assert.deepEqual(r, { l1: 237.6, l2: 236.8, l3: null, frequencyHz: 50.04 });
  assert.deepEqual(calls, [[31, 2616, 5, 3], [31, 2644, 1, 3]]);
});

test('Victron Modbus: konfigurierte Unit 100 liefert (wie auf Christins Anlage) → keine Suche', async () => {
  const gx = fakeGx({ 100: { ...SYSTEM, ...GRID } });
  const h = harness({ transport: { type: 'modbus', mbRequest: gx.mbRequest } });
  await h.poller.onPoll(h.cfg);
  const gv = h.st.victron.gridVoltage;
  assert.equal(gv.l1, 238.2);
  assert.equal(gv.l2, 237.1);
  assert.equal(gv.l3, 237.4);
  assert.equal(gv.frequencyHz, 49.98);
  assert.equal(gv.source, 'victron_modbus');
  assert.equal(gv.unitId, 100);
  assert.equal(gv.error, null);
  assert.equal(gv.updatedAt, h.now());
  assert.deepEqual(gx.calls.map((c) => c.unitId), [100, 100], 'nur die beiden Lesungen an Unit 100');
  assert.equal(h.logs.length, 0, 'keine Suche, kein Fund-Log');
});

test('Victron Modbus: Unit 100 mit Ausnahme 10 → Netzzähler-Unit gesucht (40), gemerkt und geloggt (GH #33)', async () => {
  const gx = fakeGx({ 40: GRID, 50: { 3900: 1 } });
  const h = harness({ transport: { type: 'modbus', mbRequest: gx.mbRequest } });
  await h.poller.onPoll(h.cfg);
  const gv = h.st.victron.gridVoltage;
  assert.equal(gv.unitId, 40);
  assert.equal(gv.l1, 238.2);
  assert.equal(gv.frequencyHz, 49.98);
  const found = h.logs.find((l) => l.event === 'victron_grid_meter_found');
  assert.ok(found, 'Fund steht im Log');
  assert.equal(found.details.unitId, 40);
  assert.equal(found.details.configuredUnitId, 100);
  // Suche: erst 30–49, bricht nach dem ersten Treffer ab.
  assert.equal(gx.calls[0].unitId, 100, 'zuerst die konfigurierte Unit');
  assert.ok(gx.calls.slice(1).every((c) => c.unitId >= 30 && c.unitId <= 40));
  // Nächster Takt: direkt Unit 40, keine Suche mehr.
  gx.calls.length = 0;
  h.advance(GRID_VOLTAGE_POLL_MS);
  await h.poller.onPoll(h.cfg);
  assert.deepEqual(gx.calls.map((c) => c.unitId), [40, 40]);
  assert.equal(h.logs.filter((l) => l.event === 'victron_grid_meter_found').length, 1);
});

test('Unit-Suche: typische Zähler-Units 30–49 zuerst, dann der Rest 1–247 (ohne die schon gefragte)', async () => {
  assert.deepEqual(GRID_SCAN_ORDER.slice(0, 20), Array.from({ length: 20 }, (_, i) => 30 + i));
  assert.equal(GRID_SCAN_ORDER.length, 247);
  assert.equal(new Set(GRID_SCAN_ORDER).size, 247);
  // EM540 an Unit 31: nach Unit 100 sind nur 30 und 31 gefragt.
  const gx = fakeGx({ 31: GRID });
  const h = harness({ transport: { type: 'modbus', mbRequest: gx.mbRequest } });
  await h.poller.onPoll(h.cfg);
  assert.equal(h.st.victron.gridVoltage.unitId, 31);
  assert.deepEqual(gx.calls.map((c) => c.unitId), [100, 30, 31, 31, 31]);
  // Zähler außerhalb des typischen Bereichs (z. B. 7) wird danach gefunden.
  const gx2 = fakeGx({ 7: GRID });
  const h2 = harness({ transport: { type: 'modbus', mbRequest: gx2.mbRequest } });
  await h2.poller.onPoll(h2.cfg);
  assert.equal(h2.st.victron.gridVoltage.unitId, 7);
});

test('Victron Modbus: Unit 100 antwortet, aber alle Spannungen 0xFFFF → Suche (EM540 an Unit 31)', async () => {
  const gx = fakeGx({ 100: { 2616: 0xffff, 2617: 0, 2618: 0xffff, 2619: 0, 2620: 0xffff, 2644: 0xffff }, 31: GRID });
  const h = harness({ transport: { type: 'modbus', mbRequest: gx.mbRequest } });
  await h.poller.onPoll(h.cfg);
  assert.equal(h.st.victron.gridVoltage.unitId, 31);
  assert.equal(h.st.victron.gridVoltage.l3, 237.4);
});

test('Victron Modbus: Zeitüberschreitung ist kein Grund zu suchen (GX weg) — Fehler, alte Werte bleiben alt', async () => {
  const gx = fakeGx({ 100: { ...SYSTEM, ...GRID } });
  let down = false;
  const transport = { type: 'modbus', mbRequest: async (req) => { if (down) throw new Error('modbus timeout'); return gx.mbRequest(req); } };
  const h = harness({ transport });
  await h.poller.onPoll(h.cfg);
  const firstAt = h.st.victron.gridVoltage.updatedAt;
  down = true;
  gx.calls.length = 0;
  h.advance(GRID_VOLTAGE_POLL_MS);
  await h.poller.onPoll(h.cfg);
  const gv = h.st.victron.gridVoltage;
  assert.match(gv.error, /timeout/);
  assert.equal(gv.updatedAt, firstAt, 'Messzeit bleibt die der letzten echten Messung');
  assert.equal(h.logs.some((l) => l.event === 'victron_grid_meter_found'), false);
});

test('Victron Modbus: kein Netzzähler zu finden → Fehler, neue Suche erst nach GRID_UNIT_RESCAN_MS', async () => {
  const gx = fakeGx({ 50: { 3900: 1 } });
  const h = harness({ transport: { type: 'modbus', mbRequest: gx.mbRequest } });
  await h.poller.onPoll(h.cfg);
  assert.equal(h.st.victron.gridVoltage.error, 'grid_meter_not_found');
  assert.ok(h.logs.some((l) => l.event === 'victron_grid_meter_not_found'));
  const scanned = gx.calls.length;
  assert.ok(scanned > 200, 'einmal alle Units gefragt');
  h.advance(GRID_VOLTAGE_POLL_MS);
  await h.poller.onPoll(h.cfg);
  assert.equal(gx.calls.length - scanned, 1, 'nur die konfigurierte Unit erneut, keine neue Suche');
  h.advance(GRID_UNIT_RESCAN_MS);
  await h.poller.onPoll(h.cfg);
  assert.ok(gx.calls.length - scanned > 200, 'nach der Pause wird wieder gesucht');
});

test('Victron Modbus: gemerkte Unit fällt weg → vergessen und neu gesucht', async () => {
  const units = { 40: GRID };
  const gx = fakeGx(units);
  const h = harness({ transport: { type: 'modbus', mbRequest: gx.mbRequest } });
  await h.poller.onPoll(h.cfg);
  assert.equal(h.st.victron.gridVoltage.unitId, 40);
  delete units[40];
  units[41] = GRID;
  h.advance(GRID_VOLTAGE_POLL_MS);
  await h.poller.onPoll(h.cfg);
  assert.equal(h.st.victron.gridVoltage.unitId, 41);
});

test('Takt: zwischen zwei Lesungen mindestens GRID_VOLTAGE_POLL_MS, nur lesend', async () => {
  const gx = fakeGx({ 100: { ...SYSTEM, ...GRID } });
  const h = harness({ transport: { type: 'modbus', mbRequest: gx.mbRequest } });
  await h.poller.onPoll(h.cfg);
  h.advance(1000);
  await h.poller.onPoll(h.cfg);
  assert.equal(gx.calls.length, 2, 'zweiter Aufruf 1 s später liest nicht');
  assert.ok(GRID_VOLTAGE_POLL_MS >= 30_000 && GRID_VOLTAGE_POLL_MS <= 60_000);
});

test('Gesundheits-Sperre: Steuer-Abfrage gestört → keine Spannungs-Lesung', async () => {
  const gx = fakeGx({ 100: GRID });
  const h = harness({ transport: { type: 'modbus', mbRequest: gx.mbRequest }, state: { meter: { consecutiveErrors: 2 }, victron: {} } });
  await h.poller.onPoll(h.cfg);
  assert.equal(gx.calls.length, 0);
});

test('Victron MQTT: Werte aus dem Transport (Grid-Topics), Messzeit = Empfangszeit', async () => {
  const transport = { type: 'mqtt', readGridVoltage: () => ({ l1: 231.5, l2: 232, l3: null, frequencyHz: 50.01, ts: 999_000 }) };
  const h = harness({ transport });
  await h.poller.onPoll(h.cfg);
  const gv = h.st.victron.gridVoltage;
  assert.deepEqual([gv.l1, gv.l2, gv.l3, gv.frequencyHz, gv.source, gv.updatedAt], [231.5, 232, null, 50.01, 'victron_mqtt', 999_000]);
});

test('MQTT ohne Spannungen (DVhub-Schema) bzw. andere Hersteller per Modbus → leer, keine Lesung', async () => {
  const mqtt = harness({ transport: { type: 'mqtt', readGridVoltage: () => null } });
  await mqtt.poller.onPoll(mqtt.cfg);
  assert.equal(mqtt.st.victron.gridVoltage, null);
  const plain = harness({ transport: { type: 'mqtt' } });
  await plain.poller.onPoll(plain.cfg);
  assert.equal(plain.st.victron.gridVoltage, null);
  const gx = fakeGx({ 100: GRID });
  for (const manufacturer of ['fronius', 'deye-lv']) {
    const h = harness({ cfg: { manufacturer }, transport: { type: 'modbus', mbRequest: gx.mbRequest } });
    await h.poller.onPoll(h.cfg);
    assert.equal(h.st.victron.gridVoltage, null, manufacturer);
  }
  assert.equal(gx.calls.length, 0);
});

test('SPiNE EnergyLink (spine-http): Spannungen aus EM.GetStatus, 0 V = Phase nicht belegt', async () => {
  const h = harness({ cfg: { meter: { readType: 'spine-http' } }, transport: { type: 'modbus', mbRequest: async () => { throw new Error('nicht benutzen'); } } });
  await h.poller.onPoll(h.cfg, { spine: { a_voltage: 235.775, b_voltage: 0, c_voltage: 0, freq: 50.022 }, spineAt: 123 });
  const gv = h.st.victron.gridVoltage;
  assert.deepEqual([gv.l1, gv.l2, gv.l3, gv.frequencyHz, gv.source, gv.updatedAt], [235.8, null, null, 50.02, 'spine_http', 123]);
});

test('freshGridVoltage: frisch nur bis GRID_VOLTAGE_MAX_AGE_MS; fehlend/alt mit Grund', () => {
  const gv = { l1: 230, l2: 231, l3: 232, frequencyHz: 50, updatedAt: 1_000_000, source: 'victron_modbus', error: null };
  assert.equal(GRID_VOLTAGE_MAX_AGE_MS, 120_000);
  assert.equal(freshGridVoltage(gv, 1_000_000 + 119_000).ok, true);
  assert.deepEqual(freshGridVoltage(gv, 1_000_000 + 121_000), { ok: false, reason: 'voltage_stale' });
  assert.deepEqual(freshGridVoltage(null, 1), { ok: false, reason: 'voltage_unavailable' });
  assert.deepEqual(freshGridVoltage({ ...gv, l1: null, l2: null, l3: null }, 1_000_000), { ok: false, reason: 'voltage_unavailable' });
  assert.deepEqual(freshGridVoltage({ error: 'grid_meter_not_found', updatedAt: null }, 1), { ok: false, reason: 'voltage_unavailable', error: 'grid_meter_not_found' });
});

test('/api/status: gridVoltage überlebt den Poller-Snapshot (Whitelist)', () => {
  const gv = { l1: 230, l2: 231, l3: 232, frequencyHz: 50, updatedAt: 5, source: 'victron_modbus', unitId: 40, error: null };
  const snap = buildVictronSnapshot({ soc: 50, gridVoltage: gv });
  assert.deepEqual(snap.gridVoltage, gv);
  // Web-seitiger zweiter Durchlauf (gefilterter Snapshot) behält es ebenfalls.
  assert.deepEqual(buildVictronSnapshot(snap).gridVoltage, gv);
});

// Codex-Gegenprüfung 7f88bc74 (3× P2).
test('Unit-Suche: Treffer ohne Spannung (alle 0xFFFF) → weitersuchen, nicht an ihm hängen bleiben', async () => {
  const dead = { 2616: 0xffff, 2617: 0, 2618: 0xffff, 2619: 0, 2620: 0xffff, 2644: 0xffff };
  const gx = fakeGx({ 30: dead, 33: GRID });
  const h = harness({ transport: { type: 'modbus', mbRequest: gx.mbRequest } });
  await h.poller.onPoll(h.cfg);
  assert.equal(h.st.victron.gridVoltage.unitId, 33);
  assert.equal(h.st.victron.gridVoltage.error, null);
});

test('MQTT: Zufluss bricht ab → letzte Messung bleibt mit alter Messzeit (Kachel zeigt „veraltet“)', async () => {
  let g = { l1: 231.5, l2: 232, l3: 233, frequencyHz: 50, ts: 990_000 };
  const transport = { type: 'mqtt', readGridVoltage: () => g };
  const h = harness({ transport });
  await h.poller.onPoll(h.cfg);
  g = null;
  h.advance(5 * 60_000);
  await h.poller.onPoll(h.cfg);
  const gv = h.st.victron.gridVoltage;
  assert.equal(gv.l1, 231.5);
  assert.equal(gv.updatedAt, 990_000);
  assert.deepEqual(freshGridVoltage(gv, h.now()), { ok: false, reason: 'voltage_stale' });
});

test('MQTT: Messzeit je Phase (phaseAt) bleibt erhalten und steht in freshGridVoltage', async () => {
  const transport = { type: 'mqtt', readGridVoltage: () => ({ l1: 231, l2: 232, l3: 233, frequencyHz: 50, ts: 999_000, phaseTs: [999_500, 999_000, 999_800] }) };
  const h = harness({ transport });
  await h.poller.onPoll(h.cfg);
  assert.deepEqual(h.st.victron.gridVoltage.phaseAt, { l1: 999_500, l2: 999_000, l3: 999_800 });
  assert.deepEqual(freshGridVoltage(h.st.victron.gridVoltage, h.now()).phaseAt, { l1: 999_500, l2: 999_000, l3: 999_800 });
});

test('MQTT: ausdrücklich ungültig gemeldete Spannungen (invalidated) → sofort keine Werte, nicht die alte Messung', async () => {
  let g = { l1: 231.5, l2: 232, l3: 233, frequencyHz: 50, ts: 990_000 };
  const h = harness({ transport: { type: 'mqtt', readGridVoltage: () => g } });
  await h.poller.onPoll(h.cfg);
  g = { l1: null, l2: null, l3: null, frequencyHz: null, ts: 995_000, invalidated: true };
  await h.poller.onPoll(h.cfg);
  assert.equal(h.st.victron.gridVoltage, null);
});

// Codex de261f07 (P2): Liefert die gemerkte Unit einmal keine Spannung (alle
// 0xFFFF) oder eine Ausnahme, wurde sie vergessen; die Suche schloss sie aus,
// fand nichts und sperrte 30 min. Danach fragte DVhub nur noch Unit 100 —
// die Werte blieben weg, obwohl Unit 40 längst wieder antwortete.
test('Victron Modbus: gemerkte Unit kurz ohne Spannung → in der Such-Pause erneut gefragt', async () => {
  const units = { 40: GRID };
  const gx = fakeGx(units);
  const h = harness({ transport: { type: 'modbus', mbRequest: gx.mbRequest } });
  await h.poller.onPoll(h.cfg);
  assert.equal(h.st.victron.gridVoltage.unitId, 40);
  units[40] = { ...GRID, 2616: 0xFFFF, 2618: 0xFFFF, 2620: 0xFFFF };
  h.advance(GRID_VOLTAGE_POLL_MS);
  await h.poller.onPoll(h.cfg);
  assert.equal(h.st.victron.gridVoltage.error, 'grid_meter_not_found');
  units[40] = GRID;
  h.advance(GRID_VOLTAGE_POLL_MS);
  await h.poller.onPoll(h.cfg);
  const gv = h.st.victron.gridVoltage;
  assert.equal(gv.error, null);
  assert.equal(gv.unitId, 40);
  assert.equal(gv.l1, 238.2);
});

// Codex 617760b9 (P2): Läuft die weggefallene Unit danach in Zeitüberschreitungen,
// darf ihr Wiederholen die fällige Suche nicht verhindern — ein Ersatzzähler
// auf einer anderen Unit muss gefunden werden.
test('Victron Modbus: weggefallene Unit mit Zeitüberschreitung hält die fällige Suche nicht auf', async () => {
  const units = { 40: GRID };
  const timeoutUnits = [];
  const gx = fakeGx(units, { timeoutUnits });
  const h = harness({ transport: { type: 'modbus', mbRequest: gx.mbRequest } });
  await h.poller.onPoll(h.cfg);
  assert.equal(h.st.victron.gridVoltage.unitId, 40);
  units[40] = { ...GRID, 2616: 0xFFFF, 2618: 0xFFFF, 2620: 0xFFFF };
  h.advance(GRID_VOLTAGE_POLL_MS);
  await h.poller.onPoll(h.cfg);
  timeoutUnits.push(40);
  units[41] = GRID;
  h.advance(GRID_UNIT_RESCAN_MS);
  await h.poller.onPoll(h.cfg);
  assert.equal(h.st.victron.gridVoltage.unitId, 41);
  assert.equal(h.st.victron.gridVoltage.error, null);
});
