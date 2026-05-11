// services/llm/index.js -- LLM service factory (D-11 to D-18).
// Factory pattern: createLlmService(ctx) -> { start, close, generateMessage, getMessages, getLatest, getMessageCount }
// Wires Ollama client, message generator, and ring buffer.
// Tier gating: LLM features require tier >= 2 and llmEnabled config.
// Timer generates hourly status messages when active.

import { createOllamaClient } from './ollama-client.js';
import { createMessageGenerator } from './message-generator.js';
import { createMessageBuffer } from './message-buffer.js';
// Plan 09-07: shared safeInterval wraps the hourly status-message ticker.
// The async callback's try/catch already pushLogs on inner errors; safeInterval
// is the belt to its braces — protects against new error paths added later.
import { safeInterval } from '../safe-async.js';

/**
 * Create the LLM service.
 *
 * @param {object} ctx - DI context { getCfg, state, pushLog, tier }
 * @returns {{ start: Function, close: Function, generateMessage: Function, getMessages: Function, getLatest: Function, getMessageCount: Function }}
 */
export function createLlmService(ctx) {
  const { getCfg, state, pushLog } = ctx;
  // Tier comes from forecast service (wired first in server.js); fall back to ctx.tier for standalone tests
  const tier = ctx.forecastService?.tier ?? ctx.tier ?? 1;

  // Create Ollama client (T-05-07: hardcoded to localhost)
  const ollamaClient = createOllamaClient();

  // Create message generator with tier gating
  const generator = createMessageGenerator({ ollamaClient, getCfg, tier, pushLog });

  // Create ring buffer (D-18: 24h in-memory)
  const buffer = createMessageBuffer({ maxAgeMs: 86400000 });

  let statusTimer = null;

  /**
   * Start the LLM service.
   * If tier >= 3, checks Ollama health.
   * Sets up hourly status message timer if enabled.
   */
  async function start() {
    const cfg = getCfg();
    const llmCfg = cfg?.llm || {};

    // Skip if disabled or tier too low
    if (tier < 2 || !llmCfg.llmEnabled) {
      pushLog('llm_init', { tier, enabled: false, reason: tier < 2 ? 'tier_too_low' : 'disabled' });
      return;
    }

    pushLog('llm_init', { tier, enabled: true });

    // Check Ollama health on Tier 3
    if (tier >= 3) {
      try {
        const healthy = await ollamaClient.checkHealth();
        pushLog('llm_health', { ollamaAvailable: healthy });
      } catch (e) {
        pushLog('llm_error', { error: e.message, context: 'health_check' });
      }
    }

    // Set up hourly status message timer (D-13)
    const intervalMin = llmCfg.llmStatusIntervalMin ?? 60;
    const intervalMs = intervalMin * 60 * 1000;

    statusTimer = safeInterval('llm.status', async () => {
      try {
        // Gather live data from state
        const liveData = buildLiveData();
        const msg = await generator.generateStatus(liveData);
        buffer.add(msg);
        pushLog('llm_status_generated', { source: msg.source, type: msg.type });
      } catch (e) {
        pushLog('llm_error', { error: e.message, context: 'status_timer' });
      }
    }, intervalMs);

    pushLog('llm_started', { tier, intervalMin, ollamaAvailable: ollamaClient.isAvailable() });
  }

  /**
   * Build live data object from current state for status messages.
   *
   * @returns {object}
   */
  function buildLiveData() {
    const v = state?.victron || {};
    const epex = state?.epex?.data;
    const now = Date.now();

    // Find current price slot
    let currentPrice = null;
    if (Array.isArray(epex)) {
      const slot = epex.find(s => {
        const ts = Number(s.ts);
        return ts <= now && now < ts + 15 * 60 * 1000;
      });
      if (slot) currentPrice = slot.ct_kwh;
    }

    return {
      pvW: v.pvW ?? null,
      soc: v.soc ?? null,
      gridW: v.gridW ?? null,
      pvTodayKwh: v.pvTodayKwh ?? null,
      consumedKwh: v.consumedKwh ?? null,
      price: currentPrice
    };
  }

  /**
   * Graceful shutdown. Clear timers and log.
   * Async so callers can use `.catch()` uniformly with other services.
   */
  async function close() {
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
    pushLog('llm_service_closed', {});
  }

  /**
   * Generate a message, add to buffer, and return it.
   * Works on all tiers (template fallback on Tier 1/2).
   *
   * @param {string} type - Message type
   * @param {object} data - Data for message generation
   * @returns {Promise<object>}
   */
  async function generateMessage(type, data) {
    try {
      const msg = await generator.generate(type, data);
      buffer.add(msg);
      return msg;
    } catch (e) {
      pushLog('llm_error', { error: e.message, context: 'generateMessage' });
      // Return a safe fallback
      const fallback = { text: '', type, source: 'error', emoji: '' };
      return fallback;
    }
  }

  /**
   * Get all messages from the buffer (newest first).
   *
   * @returns {Array<object>}
   */
  function getMessages() {
    return buffer.getAll();
  }

  /**
   * Get the most recent message, or null.
   *
   * @returns {object|null}
   */
  function getLatest() {
    return buffer.getLatest();
  }

  /**
   * Get current message count in buffer.
   *
   * @returns {number}
   */
  function getMessageCount() {
    return buffer.getCount();
  }

  return { start, close, generateMessage, getMessages, getLatest, getMessageCount, listModels: () => ollamaClient.list() };
}
