// test/sqlite/history-source-rule.test.js — Historie „eigene Messwerte zuerst,
// VRM füllt auf“ (Christin 05.11.2026, Entscheidung B) mit echtem SQLite-Speicher.
//
// Drei Viertelstunden, jeweils mit VRM-Import (0,6 kWh Bezug):
//   10:00 lokal lückenlos (180 × 5 s, 2000 W = 0,5 kWh)  → lokal 0,5
//   10:15 lokal nur die zweite Hälfte (Neustart, 0,25 kWh) → VRM 0,6
//   10:30 lokal gar nichts                                 → VRM 0,6
// Die eigenen Proben kommen in mehreren Schreibpaketen (wie im Betrieb jede
// Minute), damit die Abdeckung auch über das Aufaddieren stimmt.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createTelemetryStore } from '../../telemetry-store.js';
import { createHistoryRuntime } from '../../history-runtime.js';

const T0 = Date.parse('2026-03-09T10:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

function liveSamples(slotStartMs, fromSecond, toSecond, watts) {
  const rows = [];
  for (let s = fromSecond; s < toSecond; s += 5) {
    rows.push({ seriesKey: 'grid_import_w', ts: iso(slotStartMs + s * 1000), value: watts, scope: 'live', source: 'local_poll', quality: 'raw', resolutionSeconds: 5, unit: 'W' });
  }
  return rows;
}
const vrmSample = (slotStartMs, kwh, meta = null) => ({
  seriesKey: 'grid_import_w', ts: iso(slotStartMs), value: kwh * 4000, scope: 'history', source: 'vrm_import', quality: 'backfilled', resolutionSeconds: 900, unit: 'W', meta
});

function buildStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-source-rule-'));
  const dbPath = path.join(dir, 'telemetry.sqlite');
  const store = createTelemetryStore({ dbPath, rawRetentionDays: 30, rollupIntervals: [900] });
  store.dbPathForTest = dbPath;
  const local = [
    ...liveSamples(T0, 0, 900, 2000),
    ...liveSamples(T0 + 900000, 450, 900, 2000)
  ];
  for (let i = 0; i < local.length; i += 12) store.writeSamples(local.slice(i, i + 12));
  store.writeSamples([
    vrmSample(T0, 0.6, { provenance: 'mapped_from_vrm', incomplete: true }),
    vrmSample(T0 + 900000, 0.6),
    vrmSample(T0 + 1800000, 0.6),
    ...[0, 1, 2].map((i) => ({ seriesKey: 'price_ct_kwh', ts: iso(T0 + i * 900000), value: 20, scope: 'history', source: 'price_backfill', quality: 'backfilled', resolutionSeconds: 900, unit: 'ct/kWh' }))
  ]);
  return store;
}

const range = { start: '2026-03-09T00:00:00.000Z', end: '2026-03-10T00:00:00.000Z' };

test('vorberechnete Slots: lokal vollstaendig → lokal, lokal halb → VRM, lokal fehlt → VRM', () => {
  const store = buildStore();
  try {
    const slots = store.listMaterializedEnergySlots(range);
    assert.deepEqual(slots.map((s) => Math.round(s.importKwh * 1000) / 1000), [0.5, 0.6, 0.6]);
    assert.deepEqual(slots.map((s) => s.sourceKind), ['local_live', 'vrm_import', 'vrm_import']);
    assert.equal(slots[0].incomplete, false, 'Kennzeichen des verworfenen VRM-Werts zaehlen nicht');
  } finally {
    store.close();
  }
});

test('eigene Abdeckung wird ueber mehrere Schreibpakete aufaddiert', () => {
  const store = buildStore();
  const db = new DatabaseSync(store.dbPathForTest);
  try {
    const rows = db.prepare(`SELECT meta_json FROM energy_slots_15m WHERE source_kind = 'local_live' ORDER BY slot_start_utc`).all();
    assert.deepEqual(rows.map((r) => JSON.parse(r.meta_json)), [{ coverageS: 900, samples: 180, maxResS: 5 }, { coverageS: 450, samples: 90, maxResS: 5 }]);
  } finally {
    db.close();
    store.close();
  }
});

test('Rohdaten-Ausweichpfad waehlt je Reihe genauso, nie gemittelt', () => {
  const store = buildStore();
  try {
    const slots = store.listAggregatedEnergySlots({ ...range, bucketSeconds: 900 });
    assert.deepEqual(slots.map((s) => s.importKwh), [0.5, 0.6, 0.6]);
    assert.equal(slots[0].incomplete, false);
    assert.equal(slots[1].incomplete, false);
  } finally {
    store.close();
  }
});

test('Tagesbilanz: 0,5 + 0,6 + 0,6 kWh Bezug', async () => {
  const store = buildStore();
  try {
    const runtime = createHistoryRuntime({ store, getPricingConfig: () => ({}), getCurrentDate: () => '2027-04-02' });
    const { kpis } = await runtime.getSummary({ view: 'day', date: '2026-03-09' });
    assert.equal(kpis.importKwh, 1.7);
  } finally {
    store.close();
  }
});

// Codex 633d1caf: veraltete Proben (Lesefehler, alte Werte) und eine Probe nach
// einer Pause ueber 60 s machen den eigenen Wert nicht vollstaendig → VRM.
test('veraltete Proben oder eine lange Pause im Slot → VRM fuellt auf', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-source-rule-stale-'));
  const store = createTelemetryStore({ dbPath: path.join(dir, 'telemetry.sqlite'), rawRetentionDays: 30, rollupIntervals: [900] });
  try {
    const stale = liveSamples(T0, 0, 900, 2000).map((r) => ({ ...r, meta: { stale: true } }));
    const paused = [
      { ...liveSamples(T0 + 900000, 0, 5, 2000)[0], resolutionSeconds: 300 },
      ...liveSamples(T0 + 900000, 5, 900, 2000)
    ];
    store.writeSamples([...stale, ...paused]);
    store.writeSamples([vrmSample(T0, 0.6), vrmSample(T0 + 900000, 0.6)]);
    const slots = store.listMaterializedEnergySlots(range);
    assert.deepEqual(slots.map((s) => s.importKwh), [0.6, 0.6]);
    const raw = store.listAggregatedEnergySlots({ ...range, bucketSeconds: 900 });
    assert.deepEqual(raw.map((s) => s.importKwh), [0.6, 0.6]);
  } finally {
    store.close();
  }
});
