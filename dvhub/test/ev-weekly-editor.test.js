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
  it('ohne Heimweg-Spalte (Kachel) bleiben die Heimweg-km je Tag erhalten', () => {
    const rendered = [{ day: 1, arrival: '20:00', departure: '05:00', targetValue: null, commuteKm: 40 }];
    const read = [{ day: 1, arrival: '19:30', departure: '05:00', targetValue: 90, commuteKm: null }, { day: 2, arrival: '', departure: '', targetValue: null, commuteKm: null }];
    const out = W.keepHidden(read, rendered, { showKm: false });
    assert.equal(out[0].commuteKm, 40);
    assert.equal(out[0].arrival, '19:30');
    assert.equal(out[0].targetValue, 90);
    assert.equal(out[1].commuteKm, null);
    // mit Spalte gilt, was im Feld steht
    assert.equal(W.keepHidden(read, rendered, { showKm: true })[0].commuteKm, null);
  });

  it('validate: Ankunft ohne Abfahrt, und eingeschaltet ohne jede Abfahrt', () => {
    assert.match(W.validate([{ day: 3, arrival: '20:00', departure: '' }]), /Mittwoch/);
    assert.match(W.validate([{ day: 1, arrival: '', departure: '' }], { enabled: true }), /mindestens eine Abfahrt/i);
    assert.equal(W.validate([{ day: 1, arrival: '20:00', departure: '05:00' }], { enabled: true }), null);
    // nur eine einmalige Abfahrt, Wochenplan leer: erlaubt (der Server kennt das)
    assert.equal(W.validate([{ day: 1, arrival: '', departure: '' }], { enabled: true, hasOnce: true }), null);
  });
});
