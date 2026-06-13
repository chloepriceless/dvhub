// ml-health.js -- ML health status aggregator.
// Combines ML correction, training, and tier info into a single status object.
// Per D-26, D-27: queryable health status for API endpoints and dashboard.
// Factory: createMlHealth({ mlCorrection, mlTraining, getCfg, tier, getLoadForecastState? })
//   -> { getStatus, getAccuracyTrend }
// Phase 07 FORE-12 D-D2: `getLoadForecastState` optional dep surfaces load_forecast
// source/status on /api/ml/status for operator visibility.

/**
 * Build tier feature table per D-27.
 * Returns which features are active/inactive/unavailable for this tier.
 * @param {number} tier - RAM tier (1, 2, or 3)
 * @param {object} cfg - Full config object
 * @returns {Array<{feature: string, status: string, requiredTier: number}>}
 */
export function buildTierFeatures(tier, cfg) {
  const ml = cfg.ml || {};
  const features = [
    {
      feature: 'sql_load_forecast',
      status: 'active', // Always active on all tiers
      requiredTier: 1
    },
    {
      feature: 'pvlib_batch',
      status: tier >= 2 ? 'active' : 'unavailable',
      requiredTier: 2
    },
    {
      feature: 'statsforecast',
      status: tier >= 2 && ml.sfEnabled ? 'active' : tier >= 2 ? 'inactive' : 'unavailable',
      requiredTier: 2
    },
    {
      feature: 'ml_correction',
      status: tier >= 2 && ml.mlEnabled ? 'active' : tier >= 2 ? 'inactive' : 'unavailable',
      requiredTier: 2
    },
    {
      feature: 'ml_training',
      status: tier >= 2 && ml.mlEnabled ? 'active' : tier >= 2 ? 'inactive' : 'unavailable',
      requiredTier: 2
    },
    {
      feature: 'statsforecast_mstl',
      status: tier >= 3 && ml.sfEnabled && ml.sfUseMstl ? 'active' : tier >= 3 ? 'inactive' : 'unavailable',
      requiredTier: 3
    },
    {
      feature: 'persistent_python',
      status: tier >= 3 ? 'active' : 'unavailable',
      requiredTier: 3
    }
  ];
  return features;
}

/**
 * Create ML health status aggregator.
 *
 * @param {object} deps - { mlCorrection, mlTraining, getCfg, tier }
 * @returns {{ getStatus: Function, getAccuracyTrend: Function }}
 */
export function createMlHealth({ mlCorrection, mlTraining, getCfg, tier, getLoadForecastState }) {
  /**
   * Get ML system status for API and dashboard.
   * @returns {object} Full ML status object
   */
  function getStatus() {
    const cfg = getCfg();
    const ml = cfg.ml || {};
    const modelInfo = mlCorrection.getModelInfo();
    const log = mlTraining.getTrainingLog();

    // Compute next training time
    const now = new Date();
    const nextTraining = new Date(now);
    nextTraining.setUTCHours(ml.mlTrainingHour ?? 21, ml.mlTrainingMinute ?? 30, 0, 0);
    if (nextTraining <= now) {
      nextTraining.setDate(nextTraining.getDate() + 1);
    }

    // Determine data status
    let dataStatus = 'inactive';
    if (ml.mlEnabled && modelInfo) {
      dataStatus = 'active';
    } else if (ml.mlEnabled && !modelInfo) {
      dataStatus = 'collecting';
    } else if (!ml.mlEnabled) {
      dataStatus = 'inactive';
    }

    // Phase 07 FORE-12 D-D2: load-forecast degradation visibility.
    // Surfaces source (statsforecast|sql_rollup|vrm_fallback|naive_constant|unknown)
    // and status (ok|degraded|failed|unknown) for operator and dashboard.
    let loadForecast = { source: 'unknown', status: 'unknown', consecutive_non_sf_runs: 0, last_updated_at: null };
    try {
      const lfState = typeof getLoadForecastState === 'function' ? getLoadForecastState() : null;
      if (lfState) {
        loadForecast = {
          source: lfState.source ?? 'unknown',
          status: lfState.status ?? 'unknown',
          consecutive_non_sf_runs: lfState.consecutiveNonSfRuns ?? 0,
          last_updated_at: lfState.lastUpdatedAt ?? null
        };
      }
    } catch (err) {
      loadForecast = { source: 'unknown', status: 'unknown', error: err.message };
    }

    return {
      tier,
      mlEnabled: ml.mlEnabled || false,
      modelType: modelInfo?.model_type || null,
      modelVersion: modelInfo?.version || 0,
      mae: modelInfo?.mae || null,
      dataStatus,
      nextTraining: nextTraining.toISOString(),
      lastTraining: log[0]?.ts || null,
      trainingLog: log,
      sfEnabled: ml.sfEnabled || false,
      sfUseMstl: tier >= 3 && (ml.sfUseMstl || false),
      tierFeatures: buildTierFeatures(tier, cfg),
      // Phase 07 FORE-12 D-D2 exposure
      load_forecast: loadForecast
    };
  }

  /**
   * Get accuracy trend data for sparkline chart.
   * Queries accuracy_tracker for daily MAE values.
   * @param {number} days - Number of days to include (default 30)
   * @returns {Array<{date: string, mae: number}>}
   */
  function getAccuracyTrend(days = 30) {
    // Accuracy trend requires DB access which is not directly available here.
    // This is a stub that returns empty array -- will be wired in the ML service index.js
    // when the accuracy tracker store is available.
    return [];
  }

  return { getStatus, getAccuracyTrend };
}
