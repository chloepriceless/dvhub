// test/ev-arrival.test.js -- erwarteter Ladestand des E-Autos bei Ankunft.
//
// Rechenbasis aller Faelle (von Hand): Akku 60 kWh, Verbrauch 18 kWh/100 km,
// Heimweg 20 km → 20 × 18 / 100 = 3,6 kWh = 3,6 / 60 = 6 % je Strecke.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  estimateArrivalSoc, readEvSocReading, resolveEvArrival, createEvSocMemory, commutePct,
  EV_LIVE_MAX_AGE_MS
} from '../services/optimizer/ev-arrival.js';

const at = (s) => Date.parse(s);
const NOW = at('2026-09-22T16:00:00Z');         // Di 18:00 CEST
const TRIP_START = at('2026-09-22T03:00:00Z');  // Di 05:00 CEST (Abfahrt aus dem Mo-Eintrag)
const CAR = { capacityWh: 60000, consumptionKwhPer100km: 18, commuteKm: 20 };

describe('Heimweg in Prozent', () => {
  test('20 km × 18 kWh/100 km von 60 kWh = 6 %', () => {
    assert.equal(commutePct({ km: 20, consumptionKwhPer100km: 18, capacityWh: 60000 }), 6);
    assert.equal(commutePct({ km: 0, consumptionKwhPer100km: 18, capacityWh: 60000 }), 0);
    assert.equal(commutePct({ km: 20, consumptionKwhPer100km: 0, capacityWh: 60000 }), 0, 'ohne Verbrauch nichts abziehen');
  });
});

describe('estimateArrivalSoc', () => {
  test('angesteckt: der echte Ladestand gewinnt immer', () => {
    const r = estimateArrivalSoc({ ...CAR, plugged: true, pluggedSoc: { pct: 55, source: 'evcc' },
      reading: { pct: 90, source: 'teslamate', atMs: NOW - 60_000 }, tripStartMs: TRIP_START, nowMs: NOW });
    assert.equal(r.pct, 55);
    assert.equal(r.source, 'plugged');
    assert.equal(r.deductKm, 0);
  });

  test('live vom Auto (unterwegs gemessen): minus einmal Heimweg → 70 − 6 = 64 %', () => {
    const r = estimateArrivalSoc({ ...CAR, plugged: false,
      reading: { pct: 70, source: 'teslamate', atMs: at('2026-09-22T15:00:00Z') }, tripStartMs: TRIP_START, nowMs: NOW });
    assert.equal(r.pct, 64);
    assert.equal(r.source, 'live');
    assert.equal(r.legs, 1);
    assert.equal(r.deductKm, 20);
    assert.equal(r.basePct, 70);
    assert.equal(r.baseSource, 'teslamate');
    assert.equal(r.baseAt, '2026-09-22T15:00:00.000Z');
  });

  test('letzter Wert von VOR der Abfahrt: Hin- und Rueckweg → 78 − 12 = 66 % (geschaetzt)', () => {
    const r = estimateArrivalSoc({ ...CAR, plugged: false,
      reading: { pct: 78, source: 'teslamate', atMs: at('2026-09-22T02:00:00Z') }, tripStartMs: TRIP_START, nowMs: NOW });
    assert.equal(r.pct, 66);
    assert.equal(r.source, 'estimate');
    assert.equal(r.legs, 2);
    assert.equal(r.deductKm, 40);
  });

  test('unterwegs gemessen, aber aelter als 12 h: geschaetzt, einmal Heimweg → 64 %', () => {
    const atMs = NOW - EV_LIVE_MAX_AGE_MS - 60_000;
    const r = estimateArrivalSoc({ ...CAR, plugged: false, reading: { pct: 70, source: 'evccvehicle', atMs }, tripStartMs: atMs - 3600_000, nowMs: NOW });
    assert.equal(r.pct, 64);
    assert.equal(r.source, 'estimate');
    assert.equal(r.legs, 1);
  });

  test('Wallbox-Wert (nur angesteckt gemessen) gilt nie als live', () => {
    const r = estimateArrivalSoc({ ...CAR, plugged: false,
      reading: { pct: 80, source: 'evcc', atMs: at('2026-09-22T02:50:00Z') }, tripStartMs: TRIP_START, nowMs: NOW });
    assert.equal(r.pct, 68);
    assert.equal(r.source, 'estimate');
  });

  test('kein Wert / Wert aelter als 7 Tage: unbekannt', () => {
    assert.equal(estimateArrivalSoc({ ...CAR, plugged: false, reading: null, tripStartMs: TRIP_START, nowMs: NOW }).pct, null);
    const old = estimateArrivalSoc({ ...CAR, plugged: false, reading: { pct: 70, source: 'teslamate', atMs: NOW - 8 * 24 * 3600_000 }, tripStartMs: TRIP_START, nowMs: NOW });
    assert.equal(old.pct, null);
    assert.equal(old.source, null);
  });

  test('nie unter 0 %: 5 − 12 → 0', () => {
    const r = estimateArrivalSoc({ ...CAR, plugged: false, reading: { pct: 5, source: 'evcc', atMs: TRIP_START - 1 }, tripStartMs: TRIP_START, nowMs: NOW });
    assert.equal(r.pct, 0);
  });

  test('ohne Heimweg: nichts abziehen', () => {
    const r = estimateArrivalSoc({ ...CAR, commuteKm: 0, plugged: false, reading: { pct: 70, source: 'teslamate', atMs: NOW - 60_000 }, tripStartMs: TRIP_START, nowMs: NOW });
    assert.equal(r.pct, 70);
  });
});

function ctxWith({ tesla = null, teslaAt = null, evccVehicle = null, mqtt = null, loadpoint = null, source = 'auto', memory = null } = {}) {
  return {
    getCfg: () => ({ optimizer: { evSocSource: source, evEvccLoadpoint: 1 } }),
    teslamateService: tesla === null ? undefined : {
      getState: () => ({ batteryLevel: tesla }),
      getFieldUpdatedAt: () => ({ batteryLevel: teslaAt ? new Date(teslaAt) : undefined }),
    },
    vehicleEvcc: evccVehicle ? { getState: () => evccVehicle } : undefined,
    vehicleMqtt: mqtt ? { getState: () => mqtt } : undefined,
    evccIntegration: loadpoint ? { getLoadpoints: () => [{ id: 1, ...loadpoint }] } : undefined,
    evSocMemory: memory || undefined,
  };
}

describe('readEvSocReading', () => {
  test('auto: der juengste Wert aller Quellen (TeslaMate 10:00 vs. evcc-Fahrzeug 12:00)', () => {
    const ctx = ctxWith({ tesla: 70, teslaAt: at('2026-09-22T10:00:00Z'), evccVehicle: { socPct: 65, at: '2026-09-22T12:00:00.000Z' } });
    assert.deepEqual(readEvSocReading(ctx, NOW), { pct: 65, source: 'evccvehicle', atMs: at('2026-09-22T12:00:00Z') });
  });

  test('feste Quelle: nur diese', () => {
    const ctx = ctxWith({ tesla: 70, teslaAt: at('2026-09-22T10:00:00Z'), evccVehicle: { socPct: 65, at: '2026-09-22T12:00:00.000Z' }, source: 'teslamate' });
    assert.equal(readEvSocReading(ctx, NOW).source, 'teslamate');
  });

  test('Wallbox/evcc nur angesteckt, mit Zeitpunkt jetzt; MQTT mit socAt', () => {
    assert.deepEqual(readEvSocReading(ctxWith({ loadpoint: { connected: true, vehicleSocPct: 55 } }), NOW), { pct: 55, source: 'evcc', atMs: NOW });
    assert.equal(readEvSocReading(ctxWith({ loadpoint: { connected: false, vehicleSocPct: 0 } }), NOW), null);
    const m = readEvSocReading(ctxWith({ mqtt: { socPct: 61, socAt: NOW - 5000 } }), NOW);
    assert.deepEqual(m, { pct: 61, source: 'mqtt', atMs: NOW - 5000 });
  });

  test('Gedaechtnis: der beim Abstecken zuletzt gesehene evcc-Wert bleibt verfuegbar', () => {
    const memory = createEvSocMemory();
    memory.observe({ pct: 80, source: 'evcc', atMs: at('2026-09-22T02:50:00Z') });
    const r = readEvSocReading(ctxWith({ loadpoint: { connected: false }, memory }), NOW);
    assert.deepEqual(r, { pct: 80, source: 'evcc', atMs: at('2026-09-22T02:50:00Z') });
  });
});

describe('createEvSocMemory', () => {
  test('behaelt den juengsten Wert und uebersteht einen Neustart (Datei)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-soc-mem-'));
    const filePath = path.join(dir, 'ev-soc-last.json');
    const a = createEvSocMemory({ filePath });
    a.observe({ pct: 80, source: 'evcc', atMs: 1000 });
    a.observe({ pct: 70, source: 'evcc', atMs: 500 });   // aelter → ignoriert
    a.observe(null);
    assert.deepEqual(a.get(), { pct: 80, source: 'evcc', atMs: 1000 });
    const b = createEvSocMemory({ filePath });
    assert.deepEqual(b.get(), { pct: 80, source: 'evcc', atMs: 1000 });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('resolveEvArrival (Config + Fahrzeug)', () => {
  const cfg = {
    schedule: { timezone: 'Europe/Berlin' },
    optimizer: {
      evCapacityWh: 60000, evConsumptionKwhPer100km: 18, evCommuteKm: 20, evDepartureEnabled: true,
      evTargetMode: 'percent', evTargetValue: 80,
      evWeeklyPlan: [1, 2, 3, 4].map((day) => ({ day, arrival: '20:00', departure: '05:00' })).concat([{ day: 5, arrival: '15:00', departure: '09:00', commuteKm: 50 }]),
    },
  };

  test('Di mittags, TeslaMate unterwegs 70 % → erwartet 64 % (live)', () => {
    const ctx = ctxWith({ tesla: 70, teslaAt: at('2026-09-22T15:00:00Z') });
    ctx.getCfg = () => cfg;
    const r = resolveEvArrival(ctx, cfg, { plugged: false, nowMs: NOW });
    assert.equal(r.pct, 64);
    assert.equal(r.source, 'live');
    assert.equal(r.arrivalAt, '2026-09-22T18:00:00.000Z');
  });

  test('Freitag: eigener Heimweg 50 km = 15 %, Wert von vor der Abfahrt → 90 − 30 = 60 %', () => {
    // Fr 25.09. 10:00 CEST; Abfahrt Fr 05:00 CEST (= 03:00Z) aus dem Do-Eintrag
    const ctx = ctxWith({ tesla: 90, teslaAt: at('2026-09-25T02:30:00Z') });
    ctx.getCfg = () => cfg;
    const r = resolveEvArrival(ctx, cfg, { plugged: false, nowMs: at('2026-09-25T08:00:00Z') });
    assert.equal(r.commuteKm, 50);
    assert.equal(r.legs, 2);
    assert.equal(r.pct, 60);
  });
});

describe('Codex-Befunde Runde 1 (Ladestand-Gedaechtnis)', () => {
  test('Wallbox direkt (OpenEVSE) mit Quelle „evcc/Wallbox“: gemerkter Wert bleibt nach dem Abstecken', () => {
    const memory = createEvSocMemory();
    memory.observe({ pct: 80, source: 'openevse', atMs: at('2026-09-22T02:50:00Z') });
    const ctx = ctxWith({ source: 'evcc', memory });
    ctx.mainWallbox = { state: () => ({ type: 'openevse', connected: false, available: true }) };
    assert.deepEqual(readEvSocReading(ctx, NOW), { pct: 80, source: 'openevse', atMs: at('2026-09-22T02:50:00Z') });
  });

  test('unveraenderter Wert: Zeitpunkt wird mindestens stuendlich in die Datei geschrieben', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-soc-mem-'));
    const filePath = path.join(dir, 'ev-soc-last.json');
    const a = createEvSocMemory({ filePath });
    a.observe({ pct: 80, source: 'evcc', atMs: 0 });
    a.observe({ pct: 80, source: 'evcc', atMs: 30 * 60_000 });      // < 1 h: nicht schreiben
    assert.equal(createEvSocMemory({ filePath }).get().atMs, 0);
    a.observe({ pct: 80, source: 'evcc', atMs: 2 * 3600_000 });     // ≥ 1 h: Zeitpunkt sichern
    assert.equal(createEvSocMemory({ filePath }).get().atMs, 2 * 3600_000);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('evcc-Ladepunkt: Zeitpunkt der letzten erfolgreichen Abfrage, nicht „jetzt“', () => {
    const polled = NOW - 20 * 60_000;
    const ctx = ctxWith({ loadpoint: { connected: true, vehicleSocPct: 55 } });
    ctx.evccIntegration.getStatus = () => ({ lastPolledAt: polled });
    assert.equal(readEvSocReading(ctx, NOW).atMs, polled);
  });
});
