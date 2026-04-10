// python-bridge/index.js -- Node.js bridge for Python child_process invocation.
// Tier-gated: only available on Tier 2+ (>= 2GB RAM).
// Spawns Python scripts via execFile, passes JSON via stdin, reads JSON from stdout.
// Batch mode (Tier 2): spawn, compute, exit per invocation.
// Persistent mode (Tier 3): JSON-RPC 2.0 over stdin/stdout with heartbeat and auto-respawn.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const VENV_PYTHON = '/opt/dvhub/forecast-venv/bin/python3';
const MIN_FREE_MB_FOR_SPAWN = 500;

/**
 * Create a Python bridge for invoking Python scripts as child processes.
 * Only available on Tier 2+ hardware (>= 2GB RAM).
 *
 * @param {object} ctx - DI context { state, getCfg, pushLog }
 * @param {object} options - { tier: number }
 * @returns {{ call: Function, start: Function, close: Function }}
 */
export function createPythonBridge(ctx, { tier }) {
  const { pushLog } = ctx;

  /**
   * Call a Python script with JSON input data.
   * Returns parsed JSON output or null on error.
   *
   * @param {string} scriptPath - Absolute path to the Python script
   * @param {object} inputData - JSON-serializable input data (passed via stdin)
   * @returns {Promise<object|null>} Parsed JSON output or null on error
   */
  async function call(scriptPath, inputData) {
    // Tier gate: refuse on Tier 1
    if (tier < 2) {
      throw new Error('Python bridge not available on Tier 1');
    }

    // OOM guard: check free memory before spawning
    const freeMB = Math.floor(os.freemem() / (1024 * 1024));
    if (freeMB < MIN_FREE_MB_FOR_SPAWN) {
      pushLog('python_oom_guard', { freeMB, minRequired: MIN_FREE_MB_FOR_SPAWN });
      return null;
    }

    // Check venv Python exists
    if (!fs.existsSync(VENV_PYTHON)) {
      pushLog('python_not_installed', { expectedPath: VENV_PYTHON });
      return null;
    }

    const stdinStr = JSON.stringify(inputData);
    // ML training with 90+ days of data can take several minutes — use longer timeout for train scripts
    const isTraining = path.basename(scriptPath) === 'ml_train.py';
    const timeoutMs = isTraining ? 600_000 : 60_000;

    // Use spawn with explicit pipes — execFile with `input` option was returning
    // non-zero exit codes silently on Debian 13 / Node 22 with no captured stderr.
    return await new Promise((resolve) => {
      let resolved = false;
      const finish = (result) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolve(result);
      };

      let proc;
      try {
        proc = spawn(VENV_PYTHON, [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (spawnErr) {
        pushLog('python_error', { script: path.basename(scriptPath), error: spawnErr.message });
        return finish(null);
      }

      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        pushLog('python_timeout', { script: path.basename(scriptPath), timeoutMs });
        finish(null);
      }, timeoutMs);

      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      const maxBytes = 50 * 1024 * 1024;
      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => {
        stdoutBytes += Buffer.byteLength(chunk);
        if (stdoutBytes > maxBytes) {
          try { proc.kill('SIGKILL'); } catch { /* ignore */ }
          pushLog('python_oversize', { script: path.basename(scriptPath), bytes: stdoutBytes });
          return finish(null);
        }
        stdout += chunk;
      });
      proc.stderr.on('data', (chunk) => { stderr += chunk; });

      proc.on('error', (err) => {
        pushLog('python_error', { script: path.basename(scriptPath), error: err.message, stderr: stderr.slice(0, 2000) });
        finish(null);
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          pushLog('python_error', {
            script: path.basename(scriptPath),
            error: `exit code ${code}`,
            stderr: stderr.slice(0, 2000),
            stdout: stdout.slice(0, 2000)
          });
          return finish(null);
        }
        try {
          finish(JSON.parse(stdout));
        } catch (parseErr) {
          pushLog('python_error', {
            script: path.basename(scriptPath),
            error: `JSON parse failed: ${parseErr.message}`,
            stdout: stdout.slice(0, 2000),
            stderr: stderr.slice(0, 2000)
          });
          finish(null);
        }
      });

      proc.stdin.on('error', (err) => {
        pushLog('python_error', { script: path.basename(scriptPath), error: `stdin: ${err.message}` });
      });
      proc.stdin.write(stdinStr);
      proc.stdin.end();
    });
  }

  /**
   * Start the Python bridge.
   * Phase 1: async no-op (Tier 3 persistent process deferred to Phase 5).
   */
  async function start() {
    // No-op for Phase 1 batch mode
  }

  /**
   * Close the Python bridge.
   * Phase 1: no-op (no persistent process to terminate).
   */
  function close() {
    // No-op for Phase 1 batch mode
  }

  return { call, start, close };
}

/**
 * Create a persistent Python bridge using JSON-RPC 2.0 over stdin/stdout.
 * Only used on Tier 3 (8GB+ RAM) for long-running Python ML server.
 * Per D-19, D-20: heartbeat, auto-respawn, timeout handling.
 *
 * @param {object} ctx - DI context { pushLog }
 * @param {object} options - { scriptPath: string }
 * @returns {{ call: Function, start: Function, close: Function }}
 */
export function createPersistentBridge(ctx, { scriptPath }) {
  const { pushLog } = ctx;

  let proc = null;
  let rl = null;
  /** @type {Map<number, {resolve: Function, reject: Function, timer: ReturnType<typeof setTimeout>}>} */
  const pending = new Map();
  let nextId = 1;
  let heartbeatTimer = null;
  let heartbeatFailures = 0;
  const MAX_HEARTBEAT_FAILURES = 3;
  const HEARTBEAT_INTERVAL_MS = 60_000;
  let closing = false;

  /**
   * Spawn the Python process and set up JSON-RPC line reader.
   */
  function spawnProcess() {
    if (!fs.existsSync(VENV_PYTHON)) {
      pushLog('python_persistent_not_installed', { expectedPath: VENV_PYTHON });
      return;
    }

    proc = spawn(VENV_PYTHON, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Parse stdout line by line for JSON-RPC responses
    rl = createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && pending.has(msg.id)) {
          const entry = pending.get(msg.id);
          pending.delete(msg.id);
          clearTimeout(entry.timer);

          if (msg.error) {
            entry.reject(new Error(msg.error.message || 'JSON-RPC error'));
          } else {
            entry.resolve(msg.result);
          }
        }
      } catch {
        // Skip malformed lines
      }
    });

    // Pipe stderr to pushLog
    if (proc.stderr) {
      const stderrRl = createInterface({ input: proc.stderr });
      stderrRl.on('line', (text) => {
        pushLog('python_stderr', { text });
      });
    }

    // Handle process exit: reject all pending requests
    proc.on('exit', (code) => {
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`Python process exited with code ${code}`));
      }
      pending.clear();

      if (!closing) {
        pushLog('python_persistent_exit', { code });
        // Auto-respawn
        setTimeout(() => {
          if (!closing) {
            pushLog('python_persistent_respawn', {});
            spawnProcess();
          }
        }, 2000);
      }
    });

    heartbeatFailures = 0;
  }

  /**
   * Send a JSON-RPC 2.0 request to the persistent Python process.
   * @param {string} method - RPC method name
   * @param {object} params - Method parameters
   * @param {number} timeoutMs - Timeout in milliseconds (default 30000)
   * @returns {Promise<object>} Result from Python
   */
  function call(method, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!proc || !proc.stdin?.writable) {
        reject(new Error('Persistent Python bridge not running'));
        return;
      }

      const id = nextId++;
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`JSON-RPC timeout after ${timeoutMs}ms for method ${method}`));
        }
      }, timeoutMs);

      pending.set(id, { resolve, reject, timer });

      const request = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      proc.stdin.write(request);
    });
  }

  /**
   * Start heartbeat monitor. Sends health check every 60s.
   * After 3 consecutive failures, kills and respawns process.
   */
  function startHeartbeat() {
    heartbeatTimer = setInterval(async () => {
      try {
        await call('health', {}, 10_000);
        heartbeatFailures = 0;
      } catch {
        heartbeatFailures++;
        pushLog('python_heartbeat_fail', { failures: heartbeatFailures });
        if (heartbeatFailures >= MAX_HEARTBEAT_FAILURES) {
          pushLog('python_heartbeat_kill', { failures: heartbeatFailures });
          if (proc) {
            proc.kill('SIGTERM');
          }
          heartbeatFailures = 0;
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Start the persistent bridge: spawn process, start heartbeat.
   */
  async function start() {
    closing = false;
    spawnProcess();
    startHeartbeat();
    pushLog('python_persistent_started', { scriptPath });
  }

  /**
   * Close the persistent bridge: send shutdown, wait, then kill.
   */
  async function close() {
    closing = true;

    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    if (proc) {
      try {
        // Send shutdown command
        const shutdownReq = JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'shutdown', params: {} }) + '\n';
        proc.stdin.write(shutdownReq);

        // Wait up to 5 seconds for graceful exit
        await new Promise((resolve) => {
          const killTimer = setTimeout(() => {
            if (proc) {
              proc.kill('SIGTERM');
            }
            resolve();
          }, 5000);

          proc.on('exit', () => {
            clearTimeout(killTimer);
            resolve();
          });
        });
      } catch {
        if (proc) {
          proc.kill('SIGTERM');
        }
      }
      proc = null;
    }

    // Reject any remaining pending requests
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Persistent bridge closed'));
    }
    pending.clear();
  }

  return { call, start, close };
}
