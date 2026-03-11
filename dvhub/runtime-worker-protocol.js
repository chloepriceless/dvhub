import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const RUNTIME_MESSAGE_TYPES = Object.freeze({
  RUNTIME_SNAPSHOT: 'runtime_snapshot',
  RUNTIME_READY: 'runtime_ready',
  RUNTIME_ERROR: 'runtime_error',
  COMMAND_REQUEST: 'command_request',
  COMMAND_RESULT: 'command_result'
});

export function startRuntimeWorker({
  workerPath = path.join(__dirname, 'runtime-worker.js'),
  forkImpl = fork,
  cwd = process.cwd(),
  env = {}
} = {}) {
  return forkImpl(workerPath, [], {
    cwd,
    env: {
      ...process.env,
      ...env
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  });
}

export function createRuntimeCommandQueue({ handleCommand, sendMessage }) {
  let active = false;
  const pending = [];

  async function drainQueue() {
    if (active) return;
    const next = pending.shift();
    if (!next) return;

    active = true;
    try {
      const result = await handleCommand(next.command);
      sendMessage({
        type: RUNTIME_MESSAGE_TYPES.COMMAND_RESULT,
        requestId: next.requestId,
        ok: true,
        result
      });
    } catch (error) {
      sendMessage({
        type: RUNTIME_MESSAGE_TYPES.COMMAND_RESULT,
        requestId: next.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      active = false;
      drainQueue();
    }
  }

  return {
    enqueue(request) {
      pending.push(request);
      drainQueue();
    },
    isBusy() {
      return active;
    },
    getQueueDepth() {
      return pending.length;
    }
  };
}
