// test/pv-strings.test.js -- Erzeugung je String (VRM-Tracker, Fronius-MPPT),
// Gruppen und pvnode-CSV.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateToSlots, buildPvnodeCsv, isoWithOffset, resolvePvStringSources,
  fetchVrmTrackers, discoverVrmTrackers, createPvStringsService, seriesKeyFor,
  resolvePvStringGroups, fetchFroniusDay, discoverFroniusMppts, localMidnightS, localDate, shiftDate
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
  test('1-Minuten-Werte → 5-Minuten-Mittel, Stempel = Slot-Beginn', () => {
    const slots = aggregateToSlots(minutePoints(T0, 10, (i) => (i < 5 ? 1000 : 3000)));
    assert.deepEqual(slots.map((s) => [s.slotStartS - T0, s.avgW, s.n]), [[0, 1000, 5], [300, 3000, 5]]);
  });

  test('halb leerer Slot wird zur Luecke, nicht zu einem Mittel aus zwei Werten', () => {
    const pts = [...minutePoints(T0, 5, 500), [T0 + 300, 4000]];
    assert.deepEqual(aggregateToSlots(pts).map((s) => s.slotStartS - T0), [0]);
  });

  test('negative Messwerte (Nachtrauschen) werden 0', () => {
    assert.equal(aggregateToSlots(minutePoints(T0, 5, -3))[0].avgW, 0);
  });

  test('lokale Mitternacht auch an Umstellungstagen', () => {
    assert.equal(new Date(localMidnightS('2026-03-29') * 1000).toISOString(), '2026-03-28T23:00:00.000Z');
    assert.equal(new Date(localMidnightS('2026-03-30') * 1000).toISOString(), '2026-03-29T22:00:00.000Z');
    assert.equal(new Date(localMidnightS('2026-10-25') * 1000).toISOString(), '2026-10-24T22:00:00.000Z');
    assert.equal(new Date(localMidnightS('2026-10-26') * 1000).toISOString(), '2026-10-25T23:00:00.000Z');
    assert.equal(localDate(Date.parse('2026-09-22T22:30:00Z') / 1000), '2026-09-23');
    assert.equal(shiftDate('2026-03-01', -1), '2026-02-28');
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

  test('Fronius-Quellen: nur Host ohne Schema/Pfad, MPPT 1..4', () => {
    const src = resolvePvStringSources({ pvStrings: { sources: [
      { id: 'sued-symo', kind: 'fronius_mppt', host: '192.168.1.50', mppt: 1, kwp: 9 },
      { id: 'nord-symo', kind: 'fronius_mppt', host: 'Symo.local:8080', mppt: 2 },
      { id: 'a', kind: 'fronius_mppt', host: 'http://192.168.1.50', mppt: 1 },
      { id: 'b', kind: 'fronius_mppt', host: '192.168.1.50/x', mppt: 1 },
      { id: 'c', kind: 'fronius_mppt', host: '192.168.1.50', mppt: 5 },
      { id: 'd', kind: 'fronius_mppt', host: '', mppt: 1 }
    ] } });
    assert.deepEqual(src.map((s) => [s.id, s.host, s.mppt]), [['sued-symo', '192.168.1.50', 1], ['nord-symo', 'symo.local:8080', 2]]);
  });

  test('Gruppen: nur bestehende Mitglieder, mindestens zwei, ID darf keinen String verdecken', () => {
    const cfg = { pvStrings: {
      sources: [
        { id: 'sued-rs-a', kind: 'victron_vrm_tracker', instance: 0, tracker: 0, kwp: 4.5 },
        { id: 'sued-rs-b', kind: 'victron_vrm_tracker', instance: 0, tracker: 1, kwp: 4.5 },
        { id: 'sued-symo', kind: 'fronius_mppt', host: '192.168.1.50', mppt: 1, kwp: 9 },
        { id: 'garten', kind: 'victron_vrm_tracker', instance: 0, tracker: 2 }
      ],
      groups: [
        { id: 'sued', label: 'Süd gesamt', members: ['sued-rs-a', 'sued-rs-b', 'sued-symo', 'fehlt'] },
        { id: 'garten', members: ['sued-rs-a', 'sued-rs-b'] },
        { id: 'allein', members: ['sued-rs-a', 'fehlt'] },
        { id: 'mit-garten', members: ['sued-rs-a', 'garten'] }
      ]
    } };
    const g = resolvePvStringGroups(cfg);
    assert.deepEqual(g.map((x) => [x.id, x.members, x.kwp]), [
      ['sued', ['sued-rs-a', 'sued-rs-b', 'sued-symo'], 18],
      ['mit-garten', ['sued-rs-a', 'garten'], null]
    ]);
    assert.equal(g[0].seriesKey, 'pv_string_sued_w');
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

// Archivantwort wie vom Symo (Solar API v1): Werte je Sekunden ab lokaler Mitternacht.
function froniusArchive(date, byMppt) {
  const data = {};
  for (const [m, pts] of Object.entries(byMppt)) {
    data[`Current_DC_String_${m}`] = { Unit: 'A', Values: Object.fromEntries(pts.map(([k, a]) => [String(k), a])) };
    data[`Voltage_DC_String_${m}`] = { Unit: 'V', Values: Object.fromEntries(pts.map(([k, , v]) => [String(k), v])) };
  }
  const off = date.startsWith('2026-01') ? '+01:00' : '+02:00';
  return {
    Body: { Data: { 'inverter/1': { Start: `${date}T00:00:00${off}`, End: `${date}T23:59:59${off}`, NodeType: 97, Data: data } } },
    Head: { Status: { Code: 0, Reason: '' } }
  };
}

describe('Fronius', () => {
  const DAY = '2026-09-22';
  const mid = localMidnightS(DAY);

  test('Archiv → Slots: Leistung = U x I, Stempel = Intervallende, Nachtnullen am abgeschlossenen Tag', async () => {
    const f = fakeFetch(() => froniusArchive(DAY, { 1: [[36000, 10, 600], [36300, 11, 600]], 2: [[36300, 2, 500]] }));
    const r = await fetchFroniusDay({ host: '192.168.1.50', mppts: [1, 2], date: DAY, nowS: mid + 2 * 86400, fetchImpl: f });
    assert.equal(r.ok, true);
    assert.match(f.calls[0], /^http:\/\/192\.168\.1\.50\/solar_api\/v1\/GetArchiveData\.cgi\?Scope=System&StartDate=2026-09-22&EndDate=2026-09-22&Channel=Current_DC_String_1&Channel=Voltage_DC_String_1&Channel=Current_DC_String_2/);
    const m1 = r.byMppt.get(1);
    assert.equal(m1.length, 288, 'ganzer Tag, Rest mit 0 W');
    const byT = new Map(m1.map((x) => [x.slotStartS - mid, x]));
    assert.deepEqual([byT.get(35700).avgW, byT.get(36000).avgW], [6000, 6600], '10:00 gestempelt = Slot 09:55');
    assert.equal(byT.get(0).avgW, 0);
    assert.equal(byT.get(0).n, 0);
    assert.equal(byT.get(86100).avgW, 0);
    assert.equal(r.byMppt.get(2).find((x) => x.slotStartS - mid === 36000).avgW, 1000);
  });

  test('laufender Tag: keine Nullen nach dem letzten Wert (koennte noch kommen)', async () => {
    const f = fakeFetch(() => froniusArchive(DAY, { 1: [[36000, 10, 600]] }));
    const r = await fetchFroniusDay({ host: 'h', mppts: [1], date: DAY, nowS: mid + 36600, fetchImpl: f });
    const last = r.byMppt.get(1).at(-1);
    assert.equal(last.slotStartS - mid, 35700);
    assert.equal(r.byMppt.get(1).length, 120, '0:00 bis 9:55');
  });

  test('Tag ganz ohne Werte bleibt leer (Ausfall, keine Nullen)', async () => {
    const f = fakeFetch(() => froniusArchive(DAY, {}));
    const r = await fetchFroniusDay({ host: 'h', mppts: [1], date: DAY, nowS: mid + 2 * 86400, fetchImpl: f });
    assert.deepEqual(r.byMppt.get(1), []);
  });

  test('Fehlerstatus der Solar API wird gemeldet', async () => {
    const f = fakeFetch(() => ({ Head: { Status: { Code: 255, Reason: 'Query not supported' } } }));
    const r = await fetchFroniusDay({ host: 'h', mppts: [1], date: DAY, fetchImpl: f });
    assert.equal(r.ok, false);
    assert.match(r.error, /Query not supported/);
  });

  test('MPPT-Erkennung aus components/inverter/readable', async () => {
    const f = fakeFetch(() => ({ Body: { Data: { 1: { attributes: { 'Nameplate.cnt-dc': '2' }, channels: { Power_DC_String_1: 6944.8, Power_DC_String_2: 2150.1 } } } } }));
    const r = await discoverFroniusMppts({ host: '192.168.1.50', fetchImpl: f });
    assert.deepEqual(r.mppts, [{ host: '192.168.1.50', mppt: 1, powerW: 6945 }, { host: '192.168.1.50', mppt: 2, powerW: 2150 }]);
    assert.equal(f.calls[0], 'http://192.168.1.50/components/inverter/readable');
    assert.equal((await discoverFroniusMppts({ host: 'http://evil/', fetchImpl: f })).ok, false);
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

  test('ein Abruf je Laderegler, 5-Minuten-Zeilen je String mit eigenem Serien-Schluessel', async () => {
    const { svc, written, f } = setup({ handler: () => vrmGraphBody({ 0: minutePoints(T0, 60, 2000), 1: minutePoints(T0, 60, 1000) }) });
    const r = await svc.syncWindow(T0, T0 + 3600);
    assert.equal(r.ok, true);
    assert.equal(f.calls.length, 1);
    assert.equal(written.length, 24);
    const a = written.filter((w) => w.seriesKey === seriesKeyFor('sued-a'));
    assert.equal(a.length, 12);
    assert.ok(a.every((w) => w.value === 2000));
    assert.equal(a[0].scope, 'history');
    assert.equal(a[0].source, 'vrm_import');
    assert.equal(a[0].resolutionSeconds, 300);
    assert.equal(a[0].unit, 'W');
  });

  test('angeschnittener letzter Slot wird nicht gespeichert', async () => {
    const { svc, written } = setup({ handler: () => vrmGraphBody({ 0: minutePoints(T0, 17, 500), 1: [] }) });
    await svc.syncWindow(T0, T0 + 1020);
    assert.deepEqual(written.map((w) => w.ts), ['2026-09-22T10:00:00.000Z', '2026-09-22T10:05:00.000Z', '2026-09-22T10:10:00.000Z']);
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

describe('Dienst: Fronius + Gruppe', () => {
  // Speicher im Arbeitsspeicher mit derselben Lesesemantik wie der Store:
  // Zeilen bis maxResolution, sortiert nach Zeit.
  function memStore() {
    const rows = new Map();
    return {
      rows,
      writeSamples: async (list) => { for (const r of list) rows.set(`${r.seriesKey}|${r.ts}|${r.resolutionSeconds}`, r); },
      querySeries: async ({ seriesKeys, start, end, maxResolution }) => [...rows.values()]
        .filter((r) => seriesKeys.includes(r.seriesKey) && r.ts >= start && r.ts < end && r.resolutionSeconds <= maxResolution)
        .sort((a, b) => a.ts.localeCompare(b.ts))
        .map((r) => ({ key: r.seriesKey, ts: r.ts, value: r.value, unit: r.unit, resolution: r.resolutionSeconds }))
    };
  }
  const DAY = '2026-09-22';
  const mid = localMidnightS(DAY);
  const W0 = mid + 36000 - 300; // 09:55 lokal

  function setup({ vrm = () => vrmGraphBody({ 0: minutePoints(W0, 10, 1000), 1: minutePoints(W0, 10, 1500) }), fronius, nowS = mid + 2 * 86400 } = {}) {
    const store = memStore();
    const cfg = {
      telemetry: { historyImport: { vrmPortalId: '769799', vrmToken: 'geheim' } },
      pvStrings: {
        enabled: true,
        sources: [
          { id: 'sued-rs-a', kind: 'victron_vrm_tracker', instance: 0, tracker: 0, kwp: 4.5 },
          { id: 'sued-rs-b', kind: 'victron_vrm_tracker', instance: 0, tracker: 1, kwp: 4.5 },
          { id: 'sued-symo', kind: 'fronius_mppt', host: '192.168.1.50', mppt: 1, kwp: 9 },
          { id: 'nord-symo', kind: 'fronius_mppt', host: '192.168.1.50', mppt: 2, kwp: 9 }
        ],
        groups: [{ id: 'sued', label: 'Süd gesamt', members: ['sued-rs-a', 'sued-rs-b', 'sued-symo'] }]
      }
    };
    const f = fakeFetch((url) => (url.includes('vrmapi') ? vrm(url) : (fronius ? fronius(url) : froniusArchive(DAY, { 1: [[36000, 5, 600], [36300, 6, 600]], 2: [[36000, 1, 500], [36300, 1, 500]] }))));
    const svc = createPvStringsService({ getCfg: () => cfg, telemetryStore: store, fetchImpl: f, sleep: async () => {}, now: () => nowS * 1000 });
    return { svc, store, f, cfg };
  }
  const val = (store, id, t) => store.rows.get(`${seriesKeyFor(id)}|${new Date(t * 1000).toISOString()}|300`)?.value;

  test('Fronius-Slot 09:55 und VRM-Minuten 09:55–09:59 landen im selben Slot; Gruppe = Summe', async () => {
    const { svc, store } = setup();
    const r = await svc.syncWindow(W0, W0 + 600);
    assert.equal(r.ok, true, r.error);
    assert.equal(val(store, 'sued-symo', W0), 3000);
    assert.equal(val(store, 'sued-rs-a', W0), 1000);
    assert.equal(val(store, 'sued-rs-b', W0), 1500);
    assert.equal(val(store, 'sued', W0), 5500);
    assert.equal(val(store, 'sued', W0 + 300), 5500 + 600);
    assert.equal(val(store, 'nord-symo', W0), 500);
    const g = [...store.rows.values()].find((x) => x.seriesKey === seriesKeyFor('sued'));
    assert.equal(g.source, 'derived');
    assert.deepEqual(g.meta.members, ['sued-rs-a', 'sued-rs-b', 'sued-symo']);
  });

  test('Gruppe nur, wo alle Mitglieder einen Wert haben', async () => {
    const { svc, store } = setup({ vrm: () => vrmGraphBody({ 0: minutePoints(W0, 10, 1000), 1: minutePoints(W0, 5, 1500) }) });
    await svc.syncWindow(W0, W0 + 600);
    assert.equal(val(store, 'sued', W0), 5500);
    assert.equal(val(store, 'sued', W0 + 300), undefined);
  });

  test('Fronius nicht erreichbar: VRM wird trotzdem gespeichert, Fehler gemeldet', async () => {
    const { svc, store } = setup({ fronius: () => { throw new Error('ECONNREFUSED'); } });
    const r = await svc.syncWindow(W0, W0 + 600);
    assert.equal(r.ok, false);
    assert.match(r.error, /Fronius 192\.168\.1\.50/);
    assert.equal(val(store, 'sued-rs-a', W0), 1000);
    assert.equal(val(store, 'sued', W0), undefined);
  });

  test('Uebersicht und CSV enthalten die Gruppe, alte 15-Minuten-Zeilen bleiben aussen vor', async () => {
    const { svc, store } = setup();
    await svc.syncWindow(W0, W0 + 600);
    await store.writeSamples([{ seriesKey: seriesKeyFor('sued-rs-a'), ts: new Date((W0 - 900) * 1000).toISOString(), resolutionSeconds: 900, value: 9999, unit: 'W' }]);
    const ov = await svc.overview();
    const g = ov.sources.find((s) => s.id === 'sued');
    assert.equal(g.kind, 'group');
    assert.equal(g.kwp, 18);
    assert.equal(g.slots, 2);
    const a = await svc.readSeries('sued-rs-a', { start: new Date((W0 - 3600) * 1000).toISOString(), end: new Date((W0 + 3600) * 1000).toISOString() });
    assert.deepEqual(a.rows.map((x) => x.value), [1000, 1000]);
  });

  test('Nachladen: VRM endet frueher, Fronius laeuft weiter; VRM wird danach nicht mehr gefragt', async () => {
    let vrmCalls = 0;
    const today = localDate(mid + 86400 * 10);
    const { svc, f } = setup({
      nowS: localMidnightS(today) + 43200,
      vrm: () => { vrmCalls += 1; return vrmGraphBody({ 0: vrmCalls <= 2 ? minutePoints(W0, 5, 100) : [], 1: [] }); },
      fronius: (url) => {
        const date = /StartDate=([0-9-]+)/.exec(url)[1];
        const back = Math.round((localMidnightS(today) - localMidnightS(date)) / 86400);
        return froniusArchive(date, back < 8 ? { 1: [[36000, 1, 500]], 2: [[36000, 1, 500]] } : {});
      }
    });
    const r = await svc.backfill({ days: 60 });
    assert.equal(r.ok, true, r.error);
    assert.equal(vrmCalls, 5, 'VRM: 2 Tage mit Daten + 3 leere, dann Schluss');
    assert.equal(r.doneDays, 11, 'Fronius: 8 Tage mit Daten + 3 leere');
    assert.equal(f.calls.filter((u) => !u.includes('vrmapi')).length, 11);
  });

  test('syncRecent holt einmal am Tag den ganzen Vortag nach', async () => {
    const { svc, f } = setup({ nowS: mid + 86400 + 3600 * 12 });
    await svc.syncRecent();
    await svc.syncRecent();
    const froniusDates = f.calls.filter((u) => !u.includes('vrmapi')).map((u) => /StartDate=([0-9-]+)/.exec(u)[1]);
    assert.deepEqual(froniusDates, ['2026-09-22', '2026-09-23', '2026-09-23']);
  });
});
