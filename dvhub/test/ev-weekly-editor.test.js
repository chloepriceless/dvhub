// test/ev-weekly-editor.test.js -- E-Auto-Planung (public/ev-weekly-editor.js),
// seit T-0427: Karten je Abfahrtstag, Blatt, Standardwerte. Reine Logik im
// Browser-Skript, hier über vm geladen; die Bedienung im Browser prüfen die
// Playwright-Specs tests/visual-parity/ev-wochenplan-*.spec.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { resolveEvWindow, earlyDepartureWithoutArrival, normalizeDepartureRows } from '../services/optimizer/ev-departure.js';

const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'public', 'ev-weekly-editor.js'), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(src, sandbox);
const W = sandbox.window.DVhubEvWeekly;
const plain = (x) => JSON.parse(JSON.stringify(x));
const row = (day, departure, extra = {}) => ({ day, departure, minSocPct: null, tripSocPct: null, homeFrom: '', homeFromPrevDay: false, ...extra });

describe('E-Auto-Planung: Karten in Klartext', () => {
  it('Karte: Uhrzeit, mind. (eigener Wert oder Standard), zuhause ab, Verbrauch → bei Ankunft', () => {
    assert.deepEqual(plain(W.cardText(row(2, '08:30', { minSocPct: 80, homeFrom: '19:15', homeFromPrevDay: true, tripSocPct: 20 }), 70)),
      { time: '08:30', min: 'mind. 80\u00a0%', minOwn: true, sub: 'zuhause ab Mo 19:15 · Verbrauch ≈ 20\u00a0% → bei Ankunft ≈ 60\u00a0%' });
    assert.deepEqual(plain(W.cardText(row(3, '07:00'), 70)), { time: '07:00', min: 'mind. 70\u00a0%', minOwn: false, sub: '' });
    assert.deepEqual(plain(W.cardText(row(4, ''), 70)), { time: '', min: '', sub: 'kein Termin', minOwn: false });
    // Verbrauch mit Standard-Ziel gerechnet; kein Verbrauch → keine Ankunftsschätzung
    assert.match(W.cardText(row(5, '07:00', { tripSocPct: 25 }), 70).sub, /→ bei Ankunft ≈ 45\u00a0%/);
    assert.equal(W.cardText(row(5, '07:00', { tripSocPct: 0 }), 70).sub, '');
  });

  it('erwarteter Ladestand bei Ankunft: Abfahrt − Verbrauch, nie unter 0, ohne Verbrauch nichts', () => {
    assert.equal(W.arrivalSocPct(80, 20), 60);
    assert.equal(W.arrivalSocPct(30, 45), 0);
    for (const t of [null, '', 0, undefined]) assert.equal(W.arrivalSocPct(80, t), null, String(t));
  });

  it('Nacht-Hinweis nur ohne „zuhause ab“ — dieselbe Regel wie der Server', () => {
    for (let m = 0; m < 24 * 60; m += 5) {
      const t = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      for (const homeFrom of ['', '20:00']) {
        const r = row(3, t, { homeFrom, homeFromPrevDay: true });
        assert.equal(!!W.rowInfo(r).hint, earlyDepartureWithoutArrival(r), `${t} ${homeFrom}`);
      }
    }
    assert.equal(W.rowInfo(row(3, '02:00')).hint, 'Nacht von Dienstag auf Mittwoch');
  });

  it('„zuhause ab“ am selben Tag nach der Abfahrt ist ein Fehler, am Vortag nicht; dieselben Zeiten wie die Auflösung am Server', () => {
    assert.match(W.rowInfo(row(2, '08:30', { homeFrom: '09:00', homeFromPrevDay: false })).error, /vor der Abfahrt/);
    assert.equal(W.rowInfo(row(2, '08:30', { homeFrom: '09:00', homeFromPrevDay: true })).error, '');
    assert.equal(W.rowInfo(row(2, '08:30', { homeFrom: '09:00', homeFromPrevDay: true })).homeText, 'zuhause ab Mo 09:00');
    assert.equal(W.rowInfo(row(1, '08:30', { homeFrom: '19:00', homeFromPrevDay: true })).homeText, 'zuhause ab So 19:00');
    assert.match(W.rowInfo(row(2, '', { homeFrom: '19:00' })).error, /ohne Abfahrt/);
    // Die Karte nennt denselben Tag, den der Server als Ankunft nimmt.
    const now = Date.parse('2026-11-16T12:00:00Z'); // Mo
    for (const prev of [true, false]) {
      const r = row(3, '19:00', { homeFrom: '17:30', homeFromPrevDay: prev });
      const w = resolveEvWindow({ evWeeklyDepartures: [r] }, 'Europe/Berlin', now).window;
      const wd = new Date(w.arrivalMs).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', weekday: 'short' }).replace('.', '');
      assert.equal(W.rowInfo(r).homeText, `zuhause ab ${wd} 17:30`);
    }
  });

  it('feste Form wie am Server: je Tag mind. eine Zeile, nach Uhrzeit, Vortag zuerst', () => {
    const list = [row(6, '10:00', { minSocPct: 50 }), row(6, '09:22', { homeFrom: '09:17' }), row(2, '8:30'), { day: 9, departure: '07:00' }];
    assert.deepEqual(plain(W.normalizePlan(list)), plain(normalizeDepartureRows(list)));
  });
});

describe('E-Auto-Planung: Prüfen vor dem Speichern', () => {
  it('Fehler je Zeile, eingeschaltet ohne Abfahrt, Standardwerte', () => {
    assert.match(W.validate([row(3, '', { homeFrom: '20:00' })]), /Mittwoch/);
    assert.match(W.validate([row(1, '')], { enabled: true }), /Mindestens einen Tag/);
    assert.equal(W.validate([row(1, '')], { enabled: true, hasOnce: true }), null, 'Einmal-Ziel allein genügt');
    assert.equal(W.validate([row(2, '05:00', { homeFrom: '20:00', homeFromPrevDay: true })], { enabled: true }), null);
    assert.match(W.validate([row(1, '07:00')], { settings: { minSocPct: 120, maxSocPct: '' } }), /0–100/);
    assert.match(W.validate([row(1, '07:00')], { settings: { minSocPct: 80, maxSocPct: 5 } }), /10–100/);
    assert.equal(W.validate([row(1, '07:00')], { settings: { minSocPct: 80, maxSocPct: '' } }), null);
  });

  it('Hinweis: alter Heimweg wird nicht mehr genutzt (Christin 10.11.2026)', () => {
    assert.match(W.legacyCommuteHint(20), /Heimweg \(20 km\).*nicht mehr/);
    assert.match(W.legacyCommuteHint('12.5'), /12,5 km/);
    for (const v of [0, null, undefined, '', 'x', -3]) assert.equal(W.legacyCommuteHint(v), '', String(v));
  });
});

describe('E-Auto-Planung: Rückmeldung in Klartext', () => {
  const resolved = { enabled: true, weeklyEnabled: true, departureAt: '2026-11-17T07:30:00.000Z', targetSocPct: 80, tripSocPct: 20, source: 'weekly', day: 2, timeZone: 'Europe/Berlin' };

  it('nächste Abfahrt, Verbrauch → bei Ankunft, wann geladen wird — ohne Technik in der Hauptansicht', () => {
    const lines = plain(W.summaryLines({ resolved, capacityWh: 60000, maxSocPct: 90 }));
    assert.equal(lines[0].text, 'Nächste Abfahrt: Di 17.11. 08:30 mit mindestens 80\u00a0% (≈\u00a048\u00a0kWh)');
    assert.equal(lines[0].cls, 'is-next');
    assert.equal(lines[1].text, 'Verbrauch der Fahrt ≈ 20\u00a0% → bei Ankunft ≈ 60\u00a0%');
    assert.equal(lines[2].text, 'Geladen wird ab dem Anstecken in den günstigsten Stunden, auch über Nacht — und bis 90\u00a0%, wenn Strom günstig ist.');
    for (const l of lines) assert.doesNotMatch(l.text, /EOS|Wertstufe|Folgetag/);
  });

  it('mit „zuhause ab“: Laden ab dann; mit geplantem Ladestand von EOS: Ankunft danach', () => {
    const lines = plain(W.summaryLines({ resolved: { ...resolved, arrivalAt: '2026-11-16T18:15:00.000Z', arrivalSource: 'weekly' }, plannedSocAtDeparture: 90 }));
    assert.match(lines.find((l) => /Geladen wird/.test(l.text)).text, /^Geladen wird ab Mo 16\.11\. 19:15 \(zuhause ab\)/);
    assert.equal(lines[1].text, 'Verbrauch der Fahrt ≈ 20\u00a0% → bei Ankunft ≈ 70\u00a0% (nach dem Ladeplan)');
  });

  it('Technik (EOS-Ziele, Wertstufen) nur als eingeklappte Details', () => {
    const lines = plain(W.summaryLines({
      resolved,
      eos: {
        optimizeEv: true, registered: true, deadlineSupported: true, chargeStartSupported: true, mode: 'plugged', valueSupported: true,
        targets: { minSocPct: 88, minWeekPct: 80, maxSocPct: 90, maxActive: true, steps: [[85, 0.15], [90, 0.09]] },
      },
    }));
    const tech = lines.filter((l) => l.tech);
    assert.equal(tech.length, 1);
    assert.match(tech[0].text, /mindestens 88\u00a0%.*vorausschauend, Plan 80\u00a0%.*bis 90\u00a0%, wenn günstig.*Wert 15–9 ct je kWh.*Ladestart sofort/);
    assert.ok(lines.filter((l) => !l.tech).every((l) => !/EOS/.test(l.text)));
  });

  it('Planung aus: als Hinweis sichtbar (nicht versteckt)', () => {
    const lines = plain(W.summaryLines({ resolved, eos: { optimizeEv: false } }));
    const off = lines.find((l) => /aus — das Auto wird nicht mitgeplant/.test(l.text));
    assert.ok(off && !off.tech);
  });

  it('Wochenplan aus, Einmal-Ziel ist die einzige Abfahrt', () => {
    const lines = plain(W.summaryLines({ resolved: { ...resolved, weeklyEnabled: false, source: 'once' } }));
    assert.match(lines[0].text, /— einmalig$/);
    assert.ok(lines.some((l) => /Wochenplan ist aus — das ist die einzige geplante Abfahrt/.test(l.text)));
    assert.match(plain(W.summaryLines({ resolved: { enabled: false, timeZone: 'Europe/Berlin' } }))[0].text, /^Wochenplan aus/);
  });

  it('Max ohne passendes EOS wird ehrlich benannt (in den Details)', () => {
    const lines = plain(W.summaryLines({
      resolved: { ...resolved, tripSocPct: 0 },
      eos: { optimizeEv: true, registered: true, deadlineSupported: true, valueSupported: false, maxSocPct: 80, targets: { minSocPct: 80, maxActive: false } },
    }));
    assert.ok(lines.some((l) => l.tech && /wirkt erst mit einem EOS, das Wertstufen kennt/.test(l.text)));
  });
});
