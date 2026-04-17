// test/message-generator-mock.test.js -- Phase 07 LLM-02 REVIEWS L.
// Integration test for message-generator.generate() with a stubbed ollama-client.chat().
// Exercises the full /api/chat messages-array path end-to-end without needing a live Ollama.
// Complements the live Golden-Samples tests in llm-prompts.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageGenerator } from '../services/llm/message-generator.js';
import { MESSAGE_TYPES } from '../services/llm/message-types.js';

// Mock ollama-client.chat -- records calls + returns a deterministic German response.
// Mirrors the real /api/chat response shape: { message: { content: string } }.
function createMockOllamaClient(responseText = 'Das Haus läuft ruhig — alles gut.') {
  const calls = [];
  return {
    chat: async ({ model, messages, temperature, num_predict }) => {
      calls.push({ model, messages, temperature, num_predict });
      return { message: { content: responseText } };
    },
    isAvailable: () => true,
    _calls: calls
  };
}

// Minimal deps bundle for createMessageGenerator factory signature.
function createDeps(ollamaClient, opts = {}) {
  const logs = [];
  return {
    deps: {
      ollamaClient,
      getCfg: () => ({
        llm: {
          llmEnabled: true,
          llmModel: opts.model || 'llama3.2',
          llmTemperature: 0.7,
          llmMaxTokens: 120,
          llmMaxMessagesPerDay: 20
        }
      }),
      tier: opts.tier ?? 3,
      pushLog: (event, payload) => logs.push({ event, payload })
    },
    _logs: logs
  };
}

test('generate(NORMAL_STATUS) calls ollamaClient.chat with messages array (system + few-shot pairs + user)', async () => {
  const mockOllama = createMockOllamaClient();
  const { deps } = createDeps(mockOllama);
  const gen = createMessageGenerator(deps);

  const result = await gen.generate(MESSAGE_TYPES.NORMAL_STATUS, {
    socPercent: 50, pvKw: 2.5, loadKw: 1.0
  });

  assert.ok(result, 'result is defined');
  assert.equal(typeof result.text, 'string', 'result.text is a string');
  assert.ok(result.text.length > 0, 'result.text is non-empty');
  assert.equal(result.source, 'llm', 'source=llm when Ollama returns text');
  assert.equal(mockOllama._calls.length, 1, 'ollamaClient.chat called exactly once');

  const { messages } = mockOllama._calls[0];
  assert.ok(Array.isArray(messages), 'messages is an array');
  // system + (2 example pairs = 4) + final user = 6 messages minimum
  assert.ok(messages.length >= 6, `expected >=6 messages (1 system + 2 few-shot pairs + 1 user), got ${messages.length}`);
  assert.equal(messages[0].role, 'system', 'first message is system');
  assert.equal(messages[messages.length - 1].role, 'user', 'last message is user');
  // Verify alternating user/assistant in the middle (few-shot)
  assert.equal(messages[1].role, 'user', 'second message is few-shot user');
  assert.equal(messages[2].role, 'assistant', 'third message is few-shot assistant');
});

test('generate pushLog includes promptVersion field', async () => {
  const mockOllama = createMockOllamaClient();
  const bundle = createDeps(mockOllama);
  const gen = createMessageGenerator(bundle.deps);

  await gen.generate(MESSAGE_TYPES.SOC_WARNING, { socPercent: 20, remainingHours: 2 });

  const llmGenerated = bundle._logs.find(l => l.event === 'llm_generated');
  assert.ok(llmGenerated, 'pushLog("llm_generated", ...) was called');
  assert.ok(llmGenerated.payload.promptVersion, 'promptVersion included in llm_generated payload');
  assert.equal(typeof llmGenerated.payload.promptVersion, 'string', 'promptVersion is a string');
});

test('generate result includes promptVersion on successful LLM path', async () => {
  const mockOllama = createMockOllamaClient('Eine kurze, freundliche deutsche Antwort.');
  const { deps } = createDeps(mockOllama);
  const gen = createMessageGenerator(deps);

  const result = await gen.generate(MESSAGE_TYPES.NEGATIVE_PRICE_ALERT, { priceCtKwh: -2.5, until: '14:00' });
  assert.equal(result.source, 'llm');
  assert.ok(result.promptVersion, 'promptVersion propagated to result on LLM success');
});

test('generate falls back to rules-template on ollama chat error (source=template)', async () => {
  const failingOllama = {
    chat: async () => { throw new Error('ollama_down'); },
    isAvailable: () => true
  };
  const bundle = createDeps(failingOllama);
  const gen = createMessageGenerator(bundle.deps);

  const result = await gen.generate(MESSAGE_TYPES.SOC_WARNING, { socPercent: 20, remainingHours: 2 });
  assert.equal(result.source, 'template', 'should fall through to rules template (D-E2, UNCHANGED path)');
  assert.ok(result.text, 'fallback produces non-empty text');

  const llmError = bundle._logs.find(l => l.event === 'llm_error');
  assert.ok(llmError, 'pushLog("llm_error", ...) recorded the failure');
});

test('generate with unknown type falls back to rules without hitting Ollama (enum-pinning guard)', async () => {
  const mockOllama = createMockOllamaClient();
  const bundle = createDeps(mockOllama);
  const gen = createMessageGenerator(bundle.deps);

  // Type not in MESSAGE_TYPES -- must fall through to rules, NOT hit Ollama.
  const result = await gen.generate('unknown_type_xxx', {});
  assert.equal(result.source, 'template', 'unknown type routes to rules template');
  assert.equal(mockOllama._calls.length, 0, 'ollama.chat NOT called for unknown type (REVIEWS L enum guard)');
});

test('generate passes num_predict=120 to ollamaClient.chat (Pitfall LLM-3 token budget)', async () => {
  const mockOllama = createMockOllamaClient();
  const { deps } = createDeps(mockOllama);
  const gen = createMessageGenerator(deps);

  await gen.generate(MESSAGE_TYPES.NORMAL_STATUS, { socPercent: 50, pvKw: 2.0, loadKw: 1.0 });
  const call = mockOllama._calls[0];
  assert.equal(call.num_predict, 120, 'num_predict=120 passed through (T-07-07-03)');
});
