// A23 b (Christin 23.11.2026): Modbus-Gesundheit und Slave-Begleitdienst messen Abstände monoton. Die Wanduhr (now)
// bleibt für die Anzeige (lastError.at, updatedAt); Fenster, Startphase, Antwortzeit und Config-Takt laufen über
// monoNow. Jeder Test lässt die Wanduhr springen, während die monotone Uhr normal weiterläuft.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createModbusHealth } from '../services/inverter/modbus-health.js';
import { createSungrowSecond } from '../services/inverter/sungrow-second.js';
import { wire } from '../services/inverter/sungrow.js';
import { sungrowImage, mockSungrow } from './helpers/sungrow-fixture.js';

function clocks(wall0 = 5_000_000_000, mono0 = 1000) {
  const c = { wall: wall0, mono: mono0 };
  c.now = () => c.wall;
  c.monoNow = () => c.mono;
  c.tick = (ms) => { c.wall += ms; c.mono += ms; };
  c.jump = (ms) => { c.wall += ms; };
  return c;
}

test('modbus-health: Rücksprung — Startphase endet nach 60 s Laufzeit, Antwortzeit wird gewertet', () => {
  const c = clocks();
  const h = createModbusHealth(c.now, { monoNow: c.monoNow });
  h.record(true, 9000); // Startphase
  c.jump(-3_600_000);
  c.tick(61_000);
  h.record(true, 40);
  assert.equal(h.responseMs(), 40);
});

test('modbus-health: Antwortzeit einer Anfrage, während der die Wanduhr springt, ist die echte Dauer', async () => {
  const c = clocks();
  const h = createModbusHealth(c.now, { monoNow: c.monoNow });
  const tx = h.wrap({ type: 'modbus', async mbRequest() { c.tick(25); c.jump(-3_600_000); return [1]; }, async mbWriteSingle() {}, async mbWriteMultiple() {} });
  c.tick(61_000);
  await tx.mbRequest({ address: 1 }); // erster Punkt setzt die Startphase
  c.tick(61_000);
  await tx.mbRequest({ address: 1 });
  assert.equal(h.responseMs(), 25);
});

test('modbus-health: Sprung vorwärts — Fehler der letzten 24 h und Anfragen/s bleiben, lastError.at bleibt Wanduhr', async () => {
  const c = clocks();
  const h = createModbusHealth(c.now, { monoNow: c.monoNow });
  for (let i = 0; i < 10; i += 1) { h.record(true, 10); c.tick(100); }
  h.record(false, 5, 'modbus timeout');
  const errAtWall = c.wall;
  c.jump(25 * 3_600_000);
  c.tick(500);
  const s = h.snapshot();
  assert.equal(s.errors24h, 1, 'Fehler vor 0,5 s zählt');
  assert.ok(s.requestsPerSec > 5, `Anfragen/s ${s.requestsPerSec}`);
  assert.equal(s.lastError.at, errAtWall, 'Anzeige: Wanduhrzeit des Fehlers');
});

test('modbus-health: Rücksprung — Fehler-Sammelfenster schließt nach 60 s Laufzeit', () => {
  const c = clocks();
  const logs = [];
  const h = createModbusHealth(c.now, { monoNow: c.monoNow, pushLog: (event, data) => logs.push({ event, data }), wr: 'master' });
  h.record(false, 1, 'modbus timeout');
  h.record(false, 1, 'modbus timeout');
  c.jump(-3_600_000);
  c.tick(61_000);
  h.snapshot();
  assert.ok(logs.some((l) => l.event === 'sungrow_modbus_error_summary'), 'Zusammenfassung nach 60 s');
});

test('modbus-health: ohne eigene monotone Uhr misst eine eingespielte Uhr auch die Abstände (Tests wie bisher)', () => {
  let t = 1_000_000;
  const h = createModbusHealth(() => t);
  h.record(true, 9000);
  t += 61_000;
  h.record(true, 30);
  assert.equal(h.responseMs(), 30);
});

function pollerRig(c) {
  const image = sungrowImage();
  const t = mockSungrow(image);
  const cfg = { sungrow: { secondInverter: { host: '192.168.68.83' } } };
  const state = {};
  const sec = createSungrowSecond({ state, getCfg: () => cfg, pushLog: () => {} }, { transport: t, now: c.now, monoNow: c.monoNow });
  const configReads = () => t.reads.filter((x) => x.fc === 3 && x.address === wire(33047)).length;
  return { state, sec, t, configReads };
}

test('sungrow-second: Rücksprung — Geräte-/Grenzwerte werden nach 15 s Laufzeit neu gelesen', async () => {
  const c = clocks();
  const r = pollerRig(c);
  await r.sec.tick();
  assert.equal(r.configReads(), 1);
  c.jump(-3_600_000);
  c.tick(16_000);
  await r.sec.tick();
  assert.equal(r.configReads(), 2, 'langsamer Takt nach 16 s Laufzeit fällig');
  assert.equal(r.state.sungrowSecond.updatedAt, c.wall, 'updatedAt bleibt Wanduhr');
});

test('sungrow-second: Sprung vorwärts — kein vorzeitiges Neulesen der Geräte-/Grenzwerte', async () => {
  const c = clocks();
  const r = pollerRig(c);
  await r.sec.tick();
  c.jump(3_600_000);
  c.tick(5000);
  await r.sec.tick();
  assert.equal(r.configReads(), 1, 'nach 5 s Laufzeit noch gecacht');
});
