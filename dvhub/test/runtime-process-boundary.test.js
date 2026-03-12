import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRuntimeSnapshot,
  buildWebStatusResponse,
  buildWorkerBackedStatusResponse,
  buildHistoryImportStatusResponse
} from '../runtime-state.js';
import {
  createRuntimeCommandRequest,
  validateRuntimeCommand
} from '../runtime-commands.js';
import {
  RUNTIME_MESSAGE_TYPES,
  startRuntimeWorker
} from '../runtime-worker-protocol.js';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));

function waitForWorkerMessage(worker, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('worker message timeout'));
    }, 2000);

    function handleMessage(message) {
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    }

    function handleExit(code, signal) {
      cleanup();
      reject(new Error(`worker exited before message (code=${code}, signal=${signal})`));
    }

    function cleanup() {
      clearTimeout(timeout);
      worker.off('message', handleMessage);
      worker.off('exit', handleExit);
    }

    worker.on('message', handleMessage);
    worker.on('exit', handleExit);
  });
}

function waitForWorkerMessages(worker, predicate, expectedCount) {
  return new Promise((resolve, reject) => {
    const matches = [];
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`worker message timeout after ${matches.length}/${expectedCount} matches`));
    }, 2000);

    function handleMessage(message) {
      if (!predicate(message)) return;
      matches.push(message);
      if (matches.length >= expectedCount) {
        cleanup();
        resolve(matches);
      }
    }

    function handleExit(code, signal) {
      cleanup();
      reject(new Error(`worker exited before messages (code=${code}, signal=${signal})`));
    }

    function cleanup() {
      clearTimeout(timeout);
      worker.off('message', handleMessage);
      worker.off('exit', handleExit);
    }

    worker.on('message', handleMessage);
    worker.on('exit', handleExit);
  });
}

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

test('web status responses prefer cached worker payloads over local fallback state', () => {
  const cachedStatus = {
    now: 1773117900000,
    meter: { grid_total_w: 420 },
    victron: { soc: 63 },
    telemetry: {
      enabled: true,
      historyImport: {
        enabled: true,
        provider: 'vrm',
        ready: true,
        backfillRunning: false
      }
    },
    epex: {
      ok: true,
      data: [{ ts: 1773117600000, ct_kwh: 4.2 }],
      summary: { current: { ts: 1773117600000, ct_kwh: 4.2 } }
    }
  };

  const fallbackStatus = {
    now: 1773117912345,
    meter: { grid_total_w: 9999 },
    victron: { soc: 5 },
    telemetry: {
      enabled: false,
      historyImport: {
        enabled: false,
        provider: 'vrm',
        ready: false,
        backfillRunning: true
      }
    },
    epex: {
      ok: false,
      data: [],
      summary: null
    }
  };

  const response = buildWorkerBackedStatusResponse({
    cachedStatus,
    fallbackStatus,
    setup: {
      path: '/etc/dvhub/config.json',
      exists: true,
      valid: true
    },
    runtime: {
      ready: true,
      mode: 'worker',
      snapshotAgeMs: 450
    }
  });

  assert.equal(response.meter.grid_total_w, 420);
  assert.equal(response.victron.soc, 63);
  assert.equal(response.telemetry.enabled, true);
  assert.equal(response.telemetry.historyImport.backfillRunning, false);
  assert.equal(response.epex.ok, true);
  assert.equal(response.epex.data.length, 1);
  assert.equal(response.setup.path, '/etc/dvhub/config.json');
  assert.equal(response.runtime.mode, 'worker');
});

test('history import status prefers cached worker telemetry state when available', () => {
  const response = buildHistoryImportStatusResponse({
    cachedStatus: {
      telemetry: {
        enabled: true,
        historyImport: {
          enabled: true,
          provider: 'vrm',
          ready: true,
          backfillRunning: false
        }
      }
    },
    fallbackTelemetryEnabled: false,
    fallbackHistoryImport: {
      enabled: false,
      provider: 'vrm',
      ready: false,
      backfillRunning: true
    }
  });

  assert.deepEqual(response, {
    ok: true,
    telemetryEnabled: true,
    historyImport: {
      enabled: true,
      provider: 'vrm',
      ready: true,
      backfillRunning: false
    }
  });
});

test('server source wires small-market automation regeneration before schedule evaluation', async () => {
  const source = await fs.readFile(serverPath, 'utf8');
  assert.match(source, /regenerateSmallMarketAutomationRules/);
  assert.match(source, /small_market_automation/);
  assert.match(source, /autoManaged/);
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

test('runtime state snapshots stay serializable and drop transport-only objects', () => {
  const snapshot = buildRuntimeSnapshot({
    now: '2026-03-10T04:45:00.000Z',
    meter: {
      grid_total_w: 380,
      raw: [1, 2, 3],
      socket: { remoteAddress: '127.0.0.1' }
    },
    victron: {
      soc: 57,
      errors: {
        batteryPowerW: 'timeout'
      },
      request: { method: 'POST' }
    },
    schedule: {
      active: { gridSetpointW: 50 },
      rules: [{ id: 'day-1', enabled: true }],
      manualOverride: { gridSetpointW: { value: 1200 } }
    },
    telemetry: {
      enabled: true,
      dbPath: '/tmp/telemetry.sqlite',
      lastWriteAt: '2026-03-10T04:44:59.000Z',
      res: { statusCode: 200 }
    },
    historyImport: {
      enabled: true,
      provider: 'vrm',
      ready: true,
      backfillRunning: true,
      req: { url: '/api/history/import' }
    }
  });

  const plain = JSON.parse(JSON.stringify(snapshot));
  assert.equal(plain.capturedAt, '2026-03-10T04:45:00.000Z');
  assert.equal(plain.meter.grid_total_w, 380);
  assert.equal(plain.victron.soc, 57);
  assert.equal(plain.schedule.rules[0].id, 'day-1');
  assert.equal(plain.telemetry.dbPath, '/tmp/telemetry.sqlite');
  assert.equal(plain.historyImport.backfillRunning, true);
  assert.equal('socket' in plain.meter, false);
  assert.equal('request' in plain.victron, false);
  assert.equal('res' in plain.telemetry, false);
  assert.equal('req' in plain.historyImport, false);
});

test('command payloads are schema-checked before runtime execution', () => {
  assert.equal(validateRuntimeCommand(createRuntimeCommandRequest('poll_now')).ok, true);
  assert.equal(validateRuntimeCommand(createRuntimeCommandRequest('service_health_snapshot')).ok, true);

  assert.deepEqual(
    validateRuntimeCommand(createRuntimeCommandRequest('control_write', {
      target: 'gridSetpointW',
      value: 2500
    })),
    {
      ok: true,
      error: null
    }
  );

  assert.deepEqual(
    validateRuntimeCommand(createRuntimeCommandRequest('history_import', {
      provider: 'vrm',
      requestedFrom: '2026-03-01T00:00:00.000Z',
      requestedTo: '2026-03-02T00:00:00.000Z',
      interval: '15mins'
    })),
    {
      ok: true,
      error: null
    }
  );

  assert.deepEqual(
    validateRuntimeCommand(createRuntimeCommandRequest('history_backfill', {
      mode: 'full',
      requestedBy: 'tools_page'
    })),
    {
      ok: true,
      error: null
    }
  );

  assert.deepEqual(
    validateRuntimeCommand({
      type: 'control_write',
      route: 'runtime_worker',
      payload: { target: 'gridSetpointW', value: Number.NaN }
    }),
    {
      ok: false,
      error: 'control_write value must be finite'
    }
  );

  assert.deepEqual(
    validateRuntimeCommand({
      type: 'history_import',
      route: 'runtime_worker',
      payload: { provider: 'vrm', requestedFrom: 'not-a-date' }
    }),
    {
      ok: false,
      error: 'history_import requestedFrom/requestedTo must be valid ISO timestamps'
    }
  );

  assert.deepEqual(
    validateRuntimeCommand({
      type: 'history_backfill',
      route: 'runtime_worker',
      payload: { mode: 'overnight' }
    }),
    {
      ok: false,
      error: 'history_backfill mode must be gap or full'
    }
  );
});

test('web process can spawn a dedicated runtime worker', async (t) => {
  const worker = startRuntimeWorker({
    env: {
      DVHUB_RUNTIME_WORKER_TEST: '1'
    }
  });
  t.after(() => worker.kill());

  const readyMessage = await waitForWorkerMessage(
    worker,
    (message) => message?.type === RUNTIME_MESSAGE_TYPES.RUNTIME_READY
  );

  assert.equal(readyMessage.type, RUNTIME_MESSAGE_TYPES.RUNTIME_READY);
  assert.equal(typeof readyMessage.pid, 'number');
});

test('runtime worker publishes status snapshots over ipc', async (t) => {
  const worker = startRuntimeWorker({
    env: {
      DVHUB_RUNTIME_WORKER_TEST: '1'
    }
  });
  t.after(() => worker.kill());

  const snapshotMessage = await waitForWorkerMessage(
    worker,
    (message) => message?.type === RUNTIME_MESSAGE_TYPES.RUNTIME_SNAPSHOT
  );

  assert.equal(snapshotMessage.type, RUNTIME_MESSAGE_TYPES.RUNTIME_SNAPSHOT);
  assert.equal(snapshotMessage.snapshot.telemetry.enabled, true);
  assert.equal(typeof snapshotMessage.snapshot.capturedAt, 'string');
});

test('runtime worker handles one command at a time and reports structured success and error results', async (t) => {
  const worker = startRuntimeWorker({
    env: {
      DVHUB_RUNTIME_WORKER_TEST: '1'
    }
  });
  t.after(() => worker.kill());

  await waitForWorkerMessage(worker, (message) => message?.type === RUNTIME_MESSAGE_TYPES.RUNTIME_READY);

  worker.send({
    type: RUNTIME_MESSAGE_TYPES.COMMAND_REQUEST,
    requestId: 'cmd-1',
    command: {
      type: 'poll_now',
      payload: {
        delayMs: 30
      }
    }
  });
  worker.send({
    type: RUNTIME_MESSAGE_TYPES.COMMAND_REQUEST,
    requestId: 'cmd-2',
    command: {
      type: 'service_health_snapshot',
      payload: {}
    }
  });
  worker.send({
    type: RUNTIME_MESSAGE_TYPES.COMMAND_REQUEST,
    requestId: 'cmd-3',
    command: {
      type: 'poll_now',
      payload: {
        fail: true
      }
    }
  });

  const results = await waitForWorkerMessages(
    worker,
    (message) => message?.type === RUNTIME_MESSAGE_TYPES.COMMAND_RESULT,
    3
  );

  assert.deepEqual(
    results.map((message) => message.requestId),
    ['cmd-1', 'cmd-2', 'cmd-3']
  );
  assert.deepEqual(results[0], {
    type: RUNTIME_MESSAGE_TYPES.COMMAND_RESULT,
    requestId: 'cmd-1',
    ok: true,
    result: {
      commandType: 'poll_now'
    }
  });
  assert.deepEqual(results[1], {
    type: RUNTIME_MESSAGE_TYPES.COMMAND_RESULT,
    requestId: 'cmd-2',
    ok: true,
    result: {
      commandType: 'service_health_snapshot'
    }
  });
  assert.deepEqual(results[2], {
    type: RUNTIME_MESSAGE_TYPES.COMMAND_RESULT,
    requestId: 'cmd-3',
    ok: false,
    error: 'runtime worker command failed: poll_now'
  });
});
