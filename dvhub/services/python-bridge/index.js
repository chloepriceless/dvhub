// python-bridge/index.js -- Node.js bridge for Python child_process invocation.
// Available when the forecast venv is installed (pythonEnvStatus); the RAM
// tiers that used to gate it were removed 2026-10-03.
// Spawns Python scripts via execFile, passes JSON via stdin, reads JSON from stdout.
// Batch mode: spawn, compute, exit per invocation.

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENV_DIR = '/opt/dvhub/forecast-venv';
const VENV_PYTHON = path.join(VENV_DIR, 'bin', 'python3');
const MIN_FREE_MB_FOR_SPAWN = 500;
// Top-level-Module, die die Skripte in scripts/ importieren. Der Interpreter
// allein genügt nicht: scheitert der pip-Lauf von forecast-provision.sh (z. B.
// Python zu alt für das Lockfile, kein PyPI), bleibt ein venv OHNE Pakete
// zurück — im Feld sah das wie „Python vorhanden" aus und jedes Skript starb mit
// ModuleNotFoundError (Kundenfall deye1, 2026-10-06).
const REQUIRED_MODULES = ['numpy', 'pandas', 'pvlib', 'statsforecast'];
const ENV_INCOMPLETE_LOG_DEDUP_MS = 60 * 60 * 1000;

/**
 * Zustand der Forecast-Python-Umgebung — reiner Dateisystem-Blick (kein Spawn),
 * billig genug für jeden Aufruf.
 * @returns {{ ok: boolean, reason: null|'no_venv'|'packages_missing', missing: string[] }}
 */
export function pythonEnvStatus(venvDir = VENV_DIR) {
  if (!fs.existsSync(path.join(venvDir, 'bin', 'python3'))) {
    return { ok: false, reason: 'no_venv', missing: [...REQUIRED_MODULES] };
  }
  let sitePackages = [];
  try {
    sitePackages = fs.readdirSync(path.join(venvDir, 'lib'))
      .filter((d) => d.startsWith('python3'))
      .map((d) => path.join(venvDir, 'lib', d, 'site-packages'));
  } catch { /* kein lib/ → alles fehlt */ }
  const missing = REQUIRED_MODULES.filter((m) => !sitePackages.some((sp) => fs.existsSync(path.join(sp, m))));
  return missing.length
    ? { ok: false, reason: 'packages_missing', missing }
    : { ok: true, reason: null, missing: [] };
}

/**
 * Was forecast-provision.sh zuletzt gemeldet hat (Grund eines Fehlschlags),
 * oder null. Datei: $DV_DATA_DIR/forecast-venv-status.json.
 */
export function readProvisionStatus(dataDir = process.env.DV_DATA_DIR || '/var/lib/dvhub') {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'forecast-venv-status.json'), 'utf8'));
  } catch {
    return null;
  }
}


/**
 * Create a Python bridge for invoking Python scripts as child processes.
 *
 * @param {object} ctx - DI context { state, getCfg, pushLog }
 * @returns {{ call: Function, start: Function, close: Function }}
 */
export function createPythonBridge(ctx) {
  const { pushLog } = ctx;
  let envIncompleteLoggedAt = 0;

  /**
   * Call a Python script with JSON input data.
   * Returns parsed JSON output or null on error.
   *
   * @param {string} scriptPath - Absolute path to the Python script
   * @param {object} inputData - JSON-serializable input data (passed via stdin)
   * @returns {Promise<object|null>} Parsed JSON output or null on error
   */
  // Review 2026-06-10 (P2-10): callers (load-forecast 120s)
  // always passed a third timeout argument that this signature silently
  // dropped — StatsForecast ran against the 60s default and timed out on
  // larger datasets. Honour the caller's timeout when provided.
  async function call(scriptPath, inputData, callerTimeoutMs) {
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
    // Interpreter da, Pakete (noch) nicht: nicht spawnen — das gäbe pro Lauf nur
    // einen ModuleNotFoundError-Traceback. Bei jedem Aufruf neu geprüft, damit
    // die Bridge von selbst greift, sobald die Hintergrund-Provisionierung
    // fertig ist; gemeldet höchstens 1×/h, mit dem Grund aus forecast-provision.sh.
    const env = pythonEnvStatus();
    if (ctx.state?.forecast) ctx.state.forecast.pythonAvailable = env.ok;
    if (!env.ok) {
      const now = Date.now();
      if (now - envIncompleteLoggedAt > ENV_INCOMPLETE_LOG_DEDUP_MS) {
        envIncompleteLoggedAt = now;
        const prov = readProvisionStatus();
        pushLog('python_env_incomplete', {
          script: path.basename(scriptPath),
          missing: env.missing,
          provisionReason: prov?.reason ?? null,
          provisionDetail: prov?.detail ?? null,
          hint: 'sudo bash /opt/dvhub/forecast-provision.sh --force',
        }, 'warn');
      }
      return null;
    }
    envIncompleteLoggedAt = 0;

    const stdinStr = JSON.stringify(inputData);
    const timeoutMs = (Number.isFinite(Number(callerTimeoutMs)) && Number(callerTimeoutMs) > 0)
      ? Number(callerTimeoutMs)
      : 60_000;

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
   * Async no-op (batch mode has no long-running process).
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
