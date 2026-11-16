// Befund 1.4-1 (Christin 16.11.2026): Bei ZWEI konfigurierten Wechselrichtern wird OHNE ausdrückliche Wahl
// Forced-Split wirksam. Vorher stand der Config-Standard sungrow.controlMode fest auf 'external' und landete in der
// wirksamen Config — die Zwei-WR-Automatik in resolveSungrowControl (twoWr → forced) kam nie zum Zug, eine
// Zwei-WR-Anlage fuhr External EMS (Slave 0 W). Fix: Standard 'auto', die Zahl der WR entscheidet.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultConfig } from '../config-model.js';
import { resolveSungrowControl as resolveDirect, EMS_MODE } from '../services/inverter/sungrow.js';
import { loadSungrowConfig } from './helpers/sungrow-fixture.js';

test('createDefaultConfig: Sungrow-Standard controlMode ist jetzt "auto" (nicht fest "external")', () => {
  const cfg = createDefaultConfig();
  assert.equal(cfg.sungrow.controlMode, 'auto');
});

test('Zwei WR ohne ausdrückliche Wahl → Forced-Split wirksam', () => {
  // secondInverter.host gesetzt, KEIN controlMode in persisted → Default 'auto' wird gemergt.
  const cfg = loadSungrowConfig({ sungrow: { secondInverter: { host: '192.0.2.83' } } });
  assert.equal(cfg.sungrow.controlMode, 'auto', 'die wirksame Config trägt den Auto-Standard, nicht "external"');
  const ctl = resolveDirect(cfg);
  assert.equal(ctl.mode, 'forced');
  assert.equal(ctl.modeValue, EMS_MODE.FORCED);
});

test('Ein WR ohne ausdrückliche Wahl bleibt External EMS (unberührt)', () => {
  const cfg = loadSungrowConfig();
  assert.equal(cfg.sungrow.controlMode, 'auto');
  const ctl = resolveDirect(cfg);
  assert.equal(ctl.mode, 'external');
  assert.equal(ctl.modeValue, EMS_MODE.EXTERNAL);
});

test('Ausdrückliche Wahl gewinnt: external trotz zwei WR (master-only), forced bei einem WR', () => {
  const twoWrExternal = loadSungrowConfig({ sungrow: { controlMode: 'external', secondInverter: { host: '192.0.2.83' } } });
  assert.equal(resolveDirect(twoWrExternal).mode, 'external', 'ausdrückliches external gewinnt gegen die Automatik');

  const oneWrForced = loadSungrowConfig({ sungrow: { controlMode: 'forced' } });
  assert.equal(resolveDirect(oneWrForced).mode, 'forced');
});
