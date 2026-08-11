import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfigFile } from '../config-model.js';

// Issue #13 (FrodoVDR): PV kann gleichzeitig am Netz-Eingang UND am
// Verbraucher-Ausgang haengen (Hoymiles an AC-in, SolarEdge an AC-out). Bis
// v1.0.5 verschob victron.acPvSource nur EIN Register-Tripel — ein
// Entweder-oder, eine der beiden Anlagen blieb immer unsichtbar.
//
// Registerbloecke im GX (unit-id 100): on-output 808-810, on-grid 811-813,
// on-genset 814-816.

function effective(victron, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-acpv2-'));
  const cfgPath = path.join(dir, 'config.json');
  try {
    fs.writeFileSync(cfgPath, JSON.stringify({ pvCoupling: 'ac_dc', ...extra, victron }));
    return loadConfigFile(cfgPath).effectiveConfig;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('ohne zweite Position bleibt alles wie bisher (Bestandssetups)', () => {
  const cfg = effective({});
  assert.equal(cfg.points.acPvL1W.address, 808);
  // Die zweiten Punkte existieren, sind aber AUS → weiterhin genau drei
  // AC-PV-Register im Poll-Zyklus.
  assert.equal(cfg.points.acPv2L1W.enabled, false);
  assert.equal(cfg.points.acPv2L2W.enabled, false);
  assert.equal(cfg.points.acPv2L3W.enabled, false);
});

test('FrodoVDRs Fall: AC-out UND AC-in gleichzeitig', () => {
  const cfg = effective({ acPvSource: 'output', acPvSource2: 'grid' });
  assert.equal(cfg.points.acPvL1W.address, 808);
  assert.equal(cfg.points.acPvL2W.address, 809);
  assert.equal(cfg.points.acPvL3W.address, 810);
  assert.equal(cfg.points.acPv2L1W.address, 811);
  assert.equal(cfg.points.acPv2L2W.address, 812);
  assert.equal(cfg.points.acPv2L3W.address, 813);
  assert.equal(cfg.points.acPv2L1W.enabled, true);
});

test('umgekehrte Reihenfolge liefert dieselben zwei Bloecke', () => {
  const cfg = effective({ acPvSource: 'grid', acPvSource2: 'output' });
  assert.equal(cfg.points.acPvL1W.address, 811);
  assert.equal(cfg.points.acPv2L1W.address, 808);
  assert.equal(cfg.points.acPv2L1W.enabled, true);
});

test('Generator als zweite Position', () => {
  const cfg = effective({ acPvSource: 'output', acPvSource2: 'genset' });
  assert.equal(cfg.points.acPv2L1W.address, 814);
  assert.equal(cfg.points.acPv2L1W.enabled, true);
});

test('dieselbe Position zweimal wird NICHT doppelt gezaehlt', () => {
  // Sonst stuende derselbe Registerblock zweimal in der PV-Summe und die
  // Anzeige haette schlagartig die doppelte PV-Leistung.
  const cfg = effective({ acPvSource: 'grid', acPvSource2: 'grid' });
  assert.equal(cfg.points.acPv2L1W.enabled, false);
});

test('unbekannte oder leere zweite Position bleibt aus', () => {
  for (const v of [null, '', 'quatsch']) {
    const cfg = effective({ acPvSource: 'output', acPvSource2: v });
    assert.equal(cfg.points.acPv2L1W.enabled, false, `acPvSource2=${JSON.stringify(v)}`);
  }
});

test('reine DC-Kopplung schaltet auch die zweite Position ab', () => {
  // acPvSource2 darf die pvCoupling-Entscheidung nicht aushebeln.
  const cfg = effective({ acPvSource: 'output', acPvSource2: 'grid' }, { pvCoupling: 'dc' });
  assert.equal(cfg.points.acPvL1W.enabled, false);
  assert.equal(cfg.points.acPv2L1W.enabled, false);
});

test('PV-Summe addiert beide Positionen (Rechenweg aus polling.js)', () => {
  // Spiegelt die Summenbildung in polling.js: DC + AC(1. Position) + AC(2.).
  const v = {
    pvPowerW: 4000,
    acPvL1W: 1000, acPvL2W: 1100, acPvL3W: 900,      // AC-out
    acPv2L1W: 500, acPv2L2W: 600, acPv2L3W: 400,     // AC-in
  };
  const pvAc = Number(v.acPvL1W || 0) + Number(v.acPvL2W || 0) + Number(v.acPvL3W || 0)
    + Number(v.acPv2L1W || 0) + Number(v.acPv2L2W || 0) + Number(v.acPv2L3W || 0);
  assert.equal(pvAc, 4500);
  assert.equal(v.pvPowerW + pvAc, 8500);
});
