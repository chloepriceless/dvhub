// ml-health.js -- ML health status aggregator.
// Combines ML correction, training and feature availability into a single status object.
// Per D-26, D-27: queryable health status for API endpoints and dashboard.
// Factory: createMlHealth({ mlCorrection, mlTraining, getCfg, pythonAvailable, getLoadForecastState? })
//   -> { getStatus, getAccuracyTrend }
// Phase 07 FORE-12 D-D2: `getLoadForecastState` optional dep surfaces load_forecast
// source/status on /api/ml/status for operator visibility.

/**
 * Feature table per D-27: which forecast/ML features are active, inactive
 * (switched off in the config) or unavailable (no Python environment).
 * The RAM tiers that used to decide availability were removed 2026-10-03.
 * @param {boolean} pythonAvailable - forecast Python environment installed
 * @param {object} cfg - Full config object
 * @returns {Array<{feature: string, status: string, requires: string|null}>}
 */
export function buildFeatures(pythonAvailable, cfg) {
  const ml = cfg.ml || {};
  const py = (enabled) => (pythonAvailable ? (enabled ? 'active' : 'inactive') : 'unavailable');
  const features = [
    { feature: 'sql_load_forecast', status: 'active', requires: null },
    { feature: 'pvlib_batch', status: py(true), requires: 'python' },
    { feature: 'statsforecast', status: py(Boolean(ml.sfEnabled)), requires: 'python' },
    { feature: 'ml_correction', status: py(Boolean(ml.mlEnabled)), requires: 'python' },
    { feature: 'ml_training', status: py(Boolean(ml.mlEnabled)), requires: 'python' },
    { feature: 'statsforecast_mstl', status: py(Boolean(ml.sfEnabled && ml.sfUseMstl)), requires: 'python' },
    { feature: 'persistent_python', status: py(Boolean(ml.mlEnabled)), requires: 'python' }
  ];

  // ML-Korrektur + ML-Training nur listen, wenn ML aktiv ist (selbstheilend:
  // taucht automatisch wieder auf, sobald ml.mlEnabled=true gesetzt wird).
  // Hintergrund: ML auf prod deaktiviert seit 2026-05-22 (lightgbm-v1 verschlechterte
  // die PV-Prognose, MAE ~2658W statt ~550W). Bis zum Modell-Fix (#999.17) sollen die
  // beiden Zeilen nicht als "inaktiv" erscheinen, statt den Kunden zu verwirren.
  const ML_ONLY = new Set(['ml_correction', 'ml_training']);
  return ml.mlEnabled ? features : features.filter(f => !ML_ONLY.has(f.feature));
}

/**
 * Create ML health status aggregator.
 *
 * @param {object} deps - { mlCorrection, mlTraining, getCfg, pythonAvailable }
 * @returns {{ getStatus: Function, getAccuracyTrend: Function }}
 */
export function createMlHealth({ mlCorrection, mlTraining, getCfg, pythonAvailable = true, getLoadForecastState }) {
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
      pythonAvailable,
      mlEnabled: ml.mlEnabled || false,
      modelType: modelInfo?.model_type || null,
      modelVersion: modelInfo?.version || 0,
      mae: modelInfo?.mae || null,
      dataStatus,
      nextTraining: nextTraining.toISOString(),
      lastTraining: log[0]?.ts || null,
      trainingLog: log,
      sfEnabled: ml.sfEnabled || false,
      sfUseMstl: Boolean(ml.sfUseMstl),
      features: buildFeatures(pythonAvailable, cfg),
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
