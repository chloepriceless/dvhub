// services/llm/message-generator.js -- LLM and template message generation (D-13, D-14, D-16).
// Generates German energy messages via Ollama (Tier 3) or template fallback (Tier 1/2).
// Respects daily message limit (T-05-08) and tier gating.
// T-05-06: System prompt is hardcoded (now lives in prompt-templates.BASE_SYSTEM); sensor
//   data enters only via structured "Aktuelle Daten:" user-message field (T-07-07-01).
//
// Phase 07 LLM-02 REVIEWS L:
// - SYSTEM_PROMPT constant MOVED to prompt-templates.BASE_SYSTEM
// - BUILDERS map keyed by MESSAGE_TYPES enum (computed `[MESSAGE_TYPES.X]: buildX`) so
//   keys structurally cannot drift from production enum.
// - Uses Ollama /api/chat (messages array) to properly pass few-shot examples as
//   alternating user/assistant turns -- /api/generate cannot do that.
// - pushLog includes promptVersion for T-07-07-08 version correlation.
// - Rules-fallback (template-fallback.js) UNCHANGED -- D-E2 constraint.

import { generateTemplateMessage, getMessageEmoji } from './template-fallback.js';
import { MESSAGE_TYPES } from './message-types.js';
import {
  PROMPT_VERSION,
  buildNegativePriceAlert,
  buildSocWarning,
  buildSocFull,
  buildNormalStatus,
  buildSavings,
  buildForecastInconsistency,
  buildPvRecord,
  buildLoadForecastInfo,
  buildChargingPlan,
  buildSystemOk
} from './prompt-templates.js';

// REVIEWS L: BUILDERS keyed by MESSAGE_TYPES enum -- keys cannot drift from production enum.
// Computed `[MESSAGE_TYPES.X]: buildX` syntax makes the mapping grep-auditable.
const BUILDERS = {
  [MESSAGE_TYPES.NEGATIVE_PRICE_ALERT]:   buildNegativePriceAlert,
  [MESSAGE_TYPES.SOC_WARNING]:            buildSocWarning,
  [MESSAGE_TYPES.SOC_FULL]:               buildSocFull,
  [MESSAGE_TYPES.NORMAL_STATUS]:          buildNormalStatus,
  [MESSAGE_TYPES.SAVINGS]:                buildSavings,
  [MESSAGE_TYPES.FORECAST_INCONSISTENCY]: buildForecastInconsistency,
  [MESSAGE_TYPES.PV_RECORD]:              buildPvRecord,
  [MESSAGE_TYPES.LOAD_FORECAST_INFO]:     buildLoadForecastInfo,
  [MESSAGE_TYPES.CHARGING_PLAN]:          buildChargingPlan,
  [MESSAGE_TYPES.SYSTEM_OK]:              buildSystemOk
};

// Max tokens for LLM output (bound by num_predict at the ollama-client.chat layer;
// kept here as DEFAULT_MAX_TOKENS for Tier-1/2 callers that still rely on it via cfg).
const DEFAULT_MAX_TOKENS = 200;

/**
 * Build Ollama /api/chat messages array from a prompt-template result.
 * T-05-06: user data only in structured "Aktuelle Daten:" user-turn content.
 *
 * @param {string} type - Message type (MESSAGE_TYPES value)
 * @param {object} data - Structured data for template interpolation
 * @returns {{ messages: Array<{role:string,content:string}>, version: string }}
 */
function buildPromptMessages(type, data) {
  const builder = BUILDERS[type];
  if (!builder) {
    throw new Error(
      `No prompt template for type "${type}" -- expected one of: ${Object.values(MESSAGE_TYPES).join(', ')}`
    );
  }
  const template = builder(data);
  const messages = [{ role: 'system', content: template.system }];
  for (const ex of template.examples) {
    messages.push({ role: 'user', content: ex.user });
    messages.push({ role: 'assistant', content: ex.assistant });
  }
  messages.push({ role: 'user', content: template.user });
  return { messages, version: template.version };
}

/**
 * Create a message generator that uses Ollama (if available) or template fallback.
 *
 * @param {{ ollamaClient: object, getCfg: Function, tier: number, pushLog: Function }} deps
 * @returns {{ generate: Function, generateStatus: Function, generateEvent: Function }}
 */
export function createMessageGenerator({ ollamaClient, getCfg, tier, pushLog }) {
  // Daily message counter for LLM rate limiting (T-05-08)
  let dailyLlmCount = 0;
  let dailyResetDate = new Date().toDateString();

  /**
   * Reset daily counter at midnight.
   */
  function checkDailyReset() {
    const today = new Date().toDateString();
    if (today !== dailyResetDate) {
      dailyLlmCount = 0;
      dailyResetDate = today;
    }
  }

  /**
   * Check if LLM generation is allowed (under daily limit).
   *
   * @returns {boolean}
   */
  function isLlmAllowed() {
    checkDailyReset();
    const cfg = getCfg();
    const maxPerDay = cfg?.llm?.llmMaxMessagesPerDay ?? 20;
    return dailyLlmCount < maxPerDay;
  }

  /**
   * Generate a message for the given type and data.
   * Uses Ollama /api/chat if tier >= 3, client available, builder exists, and under daily limit.
   * Falls back to rules-based template (template-fallback.js, UNCHANGED per D-E2).
   *
   * @param {string} type - Message type (MESSAGE_TYPES value, e.g. 'status', 'savings', 'negative_price', 'soc_full', ...)
   * @param {object} data - Data for message generation
   * @returns {Promise<{ text: string, type: string, source: string, emoji: string, promptVersion?: string }>}
   */
  async function generate(type, data) {
    const emoji = getMessageEmoji(type);
    const hasBuilder = typeof BUILDERS[type] === 'function';

    // Try LLM if tier >= 3, client available, builder exists, and under daily limit.
    // Unknown types skip LLM entirely and fall through to rules (enum-pinning guard, REVIEWS L).
    if (hasBuilder && tier >= 3 && ollamaClient && ollamaClient.isAvailable() && isLlmAllowed()) {
      try {
        const cfg = getCfg();
        const temperature = cfg?.llm?.llmTemperature ?? 0.7;
        const maxTokens = cfg?.llm?.llmMaxTokens ?? DEFAULT_MAX_TOKENS;
        const model = cfg?.llm?.llmModel ?? 'qwen3:4b';

        const { messages, version } = buildPromptMessages(type, data);

        // Prefer /api/chat for few-shot messages array. Fall back to /api/generate path
        // if the client predates Phase 07 (backward compat for any non-Phase-7 callers).
        let text = '';
        if (typeof ollamaClient.chat === 'function') {
          const result = await ollamaClient.chat({
            model,
            messages,
            temperature,
            num_predict: maxTokens
          });
          const raw = result?.message?.content ?? result?.content ?? '';
          text = typeof raw === 'string' ? raw.trim() : '';
        } else {
          // Legacy /api/generate path -- concatenate examples into a single prompt.
          const flattened = messages
            .filter(m => m.role !== 'system')
            .map(m => (m.role === 'user' ? `Nutzer: ${m.content}` : `Assistent: ${m.content}`))
            .join('\n');
          const result = await ollamaClient.generate({
            model,
            prompt: flattened,
            system: messages[0]?.content ?? '',
            temperature,
            num_predict: maxTokens
          });
          const raw = result?.response ?? '';
          text = typeof raw === 'string' ? raw.trim() : '';
        }

        // B-1/LLM-Auswahl (2026-06-10): reasoning models (Qwen3 et al.) prepend a
        // <think>…</think> block before the actual answer. For our short German
        // status lines that reasoning must never leak into the UI. Strip matched
        // blocks, then any dangling text up to a stray closing tag, then trim.
        text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
        if (text.includes('</think>')) {
          text = text.slice(text.lastIndexOf('</think>') + '</think>'.length);
        }
        text = text.trim();

        if (text.length > 0) {
          dailyLlmCount++;
          pushLog('llm_generated', {
            type,
            source: 'llm',
            dailyCount: dailyLlmCount,
            model,
            promptVersion: version,
            length: text.length
          });
          return { text, type, source: 'llm', emoji, promptVersion: version };
        }

        // Empty response -- log for diagnostics so fallback isn't silent
        pushLog('llm_null_response', {
          type,
          model,
          promptVersion: version,
          fallback: 'template'
        });
      } catch (e) {
        pushLog('llm_error', {
          error: e.message,
          type,
          promptVersion: PROMPT_VERSION,
          fallback: 'template'
        });
      }
    }

    // Fallback to rules-based template (template-fallback.js, D-E2 unchanged)
    const text = generateTemplateMessage(type, data);
    return { text, type, source: 'template', emoji };
  }

  /**
   * Generate a status message from live data.
   *
   * @param {object} liveData - Current system data
   * @returns {Promise<object>}
   */
  async function generateStatus(liveData) {
    return generate(MESSAGE_TYPES.NORMAL_STATUS, liveData);
  }

  /**
   * Generate an event-triggered message.
   *
   * @param {string} eventType - Event type (MESSAGE_TYPES value)
   * @param {object} eventData - Event-specific data
   * @returns {Promise<object>}
   */
  async function generateEvent(eventType, eventData) {
    return generate(eventType, eventData);
  }

  return { generate, generateStatus, generateEvent };
}
