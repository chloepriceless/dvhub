import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createRuntimeCommandRequest, validateRuntimeCommand } from './runtime-commands.js';

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

/**
 * Web-Prozess → Runtime-Prozess: Befehl senden und auf das Ergebnis warten
 * (Gegenprüfung Release 1.0.9, P2 — Netzstrom-Zähler zurücksetzen). Ohne
 * laufenden Worker, bei Zeitablauf oder Worker-Ende kommt { ok:false, error }.
 * Der Aufrufer leitet COMMAND_RESULT-Nachrichten an handleMessage weiter.
 * Nach dem Zeitlimit kann der Worker den Befehl trotzdem noch ausführen
 * (Gegenprüfung 302ebd13, P3): seine verspätete Antwort geht an onLateResult.
 * isReady: nur an einen bereiten Worker senden, sonst sofort
 * runtime_worker_unavailable (sonst wartete ein Befehl beim Start bis zum Zeitlimit).
 * @param {{ getWorker: () => any, isReady?: () => boolean, timeoutMs?: number,
 *           onLateResult?: (type: string, outcome: {ok:boolean, result?:any, error?:string}) => void }} opts
 */
export function createRuntimeCommandClient({ getWorker, isReady = () => true, timeoutMs = 10_000, onLateResult = null }) {
  const pending = new Map();
  // Nach dem Zeitlimit aufgegeben, Antwort noch offen: requestId → type.
  const timedOut = new Map();

  function settle(requestId, outcome) {
    const entry = pending.get(requestId);
    if (!entry) return false;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(outcome);
    return true;
  }
  const toOutcome = (message) => (message.ok
    ? { ok: true, result: message.result }
    : { ok: false, error: message.error || 'runtime_command_failed' });

  return {
    send(type, payload = {}) {
      const request = createRuntimeCommandRequest(type, payload);
      const validation = validateRuntimeCommand(request);
      if (!validation.ok) return Promise.resolve({ ok: false, error: validation.error });
      const worker = isReady() ? getWorker?.() : null;
      if (!worker || worker.connected === false || typeof worker.send !== 'function') {
        return Promise.resolve({ ok: false, error: 'runtime_worker_unavailable' });
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (settle(request.requestId, { ok: false, error: 'runtime_worker_timeout' })) timedOut.set(request.requestId, request.type);
        }, timeoutMs);
        timer.unref?.();
        pending.set(request.requestId, { resolve, timer });
        try {
          worker.send({ type: RUNTIME_MESSAGE_TYPES.COMMAND_REQUEST, requestId: request.requestId, command: request });
        } catch (error) {
          settle(request.requestId, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      });
    },
    /** @returns {boolean} ob die Nachricht ein Ergebnis dieses Clients war */
    handleMessage(message) {
      if (!message || message.type !== RUNTIME_MESSAGE_TYPES.COMMAND_RESULT) return false;
      if (timedOut.has(message.requestId)) {
        const type = timedOut.get(message.requestId);
        timedOut.delete(message.requestId);
        try { onLateResult?.(type, toOutcome(message)); } catch { /* best effort */ }
        return true;
      }
      if (!pending.has(message.requestId)) return false;
      return settle(message.requestId, toOutcome(message));
    },
    /** Worker beendet: alle offenen Befehle scheitern sofort statt erst nach dem Zeitlimit. */
    failAll(error = 'runtime_worker_exited') {
      for (const requestId of [...pending.keys()]) settle(requestId, { ok: false, error });
      timedOut.clear();
    },
    pendingCount() { return pending.size; },
  };
}

/**
 * Runtime-Prozess: Befehle des Web-Prozesses annehmen, prüfen und der Reihe
 * nach ausführen. handlers: { [type]: async (payload) => result } — nur diese
 * Befehle werden ausgeführt, alles andere scheitert mit Fehlermeldung.
 * @param {{ proc?: NodeJS.Process, handlers: Record<string, (payload: object) => any> }} opts
 */
export function attachRuntimeCommandServer({ proc = process, handlers }) {
  const queue = createRuntimeCommandQueue({
    async handleCommand(command) {
      const validation = validateRuntimeCommand(command);
      if (!validation.ok) throw new Error(validation.error);
      const handler = handlers?.[command.type];
      if (typeof handler !== 'function') throw new Error(`unsupported runtime command: ${command.type}`);
      return handler(command.payload || {});
    },
    sendMessage: (message) => { if (typeof proc.send === 'function') proc.send(message); },
  });
  const onMessage = (message) => {
    if (!message || message.type !== RUNTIME_MESSAGE_TYPES.COMMAND_REQUEST) return;
    queue.enqueue({ requestId: message.requestId, command: message.command });
  };
  proc.on('message', onMessage);
  return { detach: () => proc.off?.('message', onMessage) };
}
