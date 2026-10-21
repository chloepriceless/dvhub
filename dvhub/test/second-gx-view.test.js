// test/second-gx-view.test.js -- Leitstand-Kachel „Zweite Anlage“ (Chrissi
// 21.10.2026: „im Leitstand sollte die zweite Anlage auch auftauchen“).
// Reine Anzeige-Logik aus public/second-gx-view.js, geladen wie im Browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function load() {
  const file = fileURLToPath(new URL('../public/second-gx-view.js', import.meta.url));
  const sandbox = { window: {}, document: undefined };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: 'second-gx-view.js' });
  return sandbox.window.DVhubSecondGx;
}

const base = { enabled: true, online: true, socPct: 62, batteryPowerW: -1658, minSocPct: 15, setpointW: -1650,
  desiredBatteryW: -1895, sharePct: 47.4, totalBatteryW: -4000, reason: 'deadband' };

test('aus oder ohne Daten: Kachel versteckt', () => {
  const { view } = load();
  assert.equal(view(null).hidden, true);
  assert.equal(view({ enabled: false, reason: 'disabled' }).hidden, true);
});

test('online: Ladestand, Akkuleistung, Anteil, Sollwert, Zustand', () => {
  const v = load().view(base);
  assert.equal(v.hidden, false);
  assert.equal(v.soc, '62 %');
  assert.equal(v.socPct, 62);
  assert.equal(v.battery, '-1658 W');
  assert.equal(v.share, '47 % von -4000 W');
  assert.equal(v.setpoint, '-1650 W');
  assert.equal(v.minSoc, '15 %');
  assert.deepEqual([v.state, v.tone], ['Entlädt', 'ok']);
});

test('Zustände: laden, ruhig, Not-Halt, Einspeisung gesperrt, offline, keine Messwerte', () => {
  const { view } = load();
  assert.deepEqual(pick(view({ ...base, batteryPowerW: 2100 })), ['Lädt', 'info']);
  assert.deepEqual(pick(view({ ...base, batteryPowerW: 20 })), ['Ruht', '']);
  assert.deepEqual(pick(view({ ...base, reason: 'stop' })), ['Not-Halt', 'danger']);
  assert.deepEqual(pick(view({ ...base, reason: 'export_blocked', batteryPowerW: 0 })), ['Einspeisung gesperrt', 'warn']);
  assert.deepEqual(pick(view({ ...base, online: false, socPct: null, batteryPowerW: null, reason: 'follower_offline' })), ['Nicht erreichbar', 'danger']);
  assert.deepEqual(pick(view({ ...base, reason: 'no_data' })), ['Keine Messwerte', 'warn']);
});

test('offline: Werte als Strich, kein „null W“', () => {
  const v = load().view({ ...base, online: false, socPct: null, batteryPowerW: null, sharePct: null, totalBatteryW: null, reason: 'follower_offline' });
  assert.equal(v.soc, '–');
  assert.equal(v.socPct, null);
  assert.equal(v.battery, '–');
  assert.equal(v.share, '–');
});

function pick(v) { return [v.state, v.tone]; }
