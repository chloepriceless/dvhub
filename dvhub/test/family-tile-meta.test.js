// test/family-tile-meta.test.js -- unit coverage for the Phase 11 tile-meta
// heuristic: the unit/topic -> icon + colour auto-derivation (D-02/D-04) and
// the power-unit classifier (D-06). The module under test is pure, so these
// are plain deepEqual assertions with no mocks or fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTileIconColor, isPowerUnit } from '../services/family/tile-meta.js';

// 1. Every row of the 11-UI-SPEC heuristic table maps to its declared glyph.
test('unit heuristic -- every row maps correctly', () => {
  assert.deepEqual(resolveTileIconColor({ unit: 'W' }),   { icon: '⚡',  color: '#F7B731' });
  assert.deepEqual(resolveTileIconColor({ unit: 'kWh' }), { icon: '🔋', color: '#26de81' });
  assert.deepEqual(resolveTileIconColor({ unit: '°C' }),  { icon: '🌡️', color: '#ff6b6b' });
  assert.deepEqual(resolveTileIconColor({ unit: '%' }),   { icon: '💧', color: '#4b7bec' });
  assert.deepEqual(resolveTileIconColor({ unit: 'V' }),   { icon: '🔌', color: '#22d3ee' });
  assert.deepEqual(resolveTileIconColor({ unit: 'ct' }),  { icon: '💡', color: '#fd9644' });
  assert.deepEqual(resolveTileIconColor({ unit: 'lux' }), { icon: '💡', color: '#F7B731' });
  assert.deepEqual(resolveTileIconColor({ unit: 'ppm' }), { icon: '💨', color: '#4b7bec' });
});

// 2. Unit matching is case-insensitive.
test('case-insensitive unit match', () => {
  assert.deepEqual(resolveTileIconColor({ unit: 'kw' }), { icon: '⚡', color: '#F7B731' });
  assert.deepEqual(resolveTileIconColor({ unit: 'KW' }), { icon: '⚡', color: '#F7B731' });
  assert.deepEqual(resolveTileIconColor({ unit: 'mW' }), { icon: '⚡', color: '#F7B731' });
});

// 3. With no unit set, the topic fallback rules fire.
test('topic fallback when unit absent', () => {
  assert.deepEqual(
    resolveTileIconColor({ unit: '', topic: 'home/tesla/charge' }),
    { icon: '🚗', color: '#a55eea' }
  );
  assert.deepEqual(
    resolveTileIconColor({ topic: 'wohnzimmer/temp' }),
    { icon: '🌡️', color: '#ff6b6b' }
  );
});

// 4. No unit + no topic match -> the Slate 📡 fallback.
test('no-match fallback', () => {
  assert.deepEqual(
    resolveTileIconColor({ unit: '', topic: 'foo/bar' }),
    { icon: '📡', color: '#78909c' }
  );
  assert.deepEqual(resolveTileIconColor({}), { icon: '📡', color: '#78909c' });
  assert.deepEqual(resolveTileIconColor(null), { icon: '📡', color: '#78909c' });
});

// 5. Explicit tile.icon AND tile.color are returned verbatim -- the heuristic
//    is not consulted (an explicit value always wins).
test('explicit values win', () => {
  assert.deepEqual(
    resolveTileIconColor({ icon: '🔥', color: '#26de81', unit: 'W' }),
    { icon: '🔥', color: '#26de81' }
  );
});

// 6. Partial-explicit: an explicit icon with no colour -> icon verbatim,
//    colour auto-derived from the unit. Resolved per-field, independently.
test('partial explicit -- icon set, colour auto', () => {
  assert.deepEqual(
    resolveTileIconColor({ icon: '🔥', unit: 'W' }),
    { icon: '🔥', color: '#F7B731' }
  );
  // ...and the reverse: explicit colour, auto icon.
  assert.deepEqual(
    resolveTileIconColor({ color: '#a55eea', unit: 'W' }),
    { icon: '⚡', color: '#a55eea' }
  );
});

// 7. The power-unit classifier (D-06).
test('isPowerUnit classifier', () => {
  assert.equal(isPowerUnit('W'), true);
  assert.equal(isPowerUnit('kW'), true);
  assert.equal(isPowerUnit('MW'), true);
  assert.equal(isPowerUnit('w'), true);   // case-insensitive
  assert.equal(isPowerUnit('°C'), false);
  assert.equal(isPowerUnit('%'), false);
  assert.equal(isPowerUnit('Wh'), false); // energy, not power
  assert.equal(isPowerUnit(''), false);
  assert.equal(isPowerUnit(undefined), false);
});

// 8. A power unit pins the colour even when the topic would otherwise match a
//    different rule -- unit rules are checked before topic rules.
test('power unit wins over a topic match', () => {
  assert.deepEqual(
    resolveTileIconColor({ unit: 'kW', topic: 'home/tesla/charge' }),
    { icon: '⚡', color: '#F7B731' }
  );
});
