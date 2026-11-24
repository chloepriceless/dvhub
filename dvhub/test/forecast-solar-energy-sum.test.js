// test/forecast-solar-energy-sum.test.js — M13b Bug A (Feld 16.11.):
// Forecast.Solar zeigte 227,8 kWh bei 2,6 kW Peak (Open-Meteo 3,4 / Ensemble 9,8).
// Zwei Ursachen:
//   (1) forecast-solar.js speicherte `watt_hours_period` (ENERGIE, Wh) ins
//       `power_w`-Feld (LEISTUNG). Jetzt wird `result.watts` (mittlere Leistung) gelesen.
//   (2) Der Inspector-Forward-Fill leitete die Sub-Slot-Zahl aus dem ERSTEN Abstand ab.
//       Bei daylight-only-Daten mit einem großen führenden Nacht-Abstand (z. B.
//       00:00-Nullslot → Sonnenaufgang) wurde JEDER Stundenwert vielfach repliziert,
//       und die Energie-Summe (power_w × Δt) explodierte. Jetzt: Median-Abstand + Deckel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createForecastSolar } from '../services/forecast/forecast-solar.js';
import { createInspector } from '../services/forecast/inspector.js';

// Leitstand-Energie: power_w × Δt (wie providerForecastEnergyKwh in leitstand-charts.js).
function energyKwh(slots) {
  const s = slots.slice().sort((a, b) => new Date(a.ts_utc) - new Date(b.ts_utc));
  let kwh = 0;
  for (let i = 0; i < s.length; i++) {
    const w = Number(s[i].power_w) || 0;
    let dtH;
    if (i < s.length - 1) dtH = (new Date(s[i + 1].ts_utc) - new Date(s[i].ts_utc)) / 3600000;
    else if (i > 0) dtH = (new Date(s[i].ts_utc) - new Date(s[i - 1].ts_utc)) / 3600000;
    else dtH = 0.25;
    if (!isFinite(dtH) || dtH <= 0 || dtH > 1) dtH = 0.25;
    kwh += w * dtH / 1000;
  }
  return kwh;
}

// Wolkiger Novembertag, 24,2 kWp, Peak ~2,6 kW, ~13,3 kWh/Tag.
const HOURLY = { '07': 50, '08': 300, '09': 900, '10': 1600, '11': 2200, '12': 2600, '13': 2400, '14': 1800, '15': 1000, '16': 400, '17': 80 };
function dayWatts(dateStr) {
  const out = {};
  for (const [h, v] of Object.entries(HOURLY)) out[`${dateStr} ${h}:00:00`] = v;
  return out;
}

test('Bug A unit: forecast-solar liest Leistung aus result.watts (nicht Energie)', async () => {
  const written = [];
  const store = { writePvForecasts: async (rows) => { written.push(...rows); } };
  const ctx = { getCfg: () => ({ forecast: { location: { latitude: 52.5, longitude: 13.4 }, pv: { totalKwp: 24.2 } } }), pushLog: () => {} };
  const orig = global.fetch;
  // watts = echte Leistung; watt_hours_period bewusst ANDERS (×10), damit ein
  // Rückfall auf das alte Energie-Feld auffliegt.
  const watts = dayWatts('2026-11-16');
  const whWrong = Object.fromEntries(Object.entries(watts).map(([k, v]) => [k, v * 10]));
  global.fetch = async () => ({ ok: true, json: async () => ({ result: { watts, watt_hours_period: whWrong } }) });
  let slots;
  try {
    slots = await createForecastSolar(ctx, { store }).fetchForecast();
  } finally { global.fetch = orig; }
  const peak = Math.max(...slots.map(s => s.power_w));
  assert.equal(peak, 2600, 'Peak-Leistung = watts-Maximum, nicht das 10x-Energiefeld');
});

test('Bug A regression: Inspector-Forward-Fill explodiert nicht bei großem führenden Nacht-Abstand', async () => {
  // DB-Rows: führender Nacht-Nullslot 00:00, dann erst ab 07:00 — großer erster Abstand.
  const watts = { '2026-11-16 00:00:00': 0, ...dayWatts('2026-11-16'), ...dayWatts('2026-11-17') };
  const rows = Object.entries(watts).map(([timeStr, w]) => ({
    ts_utc: new Date(timeStr).toISOString(), model: 'forecast_solar', power_w: w, confidence: 0.7,
    fetched_at: new Date('2026-11-16T06:00:00Z'),
  }));
  const store = { getLatestPvForecast: async () => rows };
  const inspector = createInspector(
    { state: { forecast: { pv: { ensembleWeights: null } } }, getCfg: () => ({}), pushLog: () => {} },
    { store }
  );
  const out = await inspector.getPvProviders({ from: '2026-11-16T00:00:00Z', to: '2026-11-18T00:00:00Z' });
  const kwh = energyKwh(out.providers.forecast_solar);
  const realKwh = Object.values(HOURLY).reduce((a, b) => a + b, 0) / 1000 * 2; // 2 Tage
  // Vor dem Fix ~93 kWh (7x). Jetzt muss die Summe nahe der echten Energie liegen.
  assert.ok(kwh < realKwh * 1.2, `Energie plausibel (${kwh.toFixed(1)} kWh, erwartet ~${realKwh.toFixed(1)})`);
  assert.ok(kwh > realKwh * 0.8, `Energie nicht zu klein (${kwh.toFixed(1)} kWh)`);
  // Peak bleibt korrekt (Forward-Fill kopiert nur, inflationiert die Leistung nie).
  const peak = Math.max(...out.providers.forecast_solar.map(s => s.power_w));
  assert.equal(peak, 2600);
});
