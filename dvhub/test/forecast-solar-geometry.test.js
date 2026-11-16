// test/forecast-solar-geometry.test.js — M13 (Feld 16.11.): Forecast.Solar-Abfrage nutzt im
// Detail-Modus die Geometrie des GRÖSSTEN Strings (nicht mehr starr 35°/180°) und die
// effektive Gesamt-kWp OHNE Doppelzählung des zweiten WR.
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

async function captureUrl(cfg) {
  const { ctx } = makeCtx(cfg);
  const orig = global.fetch;
  let seenUrl = null;
  global.fetch = async (url) => {
    seenUrl = String(url);
    return { ok: true, json: async () => ({ result: { watt_hours_period: {} } }) };
  };
  try {
    const fs = createForecastSolar(ctx, { store: noopStore });
    await fs.fetchForecast();
  } finally {
    global.fetch = orig;
  }
  return seenUrl;
}

test('forecast-solar Detail-Modus: Geometrie des größten Strings + effektive kWp (24,2, nicht 36,08)', async () => {
  const cfg = {
    manufacturer: 'sungrow',
    forecast: {
      location: { latitude: 52.5, longitude: 13.4 },
      pv: {
        configLevel: 'detailed',
        totalKwp: 24.2,
        strings: [
          { kwp: 12.32, tiltDeg: 40, azimuthDeg: 216 }, // größter String (WSW)
          { kwp: 11.88, tiltDeg: 40, azimuthDeg: 25 },
        ],
      },
    },
    sungrow: { secondInverter: { host: '192.168.68.83', pvKwp: 11.88 } },
  };
  const url = await captureUrl(cfg);
  // Reihenfolge: /estimate/{lat}/{lon}/{dec}/{az}/{kwp}
  const parts = url.split('/estimate/')[1].split('/');
  const [lat, lon, dec, az, kwp] = parts;
  assert.equal(Number(lat), 52.5);
  assert.equal(Number(lon), 13.4);
  assert.equal(Number(dec), 40);           // Neigung des größten Strings
  assert.equal(Number(az), 216 - 180);     // Ausrichtung des größten Strings (36, nicht 0=Süd)
  assert.equal(Number(kwp), 24.2);         // keine Doppelzählung des zweiten WR
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
