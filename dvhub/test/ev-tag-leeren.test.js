// test/ev-tag-leeren.test.js -- Einzelnen Tag im E-Auto-Wochenplan leeren
// (Christin 10.11.2026, Handy): Am iPhone öffnet ein Tipp ins Zeitfeld sofort
// den Zeit-Picker, und WebKit schreibt dabei schon die aktuelle Uhrzeit ins
// leere Feld; „Zurücksetzen“ im Picker leert nur dieses eine Feld (der Rad-
// Picker bleibt offen und zeigt weiter eine Zeit), Ankunft, Mind. % und
// Fahrt % bleiben stehen. Deshalb je Tag ein „Leeren“-Knopf, der die ganze
// Zeile auf „nicht gesetzt“ stellt, ohne dass man ins Zeitfeld tippen muss —
// und ein „Leeren“ fürs Einmal-Ziel.
//
// Seit T-0427 (Karten je Abfahrtstag) ist es ein Schalter je Tag statt
// „Leeren“; Uhrzeiten nur im Blatt. Oberfläche (public/ev-weekly-editor.js)
// über vm mit einer kleinen Attrappe des DOM; Server: ein geleerter Tag kommt als „nicht gesetzt“ an, die Konfig
// nimmt ihn so an und er erzeugt keine Abfahrt.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createApiRoutes } from '../routes-api.js';
import { buildEvTrips, previewEvDeparture, resolveEvDeparture, parseEvDeparturePatch } from '../services/optimizer/ev-departure.js';
import { loadConfigFile } from '../config-model.js';

const PUB = path.resolve(import.meta.dirname, '..', 'public');
const src = fs.readFileSync(path.join(PUB, 'ev-weekly-editor.js'), 'utf8');
const css = fs.readFileSync(path.join(PUB, 'ev-weekly-editor.css'), 'utf8');

// ------------------------------------------------------------ DOM-Attrappe
function fakeEl(props = {}) {
  const classes = new Set();
  const listeners = {};
  return {
    value: '', hidden: false, textContent: '', disabled: false, attrs: {}, events: [],
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
      toggle: (c, on) => { const v = on === undefined ? !classes.has(c) : !!on; if (v) classes.add(c); else classes.delete(c); return v; },
    },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    dispatchEvent(ev) { this.events.push(ev.type); (listeners[ev.type] || []).forEach((fn) => fn(ev)); return true; },
    ...props,
  };
}
function loadEditor(doc = {}) {
  const sandbox = {
    window: {},
    document: { addEventListener() {}, getElementById: () => null, ...doc },
    Event: class { constructor(type, o = {}) { this.type = type; this.bubbles = !!o.bubbles; } },
    setTimeout, clearTimeout,
  };
  vm.runInNewContext(src, sandbox);
  return sandbox.window.DVhubEvWeekly;
}

describe('Wochenplan: einzelnen Tag leeren (Oberfläche)', () => {
  // Seit T-0427 (Karten je Abfahrtstag): je Tag ein Schalter „fahre an diesem
  // Tag“ — aus = kein Termin, ohne ein Zeitfeld anzutippen. Uhrzeiten gibt es
  // nur noch im Blatt (Dialog) nach Antippen der Karte.
  it('jede Tageskarte hat einen eigenen Schalter mit Tagesname (aria-label); keine Zeitfelder in der Liste', () => {
    assert.match(src, /switchHtml\('evw-drive', !!ct\.time, DAY_NAMES\[i\] \+ ': fahre an diesem Tag'\)/);
    assert.match(src, /<input type="checkbox" class="' \+ cls \+ '"/);
    // Karten-HTML ohne Zeitfeld; Zeitfelder nie als Pflichtfeld (iOS erzwänge sonst eine Zeit).
    const card = src.slice(src.indexOf('function cardHtml'), src.indexOf('function migrationHtml'));
    assert.doesNotMatch(card, /type="time"/);
    assert.doesNotMatch(src, /type="time"[^>]*required/);
  });

  it('Fingergröße: Schalter, Löschen und Knöpfe im Blatt mindestens 44 px', () => {
    for (const sel of ['\\.evw-card-sw', '\\.evw \\.evw-card-del']) {
      assert.ok(new RegExp(sel + '\\s*\\{[^}]*min-width:\\s*(4[4-9]|[5-9]\\d)px').test(css), `${sel} min-width`);
      assert.ok(new RegExp(sel + '\\s*\\{[^}]*min-height:\\s*44px').test(css), `${sel} min-height`);
    }
    assert.match(css, /\.evw-chip \{[^}]*min-height:44px/);
    assert.match(css, /\.evw-seg-b \{[^}]*min-height:44px/);
    assert.match(css, /\.evw-card-main \{[^}]*min-height:44px/);
  });

  it('clearDay nimmt alle Abfahrten des Tages heraus (auch eine zweite), die anderen bleiben, onChange läuft', () => {
    const W = loadEditor();
    let changes = 0;
    const host = { querySelector: () => null, _evwOpts: { onChange: () => { changes += 1; } } };
    host._evwRows = W.normalizePlan([
      { day: 2, departure: '07:00' },
      { day: 3, departure: '07:30', minSocPct: 60, tripSocPct: 25, homeFrom: '18:00', homeFromPrevDay: true },
      { day: 3, departure: '19:00' },
    ]);
    assert.equal(W.clearDay(host, 3), true);
    assert.equal(changes, 1);
    const plan = JSON.parse(JSON.stringify(W.read(host)));
    assert.deepEqual(plan.filter((r) => r.day === 3), [{ day: 3, departure: '', minSocPct: null, tripSocPct: null, homeFrom: '', homeFromPrevDay: false }]);
    assert.equal(plan.find((r) => r.day === 2).departure, '07:00');
    assert.equal(W.validate(plan, { enabled: true }), null, 'geleerter Tag blockiert das Speichern nicht');
  });

  it('„zuhause ab“ ohne Abfahrt blockiert das Speichern — Tag ausschalten nimmt beides weg', () => {
    const W = loadEditor();
    assert.match(W.validate([{ day: 3, departure: '', homeFrom: '18:00' }]) || '', /Mittwoch: „zuhause ab“ ohne Abfahrt/);
    const host = { querySelector: () => null, _evwOpts: {}, _evwRows: [{ day: 3, departure: '', homeFrom: '18:00' }] };
    W.clearDay(host, 3);
    assert.equal(W.validate(W.read(host)), null);
  });

  it('Einmal-Ziel leeren: Felder per data-evw-clear auf leer, input + change sprudeln (Seite merkt die Änderung)', () => {
    const fields = { evDepOnce: fakeEl({ value: '2026-11-11T07:00' }), evOnceMin: fakeEl({ value: '75' }), evOnceTrip: fakeEl({ value: '40' }) };
    const W = loadEditor({ getElementById: (id) => fields[id] || null });
    assert.equal(typeof W.clearFields, 'function', 'DVhubEvWeekly.clearFields fehlt');
    W.clearFields(['evDepOnce', 'evOnceMin', 'evOnceTrip', 'gibtsnicht']);
    for (const f of Object.values(fields)) {
      assert.equal(f.value, '');
      assert.deepEqual(f.events, ['input', 'change']);
    }
  });

  it('Einmal-Ziel beenden geht überall per „Beenden“ im gemeinsamen Baustein; „zuhause ab“ im Dialog leeren (seit 11.11.2026)', () => {
    const once = fs.readFileSync(path.join(PUB, 'ev-once.js'), 'utf8');
    assert.ok(once.includes('data-evo="end"'), '„Beenden“ fürs Einmal-Ziel fehlt');
    assert.ok(once.includes('id="evOnceArrClear"'), 'Dialog: „zuhause ab“ leeren fehlt');
  });

  it('Cache-Busting: alle Einbindungen von ev-weekly-editor.js/.css und ev-tile.js zeigen auf denselben neuen Stand', () => {
    const pages = ['index.html', 'integrations.html', 'family.html'].map((f) => fs.readFileSync(path.join(PUB, f), 'utf8'));
    const vers = new Set();
    for (const html of pages) {
      for (const m of html.matchAll(/ev-weekly-editor\.(?:js|css)\?v=([\w-]+)/g)) vers.add(m[1]);
    }
    assert.equal(vers.size, 1, [...vers].join(', '));
    assert.equal([...vers][0], '20261111-abfahrtstag3', 'neuer Stand (T-0427) — sonst hielten Browser den alten Editor im Cache');
  });
});

// ------------------------------------------------------------ Server
const WED_FULL = { day: 3, arrival: '18:00', departure: '07:30', minSocPct: 60, tripSocPct: 25 };
const WED_EMPTY = { day: 3, arrival: '', departure: '', minSocPct: null, tripSocPct: null };
const planWith = (wed) => [1, 2, 3, 4, 5, 6, 7].map((day) => (day === 3 ? wed : { day, arrival: '', departure: '', minSocPct: null, tripSocPct: null }));

function makeCtx() {
  const raw = { optimizer: { enabled: true, eosOptimizeEv: false, evDepartureEnabled: true, evWeeklyPlan: planWith(WED_FULL) }, evcc: { enabled: true, url: 'http://evcc' }, wallbox: { kind: 'x' } };
  const saved = [];
  return {
    saved,
    state: {
      meter: { grid_total_w: 0 }, victron: {}, epex: { ok: false, data: [] }, energy: { day: null },
      telemetry: {}, keepalive: { appPulse: {} }, log: [],
      schedule: { rules: [], config: {}, active: {}, lastWrite: {}, manualOverride: {} }, ctrl: { forcedOff: false },
    },
    getCfg: () => ({ ...raw, apiToken: null, corsAllowedOrigins: [], allowedHosts: [], gridPositiveMeans: 'grid_import' }),
    getRawCfg: () => raw,
    getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }),
    getAppVersion: () => ({ version: '0.0.0-test' }),
    controlValue: () => 'off', pushLog: () => {}, telemetrySafeWrite: () => {}, needsSetup: () => false,
    expireLeaseIfNeeded: () => {}, epexNowNext: () => null,
    licenseService: { requirePro: () => true },
    saveAndApplyConfig: (next) => { saved.push(JSON.parse(JSON.stringify(next))); Object.assign(raw, JSON.parse(JSON.stringify(next))); return { ok: true, changedPaths: [] }; },
    optimizerService: { requestEosReplan: () => {} },
  };
}
async function call(ctx, method, url, body) {
  const routes = createApiRoutes(ctx);
  const req = {
    method, url, headers: { host: 'dvhub.test', 'content-type': 'application/json' }, socket: { remoteAddress: '192.168.1.20' },
    on(ev, cb) {
      if (ev === 'data' && body !== undefined) setTimeout(() => cb(Buffer.from(JSON.stringify(body))), 0);
      if (ev === 'end') setTimeout(() => cb(), 1);
      return req;
    },
    destroy() {},
  };
  const out = { status: 0, body: '' };
  const res = { writeHead(c) { out.status = c; }, setHeader() {}, end(b) { out.body = b == null ? '' : String(b); } };
  await routes.handleRequest(req, res, new URL(url, 'http://dvhub.test'));
  return { status: out.status, body: out.body ? JSON.parse(out.body) : null };
}

// Mi 11.11.2026 08:00 Berlin → nächste Mittwochs-Abfahrt wäre Do 12.11. 07:30 (Folgetag).
const NOW = Date.parse('2026-11-11T07:00:00Z');
// Seit T-0427 wird evWeeklyPlan im alten Format mitgeschrieben (Rückweg 1.0.9:
// targetValue, commuteKm); gilt: evWeeklyDepartures (Zeile = Abfahrtstag).
const WED_EMPTY_STORED = { ...WED_EMPTY, targetValue: null, commuteKm: null };
const noWedDeparture = (rows) => rows.every((x) => !(x.day === 3 && x.departure) && !(x.day === 4 && x.departure === WED_FULL.departure));

describe('Wochenplan: geleerter Tag am Server', () => {
  it('POST /api/ev mit geleertem Mittwoch: gespeichert als nicht gesetzt (kein 00:00, keine 0 %)', async () => {
    const ctx = makeCtx();
    const r = await call(ctx, 'POST', '/api/ev', { departure: { enabled: true, weeklyPlan: planWith(WED_EMPTY), once: '', onceMinSocPct: '', onceTripSocPct: '' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const opt = ctx.saved.at(-1).optimizer;
    assert.deepEqual(opt.evWeeklyPlan[2], WED_EMPTY_STORED);
    assert.ok(noWedDeparture(opt.evWeeklyDepartures), JSON.stringify(opt.evWeeklyDepartures));
    assert.equal(opt.evDepartureOnce, '');
    assert.equal(opt.evDepartureOnceMinSocPct, null);
    assert.equal(opt.evDepartureOnceTripSocPct, null);
  });

  it('ältere Oberflächen schicken leere Strings: auch "" bei Mind./Fahrt heißt nicht gesetzt', () => {
    const p = parseEvDeparturePatch({ weeklyPlan: [{ day: 3, arrival: '', departure: '', minSocPct: '', tripSocPct: '' }] });
    assert.equal(p.ok, true, p.error);
    assert.deepEqual(p.patch.evWeeklyPlan[2], WED_EMPTY_STORED);
    assert.ok(noWedDeparture(p.patch.evWeeklyDepartures));
  });

  it('ein geleerter Tag erzeugt keine Abfahrt — weder in der Auflösung noch in den Fahrten', () => {
    const full = { optimizer: { evDepartureEnabled: true, evTargetValue: 80, evWeeklyPlan: planWith(WED_FULL) } };
    const empty = { optimizer: { evDepartureEnabled: true, evTargetValue: 80, evWeeklyPlan: planWith(WED_EMPTY) } };
    // Vorher: Abfahrt aus Mittwoch.
    const before = resolveEvDeparture(full, NOW);
    assert.equal(before.day, 4, 'Mi 18:00 → Do 07:30: Abfahrtstag Donnerstag (T-0427)');
    assert.ok(buildEvTrips(full, NOW).trips.some((t) => t.depMs === Date.parse(before.departureAt)));
    // Nachher: kein Tag mit Abfahrt → keine Abfahrt, keine Fahrt.
    const after = resolveEvDeparture(empty, NOW);
    assert.equal(after.departureAt, null);
    assert.deepEqual(buildEvTrips(empty, NOW).trips, []);
    // Die Vorschau (was die Kachel beim Bearbeiten zeigt) sieht es genauso.
    const pv = previewEvDeparture(full, { enabled: true, weeklyPlan: planWith(WED_EMPTY) }, { nowMs: NOW });
    assert.equal(pv.ok, true, pv.error);
    assert.equal(pv.resolved.departureAt, null);
  });

  it('Konfig laden: ein geleerter Tag bleibt geleert (keine Übernahme als alte Zeile, keine Vorbelegung)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-leeren-'));
    try {
      const file = path.join(dir, 'config.json');
      fs.writeFileSync(file, JSON.stringify({ optimizer: { evDepartureEnabled: true, evWeeklyPlan: planWith(WED_EMPTY) } }, null, 2));
      const loaded = loadConfigFile(file);
      assert.equal(loaded.broken, false);
      assert.deepEqual(loaded.rawConfig.optimizer.evWeeklyPlan[2], WED_EMPTY_STORED);
      assert.ok(noWedDeparture(loaded.rawConfig.optimizer.evWeeklyDepartures));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
