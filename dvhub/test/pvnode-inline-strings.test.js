// test/pvnode-inline-strings.test.js — pvnode (ohne Site-ID) bekommt die
// PV-Strings aus der Oberfläche (Audit 2026-10-14, Befund 2).
//
// Vorher las der Inline-Abruf nur userEnergyPricing.pvPlants (dort pflegt die
// Oberfläche keine Neigung/Ausrichtung) und sonst die alten Einzelfelder —
// die Strings aus Einstellungen → Prognose (forecast.pv.strings, Stufe
// „detailed“) blieben ungenutzt. Jetzt wie die anderen Dienste: Strings zuerst.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPvnodeClient } from '../services/forecast/pvnode-client.js';

async function inlineBody(pv, extra = {}) {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    sent.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null });
    return { ok: true, status: 200, json: async () => ({ timezone: 'UTC', values: [] }) };
  };
  try {
    const client = createPvnodeClient({
      getCfg: () => ({
        forecast: { location: { latitude: 52.5, longitude: 13.4 }, pv, pvnode: { apiKey: 'test', plan: 'plus' } },
        ...extra,
      }),
      pushLog: () => {},
    }, {});
    await client.fetchForecast();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /\/forecast\/inline/);
  return sent[0].body;
}

const strings = [
  { label: 'Süd', kwp: 18, tiltDeg: 40, azimuthDeg: 180 },
  { label: 'Ost', kwp: 6.5, tiltDeg: 15, azimuthDeg: 90 },
];

test('Stufe „detailed“ mit Strings → genau diese Strings gehen an pvnode', async () => {
  const body = await inlineBody({ configLevel: 'detailed', strings, totalKwp: 24.5, tiltDeg: 35, azimuthDeg: 180 });
  assert.deepEqual(body.strings, [
    { slope: 40, orientation: 180, power_kw: 18 },
    { slope: 15, orientation: 90, power_kw: 6.5 },
  ]);
});

test('Strings vor pvPlants-Geometrie', async () => {
  const body = await inlineBody(
    { configLevel: 'detailed', strings },
    { userEnergyPricing: { pvPlants: [{ kwp: 10, commissionedAt: '2020-01-01', tiltDeg: 30, azimuthDeg: 200 }] } },
  );
  assert.equal(body.strings.length, 2);
  assert.equal(body.strings[0].power_kw, 18);
});

test('ohne Stufe „detailed“ bleibt es bei pvPlants bzw. den Einzelfeldern', async () => {
  const body = await inlineBody({ configLevel: 'standard', strings, totalKwp: 12, tiltDeg: 30, azimuthDeg: 160 });
  assert.deepEqual(body.strings, [{ slope: 30, orientation: 160, power_kw: 12 }]);
});
