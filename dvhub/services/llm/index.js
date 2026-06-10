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
import { buildTileFriendlies, PROMPT_VERSION } from './prompt-templates.js';

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

  // Create Ollama client. B-1 (Go-Live-Review 2026-06-10): the config field
  // llm.llmOllamaUrl existed (config-model.js) but was never passed through —
  // createOllamaClient defaulted to 127.0.0.1:11434 regardless, so the GUI knob
  // was a no-op. Wire it: an operator running Ollama on a beefier box can now
  // point DVhub at it. Empty/unset → undefined → the client's loopback default
  // applies (unchanged behaviour). install.sh still binds the LOCAL Ollama to
  // 127.0.0.1; this only changes which URL DVhub *calls*.
  // Pass pushLog so OLLAMA_DEBUG=1 captures per-call diagnostics into audit_log.
  const ollamaClient = createOllamaClient({
    pushLog,
    baseUrl: getCfg()?.llm?.llmOllamaUrl || undefined
  });

  // Create message generator with tier gating
  const generator = createMessageGenerator({ ollamaClient, getCfg, tier, pushLog });

  // Create ring buffer (D-18: 24h in-memory)
  const buffer = createMessageBuffer({ maxAgeMs: 86400000 });

  let statusTimer = null;
  let tileFriendliesCache = null;  // { solar, home, battery, ev, grid, ts }

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

    // Generate one message early so the family dashboard isn't blank after
    // service restarts (the buffer is in-memory and wiped on every restart).
    // Wait 60s for Victron polling + EPEX fetch + forecast service to settle,
    // then generate immediately rather than waiting for the first interval tick.
    setTimeout(async () => {
      try {
        const msg = await generator.generateStatus(buildLiveData());
        buffer.add(msg);
        pushLog('llm_status_generated', { source: msg.source, type: msg.type, trigger: 'startup' });
      } catch (e) {
        pushLog('llm_error', { error: e.message, context: 'startup_message' });
      }
      // Sequential: Ollama serves one model worker — running two long-context
      // chat calls in parallel race for the slot and one usually returns empty.
      try {
        await generateTileFriendlies();
      } catch (e) {
        pushLog('llm_error', { error: e.message, context: 'startup_tile_friendlies' });
      }
    }, 60000).unref();

    statusTimer = safeInterval('llm.status', async () => {
      try {
        // Gather live data from state
        const liveData = buildLiveData();
        const msg = await generator.generateStatus(liveData);
        buffer.add(msg);
        pushLog('llm_status_generated', { source: msg.source, type: msg.type });
        // Run tile-friendlies regeneration sequentially after status (Ollama
        // serves one worker — parallel requests starve and return empty).
        try {
          await generateTileFriendlies();
        } catch (tfErr) {
          pushLog('llm_error', { error: tfErr.message, context: 'tile_friendlies' });
        }
      } catch (e) {
        pushLog('llm_error', { error: e.message, context: 'status_timer' });
      }
    }, intervalMs);

    pushLog('llm_started', { tier, intervalMin, ollamaAvailable: ollamaClient.isAvailable() });
  }

  /**
   * Build the structured "Aktuelle Daten:" payload the tile-friendly prompt
   * expects, then call Ollama with the JSON-output template and parse the
   * result. On any failure (Ollama down, JSON unparseable, tier too low,
   * llmEnabled false), the cache stays untouched and the family-service
   * falls back to its rule-based friendly strings.
   *
   * @returns {Promise<{solar:string, home:string, battery:string, ev:string, grid:string, ts:number} | null>}
   */
  async function generateTileFriendlies() {
    const cfg = getCfg();
    if (tier < 3 || !cfg?.llm?.llmEnabled || !ollamaClient.isAvailable()) return null;

    const v = state?.victron || {};
    const epex = state?.epex?.data;
    const ev = state?.ev || {};
    const now = Date.now();

    // Find current price slot
    let priceCtKwh = state?.costs?.priceNowCtKwh ?? null;
    if (priceCtKwh == null && Array.isArray(epex)) {
      const slot = epex.find(s => Number(s.ts) <= now && now < Number(s.ts) + 15 * 60 * 1000);
      if (slot) priceCtKwh = slot.ct_kwh;
    }

    const pvW = v.pvTotalW ?? v.pvPowerW ?? 0;
    const homeW = v.selfConsumptionW ?? 0;
    const batPowW = v.batteryPowerW ?? 0;
    const gridImport = v.gridImportW ?? 0;
    const gridExport = v.gridExportW ?? 0;
    const netGridW = gridImport - gridExport;
    const evPowW = ev.powerKw != null ? Math.round(ev.powerKw * 1000) : 0;
    const toKw = (w) => Math.round(w / 100) / 10;

    const promptData = {
      solarKw: toKw(pvW),
      homeKw: toKw(homeW),
      batteryPct: v.soc ?? 0,
      batteryMode: batPowW > 50 ? 'laedt' : batPowW < -50 ? 'entlaedt' : 'haelt',
      batteryPowerKw: toKw(Math.abs(batPowW)),
      evMode: evPowW > 50 ? 'laedt' : 'parkt',
      evPowerKw: evPowW > 50 ? toKw(evPowW) : null,
      evFinishHm: ev.finishEstIso ? new Date(ev.finishEstIso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : null,
      gridDirection: netGridW < 0 ? 'speist ein' : netGridW > 0 ? 'bezieht' : 'neutral',
      gridKw: toKw(Math.abs(netGridW)),
      priceCtKwh: priceCtKwh != null ? Number(priceCtKwh).toFixed(1) : 'unbekannt'
    };

    try {
      // buildTileFriendlies returns the shared template shape
      // { version, system, user, examples } — NOT a ready-made `messages`
      // array. The previous `const { messages } = buildTileFriendlies(...)`
      // destructure pulled `undefined`, which JSON.stringify omits entirely,
      // and Ollama then receives a chat request with no messages, loads the
      // model, and returns done_reason:'load' with empty content (86-byte
      // request bodies in the audit log proved this).
      // Convert the same way message-generator.buildPromptMessages does.
      const template = buildTileFriendlies(promptData);
      const messages = [{ role: 'system', content: template.system }];
      for (const ex of template.examples) {
        messages.push({ role: 'user', content: ex.user });
        messages.push({ role: 'assistant', content: ex.assistant });
      }
      messages.push({ role: 'user', content: template.user });
      const chatArgs = {
        model: cfg?.llm?.llmModel ?? 'qwen3.5:2b',
        messages,
        temperature: cfg?.llm?.llmTemperature ?? 0.7,
        num_predict: 240  // 5 short sentences + JSON syntax fits comfortably
      };
      let result = await ollamaClient.chat(chatArgs);
      // Ollama returns done_reason: "load" + empty content when the model
      // wasn't resident — the call kicks off the load but produces nothing.
      // Wait long enough for the load to finish (3B model ≈ 4-6s on Pi),
      // then retry once. Mirrors the standard "warm up & retry" pattern.
      if (result?.done_reason === 'load') {
        pushLog('llm_tile_retry_after_load', { firstAttemptEmpty: true });
        await new Promise((r) => setTimeout(r, 6000));
        result = await ollamaClient.chat(chatArgs);
      }
      const raw = (result?.message?.content ?? result?.content ?? '').trim();
      // Extract first {...} block — model sometimes prefixes/suffixes prose.
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) {
        pushLog('llm_tile_parse_fail', {
          reason: 'no_json_block',
          rawLen: raw.length,
          sample: raw.slice(0, 200),
          done_reason: result?.done_reason,
          messageKeys: Object.keys(result?.message || {}),
          messageRole: result?.message?.role,
          messagePreview: typeof result?.message?.content === 'string' ? result.message.content.slice(0, 200) : `non-string:${typeof result?.message?.content}`
        });
        return null;
      }
      const parsed = JSON.parse(m[0]);
      const next = {
        solar:   typeof parsed.solar   === 'string' ? parsed.solar.trim()   : null,
        home:    typeof parsed.home    === 'string' ? parsed.home.trim()    : null,
        battery: typeof parsed.battery === 'string' ? parsed.battery.trim() : null,
        ev:      typeof parsed.ev      === 'string' ? parsed.ev.trim()      : null,
        grid:    typeof parsed.grid    === 'string' ? parsed.grid.trim()    : null,
        ts: Date.now(),
        promptVersion: PROMPT_VERSION
      };
      // Need at least 3 valid strings to count as a success — otherwise hold the previous cache.
      const validCount = ['solar','home','battery','ev','grid'].filter(k => typeof next[k] === 'string' && next[k]).length;
      if (validCount < 3) {
        pushLog('llm_tile_parse_fail', { reason: 'too_few_valid_fields', validCount });
        return null;
      }
      tileFriendliesCache = next;
      pushLog('llm_tile_friendlies_generated', { validCount });
      return next;
    } catch (e) {
      pushLog('llm_error', { error: e.message, context: 'generateTileFriendlies' });
      return null;
    }
  }

  /**
   * Build live data object from current state for status messages.
   *
   * @returns {object}
   */
  function buildLiveData() {
    const v = state?.victron || {};
    const costs = state?.costs || {};
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

    // Map raw state.victron.* fields (Watt) to the keys the prompt templates
    // actually interpolate: buildNormalStatus uses {socPercent, pvKw, loadKw},
    // buildSocWarning/SocFull uses {socPercent}, etc. Pre-Phase-5 plan, this
    // factory returned {pvW, soc, gridW, pvTodayKwh, consumedKwh} which never
    // got interpolated by any template — every status message read "Fehlende
    // Daten" because every ${pvKw}/${socPercent} resolved to `undefined`.
    const pvW = v.pvTotalW ?? v.pvPowerW ?? null;
    const loadW = v.selfConsumptionW ?? null;
    const netGridW = (v.gridImportW ?? 0) - (v.gridExportW ?? 0);
    const toKw = (w) => (w == null ? null : Math.round(w / 100) / 10);

    return {
      // Canonical keys consumed by prompt-templates.js
      socPercent: v.soc ?? null,
      pvKw: toKw(pvW),
      loadKw: toKw(loadW),
      gridKw: toKw(netGridW),
      priceCtKwh: currentPrice ?? costs.priceNowCtKwh ?? null,
      // Today-aggregates from cost-tracker (state.costs computed by routes-api)
      importKwh: costs.importKwh ?? null,
      exportKwh: costs.exportKwh ?? null,
      savingsEur: costs.netEur ?? null,
      // Legacy keys preserved for callers / future templates that consume raw Watts
      pvW,
      soc: v.soc ?? null,
      gridW: netGridW,
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

  function getTileFriendlies() { return tileFriendliesCache; }

  return { start, close, generateMessage, getMessages, getLatest, getMessageCount, getLiveData: buildLiveData, getTileFriendlies, generateTileFriendlies, listModels: () => ollamaClient.list() };
}
