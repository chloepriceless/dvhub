import test from 'node:test';
import assert from 'node:assert/strict';

import { createLimitStateMachine, HEARTBEAT_TIMEOUT_MS } from '../services/eebus/limit-state.js';

function machine(opts = {}) {
  let t = 1_000_000;
  const m = createLimitStateMachine({ kind: 'lpc', failsafeW: 4200, failsafeDurationS: 7200, now: () => t, ...opts });
  return { m, advance: (ms) => { t += ms; }, now: () => t };
}

test('ohne gekoppelte Steuerbox: disabled, nie Failsafe', () => {
  const { m, advance } = machine();
  assert.equal(m.effective().state, 'disabled');
  advance(10 * HEARTBEAT_TIMEOUT_MS);
  m.evaluate();
  assert.deepEqual(m.effective(), { state: 'disabled', limitW: null, reason: 'disabled', until: null });
});

test('init → unlimited_controlled, sobald der Heartbeat da ist', () => {
  const { m, advance } = machine();
  m.setEnabled(true);
  assert.equal(m.effective().state, 'init');
  assert.equal(m.effective().limitW, null, 'in init keine Begrenzung');
  advance(30_000);
  m.onHeartbeat(true);
  assert.equal(m.effective().state, 'unlimited_controlled');
});

test('init ohne Heartbeat: nach 120 s Failsafe mit Failsafe-Grenze', () => {
  const { m, advance } = machine();
  m.setEnabled(true);
  advance(HEARTBEAT_TIMEOUT_MS - 1);
  m.evaluate();
  assert.equal(m.effective().state, 'init');
  advance(1);
  m.evaluate();
  assert.equal(m.effective().state, 'failsafe');
  assert.equal(m.effective().limitW, 4200);
});

test('limited: Grenze gilt bis zum Ablauf ihrer Dauer', () => {
  const { m, advance, now } = machine();
  m.setEnabled(true);
  m.onHeartbeat(true);
  m.onLimit({ w: 6000, durationS: 900, active: true });
  assert.deepEqual(m.effective(), { state: 'limited', limitW: 6000, reason: 'lpc_limit', until: now() + 900_000 });
  advance(899_000);
  m.evaluate();
  assert.equal(m.effective().state, 'limited');
  advance(2_000);
  m.evaluate();
  assert.equal(m.effective().state, 'unlimited_controlled');
  assert.equal(m.effective().limitW, null);
});

test('Grenze ohne Dauer gilt unbefristet; active=false hebt sie auf', () => {
  const { m, advance } = machine();
  m.setEnabled(true);
  m.onHeartbeat(true);
  m.onLimit({ w: 5000, durationS: 0, active: true });
  advance(48 * 3600_000);
  m.onHeartbeat(true);
  assert.equal(m.effective().limitW, 5000);
  m.onLimit({ w: 5000, durationS: 0, active: false });
  assert.equal(m.effective().state, 'unlimited_controlled');
});

test('Heartbeat-Verlust in limited → nach 120 s Failsafe mit vom EG geschriebenen Werten', () => {
  const { m, advance } = machine();
  m.setEnabled(true);
  m.onHeartbeat(true);
  m.onFailsafeLimit(3000);
  m.onFailsafeDuration(10800);
  m.onLimit({ w: 6000, durationS: 3600, active: true });
  m.onHeartbeat(false);
  assert.equal(m.effective().state, 'limited', 'sofort nach dem Abbruch: Grenze gilt weiter');
  advance(HEARTBEAT_TIMEOUT_MS - 1);
  m.evaluate();
  assert.equal(m.effective().state, 'limited');
  advance(1);
  m.evaluate();
  const e = m.effective();
  assert.equal(e.state, 'failsafe');
  assert.equal(e.limitW, 3000);
});

// Fable R2 P3-1: dvhub-eebus in Go meldet „weg“ erst, wenn eebus-go selbst
// 2 min ohne Herzschlag festgestellt hat (IsHeartbeatWithinDuration) — dann
// nicht noch einmal 120 s warten (sonst Failsafe erst nach rund 4 min).
test('Herzschlag-Verlust schon mit Frist geprüft (Go): Failsafe sofort, nicht nach weiteren 120 s', () => {
  const { m, advance } = machine();
  m.setEnabled(true);
  m.onHeartbeat(true);
  m.onLimit({ w: 6000, durationS: 3600, active: true });
  advance(5_000);
  m.evaluate();
  m.onHeartbeat(false, { durationChecked: true });
  assert.equal(m.effective().state, 'failsafe');
});

test('kurzer Verbindungsabbruch (< 120 s) löst keinen Failsafe aus', () => {
  const { m, advance } = machine();
  m.setEnabled(true);
  m.onHeartbeat(true);
  advance(10 * 60_000);
  m.evaluate();
  m.onHeartbeat(false);
  advance(90_000);
  m.evaluate();
  m.onHeartbeat(true);
  advance(60_000);
  m.evaluate();
  assert.equal(m.effective().state, 'unlimited_controlled');
});

test('Failsafe hält die Mindestdauer, auch wenn der Heartbeat zurückkommt', () => {
  const { m, advance } = machine();
  m.setEnabled(true);
  m.onHeartbeat(true);
  m.onHeartbeat(false);
  advance(HEARTBEAT_TIMEOUT_MS);
  m.evaluate();
  advance(600_000);
  m.onHeartbeat(true);
  assert.equal(m.effective().state, 'failsafe', 'Heartbeat allein beendet den Failsafe nicht');
  advance(7200_000);
  m.evaluate();
  assert.equal(m.effective().state, 'unlimited_controlled');
});

test('neue Grenze der wieder verbundenen Steuerbox beendet den Failsafe sofort', () => {
  const { m, advance } = machine();
  m.setEnabled(true);
  m.onHeartbeat(true);
  m.onHeartbeat(false);
  advance(HEARTBEAT_TIMEOUT_MS);
  m.evaluate();
  assert.equal(m.effective().state, 'failsafe');
  advance(60_000);
  m.onLimit({ w: 7000, durationS: 600, active: true });
  m.evaluate();
  assert.equal(m.effective().state, 'limited');
  assert.equal(m.effective().limitW, 7000);
});

test('Failsafe abgelaufen, Steuerbox weiter weg → unlimited_autonomous; Rückkehr → controlled', () => {
  const { m, advance } = machine();
  m.setEnabled(true);
  m.onHeartbeat(true);
  m.onHeartbeat(false);
  advance(HEARTBEAT_TIMEOUT_MS);
  m.evaluate();
  advance(7200_000);
  m.evaluate();
  assert.equal(m.effective().state, 'unlimited_autonomous');
  assert.equal(m.effective().limitW, null);
  m.onHeartbeat(true);
  assert.equal(m.effective().state, 'unlimited_controlled');
});

test('Neustart: Failsafe-Werte und laufender Failsafe bleiben erhalten', () => {
  const a = machine();
  a.m.setEnabled(true);
  a.m.onHeartbeat(true);
  a.m.onFailsafeLimit(2500);
  a.m.onFailsafeDuration(14400);
  a.m.onHeartbeat(false);
  a.advance(HEARTBEAT_TIMEOUT_MS);
  a.m.evaluate();
  const saved = JSON.parse(JSON.stringify(a.m.toJSON()));

  let t = a.now() + 3600_000;
  const b = createLimitStateMachine({ kind: 'lpc', failsafeW: 4200, failsafeDurationS: 7200, now: () => t });
  b.setEnabled(true);
  b.restore(saved);
  assert.equal(b.effective().state, 'failsafe');
  assert.equal(b.effective().limitW, 2500);
  t += 3 * 3600_000 + 1;
  b.evaluate();
  assert.equal(b.effective().state, 'unlimited_autonomous', 'Failsafe endet 4 h nach seinem ursprünglichen Beginn');
});

// Fable R2 P2-4: Steuerbox dimmt auf 4,2 kW für 2 h, DVhub startet neu (Update).
// Vorher galt bis zum ersten Herzschlag (bis 120 s) gar keine Grenze.
test('Neustart während einer Begrenzung: die gespeicherte, noch gültige Grenze gilt sofort (schon in init)', () => {
  const a = machine();
  a.m.setEnabled(true);
  a.m.onHeartbeat(true);
  a.m.onLimit({ w: 4200, durationS: 7200, active: true });
  const saved = JSON.parse(JSON.stringify(a.m.toJSON()));

  let t = a.now() + 60_000;
  const b = createLimitStateMachine({ kind: 'lpc', failsafeW: 4200, failsafeDurationS: 7200, now: () => t });
  b.setEnabled(true);
  b.restore(saved);
  assert.equal(b.effective().state, 'init');
  assert.equal(b.effective().limitW, 4200, 'sofort nach dem Neustart');
  assert.equal(b.effective().until, saved.limit.until);
  t += 100_000;
  b.evaluate();
  assert.equal(b.effective().limitW, 4200, 'auch ohne Herzschlag');
  b.onHeartbeat(true);
  assert.deepEqual([b.effective().state, b.effective().limitW], ['limited', 4200]);
});

test('Neustart: abgelaufene oder aufgehobene gespeicherte Grenze gilt in init nicht', () => {
  const t = 1_000_000;
  const b = createLimitStateMachine({ kind: 'lpc', failsafeW: 4200, failsafeDurationS: 7200, now: () => t });
  b.setEnabled(true);
  b.restore({ limit: { w: 4200, active: true, receivedAt: t - 8000_000, until: t - 1000 } });
  assert.equal(b.effective().limitW, null, 'abgelaufen');
  const c = createLimitStateMachine({ kind: 'lpc', failsafeW: 4200, failsafeDurationS: 7200, now: () => t });
  c.setEnabled(true);
  c.restore({ limit: { w: 4200, active: false, receivedAt: t - 1000, until: null } });
  assert.equal(c.effective().limitW, null, 'aufgehoben');
});

test('nur von der Steuerbox geschriebene Failsafe-Werte werden gespeichert', () => {
  const { m } = machine();
  m.setEnabled(true);
  assert.equal(m.toJSON().failsafeW, null, 'Vorgabe aus der Konfiguration: nicht speichern');
  m.onFailsafeLimit(3100);
  assert.equal(m.toJSON().failsafeW, 3100);
  assert.equal(m.toJSON().failsafeDurationS, null);
});
