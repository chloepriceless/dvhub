// test/ev-einmal-ziel-ohne-wochenplan.test.js -- Einmal-Ziel wirkt auch bei
// ausgeschaltetem Wochenplan (Christin 11.11.2026): „Aktivieren“ schaltet den
// Wochenplan nicht mehr ein. Ohne Wochenplan ist das Einmal-Ziel die einzige
// Abfahrt — Frist und Ziel gehen an EOS, die Wochenplan-Zeilen (auch ihre
// Ankunft) spielen keine Rolle, nach der Abfahrt ist sofort wieder „aus“.
//
// Zeiten: Europe/Berlin im Winter UTC+1. Mo 16.11.2026 20:00 = 19:00Z.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {
  resolveEvDeparture, buildEvTrips, describeEvOnce, evOnceCleanupPatch, evOnceUnplugPatch, DEPARTURE_LEAD_MS,
} from '../services/optimizer/ev-departure.js';
import { resolveEvTargets } from '../services/optimizer/ev-targets.js';
import { buildEosElectricVehicles } from '../services/optimizer/eos-config-sync.js';

const TZ = 'Europe/Berlin';
const at = (s) => Date.parse(s);
const MIN = 60_000;
const NOW = at('2026-11-16T19:00:00Z');
const ONCE = '2026-11-18T05:00:00.000Z';   // Mi 18.11. 06:00
// Eingetragener, aber ausgeschalteter Wochenplan: Mo–Fr Ankunft 18:00 → Abfahrt 07:00, 60 %.
const COMMUTE = [1, 2, 3, 4, 5].map((day) => ({ day, arrival: '18:00', departure: '07:00', minSocPct: 60, tripSocPct: 20 }));
function cfg(extra = {}) {
  return {
    schedule: { timezone: TZ },
    optimizer: {
      eosOptimizeEv: true, evDepartureEnabled: false, evWeeklyPlan: COMMUTE, evCapacityWh: 60000,
      evConsumptionKwhPer100km: 18, evTargetMode: 'percent', evTargetValue: 80, evMaxChargeW: 11000, evMinSocPct: 50,
      evDepartureOnce: ONCE, evDepartureOnceMinSocPct: 90, ...extra,
    },
  };
}

describe('Wochenplan aus + Einmal-Ziel: das Einmal-Ziel ist die einzige Abfahrt', () => {
  test('Auflösung: aktiv, Frist = Einmal-Abfahrt, Ziel 90 %, keine Wochenplan-Ankunft', () => {
    const r = resolveEvDeparture(cfg(), NOW);
    assert.equal(r.enabled, true);
    assert.equal(r.weeklyEnabled, false);
    assert.equal(r.source, 'once');
    assert.equal(r.departureAt, ONCE);
    assert.equal(r.targetSocPct, 90);
    assert.equal(r.arrivalAt, null);
    assert.equal(r.day, null);
  });

  test('ohne eigenes Mindestziel: allgemeiner Ziel-Ladestand, nicht die Wochenplan-Zeile', () => {
    const r = resolveEvDeparture(cfg({ evDepartureOnceMinSocPct: null }), NOW);
    assert.equal(r.targetSocPct, 80);
    assert.equal(r.ownTarget, false);
  });

  test('Fahrtenliste: nur die einmalige Abfahrt', () => {
    const trips = buildEvTrips(cfg(), NOW, { days: 8 }).trips.filter((t) => t.src !== 'current');
    assert.deepEqual(trips.map((t) => [new Date(t.depMs).toISOString(), t.minPct, t.src]), [[ONCE, 90, 'once']]);
  });

  test('EOS-Ziele: Frist und Mindestziel aus dem Einmal-Ziel (nicht „Wochenplan aus“)', () => {
    const t = resolveEvTargets({ state: { optimizer: {} } }, cfg(), { nowMs: NOW });
    assert.notEqual(t.reason, 'Wochenplan aus');
    assert.equal(t.source, 'plan');
    assert.equal(t.minSocPct, 90);
    assert.equal(t.deadlineAt, ONCE);
  });

  test('EOS-Fahrzeug bekommt Frist und Ziel', () => {
    const [ev] = buildEosElectricVehicles(cfg(), { supportsDeadline: true, nowMs: NOW });
    assert.equal(ev.min_soc_deadline_datetime, ONCE);
    assert.equal(ev.min_soc_percentage, 90);
  });

  test('Status: wirksam, ersetzt nichts, nichts davor', () => {
    const d = describeEvOnce(cfg(), NOW);
    assert.equal(d.weeklyEnabled, false);
    assert.equal(d.departure.state, 'active');
    assert.equal(d.departure.effective, true);
    assert.equal(d.departure.replaces, null);
    assert.equal(d.departure.weeklyBefore, 0);
    assert.equal(d.departure.targetSocPct, 90);
  });

  test('Ende: nach der Abfahrt wieder „aus“ und sofort abgeräumt', () => {
    const gone = at(ONCE) - DEPARTURE_LEAD_MS;
    assert.equal(resolveEvDeparture(cfg(), gone - 1).enabled, true);
    const r = resolveEvDeparture(cfg(), gone);
    assert.equal(r.enabled, false);
    assert.equal(describeEvOnce(cfg(), gone).departure.state, 'ended');
    assert.deepEqual(evOnceCleanupPatch(cfg(), gone - 1), {});
    assert.deepEqual(evOnceCleanupPatch(cfg(), gone),
      { evDepartureOnce: '', evDepartureOnceMinSocPct: null, evDepartureOnceTripSocPct: null, evDepartureOnceLeftAt: '' });
  });

  test('Abstecken 20 min vorher: los, nicht mehr aktiv, abgeräumt', () => {
    const t = at(ONCE) - 20 * MIN;
    const p = evOnceUnplugPatch(cfg(), t);
    assert.ok(p.evDepartureOnceLeftAt);
    const after = cfg(p);
    assert.equal(resolveEvDeparture(after, t + MIN).enabled, false);
    assert.equal(evOnceCleanupPatch(after, t + MIN).evDepartureOnce, '');
  });

  test('einmalige Ankunft allein wirkt ohne Wochenplan nicht (es gibt keine Abfahrt)', () => {
    const c = cfg({ evDepartureOnce: '', evDepartureOnceMinSocPct: null, evArrivalOnce: '2026-11-17T17:00:00.000Z' });
    assert.equal(resolveEvDeparture(c, NOW).enabled, false);
    assert.notEqual(describeEvOnce(c, NOW).arrival.state, 'active');
  });

  test('Wochenplan an: unverändert (ersetzt Mi 07:00, Di 07:00 kommt zuerst)', () => {
    const r = resolveEvDeparture(cfg({ evDepartureEnabled: true }), NOW);
    assert.equal(r.source, 'weekly');
    assert.equal(r.weeklyEnabled, true);
    assert.equal(describeEvOnce(cfg({ evDepartureEnabled: true }), NOW).departure.replaces.departureAt, '2026-11-18T06:00:00.000Z');
  });
});

describe('Oberfläche: „Aktivieren“ schaltet den Wochenplan nicht ein', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'public', 'ev-once.js'), 'utf8');
  const sandbox = { window: {}, document: { addEventListener() {}, getElementById: () => null }, setTimeout, clearTimeout, Date, Promise };
  vm.runInNewContext(src, sandbox);
  const O = sandbox.window.DVhubEvOnce;

  test('kein enabled:true im gesendeten Einmal-Ziel', () => {
    assert.doesNotMatch(src, /out\.enabled\s*=\s*true/);
  });

  test('Hinweis bei Wochenplan aus: einzige Abfahrt, Wochenplan bleibt aus', () => {
    const v = O.validate({ once: new Date(NOW + 86400_000).toISOString(), arrivalOnce: '' }, { nowMs: NOW, enabled: false, tz: TZ });
    assert.equal(v.error, null);
    assert.ok(v.hints.some((h) => /Wochenplan ist aus/.test(h) && /einzige/.test(h) && !/schaltet/.test(h)), v.hints.join('|'));
  });

  test('Chip: aktiv (nicht „wirkt nicht“), ohne „Statt Wochenplan“', () => {
    const c = O.chip(describeEvOnce(cfg(), NOW), { tz: TZ });
    assert.equal(c.kind, 'active');
    assert.match(c.title, /^Einmal-Ziel aktiv: Mi 18\.11\. 06:00 · mindestens 90/);
    const t = c.lines.join('\n');
    assert.doesNotMatch(t, /Statt Wochenplan|Davor gilt/);
    assert.match(t, /Wochenplan ist aus/);
  });

  test('Codex 175975ce: Ankunft allein bei Wochenplan aus wird abgelehnt (bewirkte nichts)', () => {
    const v = O.validate({ once: '', arrivalOnce: new Date(NOW + 3600_000).toISOString() }, { nowMs: NOW, enabled: false, tz: TZ });
    assert.match(v.error || '', /Ankunft allein bewirkt nichts/);
    // mit Wochenplan an erlaubt
    assert.equal(O.validate({ once: '', arrivalOnce: new Date(NOW + 3600_000).toISOString() }, { nowMs: NOW, enabled: true, tz: TZ }).error, null);
    // ein Rest davon zeigt „wirkt nicht“ statt Aktiv
    const c = O.chip(describeEvOnce(cfg({ evDepartureOnce: '', evDepartureOnceMinSocPct: null, evArrivalOnce: '2026-11-17T17:00:00.000Z' }), NOW), { tz: TZ });
    assert.match(c.title, /wirkt nicht/);
  });

  test('Codex 175975ce: Integrationsseite frischt Status nach dem Speichern auf und fragt selbst regelmäßig', () => {
    const intg = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'public', 'integrations.js'), 'utf8');
    assert.match(intg, /attach\(host, \{ fetch: apiFetch, onSaved: evccOnceSaved, poll: true \}\)/);
    assert.match(intg, /async function evccOnceSaved\(\)[\s\S]*?setEvccDepSummary\(dep[\s\S]*?renderEvccDepState\(dep\)/);
    assert.match(src, /if \(o && o\.poll\)[\s\S]*?setInterval/);
  });
});
