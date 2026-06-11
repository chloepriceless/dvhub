// services/llm/ollama-client.js -- Ollama REST API client (D-11, D-12).
// Communicates with Ollama on localhost:11434 for TinyLlama inference.
// Tier 3 only. Never throws -- returns null on errors.
// Uses node:http for Node 18 compatibility (no native fetch required).
// T-05-07: baseUrl hardcoded to 127.0.0.1, no user-configurable host.

import http from 'node:http';
// Plan 09-07: safeInterval reserved import — ollama-client currently has 0
// setInterval call sites (the lone setTimeout is per-request HTTP timeout).
// Import kept so any future reconnect ticker or model-load watcher inherits
// the helper. Auditable via grep "from '../safe-async.js'".
// eslint-disable-next-line no-unused-vars
import { safeInterval } from '../safe-async.js';

/**
 * Create an Ollama REST API client.
 *
 * @param {{ baseUrl?: string, timeoutMs?: number }} options
 * @returns {{ generate: Function, checkHealth: Function, isAvailable: Function }}
 */
export function createOllamaClient({ baseUrl = 'http://127.0.0.1:11434', timeoutMs = 90000, pushLog = null } = {}) {
  let available = null; // null = unknown, true/false after health check
  const debugEnabled = process.env.OLLAMA_DEBUG === '1';

  /**
   * Make an HTTP request using node:http. Returns parsed JSON or null on error.
   *
   * 2026-05-11: `agent: false` forces a fresh TCP connection per call.
   * Symptom that pushed this: two sequential /api/chat calls — the first
   * succeeds, the second returns `done_reason: 'load'` with empty content
   * in <200 ms. Direct curl with the exact same body works (curl never
   * reuses sockets across invocations). Strong evidence the global HTTP
   * agent's keep-alive reuse is interacting badly with Ollama's request
   * handling on this back-to-back path; fresh sockets matches curl behavior.
   *
   * @param {string} method - HTTP method
   * @param {string} urlPath - URL path (e.g., '/api/generate')
   * @param {object|null} body - Request body (JSON-serialized)
   * @param {number} timeout - Timeout in ms
   * @returns {Promise<object|null>}
   */
  function httpRequest(method, urlPath, body, timeout) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      try {
        const url = new URL(urlPath, baseUrl);
        const options = {
          hostname: url.hostname,
          port: url.port || 11434,
          path: url.pathname,
          method,
          headers: {},
          agent: false
        };

        let payload = null;
        if (body) {
          payload = JSON.stringify(body);
          options.headers['Content-Type'] = 'application/json';
          options.headers['Content-Length'] = Buffer.byteLength(payload);
        }

        const req = http.request(options, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            const elapsedMs = Date.now() - startedAt;
            let parsed = null;
            try { parsed = JSON.parse(data); } catch { /* parsed stays null */ }
            if (debugEnabled && pushLog) {
              try {
                pushLog('ollama_http', {
                  method,
                  urlPath,
                  status: res.statusCode,
                  elapsedMs,
                  reqBytes: payload ? Buffer.byteLength(payload) : 0,
                  resBytes: Buffer.byteLength(data),
                  done_reason: parsed?.done_reason ?? null,
                  eval_count: parsed?.eval_count ?? null,
                  prompt_eval_count: parsed?.prompt_eval_count ?? null,
                  contentLen: typeof parsed?.message?.content === 'string'
                    ? parsed.message.content.length
                    : null
                });
              } catch { /* logging must never break the request */ }
            }
            resolve(parsed);
          });
        });

        req.on('error', () => resolve(null));

        // Timeout via setTimeout + req.destroy()
        const timer = setTimeout(() => {
          req.destroy();
          resolve(null);
        }, timeout);

        req.on('close', () => clearTimeout(timer));

        if (payload) {
          req.write(payload);
        }
        req.end();
      } catch {
        resolve(null);
      }
    });
  }

  /**
   * Generate text via Ollama API.
   * POST /api/generate with stream: false.
   * T-05-06: System prompt is hardcoded; user data in structured field only.
   *
   * @param {{ model: string, prompt: string, system?: string, temperature?: number, num_predict?: number }} params
   * @returns {Promise<{ response: string }|null>}
   */
  async function generate({ model, prompt, system, temperature, num_predict }) {
    const body = {
      model,
      prompt,
      stream: false,
      // Disable reasoning. Qwen3/Qwen3.5 (and other thinking models) otherwise spend
      // the entire num_predict budget inside a <think>…</think> block and return an
      // EMPTY final answer for our short status prompts (→ llm_null_response → template
      // fallback). Non-thinking models ignore this field. (Go-Live-Review 2026-06-11.)
      think: false,
      options: {}
    };
    if (system) body.system = system;
    if (temperature != null) body.options.temperature = temperature;
    if (num_predict != null) body.options.num_predict = num_predict;

    const result = await httpRequest('POST', '/api/generate', body, timeoutMs);
    if (result && typeof result.response === 'string') {
      return result;
    }
    return null;
  }

  /**
   * Generate text via Ollama /api/chat with a messages array (system + few-shot pairs + user).
   * Phase 07 LLM-02: replaces /api/generate for Phase-7 callers that pass few-shot examples.
   * /api/generate cannot natively express alternating user/assistant turns for few-shot;
   * /api/chat accepts messages: [{role, content}, ...] which is the correct shape.
   * T-07-07-03 mitigation: num_predict hard-caps output length (default 120).
   *
   * @param {{ model: string, messages: Array<{role:string,content:string}>, temperature?: number, num_predict?: number, options?: object }} params
   * @returns {Promise<{ message?: { content: string } }|null>}
   */
  async function chat({ model, messages, temperature, num_predict, options }) {
    const body = {
      model,
      messages,
      stream: false,
      // Disable reasoning — see generate() above. Qwen3.5's <think> block would
      // otherwise eat the whole token budget and yield an empty answer for the
      // short status messages. Non-thinking models ignore this. (2026-06-11.)
      think: false,
      options: {
        num_predict: num_predict ?? 120,   // Pitfall LLM-3 token budget (T-07-07-03)
        ...(temperature != null ? { temperature } : {}),
        ...(options || {})
      }
    };

    const result = await httpRequest('POST', '/api/chat', body, timeoutMs);
    if (result && result.message && typeof result.message.content === 'string') {
      return result;
    }
    // Permit minimal-shape responses too (alternate server impls returning {content})
    if (result && typeof result.content === 'string') return result;
    return null;
  }

  /**
   * Check Ollama health. GET / — returns true if status 200.
   * Updates the cached availability flag.
   *
   * @returns {Promise<boolean>}
   */
  async function checkHealth() {
    // Use /api/tags which returns JSON {models: [...]}; the root / returns plain text.
    const result = await httpRequest('GET', '/api/tags', null, 5000);
    available = result != null && typeof result === 'object';
    return available;
  }

  /**
   * List available Ollama models via GET /api/tags.
   * T-06-08: 10s timeout, returns empty array on error (graceful degradation).
   *
   * @returns {Promise<Array<{ name: string, size: number, modified_at: string, family: string|null, parameter_size: string|null }>>}
   */
  async function list() {
    const result = await httpRequest('GET', '/api/tags', null, 10000);
    if (!result || !Array.isArray(result.models)) return [];
    return result.models.map(m => ({
      name: m.name,
      size: m.size,
      modified_at: m.modified_at,
      family: m.details?.family || null,
      parameter_size: m.details?.parameter_size || null
    }));
  }

  /**
   * Get cached availability status.
   * null = unknown (no health check run yet), true/false after checkHealth().
   *
   * @returns {boolean|null}
   */
  function isAvailable() {
    return available;
  }

  return { generate, chat, checkHealth, isAvailable, list };
}
