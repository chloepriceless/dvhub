// T-0427 (Christin 11.11.2026): E-Auto-Wochenplan — Zeile = Tag der ABFAHRT
// statt Tag der Ankunft. Nur Eingabe, Speicherung und Darstellung ändern sich;
// was DVhub daraus plant, bleibt gleich. Beweis:
//   1. Äquivalenz: viele Zufallspläne im alten Format, verlustfrei umgerechnet,
//      ergeben über zwei Wochen dieselbe Folge (Ankunft, Abfahrt, Ziel, Fahrt)
//      — verglichen mit der eingefrorenen Logik vor dem Umbau
//      (test/fixtures/ev-departure-ankunftstag-ref.js), mit Einmal-Zielen,
//      ausgeschaltetem Plan und über beide Zeitumstellungen.
//   2. Migration alter Configs (Christins echter Plan als Fixture, ohne Orte):
//      Hilfs-Ankünfte fallen weg, zwei Abfahrten am Samstag bleiben beide.
//   3. Rückweg: evWeeklyPlan wird im alten Format mitgeschrieben (1.0.9 liest
//      es), eine Änderung durch eine ältere Version wird beim Laden übernommen.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as NEW from '../services/optimizer/ev-departure.js';
import * as OLD from './fixtures/ev-departure-ankunftstag-ref.js';
import { normalizeConfigInput } from '../config-model.js';

const TZ = 'Europe/Berlin';
const H = 3600_000;

// Christins gespeicherter Plan (Prod, 11.11.2026; Format bis 1.0.9).
const CHRISTIN = [
  { day: 1, arrival: '09:56', departure: '08:30', targetValue: null, commuteKm: null },
  { day: 2, arrival: '19:15', departure: '08:42', targetValue: 60, commuteKm: null },
  { day: 3, arrival: '19:43', departure: '10:00', targetValue: 30, commuteKm: null },
  { day: 4, arrival: '10:01', departure: '09:00', targetValue: 40, commuteKm: null },
  { day: 5, arrival: '10:01', departure: '10:00', targetValue: 50, commuteKm: null },
  { day: 6, arrival: '09:17', departure: '09:22', targetValue: 60, commuteKm: null },
  { day: 7, arrival: '09:40', departure: '09:39', targetValue: 70, commuteKm: null },
];

const dep = (day, departure, minSocPct = null, homeFrom = '', homeFromPrevDay = false, tripSocPct = null) =>
  ({ day, departure, minSocPct, tripSocPct, homeFrom, homeFromPrevDay });
const blank = (day) => dep(day, '');

// ------------------------------------------------------------ Zufallspläne

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

function randomOldPlan(r) {
  const rows = [];
  for (let day = 1; day <= 7; day += 1) {
    const kind = r();
    if (kind < 0.12) continue; // Tag fehlt ganz
    const row = { day, arrival: '', departure: '', minSocPct: null, tripSocPct: null };
    // Uhrzeiten meist aus einem kleinen Vorrat — so fallen oft zwei Zeilen auf
    // dieselbe Abfahrt (Folgetag der einen = Tag der anderen) —, sonst auf 5 min;
    // ab und zu Ankunft = Abfahrt (→ Folgetag, genau 24 h)
    const t = () => (r() < 0.6 ? pick(r, [5 * 60, 7 * 60, 7 * 60 + 30, 18 * 60, 23 * 60 + 55]) : Math.floor(r() * 288) * 5);
    if (kind < 0.85) row.departure = hhmm(t());
    if (r() < 0.6) row.arrival = r() < 0.08 && row.departure ? row.departure : hhmm(t());
    if (r() < 0.5) row.minSocPct = pick(r, [20, 40, 55, 60, 80, 100]);
    if (r() < 0.5) row.tripSocPct = pick(r, [0, 5, 12, 30]);
    rows.push(row);
  }
  // In gut einem Drittel der Pläne gezielt zwei Zeilen auf dieselbe Abfahrt:
  // Tag d „Ankunft abends, Abfahrt 07:00“ (→ Folgetag) und Tag d+1 „07:00“.
  if (r() < 0.35) {
    const d = 1 + Math.floor(r() * 7);
    const set = (day, patch) => {
      let row = rows.find((x) => x.day === day);
      if (!row) { row = { day, arrival: '', departure: '', minSocPct: null, tripSocPct: null }; rows.push(row); }
      Object.assign(row, patch);
    };
    set(d, { arrival: pick(r, ['18:00', '23:55']), departure: '07:00', minSocPct: pick(r, [40, 90]), tripSocPct: pick(r, [3, 33]) });
    set((d % 7) + 1, { arrival: pick(r, ['', '05:00']), departure: '07:00', minSocPct: pick(r, [55, null]), tripSocPct: pick(r, [7, null]) });
  }
  return rows;
}

function randomOnce(r, startMs) {
  const o = {};
  if (r() < 0.4) {
    o.evDepartureOnce = new Date(startMs + Math.floor(r() * 12 * 24 * 4) * 15 * 60_000).toISOString();
    if (r() < 0.5) o.evDepartureOnceMinSocPct = pick(r, [50, 85, 100]);
    if (r() < 0.5) o.evDepartureOnceTripSocPct = pick(r, [10, 40]);
    if (r() < 0.25) o.evDepartureOnceLeftAt = new Date(Date.parse(o.evDepartureOnce) - 20 * 60_000).toISOString();
  }
  if (r() < 0.25) o.evArrivalOnce = new Date(startMs + Math.floor(r() * 12 * 24 * 4) * 15 * 60_000).toISOString();
  return o;
}

// Alles bis auf `day` (alt: Tag der Ankunft-Zeile, neu: Tag der Abfahrt).
const noDay = (w) => (w ? { ...w, day: undefined } : w);
const winKey = (x) => ({ ...x, window: noDay(x.window) });
const depKey = (x) => ({ ...x, day: undefined });
const onceKey = (x) => (x.departure?.replaces ? { ...x, departure: { ...x.departure, replaces: { ...x.departure.replaces, day: undefined } } } : x);

const STARTS = [
  Date.parse('2026-11-09T05:13:00Z'), // gewöhnliche Woche
  Date.parse('2026-03-23T00:07:00Z'), // Sommerzeit beginnt So 29.03.
  Date.parse('2026-10-19T22:41:00Z'), // Winterzeit beginnt So 25.10.
];

test('Äquivalenz: alte Pläne verlustfrei umgerechnet planen über 2 Wochen genau gleich (Ankunft, Abfahrt, Ziel, Fahrt, Einmal-Ziel)', () => {
  const r = rng(20261111);
  let plans = 0; let points = 0; let windows = 0; let ties = 0;
  for (let n = 0; n < 120; n += 1) {
    const startMs = STARTS[n % STARTS.length] + Math.floor(r() * 7) * 24 * H;
    const old = randomOldPlan(r);
    const base = { evDepartureEnabled: r() < 0.9, evTargetMode: 'percent', evTargetValue: pick(r, [60, 80]), ...randomOnce(r, startMs) };
    const conv = NEW.departuresFromLegacy(old, base, { dropHelperArrivals: false, attachOrphanArrivals: false });
    const oldOpt = { ...base, evWeeklyPlan: old };
    const newOpt = { ...base, evWeeklyDepartures: conv.rows };
    const oldCfg = { optimizer: oldOpt, schedule: { timezone: TZ } };
    const newCfg = { optimizer: newOpt, schedule: { timezone: TZ } };
    plans += 1;
    // Zwei alte Zeilen mit derselben Abfahrt (Folgetag der einen = Tag der
    // anderen): dann entscheidet die Reihenfolge, wessen Ziel/Ankunft gilt.
    const depKeys = old.filter((e) => e.departure).map((e) => `${OLD.departsNextDay(e) ? (e.day % 7) + 1 : e.day} ${e.departure}`);
    if (new Set(depKeys).size < depKeys.length) ties += 1;
    for (let t = startMs; t < startMs + 14 * 24 * H; t += 71 * 60_000) {
      const a = OLD.resolveEvWindow(oldOpt.evDepartureEnabled ? oldOpt : { ...oldOpt, evWeeklyPlan: [] }, TZ, t);
      const b = NEW.resolveEvWindow(newOpt.evDepartureEnabled ? newOpt : { ...newOpt, evWeeklyDepartures: [] }, TZ, t);
      assert.deepEqual(winKey(b), winKey(a), `Plan ${n} ${new Date(t).toISOString()} ${JSON.stringify(old)}`);
      assert.deepEqual(depKey(NEW.resolveEvDeparture(newCfg, t)), depKey(OLD.resolveEvDeparture(oldCfg, t)));
      assert.deepEqual(NEW.evOnceCleanupPatch(newCfg, t), OLD.evOnceCleanupPatch(oldCfg, t));
      if (a.window) windows += 1;
      points += 1;
    }
    for (let t = startMs; t < startMs + 14 * 24 * H; t += 13 * H + 11 * 60_000) {
      assert.deepEqual(NEW.buildEvTrips(newCfg, t), OLD.buildEvTrips(oldCfg, t), `Fahrten Plan ${n} ${new Date(t).toISOString()}`);
      assert.deepEqual(onceKey(NEW.describeEvOnce(newCfg, t)), onceKey(OLD.describeEvOnce(oldCfg, t)));
    }
  }
  assert.equal(plans, 120);
  assert.ok(points > 30_000 && windows > points * 0.8 && ties > 30, `${points} Zeitpunkte, ${windows} mit Fenster, ${ties} Pläne mit zwei Zeilen auf derselben Abfahrt`);
});

test('Äquivalenz: Rückumrechnung in das alte Format (für 1.0.9) plant dasselbe wie die neue Zeile', () => {
  const r = rng(424242);
  for (let n = 0; n < 80; n += 1) {
    const old = randomOldPlan(r);
    const conv = NEW.departuresFromLegacy(old, {}, { dropHelperArrivals: false, attachOrphanArrivals: false });
    const mirror = NEW.legacyFromDepartures(conv.rows);
    assert.equal(mirror.lost.length, 0);
    // 1.0.9 liest targetValue (in %), nicht minSocPct/tripSocPct
    const as109 = mirror.rows.map(({ day, arrival, departure, targetValue }) => ({ day, arrival, departure, targetValue, commuteKm: null }));
    const startMs = STARTS[n % STARTS.length];
    for (let t = startMs; t < startMs + 14 * 24 * H; t += 97 * 60_000) {
      const a = OLD.resolveEvWindow({ evWeeklyPlan: as109 }, TZ, t).window;
      const b = NEW.resolveEvWindow({ evWeeklyDepartures: conv.rows }, TZ, t).window;
      assert.deepEqual(a && { arr: a.arrivalMs, dep: a.departureMs, min: a.minSocPct }, b && { arr: b.arrivalMs, dep: b.departureMs, min: b.minSocPct }, JSON.stringify(old));
    }
  }
});

// ------------------------------------------------------------ Christins Plan

test('Christins Plan: heutige Logik ergibt diese Woche (Tabelle alt)', () => {
  // Mo 16.11.2026 00:00 Berlin; die Fenster in Abfahrtsreihenfolge
  const t0 = Date.parse('2026-11-15T23:00:00Z');
  const seq = [];
  for (let t = t0; t < t0 + 7 * 24 * H; t += 5 * 60_000) {
    const w = OLD.resolveEvWindow({ evWeeklyPlan: CHRISTIN, evTargetMode: 'percent' }, TZ, t).window;
    const fmt = (ms) => (ms === null ? null : new Date(ms).toLocaleString('de-DE', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit' }));
    const row = { dep: fmt(w.departureMs), arr: fmt(w.arrivalMs), min: w.minSocPct };
    if (!seq.length || seq[seq.length - 1].dep !== row.dep) seq.push(row);
  }
  assert.deepEqual(seq, [
    { dep: 'Mo., 09:39', arr: 'So., 09:40', min: 70 },
    { dep: 'Di., 08:30', arr: 'Mo., 09:56', min: null },
    { dep: 'Mi., 08:42', arr: 'Di., 19:15', min: 60 },
    { dep: 'Do., 10:00', arr: 'Mi., 19:43', min: 30 },
    { dep: 'Fr., 09:00', arr: 'Do., 10:01', min: 40 },
    { dep: 'Sa., 09:22', arr: 'Sa., 09:17', min: 60 },
    // Ankunft Fr 10:01 liegt vor der Abfahrt Sa 09:22 → ohne Ankunft
    { dep: 'Sa., 10:00', arr: null, min: 50 },
    { dep: 'Mo., 09:39', arr: 'So., 09:40', min: 70 },
  ]);
});

test('Christins Plan: Umrechnung auf Abfahrtstage — Hilfs-Ankünfte fallen weg, Samstag behält beide Abfahrten', () => {
  const conv = NEW.departuresFromLegacy(CHRISTIN, { evTargetMode: 'percent' });
  assert.deepEqual(conv.rows, [
    dep(1, '09:39', 70),
    dep(2, '08:30', null),
    dep(3, '08:42', 60, '19:15', true),
    dep(4, '10:00', 30, '19:43', true),
    dep(5, '09:00', 40),
    dep(6, '09:22', 60, '09:17', false),
    dep(6, '10:00', 50),
    blank(7),
  ]);
  const kinds = conv.notes.map((x) => `${x.kind}:${x.day}`);
  assert.deepEqual(kinds, ['helper:2', 'helper:5', 'helper:6', 'helper:1', 'twice:6']);
  assert.match(conv.notes[0].text, /Montag.*09:56.*Dienstag 08:30/);
  assert.match(conv.notes.at(-1).text, /Samstag.*zwei Abfahrten.*09:22.*10:00/);
  // Abfahrten und Ziele bleiben über 2 Wochen gleich; nur die Hilfs-Ankünfte fehlen.
  const t0 = Date.parse('2026-11-09T05:00:00Z');
  for (let t = t0; t < t0 + 14 * 24 * H; t += 20 * 60_000) {
    const a = OLD.resolveEvWindow({ evWeeklyPlan: CHRISTIN, evTargetMode: 'percent' }, TZ, t).window;
    const b = NEW.resolveEvWindow({ evWeeklyDepartures: conv.rows }, TZ, t).window;
    assert.equal(b.departureMs, a.departureMs);
    assert.equal(b.minSocPct, a.minSocPct);
    // Hilfs-Ankünfte lagen 22,5–24 h vor der Abfahrt, die echten 13–15 h bzw. 5 min
    const helper = a.arrivalMs !== null && (a.departureMs - a.arrivalMs) > 22 * H;
    assert.equal(b.arrivalMs, helper ? null : a.arrivalMs);
  }
});

test('Christins Plan: Config-Migration beim Laden — neue Zeilen, Sicherung, Hinweis, altes Format für 1.0.9', () => {
  const { rawConfig } = normalizeConfigInput({ optimizer: { evDepartureEnabled: true, evWeeklyPlan: CHRISTIN } });
  const o = rawConfig.optimizer;
  assert.equal(o.evWeeklyDepartures.length, 8);
  assert.deepEqual(o.evWeeklyDepartures[2], dep(3, '08:42', 60, '19:15', true));
  assert.equal(o.evWeeklyMigration.seen, false);
  assert.deepEqual(o.evWeeklyMigration.previous, CHRISTIN);
  assert.equal(o.evWeeklyMigration.notes.length, 5);
  // Mitgeschrieben für 1.0.9: Zeile = Ankunftstag, Ziel in targetValue (%)
  assert.equal(o.evWeeklyPlan.length, 7);
  for (const row of o.evWeeklyPlan) assert.equal(row.targetValue, row.minSocPct);
  // Noch einmal laden: nichts mehr umzurechnen, Hinweis bleibt, wie er war
  const again = normalizeConfigInput(rawConfig).rawConfig.optimizer;
  assert.deepEqual(again.evWeeklyDepartures, o.evWeeklyDepartures);
  assert.deepEqual(again.evWeeklyMigration, o.evWeeklyMigration);
  assert.deepEqual(again.evWeeklyPlan, o.evWeeklyPlan);
});

test('Rückweg: 1.0.9 liest das mitgeschriebene alte Format und plant dieselben Abfahrten und Ziele', () => {
  const { rawConfig } = normalizeConfigInput({ optimizer: { evDepartureEnabled: true, evWeeklyPlan: CHRISTIN } });
  const o = rawConfig.optimizer;
  const as109 = o.evWeeklyPlan.map(({ day, arrival, departure, targetValue, commuteKm }) => ({ day, arrival, departure, targetValue, commuteKm }));
  const t0 = Date.parse('2026-11-09T05:00:00Z');
  for (let t = t0; t < t0 + 14 * 24 * H; t += 20 * 60_000) {
    const a = OLD.resolveEvWindow({ evWeeklyPlan: as109, evTargetMode: 'percent' }, TZ, t).window;
    const b = NEW.resolveEvWindow({ evWeeklyDepartures: o.evWeeklyDepartures }, TZ, t).window;
    assert.equal(a.departureMs, b.departureMs);
    assert.equal(a.minSocPct, b.minSocPct);
  }
  // Eine ältere offene Seite speichert das alte Format unverändert zurück →
  // dieselben Abfahrten wie vorher (auch Sa „zuhause ab 09:17“ bleibt).
  assert.deepEqual(NEW.departuresFromLegacy(as109, { evTargetMode: 'percent' }).rows, o.evWeeklyDepartures);
});

test('Rückweg: Änderung durch eine ältere Version wird beim nächsten Laden übernommen, bloßes Neuspeichern nicht', () => {
  const { rawConfig } = normalizeConfigInput({ optimizer: { evDepartureEnabled: true, evWeeklyPlan: CHRISTIN } });
  // 1.0.9 speichert unverändert (eigenes Zeilenformat, ohne minSocPct/tripSocPct) → keine neue Umrechnung
  const trips = structuredClone(rawConfig);
  trips.optimizer.evWeeklyDepartures[0].tripSocPct = 25;
  trips.optimizer.evWeeklyPlan = NEW.legacyFromDepartures(trips.optimizer.evWeeklyDepartures).rows;
  const resaved = structuredClone(trips);
  resaved.optimizer.evWeeklyPlan = resaved.optimizer.evWeeklyPlan.map(({ day, arrival, departure, targetValue }) => ({ day, arrival, departure, targetValue, commuteKm: null }));
  const kept = normalizeConfigInput(resaved).rawConfig.optimizer;
  assert.deepEqual(kept.evWeeklyDepartures, trips.optimizer.evWeeklyDepartures);
  assert.equal(kept.evWeeklyMigration.reason, 'legacy');
  // 1.0.9 ändert eine Abfahrt → die neue Zeile folgt, mit Hinweis
  const edited = structuredClone(resaved);
  const mo = edited.optimizer.evWeeklyPlan.find((x) => x.day === 1);
  mo.arrival = ''; mo.departure = '07:15'; mo.targetValue = 90;
  const o = normalizeConfigInput(edited).rawConfig.optimizer;
  assert.equal(o.evWeeklyMigration.reason, 'older-version');
  assert.equal(o.evWeeklyMigration.seen, false);
  assert.ok(o.evWeeklyDepartures.some((x) => x.day === 1 && x.departure === '07:15' && x.minSocPct === 90));
});

test('Rückweg: ältere Oberfläche setzt den Plan auf „time/days“ zurück → neue Zeilen fallen weg', () => {
  const { rawConfig } = normalizeConfigInput({ optimizer: { evWeeklyPlan: CHRISTIN } });
  rawConfig.optimizer.evWeeklyPlan = null;
  const o = normalizeConfigInput(rawConfig).rawConfig.optimizer;
  assert.equal(o.evWeeklyDepartures, null);
  assert.equal(NEW.effectiveWeeklyPlan({ ...o, evDepartureTime: '06:45', evDepartureDays: [1, 2] })[0].departure, '06:45');
});

// ------------------------------------------------------------ Regeln

test('Hilfs-Ankunft: nur am Vormittag, unter 2 h nach der (Folgetags-)Abfahrtszeit, oder genau gleich', () => {
  const one = (arrival, departure) => NEW.departuresFromLegacy([{ day: 1, arrival, departure }], {}).rows.find((x) => x.departure);
  assert.deepEqual(one('09:56', '08:30'), dep(2, '08:30', null)); // 86 min, Vormittag → Hilfe
  assert.deepEqual(one('10:29', '08:30'), dep(2, '08:30', null)); // 119 min
  assert.deepEqual(one('10:30', '08:30'), dep(2, '08:30', null, '10:30', true)); // 2 h → echt
  assert.deepEqual(one('12:10', '11:00'), dep(2, '11:00', null, '12:10', true)); // Mittag → echt
  assert.deepEqual(one('20:00', '05:00'), dep(2, '05:00', null, '20:00', true));
  assert.deepEqual(one('19:00', '19:00'), dep(2, '19:00', null)); // genau gleich → Hilfe
  assert.deepEqual(one('07:00', '08:30'), dep(1, '08:30', null, '07:00', false)); // gleicher Tag → echt
});

test('Ankunft ohne Abfahrt: wird „zuhause ab“ der nächsten Abfahrt binnen 24 h, sonst Hinweis', () => {
  const a = NEW.departuresFromLegacy([{ day: 1, arrival: '18:00', departure: '' }, { day: 2, arrival: '', departure: '07:00' }], {});
  assert.deepEqual(a.rows.find((x) => x.day === 2), dep(2, '07:00', null, '18:00', true));
  assert.equal(a.notes[0].kind, 'orphan-attached');
  const b = NEW.departuresFromLegacy([{ day: 1, arrival: '18:00', departure: '' }, { day: 3, arrival: '', departure: '07:00' }], {});
  assert.equal(b.rows.find((x) => x.day === 3).homeFrom, '');
  assert.equal(b.notes[0].kind, 'orphan-dropped');
  // Die nächste Abfahrt hat schon ein „zuhause ab“ → nicht eindeutig
  const c = NEW.departuresFromLegacy([{ day: 1, arrival: '18:00', departure: '' }, { day: 2, arrival: '05:00', departure: '07:00' }], {});
  assert.equal(c.rows.find((x) => x.day === 2).homeFrom, '05:00');
  assert.equal(c.notes[0].kind, 'orphan-dropped');
});

test('Neue Zeile: zuhause ab am Vortag oder am selben Tag, auch länger als 24 h vorher', () => {
  const t = Date.parse('2026-11-16T12:00:00Z'); // Mo
  const w = (row) => NEW.resolveEvWindow({ evWeeklyDepartures: [row] }, TZ, t).window;
  const at = (ms) => new Date(ms).toLocaleString('de-DE', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit' });
  let x = w(dep(2, '08:30', 80, '19:15', true));
  assert.equal(at(x.departureMs), 'Di., 08:30'); assert.equal(at(x.arrivalMs), 'Mo., 19:15');
  x = w(dep(2, '19:00', 80, '17:30', false));
  assert.equal(at(x.arrivalMs), 'Di., 17:30');
  x = w(dep(2, '19:00', 80, '17:30', true)); // 25,5 h vorher — ging im alten Format nicht
  assert.equal(at(x.arrivalMs), 'Mo., 17:30');
  x = w(dep(2, '08:30', 80));
  assert.equal(x.arrivalMs, null);
});

test('API: weeklyDepartures prüfen, altes weeklyPlan weiter annehmen, beides mitschreiben', () => {
  const p = NEW.parseEvDeparturePatch({ weeklyDepartures: [{ day: 2, departure: '8:30', minSocPct: 80, homeFrom: '19:15', homeFromPrevDay: true }] });
  assert.equal(p.ok, true);
  assert.deepEqual(p.patch.evWeeklyDepartures.filter((x) => x.departure), [dep(2, '08:30', 80, '19:15', true)]);
  assert.deepEqual(p.patch.evWeeklyPlan.find((x) => x.day === 1), { day: 1, arrival: '19:15', departure: '08:30', minSocPct: 80, tripSocPct: null, targetValue: 80, commuteKm: null });
  // ohne homeFromPrevDay: Vortag, wenn die Uhrzeit nicht vor der Abfahrt liegt
  const q = NEW.parseEvDeparturePatch({ weeklyDepartures: [{ day: 2, departure: '08:30', homeFrom: '19:15' }, { day: 3, departure: '19:00', homeFrom: '17:00' }] });
  assert.equal(q.patch.evWeeklyDepartures.find((x) => x.day === 2).homeFromPrevDay, true);
  assert.equal(q.patch.evWeeklyDepartures.find((x) => x.day === 3).homeFromPrevDay, false);
  // Fehler
  assert.match(NEW.parseEvDeparturePatch({ weeklyDepartures: [{ day: 2, departure: '', homeFrom: '19:15' }] }).error, /departure is required/);
  assert.match(NEW.parseEvDeparturePatch({ weeklyDepartures: [{ day: 2, departure: '08:00', homeFrom: '09:00', homeFromPrevDay: false }] }).error, /before the departure/);
  assert.match(NEW.parseEvDeparturePatch({ weeklyDepartures: [{ day: 2, departure: '08:00', minSocPct: 120 }] }).error, /minSocPct/);
  assert.match(NEW.parseEvDeparturePatch({ weeklyDepartures: Array.from({ length: 15 }, (_, i) => ({ day: (i % 7) + 1, departure: '08:00' })) }).error, /up to 14/);
  // Altes Format (ältere offene Seite): Hilfs-Ankunft fällt weg
  const old = NEW.parseEvDeparturePatch({ weeklyPlan: [{ day: 1, arrival: '09:56', departure: '08:30', minSocPct: 80, tripSocPct: null }] });
  assert.deepEqual(old.patch.evWeeklyDepartures.filter((x) => x.departure), [dep(2, '08:30', 80)]);
  // time/days (sehr alte Oberfläche) setzt beides zurück
  const td = NEW.parseEvDeparturePatch({ time: '07:00', days: [1] });
  assert.equal(td.patch.evWeeklyPlan, null); assert.equal(td.patch.evWeeklyDepartures, null);
  // Hinweis „umgestellt“ als gelesen markieren
  const seen = NEW.parseEvDeparturePatch({ migrationSeen: true }, 'departure', { opt: { evWeeklyMigration: { seen: false, notes: [] } } });
  assert.deepEqual(seen.patch.evWeeklyMigration, { seen: true, notes: [] });
});

test('Wochenplan aus: neue Zeilen zählen nicht, ein Einmal-Ziel schon', () => {
  const now = Date.parse('2026-11-16T12:00:00Z');
  const cfg = { optimizer: { evDepartureEnabled: false, evWeeklyDepartures: [dep(2, '08:30', 80)] }, schedule: { timezone: TZ } };
  assert.equal(NEW.resolveEvDeparture(cfg, now).enabled, false);
  cfg.optimizer.evDepartureOnce = '2026-11-18T06:00:00Z';
  const r = NEW.resolveEvDeparture(cfg, now);
  assert.equal(r.departureAt, '2026-11-18T06:00:00.000Z');
  assert.equal(r.source, 'once');
});

// ------------------------------------------------------------ Codex 4974135c

test('Codex 4974135c: dieselbe Abfahrt aus zwei Zeilen — es gilt wie bisher die vom Vortag, auch ohne ihre Hilfs-Ankunft', () => {
  const old = [{ day: 7, arrival: '08:00', departure: '07:00', minSocPct: 90 }, { day: 1, arrival: '', departure: '07:00', minSocPct: 40 }];
  const conv = NEW.departuresFromLegacy(old, {});
  assert.deepEqual(conv.rows.filter((r) => r.departure), [dep(1, '07:00', 90)]);
  assert.ok(conv.notes.some((n) => n.kind === 'duplicate' && /Montag 07:00 stand zweimal.*mindestens 90 %/.test(n.text)), JSON.stringify(conv.notes));
  const t = Date.parse('2026-11-15T11:00:00Z'); // So mittags
  assert.equal(OLD.resolveEvWindow({ evWeeklyPlan: old }, TZ, t).window.minSocPct, 90);
  assert.equal(NEW.resolveEvWindow({ evWeeklyDepartures: conv.rows }, TZ, t).window.minSocPct, 90);
  // Echte Ankunft am Vortag bleibt mit der Abfahrt erhalten
  const real = NEW.departuresFromLegacy([{ day: 7, arrival: '20:00', departure: '07:00', minSocPct: 90 }, { day: 1, departure: '07:00', minSocPct: 40 }], {});
  assert.deepEqual(real.rows.filter((r) => r.departure), [dep(1, '07:00', 90, '20:00', true)]);
});

test('Codex 4974135c: altes Format behält echte „zuhause ab“ vor dem Wunschplatz einer Abfahrt ohne', () => {
  const rows = [dep(2, '07:00'), dep(2, '10:00', 70, '09:00', false)];
  const m = NEW.legacyFromDepartures(rows);
  assert.equal(m.lost.length, 0);
  assert.deepEqual(m.rows.find((r) => r.day === 2), { day: 2, arrival: '09:00', departure: '10:00', minSocPct: 70, tripSocPct: null, targetValue: 70, commuteKm: null });
  assert.equal(m.rows.find((r) => r.day === 1).departure, '07:00');
});

test('Codex 4974135c: ältere Seite schickt das alte Format unverändert zurück → gespeicherter Plan bleibt (auch was das alte Format nicht kann)', () => {
  const stored = NEW.normalizeDepartureRows([dep(2, '19:00', 80, '17:30', true), dep(6, '09:22', 60, '09:17', false), dep(6, '10:00', 50, '', false, 12)]);
  const opt = { evWeeklyDepartures: stored };
  const mirror = NEW.legacyFromDepartures(stored).rows;
  const back = NEW.parseEvDeparturePatch({ weeklyPlan: mirror }, 'departure', { opt });
  assert.deepEqual(back.patch.evWeeklyDepartures, stored);
  // ohne Fahrt-Werte (Seite bis 1.0.9) ebenso
  const bare = mirror.map(({ day, arrival, departure, targetValue }) => ({ day, arrival, departure, targetValue }));
  assert.deepEqual(NEW.parseEvDeparturePatch({ weeklyPlan: bare }, 'departure', { opt }).patch.evWeeklyDepartures, stored);
  // geändert → umgerechnet
  const edited = mirror.map((r) => (r.day === 1 ? { ...r, minSocPct: 95, targetValue: 95 } : r));
  const ch = NEW.parseEvDeparturePatch({ weeklyPlan: edited }, 'departure', { opt });
  assert.equal(ch.patch.evWeeklyDepartures.find((r) => r.day === 2).minSocPct, 95);
  // Fahrt geändert (Seite schickt tripSocPct) → umgerechnet
  const trip = mirror.map((r) => (r.day === 1 ? { ...r, tripSocPct: 33 } : r));
  assert.equal(NEW.parseEvDeparturePatch({ weeklyPlan: trip }, 'departure', { opt }).patch.evWeeklyDepartures.find((r) => r.day === 2).tripSocPct, 33);
});

test('Codex 4974135c: angenommener Plan lässt sich unverändert wieder speichern (Grenze zählt Abfahrten)', () => {
  const many = Array.from({ length: 14 }, (_, i) => ({ day: 3, departure: hhmm(6 * 60 + i * 30) }));
  const a = NEW.parseEvDeparturePatch({ weeklyDepartures: many });
  assert.equal(a.ok, true, a.error);
  assert.equal(a.patch.evWeeklyDepartures.length, 20);
  const b = NEW.parseEvDeparturePatch({ weeklyDepartures: a.patch.evWeeklyDepartures });
  assert.equal(b.ok, true, b.error);
  assert.match(NEW.parseEvDeparturePatch({ weeklyDepartures: [...many, { day: 4, departure: '07:00' }] }).error, /up to 14/);
});

// ------------------------------------------------------------ Codex 6d342e27

test('Codex 6d342e27: mitgeschriebenes Altformat mit Fingerabdruck — andere Verteilung (frühere Version) ist keine Fremdänderung', () => {
  const deps = NEW.normalizeDepartureRows([dep(2, '07:00'), dep(2, '10:00', 70, '09:00', false), dep(2, '11:00', 60)]);
  // So hätte eine frühere Verteilung das alte Format schreiben können (gültig, aber anders):
  const earlier = [
    { day: 1, arrival: '10:00', departure: '10:00', minSocPct: 70, tripSocPct: null, targetValue: 70, commuteKm: null },
    { day: 2, arrival: '', departure: '07:00', minSocPct: null, tripSocPct: null, targetValue: null, commuteKm: null },
    ...[3, 4, 5, 6, 7].map((day) => ({ day, arrival: '', departure: '', minSocPct: null, tripSocPct: null, targetValue: null, commuteKm: null })),
  ];
  const o = normalizeConfigInput({ optimizer: { evWeeklyDepartures: deps, evWeeklyPlan: earlier, evWeeklyPlanKey: NEW.legacyPlanKey(earlier, {}) } }).rawConfig.optimizer;
  assert.deepEqual(o.evWeeklyDepartures, deps, 'nichts verloren');
  assert.equal(o.evWeeklyMigration ?? null, null, 'kein Hinweis');
  assert.equal(o.evWeeklyPlanKey, NEW.legacyPlanKey(o.evWeeklyPlan, {}));
  // Eine ältere Version ändert das alte Format → Fingerabdruck passt nicht mehr → deren Stand gilt
  const edited = earlier.map((r) => (r.day === 2 ? { day: 2, arrival: '', departure: '06:45', targetValue: 90, commuteKm: null } : r));
  const e = normalizeConfigInput({ optimizer: { evWeeklyDepartures: deps, evWeeklyPlan: edited, evWeeklyPlanKey: NEW.legacyPlanKey(earlier, {}) } }).rawConfig.optimizer;
  assert.equal(e.evWeeklyMigration.reason, 'older-version');
  assert.ok(e.evWeeklyDepartures.some((r) => r.day === 2 && r.departure === '06:45' && r.minSocPct === 90));
  // Speichern schreibt den Fingerabdruck mit
  const p = NEW.parseEvDeparturePatch({ weeklyDepartures: deps });
  assert.equal(p.patch.evWeeklyPlanKey, NEW.legacyPlanKey(p.patch.evWeeklyPlan, {}));
  assert.equal(NEW.parseEvDeparturePatch({ time: '07:00', days: [1] }).patch.evWeeklyPlanKey, null);
});

test('Codex 6d342e27: Fahrt-% der älteren Seite wird genau verglichen (12,1 → 12,4 ist eine Änderung)', () => {
  const stored = NEW.normalizeDepartureRows([dep(2, '07:00', 80, '', false, 12.1)]);
  const mirror = NEW.legacyFromDepartures(stored).rows.map((r) => (r.day === 2 ? { ...r, tripSocPct: 12.4 } : r));
  const p = NEW.parseEvDeparturePatch({ weeklyPlan: mirror }, 'departure', { opt: { evWeeklyDepartures: stored } });
  assert.equal(p.patch.evWeeklyDepartures.find((r) => r.day === 2).tripSocPct, 12.4);
});
