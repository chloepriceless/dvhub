// services/llm/ollama-client.js -- Ollama REST API client (D-11, D-12).
// Communicates with Ollama on localhost:11434 for TinyLlama inference.
// Tier 3 only. Never throws -- returns null on errors.
// Uses node:http for Node 18 compatibility (no native fetch required).
// T-05-07: baseUrl hardcoded to 127.0.0.1, no user-configurable host.

import http from 'node:http';

/**
 * Create an Ollama REST API client.
 *
 * @param {{ baseUrl?: string, timeoutMs?: number }} options
 * @returns {{ generate: Function, checkHealth: Function, isAvailable: Function }}
 */
export function createOllamaClient({ baseUrl = 'http://127.0.0.1:11434', timeoutMs = 15000 } = {}) {
  let available = null; // null = unknown, true/false after health check

  /**
   * Make an HTTP request using node:http. Returns parsed JSON or null on error.
   *
   * @param {string} method - HTTP method
   * @param {string} urlPath - URL path (e.g., '/api/generate')
   * @param {object|null} body - Request body (JSON-serialized)
   * @param {number} timeout - Timeout in ms
   * @returns {Promise<object|null>}
   */
  function httpRequest(method, urlPath, body, timeout) {
    return new Promise((resolve) => {
      try {
        const url = new URL(urlPath, baseUrl);
        const options = {
          hostname: url.hostname,
          port: url.port || 11434,
          path: url.pathname,
          method,
          headers: {}
        };

        if (body) {
          const payload = JSON.stringify(body);
          options.headers['Content-Type'] = 'application/json';
          options.headers['Content-Length'] = Buffer.byteLength(payload);
        }

        const req = http.request(options, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve(null);
            }
          });
        });

        req.on('error', () => resolve(null));

        // Timeout via setTimeout + req.destroy()
        const timer = setTimeout(() => {
          req.destroy();
          resolve(null);
        }, timeout);

        req.on('close', () => clearTimeout(timer));

        if (body) {
          req.write(JSON.stringify(body));
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
   * Check Ollama health. GET / — returns true if status 200.
   * Updates the cached availability flag.
   *
   * @returns {Promise<boolean>}
   */
  async function checkHealth() {
    const result = await httpRequest('GET', '/', null, 5000);
    available = result != null;
    return available;
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

  return { generate, checkHealth, isAvailable };
}
