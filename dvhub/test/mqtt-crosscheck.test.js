// T-CROSSCHECK — Zweitquellen-Kreuzprobe (2026-07-25).
//
// Anlass: der Zwischenfall vom 24.07.2026 war aus Modbus-Daten heraus NICHT
// erkennbar (Werte bewegten sich, Bilanz sauber, Soll/Ist passte, zweite
// Modbus-Sitzung identisch falsch). Nur eine Quelle außerhalb von dbus-modbustcp
// sieht ihn. Gemessen an der realen Anlage stimmen beide Wege im Normalbetrieb auf
// den Watt überein (Abweichung 0) — die Toleranzen hier sind also großzügig, und
// die Fehlalarm-Sperren (Frische beider Seiten, Anhalten über sustainMs) sind das,
// was diese Tests festnageln.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compareSources,
  resolveCrossCheckOptions,
  CROSSCHECK_FIELDS
} from '../services/mqtt-crosscheck.js';

const OPTS = resolveCrossCheckOptions({
  victron: { mqttCrossCheck: { enabled: true, sustainMs: 60000, maxAgeMs: 60000 } }
});

const fresh = (o) => ({ ...o, soc_ageMs: 1000, batteryPowerW_ageMs: 1000, gridTotalW_ageMs: 1000 });

function run(state, { cycles, stepMs = 15000, t0 = 1_000_000, mqtt, modbus }) {
  let last = null;
  for (let i = 0; i < cycles; i += 1) {
    last = compareSources(fresh(mqtt(i)), fresh(modbus(i)), state, OPTS, t0 + i * stepMs);
  }
  return last;
}

test('einige Felder, gleiche Werte: kein Widerspruch', () => {
  const state = { fields: {}, active: false, since: null };
  run(state, {
    cycles: 40,
    mqtt: (i) => ({ soc: 55, batteryPowerW: -1200 + i, gridTotalW: 800 + i }),
    modbus: (i) => ({ soc: 55, batteryPowerW: -1200 + i, gridTotalW: 800 + i })
  });
  assert.equal(state.active, false);
});

test('kleine Abweichungen innerhalb der Toleranz lösen nicht aus', () => {
  const state = { fields: {}, active: false, since: null };
  run(state, {
    cycles: 40,
    // 250 W unter der 400-W-Grenze; SoC 2 % unter 3 %
    mqtt: () => ({ soc: 55, batteryPowerW: -1200, gridTotalW: 800 }),
    modbus: () => ({ soc: 53, batteryPowerW: -1450, gridTotalW: 1050 })
  });
  assert.equal(state.active, false);
});

test('anhaltender Widerspruch löst nach sustainMs aus — und nur einmal', () => {
  const state = { fields: {}, active: false, since: null };
  const transitions = [];
  for (let i = 0; i < 40; i += 1) {
    const t = 1_000_000 + i * 15000;
    // Das reale Bild vom 24.07.: DVhub sah Einspeisung, die Anlage stand auf Eigenverbrauch.
    const r = compareSources(
      fresh({ soc: 11, batteryPowerW: -200, gridTotalW: -150 }),
      fresh({ soc: 7, batteryPowerW: -100, gridTotalW: 6400 }),
      state, OPTS, t
    );
    if (r.transition) transitions.push([r.transition, i]);
  }
  assert.deepEqual(transitions.map((x) => x[0]), ['mismatch']);
  assert.equal(transitions[0][1], 4, 'nach 60 s Anhalten (4 × 15 s)');
  assert.equal(state.active, true);
  const keys = state.mismatches.map((m) => m.key).sort();
  assert.deepEqual(keys, ['gridTotalW', 'soc']);
});

test('kurzer Ausreißer (unter sustainMs) löst NICHT aus', () => {
  const state = { fields: {}, active: false, since: null };
  for (let i = 0; i < 40; i += 1) {
    const spike = i >= 10 && i < 12;   // 30 s Abweichung
    compareSources(
      fresh({ soc: 55, batteryPowerW: -1200, gridTotalW: spike ? 6000 : 800 }),
      fresh({ soc: 55, batteryPowerW: -1200, gridTotalW: 800 }),
      state, OPTS, 1_000_000 + i * 15000
    );
  }
  assert.equal(state.active, false);
});

test('Erholung meldet genau einen Übergang zurück', () => {
  const state = { fields: {}, active: false, since: null };
  const transitions = [];
  for (let i = 0; i < 40; i += 1) {
    const bad = i >= 5 && i < 25;
    const r = compareSources(
      fresh({ soc: 55, batteryPowerW: -1200, gridTotalW: 800 }),
      fresh({ soc: bad ? 40 : 55, batteryPowerW: -1200, gridTotalW: 800 }),
      state, OPTS, 1_000_000 + i * 15000
    );
    if (r.transition) transitions.push(r.transition);
  }
  assert.deepEqual(transitions, ['mismatch', 'clear']);
  assert.equal(state.active, false);
  assert.equal(state.since, null);
});

test('veraltete Werte auf EINER Seite sind kein Widerspruch, sondern Unwissen', () => {
  const state = { fields: {}, active: false, since: null };
  for (let i = 0; i < 40; i += 1) {
    compareSources(
      { soc: 11, gridTotalW: -150, soc_ageMs: 300000, gridTotalW_ageMs: 300000 },  // MQTT alt
      fresh({ soc: 7, batteryPowerW: -100, gridTotalW: 6400 }),
      state, OPTS, 1_000_000 + i * 15000
    );
  }
  assert.equal(state.active, false, 'dafür ist die T-0075-Frische zuständig');
});

test('fehlende Zweitquelle (MQTT liefert gar nichts) löst nie aus', () => {
  const state = { fields: {}, active: false, since: null };
  for (let i = 0; i < 40; i += 1) {
    compareSources({}, fresh({ soc: 7, batteryPowerW: -100, gridTotalW: 6400 }),
      state, OPTS, 1_000_000 + i * 15000);
  }
  assert.equal(state.active, false);
});

test('Optionen: Default AUS, Broker/Portal-ID fallen auf den MQTT-Block zurück', () => {
  assert.equal(resolveCrossCheckOptions({}).enabled, false);
  const o = resolveCrossCheckOptions({
    victron: { host: '10.0.0.9', mqtt: { portalId: 'abc123', password: 'geheim' },
      mqttCrossCheck: { enabled: true } }
  });
  assert.equal(o.enabled, true);
  assert.equal(o.broker, 'mqtts://10.0.0.9:8883');
  assert.equal(o.portalId, 'abc123');
  assert.equal(o.password, 'geheim');
});

test('Feld-Katalog deckt genau die drei steuerrelevanten Größen ab', () => {
  assert.deepEqual(CROSSCHECK_FIELDS.map((f) => f.key), ['soc', 'batteryPowerW', 'gridTotalW']);
});

// ── MQTT-Pfade für den möglichen Umzug (T-MQTT-ALARMS / T-MQTT-READBACK) ─────
// Die dbus-Pfadliste stammt aus einem Live-Dump des Ekrano GX (Venus 3.73,
// 2026-07-25) — diese Tests nageln die Decodier-Semantik fest, insbesondere die
// null-Behandlung: Venus meldet nicht unterstützte Alarme als null, und die als 0
// („alles in Ordnung") zu lesen wäre ein stiller Fehlalarm in die andere Richtung.
test('MQTT-Alarme: dieselbe Ausgabeform wie der Register-Weg', async () => {
  const { buildActiveAlarmsFromDbus } = await import('../victron-alarms.js');
  const active = buildActiveAlarmsFromDbus({
    vebus: { 'VebusError': 0, 'Alarms/Overload': 2, 'Alarms/HighTemperature': 1, 'Alarms/BmsPreAlarm': null },
    battery: { 'Alarms/LowVoltage': 0, 'Alarms/HighChargeCurrent': 2 }
  }, [], Date.parse('2026-07-25T00:00:00Z'));
  assert.deepEqual(active.map((a) => [a.key, a.severity]), [
    ['batt.highChargeCurrent', 2],
    ['vebus.overload', 2],
    ['vebus.highTemp', 1]
  ]);
  assert.equal(active[0].unit, 'battery');
});

test('MQTT-Alarme: null heißt „Gerät kennt den Alarm nicht", nicht „alles gut"', async () => {
  const { buildActiveAlarmsFromDbus } = await import('../victron-alarms.js');
  const active = buildActiveAlarmsFromDbus({ vebus: { 'Alarms/BmsPreAlarm': null }, battery: {} }, [], Date.now());
  assert.deepEqual(active, []);
});

test('MQTT-Alarme: VE.Bus-Fehlercode wird als Klartext mitgeliefert', async () => {
  const { buildActiveAlarmsFromDbus } = await import('../victron-alarms.js');
  const active = buildActiveAlarmsFromDbus({ vebus: { 'VebusError': 17 }, battery: {} }, [], Date.now());
  assert.equal(active[0].key, 'vebus.error');
  assert.match(active[0].text, /Master ausgefallen/);
});

test('MQTT-Alarme: seit-Zeitstempel bleibt über Zyklen stehen', async () => {
  const { buildActiveAlarmsFromDbus } = await import('../victron-alarms.js');
  const t0 = Date.parse('2026-07-25T01:00:00Z');
  const first = buildActiveAlarmsFromDbus({ vebus: { 'Alarms/Overload': 2 }, battery: {} }, [], t0);
  const second = buildActiveAlarmsFromDbus({ vebus: { 'Alarms/Overload': 2 }, battery: {} }, first, t0 + 600000);
  assert.equal(second[0].since, first[0].since);
});

test('MQTT-Profil kennt die Entladegrenze als Rücklesepunkt', async () => {
  const { createRequire } = await import('node:module');
  const profile = createRequire(import.meta.url)('../hersteller/bridge-mqtt.json');
  assert.equal(profile.points.maxDischargeW?.enabled, true);
});
