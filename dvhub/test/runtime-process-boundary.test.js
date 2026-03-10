import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRuntimeSnapshot,
  buildWebStatusResponse
} from '../runtime-state.js';
import {
  createRuntimeCommandRequest,
  validateRuntimeCommand
} from '../runtime-commands.js';

test('web process can serve a cached status response while the runtime worker is busy', () => {
  const snapshot = buildRuntimeSnapshot({
    now: '2026-03-10T04:45:00.000Z',
    meter: {
      grid_total_w: 420,
      grid_l1_w: 120,
      grid_l2_w: 140,
      grid_l3_w: 160
    },
    victron: {
      batteryPowerW: -850,
      soc: 63
    },
    schedule: {
      active: null,
      rules: [],
      lastWrite: null
    },
    telemetry: {
      enabled: true,
      lastWriteAt: '2026-03-10T04:44:58.000Z'
    },
    historyImport: {
      enabled: true,
      provider: 'vrm',
      ready: true,
      backfillRunning: false
    }
  });

  const response = buildWebStatusResponse({
    now: 1773117900000,
    snapshot,
    runtime: {
      ready: true,
      busy: true,
      queueDepth: 1,
      snapshotAgeMs: 250
    }
  });

  assert.equal(response.meter.grid_total_w, 420);
  assert.equal(response.victron.soc, 63);
  assert.equal(response.telemetry.historyImport.backfillRunning, false);
  assert.deepEqual(response.runtime, {
    ready: true,
    busy: true,
    queueDepth: 1,
    snapshotAgeMs: 250
  });
});

test('heavy runtime writes are converted into worker command requests before execution', () => {
  const request = createRuntimeCommandRequest('history_backfill', {
    mode: 'gap',
    requestedBy: 'tools_page'
  });

  assert.equal(request.type, 'history_backfill');
  assert.equal(request.route, 'runtime_worker');
  assert.equal(request.payload.mode, 'gap');
  assert.equal(request.payload.requestedBy, 'tools_page');
  assert.equal(validateRuntimeCommand(request).ok, true);
});
