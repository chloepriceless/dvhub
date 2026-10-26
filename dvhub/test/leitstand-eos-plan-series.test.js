// test/leitstand-eos-plan-series.test.js — EOS-Fahrplan im Leitstand zeigt auch
// den geplanten Lastgang (Issue #27, 26.10.2026): Netzbezug und Last kommen zu
// PV, Einspeisung und Akku-SoC dazu. Wh je Slot → mittlere kW des Slots.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const src = fs.readFileSync(path.resolve(import.meta.dirname, '../public/leitstand-charts.js'), 'utf8');

function helpers() {
  const sandbox = {
    console, Date, Math, Number, JSON, Intl, Set, Map,
    document: { readyState: 'loading', addEventListener() {}, getElementById: () => null },
    window: {},
    setInterval() {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, sandbox, { filename: 'leitstand-charts.js' });
  return sandbox.window.DVhubLeitstand;
}

const T = Date.UTC(2026, 9, 26, 13, 0);
const plain = (pts) => Array.from(pts, (p) => ({ x: p.x, y: p.y })); // aus dem vm-Kontext lösen

test('15-min-Plan: Netzbezug und Last in kW (Wh ÷ 0,25 h ÷ 1000)', () => {
  const { eosPlanSeries } = helpers();
  const s = eosPlanSeries({
    slotMinutes: 15,
    rows: [
      { ts_utc: new Date(T).toISOString(), socPct: 50, pvWh: 1000, loadWh: 400, gridConsumptionWh: 0, gridFeedinWh: 600 },
      { ts_utc: new Date(T + 900000).toISOString(), socPct: 49, pvWh: 0, loadWh: 500, gridConsumptionWh: 250, gridFeedinWh: null },
    ],
  });
  assert.deepEqual(plain(s.import), [{ x: T, y: 0 }, { x: T + 900000, y: 1 }]);
  assert.deepEqual(plain(s.load), [{ x: T, y: 1.6 }, { x: T + 900000, y: 2 }]);
  assert.deepEqual(plain(s.feed), [{ x: T, y: 2.4 }, { x: T + 900000, y: null }]); // null = Lücke, nicht 0
  assert.deepEqual(plain(s.pv), [{ x: T, y: 4 }, { x: T + 900000, y: 0 }]);
  assert.deepEqual(plain(s.soc), [{ x: T, y: 50 }, { x: T + 900000, y: 49 }]);
});

test('60-min-Plan: Wh je Stunde = W; fehlender Wert bleibt eine Lücke', () => {
  const { eosPlanSeries } = helpers();
  const s = eosPlanSeries({
    slotMinutes: 60,
    rows: [
      { ts_utc: new Date(T).toISOString(), loadWh: 1500, gridConsumptionWh: 3000 },
      { ts_utc: new Date(T + 3600000).toISOString(), loadWh: null, gridConsumptionWh: null },
    ],
  });
  assert.deepEqual(plain(s.import), [{ x: T, y: 3 }, { x: T + 3600000, y: null }]);
  assert.deepEqual(plain(s.load), [{ x: T, y: 1.5 }, { x: T + 3600000, y: null }]);
});
