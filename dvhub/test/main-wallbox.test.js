// Die eine Hauptwallbox (services/wallbox/main-wallbox.js): die unter
// Integrationen gewählte Box gilt für Anzeige, Abfrage und Steuerung — eine
// direkt angebundene Box fragt nie ersatzweise evcc.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createMainWallbox, directModeFromRaw, wallboxType } from '../services/wallbox/main-wallbox.js';
import { resolveEvPlugged, resolveEvSocPct } from '../services/optimizer/ev-soc.js';

const evccLps = [{ id: 1, title: 'Hof', connected: true, charging: false, chargePowerW: 0, vehicleSocPct: 55, mode: 'pv', vehicleTitle: 'Tesla' }];

function setup({ type = 'evcc', fresh = null, lastError = null } = {}) {
  const calls = [];
  const cfg = { wallbox: { type }, optimizer: { evMaxChargeW: 11000, evPhases: 3 } };
  const adapter = {
    isConfigured: () => true,
    stop: async () => { calls.push(['stop']); return { ok: true }; },
    release: async () => { calls.push(['release']); return { ok: true }; },
    charge: async (a) => { calls.push(['charge', a]); return { ok: true }; }
  };
  const evccIntegration = {
    getLoadpoints: () => evccLps,
    setMode: async (lp, mode) => { calls.push(['evcc', lp, mode]); return { ok: true }; }
  };
  const chargerStatus = { fresh: () => fresh, raw: () => (fresh || (lastError ? { error: lastError } : null)) };
  const wallbox = createMainWallbox({ getCfg: () => cfg, evccIntegration, chargerStatus, getAdapter: () => adapter });
  return { wallbox, calls, cfg, ctx: { getCfg: () => cfg, mainWallbox: wallbox, evccIntegration, chargerStatus } };
}

test('Typ aus der Config, unbekannt → evcc', () => {
  assert.equal(wallboxType({ wallbox: { type: 'wattpilot' } }), 'wattpilot');
  assert.equal(wallboxType({ wallbox: { type: 'quatsch' } }), 'evcc');
  assert.equal(wallboxType({}), 'evcc');
});

test('evcc als Hauptwallbox: Ladepunkt, vier Lademodi, Moduswechsel an evcc', async () => {
  const { wallbox, calls } = setup();
  const s = wallbox.state();
  assert.equal(s.type, 'evcc');
  assert.equal(s.connected, true);
  assert.equal(s.mode, 'pv');
  assert.equal(s.modes.length, 4);
  assert.deepEqual(await wallbox.setMode('now'), { ok: true });
  assert.deepEqual(calls.at(-1), ['evcc', 1, 'now']);
});

test('Wattpilot als Hauptwallbox: Zustand von der Box, evcc wird nicht gefragt', async () => {
  const fresh = { connected: true, charging: true, carState: 'charging', powerW: 7200, currentA: 10, vehicleSocPct: null, raw: { frc: 2 } };
  const { wallbox, calls } = setup({ type: 'wattpilot', fresh });
  const s = wallbox.state();
  assert.equal(s.type, 'wattpilot');
  assert.equal(s.label, 'Fronius Wattpilot');
  assert.equal(s.charging, true);
  assert.equal(s.powerW, 7200);
  assert.equal(s.mode, 'now');
  assert.equal(s.modes.length, 3);
  assert.deepEqual(wallbox.loadpoints().map((l) => [l.id, l.title, l.chargePowerW]), [[1, 'Fronius Wattpilot', 7200]]);
  await wallbox.setMode('off');
  await wallbox.setMode('pv');
  await wallbox.setMode('now');
  assert.deepEqual(calls.map((c) => c[0]), ['stop', 'release', 'charge']);
  assert.equal(calls[2][1], 16, 'Schnell = höchster Strom aus den E-Auto-Einstellungen (11 kW, 3-phasig)');
  assert.equal(calls.some((c) => c[0] === 'evcc'), false);
});

test('direkte Box schweigt: unbekannt statt evcc-Ersatz', () => {
  const { wallbox, ctx } = setup({ type: 'openevse', fresh: null, lastError: 'timeout' });
  const s = wallbox.state();
  assert.equal(s.available, false);
  assert.equal(s.connected, null);
  assert.equal(s.error, 'timeout');
  assert.deepEqual(wallbox.loadpoints(), []);
  assert.equal(resolveEvPlugged(ctx), null, 'nicht evccs „angesteckt“ übernehmen');
  assert.equal(resolveEvSocPct(ctx), null, 'nicht evccs Ladestand übernehmen');
});

test('Steckzustand und Ladestand folgen der Hauptwallbox', () => {
  const ev = setup();
  assert.equal(resolveEvPlugged(ev.ctx), true);
  assert.deepEqual(resolveEvSocPct(ev.ctx), { pct: 55, source: 'evcc' });
  const oe = setup({ type: 'openevse', fresh: { connected: true, charging: false, vehicleSocPct: 42, raw: {} } });
  assert.equal(resolveEvPlugged(oe.ctx), true);
  assert.deepEqual(resolveEvSocPct(oe.ctx), { pct: 42, source: 'openevse' });
});

test('Lademodus aus dem Rohzustand (go-e/Wattpilot frc)', () => {
  assert.equal(directModeFromRaw({ frc: 0 }), 'pv');
  assert.equal(directModeFromRaw({ frc: 1 }), 'off');
  assert.equal(directModeFromRaw({ frc: 2 }), 'now');
  assert.equal(directModeFromRaw({}), null);
});
