// test/ev-plan-visibility.test.js -- Wochenplan sichtbar machen (2026-10-29).
//
// Anlass (Prod 29.10.): In der Mittwochszeile stand „Abfahrt 02:00, Ziel 30 %“
// OHNE Ankunft. Gemeint war Donnerstag 02:00; DVhub las — richtig nach der
// Regel „ohne Ankunft gilt die Abfahrt am Tag selbst“ — Mittwoch 02:00 (vorbei)
// und plante das Donnerstagsfenster (Ankunft 13:49, Abfahrt 23:59, 80 %).
// Die Regel bleibt; neu ist, dass die Oberflaeche zeigt, was DVhub aus jeder
// Zeile macht, eine Vorschau vor dem Speichern und ein Hinweis bei der Falle.
//
// Zeiten von Hand gerechnet: Ende Oktober 2026 gilt in Berlin CET (UTC+1).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {
  departsNextDay, earlyDepartureWithoutArrival, EARLY_DEPARTURE_HINT_BEFORE, previewEvDeparture
} from '../services/optimizer/ev-departure.js';
import { createApiRoutes } from '../routes-api.js';

const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'public', 'ev-weekly-editor.js'), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(src, sandbox);
const W = sandbox.window.DVhubEvWeekly;

// Christins Plan vom 29.10. (Prod-Config, Mittwoch wie beobachtet ohne Ankunft).
const CHRISTIN_PLAN = [
  { day: 1, arrival: '', departure: '23:59' },
  { day: 2, arrival: '20:59', departure: '00:30' },
  { day: 3, arrival: '', departure: '02:00', targetValue: 30 },
  { day: 4, arrival: '13:49', departure: '23:59', targetValue: 80 },
  { day: 5, arrival: '', departure: '23:59' },
  { day: 6, arrival: '', departure: '23:59' },
  { day: 7, arrival: '', departure: '23:59' },
];
const cfg = (extra = {}) => ({
  schedule: { timezone: 'Europe/Berlin' },
  optimizer: {
    eosOptimizeEv: true, evCapacityWh: 75000, evDepartureEnabled: true,
    evTargetMode: 'percent', evTargetValue: 80, evConsumptionKwhPer100km: 18,
    evWeeklyPlan: CHRISTIN_PLAN, ...extra
  }
});
// Mittwoch 28.10.2026, 23:00 Berlin.
const WED_2300 = Date.parse('2026-10-28T23:00:00+01:00');

describe('Regeln je Zeile (Server)', () => {
  it('Abfahrt rutscht nur mit Ankunft und Abfahrt nicht nach der Ankunft auf den Folgetag', () => {
    assert.equal(departsNextDay({ arrival: '20:00', departure: '05:00' }), true);
    assert.equal(departsNextDay({ arrival: '20:00', departure: '20:00' }), true, 'gleich = Folgetag (wie planWindows)');
    assert.equal(departsNextDay({ arrival: '13:49', departure: '23:59' }), false);
    assert.equal(departsNextDay({ arrival: '', departure: '02:00' }), false, 'ohne Ankunft: am Tag selbst');
    assert.equal(departsNextDay({ arrival: '20:00', departure: '' }), false);
  });

  it(`Hinweis bei Abfahrt vor ${EARLY_DEPARTURE_HINT_BEFORE} ohne Ankunft`, () => {
    assert.equal(EARLY_DEPARTURE_HINT_BEFORE, '06:00');
    assert.equal(earlyDepartureWithoutArrival({ arrival: '', departure: '02:00' }), true);
    assert.equal(earlyDepartureWithoutArrival({ arrival: '', departure: '00:00' }), true);
    assert.equal(earlyDepartureWithoutArrival({ arrival: '', departure: '05:55' }), true);
    assert.equal(earlyDepartureWithoutArrival({ arrival: '', departure: '06:00' }), false);
    assert.equal(earlyDepartureWithoutArrival({ arrival: '', departure: '07:00' }), false, 'alter Plan Mo–Fr 07:00: kein Hinweis');
    assert.equal(earlyDepartureWithoutArrival({ arrival: '20:00', departure: '02:00' }), false, 'mit Ankunft ist es eindeutig');
    assert.equal(earlyDepartureWithoutArrival({ arrival: '', departure: '' }), false);
  });
});

describe('Vorschau ohne Speichern (previewEvDeparture)', () => {
  it('Christins Plan: Mittwoch 02:00 ohne Ankunft ist vorbei → Donnerstagsfenster 23:59, 80 %', () => {
    const c = cfg();
    const out = previewEvDeparture(c, { weeklyPlan: CHRISTIN_PLAN }, { nowMs: WED_2300 });
    assert.equal(out.ok, true, out.error);
    assert.equal(out.resolved.departureAt, '2026-10-29T22:59:00.000Z');
    assert.equal(out.resolved.day, 4);
    assert.equal(out.resolved.source, 'weekly');
    assert.equal(out.resolved.targetSocPct, 80);
    assert.equal(out.resolved.arrivalAt, '2026-10-29T12:49:00.000Z');
    assert.equal(c.optimizer.evWeeklyPlan, CHRISTIN_PLAN, 'Config unveraendert');
  });

  it('mit Ankunft in der Mittwochszeile rutscht die Abfahrt auf Do 02:00, Ziel 30 %', () => {
    const plan = CHRISTIN_PLAN.map((e) => (e.day === 3 ? { ...e, arrival: '20:00' } : e));
    const out = previewEvDeparture(cfg(), { weeklyPlan: plan }, { nowMs: WED_2300 });
    assert.equal(out.ok, true, out.error);
    assert.equal(out.resolved.departureAt, '2026-10-29T01:00:00.000Z');
    assert.equal(out.resolved.day, 3);
    assert.equal(out.resolved.targetSocPct, 30);
  });

  it('Ziel in kWh mit der Kapazitaet aus dem Formular, nicht der gespeicherten', () => {
    const out = previewEvDeparture(cfg(), { targetMode: 'kwh', targetValue: 30, weeklyPlan: [{ day: 5, departure: '07:00' }] }, { nowMs: WED_2300, capacityWh: 60000 });
    assert.equal(out.ok, true, out.error);
    assert.equal(out.resolved.targetSocPct, 50);
  });

  it('ungueltige Eingabe → Fehler wie beim Speichern', () => {
    const out = previewEvDeparture(cfg(), { weeklyPlan: [{ day: 3, arrival: '20:00', departure: '' }] }, { nowMs: WED_2300 });
    assert.equal(out.ok, false);
    assert.match(out.error, /departure is required with an arrival/);
  });
});

describe('POST /api/ev/preview', () => {
  function makeCtx() {
    const raw = cfg();
    const saved = [];
    return {
      saved,
      state: { meter: {}, victron: {}, epex: { ok: false, data: [] }, energy: {}, telemetry: {}, keepalive: { appPulse: {} }, log: [], schedule: { rules: [], config: {}, active: {}, lastWrite: {}, manualOverride: {} }, ctrl: {} },
      getCfg: () => ({ ...raw, apiToken: null, corsAllowedOrigins: [], allowedHosts: [], gridPositiveMeans: 'grid_import' }),
      getRawCfg: () => raw,
      getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }),
      getAppVersion: () => ({ version: '0.0.0-test' }),
      controlValue: () => 'off', pushLog: () => {}, telemetrySafeWrite: () => {}, needsSetup: () => false,
      expireLeaseIfNeeded: () => {}, epexNowNext: () => null,
      // Ohne Pro: die Vorschau speichert nichts und braucht deshalb keine Lizenz.
      licenseService: { requirePro(req, res) { res.writeHead(403); res.end('{"error":"pro_required"}'); return false; } },
      saveAndApplyConfig: (next) => { saved.push(next); return { ok: true, changedPaths: [] }; },
    };
  }
  async function call(ctx, body) {
    const routes = createApiRoutes(ctx);
    const req = {
      method: 'POST', url: '/api/ev/preview',
      headers: { host: 'dvhub.test', 'content-type': 'application/json' },
      socket: { remoteAddress: '192.168.1.20' },
      on(ev, cb) {
        if (ev === 'data') setTimeout(() => cb(Buffer.from(JSON.stringify(body))), 0);
        if (ev === 'end') setTimeout(() => cb(), 1);
        return req;
      },
      destroy() {},
    };
    const out = { status: 0, body: '' };
    const res = { writeHead(c) { out.status = c; }, setHeader() {}, end(b) { out.body = b == null ? '' : String(b); } };
    await routes.handleRequest(req, res, new URL('/api/ev/preview', 'http://dvhub.test'));
    return { status: out.status, body: out.body ? JSON.parse(out.body) : null };
  }

  it('liefert die Aufloesung des Entwurfs und speichert nichts', async () => {
    const ctx = makeCtx();
    // Nur Mittwoch 02:00 ohne Ankunft — unabhaengig von „jetzt“ ist das ein Mittwoch.
    const r = await call(ctx, { departure: { enabled: true, weeklyPlan: [{ day: 3, arrival: '', departure: '02:00', targetValue: 30 }] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.resolved.day, 3);
    assert.equal(r.body.resolved.targetSocPct, 30);
    const wd = new Date(r.body.resolved.departureAt).toLocaleDateString('en-US', { timeZone: 'Europe/Berlin', weekday: 'short' });
    assert.equal(wd, 'Wed');
    assert.equal(ctx.saved.length, 0);
  });

  it('400 bei ungueltigem Entwurf', async () => {
    const r = await call(makeCtx(), { departure: { weeklyPlan: [{ day: 3, arrival: '20:00', departure: '' }] } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /departure is required with an arrival/);
  });
});

describe('Editor im Browser: Zeilen-Aufloesung', () => {
  it('dieselben Regeln wie der Server (alle Zeiten im 5-Minuten-Raster)', () => {
    const times = [''];
    for (let m = 0; m < 24 * 60; m += 5) times.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
    let n = 0;
    for (const arrival of times.filter((_, i) => i % 7 === 0 || i < 3)) {
      for (const departure of times) {
        const e = { arrival, departure };
        const info = W.rowInfo({ day: 3, ...e });
        assert.equal(info.nextDay, departsNextDay(e), `${arrival} → ${departure}`);
        assert.equal(info.early, earlyDepartureWithoutArrival(e), `${arrival} → ${departure}`);
        n += 1;
      }
    }
    assert.ok(n > 10000);
  });

  it('Texte je Zeile', () => {
    assert.equal(W.rowInfo({ day: 3, arrival: '', departure: '02:00' }).text, '→ Abfahrt Mi 02:00');
    assert.equal(W.rowInfo({ day: 3, arrival: '20:00', departure: '02:00' }).text, 'Ankunft Mi 20:00 → Abfahrt Do 02:00 (Folgetag)');
    assert.equal(W.rowInfo({ day: 4, arrival: '13:49', departure: '23:59' }).text, 'Ankunft Do 13:49 → Abfahrt Do 23:59');
    assert.equal(W.rowInfo({ day: 7, arrival: '20:00', departure: '05:00' }).text, 'Ankunft So 20:00 → Abfahrt Mo 05:00 (Folgetag)');
    assert.equal(W.rowInfo({ day: 1, arrival: '', departure: '' }).text, '');
    assert.match(W.rowInfo({ day: 2, arrival: '20:00', departure: '' }).text, /Abfahrt fehlt/);
  });

  it('Hinweis bei der Falle nennt beide Naechte und den Ausweg', () => {
    const hint = W.rowInfo({ day: 3, arrival: '', departure: '02:00' }).hint;
    assert.equal(hint, 'Diese Abfahrt gilt für Mittwoch 02:00 (Nacht von Dienstag auf Mittwoch). Ist die Nacht von Mittwoch auf Donnerstag gemeint, trage hier eine Ankunft ein (z. B. 20:00) — dann rutscht die Abfahrt auf Donnerstag 02:00.');
    assert.equal(W.rowInfo({ day: 1, arrival: '', departure: '07:00' }).hint, '');
    assert.equal(W.rowInfo({ day: 3, arrival: '20:00', departure: '02:00' }).hint, '');
    assert.match(W.rowInfo({ day: 7, arrival: '', departure: '04:00' }).hint, /Sonntag 04:00 \(Nacht von Samstag auf Sonntag\).*Sonntag auf Montag.*Montag 04:00/);
  });
});

describe('Editor im Browser: Zusammenfassung', () => {
  const resolved = {
    enabled: true, departureAt: '2026-10-29T22:59:00.000Z', source: 'weekly', day: 4,
    arrivalAt: '2026-10-29T12:49:00.000Z', arrivalSource: 'weekly', targetSocPct: 80, timeZone: 'Europe/Berlin'
  };
  const eos = { optimizeEv: true, registered: true, mode: 'preplan', chargeStartAt: '2026-10-29T12:49:00.000Z', deadlineSupported: true, chargeStartSupported: true };

  it('naechste Abfahrt mit Quelle, Ankunft davor und was an EOS geht', () => {
    const lines = W.summaryLines({ resolved, eos, capacityWh: 75000 });
    assert.equal(lines[0].text, 'Nächste Abfahrt: Do 29.10. 23:59 · Ziel 80 % ≈ 60 kWh · aus Wochenplan Donnerstag');
    assert.equal(lines[1].text, 'Ankunft davor: Do 29.10. 13:49 (Wochenplan)');
    assert.equal(lines[2].text, 'An EOS: Ziel 80 % bis Do 29.10. 23:59 · Ladestart Do 29.10. 13:49');
  });

  it('Abfahrt am Folgetag nennt die Zeile, aus der sie kommt', () => {
    const lines = W.summaryLines({ resolved: { ...resolved, departureAt: '2026-10-29T01:00:00.000Z', day: 3, arrivalAt: '2026-10-28T19:00:00.000Z', targetSocPct: 30 }, eos: null });
    assert.equal(lines[0].text, 'Nächste Abfahrt: Do 29.10. 02:00 · Ziel 30 % · aus Wochenplan Mittwoch (Abfahrt am Folgetag)');
  });

  it('einmalige Abfahrt', () => {
    const lines = W.summaryLines({ resolved: { ...resolved, source: 'once', day: 4 }, eos: null });
    assert.equal(lines[0].text, 'Nächste Abfahrt: Do 29.10. 23:59 · Ziel 80 % · einmalig (statt Wochenplan Donnerstag)');
    const alone = W.summaryLines({ resolved: { ...resolved, source: 'once', day: null, arrivalAt: null }, eos: null });
    assert.equal(alone[0].text, 'Nächste Abfahrt: Do 29.10. 23:59 · Ziel 80 % · einmalig');
  });

  it('Vorschau: markiert und sagt, dass an EOS noch der gespeicherte Plan geht', () => {
    const lines = W.summaryLines({ resolved, eos, preview: true });
    assert.match(lines[0].text, /^Vorschau \(noch nicht gespeichert\) — Nächste Abfahrt/);
    assert.match(lines.at(-1).text, /^An EOS \(gespeicherter Plan\):/);
  });

  it('EOS-Zeile: nicht angemeldet, ohne Uhrzeit, aus', () => {
    assert.equal(W.summaryLines({ resolved, eos: { ...eos, registered: false, reason: 'nicht angesteckt', preplanBlocked: null } }).at(-1).text, 'An EOS: Auto gerade nicht angemeldet (nicht angesteckt)');
    assert.equal(W.summaryLines({ resolved, eos: { ...eos, mode: 'plugged', chargeStartAt: null, deadlineSupported: false } }).at(-1).text, 'An EOS: Ziel 80 % ohne Uhrzeit (kein EOS 0.4 erkannt)');
    assert.equal(W.summaryLines({ resolved, eos: { ...eos, optimizeEv: false } }).at(-1).text, 'An EOS: nichts — EOS plant das Auto nicht mit');
    assert.equal(W.summaryLines({ resolved, eos: { ...eos, registered: null } }).at(-1).text, 'An EOS: noch nichts — DVhub hat das Auto noch nicht mit EOS abgeglichen');
    assert.equal(W.summaryLines({ resolved, eos: { ...eos, mode: 'plugged', chargeStartAt: null } }).at(-1).text, 'An EOS: Ziel 80 % bis Do 29.10. 23:59 · Ladestart sofort (angesteckt)');
  });

  it('Wochenplan aus / keine Abfahrt', () => {
    assert.equal(W.summaryLines({ resolved: { enabled: false, reason: 'aus' }, eos: null })[0].text, 'Wochenplan aus — EOS nutzt den allgemeinen Ziel-Ladestand.');
    assert.equal(W.summaryLines({ resolved: { enabled: true, departureAt: null, reason: 'keine Abfahrt geplant', targetSocPct: 80 }, eos: null })[0].text, 'Keine Abfahrt geplant.');
  });
});
