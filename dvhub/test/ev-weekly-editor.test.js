// test/ev-weekly-editor.test.js -- Wochenplan-Editor (public/ev-weekly-editor.js):
// reine Hilfsfunktionen im Browser-Skript, hier ueber vm geladen.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'public', 'ev-weekly-editor.js'), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(src, sandbox);
const W = sandbox.window.DVhubEvWeekly;

describe('Wochenplan-Editor', () => {
  it('Plan in SoC-%: Kachel und Integrationsseite zeigen dieselben Spalten — nichts Verstecktes geht verloren', () => {
    const read = [{ day: 1, arrival: '19:30', departure: '05:00', minSocPct: 90, tripSocPct: 25 }];
    assert.deepEqual(JSON.parse(JSON.stringify(W.keepHidden(read, [], {}))), read);
  });

  it('Zusammenfassung: Mindest-Ladestand, Fahrt und was an EOS geht (min vorausschauend, Max, Wertstufen)', () => {
    const lines = W.summaryLines({
      resolved: { enabled: true, departureAt: '2026-11-17T06:00:00.000Z', targetSocPct: 50, tripSocPct: 30, source: 'weekly', day: 2, timeZone: 'Europe/Berlin' },
      capacityWh: 75000,
      eos: {
        optimizeEv: true, registered: true, deadlineSupported: true, chargeStartSupported: true, mode: 'plugged',
        valueSupported: true,
        targets: { minSocPct: 68, minWeekPct: 50, maxSocPct: 80, maxActive: true, steps: [[73, 0.15], [80, 0.09]], deadlineAt: '2026-11-17T06:00:00.000Z' },
      },
    }).map((l) => l.text);
    assert.match(lines[0], /mindestens 50 %/);
    assert.match(lines[0], /Fahrt danach ≈ 30 %/);
    const eos = lines.find((t) => t.startsWith('An EOS'));
    assert.match(eos, /mindestens 68 %/);
    assert.match(eos, /vorausschauend, Plan 50 %/);
    assert.match(eos, /bis 80 %, wenn günstig/);
    assert.match(eos, /Wert 15–9 ct je kWh/);
  });

  it('Zusammenfassung: Max-Ladestand ohne passendes EOS wird ehrlich benannt', () => {
    const lines = W.summaryLines({
      resolved: { enabled: true, departureAt: '2026-11-17T06:00:00.000Z', targetSocPct: 50, timeZone: 'Europe/Berlin' },
      eos: { optimizeEv: true, registered: true, deadlineSupported: true, valueSupported: false, maxSocPct: 80,
        targets: { minSocPct: 50, minWeekPct: 50, maxSocPct: 100, maxActive: false, steps: null } },
    }).map((l) => l.text);
    assert.ok(lines.some((t) => /Max-Ladestand 80 % wirkt erst mit einem EOS, das Wertstufen kennt/.test(t)), lines.join(' | '));
  });

  it('validate: Ankunft ohne Abfahrt, und eingeschaltet ohne jede Abfahrt', () => {
    assert.match(W.validate([{ day: 3, arrival: '20:00', departure: '' }]), /Mittwoch/);
    assert.match(W.validate([{ day: 1, arrival: '', departure: '' }], { enabled: true }), /mindestens eine Abfahrt/i);
    assert.equal(W.validate([{ day: 1, arrival: '20:00', departure: '05:00' }], { enabled: true }), null);
    // nur eine einmalige Abfahrt, Wochenplan leer: erlaubt (der Server kennt das)
    assert.equal(W.validate([{ day: 1, arrival: '', departure: '' }], { enabled: true, hasOnce: true }), null);
  });

  it('Hinweis: alter Heimweg wird nicht mehr genutzt (Christin 10.11.2026)', () => {
    assert.match(W.legacyCommuteHint(20), /Heimweg \(20 km\).*nicht mehr/);
    assert.match(W.legacyCommuteHint('12.5'), /12,5 km/);
    for (const v of [0, null, undefined, '', 'x', -3]) assert.equal(W.legacyCommuteHint(v), '', String(v));
  });
});
