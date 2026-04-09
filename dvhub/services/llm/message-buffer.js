// services/llm/message-buffer.js -- In-memory ring buffer for LLM messages.
// Stores last 24h of messages (per D-18). No DB persistence.
// Oldest messages are discarded on cleanup.

import { randomUUID } from 'node:crypto';

/**
 * Create an in-memory message buffer with time-based eviction.
 *
 * @param {{ maxAgeMs?: number }} options - Maximum message age in milliseconds (default: 24h)
 * @returns {{ add: Function, getAll: Function, getLatest: Function, getCount: Function, cleanup: Function, clear: Function }}
 */
export function createMessageBuffer({ maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  /** @type {Array<{ id: string, ts: number, [key: string]: any }>} */
  let messages = [];

  /** Remove messages older than maxAgeMs. */
  function cleanup() {
    const cutoff = Date.now() - maxAgeMs;
    messages = messages.filter(m => m.ts > cutoff);
  }

  /**
   * Add a message to the buffer. Auto-generates id and timestamp.
   * Runs cleanup after adding.
   *
   * @param {object} msg - Message object (must include at least text and type)
   */
  function add(msg) {
    messages.unshift({ id: randomUUID(), ts: Date.now(), ...msg });
    cleanup();
  }

  /**
   * Get all messages, newest first. Runs cleanup before returning.
   *
   * @returns {Array<object>} Shallow copy of messages array
   */
  function getAll() {
    cleanup();
    return [...messages];
  }

  /**
   * Get the most recent message, or null if buffer is empty.
   *
   * @returns {object|null}
   */
  function getLatest() {
    return messages[0] || null;
  }

  /**
   * Get current buffer length.
   *
   * @returns {number}
   */
  function getCount() {
    return messages.length;
  }

  /** Empty the buffer. */
  function clear() {
    messages = [];
  }

  return { add, getAll, getLatest, getCount, cleanup, clear };
}
