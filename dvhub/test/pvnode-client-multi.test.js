import test from 'node:test';
import assert from 'node:assert/strict';

// Phase 07 Wave-0 scaffold — REVIEWS H5: tests SKIPPED because module doesn't export
// chunkPlants/buildQueryParams yet. UNSKIP in Plan 07-02 when
// services/forecast/pvnode-client.js is refactored to multi-plane.

test.skip('chunkPlants N=4 produces 2 groups of 2 sorted by kwp desc — UNSKIP when Plan 07-02 merges', async () => {
  const { chunkPlants } = await import('../services/forecast/pvnode-client.js');
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

test.skip('chunkPlants N=3 isolates largest plant alone (REVIEWS H6 locked rule) — UNSKIP when Plan 07-02 merges', async () => {
  const { chunkPlants } = await import('../services/forecast/pvnode-client.js');
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

test.skip('chunkPlants N=1 produces single-element group — UNSKIP when Plan 07-02 merges', async () => {
  const { chunkPlants } = await import('../services/forecast/pvnode-client.js');
  const groups = chunkPlants([{ kwp: 5, tiltDeg: 30, azimuthDeg: 180 }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 1);
});

test.skip('chunkPlants N=0 produces empty array — UNSKIP when Plan 07-02 merges', async () => {
  const { chunkPlants } = await import('../services/forecast/pvnode-client.js');
  assert.deepEqual(chunkPlants([]), []);
});
