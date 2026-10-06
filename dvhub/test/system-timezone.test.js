import test from 'node:test';
import assert from 'node:assert/strict';
import { applySystemTimeZone, isUsableTimeZone } from '../services/system-timezone.js';

test('Zeitzone aus den Einstellungen gilt für Prozess, Börsenpreise und EOS', () => {
  const env = { TZ: 'UTC' };
  const cfg = { schedule: { timezone: 'Europe/Berlin' }, epex: { timezone: 'UTC' }, optimizer: {} };
  assert.deepEqual(applySystemTimeZone(cfg, env), { timeZone: 'Europe/Berlin', changed: true, previous: 'UTC' });
  assert.equal(env.TZ, 'Europe/Berlin');
  assert.equal(cfg.epex.timezone, 'Europe/Berlin');
  assert.equal(cfg.optimizer.timezone, 'Europe/Berlin');
  assert.equal(applySystemTimeZone(cfg, env).changed, false);
});

test('System ohne Zeitzone, ungültige oder fehlende Einstellung → Europe/Berlin', () => {
  const env = {};
  assert.equal(applySystemTimeZone({ schedule: { timezone: 'Europe/Berln' } }, env).timeZone, 'Europe/Berlin');
  assert.equal(env.TZ, 'Europe/Berlin');
  assert.equal(applySystemTimeZone({}, {}).timeZone, 'Europe/Berlin');
  assert.equal(isUsableTimeZone(''), false);
  assert.equal(isUsableTimeZone('America/New_York'), true);
});

test('die Uhr des Prozesses folgt der Einstellung sofort', () => {
  const before = process.env.TZ;
  try {
    const at = new Date('2026-07-01T10:00:00Z');
    applySystemTimeZone({ schedule: { timezone: 'UTC' } });
    assert.equal(at.getHours(), 10);
    applySystemTimeZone({ schedule: { timezone: 'Europe/Berlin' } });
    assert.equal(at.getHours(), 12, 'Sommerzeit: zwei Stunden vor UTC');
    applySystemTimeZone({ schedule: { timezone: 'America/New_York' } });
    assert.equal(at.getHours(), 6);
  } finally {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  }
});
