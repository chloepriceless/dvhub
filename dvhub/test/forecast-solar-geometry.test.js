// test/forecast-solar-geometry.test.js — M13/M13b (Feld 16.11.): Forecast.Solar-Geometrie.
// M13b: Die Gratis-API kennt nur EINE Fläche je Abfrage. Eine real gespreizte Detail-Anlage
// (z. B. String 1 216° SW, String 2 25° NNO) wird daher GANZ aus dem Ensemble genommen
// (kein Fetch, kein Store-Write), statt mit der Geometrie des größten Strings eine verzerrte
// Prognose einzuspeisen. Koplanare Detail-Strings + Simple/Standard laufen wie bisher.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createForecastSolar } from '../services/forecast/forecast-solar.js';

function makeCtx(cfg) {
  const logs = [];
  return {
    ctx: { getCfg: () => cfg, pushLog: (type, data) => logs.push({ type, data }) },
    logs,
  };
}

const noopStore = { writePvForecasts: async () => {} };

async function captureFetch(cfg, store = noopStore) {
  const { ctx, logs } = makeCtx(cfg);
  const orig = global.fetch;
  let seenUrl = null;
  let fetched = false;
  global.fetch = async (url) => {
    fetched = true;
    seenUrl = String(url);
    return { ok: true, json: async () => ({ result: { watts: {}, watt_hours_period: {} } }) };
  };
  let result;
  try {
    const fs = createForecastSolar(ctx, { store });
    result = await fs.fetchForecast();
  } finally {
    global.fetch = orig;
  }
  return { seenUrl, fetched, result, logs };
}

async function captureUrl(cfg) {
  return (await captureFetch(cfg)).seenUrl;
}

test('M13b Detail-Modus gespreizt (216° SW / 25° NNO): kein Abruf, aus dem Ensemble genommen', async () => {
  const writes = [];
  const store = { writePvForecasts: async (rows) => { writes.push(rows); } };
  const cfg = {
    manufacturer: 'sungrow',
    forecast: {
      location: { latitude: 52.5, longitude: 13.4 },
      pv: {
        configLevel: 'detailed',
        totalKwp: 24.2,
        strings: [
          { kwp: 12.32, tiltDeg: 40, azimuthDeg: 216 }, // String 1 (WSW)
          { kwp: 11.88, tiltDeg: 40, azimuthDeg: 25 },  // String 2 (NNO) — stark abweichend
        ],
      },
    },
    sungrow: { secondInverter: { host: '192.168.68.83', pvKwp: 11.88 } },
  };
  const { fetched, result, logs } = await captureFetch(cfg, store);
  assert.equal(fetched, false, 'keine HTTP-Abfrage bei gespreizter Detail-Anlage');
  assert.equal(result, null, 'fetchForecast liefert null → nicht im presentProviders/Ensemble');
  assert.equal(writes.length, 0, 'keine Slots in die DB (Inspector zeigt forecast_solar nicht)');
  assert.ok(logs.some(l => l.type === 'forecast_solar_skip' && l.data?.reason === 'multi_plane_detailed'),
    'skip-Grund multi_plane_detailed geloggt');
});

test('M13b Detail-Modus koplanar (180° / 190°, ein Dach): normal mit größter-String-Geometrie', async () => {
  const cfg = {
    manufacturer: 'sungrow',
    forecast: {
      location: { latitude: 52.5, longitude: 13.4 },
      pv: {
        configLevel: 'detailed',
        totalKwp: 20,
        strings: [
          { kwp: 12, tiltDeg: 35, azimuthDeg: 180 }, // größter String
          { kwp: 8, tiltDeg: 35, azimuthDeg: 190 },
        ],
      },
    },
  };
  const url = await captureUrl(cfg);
  assert.ok(url, 'koplanare Strings werden weiter abgefragt');
  const [, , dec, az, kwp] = url.split('/estimate/')[1].split('/');
  assert.equal(Number(dec), 35);
  assert.equal(Number(az), 0);     // 180 - 180 = Süd (größter String)
  assert.equal(Number(kwp), 20);
});

test('forecast-solar Simple-Modus: Default-Geometrie 35/180 + totalKwp + zweiter WR', async () => {
  const cfg = {
    manufacturer: 'sungrow',
    forecast: {
      location: { latitude: 52.5, longitude: 13.4 },
      pv: { configLevel: 'simple', totalKwp: 12.32 },
    },
    sungrow: { secondInverter: { host: '192.168.68.84', pvKwp: 11.88 } },
  };
  const url = await captureUrl(cfg);
  const [, , dec, az, kwp] = url.split('/estimate/')[1].split('/');
  assert.equal(Number(dec), 35);
  assert.equal(Number(az), 0);     // 180 - 180 = Süd
  assert.equal(Number(kwp), 24.2); // 12,32 + 11,88 (zweiter WR addiert)
});
