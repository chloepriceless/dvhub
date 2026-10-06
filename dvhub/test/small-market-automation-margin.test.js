import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveForecastSafetyMarginKwh, FORECAST_SAFETY_MARGIN_DEFAULT_KWH } from '../market-automation-builder.js';
import { computeForecastReserveSocPct } from '../small-market-automation.js';

test('Sicherheitspuffer: Standard 1,5 kWh, 0 erlaubt, Unsinn fällt auf den Standard', () => {
  assert.equal(FORECAST_SAFETY_MARGIN_DEFAULT_KWH, 1.5);
  assert.equal(resolveForecastSafetyMarginKwh({}), 1.5);
  assert.equal(resolveForecastSafetyMarginKwh({ forecastSafetyMarginKwh: '' }), 1.5);
  assert.equal(resolveForecastSafetyMarginKwh({ forecastSafetyMarginKwh: null }), 1.5);
  assert.equal(resolveForecastSafetyMarginKwh({ forecastSafetyMarginKwh: 0 }), 0);
  assert.equal(resolveForecastSafetyMarginKwh({ forecastSafetyMarginKwh: 4 }), 4);
  assert.equal(resolveForecastSafetyMarginKwh({ forecastSafetyMarginKwh: -1 }), 1.5);
  assert.equal(resolveForecastSafetyMarginKwh({ forecastSafetyMarginKwh: 'abc' }), 1.5);
});

test('Sicherheitspuffer wirkt: größerer Puffer → höhere (oder gleiche) Reserve', () => {
  const now = Date.parse('2026-10-06T16:00:00Z');
  const slots = (w) => Array.from({ length: 24 }, (_, i) => ({ start: new Date(now + i * 3600000).toISOString(), end: new Date(now + (i + 1) * 3600000).toISOString(), powerW: w, confidence: 0.9 }));
  const base = { pvSlots: slots(1500), loadSlots: slots(800), nowTs: now, horizonHours: 24, currentSocPct: 80, batteryCapacityKwh: 20, configuredMinSocPct: 40, globalMinSocPct: 5, confidenceThreshold: 0.25 };
  const small = computeForecastReserveSocPct({ ...base, safetyMarginKwh: 0 });
  const large = computeForecastReserveSocPct({ ...base, safetyMarginKwh: 6 });
  assert.equal(large.effectiveMinSocPct >= small.effectiveMinSocPct, true);
  assert.equal(large.effectiveMinSocPct <= 40, true, 'nie über der eingestellten Reserve');
});
