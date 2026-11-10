// test/ev-minmax.test.js -- E-Auto Mindest-/Max-Ladestand: JS gegen den Python-Port.
//
// test/fixtures/ev-minmax-golden.json kommt aus eos-bench/ev-minmax/evsim.py
// (gen-ev-minmax-golden.py daneben): gleiche Eingaben → gleiches
// vorausschauendes Mindestziel, gleiches Maximum, gleiche Kostenkurve und
// gleiche Wertstufen.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  propagateMin, futureCostCurve, valueSteps, medianSurplusProfile, deriveEvMinMax, todKey
} from '../services/optimizer/ev-minmax.js';

const golden = JSON.parse(readFileSync(new URL('./fixtures/ev-minmax-golden.json', import.meta.url), 'utf8'));
const TZ = golden.timeZone;

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} ≠ ${b} (±${tol})`);

function common(s) {
  return {
    capacityWh: s.capacityWh, eta: s.eta, chargeW: s.chargeW, timeZone: TZ,
  };
}
function futureOf(s) {
  const ref = s.present ? s.tMs : s.arriveMs;
  return s.trips.filter((x) => x.depMs >= ref && x.depMs > s.tMs);
}

describe('ev-minmax: Golden-Werte aus evsim.py', () => {
  test('Fixture hat alle Lagen', () => {
    assert.ok(golden.scenarios.length >= 10);
  });

  for (const s of golden.scenarios) {
    describe(s.name, () => {
      test('vorausschauendes Mindestziel (propagate_min)', () => {
        close(propagateMin(futureOf(s), common(s)), s.expect.propagated, 1e-9, 'req');
      });

      test('Median-Profil des PV-Überschusses je Viertelstunde', () => {
        const prof = medianSurplusProfile(s.inputs.pastSurplus, TZ);
        for (const [key, v] of Object.entries(s.inputs.pastMedian)) close(prof.get(Number(key)), v, 1e-9, `tod ${key}`);
        assert.equal(prof.size, Object.keys(s.inputs.pastMedian).length);
      });

      test('Kostenkurve (Rückwärts-DP)', () => {
        const top = Math.min(s.expect.maxSocPct, 100);
        const r = futureCostCurve({ ...common(s), ...s.inputs, eMs: s.expect.eMs, topPct: top, trips: s.trips });
        assert.equal(r.grid.length, s.expect.gridLen, 'Rasterlänge');
        assert.equal(r.info.nTrips, s.expect.nTrips);
        close(r.info.impMaxCt, s.expect.impMaxCt, 1e-9, 'imp_max');
        close(r.info.dpCap, s.expect.dpCap, 1e-9, 'dp_cap');
        s.expect.gridSample.forEach((g, k) => close(r.grid[k * 7], g, 1e-9, `grid[${k * 7}]`));
        s.expect.costSample.forEach((c, k) => close(r.cost[k * 7], c, 1e-9, `cost[${k * 7}]`));
        close(r.cost[r.cost.length - 1], s.expect.costTop, 1e-9, 'cost(top)');
      });

      test('Wertstufen (value_steps)', () => {
        const out = valueSteps({
          ...common(s), ...s.inputs, eMs: s.expect.eMs, sEPct: s.expect.minSocPct, maxPct: s.expect.maxSocPct,
          trips: s.trips, marginCt: s.marginCt
        });
        assert.equal(out.steps.length, s.expect.steps.length, JSON.stringify(out.steps));
        out.steps.forEach(([soc, v], k) => {
          close(soc, s.expect.steps[k][0], 1e-9, `soc[${k}]`);
          close(v, s.expect.steps[k][1], 1.01e-5, `wert[${k}]`);
        });
        assert.equal(out.info.reason ?? null, s.expect.valueReason ?? null);
        if (s.expect.cSe !== null && s.expect.cSe !== undefined) close(out.info.cSe, s.expect.cSe, 1.01e-3, 'C(s_e)');
      });

      test('EOS-Parameter je Lauf (min, max, Start-SoC abgerundet, Frist, E)', () => {
        const d = deriveEvMinMax({
          ...common(s), nowMs: s.tMs, refMs: s.present ? s.tMs : s.arriveMs, trips: s.trips,
          maxSocPct: s.maxSocPct, socPct: s.socNowPct, ctrlEndMs: s.ctrlEndMs, propagate: true
        });
        assert.equal(d.minSocPct, s.expect.minSocPct);
        assert.equal(d.maxSocPct, s.expect.maxSocPct);
        assert.equal(d.initialSocPct, s.expect.initialSocPct);
        assert.equal(d.deadlineMs, s.expect.deadlineMs);
        assert.equal(d.eMs, s.expect.eMs);
      });
    });
  }
});

describe('ev-minmax: Randfälle', () => {
  const base = { capacityWh: 75000, eta: 0.88, chargeW: 11000, timeZone: TZ };

  test('ohne Fahrten: Mindestziel 0, keine Wertstufen', () => {
    assert.equal(propagateMin([], base), 0);
  });

  test('Start-SoC wird abgerundet, nie aufgerundet (Rundungsschwäche aus der Simulation)', () => {
    const t = Date.parse('2026-11-16T19:00:00Z');
    const trips = [{ depMs: t + 12 * 3600_000, retMs: t + 22 * 3600_000, tripPct: 20, minPct: 50 }];
    const d = deriveEvMinMax({ ...base, nowMs: t, refMs: t, trips, maxSocPct: 80, socPct: 49.99, ctrlEndMs: t + 24 * 3600_000, propagate: true });
    assert.equal(d.initialSocPct, 49);
    assert.equal(d.minSocPct, 50);
  });

  test('Mindestziel über dem Max-Ladestand: Max steigt mit (Einmal-Ziel gewinnt)', () => {
    const t = Date.parse('2026-11-16T19:00:00Z');
    const trips = [{ depMs: t + 12 * 3600_000, retMs: t + 22 * 3600_000, tripPct: 40, minPct: 90 }];
    const d = deriveEvMinMax({ ...base, nowMs: t, refMs: t, trips, maxSocPct: 80, socPct: 30, ctrlEndMs: t + 24 * 3600_000, propagate: true });
    assert.equal(d.minSocPct, 90);
    assert.equal(d.maxSocPct, 90);
  });

  test('ohne Max-Ladestand: Max 100 wie bisher', () => {
    const t = Date.parse('2026-11-16T19:00:00Z');
    const trips = [{ depMs: t + 12 * 3600_000, retMs: t + 22 * 3600_000, tripPct: 40, minPct: 50 }];
    const d = deriveEvMinMax({ ...base, nowMs: t, refMs: t, trips, maxSocPct: null, socPct: 30, ctrlEndMs: t + 24 * 3600_000, propagate: true });
    assert.equal(d.maxSocPct, 100);
    assert.equal(d.valueActive, false);
  });

  test('Vorausschau 8 Tage: eine Fahrt dahinter zählt nicht', () => {
    const t = Date.parse('2026-11-16T19:00:00Z');
    const day = 24 * 3600_000;
    const trips = [
      { depMs: t + 12 * 3600_000, retMs: t + 12 * 3600_000, tripPct: 0, minPct: 30 },
      { depMs: t + 12 * 3600_000 + 9 * day, retMs: t + 9 * day + 13 * 3600_000, tripPct: 0, minPct: 100 },
    ];
    // 1,4 kW wären zu wenig für 70 Punkte in 9 Tagen? Nein — aber außerhalb von 8 Tagen zählt sie gar nicht.
    assert.equal(propagateMin(trips, { ...base, chargeW: 100 }), 30);
  });

  test('Viertelstunde in Ortszeit (Winter: UTC+1)', () => {
    assert.equal(todKey(Date.parse('2026-11-16T06:15:00Z'), TZ), 7 * 4 + 1);
  });
});
