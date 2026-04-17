// services/llm/message-types.js -- Phase 07 LLM-02 REVIEWS L.
// Single source of truth for MLAI-05 message-type enum.
// Consumed by message-generator.js BUILDERS map AND (unchanged) template-fallback.js path.
//
// Values mirror the production keys already used by callers (routes-api.js line ~1891,
// services/llm/index.js buildLiveData/generateStatus) so refactor is backward-compatible:
//   - 'status', 'savings', 'alert', 'pv_record', 'negative_price' -- existing legacy keys
//   - 'soc_full', 'forecast_inconsistency', 'load_forecast_info', 'charging_plan', 'system_ok'
//     -- new keys introduced in Phase 07 LLM-02 for richer MLAI-05 coverage
//
// When adding a new message type: add here FIRST, then wire both a builder in
// prompt-templates.js AND (if needed) a rules-fallback entry in template-fallback.js.

export const MESSAGE_TYPES = Object.freeze({
  // Legacy (production) keys -- DO NOT RENAME. Callers pass these strings verbatim.
  NORMAL_STATUS:          'status',
  SAVINGS:                'savings',
  SOC_WARNING:            'alert',
  PV_RECORD:              'pv_record',
  NEGATIVE_PRICE_ALERT:   'negative_price',
  // Phase 07 LLM-02 new keys -- richer coverage; Tier 3 LLM callers can use these now.
  SOC_FULL:               'soc_full',
  FORECAST_INCONSISTENCY: 'forecast_inconsistency',
  LOAD_FORECAST_INFO:     'load_forecast_info',
  CHARGING_PLAN:          'charging_plan',
  SYSTEM_OK:              'system_ok'
});
