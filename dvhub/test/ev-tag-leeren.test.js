// test/ev-tag-leeren.test.js -- Einzelnen Tag im E-Auto-Wochenplan leeren
// (Christin 10.11.2026, Handy): Am iPhone öffnet ein Tipp ins Zeitfeld sofort
// den Zeit-Picker, und WebKit schreibt dabei schon die aktuelle Uhrzeit ins
// leere Feld; „Zurücksetzen“ im Picker leert nur dieses eine Feld (der Rad-
// Picker bleibt offen und zeigt weiter eine Zeit), Ankunft, Mind. % und
// Fahrt % bleiben stehen. Deshalb je Tag ein „Leeren“-Knopf, der die ganze
// Zeile auf „nicht gesetzt“ stellt, ohne dass man ins Zeitfeld tippen muss —
// und ein „Leeren“ fürs Einmal-Ziel.
//
// Oberfläche (public/ev-weekly-editor.js) über vm mit einer kleinen Attrappe
// des DOM; Server: ein geleerter Tag kommt als „nicht gesetzt“ an, die Konfig
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
function fakeRow(day, v = {}) {
  const parts = {
    '.evw-arr': fakeEl({ value: v.arrival || '' }),
    '.evw-dep': fakeEl({ value: v.departure || '' }),
    '.evw-min': fakeEl({ value: v.min ?? '' }),
    '.evw-trip': fakeEl({ value: v.trip ?? '' }),
    '.evw-next': fakeEl(), '.evw-res': fakeEl(), '.evw-warn': fakeEl(), '.evw-row-clear': fakeEl(),
  };
  const row = fakeEl({
    querySelector: (sel) => parts[sel] || null,
    querySelectorAll: (sel) => (sel === 'input' ? ['.evw-arr', '.evw-dep', '.evw-min', '.evw-trip'].map((k) => parts[k]) : []),
    parts,
  });
  row.setAttribute('data-day', day);
  return row;
}
function fakeHost(rows) {
  return fakeEl({
    querySelector: (sel) => {
      const m = /^\.evw-row\[data-day="(\d)"\]$/.exec(sel);
      return m ? rows.find((r) => r.getAttribute('data-day') === m[1]) || null : null;
    },
    querySelectorAll: (sel) => (sel === '.evw-row' ? rows : []),
  });
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
  it('jede Tageszeile hat einen eigenen „Leeren“-Knopf mit Tagesname (aria-label), ohne dass man ins Zeitfeld tippen muss', () => {
    // rowHtml baut 7 Zeilen; je Zeile genau ein Knopf, kein type=submit.
    const m = src.match(/class="[^"]*evw-row-clear[^"]*"/g) || [];
    assert.ok(m.length >= 1, 'Knopf evw-row-clear fehlt in rowHtml');
    assert.match(src, /<button type="button" class="[^"]*evw-row-clear/);
    assert.match(src, /aria-label="' \+ name \+ ' leeren"/, 'aria-label mit Tagesname');
    // Zeitfelder nie als Pflichtfeld (iOS erzwänge sonst eine Zeit).
    assert.doesNotMatch(src, /type="time"[^>]*required/);
  });

  it('Fingergröße: der Knopf ist auf Touch und schmal mindestens 44 px groß', () => {
    assert.ok(/\.evw-row-clear\s*\{[^}]*min-width:\s*44px/.test(css), 'min-width 44px fehlt');
    assert.ok(/\.evw-row-clear\s*\{[^}]*min-height:\s*44px/.test(css), 'min-height 44px fehlt');
  });

  it('clearDay stellt Ankunft, Abfahrt, Mind. % und Fahrt % auf „nicht gesetzt“, die Zeile zeigt „kein Termin“, onChange läuft', () => {
    const W = loadEditor();
    const rows = [1, 2, 3, 4, 5, 6, 7].map((d) => fakeRow(d, d === 3 ? { arrival: '18:00', departure: '07:30', min: '60', trip: '25' } : { departure: '07:00' }));
    const host = fakeHost(rows);
    let changes = 0;
    host._evwOpts = { onChange: () => { changes += 1; } };
    assert.equal(typeof W.clearDay, 'function', 'DVhubEvWeekly.clearDay fehlt');
    W.clearDay(host, 3);
    const p = rows[2].parts;
    assert.deepEqual([p['.evw-arr'].value, p['.evw-dep'].value, p['.evw-min'].value, p['.evw-trip'].value], ['', '', '', '']);
    assert.equal(p['.evw-res'].textContent, 'kein Termin');
    // Keine Schein-Uhrzeit im leeren Zeitfeld (WebKit malt sonst die aktuelle Zeit).
    assert.equal(p['.evw-arr'].classList.contains('is-unset'), true);
    assert.equal(p['.evw-dep'].classList.contains('is-unset'), true);
    assert.equal(rows[1].parts['.evw-dep'].classList.contains('is-unset'), false);
    assert.equal(p['.evw-res'].hidden, false);
    assert.equal(changes, 1);
    // Die anderen Tage bleiben, wie sie sind.
    assert.equal(rows[1].parts['.evw-dep'].value, '07:00');
    // Gelesen: nicht gesetzt — kein 00:00, keine 0 %.
    const plan = W.read(host);
    assert.deepEqual(JSON.parse(JSON.stringify(plan[2])), { day: 3, arrival: '', departure: '', minSocPct: null, tripSocPct: null });
    assert.equal(W.validate(plan, { enabled: true }), null, 'geleerter Tag blockiert das Speichern nicht');
  });

  it('nur die Abfahrt per iOS-„Zurücksetzen“ geleert: Speichern scheitert an der Ankunft — „Leeren“ nimmt beides weg', () => {
    const W = loadEditor();
    // Das ist der Zustand nach „Zurücksetzen“ im Picker der Abfahrt.
    assert.match(W.validate([{ day: 3, arrival: '18:00', departure: '' }]) || '', /Ankunft ohne Abfahrt/);
    const rows = [fakeRow(3, { arrival: '18:00', departure: '' })];
    W.clearDay(fakeHost(rows), 3);
    assert.equal(W.validate(W.read(fakeHost(rows))), null);
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

  it('Leitstand-Kachel und Integrationsseite haben einen „Leeren“-Knopf fürs Einmal-Ziel', () => {
    const tile = fs.readFileSync(path.join(PUB, 'ev-tile.js'), 'utf8');
    const intg = fs.readFileSync(path.join(PUB, 'integrations.html'), 'utf8');
    assert.ok(tile.includes('data-evw-clear=\\"evDepOnce evOnceMin evOnceTrip\\"'), 'Kachel: Einmal-Ziel-Leeren fehlt');
    assert.ok(intg.includes('data-evw-clear="evcc-dep-once evcc-dep-once-min evcc-dep-once-trip"'), 'Integrationsseite: Einmal-Ziel-Leeren fehlt');
  });

  it('Cache-Busting: alle Einbindungen von ev-weekly-editor.js/.css und ev-tile.js zeigen auf denselben neuen Stand', () => {
    const pages = ['index.html', 'integrations.html', 'family.html'].map((f) => fs.readFileSync(path.join(PUB, f), 'utf8'));
    const vers = new Set();
    for (const html of pages) {
      for (const m of html.matchAll(/ev-weekly-editor\.(?:js|css)\?v=([\w-]+)/g)) vers.add(m[1]);
    }
    assert.equal(vers.size, 1, [...vers].join(', '));
    assert.notEqual([...vers][0], '20261110-minmax', 'alte Version — Browser hielten den alten Editor im Cache');
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

describe('Wochenplan: geleerter Tag am Server', () => {
  it('POST /api/ev mit geleertem Mittwoch: gespeichert als nicht gesetzt (kein 00:00, keine 0 %)', async () => {
    const ctx = makeCtx();
    const r = await call(ctx, 'POST', '/api/ev', { departure: { enabled: true, weeklyPlan: planWith(WED_EMPTY), once: '', onceMinSocPct: '', onceTripSocPct: '' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const opt = ctx.saved.at(-1).optimizer;
    assert.deepEqual(opt.evWeeklyPlan[2], WED_EMPTY);
    assert.equal(opt.evDepartureOnce, '');
    assert.equal(opt.evDepartureOnceMinSocPct, null);
    assert.equal(opt.evDepartureOnceTripSocPct, null);
  });

  it('ältere Oberflächen schicken leere Strings: auch "" bei Mind./Fahrt heißt nicht gesetzt', () => {
    const p = parseEvDeparturePatch({ weeklyPlan: [{ day: 3, arrival: '', departure: '', minSocPct: '', tripSocPct: '' }] });
    assert.equal(p.ok, true, p.error);
    assert.deepEqual(p.patch.evWeeklyPlan[2], WED_EMPTY);
  });

  it('ein geleerter Tag erzeugt keine Abfahrt — weder in der Auflösung noch in den Fahrten', () => {
    const full = { optimizer: { evDepartureEnabled: true, evTargetValue: 80, evWeeklyPlan: planWith(WED_FULL) } };
    const empty = { optimizer: { evDepartureEnabled: true, evTargetValue: 80, evWeeklyPlan: planWith(WED_EMPTY) } };
    // Vorher: Abfahrt aus Mittwoch.
    const before = resolveEvDeparture(full, NOW);
    assert.equal(before.day, 3);
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
      assert.deepEqual(loaded.rawConfig.optimizer.evWeeklyPlan[2], WED_EMPTY);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
