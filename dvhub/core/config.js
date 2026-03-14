/**
 * Config wrapper -- loads configuration and validates module activation.
 *
 * Wraps the existing config-model.js loadConfigFile and adds a
 * modules section with activation constraints: at least one of
 * DV or Optimizer must be active alongside Gateway.
 */

import { loadConfigFile } from '../config-model.js';

const DEFAULT_MODULES = {
  dv: { enabled: false },
  optimizer: { enabled: false }
};

/**
 * Load and validate configuration with module activation.
 *
 * @param {string} configPath - Path to config.json
 * @returns {{ rawConfig: object, config: object }} Validated configuration
 * @throws {Error} If both DV and Optimizer are disabled
 */
export function loadConfig(configPath) {
  const loaded = loadConfigFile(configPath);
  const effectiveConfig = loaded.effectiveConfig;

  // Merge in modules defaults
  // If no modules section exists in config, enable both for backward compatibility
  if (!effectiveConfig.modules) {
    effectiveConfig.modules = {
      dv: { enabled: true },
      optimizer: { enabled: true }
    };
  } else {
    effectiveConfig.modules = {
      dv: { enabled: false, ...effectiveConfig.modules.dv },
      optimizer: { enabled: false, ...effectiveConfig.modules.optimizer }
    };

    // Validate: at least one of DV or Optimizer must be active
    const dvEnabled = effectiveConfig.modules.dv.enabled === true;
    const optEnabled = effectiveConfig.modules.optimizer.enabled === true;

    if (!dvEnabled && !optEnabled) {
      throw new Error(
        'At least one of DV or Optimizer must be active alongside Gateway'
      );
    }
  }

  return {
    rawConfig: loaded.rawConfig,
    config: effectiveConfig
  };
}
