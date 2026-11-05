// test/live-stale-poll.test.js — Live-Proben aus echten Abfragen (polling.js →
// telemetry-runtime.js liveSnapshotStale): wann zählt eine Probe in der
// Historie nicht als eigene Messung (energy-source-rule.js)?
//
// Codex 4e636a56 (P2): Ein PV-Punkt, der vor seinem ersten Wert scheiterte und
// dann abgeschaltet wurde, behielt seinen Lesefehler — jede weitere Probe galt
// als veraltet. Codex fbb2f961 (P2): Umgekehrt darf ein EINGESCHALTETER Punkt,
// der seit dem Start scheitert (kein Wert), die Probe nicht frisch lassen —
// polling.js leitet daraus Nullen (Akku laden/entladen 0 W) ab, die sonst als
// volle Abdeckung den VRM-Import verdrängen.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createPoller } from '../polling.js';
import { buildLiveTelemetrySamples } from '../telemetry-runtime.js';

function rig(failing) {
  const values = { pvPowerW: 3_000, acPvL1W: 1_000, acPv2L1W: 500, soc: 60, batteryPowerW: 500, selfConsumptionW: 1_000 };
  const transport = {
    type: 'mqtt',
    readGrid: () => ({ total: 100, l1: 100, l2: 0, l3: 0, ts: Date.now() }),
    readPoint: async (name) => {
      if (failing.has(name)) throw new Error('modbus exception 2');
      return { mqttValue: values[name], ts: Date.now() };
    },
  };
  const state = {
    meter: { ok: false, updatedAt: 0, raw: [], grid_l1_w: 0, grid_l2_w: 0, grid_l3_w: 0, grid_total_w: 0, error: null },
    victron: { errors: {}, updatedAt: 0, fieldUpdatedAt: {} },
    dvRegs: new Array(8).fill(0),
    energy: { day: '2026-11-05', importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0, lastTs: 0 },
  };
  const points = {
    soc: { enabled: true }, batteryPowerW: { enabled: true }, pvPowerW: { enabled: true },
    acPvL1W: { enabled: true }, acPv2L1W: { enabled: true }, selfConsumptionW: { enabled: true },
  };
  const cfg = { pollMs: 500, gridPositiveMeans: 'grid_import', points, epex: { timezone: 'UTC' }, userEnergyPricing: {}, dvControl: {} };
  let snap = null;
  const poller = createPoller({
    state, getCfg: () => cfg, transport, pushLog: () => {},
    energyPath: path.join(os.tmpdir(), `live-stale-poll-${process.pid}-${Math.random()}.json`),
    onPollComplete: (s) => { snap = s; },
    epexNowNext: () => ({ current: { ct_kwh: 0 } }),
  });
  const metaAfterPoll = async () => {
    await poller.requestPoll();
    return buildLiveTelemetrySamples(snap)[0].meta;
  };
  return { points, metaAfterPoll, state };
}

test('frische Abfrage aller Punkte → Probe zählt (meta null)', async () => {
  const r = rig(new Set());
  assert.equal(await r.metaAfterPoll(), null);
});

test('eingeschalteter Akkupunkt scheitert seit dem Start (kein Wert) → veraltet (Codex fbb2f961)', async () => {
  const r = rig(new Set(['batteryPowerW']));
  assert.equal(r.state.victron.batteryPowerW, undefined);
  assert.deepEqual(await r.metaAfterPoll(), { stale: true });
});

// Codex 22b1fb66 (P2): Optionale Kanäle (dvhub-mqtt: ac_l1..l3_w bei reiner
// PV-Summe) sind eingeschaltet, liefern aber nie einen Wert — das ist kein
// Messausfall, die Probe bleibt frisch. Nur der Akku (Pflicht) zählt ohne Wert.
test('eingeschalteter PV-Kanal ohne je einen Wert (optional) → Probe frisch, auch abgeschaltet', async () => {
  const r = rig(new Set(['acPv2L1W']));
  assert.equal(await r.metaAfterPoll(), null, 'optionaler Kanal fehlt');
  r.points.acPv2L1W = { enabled: false };
  assert.equal(await r.metaAfterPoll(), null);
});

test('abgeschalteter Akkupunkt ohne Wert mit altem Fehler → Probe nicht veraltet (Codex 4e636a56)', async () => {
  const r = rig(new Set(['batteryPowerW']));
  await r.metaAfterPoll();
  r.points.batteryPowerW = { enabled: false };
  assert.equal(await r.metaAfterPoll(), null);
});

// Codex 22b1fb66 (P2): Akkupunkt hatte einen Wert, scheitert dann und wird
// abgeschaltet — der alte Wert bleibt stehen (M160 kann ihn sonst liefern),
// also bleibt die Probe veraltet, bis ein frischer Wert kommt.
test('Akkupunkt mit altem Wert scheitert und wird abgeschaltet → bleibt veraltet', async () => {
  const failing = new Set();
  const r = rig(failing);
  assert.equal(await r.metaAfterPoll(), null);
  failing.add('batteryPowerW');
  assert.deepEqual(await r.metaAfterPoll(), { stale: true });
  r.points.batteryPowerW = { enabled: false };
  assert.equal(r.state.victron.batteryPowerW, 500, 'alter Wert noch da');
  assert.deepEqual(await r.metaAfterPoll(), { stale: true });
});

// Codex 92613083 (P2): Nur die AC-PV-Kanäle sind optional (docs/MQTT-SCHEMA.md).
// Scheitert die PV-Summe (pvPowerW) oder die Hauslast seit dem Start, leitet
// polling.js Nullen ab — die Probe ist veraltet.
test('PV-Summe scheitert seit dem Start (kein Wert) → veraltet', async () => {
  const r = rig(new Set(['pvPowerW']));
  assert.deepEqual(await r.metaAfterPoll(), { stale: true });
});
