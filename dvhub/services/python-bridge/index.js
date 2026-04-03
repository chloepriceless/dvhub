// python-bridge/index.js -- Node.js bridge for Python child_process invocation.
// Tier-gated: only available on Tier 2+ (>= 2GB RAM).
// Spawns Python scripts via execFile, passes JSON via stdin, reads JSON from stdout.
// Phase 1: batch mode only (spawn, compute, exit). Tier 3 persistent process deferred to Phase 5.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const VENV_PYTHON = '/opt/dvhub/forecast-venv/bin/python';
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

    const stdin = JSON.stringify(inputData);

    try {
      const { stdout } = await execFileAsync(VENV_PYTHON, [scriptPath], {
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
        encoding: 'utf8',
        input: stdin
      });

      return JSON.parse(stdout);
    } catch (error) {
      pushLog('python_error', {
        script: path.basename(scriptPath),
        error: error.message
      });
      return null;
    }
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
