// test/ev-max-stop-soc-alter.test.js -- Fable R5 P3-2: Der Max-Stopp nimmt nur
// einen Ladestand, der nach dem zuletzt gesehenen Abstecken gelesen wurde.
// Sonst: TeslaMate (ohne Altersgrenze) bzw. evcc-Fahrzeugtreiber (bis 24 h)
// melden noch 85 % von vor der Fahrt, das Auto kommt mit 40 % zurück, und
// DVhub schaltet die Wallbox bei Max 80 % jeden Takt hart aus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as evSoc from '../services/optimizer/ev-soc.js';

function fakeCtx() {
  const s = { connected: true, soc: 85, socAt: Date.parse('2026-11-16T06:00:00Z') };
  const ctx = {
    getCfg: () => ({ optimizer: { evSocSource: 'teslamate' } }),
    mainWallbox: { state: () => ({ type: 'goe', available: true, connected: s.connected }) },
    teslamateService: {
      getState: () => ({ batteryLevel: s.soc }),
      getFieldUpdatedAt: () => ({ batteryLevel: new Date(s.socAt).toISOString() }),
    },
  };
  return { ctx, s };
}

test('Ladestand von vor der Fahrt zählt nach dem Wieder-Anstecken nicht', () => {
  assert.equal(typeof evSoc.createMaxStopSoc, 'function');
  const { ctx, s } = fakeCtx();
  const m = evSoc.createMaxStopSoc();
  // Angesteckt, frischer Wert: gilt.
  assert.equal(m.resolve(ctx, Date.parse('2026-11-16T06:05:00Z'))?.pct, 85);
  // Abgesteckt um 07:00 (Fahrt), zurück um 18:00 — TeslaMate meldet nichts Neues.
  s.connected = false;
  assert.equal(m.resolve(ctx, Date.parse('2026-11-16T07:00:00Z')), null);
  s.connected = true;
  assert.equal(m.resolve(ctx, Date.parse('2026-11-16T18:00:00Z')), null, 'alter Wert: kein Max-Stopp');
  // Neuer Wert nach dem Anstecken: gilt wieder — auch, wenn er danach lange nicht neu kommt
  // (schlafendes Auto nach dem Stopp: kein Flattern).
  s.soc = 41; s.socAt = Date.parse('2026-11-16T18:02:00Z');
  assert.equal(m.resolve(ctx, Date.parse('2026-11-16T18:03:00Z'))?.pct, 41);
  assert.equal(m.resolve(ctx, Date.parse('2026-11-17T05:00:00Z'))?.pct, 41);
});

test('Wert ohne Zeitpunkt: kein Max-Stopp', () => {
  const { ctx } = fakeCtx();
  ctx.teslamateService.getFieldUpdatedAt = () => ({});
  ctx.teslamateService.lastUpdateAt = null;
  assert.equal(evSoc.createMaxStopSoc().resolve(ctx, Date.now()), null);
});

test('Steck-Zustand unbekannt: Wert gilt wie bisher', () => {
  const { ctx } = fakeCtx();
  ctx.mainWallbox = { state: () => ({ type: 'goe', available: false }) };
  assert.equal(evSoc.createMaxStopSoc().resolve(ctx, Date.parse('2026-11-16T06:05:00Z'))?.pct, 85);
});

// ── Codex e957655a ──
test('Box kennt den Steck-Zustand nicht (EEBUS nur LPC, nach dem Stopp „nicht verbunden“): kein Abstecken', () => {
  const { ctx } = fakeCtx();
  ctx.mainWallbox = { state: () => ({ type: 'eebus', available: true, connected: false, connectedKnown: false }) };
  const m = evSoc.createMaxStopSoc();
  assert.equal(m.resolve(ctx, Date.parse('2026-11-16T06:05:00Z'))?.pct, 85);
  assert.equal(m.resolve(ctx, Date.parse('2026-11-16T06:30:00Z'))?.pct, 85, 'Wert gilt weiter');
});

test('Abstecken zählt mit dem Zeitpunkt der Abfrage, nicht dem des Lesens', () => {
  const { ctx, s } = fakeCtx();
  const st = { connected: false, sampleAt: Date.parse('2026-11-16T18:00:00Z') };
  ctx.mainWallbox = { state: () => ({ type: 'goe', available: true, connected: st.connected, connectedKnown: true, sampleAt: st.sampleAt }) };
  const m = evSoc.createMaxStopSoc();
  // Frischer Ladestand kommt 18:00:10, die Box meldet bis zur nächsten Abfrage noch „abgesteckt“.
  s.soc = 42; s.socAt = Date.parse('2026-11-16T18:00:10Z');
  assert.equal(m.resolve(ctx, Date.parse('2026-11-16T18:00:12Z')), null);
  st.connected = true; st.sampleAt = Date.parse('2026-11-16T18:00:15Z');
  assert.equal(m.resolve(ctx, Date.parse('2026-11-16T18:00:16Z'))?.pct, 42, 'frischer Wert gilt nach dem Anstecken');
});

// ── Codex 5753e29c ──
test('Wallbox kennt den Steck-Zustand nicht, MQTT meldet „abgesteckt“: zählt als Abstecken', () => {
  const { ctx, s } = fakeCtx();
  const plug = { plugged: true, pluggedAt: Date.parse('2026-11-16T06:00:00Z') };
  ctx.mainWallbox = { state: () => ({ type: 'eebus', available: true, connected: false, connectedKnown: false }) };
  ctx.vehicleMqtt = { getState: () => ({ plugged: plug.plugged, pluggedAt: plug.pluggedAt }) };
  const m = evSoc.createMaxStopSoc();
  assert.equal(m.resolve(ctx, Date.parse('2026-11-16T06:05:00Z'))?.pct, 85);
  plug.plugged = false; plug.pluggedAt = Date.parse('2026-11-16T07:00:00Z');
  assert.equal(m.resolve(ctx, Date.parse('2026-11-16T07:01:00Z')), null);
  plug.plugged = true; plug.pluggedAt = Date.parse('2026-11-16T18:00:00Z');
  assert.equal(m.resolve(ctx, Date.parse('2026-11-16T18:01:00Z')), null, 'Wert von vor der Fahrt zählt nicht');
  void s;
});

test('evcc noch ohne Ladepunkt (Abfragezeit 0), MQTT meldet „abgesteckt“: Zeitpunkt der MQTT-Meldung', () => {
  const { ctx } = fakeCtx();
  const plug = { plugged: false, pluggedAt: Date.parse('2026-11-16T07:00:00Z') };
  ctx.mainWallbox = { state: () => ({ type: 'evcc', available: false, connected: null }) };
  ctx.evccIntegration = { getLoadpoints: () => [], getStatus: () => ({ lastPolledAt: 0 }) };
  ctx.vehicleMqtt = { getState: () => ({ plugged: plug.plugged, pluggedAt: plug.pluggedAt }) };
  const m = evSoc.createMaxStopSoc();
  assert.equal(m.resolve(ctx, Date.parse('2026-11-16T07:01:00Z')), null);
  plug.plugged = true; plug.pluggedAt = Date.parse('2026-11-16T18:00:00Z');
  assert.equal(m.resolve(ctx, Date.parse('2026-11-16T18:01:00Z')), null, 'Wert von 06:00 liegt vor dem Abstecken um 07:00');
});
