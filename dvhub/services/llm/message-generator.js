// services/llm/message-generator.js -- LLM and template message generation (D-13, D-14, D-16).
// Generates German energy messages via Ollama (Tier 3) or template fallback (Tier 1/2).
// Respects daily message limit (T-05-08) and tier gating.
// T-05-06: System prompt is hardcoded constant; sensor data in structured field only.

import { generateTemplateMessage, getMessageEmoji } from './template-fallback.js';

// Hardcoded German system prompt -- never user-configurable (T-05-06)
const SYSTEM_PROMPT =
  'Du bist der Energie-Assistent eines Haushalts mit Photovoltaik und Batteriespeicher. ' +
  'Antworte in einem kurzen, freundlichen Satz auf Deutsch. ' +
  'Keine Emojis, keine Aufzaehlungen — nur ein natuerlicher Satz.';

// Maximum tokens for LLM output (T-05-06: truncate to prevent excessive output)
const DEFAULT_MAX_TOKENS = 200;

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
   * Build the data prompt for Ollama from structured data.
   * T-05-06: User data only appears in "Aktuelle Daten:" field.
   *
   * @param {string} type - Message type
   * @param {object} data - Structured data
   * @returns {string}
   */
  function buildDataPrompt(type, data) {
    const parts = [];
    if (data.pvW != null) parts.push(`PV ${data.pvW}W`);
    if (data.soc != null) parts.push(`Batterie ${data.soc}%`);
    if (data.gridW != null) parts.push(`Netzimport ${data.gridW}W`);
    if (data.price != null) parts.push(`Strompreis ${data.price} ct/kWh`);
    if (data.pvTodayKwh != null) parts.push(`PV heute ${data.pvTodayKwh} kWh`);
    if (data.consumedKwh != null) parts.push(`Verbrauch ${data.consumedKwh} kWh`);
    if (data.until != null) parts.push(`bis ${data.until}`);

    const dataStr = parts.length > 0 ? parts.join(', ') : 'keine Daten';
    return `Aktuelle Daten: ${dataStr}. Erstelle eine kurze ${type}-Nachricht.`;
  }

  /**
   * Generate a message for the given type and data.
   * Uses Ollama if tier >= 3, available, and under daily limit.
   * Otherwise falls back to template.
   *
   * @param {string} type - Message type (status, savings, alert, pv_record, negative_price)
   * @param {object} data - Data for message generation
   * @returns {Promise<{ text: string, type: string, source: string, emoji: string }>}
   */
  async function generate(type, data) {
    const emoji = getMessageEmoji(type);

    // Try LLM if tier >= 3, client available, and under daily limit
    if (tier >= 3 && ollamaClient && ollamaClient.isAvailable() && isLlmAllowed()) {
      try {
        const cfg = getCfg();
        const temperature = cfg?.llm?.llmTemperature ?? 0.7;
        const maxTokens = cfg?.llm?.llmMaxTokens ?? DEFAULT_MAX_TOKENS;

        const result = await ollamaClient.generate({
          model: cfg?.llm?.llmModel ?? 'tinyllama',
          prompt: buildDataPrompt(type, data),
          system: SYSTEM_PROMPT,
          temperature,
          num_predict: maxTokens
        });

        if (result && result.response && result.response.trim().length > 0) {
          dailyLlmCount++;
          pushLog('llm_generated', { type, source: 'llm', dailyCount: dailyLlmCount });
          return { text: result.response.trim(), type, source: 'llm', emoji };
        }
      } catch (e) {
        pushLog('llm_error', { error: e.message, type, fallback: 'template' });
      }
    }

    // Fallback to template
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
    return generate('status', liveData);
  }

  /**
   * Generate an event-triggered message.
   *
   * @param {string} eventType - Event type (alert, pv_record, negative_price, savings)
   * @param {object} eventData - Event-specific data
   * @returns {Promise<object>}
   */
  async function generateEvent(eventType, eventData) {
    return generate(eventType, eventData);
  }

  return { generate, generateStatus, generateEvent };
}
