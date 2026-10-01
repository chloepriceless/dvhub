import test from 'node:test';
import assert from 'node:assert/strict';
import { fitInverterCurve, curveWindow, etaAt, CURVE_MIN_DAYS } from '../services/inverter-efficiency/curve.js';
import { createInverterCurveCalibrator, effectiveInverterCurve } from '../services/inverter-efficiency/calibrator.js';
import { buildEosInverters } from '../services/optimizer/eos-config-sync.js';

const PNOM = 24000;
// Realistische Anlage: η je Bin, mittlere AC-Leistung je Bin.
const PROFILE = [
  { bin: 0, w: 600, eta: 0.80 }, { bin: 2, w: 1100, eta: 0.90 }, { bin: 4, w: 1600, eta: 0.93 },
  { bin: 9, w: 4000, eta: 0.93 }, { bin: 14, w: 13000, eta: 0.91 }, { bin: 17, w: 22000, eta: 0.885 },
];
function rows(days, { start = '2026-06-01', secondsPerBin = 600 } = {}) {
  const out = [];
  const t0 = Date.parse(`${start}T00:00:00Z`);
  for (let d = 0; d < days; d++) {
    const day = new Date(t0 + d * 86_400_000).toISOString().slice(0, 10);
    for (const p of PROFILE) {
      const ac = p.w * secondsPerBin / 3600;
      out.push({ day, bin: p.bin, ac_wh: ac, dc_wh: ac / p.eta, seconds: secondsPerBin });
    }
  }
  return out;
}

test('Kurve: Stützstellen und Referenz-η aus den Bins', () => {
  const fit = fitInverterCurve(rows(30), { pnomW: PNOM });
  assert.equal(fit.status, 'ok');
  assert.deepEqual(fit.points, [[0.025, 0.8], [0.0458, 0.9], [0.0667, 0.93], [0.1667, 0.93], [0.5417, 0.91], [0.9167, 0.885]]);
  assert.equal(fit.days, 30);
  assert.ok(fit.referenceEta > 0.88 && fit.referenceEta < 0.93);
});

test('Kurve: idempotent — gleiche Daten in anderer Reihenfolge, gleiches Ergebnis', () => {
  const a = rows(40);
  const b = [...a].reverse();
  const shuffled = a.map((x, i) => a[(i * 7919) % a.length]);
  assert.equal(new Set(shuffled.map((x) => `${x.day}|${x.bin}`)).size, a.length, 'Permutation');
  const fa = fitInverterCurve(a, { pnomW: PNOM });
  assert.deepEqual(fitInverterCurve(b, { pnomW: PNOM }), fa);
  assert.deepEqual(fitInverterCurve(shuffled, { pnomW: PNOM }), fa);
  assert.deepEqual(fitInverterCurve(a, { pnomW: PNOM }), fa);
  assert.match(fa.curveHash, /^[0-9a-f]{16}$/);
});

test('Kurve: erst nach der Betriebsphase freigegeben', () => {
  const early = fitInverterCurve(rows(CURVE_MIN_DAYS - 1), { pnomW: PNOM });
  assert.equal(early.status, 'insufficient_data');
  assert.equal(early.curveHash, null);
  assert.match(early.reason, /Tagen/);
  assert.equal(fitInverterCurve(rows(CURVE_MIN_DAYS), { pnomW: PNOM }).status, 'ok');
});

test('Kurve: Fenster schneidet ältere Tage ab', () => {
  const all = rows(200, { start: '2026-01-01' });
  const w = curveWindow('2026-07-19');
  assert.deepEqual(w, { from: '2026-01-21', to: '2026-07-19' });
  const fit = fitInverterCurve(all, { pnomW: PNOM, window: w });
  assert.equal(fit.days, 180);
});

test('Kurve: Last aus dem Akku abgeleitet (η≈1) → nicht messbar, nicht angewendet', () => {
  const r = rows(30).map((x) => ({ ...x, dc_wh: x.ac_wh }));
  const fit = fitInverterCurve(r, { pnomW: PNOM });
  assert.equal(fit.status, 'not_measurable');
  assert.equal(effectiveInverterCurve({}, fit), null);
});

test('etaAt interpoliert linear und hält die Enden', () => {
  const p = [[0.02, 0.8], [0.06, 0.92], [1, 0.88]];
  assert.equal(etaAt(p, 0), 0.8);
  assert.ok(Math.abs(etaAt(p, 0.04) - 0.86) < 1e-9);
  assert.equal(etaAt(p, 2), 0.88);
});

test('EOS-Wechselrichter: ohne Kurve 1.0, mit freigegebener Kurve Referenz-η, abschaltbar', () => {
  const cfg = { optimizer: { inverterMaxPowerW: PNOM } };
  assert.equal(buildEosInverters(cfg)[0].dc_to_ac_efficiency, 1.0);
  const fit = fitInverterCurve(rows(30), { pnomW: PNOM });
  const inv = buildEosInverters(cfg, { curve: effectiveInverterCurve(cfg, fit) })[0];
  assert.equal(inv.dc_to_ac_efficiency, fit.referenceEta);
  assert.equal(inv.ac_to_dc_efficiency, 1.0);
  const off = { optimizer: { ...cfg.optimizer, inverterEfficiencyAuto: false } };
  assert.equal(buildEosInverters(off, { curve: effectiveInverterCurve(off, fit) })[0].dc_to_ac_efficiency, 1.0);
});

test('Kalibrator: meldet nur echte Änderungen, überlebt Neustart über die Datei', async () => {
  const files = new Map();
  const fsImpl = {
    existsSync: (p) => files.has(p), readFileSync: (p) => files.get(p),
    writeFileSync: (p, c) => files.set(p, c), renameSync: (a, b) => { files.set(b, files.get(a)); files.delete(a); },
  };
  let data = rows(30, { start: '2026-08-01' });
  const db = { query: async (_sql, [from, to]) => ({ rows: data.filter((x) => x.day >= from && x.day <= to) }) };
  let applied = 0;
  const mk = () => createInverterCurveCalibrator({ getDb: () => db, getCfg: () => ({ optimizer: { inverterMaxPowerW: PNOM } }), filePath: '/x/curve.json', fsImpl, onChange: () => { applied++; } });
  const c1 = mk();
  const now = new Date('2026-09-05T10:00:00Z');
  assert.equal((await c1.refresh({ now })).changed, true);
  assert.equal((await c1.refresh({ now })).changed, false, 'gleiche Daten → keine Änderung');
  assert.equal(applied, 1);
  const c2 = mk();
  assert.equal(c2.get().curveHash, c1.get().curveHash, 'nach Neustart aus Datei');
  assert.equal((await c2.refresh({ now })).changed, false);
  data = [...data, ...rows(1, { start: '2026-08-31' }).map((x) => ({ ...x, dc_wh: x.dc_wh * 1.2 }))];
  assert.equal((await c2.refresh({ now })).changed, true);
});
