// test/pv-strings.test.js -- Erzeugung je String (VRM-Tracker) + pvnode-CSV.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateToSlots, buildPvnodeCsv, isoWithOffset, resolvePvStringSources,
  fetchVrmTrackers, discoverVrmTrackers, createPvStringsService, seriesKeyFor
} from '../services/pv-strings/index.js';

const T0 = Date.parse('2026-09-22T10:00:00Z') / 1000; // Slot-Grenze

function minutePoints(startS, minutes, w) {
  return Array.from({ length: minutes }, (_, i) => [startS + i * 60, typeof w === 'function' ? w(i) : w]);
}

function vrmGraphBody(byTracker, names = {}) {
  const meta = {};
  const data = {};
  Object.entries(byTracker).forEach(([t, pts], i) => {
    const id = String(802 + i);
    meta[id] = { code: `PVP${t}`, customName: names[t] ? [names[t]] : [] };
    data[id] = pts;
  });
  return { success: true, records: { data, meta, instance: 0 } };
}

function fakeFetch(handler) {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    const body = handler(url);
    return { ok: true, status: 200, json: async () => body };
  };
  f.calls = calls;
  return f;
}

describe('Aufbereitung', () => {
  test('1-Minuten-Werte → 15-Minuten-Mittel', () => {
    const slots = aggregateToSlots(minutePoints(T0, 30, (i) => (i < 15 ? 1000 : 3000)));
    assert.deepEqual(slots.map((s) => [s.slotStartS - T0, s.avgW, s.n]), [[0, 1000, 15], [900, 3000, 15]]);
  });

  test('halb leerer Slot wird zur Luecke, nicht zu einem Mittel aus zwei Werten', () => {
    const pts = [...minutePoints(T0, 15, 500), [T0 + 900, 4000], [T0 + 960, 4000]];
    assert.deepEqual(aggregateToSlots(pts).map((s) => s.slotStartS - T0), [0]);
  });

  test('negative Messwerte (Nachtrauschen) werden 0', () => {
    assert.equal(aggregateToSlots(minutePoints(T0, 15, -3))[0].avgW, 0);
  });

  test('Zeitstempel mit Offset in Anlagen-Zeitzone (Sommer/Winter)', () => {
    assert.equal(isoWithOffset(Date.parse('2026-06-01T10:00:00Z')), '2026-06-01T12:00:00+02:00');
    assert.equal(isoWithOffset(Date.parse('2026-01-15T10:00:00Z')), '2026-01-15T11:00:00+01:00');
    assert.equal(isoWithOffset(Date.parse('2026-01-15T10:00:00Z'), 'UTC'), '2026-01-15T10:00:00+00:00');
  });

  test('pvnode-CSV: Kopfzeile, Semikolon, ganze Watt', () => {
    const csv = buildPvnodeCsv([
      { ts: '2026-06-01T10:00:00.000Z', value: 4200.4 },
      { ts: '2026-06-01T10:15:00.000Z', value: 4310.6 }
    ]);
    assert.equal(csv, 'timestamp;pv_power\n2026-06-01T12:00:00+02:00;4200\n2026-06-01T12:15:00+02:00;4311\n');
  });

  test('Quellen: ungueltige und doppelte fallen weg', () => {
    const src = resolvePvStringSources({ pvStrings: { sources: [
      { id: 'sued-a', label: 'Süd A', kind: 'victron_vrm_tracker', instance: 0, tracker: 0, kwp: 4.5 },
      { id: 'sued-a', label: 'doppelt', kind: 'victron_vrm_tracker', instance: 0, tracker: 1 },
      { id: 'Böse Id', kind: 'victron_vrm_tracker', instance: 0, tracker: 2 },
      { id: 'x', kind: 'unbekannt', instance: 0, tracker: 2 },
      { id: 'garten', kind: 'victron_vrm_tracker', instance: 0, tracker: 2 }
    ] } });
    assert.deepEqual(src.map((s) => s.id), ['sued-a', 'garten']);
    assert.equal(src[0].seriesKey, 'pv_string_sued-a_w');
    assert.equal(src[1].kwp, null);
  });
});

describe('VRM', () => {
  test('Graph-Abruf: Tracker ueber den Attributcode zugeordnet, Namen aus meta', async () => {
    const f = fakeFetch(() => vrmGraphBody({ 0: [[T0, 100]], 2: [[T0, 300]] }, { 0: 'String 2' }));
    const r = await fetchVrmTrackers({ creds: { portalId: '769799', token: 't' }, instance: 0, trackers: [0, 2], startS: T0, endS: T0 + 3600, fetchImpl: f });
    assert.equal(r.ok, true);
    assert.deepEqual(r.byTracker.get(2), [[T0, 300]]);
    assert.equal(r.names.get(0), 'String 2');
    assert.match(f.calls[0], /widgets\/Graph\?attributeCodes%5B%5D=PVP0&attributeCodes%5B%5D=PVP2&instance=0/);
  });

  test('Diagnose → Tracker mit Name und Aktiv-Status', async () => {
    const f = fakeFetch(() => ({ records: [
      { code: 'PVn0', Device: 'Solar Charger', instance: 0, formattedValue: 'String 2' },
      { code: 'PVe0', Device: 'Solar Charger', instance: 0, formattedValue: 'Enabled' },
      { code: 'PVn3', Device: 'Solar Charger', instance: 0, formattedValue: 'Zzz' },
      { code: 'PVe3', Device: 'Solar Charger', instance: 0, formattedValue: 'Disabled' },
      { code: 'PVn0', Device: 'Battery Monitor', instance: 5, formattedValue: 'nein' }
    ] }));
    const r = await discoverVrmTrackers({ creds: { portalId: '1', token: 't' }, fetchImpl: f });
    assert.deepEqual(r.trackers.map((t) => [t.tracker, t.name, t.enabled]), [[0, 'String 2', true], [3, 'Zzz', false]]);
  });
});

describe('Dienst', () => {
  function setup({ handler, sources, enabled = true }) {
    const written = [];
    const cfg = {
      telemetry: { historyImport: { vrmPortalId: '769799', vrmToken: 'geheim' } },
      pvStrings: { enabled, sources: sources || [
        { id: 'sued-a', label: 'Süd A', kind: 'victron_vrm_tracker', instance: 0, tracker: 0 },
        { id: 'sued-b', label: 'Süd B', kind: 'victron_vrm_tracker', instance: 0, tracker: 1 }
      ] }
    };
    const f = fakeFetch(handler);
    const svc = createPvStringsService({
      getCfg: () => cfg,
      telemetryStore: { writeSamples: async (rows) => { written.push(...rows); } },
      fetchImpl: f,
      sleep: async () => {},
      now: () => (T0 + 3 * 3600) * 1000
    });
    return { svc, written, f, cfg };
  }

  test('ein Abruf je Laderegler, 15-Minuten-Zeilen je String mit eigenem Serien-Schluessel', async () => {
    const { svc, written, f } = setup({ handler: () => vrmGraphBody({ 0: minutePoints(T0, 60, 2000), 1: minutePoints(T0, 60, 1000) }) });
    const r = await svc.syncWindow(T0, T0 + 3600);
    assert.equal(r.ok, true);
    assert.equal(f.calls.length, 1);
    assert.equal(written.length, 8);
    const a = written.filter((w) => w.seriesKey === seriesKeyFor('sued-a'));
    assert.deepEqual(a.map((w) => w.value), [2000, 2000, 2000, 2000]);
    assert.equal(a[0].scope, 'history');
    assert.equal(a[0].source, 'vrm_import');
    assert.equal(a[0].resolutionSeconds, 900);
    assert.equal(a[0].unit, 'W');
  });

  test('angeschnittener letzter Slot wird nicht gespeichert', async () => {
    const { svc, written } = setup({ handler: () => vrmGraphBody({ 0: minutePoints(T0, 20, 500), 1: [] }) });
    await svc.syncWindow(T0, T0 + 1200);
    assert.deepEqual(written.map((w) => w.ts), ['2026-09-22T10:00:00.000Z']);
  });

  test('ohne VRM-Zugang: klare Meldung, kein Abruf', async () => {
    const { svc, f, cfg } = setup({ handler: () => ({}) });
    cfg.telemetry.historyImport.vrmToken = '';
    const r = await svc.syncWindow(T0, T0 + 900);
    assert.equal(r.ok, false);
    assert.match(r.error, /VRM-Zugang fehlt/);
    assert.equal(f.calls.length, 0);
  });

  test('Erfassung aus: syncRecent tut nichts', async () => {
    const { svc, f } = setup({ handler: () => ({}), enabled: false });
    assert.equal((await svc.syncRecent()).skipped, 'disabled');
    assert.equal(f.calls.length, 0);
  });

  test('Nachladen stoppt nach drei leeren Tagen (Beginn der VRM-Aufzeichnung)', async () => {
    let day = 0;
    const { svc } = setup({ handler: () => { day += 1; return vrmGraphBody({ 0: day <= 2 ? minutePoints(T0, 15, 100) : [], 1: [] }); } });
    const r = await svc.backfill({ days: 30 });
    assert.equal(r.ok, true);
    assert.equal(r.doneDays, 5, '2 Tage mit Daten + 3 leere');
    assert.equal(svc.getStatus().backfill.running, false);
  });
});
