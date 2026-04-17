import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkPlants, buildQueryParams } from '../services/forecast/pvnode-client.js';

// Phase 07 Wave-1 (Plan 07-02): tests unskipped (REVIEWS H5 transition).
// services/forecast/pvnode-client.js now exports chunkPlants + buildQueryParams.

test('chunkPlants N=4 produces 2 groups of 2 sorted by kwp desc', () => {
  const plants = [
    { kwp: 3, tiltDeg: 30, azimuthDeg: 180 },
    { kwp: 5, tiltDeg: 30, azimuthDeg: 180 },
    { kwp: 2, tiltDeg: 30, azimuthDeg: 270 },
    { kwp: 4, tiltDeg: 30, azimuthDeg: 90 }
  ];
  const groups = chunkPlants(plants);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].length, 2);
  assert.equal(groups[1].length, 2);
  assert.equal(groups[0][0].kwp, 5); // largest first
});

test('chunkPlants N=3 isolates largest plant alone (REVIEWS H6 locked rule)', () => {
  // REVIEWS H6: for odd N, the LARGEST plant is isolated alone in its own group,
  // so the two smaller plants are paired (smaller absolute error when summed).
  // Plants sorted desc: [kwp:5, kwp:3, kwp:2] → expected [[5]], [[3, 2]]
  const plants = [
    { kwp: 2, tiltDeg: 30, azimuthDeg: 180 },
    { kwp: 5, tiltDeg: 30, azimuthDeg: 180 },
    { kwp: 3, tiltDeg: 30, azimuthDeg: 270 }
  ];
  const groups = chunkPlants(plants);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].length, 1);       // largest isolated
  assert.equal(groups[0][0].kwp, 5);
  assert.equal(groups[1].length, 2);
});

test('chunkPlants N=1 produces single-element group', () => {
  const groups = chunkPlants([{ kwp: 5, tiltDeg: 30, azimuthDeg: 180 }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 1);
});

test('chunkPlants N=0 produces empty array', () => {
  assert.deepEqual(chunkPlants([]), []);
});

test('buildQueryParams maps plant[0] to first plane (REVIEWS H7: sky_obstruction_config + shading_config)', () => {
  const plants = [
    {
      kwp: 5, tiltDeg: 30, azimuthDeg: 180,
      skyObstructionConfig: 'HORIZON:{30,180}',
      shadingConfig: 'ROW:1.5m'
    }
  ];
  const q = buildQueryParams({ lat: 52.5, lon: 13.4, plants });
  assert.equal(q.get('latitude'), '52.5');
  assert.equal(q.get('longitude'), '13.4');
  assert.equal(q.get('slope'), '30');
  assert.equal(q.get('orientation'), '180'); // 0=N,180=S natively (NO -180 offset)
  assert.equal(q.get('pv_power_kw'), '5');
  assert.equal(q.get('sky_obstruction_config'), 'HORIZON:{30,180}');
  assert.equal(q.get('shading_config'), 'ROW:1.5m');
  assert.equal(q.get('second_array_slope'), null); // no second plane
});

test('buildQueryParams adds second_array_* params when plants[1] is present', () => {
  const plants = [
    { kwp: 5, tiltDeg: 30, azimuthDeg: 180 },
    { kwp: 3, tiltDeg: 25, azimuthDeg: 90 }
  ];
  const q = buildQueryParams({ lat: 52.5, lon: 13.4, plants });
  assert.equal(q.get('slope'), '30');
  assert.equal(q.get('orientation'), '180');
  assert.equal(q.get('pv_power_kw'), '5');
  assert.equal(q.get('second_array_slope'), '25');
  assert.equal(q.get('second_array_orientation'), '90');
  assert.equal(q.get('second_array_power_kw'), '3');
});
