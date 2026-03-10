import { setTimeout as delay } from 'node:timers/promises';

import { buildRuntimeSnapshot } from './runtime-state.js';
import {
  createRuntimeCommandQueue,
  RUNTIME_MESSAGE_TYPES
} from './runtime-worker-protocol.js';

function sendMessage(message) {
  if (typeof process.send === 'function') {
    process.send(message);
  }
}

function publishSnapshot() {
  sendMessage({
    type: RUNTIME_MESSAGE_TYPES.RUNTIME_SNAPSHOT,
    snapshot: buildRuntimeSnapshot({
      now: Date.now(),
      meter: {
        ok: true,
        updatedAt: Date.now(),
        grid_total_w: 0,
        grid_l1_w: 0,
        grid_l2_w: 0,
        grid_l3_w: 0
      },
      victron: {
        updatedAt: Date.now(),
        soc: 50,
        batteryPowerW: 0
      },
      schedule: {
        active: null,
        rules: [],
        lastWrite: null
      },
      telemetry: {
        enabled: true,
        ok: true,
        lastWriteAt: null
      },
      historyImport: {
        enabled: true,
        provider: 'vrm',
        ready: true,
        backfillRunning: false
      }
    })
  });
}

async function handleCommand(command = {}) {
  const type = String(command.type || '');
  const payload = command && typeof command === 'object' ? command.payload || {} : {};

  if (Number.isFinite(Number(payload.delayMs)) && Number(payload.delayMs) > 0) {
    await delay(Number(payload.delayMs));
  }

  if (payload.fail) {
    throw new Error(`runtime worker command failed: ${type}`);
  }

  publishSnapshot();
  return {
    commandType: type
  };
}

const commandQueue = createRuntimeCommandQueue({
  handleCommand,
  sendMessage
});

process.on('message', (message) => {
  if (!message || message.type !== RUNTIME_MESSAGE_TYPES.COMMAND_REQUEST) return;
  commandQueue.enqueue({
    requestId: message.requestId,
    command: message.command
  });
});

process.on('uncaughtException', (error) => {
  sendMessage({
    type: RUNTIME_MESSAGE_TYPES.RUNTIME_ERROR,
    error: error instanceof Error ? error.message : String(error)
  });
});

process.channel?.ref?.();

sendMessage({
  type: RUNTIME_MESSAGE_TYPES.RUNTIME_READY,
  pid: process.pid
});
publishSnapshot();
