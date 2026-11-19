// test/grid-share-cap-m21.test.js — M21 (Feld 19.11.2026): der Netzstrom-Anteil
// im Akku war größer als der Akku-Inhalt und blieb es.
//
// Felddaten:
//   - Sungrow: gridKwh 0,926 bei storedKwh 0,77 (SoC real 14,99 %, Boden 11 %,
//     Kapazität 19 290 Wh), sharePct 100.
//   - Nebeling: 1,875 bei 1,0 (100 kWh, ganzzahliger SoC, lange „unsicher“).
// Ursache: Obergrenze war (Ladestand + 1 %) × Kapazität, gekappt erst nach 60 s
// darunter. Der Rest (Ladeverluste, nicht abgebuchte Entladung aus einer
// unsicheren Phase) blieb als Netzstrom stehen und hielt die Sperre.
// Entscheidung Christin 19.11.2026: „m21 bitte wie im feld gemessen“ — nach
// jedem Abgleich gridWh = min(gridWh, storedWh), der Überschuss ist Verlust.
// Keine Reserve, keine Wartezeit. Gekappt wird nur mit sicherem Ladestand und
// bekannter Kapazität.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  GRID_SHARE_STATE_FILE,
  GRID_SHARE_RELEASE_WH,
  stepGridShare,
  createGridShareTracker,
} from '../services/optimizer/grid-share.js';

const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-grid-share-m21-'));
const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
const lockedCfg = () => ({ optimizer: { allowGridCharge: true, gridChargeWithoutMispel: true }, schedule: { timezone: 'Europe/Berlin' } });

/** Zähler mit gespeichertem Feldstand (Neustart auf der Anlage). */
function trackerWith(dir, gridWh, logs = []) {
  fs.writeFileSync(path.join(dir, GRID_SHARE_STATE_FILE), JSON.stringify({ version: 1, gridWh, locked: true }) + '\n');
  return createGridShareTracker({ getCfg: lockedCfg, pushLog: (e, d, l) => logs.push({ e, d, l }), dataDir: dir });
}

// Sungrow-Feldfall: SoC real 14,99 %, Boden 11 %, 19 290 Wh → Inhalt über dem Boden 769,67 Wh.
const SUNGROW = { socPct: 14.99, floorPct: 11, capacityWh: 19_290 };
const SUNGROW_STORED_WH = (14.99 - 11) / 100 * 19_290;

test('stepGridShare: gekappt wird sofort auf den Inhalt über dem Boden, der Überschuss ist Verlust', () => {
  const r = stepGridShare(926, { dtMs: 0, ...SUNGROW });
  near(r.gridWh, SUNGROW_STORED_WH);
  near(r.lossWh, 926 - SUNGROW_STORED_WH);
  near(r.storedWh, SUNGROW_STORED_WH);
  assert.equal(r.share, 1);
});

test('stepGridShare: ohne Ladestand oder ohne Kapazität keine Kappung am Inhalt', () => {
  const noSoc = stepGridShare(926, { dtMs: 0, ...SUNGROW, socPct: null });
  near(noSoc.gridWh, 926);
  assert.equal(noSoc.lossWh, 0);
  const noCap = stepGridShare(926, { dtMs: 0, ...SUNGROW, capacityWh: null });
  near(noCap.gridWh, 926);
  assert.equal(noCap.lossWh, 0);
});

test('M21 Sungrow-Feld: 0,926 kWh bei 0,77 kWh Inhalt → beim ersten Abgleich 0,77, Rest als Verlust, Sperre bleibt', () => {
  const dir = mkDir();
  try {
    const logs = [];
    const t = trackerWith(dir, 926, logs);
    t.tick({ nowMs: Date.parse('2026-11-19T09:00:00Z'), victron: { batteryChargeW: 0 }, ...SUNGROW });
    const sum = t.summary();
    near(sum.gridWh, SUNGROW_STORED_WH);
    assert.ok(sum.gridKwh <= sum.storedKwh, `gridKwh ${sum.gridKwh} ≤ storedKwh ${sum.storedKwh}`);
    assert.equal(sum.sharePct, 100);
    near(sum.today.lossFromGridKwh, (926 - SUNGROW_STORED_WH) / 1000, 0.001);
    assert.equal(t.isLocked(), true, 'der ganze Inhalt ist Netzstrom — die Sperre bleibt');
    const capped = logs.filter((l) => l.e === 'grid_share_capped');
    assert.equal(capped.length, 1, 'spürbare Kappung steht im Protokoll');
    near(capped[0].d.lostKwh, 0.156, 0.001);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M21 Nebeling-Feld: 1,875 kWh bei 1,0 kWh — unsicherer Ladestand kappt nicht, der erste sichere Wert kappt auf 1,0', () => {
  const dir = mkDir();
  try {
    const t = trackerWith(dir, 1_875);
    const t0 = Date.parse('2026-11-19T03:00:00Z');
    const p = { socPct: 11, floorPct: 10, capacityWh: 100_000 };
    for (let s = 0; s <= 600; s += 10) {
      const n = t0 + s * 1_000;
      t.tick({ nowMs: n, victron: { fieldUpdatedAt: { batteryPowerW: n, soc: n - 120_000 } }, ...p });
    }
    near(t.summary().gridWh, 1_875);
    assert.equal(t.summary().today.lossFromGridKwh, 0, 'unsicher: nichts gekappt');
    const n = t0 + 610_000;
    t.tick({ nowMs: n, victron: { fieldUpdatedAt: { batteryPowerW: n, soc: n } }, ...p });
    near(t.summary().gridWh, 1_000);
    assert.ok(t.summary().gridKwh <= t.summary().storedKwh);
    near(t.summary().today.lossFromGridKwh, 0.875, 0.001);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M21 Sperre fällt, sobald der Inhalt unter releaseWh liegt (Netzstrom-Akku entlädt ins Haus)', () => {
  const dir = mkDir();
  try {
    const t = trackerWith(dir, 926);
    const t0 = Date.parse('2026-11-19T18:00:00Z');
    t.tick({ nowMs: t0, victron: {}, ...SUNGROW });
    assert.equal(t.isLocked(), true);
    // 1 kW ins Haus, der Ladestand sinkt mit: 1 kW × 10 s = 2,78 Wh ≈ 0,0144 % von 19 290 Wh.
    let soc = 14.99;
    let s = 0;
    while ((soc - 11) / 100 * 19_290 >= GRID_SHARE_RELEASE_WH) {
      s += 10;
      soc -= 1_000 * 10 / 3_600 / 19_290 * 100;
      t.tick({ nowMs: t0 + s * 1_000, victron: { batteryDirectUseW: 1_000 }, ...SUNGROW, socPct: soc });
    }
    assert.ok(t.summary().gridWh < GRID_SHARE_RELEASE_WH, `${t.summary().gridWh}`);
    assert.equal(t.isLocked(), false, 'Inhalt unter 50 Wh → Netzanteil darunter → Sperre frei');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M21 Ladestand auf den Boden: Netzanteil sofort 0, Sperre fällt, Kachel-Hinweis (floorResetAt)', () => {
  const dir = mkDir();
  try {
    const logs = [];
    const t = trackerWith(dir, 926, logs);
    const n = Date.parse('2026-11-19T21:00:00Z');
    t.tick({ nowMs: n, victron: {}, ...SUNGROW, socPct: 11 });
    near(t.summary().gridWh, 0);
    assert.equal(t.isLocked(), false);
    assert.equal(t.summary().floorResetAt, new Date(n).toISOString());
    assert.equal(logs.filter((l) => l.e === 'grid_share_floor_reset').length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M21 ohne Akkukapazität: keine Kappung am Inhalt', () => {
  const dir = mkDir();
  try {
    const t = trackerWith(dir, 926);
    t.tick({ nowMs: Date.parse('2026-11-19T09:00:00Z'), victron: {}, socPct: 14.99, floorPct: 11, capacityWh: null, capacityMissing: true });
    near(t.summary().gridWh, 926);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
